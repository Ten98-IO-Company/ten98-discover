import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {metaAppContext,metaConnectionContext,metaSubjectHash,type MetaSecrets} from '../src/server/meta-auth.ts';
import {acceptMetaDeletion,getMetaDeletionStatus,runMetaDeletionBatch} from '../src/server/meta-callbacks.ts';
import {exportMetaInventory,listMetaInventories,metaCampaignStatuses,readLatestMetaInventory,readMetaInventory} from '../src/server/meta-inventory.ts';

// Fresh disposable database only. This test never migrates, starts jobs, calls a
// provider, or deletes fixtures. Grant seeding follows the existing deletion suite.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_META_CALLBACKS_TEST,'1');
const config=getConfig(),url=new URL(config.databaseUrl);
const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_callbacks_inventory_ci';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_callbacks_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));assert.ok(process.env.CREDENTIAL_KEYS&&process.env.CREDENTIAL_ACTIVE_KEY&&!process.env.CREDENTIAL_KEYS_FILE);
const pool=getDatabase().pool,original={fetch:globalThis.fetch,keys:process.env.CREDENTIAL_KEYS,active:process.env.CREDENTIAL_ACTIVE_KEY};let requests=0;
globalThis.fetch=async()=>{requests++;throw new Error('Provider traffic is forbidden in inventory deletion acceptance.');};
const subject='123456789012345678901',otherSubject='123456789012345678902';
type App={id:string;secrets:MetaSecrets};type Project={id:string;workspace:string;owner:string};type Grant={id:string;flow:string;account:string;revision:number};
const status=(n:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===n;
async function app(appId:string):Promise<App>{const id=randomUUID(),secrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,bound_origin,declared_mode) VALUES($1,$2,'123',1,1,$3,$4,'development')`,[id,appId,encryptCredentials(secrets,metaAppContext({id,credential_revision:1})),config.appUrl]);return {id,secrets};}
async function project():Promise<Project>{const id=randomUUID(),workspace=randomUUID(),owner=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Inventory erasure\',$2)',[owner,owner+'@meta-inventory-erasure.integration.test']);await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Inventory erasure fixture')",[workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Inventory erasure fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.integration.test',randomUUID()]);return {id,workspace,owner};}
let accountSequence=1;
async function grant(a:App,p:Project,{user=subject,epoch='1',existing}: {user?:string;epoch?:string;existing?:string}={}):Promise<Grant>{
 const id=existing??randomUUID(),flow=randomUUID(),account='123450'+accountSequence++,revision=existing?(await pool.query('SELECT revision FROM meta_connection WHERE id=$1',[id])).rows[0].revision+1:1;
 const token=encryptCredentials({accessToken:'synthetic-'+flow},metaConnectionContext({id,workspace_id:p.workspace,revision}));
 if(existing)await pool.query("UPDATE meta_connection SET revision=$2,status='ready',encrypted_token=$3,account_id=$4,account_name='New provider label',deleted_at=NULL WHERE id=$1",[id,revision,token,account]);
 else await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,revision,status,encrypted_token,account_id,account_name,currency,time_zone,account_status) VALUES($1,$2,$3,'Authored source',1,'ready',$4,$5,'Provider label','USD','UTC',1)`,[id,p.workspace,p.id,token,account]);
 await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,'completed',$8,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp()+interval '10 minutes')`,[flow,a.id,epoch,p.workspace,p.id,p.owner,id,metaSubjectHash(a.secrets,user)]);
 await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[id,flow]);return {id,flow,account,revision};
}
async function inventory(p:Project,g:Grant,{id=randomUUID(),pages=1,active=false,expired=false}: {id?:string;pages?:number;active?:boolean;expired?:boolean}={}){
 const source={provider:'meta_ads',accountId:g.account,accountName:'Private provider account label',currency:'USD',timeZone:'UTC',graphVersion:'v26.0',definitionVersion:1,kind:'campaign_inventory',effectiveStatuses:metaCampaignStatuses};
 await pool.query(`INSERT INTO meta_campaign_inventory(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,source,status,pages,row_count,generation,lease_token,lease_expires_at,next_cursor,cursor_hashes,first_fetched_at,last_fetched_at,completed_at,data_expired_at)
  VALUES($1,$2,$3,$4,$5,$6,$17,1,$7,$8,$9,$10,$10*5,$11,$12,$13,'private-cursor',$14,clock_timestamp()-interval '1 minute',clock_timestamp(),$15,$16)`,[id,p.workspace,p.id,p.owner,g.id,g.flow,randomUUID(),source,active?'reading':'completed',pages,active?'9223372036854775807':'7',active?randomUUID():null,active?new Date(Date.now()+60000):null,['a'.repeat(64)],active?null:new Date(),expired?new Date():null,g.revision]);
 for(let page=0;page<pages;page++){const rows=Array.from({length:5},(_,i)=>({id:String(100000+page*5+i),accountId:g.account,name:'Private campaign '+page+'-'+i,status:'PAUSED',effectiveStatus:'PAUSED'})),json=JSON.stringify(rows);await pool.query('INSERT INTO meta_campaign_inventory_page(inventory_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,5,$6)',[id,p.id,p.workspace,page,json,createHash('sha256').update(json).digest('hex')]);}return id;
}
async function report(p:Project,g:Grant){const id=randomUUID(),source={provider:'meta_ads',accountId:g.account,accountName:'Report account label',currency:'USD',timeZone:'UTC'};await pool.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,pages,row_count,completed_at) VALUES($1,$2,$3,$4,$5,$6,1,1,$7,'account_daily','2026-10-01','2026-10-06',$8,'completed',6,6,clock_timestamp())`,[id,p.workspace,p.id,p.owner,g.id,g.flow,randomUUID(),source]);for(let page=0;page<6;page++){const json=JSON.stringify([{date:'2026-10-0'+(page+1),accountId:g.account,spend:'0.01'}]);await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,1,$6)',[id,p.id,p.workspace,page,json,createHash('sha256').update(json).digest('hex')]);}return id;}
const row=async(id:string)=>(await pool.query('SELECT * FROM meta_campaign_inventory WHERE id=$1',[id])).rows[0];
const pages=async(id:string)=>(await pool.query('SELECT count(*)::int n FROM meta_campaign_inventory_page WHERE inventory_id=$1',[id])).rows[0].n as number;
const connection=async(id:string)=>(await pool.query('SELECT * FROM meta_connection WHERE id=$1',[id])).rows[0];
function signed(a:App,issued=1){const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:subject,issued_at:issued})).toString('base64url');return createHmac('sha256',a.secrets.appSecret).update(payload).digest('base64url')+'.'+payload;}
async function counts(){return(await pool.query(`SELECT 'report:'||import_id::text AS id,count(*)::int AS n FROM meta_import_page GROUP BY import_id UNION ALL SELECT 'inventory:'||inventory_id::text,count(*)::int FROM meta_campaign_inventory_page GROUP BY inventory_id`)).rows as {id:string;n:number}[];}
async function boundedBatch(){const before=await counts(),result=await runMetaDeletionBatch(),after=new Map((await counts()).map(r=>[r.id,r.n]));let changed=0,removed=0;for(const item of before){const n=after.get(item.id)??0;assert.ok(n<=item.n);if(n!==item.n)changed++;removed+=item.n-n;}assert.ok(changed<=1,'One receipt across both datasets per batch');assert.ok(removed<=5,'At most five pages across both datasets per batch');return result;}
async function drain(){for(let i=0;i<30;i++)if(!(await boundedBatch()).pending)return;assert.fail('Synthetic bounded cleanup did not finish.');}
async function masked(p:Project,id:string){const value=await readMetaInventory(p.id,p.owner,id);assert.equal(value.inventory?.dataStatus,'unavailable');assert.equal(value.inventory?.source,null);assert.equal(value.inventory?.readableRows,null);assert.equal(value.inventory?.coverage,'unavailable');assert.equal(value.inventory?.firstFetchedAt,null);assert.equal(value.inventory?.lastFetchedAt,null);assert.deepEqual(value.rows,[]);assert.equal(value.nextCursor,null);return value;}

