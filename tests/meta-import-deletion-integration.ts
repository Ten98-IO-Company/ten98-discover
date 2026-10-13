import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {assertMetaGrantAllowed,metaAppContext,metaConnectionContext,metaSubjectHash,withMetaRegistration,type MetaSecrets} from '../src/server/meta-auth.ts';
import {acceptMetaDeletion,getMetaDeletionStatus,runMetaDeletionBatch} from '../src/server/meta-callbacks.ts';

// Fresh disposable fixture only. No migration, provisioning, reset, or provider call.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig(),url=new URL(config.databaseUrl),ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_meta_callbacks_imports_ci';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_meta_callbacks_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));assert.ok(process.env.CREDENTIAL_KEYS&&process.env.CREDENTIAL_ACTIVE_KEY&&!process.env.CREDENTIAL_KEYS_FILE);
const pool=getDatabase().pool,original={fetch:globalThis.fetch,keys:process.env.CREDENTIAL_KEYS,active:process.env.CREDENTIAL_ACTIVE_KEY};let requests=0;
globalThis.fetch=async()=>{requests++;throw new Error('External traffic is forbidden in Meta deletion acceptance.');};
const subject='123456789012345678901',otherSubject='123456789012345678902';
type App={id:string;secrets:MetaSecrets};type Project={id:string;workspace:string;owner:string};type Grant={id:string;flow:string;account:string};
const fails=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
async function app(appId:string):Promise<App>{const id=randomUUID(),secrets={appSecret:'synthetic-'+randomUUID(),subjectHmacKey:randomBytes(32).toString('base64url')};await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,bound_origin,declared_mode) VALUES($1,$2,'123',1,1,$3,$4,'development')`,[id,appId,encryptCredentials(secrets,metaAppContext({id,credential_revision:1})),config.appUrl]);return {id,secrets};}
async function project():Promise<Project>{const id=randomUUID(),workspace=randomUUID(),owner=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Meta report erasure\',$2)',[owner,owner+'@meta-erasure.integration.test']);await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Meta erasure fixture')",[workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Meta erasure fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.integration.test',randomUUID()]);return {id,workspace,owner};}
let accountSequence=1;
async function grant(a:App,p:Project,{user=subject,epoch='1',existing}: {user?:string;epoch?:string;existing?:string}={}):Promise<Grant>{
 const id=existing??randomUUID(),flow=randomUUID(),account='123450'+accountSequence++,revision=existing?(await pool.query('SELECT revision FROM meta_connection WHERE id=$1',[id])).rows[0].revision+1:1;
 const token=encryptCredentials({accessToken:'synthetic-'+flow},metaConnectionContext({id,workspace_id:p.workspace,revision}));
 if(existing)await pool.query("UPDATE meta_connection SET revision=$2,status='ready',encrypted_token=$3,account_id=$4,account_name='New provider label',deleted_at=NULL WHERE id=$1",[id,revision,token,account]);
 else await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,revision,status,encrypted_token,account_id,account_name,currency,time_zone,account_status) VALUES($1,$2,$3,'Authored source',1,'ready',$4,$5,'Old provider label','USD','UTC',1)`,[id,p.workspace,p.id,token,account]);
 await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,scopes,token_type,access_expires_at,data_access_expires_at,granted_at,expires_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,'completed',$8,'["ads_read"]','USER',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp()+interval '10 minutes')`,[flow,a.id,epoch,p.workspace,p.id,p.owner,id,metaSubjectHash(a.secrets,user)]);
 await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[id,flow]);return {id,flow,account};
}
async function report(p:Project,g:Grant,{id=randomUUID(),pages=1,status='completed'}:{id?:string;pages?:number;status?:string}={}){
 const active=['queued','submitting','waiting','reading'].includes(status),source={provider:'meta_ads',accountId:g.account,accountName:'Retained provider account label',currency:'USD',timeZone:'UTC',graphVersion:'v26.0',report:'account_daily',definitionVersion:1,level:'account',breakdowns:[],attribution:{mode:'meta_reported',requestedWindows:['7d_click','1d_view'],reportingPolicy:'meta_mixed',effectiveAdSetSettings:'unknown'}};
 await pool.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,pages,row_count,generation,lease_token,lease_expires_at,provider_report_id,next_cursor,cursor_hashes,completed_at)
  VALUES($1,$2,$3,$4,$5,$6,1,1,$7,'account_daily','2026-10-01','2026-10-31',$8,$9,$10,$10,7,$11,$12,'987654321','opaque-private-continuation',$13,$14)`,[id,p.workspace,p.id,p.owner,g.id,g.flow,randomUUID(),source,status,pages,active?randomUUID():null,active?new Date(Date.now()+60000):null,['a'.repeat(64)],active?null:new Date()]);
 for(let i=0;i<pages;i++){const rows=[{date:`2026-10-${String(i+1).padStart(2,'0')}`,accountId:g.account,campaignId:null,campaignName:null,impressions:'1',clicks:null,spend:'0.01',actions:null,actionValues:null}];await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,1,$6)',[id,p.id,p.workspace,i,JSON.stringify(rows),createHash('sha256').update(JSON.stringify(rows)).digest('hex')]);}return id;
}
const importRow=async(id:string)=>(await pool.query('SELECT * FROM meta_import WHERE id=$1',[id])).rows[0];
const pageCount=async(id:string)=>(await pool.query('SELECT count(*)::int AS n FROM meta_import_page WHERE import_id=$1',[id])).rows[0].n as number;
const connection=async(id:string)=>(await pool.query('SELECT * FROM meta_connection WHERE id=$1',[id])).rows[0];
function signed(a:App,at=1){const payload=Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',user_id:subject,issued_at:at})).toString('base64url');return createHmac('sha256',a.secrets.appSecret).update(payload).digest('base64url')+'.'+payload;}
async function drain(max=20){for(let i=0;i<max;i++)if(!(await runMetaDeletionBatch()).pending)return;assert.fail('Bounded synthetic erasure did not finish.');}

try{
 await assertSchema();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty synthetic fixture.');
 const a=await app('123456'),b=await app('654321'),p=await project(),p2=await project();
 const old=await grant(a,p),foreignSubject=await grant(a,p2,{user:otherSubject}),foreignApp=await grant(b,p2);
 const oldReport=await report(p,old,{id:'10000000-0000-4000-8000-000000000001',pages:11,status:'reading'}),expiredReport=await report(p,old,{id:'20000000-0000-4000-8000-000000000001',pages:6});
 const foreignSubjectReport=await report(p2,foreignSubject),foreignAppReport=await report(p2,foreignApp),protectedSubject=await importRow(foreignSubjectReport),protectedApp=await importRow(foreignAppReport);
 await pool.query('UPDATE meta_import SET data_expired_at=clock_timestamp() WHERE id=$1',[expiredReport]);const expiredBefore=await importRow(expiredReport),oldBefore=await importRow(oldReport);
 await assert.rejects(pool.query('UPDATE meta_import SET grant_id=$2 WHERE id=$1',[oldReport,foreignSubject.flow]),fails('23503'));
 await assert.rejects(pool.query('UPDATE meta_import_page SET project_id=$2,workspace_id=$3 WHERE import_id=$1',[oldReport,p2.id,p2.workspace]),fails('23503'));
 await assert.rejects(pool.query('UPDATE meta_import SET source=NULL WHERE id=$1',[oldReport]),fails('23514'));
 await assert.rejects(pool.query('UPDATE meta_import SET pages=51 WHERE id=$1',[oldReport]),fails('23514'));
 await assert.rejects(pool.query('UPDATE meta_import SET lease_expires_at=NULL WHERE id=$1',[oldReport]),fails('23514'));
 await assert.rejects(report(p,old,{status:'queued',pages:0}),fails('23505'));
 assert.equal((await importRow(oldReport)).grant_id,old.flow);assert.equal(await pageCount(oldReport),11);
 console.log('PASS schema enforces immutable scoped grant/page provenance, active-source uniqueness and bounded lease/payload invariants');

 // Prior invalidation is an access fence, not evidence that old report data was erased.
 await pool.query("UPDATE meta_oauth_flow SET invalidated_at=clock_timestamp(),scopes=NULL,token_type=NULL,access_expires_at=NULL,data_access_expires_at=NULL WHERE id=$1",[old.flow]);
 const receipt=await acceptMetaDeletion(a.id,signed(a));assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'queued');
 const allowed=()=>withMetaRegistration(a.id,client=>assertMetaGrantAllowed(client,{registrationId:a.id,subjectHash:metaSubjectHash(a.secrets,subject),startEpoch:'1'}));
 await assert.rejects(allowed(),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===409);
 const newer=await grant(a,p,{epoch:'2',existing:old.id}),newReport=await report(p,newer,{id:'30000000-0000-4000-8000-000000000001'}),newBefore=await importRow(newReport),connectionBefore=await connection(newer.id);
 assert.deepEqual(await acceptMetaDeletion(a.id,signed(a)),receipt);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'queued');
 console.log('PASS a deletion fence covers historical reports despite prior grant invalidation and does not target later reconsent');

 await pool.query("CREATE FUNCTION meta_report_cleanup_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt update failure'; END $$");await pool.query('CREATE TRIGGER meta_report_cleanup_reject BEFORE UPDATE ON meta_deletion_request FOR EACH ROW EXECUTE FUNCTION meta_report_cleanup_reject()');
 await assert.rejects(runMetaDeletionBatch());assert.deepEqual(await importRow(oldReport),oldBefore);assert.equal(await pageCount(oldReport),11);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'queued');assert.deepEqual(await connection(newer.id),connectionBefore);
 await pool.query('DROP TRIGGER meta_report_cleanup_reject ON meta_deletion_request');await pool.query('DROP FUNCTION meta_report_cleanup_reject()');
 console.log('PASS tombstone, payload erasure and deletion-receipt progress roll back atomically on a late SQL failure');

 delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
 try{
  const first=await runMetaDeletionBatch();assert.equal(first.pending,true);assert.equal(first.cleanedConnections,0);assert.equal(first.cleanedGrants,0);assert.equal(await pageCount(oldReport),6);assert.equal(await pageCount(expiredReport),6);
  const masked=await importRow(oldReport);assert.ok(masked.deleted_at);assert.equal(masked.status,'denied');assert.equal(masked.diagnostic_code,'grant_deleted');assert.ok(masked.completed_at);assert.equal(masked.source,null);assert.equal(masked.provider_report_id,null);assert.equal(masked.next_cursor,null);assert.deepEqual(masked.cursor_hashes,[]);assert.equal(masked.lease_token,null);assert.equal(masked.lease_expires_at,null);assert.equal(masked.generation,'8');assert.equal(masked.row_count,11);assert.equal(masked.pages,11);assert.equal(masked.payload_cleanup_completed_at,null);assert.equal(masked.grant_id,old.flow);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning');
  const oldLease=await pool.query("UPDATE meta_import SET provider_report_id='111' WHERE id=$1 AND lease_token=$2 AND generation=$3 AND deleted_at IS NULL RETURNING id",[oldReport,oldBefore.lease_token,oldBefore.generation]);assert.equal(oldLease.rowCount,0);
  await runMetaDeletionBatch();assert.equal(await pageCount(oldReport),1);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning');
  await runMetaDeletionBatch();assert.equal(await pageCount(oldReport),0);assert.ok((await importRow(oldReport)).payload_cleanup_completed_at);assert.equal(await pageCount(expiredReport),6);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'cleaning','One cleaned import cannot complete a grant that still owns another report.');
  await drain();
 }finally{process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;}
 const erasedExpired=await importRow(expiredReport);assert.equal(await pageCount(expiredReport),0);assert.equal(erasedExpired.source,null);assert.equal(erasedExpired.status,'completed');assert.equal(erasedExpired.completed_at.getTime(),expiredBefore.completed_at.getTime());assert.equal(erasedExpired.data_expired_at.getTime(),expiredBefore.data_expired_at.getTime());assert.equal(erasedExpired.row_count,6);assert.ok(erasedExpired.payload_cleanup_completed_at);assert.equal((await getMetaDeletionStatus(receipt.confirmation_code)).status,'local_deleted');
 console.log('PASS keyless multi-batch cleanup fences stale leases, removes at most five pages and waits for all covered imports including expired residual payload');

 assert.deepEqual(await connection(newer.id),connectionBefore);assert.deepEqual(await importRow(newReport),newBefore);assert.equal(await pageCount(newReport),1);assert.deepEqual(await importRow(foreignSubjectReport),protectedSubject);assert.deepEqual(await importRow(foreignAppReport),protectedApp);assert.equal(await pageCount(foreignSubjectReport),1);assert.equal(await pageCount(foreignAppReport),1);
 assert.deepEqual(await acceptMetaDeletion(a.id,signed(a)),receipt);await drain();assert.deepEqual(await importRow(newReport),newBefore);
 const second=await acceptMetaDeletion(a.id,signed(a,2));assert.notEqual(second.confirmation_code,receipt.confirmation_code);await drain();assert.equal((await connection(newer.id)).status,'deleted');assert.equal((await importRow(newReport)).source,null);assert.equal(await pageCount(newReport),0);assert.equal((await getMetaDeletionStatus(second.confirmation_code)).status,'local_deleted');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_import WHERE grant_id=ANY($1::uuid[])',[[old.flow,newer.flow]])).rows[0].n,3,'Minimal import receipts and original grant linkage survive erasure.');assert.equal(requests,0);
 console.log('PASS old callback replay preserves reconsented reports; a new signed deletion covers them, while other subjects/apps and minimal receipts survive');

 const switchedApp=await app('777777'),beforeSwitch=await grant(switchedApp,p2),historical=await report(p2,beforeSwitch);
 const afterSwitch=await grant(b,p2,{existing:beforeSwitch.id}),current=await report(p2,afterSwitch),currentReport=await importRow(current),currentConnection=await connection(afterSwitch.id);
 const switchedReceipt=await acceptMetaDeletion(switchedApp.id,signed(switchedApp));await drain();
 assert.equal((await getMetaDeletionStatus(switchedReceipt.confirmation_code)).status,'local_deleted');assert.equal((await importRow(historical)).source,null);assert.equal(await pageCount(historical),0);assert.deepEqual(await importRow(current),currentReport);assert.deepEqual(await connection(afterSwitch.id),currentConnection);assert.equal(await pageCount(current),1);assert.equal(requests,0);
 console.log('PASS a retired app registration erases its historical grant reports without deleting a replacement app’s current source or reports');
}finally{globalThis.fetch=original.fetch;process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;await closeDatabase();}
