import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {disconnectMeta,metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {acceptMetaDeletion,getMetaDeletionStatus,runMetaDeletionBatch} from '../src/server/meta-callbacks.ts';
import {cancelMetaImport,enqueueMetaImport,expireMetaImportPages,listMetaImports,metaQueue,readMetaImport} from '../src/server/meta-imports.ts';
import {normalizeMetaRows} from '../src/server/meta-report-rows.ts';
import {getRetention,previewRetention} from '../src/server/retention.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const addDays=(day:string,n:number)=>{const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);};
function localDay(zone:string){const parts=new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');}
function monthsBefore(day:string,n:number){const [y,m,d]=day.split('-').map(Number),date=new Date(Date.UTC(y,m-1-n,1));date.setUTCDate(Math.min(d,new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()));return date.toISOString().slice(0,10);}

export async function runMetaImportChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_imports_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('No provider requests are permitted in Meta import service tests.');};
 const owner=randomUUID(),peer=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),foreign=randomUUID();
 const app=randomUUID(),secrets:MetaSecrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};
 let next=10000;
 type Source={id:string;grant:string;accountId:string;subject:string;timeZone:string};
 async function source(timeZone='Pacific/Kiritimati',scope={workspace,project}):Promise<Source>{
  const id=randomUUID(),grant=randomUUID(),accountId=String(++next),subject=String(++next);
  const encrypted=encryptCredentials({accessToken:'synthetic-'+id},metaConnectionContext({id,workspace_id:scope.workspace,revision:1}));
  await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,revision,status,encrypted_token,account_id,account_name,currency,time_zone,account_status,validated_at)
   VALUES($1,$2,$3,'Synthetic report source',1,'ready',$4,$5,'Original account name','AED',$6,1,clock_timestamp())`,[id,scope.workspace,scope.project,encrypted,accountId,timeZone]);
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at)
   VALUES($1,$2,1,1,$3,$4,$5,$6,'completed',$7,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp()+interval '10 minutes')`,[grant,app,scope.workspace,scope.project,owner,id,metaSubjectHash(secrets,subject)]);
  await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[id,grant]);return {id,grant,accountId,subject,timeZone};
 }
 function request(s:Source,from=addDays(localDay(s.timeZone),-1),to=from){return {requestId:randomUUID(),revision:1,report:'campaign_daily' as 'campaign_daily'|'account_daily',from,to};}
 async function enqueue(s:Source,input=request(s)){return enqueueMetaImport(project,owner,s.id,input);}
 async function cancel(id:string){return cancelMetaImport(project,owner,id,{requestId:randomUUID()});}
 async function stored(id:string){return(await pool.query('SELECT *,date_from::text AS date_from,date_to::text AS date_to FROM meta_import WHERE id=$1',[id])).rows[0];}
 async function terminal(id:string,status='completed'){await pool.query('UPDATE meta_import SET status=$2,completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1',[id,status]);}
 async function pages(id:string,s:Source,count:number,rowsPerPage=1){
  const record=await stored(id),day=record.date_from as string;
  for(let page=0;page<count;page++){
   const rows=normalizeMetaRows(Array.from({length:rowsPerPage},(_,i)=>({account_id:s.accountId,account_currency:'AED',date_start:day,date_stop:day,campaign_id:String(page*rowsPerPage+i+1),campaign_name:'Synthetic campaign',impressions:i%2?'0':null,clicks:i%2?'0':null,spend:i%2?'0.00':null,actions:i%2?[]:null,action_values:null})),{report:'campaign_daily',accountId:s.accountId,currency:'AED',from:day,to:day});
   await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,project,workspace,page,JSON.stringify(rows),rows.length,hash(rows)]);
  }
  await pool.query('UPDATE meta_import SET pages=$2,row_count=$3 WHERE id=$1',[id,count,count*rowsPerPage]);
 }
 try{
  for(const uid of [owner,peer,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Meta import fixture\',$2)',[uid,uid+'@integration.test']);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta import fixture')",[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'viewer')",[workspace,owner,peer,viewer]);
  for(const id of [project,foreign])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Meta import fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.example.test',randomUUID()]);
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode)
   VALUES($1,'12345','12346',1,1,$2,true,true,$3,'development')`,[app,encryptCredentials(secrets,metaAppContext({id:app,credential_revision:1})),config.appUrl]);

  const a=await source(),input=request(a);
  await assert.rejects(enqueueMetaImport(project,viewer,a.id,input),fail(404));await assert.rejects(enqueueMetaImport(project,outsider,a.id,input),fail(404));await assert.rejects(enqueueMetaImport(foreign,owner,a.id,input),fail(404));
  const first=await enqueue(a,input);assert.equal(first.replayed,false);assert.equal(first.import.dataStatus,'pending');assert.equal(first.import.readableRows,null);
  const firstAck={requestId:input.requestId,importId:first.import.id,connectionId:a.id,revision:input.revision,report:input.report,from:input.from,to:input.to};assert.deepEqual(first.acknowledgement,firstAck);
  assert.equal((await enqueue(a,input)).import.id,first.import.id);assert.equal((await enqueue(a,input)).replayed,true);
  await assert.rejects(enqueue(a,{...input,report:'account_daily'}),fail(409));await assert.rejects(enqueueMetaImport(project,peer,a.id,input),fail(409));
  await assert.rejects(enqueue(a),fail(409));assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND data->>\'importId\'=$2',[metaQueue,first.import.id])).rows[0].n,1);
  await assert.rejects(readMetaImport(foreign,owner,first.import.id),fail(404));await assert.rejects(readMetaImport(project,outsider,first.import.id),fail(404));assert.equal((await readMetaImport(project,viewer,first.import.id)).role,'viewer');
  await assert.rejects(cancelMetaImport(project,viewer,first.import.id,{requestId:randomUUID()}),fail(404));await assert.rejects(cancelMetaImport(foreign,owner,first.import.id,{requestId:randomUUID()}),fail(404));
  console.log('PASS owner-only starts/cancel, member reads, actor/body replay, tenant isolation and one active import');

  const rollback=await source(),key=request(rollback),boss=await getBoss(),originalSend=boss.send.bind(boss);let inserted:string|undefined;
  boss.send=(async(...args:any[])=>{const id=await(originalSend as any)(...args);assert.equal(typeof id,'string');inserted=id;throw new Error('Synthetic failure after real queue insertion.');})as typeof boss.send;
  try{await assert.rejects(enqueue(rollback,key),/Synthetic failure/);}finally{boss.send=originalSend;}
  assert.ok(inserted);assert.equal((await pool.query('SELECT 1 FROM pgboss.job WHERE id=$1',[inserted])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM meta_import WHERE request_id=$1',[key.requestId])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[key.requestId])).rowCount,0);
  const retried=await enqueue(rollback,key);assert.equal(retried.replayed,false);await cancel(retried.import.id);
  const raced=await source(),race=await Promise.allSettled([enqueue(raced),enqueue(raced)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.ok(race.some(r=>r.status==='rejected'&&fail(409)(r.reason)));await cancel((race.find(r=>r.status==='fulfilled')as PromiseFulfilledResult<Awaited<ReturnType<typeof enqueue>>>).value.import.id);
  console.log('PASS real queue insertion, import and receipt roll back atomically; concurrent requests admit one import');

  const raw=await stored(first.import.id);assert.equal(raw.grant_id,a.grant);assert.equal(raw.app_revision,1);assert.equal(raw.connection_revision,1);assert.equal(raw.user_id,owner);assert.deepEqual(raw.source,first.import.source);
  await pool.query("UPDATE meta_connection SET account_name='Current changed name',currency='USD',time_zone='UTC' WHERE id=$1",[a.id]);assert.deepEqual((await readMetaImport(project,viewer,first.import.id)).import.source,first.import.source);
  await disconnectMeta(project,owner,a.id,{requestId:randomUUID(),revision:1,revokeAtMeta:false});
  const keys=process.env.CREDENTIAL_KEYS,active=process.env.CREDENTIAL_ACTIVE_KEY;delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
  try{
   const replay=await enqueue(a,input);assert.equal(replay.import.id,first.import.id);assert.equal(replay.replayed,true);
   assert.deepEqual(replay.acknowledgement,firstAck);
   const cancelInput={requestId:randomUUID()},cancelled=await cancelMetaImport(project,owner,first.import.id,cancelInput);assert.equal(cancelled.import.status,'cancelled');assert.equal((await cancelMetaImport(project,owner,first.import.id,cancelInput)).replayed,true);
   assert.deepEqual(cancelled.acknowledgement,{requestId:cancelInput.requestId,importId:first.import.id});
   await assert.rejects(cancelMetaImport(project,peer,first.import.id,cancelInput),fail(409));assert.equal((await enqueue(a,input)).import.status,'cancelled');
  }finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
  assert.equal((await stored(first.import.id)).grant_id,a.grant);
  console.log('PASS immutable captured source/grant, keyless replay after disconnect and keyless cancellation receipts');

  for(const zone of ['Pacific/Kiritimati','Pacific/Honolulu']){
   const s=await source(zone),today=localDay(zone),earliest=monthsBefore(today,37);
   const range=await enqueue(s,request(s,addDays(today,-30),today));assert.deepEqual(range.import.warnings,['current_day_provisional']);await cancel(range.import.id);
   const edge=await enqueue(s,request(s,earliest));assert.deepEqual(edge.import.warnings,[]);await cancel(edge.import.id);
   for(const [from,to]of [[addDays(today,-31),today],[addDays(earliest,-1),earliest],[today,addDays(today,1)],[today,addDays(today,-1)],['2024-02-30','2024-02-30']])await assert.rejects(enqueue(s,request(s,from,to)),fail(400));
  }
  console.log('PASS source-local calendar dates,31-day inclusive capacity, clamped37-month history and current-day warning');

  const s=await source(),staged=await enqueue(s);await pages(staged.import.id,s,2,31);
  const hidden=await readMetaImport(project,viewer,staged.import.id);assert.deepEqual(hidden.rows,[]);assert.equal(hidden.import.dataStatus,'pending');assert.equal(hidden.import.readableRows,null);
  await terminal(staged.import.id);const page=await readMetaImport(project,viewer,staged.import.id);assert.equal(page.rows.length,50);assert.equal(page.import.coverage,'complete');assert.equal(page.import.readableRows,62);assert.ok(page.nextCursor);
  assert.equal(page.rows[0].spend,null);assert.equal(page.rows[1].spend,'0.00');assert.equal(page.rows[0].clicks,null);assert.equal(page.rows[1].clicks,'0');assert.equal(page.rows[0].actions,null);assert.deepEqual(page.rows[1].actions,[]);
  const tail=await readMetaImport(project,viewer,staged.import.id,new URLSearchParams({cursor:page.nextCursor}));assert.equal(tail.rows.length,12);assert.equal(tail.nextCursor,null);assert.equal(new Set([...page.rows,...tail.rows].map(r=>r.campaignId)).size,62);
  const empty=await enqueue(s);await terminal(empty.import.id);const noRows=await readMetaImport(project,viewer,empty.import.id);assert.deepEqual(noRows.rows,[]);assert.equal(noRows.import.dataStatus,'available');assert.equal(noRows.import.readableRows,0);assert.equal(noRows.import.coverage,'complete');
  await assert.rejects(readMetaImport(project,viewer,empty.import.id,new URLSearchParams({cursor:page.nextCursor})),fail(400));await assert.rejects(readMetaImport(project,viewer,empty.import.id,new URLSearchParams('cursor=x&cursor=y')),fail(400));
  const partial=await enqueue(s);await pages(partial.import.id,s,1,2);await terminal(partial.import.id,'partial');assert.equal((await readMetaImport(project,viewer,partial.import.id)).import.coverage,'partial');assert.equal((await readMetaImport(project,viewer,partial.import.id)).rows.length,2);
  const failed=await enqueue(s);await pages(failed.import.id,s,1,2);await terminal(failed.import.id,'failed');const failure=await readMetaImport(project,viewer,failed.import.id);assert.deepEqual(failure.rows,[]);assert.equal(failure.import.dataStatus,'unavailable');assert.equal(failure.import.readableRows,null);
  console.log('PASS staged pages remain hidden; complete empty, partial, failed and null/zero measurements stay distinct');

  const copied=await stored(staged.import.id);
  await pool.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,completed_at,created_at)
   SELECT gen_random_uuid(),workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,gen_random_uuid(),report,date_from,date_to,source,'completed',clock_timestamp(),clock_timestamp()-interval '1 day'+g*interval '1 microsecond' FROM meta_import CROSS JOIN generate_series(1,53)g WHERE id=$1`,[staged.import.id]);
  await pool.query("UPDATE meta_import SET completed_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[staged.import.id]);
  const history=await listMetaImports(project,viewer,s.id);assert.equal(history.imports.length,50);assert.ok(history.nextCursor);const rest=await listMetaImports(project,viewer,s.id,new URLSearchParams({cursor:history.nextCursor}));
  const expected=(await pool.query('SELECT id FROM meta_import WHERE connection_id=$1 ORDER BY created_at DESC,id DESC',[s.id])).rows.map(r=>r.id);assert.deepEqual([...history.imports,...rest.imports].map(r=>r.id),expected);
  await assert.rejects(listMetaImports(project,viewer,a.id,new URLSearchParams({cursor:history.nextCursor})),fail(400));await assert.rejects(listMetaImports(foreign,owner,s.id),fail(404));assert.deepEqual((await stored(staged.import.id)).source,copied.source);
  console.log('PASS history follows request order with exact microsecond cursors and source-bound pagination');

  const aging=await source(),old=await enqueue(aging);await pages(old.import.id,aging,7);await terminal(old.import.id);await pool.query("UPDATE meta_import SET completed_at=clock_timestamp()-interval '400 days' WHERE id=$1",[old.import.id]);
  let expired=await readMetaImport(project,viewer,old.import.id);assert.equal(expired.import.dataStatus,'expired');assert.deepEqual(expired.rows,[]);assert.equal(expired.import.readableRows,null);assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_import_page WHERE import_id=$1',[old.import.id])).rows[0].n,7);
  assert.deepEqual(await expireMetaImportPages(),{imports:1,pages:5});const partialCleanup=await stored(old.import.id);assert.ok(partialCleanup.data_expired_at);assert.equal(partialCleanup.payload_cleanup_completed_at,null);
  await pool.query('UPDATE workspace SET derived_history_days=3650 WHERE id=$1',[workspace]);expired=await readMetaImport(project,viewer,old.import.id);assert.equal(expired.import.dataStatus,'expired');assert.deepEqual(await expireMetaImportPages(),{imports:1,pages:2});assert.ok((await stored(old.import.id)).payload_cleanup_completed_at);assert.deepEqual(await expireMetaImportPages(),{imports:0,pages:0});assert.equal((await stored(old.import.id)).grant_id,aging.grant);
  assert.equal((await enqueue(aging,{...request(aging),requestId:(await stored(old.import.id)).request_id,from:old.import.from,to:old.import.to})).import.dataStatus,'expired');
  console.log('PASS deadline masks immediately; bounded5-page cleanup resumes despite later policy extension and keeps receipt metadata');

  const covered=await source(),victimInput=request(covered),victim=await enqueue(covered,victimInput);await pages(victim.import.id,covered,7);await terminal(victim.import.id);const activeImport=await enqueue(covered);
  const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:covered.subject})).toString('base64url');const signed=createHmac('sha256',secrets.appSecret).update(payload).digest('base64url')+'.'+payload;
  const deletion=await acceptMetaDeletion(app,signed),blocked=await readMetaImport(project,viewer,victim.import.id);assert.equal(blocked.import.source,null);assert.deepEqual(blocked.rows,[]);assert.equal(blocked.import.dataStatus,'unavailable');assert.equal(blocked.import.diagnosticCode,'data_deleted');
  assert.equal((await listMetaImports(project,viewer,covered.id)).imports.every(i=>i.source===null),true);assert.equal((await readMetaImport(project,viewer,activeImport.import.id)).import.source,null);
  const deletedReplay=await enqueue(covered,victimInput);assert.equal(deletedReplay.import.source,null);assert.deepEqual(deletedReplay.acknowledgement,victim.acknowledgement);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_import_page WHERE import_id=$1',[victim.import.id])).rows[0].n,7);assert.ok((await stored(victim.import.id)).source);
  const beforeOther=await stored(staged.import.id);const ring=process.env.CREDENTIAL_KEYS,activeKey=process.env.CREDENTIAL_ACTIVE_KEY;delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
  try{await runMetaDeletionBatch();assert.notEqual((await getMetaDeletionStatus(deletion.confirmation_code)).status,'local_deleted');for(let n=0;n<8;n++){if(!(await runMetaDeletionBatch()).pending)break;}assert.equal((await getMetaDeletionStatus(deletion.confirmation_code)).status,'local_deleted');}finally{process.env.CREDENTIAL_KEYS=ring;process.env.CREDENTIAL_ACTIVE_KEY=activeKey;}
  assert.equal((await stored(victim.import.id)).source,null);assert.ok((await stored(victim.import.id)).payload_cleanup_completed_at);assert.equal((await stored(activeImport.import.id)).status,'denied');assert.equal((await stored(victim.import.id)).grant_id,covered.grant);assert.deepEqual(await stored(staged.import.id),beforeOther);assert.equal(outbound,0);
  console.log('PASS signed deletion masks source and rows before cleanup, drains keylessly and preserves other grant snapshots');
  const password=randomBytes(24).toString('base64url');await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
  const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:owner+'@integration.test',password})}));assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),apiSource=await source(),apiInput=request(apiSource),base=`/api/projects/${project}/meta`;
  const api=(path:string,method='GET',body?:unknown,origin=config.appUrl,session=cookie)=>handleApi(new Request(config.appUrl+path,{method,headers:{cookie:session,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const endpoint=base+'/connections/'+apiSource.id+'/imports';assert.equal((await api(endpoint,'GET',undefined,config.appUrl,'')).status,401);assert.equal((await api(endpoint,'POST',apiInput,'https://foreign.invalid')).status,403);assert.equal((await api(endpoint+'?unexpected=1')).status,400);
  const created=await api(endpoint,'POST',apiInput);assert.equal(created.status,200);assert.equal(created.headers.get('cache-control'),'no-store');const saved=await created.json();assert.deepEqual(saved.acknowledgement,{...apiInput,connectionId:apiSource.id,importId:saved.import.id});
  const resource=base+'/imports/'+saved.import.id;assert.equal((await api(endpoint)).status,200);assert.equal((await api(resource)).status,200);assert.equal((await api(resource,'POST',{})).status,405);assert.equal((await api(resource+'/cancel')).status,405);assert.equal((await api(resource+'?cursor=bad')).status,400);
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);assert.equal((await api(resource)).status,200);assert.equal((await api(endpoint,'POST',request(apiSource))).status,404);assert.equal((await api(resource+'/cancel','POST',{requestId:randomUUID()})).status,404);
  await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);const stopInput={requestId:randomUUID()},stopped=await api(resource+'/cancel','POST',stopInput);assert.equal(stopped.status,200);assert.deepEqual((await stopped.json()).acknowledgement,{requestId:stopInput.requestId,importId:saved.import.id});assert.equal(outbound,0);
  console.log('PASS actual session/Origin/method/query/role import API guards and immutable mutation acknowledgements');

  const previewScope={workspace:randomUUID(),project:randomUUID()},otherProject={workspace:previewScope.workspace,project:randomUUID()},foreignScope={workspace:randomUUID(),project:randomUUID()};
  for(const id of [previewScope.workspace,foreignScope.workspace]){
   await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta retention preview fixture')",[id]);
   await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[id,owner,viewer]);
  }
  const bases:string[]=[];
  for(const scope of [previewScope,otherProject,foreignScope]){
   await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Meta preview',$3,$4,'infinity')",[scope.project,scope.workspace,'https://'+scope.project+'.example.test',randomUUID()]);
   const savedSource=await source('UTC',scope),saved=await enqueueMetaImport(scope.project,owner,savedSource.id,request(savedSource));await terminal(saved.import.id);bases.push(saved.import.id);
  }
  await pool.query("UPDATE meta_import SET completed_at=clock_timestamp()-interval '100 days' WHERE id=ANY($1::uuid[])",[bases.slice(1)]);
  async function previewRows(number:number,age:number,status='completed',expired=false,deleted=false,done=false){
   await pool.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,completed_at,data_expired_at,deleted_at,payload_cleanup_completed_at)
    SELECT gen_random_uuid(),workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,gen_random_uuid(),report,date_from,date_to,
     CASE WHEN $6 THEN NULL ELSE source END,$4,CASE WHEN $4='queued' THEN NULL ELSE clock_timestamp()-make_interval(days=>$3) END,
     CASE WHEN $5 THEN clock_timestamp() END,CASE WHEN $6 THEN clock_timestamp() END,CASE WHEN $7 THEN clock_timestamp() END
    FROM meta_import CROSS JOIN generate_series(1,$2::integer) WHERE id=$1`,[bases[0],number,age,status,expired,deleted,done]);
  }
  await previewRows(1,100);await previewRows(1,100,'failed');await previewRows(1,1,'completed',true);await previewRows(1,1,'denied',false,true);
  await previewRows(1,89);await previewRows(1,100,'completed',true,false,true);await previewRows(1,100,'queued',true);
  const policy=await getRetention(previewScope.workspace,owner),proposal={revision:policy.revision,settings:{...policy.settings,derivedHistoryDays:90}};
  const preview=()=>previewRetention(previewScope.workspace,owner,proposal);
  assert.deepEqual((await preview()).metaEstimate,{status:'available',imports:5,atLeast:false});
  assert.deepEqual((await previewRetention(previewScope.workspace,owner,{...proposal,settings:{...proposal.settings,derivedHistoryDays:3650}})).metaEstimate,{status:'available',imports:2,atLeast:false},'Policy extension must not omit irreversible unfinished cleanup.');
  await assert.rejects(previewRetention(previewScope.workspace,viewer,proposal),fail(403));await assert.rejects(previewRetention(previewScope.workspace,outsider,proposal),fail(404));
  assert.deepEqual((await getRetention(previewScope.workspace,owner)).settings,policy.settings,'Preview must not save the proposed policy.');
  await previewRows(9995,100);assert.deepEqual((await preview()).metaEstimate,{status:'available',imports:10000,atLeast:false});
  await previewRows(1,100);assert.deepEqual((await preview()).metaEstimate,{status:'available',imports:10000,atLeast:true});
  const lock=await pool.connect();
  try{await lock.query('BEGIN');await lock.query('LOCK TABLE meta_import IN ACCESS EXCLUSIVE MODE');assert.deepEqual((await preview()).metaEstimate,{status:'unavailable',imports:null,atLeast:false});}
  finally{await lock.query('ROLLBACK');lock.release();}
  assert.deepEqual((await preview()).metaEstimate,{status:'available',imports:10000,atLeast:true});assert.equal(outbound,0);
  console.log('PASS owner-only Meta retention preview scopes projects/workspaces, counts age and irreversible markers, excludes active/cleaned receipts and bounds estimates with honest lock-timeout fallback');
 }finally{try{await stopJobs();await closeDatabase();}finally{globalThis.fetch=originalFetch;}}
}

if(process.env.TEN98_META_AUTH_TEST==='1')runMetaImportChecks().catch(async error=>{console.error(error instanceof Error?error.message:'Meta import acceptance failed.');await closeDatabase();process.exitCode=1;});
