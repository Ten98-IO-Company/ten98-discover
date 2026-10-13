import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {assertMetaGrantAllowed,listMetaConnections,metaAppContext,metaConnectionContext,metaSubjectHash,withMetaRegistration,type MetaSecrets} from '../src/server/meta-auth.ts';
import {acceptMetaDeletion,getMetaDeletionStatus,runMetaDeletionBatch} from '../src/server/meta-callbacks.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

// Only a newly created, migrated, disposable local fixture. No worker/provider starts,
// no destructive reset, and no customer/source database is accepted.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig(),url=new URL(config.databaseUrl);
const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_callbacks_ci';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.port,ci?'5432':'55501');
assert.match(url.pathname,/^\/ten98_meta_callbacks_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));
assert.ok(process.env.CREDENTIAL_KEYS&&process.env.CREDENTIAL_ACTIVE_KEY&&!process.env.CREDENTIAL_KEYS_FILE);
const pool=getDatabase().pool,original={fetch:globalThis.fetch,keys:process.env.CREDENTIAL_KEYS,active:process.env.CREDENTIAL_ACTIVE_KEY};
let outbound=0;
globalThis.fetch=async()=>{outbound++;throw new Error('External requests are forbidden in Meta callback acceptance.');};
const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const subject='90071992547409931234567890',otherSubject='90071992547409931234567891';
const sign=(text:string,key:string)=>{const encoded=Buffer.from(text).toString('base64url');return createHmac('sha256',key).update(encoded).digest('base64url')+'.'+encoded;};
const payload=(user=subject,at=1)=>JSON.stringify({algorithm:'HMAC-SHA256',user_id:user,issued_at:at,expires:at+1});
type App={id:string;secrets:MetaSecrets};
type Project={owner:string;workspace:string;id:string};
let nextAccount=1;
async function app(appId:string):Promise<App>{
  const id=randomUUID(),secrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode)
    VALUES($1,$2,'12345',1,1,$3,false,false,$4,'development')`,[id,appId,encryptCredentials(secrets,metaAppContext({id,credential_revision:1})),config.appUrl]);
  return {id,secrets};
}
async function project():Promise<Project>{
  const owner=randomUUID(),workspace=randomUUID(),id=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Meta callback fixture\',$2)',[owner,owner+'@meta-callback.integration.test']);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta callback fixture')",[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Meta callback fixture','https://meta-callback.integration.test',$3,'infinity')",[id,workspace,randomUUID()]);
  return {owner,workspace,id};
}
async function grant(a:App,p:Project,user=subject,startEpoch='1',existing?:string){
  const id=existing??randomUUID(),flow=randomUUID();
  const version=existing?(await pool.query('SELECT revision FROM meta_connection WHERE id=$1',[id])).rows[0].revision+1:1;
  const token=encryptCredentials({accessToken:'synthetic-user-token-'+flow},metaConnectionContext({id,workspace_id:p.workspace,revision:version}));
  if(!existing)await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,revision,status,encrypted_token,account_id,account_name,currency,time_zone,account_status,validated_at)
    VALUES($1,$2,$3,'Authored connection label',$4,'ready',$5,$6,'Provider account name','USD','UTC',1,clock_timestamp())`,[id,p.workspace,p.id,version,token,'123456'+nextAccount++]);
  else await pool.query("UPDATE meta_connection SET revision=$2,status='ready',deleted_at=NULL,encrypted_token=$3,account_id='999123',account_name='New independently granted name',validated_at=clock_timestamp() WHERE id=$1",[id,version,token]);
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at)
    VALUES($1,$2,1,$3,$4,$5,$6,$7,'completed',$8,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp()+interval '10 minutes')`,[flow,a.id,startEpoch,p.workspace,p.id,p.owner,id,metaSubjectHash(a.secrets,user)]);
  await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[id,flow]);
  return {id,flow};
}
async function epoch(a:App){return (await pool.query('SELECT lifecycle_epoch FROM meta_app_registration WHERE id=$1',[a.id])).rows[0].lifecycle_epoch as string;}
async function receipt(a:App){return (await pool.query('SELECT * FROM meta_deletion_request WHERE registration_id=$1 ORDER BY received_at DESC,id DESC LIMIT 1',[a.id])).rows[0];}
async function connection(id:string){return (await pool.query('SELECT * FROM meta_connection WHERE id=$1',[id])).rows[0];}
async function flow(id:string){return (await pool.query('SELECT * FROM meta_oauth_flow WHERE id=$1',[id])).rows[0];}
async function allowed(a:App,startEpoch:string,user=subject){return withMetaRegistration(a.id,(client)=>assertMetaGrantAllowed(client,{registrationId:a.id,subjectHash:metaSubjectHash(a.secrets,user),startEpoch}));}
async function drain(maximum=12){for(let i=0;i<maximum;i++){const result=await runMetaDeletionBatch();if(!result.pending)return;}assert.fail('Bounded fixture cleanup did not converge.');}

try{
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM workspace')).rows[0].count,0,'Use a fresh empty fixture database.');
  const a=await app('123456789'),p=await project(),p2=await project(),foreign=await app('987654321');
  const own=await grant(a,p),otherWorkspace=await grant(a,p2),foreignSubject=await grant(a,p2,otherSubject),foreignApp=await grant(foreign,p);
  await pool.query('UPDATE meta_connection SET account_id=(SELECT account_id FROM meta_connection WHERE id=$1) WHERE id=$2',[own.id,foreignSubject.id]);
  await assert.rejects(acceptMetaDeletion(a.id,sign(payload(),'wrong-secret')),fail(400));
  assert.equal(await epoch(a),'1');assert.equal(await receipt(a),undefined);
  await pool.query("CREATE FUNCTION meta_callback_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$");
  await pool.query('CREATE TRIGGER meta_callback_reject_insert BEFORE INSERT ON meta_deletion_request FOR EACH ROW EXECUTE FUNCTION meta_callback_reject_insert()');
  await assert.rejects(acceptMetaDeletion(a.id,sign(payload(),a.secrets.appSecret)));
  assert.equal(await epoch(a),'1');assert.equal(await receipt(a),undefined);
  await pool.query('DROP TRIGGER meta_callback_reject_insert ON meta_deletion_request');await pool.query('DROP FUNCTION meta_callback_reject_insert()');
  console.log('PASS signed deletion admission rejects invalid signatures and rolls back its epoch together with a failed receipt');

  const signed=sign(payload(),a.secrets.appSecret),answers=await Promise.all(Array.from({length:6},()=>acceptMetaDeletion(a.id,signed)));
  for(const answer of answers)assert.deepEqual(answer,answers[0]);
  const answer=answers[0],record=await receipt(a);
  assert.equal(await epoch(a),'2');assert.equal((await pool.query('SELECT count(*)::int AS count FROM meta_deletion_request WHERE registration_id=$1',[a.id])).rows[0].count,1);
  assert.equal(record.subject_hash,metaSubjectHash(a.secrets,subject));assert.equal(record.issued_at_seconds,'1');assert.equal(record.expires_seconds,'2');
  assert.equal(record.confirmation_hash,createHash('sha256').update(answer.confirmation_code).digest('hex'));
  assert.ok(!JSON.stringify(record).includes(answer.confirmation_code));assert.ok(!JSON.stringify(record).includes(subject));
  assert.equal(answer.url,config.appUrl+'/api/meta/deletion-status/'+answer.confirmation_code);
  const status=await getMetaDeletionStatus(answer.confirmation_code);assert.equal(status.status,'queued');assert.equal(status.scope,'local_application');assert.deepEqual(Object.keys(status).sort(),['message','scope','status']);
  for(const code of ['',answer.confirmation_code+'\n',randomBytes(32).toString('base64url')])await assert.rejects(getMetaDeletionStatus(code),fail(404));
  const listed=await listMetaConnections(p.id,p.owner),masked=listed.connections.find(row=>row.id===own.id)!;
  assert.equal(masked.status,'deleted');assert.equal(masked.account,null);assert.deepEqual(masked.scopes,[]);assert.equal(masked.accessExpiresAt,null);
  await assert.rejects(allowed(a,'1'),fail(409));await assert.rejects(allowed(a,'2'),fail(409));await allowed(a,'1',otherSubject);
  console.log('PASS concurrent redelivery has one encrypted receipt and immediate subject-scoped access fencing, with private public status');

  const oldSecret=a.secrets.appSecret;a.secrets.appSecret='rotated-'+randomUUID();
  await pool.query('UPDATE meta_app_registration SET revision=2,credential_revision=2,encrypted_config=$2 WHERE id=$1',[a.id,encryptCredentials(a.secrets,metaAppContext({id:a.id,credential_revision:2}))]);
  await assert.rejects(acceptMetaDeletion(a.id,signed),fail(400));
  assert.deepEqual(await acceptMetaDeletion(a.id,sign(payload(),a.secrets.appSecret)),answer);assert.equal(await epoch(a),'2');
  const protectedSubject=await connection(foreignSubject.id),protectedApp=await connection(foreignApp.id);
  delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
  try{await drain();assert.equal((await getMetaDeletionStatus(answer.confirmation_code)).status,'local_deleted');}
  finally{process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;}
  for(const item of [own,otherWorkspace]){const row=await connection(item.id);assert.equal(row.status,'deleted');assert.equal(row.encrypted_token,null);for(const key of ['account_id','account_name','currency','time_zone','account_status','validated_at'])assert.equal(row[key],null);assert.equal(row.name,'Authored connection label');const g=await flow(item.flow);assert.equal(g.phase,'completed');assert.equal(g.subject_hash,record.subject_hash);assert.equal(g.scopes,null);assert.equal(g.token_type,null);assert.equal(g.access_expires_at,null);assert.equal(g.data_access_expires_at,null);assert.ok(g.invalidated_at);}
  assert.deepEqual(await connection(foreignSubject.id),protectedSubject);assert.deepEqual(await connection(foreignApp.id),protectedApp);
  assert.equal((await receipt(a)).cleaned_connections,'2');await assert.rejects(allowed(a,'1'),fail(409));await allowed(a,'2');
  assert.deepEqual(await runMetaDeletionBatch(),{processedRequests:0,cleanedGrants:0,cleanedConnections:0,pending:false});
  assert.notEqual(oldSecret,a.secrets.appSecret);
  console.log('PASS current-secret rotation preserves receipt identity; keyless cleanup erases only covered grants across workspaces and leaves old grants fenced');

  const newer=await grant(a,p,subject,'2');
  assert.deepEqual(await acceptMetaDeletion(a.id,sign(payload(),a.secrets.appSecret)),answer);await allowed(a,'2');assert.equal((await connection(newer.id)).status,'ready');
  const second=await acceptMetaDeletion(a.id,sign(payload(subject,3),a.secrets.appSecret));assert.notEqual(second.confirmation_code,answer.confirmation_code);assert.equal(await epoch(a),'3');await assert.rejects(allowed(a,'2'),fail(409));
  await drain();assert.equal((await connection(newer.id)).status,'deleted');assert.equal((await receipt(a)).cleaned_connections,'1');
  console.log('PASS an old receipt cannot erase later reconsent; a newly signed deletion fences and cleans that newer grant');

  const bulk=await app('123123123'),bp=await project(),items=[];
  for(let i=0;i<53;i++)items.push(await grant(bulk,bp));
  await pool.query('UPDATE meta_connection SET revision=2147483647,encrypted_token=$2 WHERE id=$1',[items[0].id,encryptCredentials({accessToken:'synthetic-max-revision-token'},metaConnectionContext({id:items[0].id,workspace_id:bp.workspace,revision:2147483647}))]);
  const replaced=await grant(bulk,bp),replacement=await grant(bulk,bp,otherSubject,'1',replaced.id),preserved=await connection(replacement.id);
  await pool.query('UPDATE meta_oauth_flow SET invalidated_at=clock_timestamp() WHERE id=$1',[items[0].flow]);
  const bulkAnswer=await acceptMetaDeletion(bulk.id,sign(payload(),bulk.secrets.appSecret));
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM meta_app_registration WHERE id=$1 FOR UPDATE',[bulk.id]);
  try{assert.deepEqual(await runMetaDeletionBatch(),{processedRequests:0,cleanedGrants:0,cleanedConnections:0,pending:true});assert.equal((await getMetaDeletionStatus(bulkAnswer.confirmation_code)).status,'queued');}
  finally{await blocker.query('ROLLBACK');blocker.release();}
  await pool.query("CREATE FUNCTION meta_callback_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$");
  await pool.query('CREATE TRIGGER meta_callback_reject_update BEFORE UPDATE ON meta_deletion_request FOR EACH ROW EXECUTE FUNCTION meta_callback_reject_update()');
  const before=await connection(items[1].id);await assert.rejects(runMetaDeletionBatch());assert.deepEqual(await connection(items[1].id),before);assert.equal((await receipt(bulk)).status,'queued');assert.equal((await receipt(bulk)).cleaned_connections,'0');assert.notEqual((await flow(items[1].flow)).scopes,null);
  await pool.query('DROP TRIGGER meta_callback_reject_update ON meta_deletion_request');await pool.query('DROP FUNCTION meta_callback_reject_update()');
  const batch=await runMetaDeletionBatch();assert.equal(batch.cleanedGrants,50);assert.ok(batch.cleanedConnections===49||batch.cleanedConnections===50);assert.equal(batch.pending,true);assert.equal((await receipt(bulk)).status,'cleaning');
  const tail=await runMetaDeletionBatch();assert.equal(tail.cleanedGrants,4);assert.equal(tail.pending,false);assert.equal((await receipt(bulk)).cleaned_connections,'53');
  assert.deepEqual(await connection(replacement.id),preserved);assert.equal((await flow(replaced.flow)).scopes,null);assert.notEqual((await flow(replacement.flow)).scopes,null);
  for(const item of items)assert.equal((await connection(item.id)).status,'deleted');
  assert.equal((await connection(items[0].id)).revision,2147483647);
  console.log('PASS cleanup is bounded, restart-safe and atomic; skipped gates never complete early, and later different-subject credentials survive');

  const empty=await app('654654654'),noData=await acceptMetaDeletion(empty.id,sign(payload(),empty.secrets.appSecret));
  assert.deepEqual(await runMetaDeletionBatch(),{processedRequests:1,cleanedGrants:0,cleanedConnections:0,pending:false});
  assert.equal((await getMetaDeletionStatus(noData.confirmation_code)).status,'local_deleted');
  assert.equal(outbound,0);
  console.log('PASS no-data requests get truthful local completion with zero external calls');

  const httpApp=await app('789789789'),httpSigned=sign(payload(),httpApp.secrets.appSecret),path=`/api/meta/apps/${httpApp.id}/delete-data`;
  const form=new URLSearchParams({signed_request:httpSigned}).toString();
  const call=(suffix:string,init?:RequestInit)=>handleApi(new Request(config.appUrl+suffix,init));
  const post=(body=form,extra:Record<string,string>={},suffix=path)=>call(suffix,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...extra},body});
  const accepted=await post();assert.equal(accepted.status,200);const httpAnswer=await accepted.json();assert.equal(accepted.headers.get('cache-control'),'no-store');assert.equal(accepted.headers.get('referrer-policy'),'no-referrer');assert.equal(accepted.headers.get('x-content-type-options'),'nosniff');
  const publicReplay=await post(form,{origin:'https://provider-callback.example'});assert.equal(publicReplay.status,200);assert.deepEqual(await publicReplay.json(),httpAnswer);
  const statusPath=new URL(httpAnswer.url).pathname,statusResponse=await call(statusPath);assert.equal(statusResponse.status,200);assert.equal((await statusResponse.json()).status,'queued');
  const page=await call(statusPath,{headers:{accept:'text/html'}});assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')??'',/default-src 'none'/);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  const html=await page.text();for(const value of [subject,httpApp.id,httpApp.secrets.appSecret,p.workspace,p.id])assert.ok(!html.includes(value));
  assert.equal((await call(path)).status,405);assert.equal((await call(statusPath,{method:'POST'})).status,405);assert.equal((await call(statusPath+'?extra=1')).status,400);
  for(const body of [form+'&'+form,form+'&extra=value','other='+httpSigned,'signed_request='])assert.equal((await post(body)).status,400);
  assert.equal((await post(JSON.stringify({signed_request:httpSigned}),{'content-type':'application/json'})).status,415);
  assert.equal((await post(form,{},path+'?signed_request=x')).status,400);
  assert.equal((await post('signed_request='+'a'.repeat(32768),{'content-length':'1'})).status,413);
  assert.equal((await post(new URLSearchParams({signed_request:sign(payload(),'wrong-secret')}).toString())).status,400);
  const key=await createApiKey(p.workspace,p.owner,{name:'Callback route fixture',scopes:['projects:read'],expiresInDays:1});
  assert.equal((await post(form,{authorization:'Bearer '+key.token})).status,403);
  assert.equal((await call(statusPath,{headers:{authorization:'Bearer '+key.token}})).status,403);
  let cancelled=false;const controller=new AbortController(),stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});controller.abort();
  const cancelledResponse=await call(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:stream,signal:controller.signal,duplex:'half'} as RequestInit);assert.equal(cancelledResponse.status,408);assert.equal(cancelled,true);
  await pool.query(`INSERT INTO request_limit(key,minute,count) VALUES('meta:deletion-callback',floor(extract(epoch FROM now())/60),300)
    ON CONFLICT(key,minute) DO UPDATE SET count=300`);
  assert.equal((await post()).status,429);assert.equal(await epoch(httpApp),'2');
  console.log('PASS real API validates bounded native forms, public signature authority, method/query rules, stream cancellation, no-store isolated status and rate limits');

  const childEnv={...process.env};delete childEnv.CREDENTIAL_KEYS;delete childEnv.CREDENTIAL_ACTIVE_KEY;
  const noNetwork='data:text/javascript,'+encodeURIComponent("globalThis.fetch=async()=>{throw new Error('No external requests in cleanup CLI test');}");
  const cli=spawnSync(process.execPath,['--import',noNetwork,'src/server/cli.ts','meta-cleanup'],{cwd:process.cwd(),env:childEnv,encoding:'utf8',timeout:20000,maxBuffer:64000,windowsHide:true});
  assert.equal(cli.status,0,'Keyless explicit cleanup CLI must finish without starting provider workers.');
  for(const value of [config.databaseUrl,config.authSecret,config.bootstrapToken,original.keys])assert.ok(!(cli.stdout+cli.stderr).includes(value));
  assert.equal((await getMetaDeletionStatus(httpAnswer.confirmation_code)).status,'local_deleted');assert.equal(outbound,0);
  console.log('PASS explicit operator cleanup CLI finishes after vault loss without weakening paid-worker startup guards');
}finally{
  globalThis.fetch=original.fetch;process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;await closeDatabase();
}
