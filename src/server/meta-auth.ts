import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {toUSVString} from 'node:util';
import {parseCookies} from 'better-auth/cookies';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError,getAuth} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {credentialKeys,decryptCredentials,encryptCredentials} from './credential-vault.ts';
import {isInstanceOperator,requireInstanceOperator} from './instance-operators.ts';
import {contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {canonicalHash} from './context-input.ts';
import {metaRequest,MetaRequestError} from './meta-http.ts';

const id=z.uuid(),decimal=z.string().regex(/^[1-9][0-9]{0,39}$(?![\s\S])/);
const text=(max:number)=>z.string().max(max).refine(s=>toUSVString(s)===s&&!/[\x00-\x1f\x7f]/.test(s));
const accountCursor=text(4096).min(1).refine(value=>Buffer.byteLength(value)<=4096);
const secret=(max:number)=>z.string().min(1).max(max).regex(/^[\x21-\x7e]+$(?![\s\S])/);
const name=text(120).trim().min(1),revision=z.number().int().min(1).max(2147483647);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the submitted Meta fields.');return result.data;}
function provider<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new MetaRequestError('invalid_response');return result.data;}
function absent():never{throw new FoundationError(404,'Meta source not found or unavailable.');}
function changed():never{throw new FoundationError(409,'Meta settings or access changed. Reload before continuing.');}
const redirectUri=()=>getConfig().appUrl+'/api/meta/callback';
export type MetaSession={user:{id:string};session:{id:string}};
export type MetaRegistration={id:string;app_id:string;config_id:string;revision:number;credential_revision:number;encrypted_config:unknown;active:boolean;enabled:boolean;bound_origin:string;declared_mode:'development'|'live';lifecycle_epoch:string};
export type MetaSecrets={appSecret:string;subjectHmacKey:string};
type Flow={id:string;registration_id:string;app_revision:number;start_epoch:string;workspace_id:string;project_id:string;user_id:string|null;session_id:string|null;connection_id:string|null;connection_revision:number|null;name:string;phase:string;subject_hash:string|null;scopes:string[]|null;access_expires_at:Date|null;data_access_expires_at:Date|null;invalidated_at:Date|null;expires_at:Date};
type Connection={id:string;workspace_id:string;project_id:string;name:string;revision:number;status:string;current_grant_id:string|null;encrypted_token:unknown;account_id:string|null;account_name:string|null;currency:string|null;time_zone:string|null;account_status:number|null;validated_at:Date|null;updated_at:Date};
export const metaAppContext=(row:Pick<MetaRegistration,'id'|'credential_revision'>)=>({workspaceId:'instance',id:row.id,provider:'meta-app',revision:row.credential_revision});
export const metaConnectionContext=(row:Pick<Connection,'id'|'workspace_id'|'revision'>)=>({workspaceId:row.workspace_id,id:row.id,provider:'meta-connection',revision:row.revision});
export const metaDeletionContext=(row:{id:string;registration_id:string})=>({workspaceId:'instance',id:row.id,provider:'meta-deletion:'+row.registration_id,revision:1});
export function metaSubjectHash(secrets:MetaSecrets,userId:string){return createHmac('sha256',Buffer.from(parse(z.string().regex(/^[A-Za-z0-9_-]{43}$(?![\s\S])/),secrets.subjectHmacKey),'base64url')).update('ten98.meta-subject.v1\0'+parse(decimal,userId)).digest('hex');}
function appSecrets(row:MetaRegistration):MetaSecrets{return provider(z.object({appSecret:secret(512),subjectHmacKey:z.string().regex(/^[A-Za-z0-9_-]{43}$(?![\s\S])/)}).strict(),decryptCredentials(row.encrypted_config,metaAppContext(row)));}
function localFixture(){const c=getConfig();return process.env.TEN98_INTEGRATION_TEST==='1'&&[c.appUrl,c.databaseUrl].every(v=>['localhost','127.0.0.1','[::1]'].includes(new URL(v).hostname));}
function appReady(row:MetaRegistration){if(!row.active||!row.enabled||row.bound_origin!==getConfig().appUrl||(!getConfig().appUrl.startsWith('https:')&&!localFixture()))throw new FoundationError(409,'Ask the operator to enable Meta reporting for this HTTPS application origin.');}
async function transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await getDatabase().pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
async function registration(client:PoolClient,registrationId:string,write=false){const row=(await client.query<MetaRegistration>(`SELECT * FROM meta_app_registration WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[parse(id,registrationId)])).rows[0];if(!row)absent();return row;}
/** Callback-only short transaction. Inactive/disabled registrations still verify deletion. No network inside action. */
export async function withMetaRegistration<T>(registrationId:string,action:(client:PoolClient,app:MetaRegistration,secrets:MetaSecrets)=>Promise<T>){return transaction(async client=>{const app=await registration(client,registrationId,true);return action(client,app,appSecrets(app));});}
/** Caller owns the registration gate. Pending deletion blocks new consent; an old grant never revives. */
export async function assertMetaGrantAllowed(client:PoolClient,input:{registrationId:string;subjectHash:string;startEpoch:string}){
 const blocked=await client.query(`SELECT 1 FROM meta_deletion_request WHERE registration_id=$1 AND subject_hash=$2 AND (status<>'local_deleted' OR fence_epoch>$3::bigint) LIMIT 1`,[input.registrationId,input.subjectHash,input.startEpoch]);
 if(blocked.rowCount)throw new FoundationError(409,'This Meta grant is unavailable after a deletion request. Complete local cleanup and connect again.');
}
async function scope(client:PoolClient,projectId:string,userId:string,sessionId?:string){
 const p=(await client.query(`SELECT p.workspace_id FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1 FOR UPDATE OF w`,[parse(id,projectId)])).rows[0];if(!p)absent();
 const found=await client.query(`SELECT p.id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id WHERE p.id=$1 AND m.user_id=$2 AND m.role='owner' FOR UPDATE OF p`,[projectId,parse(id,userId)]);if(!found.rowCount)absent();
 if(sessionId!==undefined&&!(await client.query('SELECT id FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',[sessionId,userId])).rowCount)throw new FoundationError(401,'Sign in to continue.');
 return p.workspace_id as string;
}
async function connection(client:PoolClient,projectId:string,connectionId:string){const row=(await client.query<Connection>('SELECT * FROM meta_connection WHERE id=$1 AND project_id=$2 FOR UPDATE',[parse(id,connectionId),parse(id,projectId)])).rows[0];if(!row)absent();return row;}
async function grant(client:PoolClient,row:Connection){const f=(await client.query<Flow>("SELECT * FROM meta_oauth_flow WHERE id=$1 AND connection_id=$2 AND project_id=$3 AND phase='completed'",[row.current_grant_id,row.id,row.project_id])).rows[0];if(!f)changed();return f;}
function cas(row:{revision:number},expected:number){if(row.revision!==expected)changed();}
function nextRevision(current:number){if(current>=2147483647)throw new FoundationError(409,'This source reached its revision limit. Revoke it and create a new source.');return current+1;}
async function connectionAppId(projectId:string,connectionId:string){const row=(await getDatabase().pool.query('SELECT f.registration_id FROM meta_connection c JOIN meta_oauth_flow f ON f.id=c.current_grant_id WHERE c.id=$1 AND c.project_id=$2',[parse(id,connectionId),parse(id,projectId)])).rows[0];if(!row)absent();return row.registration_id as string;}
function appDto(app:MetaRegistration){return {id:app.id,appId:app.app_id,configId:app.config_id,revision:app.revision,active:app.active,enabled:app.enabled,declaredMode:app.declared_mode,boundOrigin:app.bound_origin,deleteDataUrl:getConfig().appUrl+`/api/meta/apps/${app.id}/delete-data`};}
export async function getMetaApp(userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(key=>!['registrationId','appId','cursor'].includes(key))||[...new Set(params.keys())].some(key=>params.getAll(key).length>1)||params.has('registrationId')&&params.has('appId'))throw new FoundationError(400,'Use one Meta registration and page cursor.');
 const operator=await isInstanceOperator(parse(id,userId)),active=(await getDatabase().pool.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE active')).rows[0];
 if(!operator&&params.size)throw new FoundationError(403,'Instance operator access is required.');
 let selected=active;const listScope={list:'meta-apps'},cursor=readContentCursor(params.get('cursor'),listScope);
 if(params.has('registrationId')){selected=(await getDatabase().pool.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE id=$1',[parse(id,params.get('registrationId'))])).rows[0];if(!selected)absent();}
 if(params.has('appId'))selected=(await getDatabase().pool.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE app_id=$1',[parse(decimal,params.get('appId'))])).rows[0];
 const rows=operator?(await getDatabase().pool.query<MetaRegistration&{createdAt:string}>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM meta_app_registration WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[cursor?.at??null,cursor?.id??null])).rows:[];
 const last=rows[49];return {operator,configured:!!active,enabled:!!active?.enabled,vaultConfigured:!!credentialKeys(),httpsReady:getConfig().appUrl.startsWith('https:'),redirectUri:redirectUri(),activeRegistrationId:active?.id??null,registration:operator&&selected?appDto(selected):null,registrations:rows.slice(0,50).map(appDto),nextCursor:rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(listScope),at:last.createdAt,id:last.id})).toString('base64url'):null};
}
export async function saveMetaApp(userId:string,raw:unknown){
 const input=parse(z.object({activeRegistrationId:id.nullable(),revision:z.number().int().min(0).max(2147483646),appId:decimal,configId:decimal,appSecret:secret(512).optional(),activate:z.boolean(),enabled:z.boolean(),declaredMode:z.enum(['development','live'])}).strict(),raw);
 const savedId=await transaction(async client=>{await requireInstanceOperator(client,parse(id,userId));await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ten98-meta-app',0))");
  const current=(await client.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE active FOR UPDATE')).rows[0];if((current?.id??null)!==input.activeRegistrationId)changed();
  const old=(await client.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE app_id=$1 FOR UPDATE',[input.appId])).rows[0];if((old?.revision??0)!==input.revision)changed();
  if(input.enabled&&!getConfig().appUrl.startsWith('https:')&&!localFixture())throw new FoundationError(400,'Meta reporting requires an HTTPS application origin.');
  if(!old&&!input.appSecret)throw new FoundationError(400,'Supply the Meta app secret.');
  const rid=old?.id??randomUUID(),cr=input.appSecret?(old?.credential_revision??0)+1:old!.credential_revision;
  const encrypted=input.appSecret?encryptCredentials({appSecret:input.appSecret,subjectHmacKey:old?appSecrets(old).subjectHmacKey:randomBytes(32).toString('base64url')},metaAppContext({id:rid,credential_revision:cr})):old!.encrypted_config;
  if(input.activate&&current&&current.id!==rid)await client.query('UPDATE meta_app_registration SET active=false,revision=LEAST(revision::bigint+1,2147483647)::integer,updated_at=clock_timestamp() WHERE id=$1',[current.id]);
  await client.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT(id) DO UPDATE SET config_id=excluded.config_id,revision=excluded.revision,credential_revision=excluded.credential_revision,encrypted_config=excluded.encrypted_config,active=excluded.active,enabled=excluded.enabled,bound_origin=excluded.bound_origin,declared_mode=excluded.declared_mode,updated_at=clock_timestamp()`,[rid,input.appId,input.configId,input.revision+1,cr,encrypted,input.activate||!!old?.active,input.enabled,getConfig().appUrl,input.declaredMode]);
  return rid;
 });return getMetaApp(userId,new URLSearchParams({registrationId:savedId}));
}
export async function disableMetaApp(userId:string,registrationId:string,raw:unknown){const input=parse(z.object({revision}).strict(),raw);await transaction(async client=>{await requireInstanceOperator(client,parse(id,userId));const app=await registration(client,registrationId,true);cas(app,input.revision);await client.query('UPDATE meta_app_registration SET enabled=false,revision=LEAST(revision::bigint+1,2147483647)::integer,updated_at=clock_timestamp() WHERE id=$1',[app.id]);});return getMetaApp(userId);}

