import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {enqueueMetaInventory,cancelMetaInventory,listMetaInventories,readMetaInventory,readLatestMetaInventory,exportMetaInventory,expireMetaInventoryPages,metaInventoryQueue} from '../src/server/meta-inventory.ts';
import {getRetention,previewRetention} from '../src/server/retention.ts';

const fail=(status:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===status;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function runMetaInventoryChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_AUTH_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_auth_inventory_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_auth_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0);
 const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('Inventory service is a local-only test.');};
 const owner=randomUUID(),peer=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),foreign=randomUUID(),app=randomUUID();
 const secrets:MetaSecrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};let n=20000;
 async function source(){const id=randomUUID(),grant=randomUUID(),accountId=String(++n);
  await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,status,encrypted_token,account_id,account_name,currency,time_zone,account_status,validated_at)
   VALUES($1,$2,$3,'Inventory fixture','ready',$4,$5,'=Synthetic account','AED','UTC',1,clock_timestamp())`,[id,workspace,project,encryptCredentials({accessToken:'synthetic-'+id},metaConnectionContext({id,workspace_id:workspace,revision:1})),accountId]);
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at)
   VALUES($1,$2,1,1,$3,$4,$5,$6,'completed',$7,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp())`,[grant,app,workspace,project,owner,id,metaSubjectHash(secrets,String(++n))]);
  await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[id,grant]);return {id,accountId};
 }
 const input=()=>({requestId:randomUUID(),revision:1});
 const enqueue=(s:{id:string},body:{requestId:string;revision:number}=input())=>enqueueMetaInventory(project,owner,s.id,body);
 async function terminal(id:string,status='completed'){await pool.query('UPDATE meta_campaign_inventory SET status=$2,completed_at=clock_timestamp() WHERE id=$1',[id,status]);}
 async function page(id:string,accountId:string,count:number,index=0){const rows=Array.from({length:count},(_,i)=>({id:String(index*100+i+1),accountId,name:i===0?'=SUM(1,2)':i===1?'':null,status:i%2?'FUTURE_STATUS':null,effectiveStatus:'PAUSED'}));
  await pool.query('INSERT INTO meta_campaign_inventory_page(inventory_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,project,workspace,index,JSON.stringify(rows),rows.length,hash(rows)]);
  await pool.query('UPDATE meta_campaign_inventory SET pages=pages+1,row_count=row_count+$2,first_fetched_at=COALESCE(first_fetched_at,clock_timestamp()),last_fetched_at=clock_timestamp() WHERE id=$1',[id,count]);
 }
 try{
  for(const id of [owner,peer,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Inventory fixture\',$2)',[id,id+'@integration.test']);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Inventory fixture')",[workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'viewer')",[workspace,owner,peer,viewer]);
  for(const id of [project,foreign])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Inventory fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.example.test',randomUUID()]);
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode) VALUES($1,'12345','12346',1,1,$2,true,true,$3,'development')`,[app,encryptCredentials(secrets,metaAppContext({id:app,credential_revision:1})),config.appUrl]);
  const s=await source(),body=input();await assert.rejects(enqueueMetaInventory(project,viewer,s.id,body),fail(404));await assert.rejects(enqueueMetaInventory(foreign,owner,s.id,body),fail(404));
  const a=await enqueue(s,body);assert.equal(a.inventory.dataStatus,'pending');assert.deepEqual(a.acknowledgement,{...body,inventoryId:a.inventory.id,connectionId:s.id});
  assert.equal((await enqueue(s,body)).inventory.id,a.inventory.id);await assert.rejects(enqueue(s,{...body,revision:2}),fail(409));await assert.rejects(enqueueMetaInventory(project,peer,s.id,body),fail(409));await assert.rejects(enqueue(s),fail(409));
  assert.deepEqual((await pool.query('SELECT data FROM pgboss.job WHERE name=$1',[metaInventoryQueue])).rows,[{data:{inventoryId:a.inventory.id}}]);
  await assert.rejects(readMetaInventory(foreign,owner,a.inventory.id),fail(404));await assert.rejects(readMetaInventory(project,outsider,a.inventory.id),fail(404));await assert.rejects(cancelMetaInventory(project,viewer,a.inventory.id,{requestId:randomUUID()}),fail(404));
  console.log('PASS inventory roles, tenant scope, immutable acknowledgement, actor-bound replay and identifier-only queue');

  const broken=await source(),key=input(),boss=await getBoss(),send=boss.send.bind(boss);let actualJob:string|undefined;
  boss.send=(async(...args:Parameters<typeof send>)=>{actualJob=await send(...args)??undefined;throw new Error('Synthetic post-insert failure.');})as unknown as typeof boss.send;
  try{await assert.rejects(enqueue(broken,key));}finally{boss.send=send;}
  assert.ok(actualJob);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[actualJob])).rowCount,0);assert.equal((await pool.query('SELECT id FROM meta_campaign_inventory WHERE request_id=$1',[key.requestId])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[key.requestId])).rowCount,0);
  console.log('PASS actual queue insert, inventory and request receipt roll back together');

  await page(a.inventory.id,s.accountId,55);await terminal(a.inventory.id);
  const first=await readLatestMetaInventory(project,viewer,s.id);assert.equal(first.inventory?.coverage,'complete');assert.equal(first.rows.length,50);assert.ok(first.nextCursor);assert.equal(first.rows[0].id,'1');assert.equal(first.rows[1].id,'10');
  const second=await readLatestMetaInventory(project,viewer,s.id,new URLSearchParams({cursor:first.nextCursor!}));assert.equal(second.rows.length,5);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,55);
  const partial=await enqueue(s);await page(partial.inventory.id,s.accountId,1);await terminal(partial.inventory.id,'partial');
  const current=await readLatestMetaInventory(project,viewer,s.id);assert.equal(current.inventory?.id,a.inventory.id);assert.equal(current.latestAttempt?.id,partial.inventory.id);assert.equal((await readMetaInventory(project,viewer,partial.inventory.id)).inventory?.coverage,'partial');
  const empty=await enqueue(s);await terminal(empty.inventory.id);assert.equal((await readLatestMetaInventory(project,viewer,s.id)).inventory?.readableRows,0);await assert.rejects(readLatestMetaInventory(project,viewer,s.id,new URLSearchParams({cursor:first.nextCursor!})),fail(409));
  await pool.query('UPDATE meta_campaign_inventory SET data_expired_at=clock_timestamp() WHERE id=$1',[empty.inventory.id]);assert.equal((await readLatestMetaInventory(project,viewer,s.id)).inventory?.dataStatus,'expired','No fallback past expired winner.');
  console.log('PASS whole completed snapshots, partial latest attempt, complete empty replacement and visibility-bound pages');

  const detail=await readMetaInventory(project,viewer,a.inventory.id),csv=await exportMetaInventory(project,viewer,a.inventory.id,{expectedRevision:detail.inventory!.revision});
  assert.equal(csv.rowCount,55);assert.equal(csv.filename,'meta-campaign-inventory.csv');assert.ok(csv.body.includes("'=Synthetic account"));assert.ok(csv.body.includes("'=SUM(1,2)"));assert.ok(csv.body.includes('Name available'));assert.ok(csv.body.includes('FUTURE_STATUS'));
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(exportMetaInventory(project,viewer,a.inventory.id,{expectedRevision:detail.inventory!.revision},cancelled.signal),fail(499));
  await pool.query('UPDATE meta_campaign_inventory SET data_expired_at=clock_timestamp() WHERE id=$1',[a.inventory.id]);await assert.rejects(exportMetaInventory(project,viewer,a.inventory.id,{expectedRevision:detail.inventory!.revision}),fail(409));
  console.log('PASS exact explicit CSV snapshot, formula-safe metadata, unavailable/empty names and abort/expiry refusal');

  const old=await source(),aged=await enqueue(old);for(let i=0;i<6;i++)await page(aged.inventory.id,old.accountId,1,i);await terminal(aged.inventory.id);await pool.query("UPDATE meta_campaign_inventory SET completed_at=clock_timestamp()-interval '400 days',app_cooldown_until=clock_timestamp()+interval '1 minute',account_cooldown_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",[aged.inventory.id]);
  const policy=await getRetention(workspace,owner),preview=await previewRetention(workspace,owner,{revision:policy.revision,settings:policy.settings});assert.equal(preview.metaInventoryEstimate.status,'available');assert.equal(preview.metaInventoryEstimate.inventories,3);
  await assert.rejects(previewRetention(workspace,viewer,{revision:policy.revision,settings:policy.settings}),fail(403));assert.equal((await readMetaInventory(project,viewer,aged.inventory.id)).rows.length,0);
  assert.equal((await expireMetaInventoryPages()).pages,5);assert.deepEqual((await pool.query('SELECT app_cooldown_until,account_cooldown_until FROM meta_campaign_inventory WHERE id=$1',[aged.inventory.id])).rows[0],{app_cooldown_until:null,account_cooldown_until:null});await pool.query('UPDATE workspace SET derived_history_days=3650 WHERE id=$1',[workspace]);assert.equal((await readMetaInventory(project,viewer,aged.inventory.id)).inventory?.dataStatus,'expired');assert.equal((await expireMetaInventoryPages()).pages,1);
  const later=await previewRetention(workspace,owner,{revision:policy.revision,settings:{...policy.settings,derivedHistoryDays:3650}});assert.equal(later.metaInventoryEstimate.inventories,2);
  console.log('PASS scoped retention preview, bounded cleanup and irreversible masking after policy extension');

  const cancelledSource=await source(),pending=await enqueue(cancelledSource),cancelBody={requestId:randomUUID()};
  assert.equal((await cancelMetaInventory(project,owner,pending.inventory.id,cancelBody)).inventory.status,'cancelled');assert.equal((await cancelMetaInventory(project,owner,pending.inventory.id,cancelBody)).replayed,true);
  await pool.query("UPDATE meta_connection SET encrypted_token=NULL,status='disconnected',revision=revision+1 WHERE id=$1",[cancelledSource.id]);assert.equal((await enqueue(cancelledSource,{requestId:pending.acknowledgement.requestId,revision:1})).inventory.status,'cancelled','Known acknowledgement replay needs no token.');
  assert.equal((await listMetaInventories(project,viewer,s.id)).inventories.length,3);await assert.rejects(listMetaInventories(project,viewer,s.id,new URLSearchParams('other=1')),fail(400));
  const password='synthetic-'+randomBytes(20).toString('hex');await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
  const login=await getAuth().api.signInEmail({body:{email:viewer+'@integration.test',password},asResponse:true});const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const route='/api/projects/'+project+'/meta/campaign-inventories/'+partial.inventory.id;
  const get=await handleApi(new Request(config.appUrl+route,{headers:{cookie}}));assert.equal(get?.status,200);assert.equal((await get!.json()).role,'viewer');
  assert.equal((await handleApi(new Request(config.appUrl+route+'/export',{method:'GET',headers:{cookie}})))?.status,405);
  assert.equal((await handleApi(new Request(config.appUrl+route+'/cancel',{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID()})})))?.status,404);
  const latest=await handleApi(new Request(config.appUrl+'/api/projects/'+project+'/meta/connections/'+s.id+'/campaigns/latest?bad=1',{headers:{cookie}}));assert.equal(latest?.status,400);assert.equal(outbound,0);
  console.log('PASS keyless cancellation/replay, retained member API routes and strict query/method boundaries');
 }finally{await stopJobs();globalThis.fetch=original;}
}
if(process.env.TEN98_META_AUTH_TEST==='1')runMetaInventoryChecks().then(()=>closeDatabase()).catch(async error=>{console.error(error instanceof Error?error.message:'Meta inventory acceptance failed.');await closeDatabase();process.exitCode=1;});
