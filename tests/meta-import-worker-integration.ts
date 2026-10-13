import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {disconnectMeta,metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {acceptMetaDeletion} from '../src/server/meta-callbacks.ts';
import {cancelMetaImport,enqueueMetaImport,expireMetaImportPages,metaQueue,readMetaImport,withMetaImport} from '../src/server/meta-imports.ts';
import {runMetaImportStep,reconcileMetaImports} from '../src/server/meta-import-worker.ts';
import {withMetaTransportForTests,type MetaTransport} from '../src/server/meta-http.ts';

function latch(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),waiting=new Promise<void>(r=>release=r);return {entered,release,hold:async()=>{enter();await waiting;}};}
async function reached(p:Promise<void>){await Promise.race([p,new Promise<never>((_,reject)=>{setTimeout(()=>reject(new Error('Contained provider barrier was not reached.')),5000).unref();})]);}
const tomorrow=()=>Math.floor(Date.now()/1000)+86400;
async function eventually(label:string,deadline:number,check:()=>Promise<boolean>){
 while(Date.now()<deadline){if(await check())return;await wait(100);}
 assert.fail('Timed out waiting for '+label+'.');
}

/** Contained durable steps and actual in-process worker lifecycle; never starts a web server. */
export async function runMetaImportWorkerChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_worker_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const oldFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('Uncontained provider traffic is forbidden.');};
 const owner=randomUUID(),viewer=randomUUID(),app=randomUUID(),secrets:MetaSecrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};
 const day=new Date(Date.now()-86400000).toISOString().slice(0,10);let next=40000,posts=0;
 type Source={id:string;grant:string;workspace:string;project:string;accountId:string;subject:string;revision:number;token:string};
 type Call={op:'account'|'inspect'|'permissions'|'submit'|'status'|'page';url:URL;init:RequestInit};
 type Handler=(call:Call)=>Promise<Response|undefined>|Response|undefined;
 const calls:Call[]=[];
 async function source(knownExpiry=true):Promise<Source>{
  const s:Source={id:randomUUID(),grant:randomUUID(),workspace:randomUUID(),project:randomUUID(),accountId:String(++next),subject:String(++next),revision:1,token:'synthetic-'+randomUUID()};
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta worker fixture')",[s.workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[s.workspace,owner,viewer]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Meta worker fixture','https://example.test',$3,'infinity')",[s.project,s.workspace,randomUUID()]);
  await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,status,encrypted_token,account_id,account_name,currency,time_zone,account_status,validated_at)
   VALUES($1,$2,$3,'Synthetic source','ready',$4,$5,'Original account','AED','UTC',1,clock_timestamp())`,[s.id,s.workspace,s.project,encryptCredentials({accessToken:s.token},metaConnectionContext({id:s.id,workspace_id:s.workspace,revision:1})),s.accountId]);
  await newGrant(s,s.grant,knownExpiry);await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[s.id,s.grant]);return s;
 }
 async function newGrant(s:Source,grant:string=randomUUID(),knownExpiry=true){
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at)
   SELECT $1,id,revision,lifecycle_epoch,$3,$4,$5,$6,'completed',$7,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',CASE WHEN $8 THEN clock_timestamp()+interval '1 day' END,clock_timestamp(),clock_timestamp()+interval '10 minutes' FROM meta_app_registration WHERE id=$2`,[grant,app,s.workspace,s.project,owner,s.id,metaSubjectHash(secrets,s.subject),knownExpiry]);return grant;
 }
 const account=(s:Source)=>({id:'act_'+s.accountId,account_id:s.accountId,name:'Original account',currency:'AED',timezone_name:'UTC',account_status:1});
 const row=(s:Source,campaign='1')=>({account_id:s.accountId,account_currency:'AED',date_start:day,date_stop:day,campaign_id:campaign,campaign_name:'Synthetic campaign',impressions:'0',clicks:null,spend:'0.000000',actions:[],action_values:null});
 const status=(s:Source,state='Job Completed',percent=100)=>({id:'90001',account_id:s.accountId,async_status:state,async_percent_completion:percent,date_start:day,date_stop:day});
 function transport(s:Source,handler:Handler=()=>undefined):MetaTransport{return async(address,init)=>{
  const u=new URL(address);assert.equal(u.origin,'https://graph.facebook.com');assert.ok(u.pathname.startsWith('/v26.0/'));assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  const op:Call['op']=u.pathname.endsWith('/debug_token')?'inspect':u.pathname.endsWith('/me/permissions')?'permissions':init.method==='POST'?'submit':u.pathname.endsWith('/insights')?'page':u.pathname.includes('/act_')?'account':'status';
  if(op==='submit'){posts++;assert.equal(u.pathname,'/v26.0/act_'+s.accountId+'/insights');}
  else if(op!=='inspect')assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+s.token);
  if(op==='page'||op==='status')assert.ok(u.pathname.startsWith('/v26.0/90001'));
  const call={op,url:u,init};calls.push(call);const custom=await handler(call);if(custom)return custom;
  if(op==='inspect')return Response.json({data:{app_id:'12345',user_id:s.subject,type:'USER',is_valid:true,scopes:['ads_read'],expires_at:tomorrow(),data_access_expires_at:0}});
  if(op==='permissions')return Response.json({data:[{permission:'ads_read',status:'granted'}]});
  if(op==='account')return Response.json(account(s));if(op==='submit')return Response.json({report_run_id:'90001'});if(op==='status')return Response.json(status(s));return Response.json({data:[row(s)]});
 };}
 async function queued(s:Source){return(await enqueueMetaImport(s.project,owner,s.id,{requestId:randomUUID(),revision:s.revision,report:'campaign_daily',from:day,to:day})).import.id;}
 async function stored(id:string){return(await pool.query('SELECT * FROM meta_import WHERE id=$1',[id])).rows[0];}
 async function due(id:string){await pool.query('UPDATE meta_import SET next_attempt_at=clock_timestamp()-interval \'1 second\' WHERE id=$1',[id]);}
 async function step(s:Source,id:string,handler?:Handler){await withMetaTransportForTests(transport(s,handler),()=>runMetaImportStep(id));}
 async function reading(s:Source,id:string){await step(s,id);assert.equal((await stored(id)).status,'waiting');await due(id);await step(s,id);assert.equal((await stored(id)).status,'reading');await due(id);}
 async function cancel(s:Source,id:string){await cancelMetaImport(s.project,owner,id,{requestId:randomUUID()});}
 async function signedDelete(s:Source){const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:s.subject,issued_at:Math.floor(Date.now()/1000)})).toString('base64url');return acceptMetaDeletion(app,createHmac('sha256',secrets.appSecret).update(payload).digest('base64url')+'.'+payload);}
 async function counts(){return(await pool.query('SELECT (SELECT count(*) FROM provider_request)::int AS ledger,(SELECT count(*) FROM event)::int AS events')).rows[0];}
 async function hidden(s:Source,id:string,expected:string){const data=await readMetaImport(s.project,viewer,id);assert.equal(data.import.status,expected);assert.equal(data.import.dataStatus,'unavailable');assert.equal(data.import.readableRows,null);assert.deepEqual(data.rows,[]);}
 try{
  for(const id of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Meta worker fixture\',$2)',[id,id+'@integration.test']);
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode)
   VALUES($1,'12345','12346',1,1,$2,true,true,$3,'development')`,[app,encryptCredentials(secrets,metaAppContext({id:app,credential_revision:1})),config.appUrl]);
  const untouched=await counts();

  const happy=await source(),happyId=await queued(happy),payload=(await pool.query('SELECT data FROM pgboss.job WHERE name=$1 AND data->>\'importId\'=$2',[metaQueue,happyId])).rows;
  assert.deepEqual(payload,[{data:{importId:happyId}}]);await step(happy,happyId);assert.equal((await stored(happyId)).provider_report_id,'90001');
  const before=calls.length;await step(happy,happyId);assert.equal(calls.length,before,'Not-due polls make no requests.');
  for(const state of ['Job Not Started','Job Started','Job Running']){await due(happyId);await step(happy,happyId,c=>c.op==='status'?Response.json(status(happy,state,100)):undefined);assert.equal((await stored(happyId)).status,'waiting');}
  await due(happyId);await step(happy,happyId);assert.equal((await stored(happyId)).status,'reading');
  await due(happyId);await step(happy,happyId,c=>c.op==='page'?Response.json({data:[row(happy)],paging:{next:'https://untrusted.invalid/secret?token=not-followed',cursors:{after:'page-two'}}}):undefined);
  await due(happyId);await step(happy,happyId,c=>c.op==='page'?(assert.equal(c.url.searchParams.get('after'),'page-two'),Response.json({data:[row(happy,'2')]})):undefined);
  const success=await readMetaImport(happy.project,viewer,happyId);assert.equal(success.import.status,'completed');assert.equal(success.import.coverage,'complete');assert.equal(success.rows.length,2);assert.equal(success.rows[0].spend,'0.000000');assert.equal(success.rows[0].clicks,null);assert.equal((await stored(happyId)).provider_report_id,null);
  console.log('PASS actual enqueue, identifier-only job, due pacing, completed-and-100 gate and ordered normalized pages');

  for(const failure of ['lost_ack','deadline']as const){const s=await source(),id=await queued(s),startPosts=posts,block=latch();
   const pending=step(s,id,async c=>{if(c.op==='submit'){await block.hold();if(failure==='lost_ack')throw new Error('Synthetic lost acknowledgement.');return Response.json({report_run_id:'90001'});}});
   await reached(block.entered);if(failure==='deadline')await pool.query("UPDATE meta_import SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);block.release();await pending;
   await hidden(s,id,'submission_unknown');await step(s,id);assert.equal(posts,startPosts+1);
  }
  const crash=await source(),crashId=await queued(crash),crashPosts=posts;await pool.query("UPDATE meta_import SET status='submitting',submitted_at=clock_timestamp(),generation=1,lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[crashId,randomUUID()]);await step(crash,crashId);assert.equal((await stored(crashId)).status,'submission_unknown');assert.equal(posts,crashPosts);
  console.log('PASS lost POST acknowledgement, late POST deadline and crash marker never resubmit or imply known failure');

  const parallel=await source(),parallelId=await queued(parallel),barrier=latch(),parallelPosts=posts;
  const first=step(parallel,parallelId,async c=>{if(c.op==='submit')await barrier.hold();});await reached(barrier.entered);await step(parallel,parallelId);assert.equal(posts,parallelPosts+1);barrier.release();await first;assert.equal((await stored(parallelId)).status,'waiting');await cancel(parallel,parallelId);
  const takeover=await source(),takeoverId=await queued(takeover),held=latch(),replacement=randomUUID();const stale=step(takeover,takeoverId,async c=>{if(c.op==='submit')await held.hold();});await reached(held.entered);
  await pool.query("UPDATE meta_import SET generation=generation+1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '3 minutes' WHERE id=$1",[takeoverId,replacement]);held.release();await stale;const after=await stored(takeoverId);assert.equal(after.status,'submitting');assert.equal(after.provider_report_id,null);assert.equal(after.lease_token,replacement);await cancel(takeover,takeoverId);
  console.log('PASS simultaneous steps dispatch once; late response cannot publish through a replaced lease');

  for(const malformed of ['duplicate','cursor_loop','currency','date','campaign','completed_99','wrong_status_id','wrong_status_account']){
   const s=await source(),id=await queued(s);await step(s,id);await due(id);
   if(malformed.startsWith('wrong_status')||malformed==='completed_99'){await step(s,id,c=>c.op==='status'?Response.json({...status(s),...(malformed==='completed_99'?{async_percent_completion:99}:malformed==='wrong_status_id'?{id:'90002'}:{account_id:'99999'})}):undefined);}
   else {await step(s,id);await due(id);await step(s,id,c=>c.op==='page'?Response.json({data:[row(s)],paging:{next:'https://ignored.invalid',cursors:{after:'same-cursor'}}}):undefined);await due(id);
    await step(s,id,c=>c.op==='page'?Response.json({data:[{...row(s,malformed==='duplicate'?'1':'2'),...(malformed==='currency'?{account_currency:'USD'}:malformed==='date'?{date_start:'2000-01-01',date_stop:'2000-01-01'}:malformed==='campaign'?{campaign_id:null}:{})}],...(malformed==='cursor_loop'?{paging:{next:'https://ignored.invalid',cursors:{after:'same-cursor'}}}:{})}):undefined);
   }await hidden(s,id,'failed');assert.equal((await stored(id)).diagnostic_code,'invalid_provider_report');
  }
  for(const state of ['Job Failed','Job Skipped']){const s=await source(),id=await queued(s);await step(s,id);await due(id);await step(s,id,c=>c.op==='status'?Response.json(status(s,state,0)):undefined);await hidden(s,id,'failed');}
  console.log('PASS malformed completion, foreign IDs/currency/dates, duplicate pages and cursor loops suppress all report payload');

  for(const operation of ['status','page']as const){const s=await source(),id=await queued(s);if(operation==='page')await reading(s,id);else{await step(s,id);await due(id);}const chargedPosts=posts;
   for(let i=0;i<4;i++){await due(id);const start=Date.now();await step(s,id,c=>c.op===operation?Response.json({error:{code:2}},{status:503}):undefined);const result=await stored(id);
    if(i<3){assert.equal(result.retry_attempts,i+1);assert.ok(result.next_attempt_at.getTime()-start>=(15*2**i-1)*1000);assert.equal(result.status,operation==='page'?'reading':'waiting');}else assert.equal(result.status,'failed');
   }assert.equal(posts,chargedPosts);
  }
  const throttle=await source(),throttleId=await queued(throttle);await step(throttle,throttleId);await due(throttleId);const throttleStart=Date.now();await step(throttle,throttleId,c=>c.op==='status'?Response.json({error:{code:4}},{status:429,headers:{'retry-after':'70','x-fb-ads-insights-throttle':JSON.stringify({app_id_util_pct:99,acc_id_util_pct:0})}}):undefined);assert.equal((await stored(throttleId)).diagnostic_code,'app_throttled');assert.ok((await stored(throttleId)).next_attempt_at.getTime()-throttleStart>=69000);await cancel(throttle,throttleId);
  console.log('PASS GET failures have three bounded retries with exponential pacing; throttle hints persist and POST is not retried');

  const bounded=await source(),boundedId=await queued(bounded);await reading(bounded,boundedId);
  for(let page=0;page<50;page++){await due(boundedId);await step(bounded,boundedId,c=>c.op==='page'?Response.json({data:[row(bounded,String(page+1))],paging:{next:'https://ignored.invalid',cursors:{after:'cursor-'+page}}}):undefined);}
  const partial=await readMetaImport(bounded.project,viewer,boundedId);assert.equal(partial.import.status,'partial');assert.equal(partial.import.coverage,'partial');assert.equal(partial.import.recordedRows,50);assert.equal(partial.rows.length,50);assert.equal(partial.import.diagnosticCode,'page_limit');
  const deadline=await source(),deadlineId=await queued(deadline);await reading(deadline,deadlineId);await step(deadline,deadlineId,c=>c.op==='page'?Response.json({data:[row(deadline)],paging:{next:'https://ignored.invalid',cursors:{after:'next'}}}):undefined);await pool.query("UPDATE meta_import SET deadline_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",[deadlineId]);const beforeDeadline=calls.length;await step(deadline,deadlineId);assert.equal(calls.length,beforeDeadline);const ended=await readMetaImport(deadline.project,viewer,deadlineId);assert.equal(ended.import.status,'partial');assert.equal(ended.rows.length,1);assert.equal(ended.import.diagnosticCode,'deadline_reached');
  console.log('PASS 50-page capacity and account-local deadline preserve explicitly partial valid observations');

  for(const change of ['cancel','disconnect','role','app','grant','deletion','expiry']){
   const s=await source(),id=await queued(s);await reading(s,id);const block=latch();const pending=step(s,id,async c=>{if(c.op==='page')await block.hold();});await reached(block.entered);
   if(change==='cancel')await cancel(s,id);
   else if(change==='disconnect')await disconnectMeta(s.project,owner,s.id,{requestId:randomUUID(),revision:1,revokeAtMeta:false});
   else if(change==='role')await withMetaImport(id,async client=>{await client.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[s.workspace,owner]);});
   else if(change==='app')await pool.query('UPDATE meta_app_registration SET revision=revision+1 WHERE id=$1',[app]);
   else if(change==='grant'){const fresh=await newGrant(s);await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[s.id,fresh]);}
   else if(change==='deletion')await signedDelete(s);
   else await pool.query("UPDATE meta_oauth_flow SET access_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.grant]);
   block.release();await pending;const result=await stored(id);assert.equal(result.status,change==='cancel'?'cancelled':'denied');assert.equal(result.row_count,0);assert.equal((await pool.query('SELECT 1 FROM meta_import_page WHERE import_id=$1',[id])).rowCount,0);
   if(change==='role')await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[s.workspace,owner]);
  }
  console.log('PASS held page publication rechecks cancellation, disconnect, live owner, app revision, grant, deletion and expiry');

  const unknown=await source(false),unknownId=await queued(unknown),inspectGate=latch(),unknownPosts=posts;
  const interrupted=step(unknown,unknownId,async c=>{if(c.op==='inspect')await inspectGate.hold();});await reached(inspectGate.entered);await cancel(unknown,unknownId);inspectGate.release();await interrupted;assert.equal(posts,unknownPosts);assert.equal(calls.filter(c=>c.op==='permissions'&&new Headers(c.init.headers).get('authorization')==='Bearer '+unknown.token).length,0);
  const brief=await source(false),briefId=await queued(brief),short=latch(),now=Date.now,shortPosts=posts;
  const expireDuringAccount=step(brief,briefId,async c=>{if(c.op==='inspect')return Response.json({data:{app_id:'12345',user_id:brief.subject,type:'USER',is_valid:true,scopes:['ads_read'],expires_at:Math.floor(now()/1000)+10,data_access_expires_at:0}});if(c.op==='account')await short.hold();});
  try{await reached(short.entered);const advanced=now()+20000;Date.now=()=>advanced;short.release();await expireDuringAccount;}finally{Date.now=now;}assert.equal(posts,shortPosts);assert.equal((await stored(briefId)).status,'denied');
  const tz=await source(),tzId=await queued(tz),tzPosts=posts;await step(tz,tzId,c=>c.op==='account'?Response.json({...account(tz),timezone_name:'Asia/Dubai'}):undefined);await hidden(tz,tzId,'failed');assert.equal(posts,tzPosts);assert.equal((await stored(tzId)).source.timeZone,'UTC');
  console.log('PASS unknown data-access expiry is freshly gated between requests; short inspection and changed remote timezone cannot dispatch');

  const retained=await source(),retainedId=await queued(retained);await reading(retained,retainedId);await step(retained,retainedId);const original=(await readMetaImport(retained.project,viewer,retainedId)).import.source;
  const renewed=await newGrant(retained);await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[retained.id,renewed]);assert.deepEqual((await readMetaImport(retained.project,viewer,retainedId)).import.source,original);
  await pool.query("UPDATE meta_import SET completed_at=clock_timestamp()-interval '366 days' WHERE id=$1",[retainedId]);await expireMetaImportPages();assert.equal((await readMetaImport(retained.project,viewer,retainedId)).import.dataStatus,'expired');await pool.query('UPDATE workspace SET derived_history_days=1000 WHERE id=$1',[retained.workspace]);await step(retained,retainedId);assert.equal((await readMetaImport(retained.project,viewer,retainedId)).import.dataStatus,'expired');assert.equal((await pool.query('SELECT 1 FROM meta_import_page WHERE import_id=$1',[retainedId])).rowCount,0);
  console.log('PASS reconnect preserves captured source history; retention expiry never resurrects after policy extension');

  const recovery=await source(),recoveryId=await queued(recovery);const boss=await getBoss();const queuedJobs=await pool.query<{id:string}>("SELECT id FROM pgboss.job WHERE name=$1 AND state IN('created','retry','active')",[metaQueue]);for(const job of queuedJobs.rows)await boss.cancel(metaQueue,job.id);
  // Close only this suite's remaining active receipts before exercising one missing-queue recovery.
  await pool.query("UPDATE meta_import SET status='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id<>$1 AND status IN('queued','submitting','waiting','reading')",[recoveryId]);
  const beforeRecovery=calls.length;assert.deepEqual(await reconcileMetaImports(),{queued:true});assert.equal(calls.length,beforeRecovery);const job=(await pool.query("SELECT data FROM pgboss.job WHERE name=$1 AND state='created'",[metaQueue])).rows;assert.deepEqual(job,[{data:{importId:recoveryId}}]);assert.deepEqual(await reconcileMetaImports(),{queued:false});await cancel(recovery,recoveryId);
  assert.deepEqual(await counts(),untouched);assert.equal(outbound,0);
  console.log('PASS recovery enqueues identifiers only; synthetic report work never changes paid ledger or native events');

  assert.equal((await pool.query("SELECT 1 FROM meta_import WHERE status IN('queued','submitting','waiting','reading')")).rowCount,0);
  const runtime=await source(),runtimeId=await queued(runtime),runtimePosts=posts,runtimeDeadline=Date.now()+55000;
  await withMetaTransportForTests(transport(runtime),async()=>{
   try{
    await startWorker();
    await eventually('real worker to save the report ID',runtimeDeadline,async()=>{const row=await stored(runtimeId);return row.status==='waiting'&&row.provider_report_id==='90001'&&row.lease_token===null;});
    assert.equal(posts,runtimePosts+1);
    await eventually('real worker to enter reading',runtimeDeadline,async()=>(await stored(runtimeId)).status==='reading');
    await eventually('real worker to complete and acknowledge all jobs',runtimeDeadline,async()=>
     (await stored(runtimeId)).status==='completed'&&!(await pool.query("SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'importId'=$2 AND state IN('created','retry','active')",[metaQueue,runtimeId])).rowCount);
    const report=await readMetaImport(runtime.project,viewer,runtimeId);assert.equal(report.import.coverage,'complete');assert.equal(report.rows.length,1);assert.equal(report.rows[0].spend,'0.000000');
    assert.equal(posts,runtimePosts+1);assert.equal((await pool.query("SELECT count(*)::int n FROM pgboss.job WHERE name=$1 AND data->>'importId'=$2 AND state='completed'",[metaQueue,runtimeId])).rows[0].n,3);
   }finally{await stopJobs();}
  });
  assert.equal((await pool.query("SELECT 1 FROM worker_heartbeat WHERE id='foundation-worker'")).rowCount,0);
  console.log('PASS actual pg-boss worker drains queued, waiting, reading and completed states with one POST and graceful stop');

  const resumed=await source(),resumedId=await queued(resumed),resumedPosts=posts,resumedDeadline=Date.now()+45000,seenAfter:(string|null)[]=[];
  await withMetaTransportForTests(transport(resumed,c=>{
   if(c.op!=='page')return;
   const after=c.url.searchParams.get('after');seenAfter.push(after);
   if(after===null)return Response.json({data:[row(resumed)],paging:{next:'https://never-followed.invalid',cursors:{after:'resume-page-two'}}},{headers:{'retry-after':'60'}});
   assert.equal(after,'resume-page-two');return Response.json({data:[row(resumed,'2')]});
  }),async()=>{
   try{
    await startWorker();
    await eventually('report ID before first stop',resumedDeadline,async()=>{const row=await stored(resumedId);return row.status==='waiting'&&row.provider_report_id==='90001'&&row.lease_token===null;});
    await stopJobs();assert.equal(posts,resumedPosts+1);assert.deepEqual(seenAfter,[]);
    // Only make this owned fixture due; production retry/poll durations remain unchanged.
    await due(resumedId);await startWorker();
    await eventually('saved first-page cursor before second stop',resumedDeadline,async()=>{const row=await stored(resumedId);return row.status==='reading'&&row.next_cursor==='resume-page-two'&&row.pages===1&&row.lease_token===null;});
    await stopJobs();const saved=await stored(resumedId);
    assert.equal(saved.provider_report_id,'90001');assert.equal(saved.next_cursor,'resume-page-two');assert.equal(saved.row_count,1);assert.equal(posts,resumedPosts+1);assert.deepEqual(seenAfter,[null]);
    assert.equal((await pool.query("SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'importId'=$2 AND state IN('created','retry','active')",[metaQueue,resumedId])).rowCount,0,'Restart must recover from the durable receipt, not an already queued page.');
    await due(resumedId);await startWorker();
    await eventually('restarted worker to finish saved cursor',resumedDeadline,async()=>
     (await stored(resumedId)).status==='completed'&&!(await pool.query("SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'importId'=$2 AND state IN('created','retry','active')",[metaQueue,resumedId])).rowCount);
    const report=await readMetaImport(resumed.project,viewer,resumedId);assert.equal(report.import.coverage,'complete');assert.deepEqual(report.rows.map(r=>r.campaignId),['1','2']);
    assert.deepEqual(seenAfter,[null,'resume-page-two']);assert.equal(posts,resumedPosts+1);
   }finally{await stopJobs();}
  });
  assert.equal((await pool.query("SELECT 1 FROM worker_heartbeat WHERE id='foundation-worker'")).rowCount,0);
  assert.deepEqual(await counts(),untouched);assert.equal(outbound,0);
  console.log('PASS in-process worker stop/start recovers saved report ID and cursor without a second POST, native events or paid ledger writes');
 }finally{await stopJobs();globalThis.fetch=oldFetch;}
}
if(process.env.TEN98_META_AUTH_TEST==='1')runMetaImportWorkerChecks().then(()=>closeDatabase()).catch(async error=>{console.error(error instanceof Error?error.message:'Meta import worker acceptance failed.');await closeDatabase();process.exitCode=1;});