const cookieName=(flowId:string)=>'ten98.meta.'+flowId;
function cookie(flowId:string,value:string,maxAge:number){return `${cookieName(flowId)}=${value}; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${getConfig().appUrl.startsWith('https:')?'; Secure':''}`;}
export async function startMetaConnect(projectId:string,session:MetaSession,raw:unknown){
 const input=parse(z.object({requestId:id,name,connectionId:id.optional(),revision:revision.optional()}).strict().refine(v=>(v.connectionId===undefined)===(v.revision===undefined)),raw);
 return transaction(async client=>{const active=(await client.query<{id:string}>('SELECT id FROM meta_app_registration WHERE active')).rows[0];if(!active)changed();const app=await registration(client,active.id);appReady(app);
  const workspaceId=await scope(client,projectId,session.user.id,session.session.id),receipt=await contentReceipt(client,projectId,input.requestId,'meta.connect',{userId:session.user.id,sessionId:session.session.id,...input});
  if(receipt.replayed)throw new FoundationError(409,'This consent start was already issued. Start a new connection attempt.');
  appSecrets(app);
  const previous=input.connectionId?await connection(client,projectId,input.connectionId):undefined;if(previous){cas(previous,input.revision!);if(previous.status==='deleted')changed();nextRevision(previous.revision);}
  await client.query("UPDATE meta_oauth_flow SET phase='cancelled',state_hash=NULL,browser_hash=NULL,session_id=NULL,name=NULL WHERE project_id=$1 AND user_id=$2 AND phase IN ('pending','exchanging')",[projectId,session.user.id]);
  const flowId=randomUUID(),state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url');
  await client.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,session_id,state_hash,browser_hash,connection_id,connection_revision,name,phase,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',clock_timestamp()+interval '10 minutes')`,[flowId,app.id,app.revision,app.lifecycle_epoch,workspaceId,projectId,session.user.id,session.session.id,digest(state),digest(browser),previous?.id??null,previous?.revision??null,input.name]);
  await receipt.save({id:flowId});const url=new URL('https://www.facebook.com/v26.0/dialog/oauth');for(const [key,value]of Object.entries({client_id:app.app_id,config_id:app.config_id,response_type:'code',redirect_uri:redirectUri(),state}))url.searchParams.set(key,value);
  return {authorizationUrl:url.href,cookie:cookie(flowId,browser,600)};
 });
}
const tokenResponse=z.object({access_token:secret(4096),token_type:z.string().refine(v=>v.toLowerCase()==='bearer'),expires_in:z.number().int().positive().max(31536000)});
const epoch=z.number().int().nonnegative().max(253402300799);
async function inspected(app:MetaRegistration,secrets:MetaSecrets,token:string,accessDeadline:number,signal?:AbortSignal){
 const raw=await metaRequest({operation:'inspectToken',appId:app.app_id,appSecret:secrets.appSecret,token},signal);
 const data=provider(z.object({data:z.object({app_id:decimal,user_id:decimal,type:z.literal('USER'),is_valid:z.literal(true),scopes:z.array(text(100).min(1)).max(100),expires_at:epoch.optional(),data_access_expires_at:epoch.optional()})}),raw.data).data;
 if(data.app_id!==app.app_id||!data.scopes.includes('ads_read'))throw new FoundationError(409,'Grant Meta advertising read access to this app.');
 const accessExpiresAt=Math.min(accessDeadline,data.expires_at?data.expires_at*1000:accessDeadline),dataExpiresAt=data.data_access_expires_at?data.data_access_expires_at*1000:null;
 if(!Number.isFinite(accessExpiresAt)||accessExpiresAt<=Date.now()||dataExpiresAt!==null&&dataExpiresAt<=Date.now())throw new FoundationError(409,'The Meta grant expired. Connect again.');
 const permissions=provider(z.object({data:z.array(z.object({permission:text(100).min(1),status:z.enum(['granted','declined','expired'])})).max(100)}),(await metaRequest({operation:'permissions',appId:app.app_id,appSecret:secrets.appSecret,token},signal)).data).data;
 if(new Set(permissions.map(p=>p.permission)).size!==permissions.length||!permissions.some(p=>p.permission==='ads_read'&&p.status==='granted'))throw new FoundationError(409,'Grant Meta advertising read access to this app.');
 return {subjectHash:metaSubjectHash(secrets,data.user_id),scopes:[...new Set(data.scopes)].sort(),accessExpiresAt:new Date(accessExpiresAt),dataExpiresAt:dataExpiresAt===null?null:new Date(dataExpiresAt)};
}
const accountSchema=z.object({id:z.string().regex(/^act_[1-9][0-9]{0,39}$(?![\s\S])/),account_id:decimal,name:text(512).min(1),currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),timezone_name:text(120).min(1),account_status:z.number().int().nonnegative()});
function accountDto(raw:unknown,expected?:string){const a=provider(accountSchema,raw);if(a.id!=='act_'+a.account_id||expected!==undefined&&a.account_id!==expected)throw new MetaRequestError('invalid_response');try{new Intl.DateTimeFormat('en',{timeZone:a.timezone_name});}catch{throw new MetaRequestError('invalid_response');}return {id:a.account_id,name:a.name,currency:a.currency,timeZone:a.timezone_name,status:a.account_status};}
export async function metaCallback(request:Request):Promise<Response>{
 let flowId:string|undefined,navigation='',claimedByThisCallback=false;const result=(success:boolean)=>new Response(null,{status:303,headers:{location:getConfig().appUrl+'/#meta='+(success?'connected'+navigation:'failed'),'cache-control':'no-store','referrer-policy':'no-referrer',...(flowId?{'set-cookie':cookie(flowId,'',0)}:{})}});
 try{const params=new URL(request.url).searchParams;if([...params.keys()].some(k=>!['state','code','error','error_reason','error_description'].includes(k))||[...new Set(params.keys())].some(k=>params.getAll(k).length!==1)||params.has('error')&&params.has('code'))return result(false);
  const state=parse(z.string().regex(/^[A-Za-z0-9_-]{43}$(?![\s\S])/),params.get('state')),session=await getAuth().api.getSession({headers:request.headers});if(!session)return result(false);
  const hint=(await getDatabase().pool.query<{id:string;registration_id:string}>('SELECT id,registration_id FROM meta_oauth_flow WHERE state_hash=$1 AND session_id=$2 AND user_id=$3',[digest(state),session.session.id,session.user.id])).rows[0];if(!hint)return result(false);flowId=hint.id;
  const browser=parseCookies(request.headers.get('cookie')??'').get(cookieName(flowId))??'';
  const before=await transaction(async client=>{const app=await registration(client,hint.registration_id);appReady(app);
   const f=(await client.query<Flow>(`SELECT * FROM meta_oauth_flow WHERE id=$1 AND state_hash=$2 AND browser_hash=$3 AND session_id=$4 AND user_id=$5 AND phase='pending' AND expires_at>clock_timestamp()`,[hint.id,digest(state),digest(browser),session.session.id,session.user.id])).rows[0];if(!f)return null;
   await scope(client,f.project_id,session.user.id,session.session.id);if(app.revision!==f.app_revision)changed();
   let accountId:string|null=null;if(f.connection_id){const old=await connection(client,f.project_id,f.connection_id);cas(old,f.connection_revision!);if(old.status==='deleted')changed();accountId=old.account_id;}
   const claimed=await client.query("UPDATE meta_oauth_flow SET phase='exchanging' WHERE id=$1 AND phase='pending' RETURNING id",[f.id]);if(!claimed.rowCount)return null;
   return {app,secrets:appSecrets(app),flow:f,accountId};
  });if(!before)return result(false);claimedByThisCallback=true;
  if(params.has('error')||!params.get('code'))throw new FoundationError(400,'Meta consent was not granted.');
  const signal=AbortSignal.timeout(90000),common={appId:before.app.app_id,appSecret:before.secrets.appSecret};
  const short=provider(tokenResponse,(await metaRequest({...common,operation:'exchangeCode',code:parse(secret(4096),params.get('code'))},signal)).data);
  const extended=provider(tokenResponse,(await metaRequest({...common,operation:'extendUserToken',token:short.access_token},signal)).data),deadline=Date.now()+extended.expires_in*1000;
  const verified=await inspected(before.app,before.secrets,extended.access_token,deadline,signal);
  let selected:ReturnType<typeof accountDto>|undefined;
  if(before.accountId)selected=accountDto((await metaRequest({...common,operation:'account',token:extended.access_token,accountId:before.accountId},signal)).data,before.accountId);
  await transaction(async client=>{const app=await registration(client,before.app.id);appReady(app);if(app.revision!==before.app.revision)changed();const f=before.flow;
   const workspaceId=await scope(client,f.project_id,session.user.id,session.session.id);if(workspaceId!==f.workspace_id)changed();
   const old=f.connection_id?await connection(client,f.project_id,f.connection_id):undefined;if(old){cas(old,f.connection_revision!);if(old.status==='deleted'||old.account_id!==null&&selected?.id!==old.account_id)changed();}
   const live=(await client.query<Flow>("SELECT * FROM meta_oauth_flow WHERE id=$1 AND phase='exchanging' AND expires_at>clock_timestamp() FOR UPDATE",[f.id])).rows[0];if(!live)changed();
   await assertMetaGrantAllowed(client,{registrationId:app.id,subjectHash:verified.subjectHash,startEpoch:f.start_epoch});if(verified.accessExpiresAt.getTime()<=Date.now()||verified.dataExpiresAt&&verified.dataExpiresAt.getTime()<=Date.now())changed();
   const cid=old?.id??randomUUID(),next=nextRevision(old?.revision??0),encrypted=encryptCredentials({accessToken:extended.access_token},metaConnectionContext({id:cid,workspace_id:workspaceId,revision:next}));
   if(old)await client.query(`UPDATE meta_connection SET name=$2,revision=$3,status=$4,encrypted_token=$5,account_name=COALESCE($6,account_name),currency=COALESCE($7,currency),time_zone=COALESCE($8,time_zone),account_status=COALESCE($9,account_status),validated_at=clock_timestamp(),disconnected_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,[cid,f.name,next,selected?'ready':'select_account',encrypted,selected?.name??null,selected?.currency??null,selected?.timeZone??null,selected?.status??null]);
   else await client.query("INSERT INTO meta_connection(id,workspace_id,project_id,name,revision,status,encrypted_token,validated_at) VALUES($1,$2,$3,$4,$5,'select_account',$6,clock_timestamp())",[cid,workspaceId,f.project_id,f.name,next,encrypted]);
   await client.query(`UPDATE meta_oauth_flow SET phase='completed',state_hash=NULL,browser_hash=NULL,session_id=NULL,name=NULL,connection_id=$2,subject_hash=$3,scopes=$4,token_type='USER',access_expires_at=$5,data_access_expires_at=$6,granted_at=clock_timestamp() WHERE id=$1`,[f.id,cid,verified.subjectHash,JSON.stringify(verified.scopes),verified.accessExpiresAt,verified.dataExpiresAt]);
   await client.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[cid,f.id]);navigation=`&meta-project=${f.project_id}&meta-workspace=${workspaceId}`;
  });return result(true);
 }catch{if(flowId&&claimedByThisCallback)await getDatabase().pool.query("UPDATE meta_oauth_flow SET phase='failed',state_hash=NULL,browser_hash=NULL,session_id=NULL,name=NULL WHERE id=$1 AND phase='exchanging'",[flowId]).catch(()=>{});return result(false);}
}

async function connectionDto(client:PoolClient,row:Connection){
 const f=await grant(client,row),a=(await client.query<MetaRegistration>('SELECT * FROM meta_app_registration WHERE id=$1',[f.registration_id])).rows[0];
 const deleted=!!(await client.query(`SELECT 1 FROM meta_deletion_request WHERE registration_id=$1 AND subject_hash=$2 AND (status<>'local_deleted' OR fence_epoch>$3::bigint) LIMIT 1`,[f.registration_id,f.subject_hash,f.start_epoch])).rowCount;
 const status=row.status==='deleted'||deleted?'deleted':row.status==='disconnected'?'disconnected':!a.active||!a.enabled||a.bound_origin!==getConfig().appUrl||a.revision!==f.app_revision||f.invalidated_at||!f.access_expires_at||f.access_expires_at.getTime()<=Date.now()||f.data_access_expires_at&&f.data_access_expires_at.getTime()<=Date.now()?'reconnect':row.status;
 return {id:row.id,name:row.name,revision:row.revision,status,account:deleted||!row.account_id?null:{id:row.account_id,name:row.account_name,currency:row.currency,timeZone:row.time_zone,status:row.account_status},scopes:deleted?[]:f.scopes??[],accessExpiresAt:deleted?null:f.access_expires_at?.toISOString()??null,dataAccessExpiresAt:deleted?null:f.data_access_expires_at?.toISOString()??null,validatedAt:deleted?null:row.validated_at?.toISOString()??null,updatedAt:row.updated_at.toISOString()};
}
export async function listMetaConnections(projectId:string,userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one Meta source page cursor.');
 return withContentProject(projectId,userId,false,async(client,p)=>{const listScope={projectId:p.id,list:'meta-connections'},cursor=readContentCursor(params.get('cursor'),listScope);
  const rows=await client.query<Connection&{createdAt:string}>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM meta_connection WHERE project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[p.id,cursor?.at??null,cursor?.id??null]);
  const connections=[];for(const row of rows.rows.slice(0,50))connections.push(await connectionDto(client,row));
  const last=rows.rows[49];return {role:p.role,connections,nextCursor:rows.rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(listScope),at:last.createdAt,id:last.id})).toString('base64url'):null};
 });
}
export async function getMetaConnection(projectId:string,userId:string,connectionId:string){return withContentProject(projectId,userId,false,async(client,p)=>{const row=(await client.query<Connection>('SELECT * FROM meta_connection WHERE id=$1 AND project_id=$2',[parse(id,connectionId),p.id])).rows[0];if(!row)absent();return {role:p.role,connection:await connectionDto(client,row)};});}
type Snapshot={app:MetaRegistration;secrets:MetaSecrets;row:Connection;flow:Flow;accessToken:string;operationExpiresAt?:number};
async function usable(client:PoolClient,app:MetaRegistration,row:Connection){appReady(app);const f=await grant(client,row);if(['disconnected','deleted','reconnect'].includes(row.status)||f.invalidated_at||f.registration_id!==app.id||f.app_revision!==app.revision||!f.access_expires_at||f.access_expires_at.getTime()<=Date.now()||f.data_access_expires_at&&f.data_access_expires_at.getTime()<=Date.now())changed();await assertMetaGrantAllowed(client,{registrationId:app.id,subjectHash:f.subject_hash!,startEpoch:f.start_epoch});return f;}
async function beforeAccount(projectId:string,userId:string,connectionId:string,expected:number):Promise<Snapshot>{const appId=await connectionAppId(projectId,connectionId);return transaction(async client=>{const app=await registration(client,appId);await scope(client,projectId,userId);const row=await connection(client,projectId,connectionId);cas(row,expected);const flow=await usable(client,app,row),secrets=appSecrets(app),accessToken=provider(z.object({accessToken:secret(4096)}).strict(),decryptCredentials(row.encrypted_token,metaConnectionContext(row))).accessToken;return {app,secrets,row,flow,accessToken};});}
async function unknownExpiry(snapshot:Snapshot){if(snapshot.flow.data_access_expires_at===null){const checked=await inspected(snapshot.app,snapshot.secrets,snapshot.accessToken,snapshot.flow.access_expires_at!.getTime());if(checked.subjectHash!==snapshot.flow.subject_hash)throw new MetaRequestError('invalid_response');snapshot.operationExpiresAt=Math.min(checked.accessExpiresAt.getTime(),checked.dataExpiresAt?.getTime()??Infinity);}}
function inspectedStillValid(snapshot:Snapshot){if(snapshot.operationExpiresAt!==undefined&&snapshot.operationExpiresAt<=Date.now())changed();}
async function afterAccount<T>(snapshot:Snapshot,userId:string,work:(client:PoolClient,row:Connection)=>Promise<T>){return transaction(async client=>{const app=await registration(client,snapshot.app.id);await scope(client,snapshot.row.project_id,userId);const row=await connection(client,snapshot.row.project_id,snapshot.row.id);cas(row,snapshot.row.revision);if(app.revision!==snapshot.app.revision||row.current_grant_id!==snapshot.flow.id)changed();await usable(client,app,row);inspectedStillValid(snapshot);return work(client,row);});}
export async function listMetaAccounts(projectId:string,userId:string,connectionId:string,raw:unknown){
 const input=parse(z.object({revision,cursor:text(20000).optional()}).strict(),raw),before=await beforeAccount(projectId,userId,connectionId,input.revision);let after:string|undefined;
 const context={workspaceId:before.row.workspace_id,id:before.row.id,provider:'meta-accounts:'+userId,revision:before.row.revision};
 if(input.cursor){let value:unknown;try{value=decryptCredentials(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')),context);}catch{throw new FoundationError(400,'Reload the Meta account list.');}const c=parse(z.object({after:accountCursor,appRevision:revision,expiresAt:z.number().int().positive()}).strict(),value);if(c.appRevision!==before.app.revision||c.expiresAt<=Date.now())changed();after=c.after;}
 await unknownExpiry(before);const rawPage=(await metaRequest({operation:'accounts',appId:before.app.app_id,appSecret:before.secrets.appSecret,token:before.accessToken,...(after?{after}:{})})).data;
 const page=provider(z.object({data:z.array(accountSchema).max(100),paging:z.object({cursors:z.object({after:accountCursor.optional()}).optional(),next:text(16000).optional()}).optional()}),rawPage),accounts=page.data.map(a=>accountDto(a));if(new Set(accounts.map(a=>a.id)).size!==accounts.length)throw new MetaRequestError('invalid_response');
 const next=page.paging?.next? page.paging.cursors?.after:undefined;if(page.paging?.next&&(!next||next===after))throw new MetaRequestError('invalid_response');
 return afterAccount(before,userId,async()=>({role:'owner' as const,connectionId,revision:before.row.revision,accounts,complete:!next,nextCursor:next?Buffer.from(JSON.stringify(encryptCredentials({after:next,appRevision:before.app.revision,expiresAt:Date.now()+600000},context))).toString('base64url'):null}));
}
export async function inspectMetaAccount(projectId:string,userId:string,connectionId:string,raw:unknown){
 const input=parse(z.object({revision,accountId:decimal}).strict(),raw),before=await beforeAccount(projectId,userId,connectionId,input.revision);
 if(before.row.account_id&&before.row.account_id!==input.accountId)changed();await unknownExpiry(before);
 const account=accountDto((await metaRequest({operation:'account',appId:before.app.app_id,appSecret:before.secrets.appSecret,token:before.accessToken,accountId:input.accountId})).data,input.accountId);
 return afterAccount(before,userId,async()=>({role:'owner' as const,connectionId,revision:before.row.revision,account}));
}
export async function selectMetaAccount(projectId:string,userId:string,connectionId:string,raw:unknown){
 const input=parse(z.object({requestId:id,revision,accountId:decimal}).strict(),raw),operation='meta.select:'+parse(id,connectionId),receiptInput={userId,...input};
 const acknowledgement=(result:unknown)=>{const saved=parse(z.object({connectionId:id,revision}).strict(),result);return {requestId:input.requestId,connectionId:saved.connectionId,selectedAccountId:input.accountId,revision:saved.revision};};
 const replay=await withContentProject(projectId,userId,true,async(client,p)=>{if(p.role!=='owner')absent();const receipt=await contentReceipt(client,p.id,input.requestId,operation,receiptInput);if(!receipt.replayed)return null;const row=await connection(client,p.id,connectionId);return {role:p.role,acknowledgement:acknowledgement(receipt.result),connection:await connectionDto(client,row),replayed:true};});if(replay)return replay;
 const before=await beforeAccount(projectId,userId,connectionId,input.revision);nextRevision(before.row.revision);if(before.row.account_id&&before.row.account_id!==input.accountId)changed();await unknownExpiry(before);
 const account=accountDto((await metaRequest({operation:'account',appId:before.app.app_id,appSecret:before.secrets.appSecret,token:before.accessToken,accountId:input.accountId})).data,input.accountId);
 return transaction(async client=>{const app=await registration(client,before.app.id);await scope(client,projectId,userId);const receipt=await contentReceipt(client,projectId,input.requestId,operation,receiptInput),row=await connection(client,projectId,connectionId);if(receipt.replayed)return {role:'owner' as const,acknowledgement:acknowledgement(receipt.result),connection:await connectionDto(client,row),replayed:true};cas(row,input.revision);if(app.revision!==before.app.revision||row.current_grant_id!==before.flow.id)changed();await usable(client,app,row);inspectedStillValid(before);if(row.account_id&&row.account_id!==account.id)changed();
  if((await client.query("SELECT 1 FROM meta_connection WHERE project_id=$1 AND account_id=$2 AND id<>$3 AND status NOT IN ('disconnected','deleted')",[projectId,account.id,row.id])).rowCount)throw new FoundationError(409,'This project already has an active Meta source for that account.');
  const next=nextRevision(row.revision),encrypted=encryptCredentials({accessToken:before.accessToken},metaConnectionContext({...row,revision:next}));const updated=(await client.query<Connection>(`UPDATE meta_connection SET revision=$2,status='ready',account_id=$3,account_name=$4,currency=$5,time_zone=$6,account_status=$7,encrypted_token=$8,validated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id,next,account.id,account.name,account.currency,account.timeZone,account.status,encrypted])).rows[0];const saved={connectionId:row.id,revision:next};await receipt.save(saved);return {role:'owner' as const,acknowledgement:acknowledgement(saved),connection:await connectionDto(client,updated),replayed:false};
 });
}
export async function disconnectMeta(projectId:string,userId:string,connectionId:string,raw:unknown){
 const input=parse(z.object({requestId:id,revision,revokeAtMeta:z.boolean()}).strict(),raw),operation='meta.disconnect:'+parse(id,connectionId),receiptInput={userId,...input};
 const acknowledgement={requestId:input.requestId,connectionId,revision:input.revision,revokeAtMeta:input.revokeAtMeta};
 const appId=await connectionAppId(projectId,connectionId),prepared=await transaction(async client=>{const app=await registration(client,appId);await scope(client,projectId,userId);const receipt=await contentReceipt(client,projectId,input.requestId,operation,receiptInput),row=await connection(client,projectId,connectionId);if(receipt.replayed)return {result:receipt.result as {acknowledgement:typeof acknowledgement;disconnected:true;remoteRevocation:string},remote:null};cas(row,input.revision);
  let remote:{appId:string;appSecret:string;token:string}|null=null;if(input.revokeAtMeta&&row.encrypted_token)try{remote={appId:app.app_id,appSecret:appSecrets(app).appSecret,token:provider(z.object({accessToken:secret(4096)}).strict(),decryptCredentials(row.encrypted_token,metaConnectionContext(row))).accessToken};}catch{/* Local erasure never depends on a readable key. */}
  await client.query("UPDATE meta_connection SET revision=LEAST(revision::bigint+1,2147483647)::integer,status=CASE WHEN status='deleted' THEN status ELSE 'disconnected' END,encrypted_token=NULL,disconnected_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[row.id]);
  await client.query("UPDATE meta_oauth_flow SET phase='cancelled',state_hash=NULL,browser_hash=NULL,session_id=NULL,name=NULL WHERE connection_id=$1 AND phase IN ('pending','exchanging')",[row.id]);
  const result={acknowledgement,disconnected:true as const,remoteRevocation:input.revokeAtMeta?'unconfirmed':'not_requested'};await receipt.save(result);return {result,remote};
 });
 if(prepared.remote){let confirmed=false;try{confirmed=provider(z.object({success:z.literal(true)}),(await metaRequest({operation:'revoke',...prepared.remote})).data).success;}catch{/* Local removal stays committed; no automatic remote retry. */}
  await transaction(async client=>{await scope(client,projectId,userId);if(confirmed){prepared.result.remoteRevocation='confirmed';await client.query('UPDATE project_content_request SET result=$3 WHERE project_id=$1 AND request_id=$2',[projectId,input.requestId,JSON.stringify(prepared.result)]);}});
 }
 return prepared.result;
}

export async function assertMetaCredentialsReadable(){const {pool}=getDatabase();for(const a of(await pool.query<MetaRegistration>('SELECT * FROM meta_app_registration')).rows)appSecrets(a);for(const c of(await pool.query<Connection>('SELECT * FROM meta_connection WHERE encrypted_token IS NOT NULL')).rows)provider(z.object({accessToken:secret(4096)}).strict(),decryptCredentials(c.encrypted_token,metaConnectionContext(c)));for(const d of(await pool.query('SELECT * FROM meta_deletion_request')).rows)provider(z.object({code:secret(128)}).strict(),decryptCredentials(d.encrypted_confirmation,metaDeletionContext(d)));}
/** No completed grant receipt is time-pruned: callbacks need its historical data provenance. */
export async function expireMetaFlows(){const result=await getDatabase().pool.query(`WITH old AS (SELECT id FROM meta_oauth_flow WHERE phase<>'completed' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) DELETE FROM meta_oauth_flow f USING old WHERE f.id=old.id`);return {expiredFlows:result.rowCount??0};}
export async function rotateMetaCredentials(){await transaction(async client=>{await client.query('LOCK meta_app_registration,meta_connection,meta_oauth_flow,meta_deletion_request IN EXCLUSIVE MODE');for(const a of(await client.query<MetaRegistration>('SELECT * FROM meta_app_registration')).rows)await client.query('UPDATE meta_app_registration SET encrypted_config=$2 WHERE id=$1',[a.id,encryptCredentials(appSecrets(a),metaAppContext(a))]);for(const c of(await client.query<Connection>('SELECT * FROM meta_connection WHERE encrypted_token IS NOT NULL')).rows){const context=metaConnectionContext(c);await client.query('UPDATE meta_connection SET encrypted_token=$2 WHERE id=$1',[c.id,encryptCredentials(decryptCredentials(c.encrypted_token,context),context)]);}for(const d of(await client.query('SELECT * FROM meta_deletion_request')).rows){const context=metaDeletionContext(d);await client.query('UPDATE meta_deletion_request SET encrypted_confirmation=$2 WHERE id=$1',[d.id,encryptCredentials(decryptCredentials(d.encrypted_confirmation,context),context)]);}});}
/** Offline restore hook: keep all web/worker writers stopped. No provider request or token decryption. */
export async function quarantineMetaConnections(){return transaction(async client=>{await client.query('UPDATE meta_app_registration SET enabled=false,revision=LEAST(revision::bigint+1,2147483647)::integer,updated_at=clock_timestamp()');const flows=await client.query("UPDATE meta_oauth_flow SET phase='cancelled',state_hash=NULL,browser_hash=NULL,session_id=NULL,name=NULL WHERE phase IN ('pending','exchanging')");return {invalidatedFlows:flows.rowCount??0};});}