try{
 await assertSchema();assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0,'Use a fresh empty fixture.');
 const a=await app('123456'),b=await app('654321'),p=await project(),foreign=await project();
 const old=await grant(a,p),cap=await grant(a,p),other=await grant(a,foreign,{user:otherSubject}),otherApp=await grant(b,foreign);
 const completed=await inventory(p,old,{id:'10000000-0000-4000-8000-000000000001',pages:11});
 const active=await inventory(p,old,{id:'20000000-0000-4000-8000-000000000001',pages:6,active:true});
 const expired=await inventory(p,old,{id:'30000000-0000-4000-8000-000000000001',pages:6,expired:true});
 const capped=await inventory(p,cap,{id:'40000000-0000-4000-8000-000000000001'}),protectedSubject=await inventory(foreign,other),protectedApp=await inventory(foreign,otherApp),reportId=await report(p,old);
 await pool.query("UPDATE meta_campaign_inventory SET app_cooldown_until=clock_timestamp()+interval '2 minutes',account_cooldown_until=clock_timestamp()+interval '3 minutes' WHERE id=ANY($1::uuid[])",[[completed,active,expired,capped]]);
 await pool.query("UPDATE meta_import SET app_cooldown_until=clock_timestamp()+interval '2 minutes',account_cooldown_until=clock_timestamp()+interval '3 minutes' WHERE id=$1",[reportId]);
 await pool.query('UPDATE meta_connection SET revision=2147483647 WHERE id=$1',[cap.id]);
 const completedBefore=await row(completed),activeBefore=await row(active),expiredBefore=await row(expired),protectedSubjectBefore=await row(protectedSubject),protectedAppBefore=await row(protectedApp);
 const available=await readMetaInventory(p.id,p.owner,completed);assert.equal(available.inventory?.dataStatus,'available');assert.equal(available.rows.length,50);assert.ok(available.nextCursor);assert.equal((await exportMetaInventory(p.id,p.owner,completed,{expectedRevision:available.inventory!.revision})).rowCount,55);
 const receipt=await acceptMetaDeletion(a.id,signed(a));assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'queued');
 await masked(p,completed);await masked(p,active);await masked(p,expired);
 const latest=await readLatestMetaInventory(p.id,p.owner,old.id);assert.equal(latest.inventory?.dataStatus,'unavailable');assert.equal(latest.inventory?.source,null);assert.deepEqual(latest.rows,[]);
 const list=await listMetaInventories(p.id,p.owner,old.id);assert.equal(list.inventories.length,3);assert.ok(list.inventories.every(i=>i.dataStatus==='unavailable'&&i.source===null));
 await assert.rejects(readMetaInventory(p.id,p.owner,completed,new URLSearchParams({cursor:available.nextCursor!})),status(409));
 await assert.rejects(exportMetaInventory(p.id,p.owner,completed,{expectedRevision:available.inventory!.revision}),status(409));
 const hidden=await masked(p,completed);await assert.rejects(exportMetaInventory(p.id,p.owner,completed,{expectedRevision:hidden.inventory!.revision}),status(409));
 assert.equal(await pages(completed),11,'Reads must mask immediately before physical cleanup.');
 console.log('PASS signed admission immediately masks detail/latest/list/export and invalidates cursors without presenting deleted inventory as empty coverage');

 // Seed a later immutable grant defensively: cleanup must key off captured grant,
 // never the connection's mutable current subject/app or account identifier.
 const newer=await grant(a,p,{epoch:'2',existing:old.id}),newInventory=await inventory(p,newer),newBefore=await row(newInventory),newConnection=await connection(newer.id);
 assert.deepEqual(await acceptMetaDeletion(a.id,signed(a)),receipt);
 await pool.query("CREATE FUNCTION meta_inventory_cleanup_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$");await pool.query('CREATE TRIGGER meta_inventory_cleanup_reject BEFORE UPDATE ON meta_deletion_request FOR EACH ROW EXECUTE FUNCTION meta_inventory_cleanup_reject()');
 await assert.rejects(runMetaDeletionBatch());assert.deepEqual(await row(completed),completedBefore);assert.equal(await pages(completed),11);assert.equal((await pool.query('SELECT count(*)::int n FROM meta_import_page WHERE import_id=$1',[reportId])).rows[0].n,6);assert.equal((await connection(cap.id)).status,'ready');assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'queued');
 await pool.query('DROP TRIGGER meta_inventory_cleanup_reject ON meta_deletion_request');await pool.query('DROP FUNCTION meta_inventory_cleanup_reject()');
 console.log('PASS a late receipt-update failure rolls back cross-dataset erasure, source cleanup and progress atomically');

 delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
 try{
  assert.equal((await boundedBatch()).pending,true);assert.equal((await pool.query('SELECT count(*)::int n FROM meta_import_page WHERE import_id=$1',[reportId])).rows[0].n,1);assert.equal(await pages(completed),11);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning');
  assert.deepEqual((await pool.query('SELECT app_cooldown_until,account_cooldown_until FROM meta_import WHERE id=$1',[reportId])).rows[0],{app_cooldown_until:null,account_cooldown_until:null});
  await boundedBatch();assert.equal(await pages(completed),11,'A report and inventory cannot each spend the five-page budget.');
  await boundedBatch();assert.equal(await pages(completed),6);const first=await row(completed);assert.ok(first.deleted_at);assert.equal(first.source,null);assert.equal(first.first_fetched_at,null);assert.equal(first.last_fetched_at,null);assert.equal(first.next_cursor,null);assert.deepEqual(first.cursor_hashes,[]);assert.equal(first.row_count,55);assert.equal(first.pages,11);assert.equal(first.payload_cleanup_completed_at,null);
  await boundedBatch();assert.equal(await pages(completed),1);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning');
  await boundedBatch();assert.equal(await pages(completed),0);assert.ok((await row(completed)).payload_cleanup_completed_at);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning','Other covered inventories still contain data.');
  // Even fully scrubbed receipts remain eligible if these newly added fields
  // contain residual provider metadata; neither a source nor pages are needed.
  await pool.query("UPDATE meta_campaign_inventory SET app_cooldown_until=clock_timestamp()+interval '2 minutes',account_cooldown_until=clock_timestamp()+interval '3 minutes' WHERE id=$1",[completed]);
  await pool.query("UPDATE meta_import SET app_cooldown_until=clock_timestamp()+interval '2 minutes',account_cooldown_until=clock_timestamp()+interval '3 minutes' WHERE id=$1",[reportId]);
  await drain();
 }finally{process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;}
 const erasedActive=await row(active),erasedExpired=await row(expired),erasedCompleted=await row(completed);
 assert.equal(erasedActive.status,'denied');assert.equal(erasedActive.diagnostic_code,'grant_deleted');assert.equal(erasedActive.generation,'9223372036854775807');assert.equal(erasedActive.lease_token,null);assert.equal(erasedActive.lease_expires_at,null);assert.equal(erasedActive.source,null);assert.equal(erasedActive.row_count,30);assert.equal(await pages(active),0);
 assert.equal((await pool.query('UPDATE meta_campaign_inventory SET next_cursor=$2 WHERE id=$1 AND lease_token=$3 AND generation=$4 AND deleted_at IS NULL RETURNING id',[active,'stale',activeBefore.lease_token,activeBefore.generation])).rowCount,0);
 assert.equal(erasedExpired.data_expired_at.getTime(),expiredBefore.data_expired_at.getTime());assert.equal(erasedExpired.completed_at.getTime(),expiredBefore.completed_at.getTime());assert.equal(erasedExpired.status,'completed');assert.equal(erasedExpired.source,null);assert.equal(await pages(expired),0);
 assert.equal(erasedCompleted.completed_at.getTime(),completedBefore.completed_at.getTime());assert.equal(erasedCompleted.status,'completed');assert.equal(erasedCompleted.grant_id,old.flow);assert.equal(erasedCompleted.row_count,55);assert.equal(erasedCompleted.pages,11);
 assert.equal((await pool.query('SELECT count(*)::int n FROM meta_campaign_inventory WHERE id=ANY($1::uuid[]) AND (app_cooldown_until IS NOT NULL OR account_cooldown_until IS NOT NULL)',[[completed,active,expired,capped]])).rows[0].n,0);
 assert.deepEqual((await pool.query('SELECT app_cooldown_until,account_cooldown_until FROM meta_import WHERE id=$1',[reportId])).rows[0],{app_cooldown_until:null,account_cooldown_until:null});
 const capAfter=await connection(cap.id);assert.equal(capAfter.status,'deleted');assert.equal(capAfter.revision,2147483647);assert.equal(capAfter.encrypted_token,null);assert.equal(capAfter.account_id,null);assert.equal((await row(capped)).source,null);
 assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'local_deleted');
 console.log('PASS keyless five-page cleanup drains both datasets before completion, scrubs inventory provenance fields, saturates caps and fences stale publication');

 assert.deepEqual(await connection(newer.id),newConnection);assert.deepEqual(await row(newInventory),newBefore);assert.equal(await pages(newInventory),1);assert.deepEqual(await row(protectedSubject),protectedSubjectBefore);assert.deepEqual(await row(protectedApp),protectedAppBefore);assert.equal(await pages(protectedSubject),1);assert.equal(await pages(protectedApp),1);
 assert.equal((await readMetaInventory(p.id,p.owner,newInventory)).inventory?.dataStatus,'available');assert.deepEqual(await acceptMetaDeletion(a.id,signed(a)),receipt);await drain();assert.deepEqual(await row(newInventory),newBefore);assert.equal((await readMetaInventory(p.id,p.owner,newInventory)).inventory?.dataStatus,'available');
 const next=await acceptMetaDeletion(a.id,signed(a,2));assert.notEqual(next.confirmation_code,receipt.confirmation_code);await masked(p,newInventory);await drain();assert.equal(await pages(newInventory),0);assert.equal((await row(newInventory)).source,null);assert.equal((await connection(newer.id)).status,'deleted');
 const retained=(await pool.query('SELECT id,phase,subject_hash,start_epoch,connection_id,scopes,token_type,access_expires_at,data_access_expires_at,invalidated_at FROM meta_oauth_flow WHERE id=ANY($1::uuid[])',[[old.flow,newer.flow]])).rows;assert.equal(retained.length,2);assert.ok(retained.every(f=>f.phase==='completed'&&f.subject_hash===metaSubjectHash(a.secrets,subject)&&f.invalidated_at&&f.scopes===null&&f.token_type===null&&f.access_expires_at===null&&f.data_access_expires_at===null));assert.equal((await pool.query('SELECT count(*)::int n FROM meta_campaign_inventory WHERE grant_id=ANY($1::uuid[])',[[old.flow,newer.flow]])).rows[0].n,4);assert.equal((await pool.query('SELECT count(*)::int n FROM meta_deletion_request WHERE registration_id=$1',[a.id])).rows[0].n,2,'Repeated signed payloads retain one durable receipt each.');
 console.log('PASS old-payload replay preserves later grants, other subjects/apps and receipt counts; a new signed request covers the later grant');

 const retired=await app('777777'),oldAppGrant=await grant(retired,foreign),historical=await inventory(foreign,oldAppGrant),replacement=await grant(b,foreign,{existing:oldAppGrant.id}),current=await inventory(foreign,replacement),currentBefore=await row(current),connectionBefore=await connection(replacement.id);
 const retiredReceipt=await acceptMetaDeletion(retired.id,signed(retired));await masked(foreign,historical);await drain();assert.equal((await getMetaDeletionStatus(retiredReceipt.confirmation_code)).status,'local_deleted');assert.equal((await row(historical)).source,null);assert.equal(await pages(historical),0);assert.deepEqual(await row(current),currentBefore);assert.deepEqual(await connection(replacement.id),connectionBefore);
 assert.equal(requests,0);assert.equal((await pool.query('SELECT count(*)::int n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM event')).rows[0].n,0);
 console.log('PASS retired-app cleanup preserves replacement-app current inventory and never emits provider requests, spend records or analytics');
}finally{globalThis.fetch=original.fetch;process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;await closeDatabase();}
