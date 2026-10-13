import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {enqueueMetaInventory,readMetaInventory} from '../src/server/meta-inventory.ts';
import {runMetaInventoryStep} from '../src/server/meta-inventory-worker.ts';
import {enqueueMetaImport,cancelMetaImport,readMetaImport} from '../src/server/meta-imports.ts';
import {runMetaImportStep} from '../src/server/meta-import-worker.ts';
import {withMetaTransportForTests,type MetaTransport} from '../src/server/meta-http.ts';

// Fresh opt-in fixture only: contained transport, no worker/server or provider I/O.
export async function runMetaInventoryBoundaryChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_inventory_boundary_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0);
 const previous=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('Uncontained network forbidden.');};
 const owner=randomUUID(),viewer=randomUUID(),app=randomUUID(),secrets:MetaSecrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};let counter=30000;
 type Source={id:string;workspace:string;project:string;grant:string;accountId:string;subject:string;token:string};
 type Call={op:'account'|'inspect'|'permissions'|'campaigns'|'submit'|'page';url:URL};type Handler=(c:Call)=>Promise<Response|undefined>|Response|undefined;
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
  const op:Call['op']=url.pathname.endsWith('/campaigns')?'campaigns':url.pathname.endsWith('/insights')&&init.method==='GET'?'page':url.pathname.endsWith('/debug_token')?'inspect':url.pathname.endsWith('/permissions')?'permissions':init.method==='POST'?'submit':'account';
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
 const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM provider_request)::int AS ledger,(SELECT count(*) FROM event)::int AS events')).rows[0];
 try{
  for(const id of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Inventory worker\',$2)',[id,id+'@integration.test']);
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode) VALUES($1,'12345','12346',1,1,$2,true,true,$3,'development')`,[app,encryptCredentials(secrets,metaAppContext({id:app,credential_revision:1})),config.appUrl]);const untouched=await counts();

  const clearCooldowns=async()=>{for(const table of ['meta_import','meta_campaign_inventory'])await pool.query('UPDATE '+table+' SET app_cooldown_until=NULL,account_cooldown_until=NULL');};
  const importRow=async(id:string)=>(await pool.query('SELECT * FROM meta_import WHERE id=$1',[id])).rows[0];
  const dueImport=(id:string)=>pool.query("UPDATE meta_import SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  const day=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const daily=async(s:Source,from=day,to=day)=>(await enqueueMetaImport(s.project,owner,s.id,{requestId:randomUUID(),revision:1,report:'account_daily',from,to})).import.id;
  const highRate=()=>({'x-fb-ads-insights-throttle':JSON.stringify({app_id_util_pct:95}),'retry-after':'120'});
  const throttle=async(s:Source,id:string)=>step(s,id,c=>c.op==='campaigns'?Response.json({data:[row(s)]},{headers:highRate()}):undefined);
  const dailyStep=(s:Source,id:string,h:Handler=()=>undefined)=>withMetaTransportForTests(transport(s,async c=>await h(c)??(c.op==='submit'?Response.json({report_run_id:'888'}):undefined)),()=>runMetaImportStep(id));

  for(const kind of ['foreign','duplicate','cursor','reauthorize']as const){
   const s=await source(),id=await enqueue(s);await step(s,id,c=>c.op==='campaigns'?Response.json({data:[row(s)],paging:{next:'unused',cursors:{after:'next'}}}):undefined);await due(id);
   await step(s,id,async c=>{if(c.op!=='campaigns')return;await pool.query("UPDATE meta_campaign_inventory SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    if(kind==='reauthorize')return Response.json({error:{code:190,error_subcode:463}},{status:400});
    return Response.json({data:[kind==='foreign'?{...row(s,'2'),account_id:'999'}:row(s,kind==='duplicate'?'1':'2')],...(kind==='cursor'?{paging:{next:'unused',cursors:{after:'next'}}}:{})});
   });
   const result=await readMetaInventory(s.project,viewer,id),connection=(await pool.query('SELECT status FROM meta_connection WHERE id=$1',[s.id])).rows[0];
   assert.equal(result.inventory?.status,kind==='reauthorize'?'denied':'failed',kind+' after deadline must not become partial');assert.equal(result.inventory?.coverage,'unavailable');assert.equal(result.inventory?.readableRows,null);assert.deepEqual(result.rows,[]);assert.equal((await stored(id)).pages,1);
   assert.equal(connection.status,kind==='reauthorize'?'reconnect':'ready');
  }
  console.log('PASS late foreign/duplicate/cursor evidence fails the whole inventory and late code190 requires reconnect before deadline fallback');

  for(const kind of ['foreign','duplicate','cursor','reauthorize']as const){
   const firstDay=kind==='cursor'?new Date(Date.now()-2*86400000).toISOString().slice(0,10):day;
   const s=await source(),id=await daily(s,firstDay,day),first=[{date:firstDay,accountId:s.accountId,campaignId:null,campaignName:null,impressions:'1',clicks:null,spend:null,actions:null,actionValues:null}];
   await pool.query("UPDATE meta_import SET status='reading',provider_report_id='888',submitted_at=clock_timestamp(),pages=1,row_count=1,next_cursor='next',cursor_hashes=$2 WHERE id=$1",[id,[createHash('sha256').update(JSON.stringify('next')).digest('hex')]]);
   await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,$4,1,$5)',[id,s.project,s.workspace,JSON.stringify(first),'a'.repeat(64)]);
   await dailyStep(s,id,async c=>{if(c.op!=='page')return;await pool.query("UPDATE meta_import SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);if(kind==='reauthorize')return Response.json({error:{code:190,error_subcode:463}},{status:400});
    return Response.json({data:[{account_id:kind==='foreign'?'999':s.accountId,account_name:'Account',account_currency:'AED',date_start:day,date_stop:day,impressions:'1'}],...(kind==='cursor'?{paging:{next:'unused',cursors:{after:'next'}}}:{})});
   });
   const result=await readMetaImport(s.project,viewer,id);assert.equal(result.import.status,kind==='reauthorize'?'denied':'failed');assert.equal(result.import.coverage,'unavailable');assert.equal(result.import.readableRows,null);assert.deepEqual(result.rows,[]);assert.equal((await importRow(id)).pages,1);assert.equal((await pool.query('SELECT status FROM meta_connection WHERE id=$1',[s.id])).rows[0].status,kind==='reauthorize'?'reconnect':'ready');
  }
  console.log('PASS the daily-report sibling also gives known invalid/access-loss evidence precedence over partial deadline outcomes');

  const final=await source(),finalId=await enqueue(final),before=Date.now();await throttle(final,finalId);assert.equal((await stored(finalId)).status,'completed');assert.equal((await readMetaInventory(final.project,viewer,finalId)).inventory?.coverage,'complete');assert.ok((await stored(finalId)).app_cooldown_until.getTime()>=before+119000);
  const sibling=await source(),siblingId=await daily(sibling),start=calls.length;await dailyStep(sibling,siblingId);assert.equal(calls.length,start,'A completed inventory app hint must block sibling Insights dispatch.');assert.equal((await importRow(siblingId)).status,'queued');assert.ok((await importRow(siblingId)).next_attempt_at.getTime()>Date.now());
  await clearCooldowns();await dueImport(siblingId);await dailyStep(sibling,siblingId);assert.deepEqual(calls.slice(start).map(c=>c.op),['account','submit']);assert.equal((await importRow(siblingId)).status,'waiting');await cancelMetaImport(sibling.project,owner,siblingId,{requestId:randomUUID()});
  console.log('PASS terminal successful inventory hints delay a different-account Insights queue until the recorded app cooldown ends');

  const invalid=await source(),invalidId=await enqueue(invalid);
  await step(invalid,invalidId,c=>c.op==='campaigns'?Response.json({data:[row(invalid)],paging:{next:'unused',cursors:{after:'next'}}}):undefined);await due(invalidId);const invalidHintAt=Date.now();
  await step(invalid,invalidId,c=>c.op==='campaigns'?Response.json({data:[row(invalid)]},{headers:highRate()}):undefined);
  const invalidResult=await readMetaInventory(invalid.project,viewer,invalidId);assert.equal(invalidResult.inventory?.status,'failed');assert.equal(invalidResult.inventory?.coverage,'unavailable');assert.deepEqual(invalidResult.rows,[]);assert.ok((await stored(invalidId)).app_cooldown_until.getTime()>=invalidHintAt+119000);
  const blocked=await source(),blockedId=await daily(blocked),blockedStart=calls.length;await dailyStep(blocked,blockedId);
  assert.equal(calls.length,blockedStart,'Validated rate headers survive a rejected response body and delay the sibling queue.');assert.equal((await importRow(blockedId)).status,'queued');assert.equal((await importRow(blockedId)).submitted_at,null);await cancelMetaImport(blocked.project,owner,blockedId,{requestId:randomUUID()});await clearCooldowns();
  console.log('PASS an invalid final campaign body stays unavailable while its observed app hint still delays sibling Insights');

  for(const kind of ['inventory','report']as const){
   const producer=await source(),producerId=await enqueue(producer),s=await source(),id=kind==='inventory'?await enqueue(s):await daily(s),start=calls.length;
   const duringAccount:Handler=async c=>{if(c.op==='account')await throttle(producer,producerId);};
   if(kind==='inventory')await step(s,id,duringAccount);else await dailyStep(s,id,duringAccount);
   assert.equal(calls.slice(start).filter(c=>c.url.pathname==='/v26.0/act_'+s.accountId+'/campaigns'||c.op==='submit').length,0,'New hint during account GET must prevent the next provider operation.');
   if(kind==='inventory'){assert.equal((await stored(id)).pages,0);assert.equal((await stored(id)).status,'reading');}else{assert.equal((await importRow(id)).status,'queued');assert.equal((await importRow(id)).submitted_at,null,'Known-unsent deferral must not become an ambiguous POST.');}
   await clearCooldowns();if(kind==='inventory'){await due(id);await step(s,id);assert.equal((await stored(id)).status,'completed');}else{await dueImport(id);await dailyStep(s,id);assert.equal((await importRow(id)).status,'waiting');assert.equal(calls.slice(start).filter(c=>c.op==='submit').length,1);await cancelMetaImport(s.project,owner,id,{requestId:randomUUID()});}
  }
  console.log('PASS both queues recheck hints between account and next GET/POST; a deferred known-unsent report resumes with one POST');

  const producer=await source(),producerId=await enqueue(producer),unknown=await source(),unknownId=await enqueue(unknown);await pool.query('UPDATE meta_oauth_flow SET data_access_expires_at=NULL WHERE id=$1',[unknown.grant]);const startUnknown=calls.length;
  await step(unknown,unknownId,async c=>{if(c.op==='inspect')await throttle(producer,producerId);});
  const ownCalls=calls.slice(startUnknown).filter(c=>c.url.searchParams.get('input_token')===unknown.token||c.url.pathname==='/v26.0/me/permissions'||c.url.pathname.includes('act_'+unknown.accountId));assert.deepEqual(ownCalls.map(c=>c.op),['inspect']);assert.equal((await stored(unknownId)).pages,0);
  await clearCooldowns();await due(unknownId);await step(unknown,unknownId);assert.equal((await stored(unknownId)).status,'completed');assert.deepEqual(await counts(),untouched);assert.equal(outbound,0);
  console.log('PASS unknown-expiry inspection also rechecks shared cooldown before permissions and safely resumes without paid/native writes');

  const inspected=await source(),inspectedId=await enqueue(inspected);await pool.query('UPDATE meta_oauth_flow SET data_access_expires_at=NULL WHERE id=$1',[inspected.grant]);const inspectedStart=calls.length,beforeHint=Date.now();
  await step(inspected,inspectedId,c=>c.op==='inspect'?Response.json({data:{app_id:'12345',user_id:inspected.subject,type:'USER',is_valid:true,scopes:['ads_read'],expires_at:Math.floor(Date.now()/1000)+86400,data_access_expires_at:0}},{headers:highRate()}):undefined);
  assert.deepEqual(calls.slice(inspectedStart).map(c=>c.op),['inspect']);assert.equal((await stored(inspectedId)).pages,0);assert.ok((await stored(inspectedId)).app_cooldown_until.getTime()>=beforeHint+119000);
  await clearCooldowns();await due(inspectedId);await step(inspected,inspectedId);assert.equal((await stored(inspectedId)).status,'completed');
  console.log('PASS a successful token inspection itself records its app cooldown before the next permissions GET');

  for(const kind of ['inventory','report']as const)for(const loss of ['permission','expiry']as const){
   const s=await source(),id=kind==='inventory'?await enqueue(s):await daily(s);
   if(kind==='inventory')await step(s,id,c=>c.op==='campaigns'?Response.json({data:[row(s)],paging:{next:'unused',cursors:{after:'next'}}}):undefined);
   else {await pool.query("UPDATE meta_import SET status='reading',provider_report_id='888',submitted_at=clock_timestamp(),pages=1,row_count=1 WHERE id=$1",[id]);await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,$4,1,$5)',[id,s.project,s.workspace,JSON.stringify([{date:day,accountId:s.accountId,campaignId:null,campaignName:null,impressions:'1',clicks:null,spend:null,actions:null,actionValues:null}]),'a'.repeat(64)]);}
   await pool.query('UPDATE meta_oauth_flow SET data_access_expires_at=NULL WHERE id=$1',[s.grant]);if(kind==='inventory')await due(id);else await dueImport(id);const start=calls.length;
   const invalidInspection:Handler=async c=>{if(c.op!=='inspect')return;await pool.query('UPDATE '+(kind==='inventory'?'meta_campaign_inventory':'meta_import')+" SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);return Response.json({data:{app_id:'12345',user_id:s.subject,type:'USER',is_valid:true,scopes:loss==='permission'?[]:['ads_read'],expires_at:Math.floor(Date.now()/1000)+86400,data_access_expires_at:loss==='expiry'?1:0}});};
   if(kind==='inventory'){await step(s,id,invalidInspection);const result=await readMetaInventory(s.project,viewer,id);assert.equal(result.inventory?.status,'denied');assert.equal(result.inventory?.readableRows,null);assert.deepEqual(result.rows,[]);}
   else {await dailyStep(s,id,invalidInspection);const result=await readMetaImport(s.project,viewer,id);assert.equal(result.import.status,'denied');assert.equal(result.import.readableRows,null);assert.deepEqual(result.rows,[]);}
   assert.deepEqual(calls.slice(start).map(c=>c.op),['inspect']);
  }
  assert.deepEqual(await counts(),untouched);assert.equal(outbound,0);
  console.log('PASS inspected permission loss or expired data access arriving after deadline denies both queues without a partial snapshot');
 }finally{await stopJobs();globalThis.fetch=previous;}
}
if(process.env.TEN98_META_AUTH_TEST==='1')runMetaInventoryBoundaryChecks().then(()=>closeDatabase()).catch(async error=>{console.error(error instanceof Error?error.message:'Inventory boundary acceptance failed.');await closeDatabase();process.exitCode=1;});
