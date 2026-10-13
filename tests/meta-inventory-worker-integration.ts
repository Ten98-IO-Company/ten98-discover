import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {enqueueMetaInventory,cancelMetaInventory,readMetaInventory,metaInventoryQueue} from '../src/server/meta-inventory.ts';
import {runMetaInventoryStep,reconcileMetaInventories} from '../src/server/meta-inventory-worker.ts';
import {enqueueMetaImport,cancelMetaImport} from '../src/server/meta-imports.ts';
import {runMetaImportStep} from '../src/server/meta-import-worker.ts';
import {withMetaTransportForTests,type MetaTransport} from '../src/server/meta-http.ts';

function latch(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),waiting=new Promise<void>(r=>release=r);return {entered,release,hold:async()=>{enter();await waiting;}};}
async function reached(p:Promise<void>){await Promise.race([p,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Fixture gate not reached.')),5000).unref())]);}
async function eventually(label:string,check:()=>Promise<boolean>){const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await wait(100);}assert.fail(label);}
export async function runMetaInventoryWorkerChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_inventory_worker_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0);
 const previous=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('Uncontained network forbidden.');};
 const owner=randomUUID(),viewer=randomUUID(),app=randomUUID(),secrets:MetaSecrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};let counter=30000;
 type Source={id:string;workspace:string;project:string;grant:string;accountId:string;subject:string;token:string};
 type Call={op:'account'|'inspect'|'permissions'|'campaigns'|'submit';url:URL};type Handler=(c:Call)=>Promise<Response|undefined>|Response|undefined;
 const calls:Call[]=[];
 async function source(accountId=String(++counter)):Promise<Source>{const s={id:randomUUID(),workspace:randomUUID(),project:randomUUID(),grant:randomUUID(),accountId,subject:String(++counter),token:'synthetic-'+randomUUID()};
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Inventory worker')",[s.workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[s.workspace,owner,viewer]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Inventory worker','https://fixture.example',$3,'infinity')",[s.project,s.workspace,randomUUID()]);
  await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,status,encrypted_token,account_id,account_name,currency,time_zone,account_status,validated_at) VALUES($1,$2,$3,'Fixture','ready',$4,$5,'Account','AED','UTC',1,clock_timestamp())`,[s.id,s.workspace,s.project,encryptCredentials({accessToken:s.token},metaConnectionContext({id:s.id,workspace_id:s.workspace,revision:1})),s.accountId]);
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at)
   VALUES($1,$2,1,1,$3,$4,$5,$6,'completed',$7,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp())`,[s.grant,app,s.workspace,s.project,owner,s.id,metaSubjectHash(secrets,s.subject)]);await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[s.id,s.grant]);return s;
 }
 const row=(s:Source,id='1')=>({id,account_id:s.accountId,name:'Campaign '+id,status:'PAUSED',effective_status:'FUTURE_STATUS'});
 function transport(s:Source,handler:Handler=()=>undefined):MetaTransport{return async(address,init)=>{const url=new URL(address);assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  const op:Call['op']=url.pathname.endsWith('/campaigns')?'campaigns':url.pathname.endsWith('/debug_token')?'inspect':url.pathname.endsWith('/permissions')?'permissions':init.method==='POST'?'submit':'account';
  const call={op,url};calls.push(call);if(op!=='inspect')assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+s.token);const special=await handler(call);if(special)return special;
  assert.notEqual(op,'submit','Campaign inventory must never submit an Insights report.');assert.equal(init.method,'GET');
  if(op==='inspect')return Response.json({data:{app_id:'12345',user_id:s.subject,type:'USER',is_valid:true,scopes:['ads_read'],expires_at:Math.floor(Date.now()/1000)+86400,data_access_expires_at:0}});
  if(op==='permissions')return Response.json({data:[{permission:'ads_read',status:'granted'}]});
  if(op==='account')return Response.json({id:'act_'+s.accountId,account_id:s.accountId,name:'Account',currency:'AED',timezone_name:'UTC',account_status:1});
  assert.equal(url.pathname,'/v26.0/act_'+s.accountId+'/campaigns');assert.equal(url.searchParams.get('limit'),'100');assert.deepEqual(JSON.parse(url.searchParams.get('effective_status')!),['ACTIVE','PAUSED','ARCHIVED','DELETED','IN_PROCESS','WITH_ISSUES']);return Response.json({data:[row(s)]});
 };}
 const enqueue=async(s:Source)=>(await enqueueMetaInventory(s.project,owner,s.id,{requestId:randomUUID(),revision:1})).inventory.id;
 const stored=async(id:string)=>(await pool.query('SELECT * FROM meta_campaign_inventory WHERE id=$1',[id])).rows[0];
 const due=(id:string)=>pool.query("UPDATE meta_campaign_inventory SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 const step=(s:Source,id:string,h?:Handler)=>withMetaTransportForTests(transport(s,h),()=>runMetaInventoryStep(id));
 const cancel=(s:Source,id:string)=>cancelMetaInventory(s.project,owner,id,{requestId:randomUUID()});
 const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM provider_request)::int AS ledger,(SELECT count(*) FROM event)::int AS events')).rows[0];
 try{
  for(const id of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Inventory worker\',$2)',[id,id+'@integration.test']);
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode) VALUES($1,'12345','12346',1,1,$2,true,true,$3,'development')`,[app,encryptCredentials(secrets,metaAppContext({id:app,credential_revision:1})),config.appUrl]);const untouched=await counts();
  const a=await source(),id=await enqueue(a);await step(a,id,c=>c.op==='campaigns'?Response.json({data:[],paging:{next:'https://untrusted.invalid/',cursors:{after:'second'}}}):undefined);assert.equal((await stored(id)).status,'reading');assert.equal((await stored(id)).pages,1);
  await due(id);await step(a,id,c=>c.op==='campaigns'?(assert.equal(c.url.searchParams.get('after'),'second'),Response.json({data:[row(a)],paging:{cursors:{after:'terminal-cursor'}}})):undefined);
  const complete=await readMetaInventory(a.project,viewer,id);assert.equal(complete.inventory?.coverage,'complete');assert.equal(complete.rows.length,1);assert.equal((await stored(id)).next_cursor,null);assert.ok(complete.inventory?.firstFetchedAt);assert.ok(complete.inventory?.lastFetchedAt);
  console.log('PASS fixed GET pages, empty continuation, ignored next URL and final after cursor without next');

  for(const kind of ['duplicate','repeated','foreign','malformed']as const){const s=await source(),run=await enqueue(s);await step(s,run,c=>c.op==='campaigns'?Response.json({data:[row(s)],paging:{next:'unused',cursors:{after:'next'}}}):undefined);await due(run);
   await step(s,run,c=>c.op==='campaigns'?Response.json({data:kind==='foreign'?[{...row(s,'2'),account_id:'999'}]:kind==='malformed'?[{...row(s,'2'),name:7}]:[row(s,kind==='duplicate'?'1':'2')],...(kind==='repeated'?{paging:{next:'unused',cursors:{after:'next'}}}:{})}):undefined);
   const result=await readMetaInventory(s.project,viewer,run);assert.equal(result.inventory?.status,'failed');assert.equal(result.inventory?.readableRows,null);assert.deepEqual(result.rows,[]);assert.equal((await stored(run)).pages,1);
  }console.log('PASS duplicate IDs, repeated cursors, foreign account and malformed later page hide the entire attempt');

  const retries=await source(),retryId=await enqueue(retries);for(let i=0;i<4;i++){await due(retryId);const before=Date.now();await step(retries,retryId,c=>c.op==='campaigns'?Response.json({error:{code:999}},{status:503}):undefined);const r=await stored(retryId);assert.equal(r.retry_attempts,Math.min(i+1,3));if(i<3){assert.ok(r.next_attempt_at.getTime()>=before+(15*2**i)*1000-1000);assert.equal(r.status,'reading');}else assert.equal(r.status,'failed');}
  const capped=await source(),capId=await enqueue(capped);for(let i=0;i<50;i++){await due(capId);await step(capped,capId,c=>c.op==='campaigns'?Response.json({data:[],paging:{next:'unused',cursors:{after:'page-'+i}}}):undefined);}assert.equal((await stored(capId)).status,'partial');assert.equal((await readMetaInventory(capped.project,viewer,capId)).inventory?.readableRows,0);
  const expired=await source(),expiredId=await enqueue(expired);await step(expired,expiredId,c=>c.op==='campaigns'?Response.json({data:[],paging:{next:'unused',cursors:{after:'p2'}}}):undefined);await pool.query("UPDATE meta_campaign_inventory SET deadline_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiredId]);const before=calls.length;await step(expired,expiredId);assert.equal(calls.length,before);assert.equal((await stored(expiredId)).status,'partial');
  console.log('PASS bounded GET backoff, page capacity and deadline preserve truthful partial zero-record coverage');

  for(const loss of ['cancel','demote','reconnect','deadline']as const){const s=await source(),run=await enqueue(s),block=latch();const pending=step(s,run,async c=>{if(c.op==='campaigns'){await block.hold();return Response.json({data:[row(s)]});}});const settled=pending.then(()=>null,e=>e);await reached(block.entered);
   if(loss==='cancel')await cancel(s,run);else if(loss==='demote')await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[s.workspace,owner]);else if(loss==='reconnect')await pool.query('UPDATE meta_connection SET revision=revision+1 WHERE id=$1',[s.id]);else await pool.query("UPDATE meta_campaign_inventory SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[run]);block.release();assert.equal(await settled,null);assert.equal((await stored(run)).pages,0);assert.equal((await stored(run)).status,loss==='cancel'?'cancelled':loss==='deadline'?'failed':'denied');
  }
  const statusSource=await source(),statusId=await enqueue(statusSource);const prior=calls.length;await step(statusSource,statusId,c=>c.op==='account'?Response.json({id:'act_'+statusSource.accountId,account_id:statusSource.accountId,name:'Account',currency:'AED',timezone_name:'UTC',account_status:2}):undefined);assert.equal((await stored(statusId)).status,'failed');assert.equal(calls.slice(prior).filter(c=>c.op==='campaigns').length,0);
  console.log('PASS held response cancellation/role/revision/deadline fences and changed account status before page GET');

  const unknown=await source(),unknownId=await enqueue(unknown),inspection=latch();await pool.query('UPDATE meta_oauth_flow SET data_access_expires_at=NULL WHERE id=$1',[unknown.grant]);const beforeUnknown=calls.length;
  const inspecting=step(unknown,unknownId,async c=>{if(c.op==='inspect')await inspection.hold();});const inspected=inspecting.then(()=>null,e=>e);await reached(inspection.entered);await cancel(unknown,unknownId);inspection.release();assert.equal(await inspected,null);assert.deepEqual(calls.slice(beforeUnknown).map(c=>c.op),['inspect']);assert.equal((await stored(unknownId)).pages,0);
  const dailyChanged=await source(),dailyDay=new Date(Date.now()-86400000).toISOString().slice(0,10),changedImport=(await enqueueMetaImport(dailyChanged.project,owner,dailyChanged.id,{requestId:randomUUID(),revision:1,report:'account_daily',from:dailyDay,to:dailyDay})).import.id;
  const beforeChanged=calls.length;await withMetaTransportForTests(transport(dailyChanged,c=>c.op==='account'?Response.json({id:'act_'+dailyChanged.accountId,account_id:dailyChanged.accountId,name:'Account',currency:'AED',timezone_name:'UTC',account_status:2}):undefined),()=>runMetaImportStep(changedImport));
  assert.deepEqual(calls.slice(beforeChanged).map(c=>c.op),['account']);assert.equal((await pool.query('SELECT status FROM meta_import WHERE id=$1',[changedImport])).rows[0].status,'failed');
  console.log('PASS unknown data-expiry inspection rechecks cancellation before permissions, and daily sibling rejects changed account status before POST');

  const stale=await source(),staleId=await enqueue(stale),block=latch();const old=step(stale,staleId,async c=>{if(c.op==='campaigns'){await block.hold();return Response.json({data:[row(stale,'999')]});}});const done=old.then(()=>null,e=>e);await reached(block.entered);await pool.query("UPDATE meta_campaign_inventory SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[staleId]);await step(stale,staleId);block.release();assert.equal(await done,null);assert.deepEqual((await readMetaInventory(stale.project,viewer,staleId)).rows.map(r=>r.id),['1']);
  console.log('PASS replacement generation admits one page and rejects the stale lease response');

  const day=new Date(Date.now()-86400000).toISOString().slice(0,10),dailySource=await source(),daily=(await enqueueMetaImport(dailySource.project,owner,dailySource.id,{requestId:randomUUID(),revision:1,report:'account_daily',from:day,to:day})).import.id;
  await pool.query("UPDATE meta_import SET account_cooldown_until=clock_timestamp()+interval '1 minute',diagnostic_code='account_throttled',next_attempt_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[daily]);
  const same=await source(dailySource.accountId),sameId=await enqueue(same),other=await source(),otherId=await enqueue(other);const seen=calls.length;await step(same,sameId);assert.equal(calls.length,seen);await step(other,otherId);assert.equal((await stored(otherId)).status,'completed');
  await pool.query("UPDATE meta_import SET app_cooldown_until=clock_timestamp()+interval '1 minute',diagnostic_code='app_throttled' WHERE id=$1",[daily]);const appScope=await source(),appRun=await enqueue(appScope),seen2=calls.length;await step(appScope,appRun);assert.equal(calls.length,seen2);await cancelMetaImport(dailySource.project,owner,daily,{requestId:randomUUID()});
  assert.ok((await pool.query('SELECT app_cooldown_until FROM meta_import WHERE id=$1',[daily])).rows[0].app_cooldown_until,'Cancellation preserves already observed cooldown.');
  await pool.query("UPDATE meta_import SET app_cooldown_until=clock_timestamp()-interval '1 second',account_cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1",[daily]);
  await pool.query("UPDATE meta_campaign_inventory SET account_cooldown_until=clock_timestamp()+interval '1 minute',diagnostic_code='account_throttled',next_attempt_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[sameId]);
  const reverse=await source(same.accountId),reverseId=(await enqueueMetaImport(reverse.project,owner,reverse.id,{requestId:randomUUID(),revision:1,report:'account_daily',from:day,to:day})).import.id;const seen3=calls.length;await withMetaTransportForTests(transport(reverse),()=>runMetaImportStep(reverseId));assert.equal(calls.length,seen3);await cancelMetaImport(reverse.project,owner,reverseId,{requestId:randomUUID()});await cancel(same,sameId);await cancel(appScope,appRun);
  console.log('PASS cross-queue account identity across connections, account isolation, app scope and reverse Insights admission');

  // Cancel only this fixture's already invoked queue receipts before starting real handlers.
  const boss=await getBoss();const queued=(await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND state IN ('created','retry','active')",[metaInventoryQueue])).rows;for(const job of queued)await boss.cancel(metaInventoryQueue,job.id);
  const live=await source(),liveId=await enqueue(live);await withMetaTransportForTests(transport(live),async()=>{try{await startWorker();await eventually('actual inventory worker drain',async()=>(await stored(liveId)).status==='completed');}finally{await stopJobs();}});
  const restart=await source(),restartId=await enqueue(restart);await step(restart,restartId,c=>c.op==='campaigns'?Response.json({data:[row(restart)],paging:{next:'unused',cursors:{after:'saved-cursor'}}}):undefined);await due(restartId);await stopJobs();
  const restartBoss=await getBoss();for(const job of(await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'inventoryId'=$2 AND state IN ('created','retry','active')",[metaInventoryQueue,restartId])).rows)await restartBoss.cancel(metaInventoryQueue,job.id);await stopJobs();
  const restartCalls=calls.length;await withMetaTransportForTests(transport(restart,c=>c.op==='campaigns'?(assert.equal(c.url.searchParams.get('after'),'saved-cursor'),Response.json({data:[row(restart,'2')]})):undefined),async()=>{try{await startWorker();await eventually('saved inventory cursor resume',async()=>(await stored(restartId)).status==='completed');}finally{await stopJobs();}});
  assert.equal(calls.slice(restartCalls).filter(c=>c.op==='campaigns').length,1);assert.deepEqual((await readMetaInventory(restart.project,viewer,restartId)).rows.map(r=>r.id),['1','2']);assert.deepEqual(await counts(),untouched);assert.equal(outbound,0);assert.equal((await pool.query("SELECT 1 FROM worker_heartbeat WHERE id='foundation-worker'")).rowCount,0);
  console.log('PASS actual pg-boss worker drain and in-process stop/start cursor recovery without refresh creation, paid or native writes');
 }finally{await stopJobs();globalThis.fetch=previous;}
}
if(process.env.TEN98_META_AUTH_TEST==='1')runMetaInventoryWorkerChecks().then(()=>closeDatabase()).catch(async error=>{console.error(error instanceof Error?error.message:'Inventory worker acceptance failed.');await closeDatabase();process.exitCode=1;});
