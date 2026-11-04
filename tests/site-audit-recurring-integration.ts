import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {addDomain,issueDomainChallenge,verifyDomain} from '../src/server/domains.ts';
import {getSiteAuditSchedule,saveSiteAuditSchedule,pauseSiteAuditSchedule,claimDueSiteAuditOccurrence,expireSiteAuditScheduleHistory} from '../src/server/site-audit-recurring.ts';
import {auditAuthorityCurrent,withAuditLock,siteAuditQueue,deleteSiteAudit} from '../src/server/site-audits.ts';
import {closeAccount,type StepUpProof} from '../src/server/account-closure.ts';
import {siteAuditScheduleResponse,siteAuditScheduleMutationResponse} from '../src/lib/site-audit-recurring.ts';

/** Native schedule/queue acceptance, only in a fresh owned loopback fixture; no crawl worker is started. */
export async function runSiteAuditScheduleChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SITE_AUDIT_SCHEDULE_TEST,'1');
 const config=getConfig(),database=new URL(config.databaseUrl);
 assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55501');assert.match(database.pathname,/^\/ten98_audit_schedule_[a-f0-9]{12}$/);
 assert.equal(database.search,'');assert.equal(database.hash,'');assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('No external requests in schedule acceptance.');};
 const owner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),stranger=randomUUID();
 for(const user of [owner,admin,editor,viewer,stranger])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Schedule fixture\',$2)',[user,`${user}@schedule.integration.test`]);
 const definition={mode:'static' as const,domainId:null as string|null,startPath:'/',maxPages:5,retainBodyText:false};
 const calendar={interval:'daily' as const,timezone:'UTC',hour:12,minute:0,weekday:null};
 async function fixture(sharedWorkspace?:string){
  const workspace=sharedWorkspace??randomUUID(),project=randomUUID();
  if(!sharedWorkspace){await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Schedule fixture')",[workspace]);for(const[user,role]of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);}
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Schedule fixture',$4,$3,'infinity')",[project,workspace,randomUUID(),'https://'+project+'.example.org']);
  return {workspace,project};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const input=(revision=0)=>({requestId:randomUUID(),expectedRevision:revision,definition:{...definition},calendar:{...calendar}});
 const save=async(f:Fixture,body=input(),user=owner)=>siteAuditScheduleMutationResponse.parse(await saveSiteAuditSchedule(f.project,user,body));
 const read=async(f:Fixture,user=owner)=>siteAuditScheduleResponse.parse(await getSiteAuditSchedule(f.project,user));
 const pause=async(f:Fixture,revision:number)=>siteAuditScheduleMutationResponse.parse(await pauseSiteAuditSchedule(f.project,owner,{requestId:randomUUID(),expectedRevision:revision}));
 const due=async(f:Fixture,age='1 second')=>{await pool.query("UPDATE site_audit_schedule SET next_due_at=clock_timestamp()-$2::interval WHERE project_id=$1",[f.project,age]);};
 const rows=async(f:Fixture)=>(await pool.query('SELECT * FROM site_audit_occurrence WHERE project_id=$1 ORDER BY created_at,id',[f.project])).rows;
 const status=async(id:string)=>(await pool.query('SELECT status FROM site_audit_run WHERE id=$1',[id])).rows[0].status;
 const finish=async(id:string)=>{await pool.query("UPDATE site_audit_run SET status='completed',phase=NULL,completed_at=GREATEST(created_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[id]);};
 const countRuns=async(f:Fixture)=>(await pool.query('SELECT count(*)::int AS n FROM site_audit_run WHERE project_id=$1',[f.project])).rows[0].n;
 try{
  const f=await fixture();const queuePresent=async()=>(await pool.query("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='pgboss' AND table_name='queue') AS present")).rows[0].present;
  const before=await queuePresent();assert.equal((await read(f,viewer)).schedule,null);assert.equal(await queuePresent(),before);assert.equal(await countRuns(f),0);
  await assert.rejects(save(f,input(),viewer),{status:403});await assert.rejects(save(f,input(),editor),{status:403});await assert.rejects(read(f,stranger),{status:404});
  await assert.rejects(saveSiteAuditSchedule(f.project,owner,{...input(),calendar:{...calendar,timezone:'Invalid/Nowhere'}}),{status:400});
  await assert.rejects(save(f,{...input(),definition:{...definition,startPath:'/?secret=x'}}),{status:400});
  await assert.rejects(saveSiteAuditSchedule(f.project,owner,{...input(),budget:5}),{status:400});
  console.log('PASS schedule reads do not queue work; native roles, tenant scope and strict inputs reject before mutation');

  const intent=input(),created=await Promise.all([save(f,intent),save(f,intent)]);assert.deepEqual(created[0].ack,created[1].ack);assert.equal(created[0].schedule!.revision,1);assert.equal(await countRuns(f),0);
  await assert.rejects(save(f,{...intent,definition:{...definition,maxPages:6}}),{status:409});await assert.rejects(save(f,input()),{status:409});await assert.rejects(save(f,intent,admin),{status:409});
  const paused=await pause(f,1);assert.equal(paused.schedule!.enabled,false);assert.equal(paused.schedule!.revision,2);
  const oldAck=await save(f,intent);assert.equal(oldAck.ack.revision,1);assert.equal(oldAck.schedule!.revision,2);assert.equal(oldAck.schedule!.enabled,false);
  const byAdmin=await save(f,input(2),admin);assert.equal(byAdmin.schedule!.enabled,true);await pause(f,3);
  console.log('PASS concurrent schedule save and exact receipt replay preserve CAS and never resurrect older approval');

  const boss=await getBoss();await boss.createQueue(siteAuditQueue);
  const c=await fixture();const querySchedule={...input(),definition:{...definition,startPath:'/catalog?b=2&a=1',includeQueryUrls:true}};await saveSiteAuditSchedule(c.project,owner,querySchedule);await due(c);
  await Promise.all([claimDueSiteAuditOccurrence(),claimDueSiteAuditOccurrence()]);const claimed=await rows(c);assert.equal(claimed.length,1);assert.equal(claimed[0].status,'queued');assert.equal(await countRuns(c),1);
  const run=(await pool.query('SELECT queue_job_id,request_id,config FROM site_audit_run WHERE id=$1',[claimed[0].run_id])).rows[0];assert.equal(run.request_id,claimed[0].request_id);assert.equal(run.config.includeQueryUrls,true);assert.equal(run.config.startPath,'/catalog?b=2&a=1');
  const job=(await pool.query('SELECT retry_limit,expire_seconds,data FROM pgboss.job WHERE id=$1',[run.queue_job_id])).rows[0];assert.equal(job.retry_limit,0);assert.equal(job.expire_seconds,2100);assert.deepEqual(job.data,{runId:claimed[0].run_id});
  await claimDueSiteAuditOccurrence();assert.equal((await rows(c)).length,1);assert.ok(Date.parse((await read(c)).schedule!.nextDueAt!)>Date.now());
  console.log('PASS simultaneous due claims create one native run and one durable queue job with a future next occurrence');

  const rollback=await fixture();await save(rollback);await due(rollback);const originalDue=(await pool.query('SELECT next_due_at::text AS at FROM site_audit_schedule WHERE project_id=$1',[rollback.project])).rows[0].at;
  const send=boss.send.bind(boss);let insertedJob:string|null=null;
  boss.send=(async(...args:Parameters<typeof boss.send>)=>{insertedJob=await (send as (...a:unknown[])=>Promise<string|null>)(...args);throw new Error('Synthetic enqueue acknowledgment loss');}) as unknown as typeof boss.send;
  try{await assert.rejects(claimDueSiteAuditOccurrence());}finally{boss.send=send;}
  assert.ok(insertedJob);assert.equal((await pool.query('SELECT 1 FROM pgboss.job WHERE id=$1',[insertedJob])).rowCount,0);assert.equal(await countRuns(rollback),0);assert.equal((await rows(rollback)).length,0);
  assert.equal((await pool.query('SELECT next_due_at::text AS at FROM site_audit_schedule WHERE project_id=$1',[rollback.project])).rows[0].at,originalDue);
  await claimDueSiteAuditOccurrence();assert.equal((await rows(rollback)).length,1);
  console.log('PASS actual enqueue acknowledgment failure rolls back job, run, occurrence and next due time atomically');

  const overlap=await fixture(c.workspace);await save(overlap);await due(overlap);await claimDueSiteAuditOccurrence();const skipped=(await rows(overlap))[0];assert.equal(skipped.status,'skipped');assert.ok(skipped.reason);assert.equal(await countRuns(overlap),0);assert.equal((await read(overlap)).schedule!.enabled,true);
  console.log('PASS workspace overlap skips only the due occurrence and keeps the future schedule enabled');

  for(const drift of ['role','origin','domain-time','domain-revision'] as const){
   const changed=await fixture();const body=input();
   if(drift.startsWith('domain')){const host='serving-'+randomUUID()+'.example.org';const added=await addDomain(changed.project,owner,{hostname:host,role:'serving'});const id=added.domains.find(d=>d.hostname===host)!.id;const proof=await issueDomainChallenge(changed.project,owner,id,{});await verifyDomain(changed.project,owner,id,{},async()=>[[proof.challenge.value]]);body.definition.domainId=id;}
   await save(changed,body,admin);await due(changed);
   if(drift==='role')await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[changed.workspace,admin]);
   if(drift==='origin')await pool.query("UPDATE project SET origin='https://changed.example.org' WHERE id=$1",[changed.project]);
   if(drift==='domain-time')await pool.query("UPDATE project_domain SET verified_at=verified_at+interval '1 microsecond' WHERE id=$1",[body.definition.domainId]);
   if(drift==='domain-revision')await pool.query('UPDATE project_domain SET redirect_revision=redirect_revision+1 WHERE id=$1',[body.definition.domainId]);
   await claimDueSiteAuditOccurrence();assert.equal(await countRuns(changed),0,drift);assert.equal((await rows(changed))[0].status,'skipped',drift);assert.equal((await read(changed)).schedule!.enabled,false,drift);
  }
  const closed=await fixture(),closingUser=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Schedule closure fixture\',$2)',[closingUser,closingUser+'@schedule.integration.test']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[closed.workspace,closingUser]);
  await save(closed,input(),closingUser);const closureClient=await pool.connect();
  try{await closureClient.query('BEGIN');await closeAccount(closureClient,closingUser,{kind:'self',userId:closingUser},{userId:closingUser,method:'password'} as StepUpProof);await closureClient.query('COMMIT');}catch(error){await closureClient.query('ROLLBACK');throw error;}finally{closureClient.release();}
  assert.equal((await pool.query('SELECT approval_user_id FROM site_audit_schedule WHERE project_id=$1',[closed.project])).rows[0].approval_user_id,closingUser);
  assert.equal((await pool.query('SELECT 1 FROM membership WHERE user_id=$1',[closingUser])).rowCount,0);assert.ok((await pool.query('SELECT closed_at FROM "user" WHERE id=$1',[closingUser])).rows[0].closed_at);
  await due(closed);await claimDueSiteAuditOccurrence();assert.equal(await countRuns(closed),0);assert.equal((await read(closed)).schedule!.enabled,false);assert.equal((await rows(closed))[0].reason,'permission_changed');
  console.log('PASS revoked manager authority and exact origin or serving proof drift disable scheduled dispatch');

  const stopping=await fixture();await save(stopping);await due(stopping);await claimDueSiteAuditOccurrence();const first=(await rows(stopping))[0].run_id;await pause(stopping,1);assert.equal(await status(first),'cancelled');
  await save(stopping,input(2));await due(stopping);await claimDueSiteAuditOccurrence();const second=(await rows(stopping)).at(-1)!.run_id;
  const amended=await save(stopping,{...input(3),definition:{...definition,maxPages:6}});assert.equal(await status(second),'cancelled');assert.equal(amended.schedule!.revision,4);
  await due(stopping);await claimDueSiteAuditOccurrence();const running=(await rows(stopping)).at(-1)!.run_id;
  await pool.query("UPDATE site_audit_run SET status='running',phase='robots',started_at=clock_timestamp(),lease_owner=$2,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1",[running,randomUUID()]);
  await pause(stopping,4);assert.equal(await status(running),'running');await finish(running);
  console.log('PASS pause and edits revoke queued approval while an already started audit keeps its original execution');

  const queued=await fixture();await save(queued);await due(queued);await claimDueSiteAuditOccurrence();const queuedId=(await rows(queued))[0].run_id;
  await pool.query("UPDATE project SET origin='https://moved.example.org' WHERE id=$1",[queued.project]);
  assert.deepEqual(await withAuditLock({internal:true,runId:queuedId},async({client,run})=>auditAuthorityCurrent(client,run!)),{allowed:false,reason:'scope_changed'});
  console.log('PASS queued scheduled audits retain the native authority gate after their schedule occurrence is committed');

  for(const [interval,zone,hour,minute,after,expected]of [
   ['daily','America/New_York',2,30,'2024-03-10T06:00:00Z','2024-03-10T07:30:00.000Z'],
   ['daily','America/New_York',1,30,'2024-11-03T04:00:00Z','2024-11-03T06:30:00.000Z'],
   ['monthly','UTC',18,0,'2024-02-01T00:00:00Z','2024-02-29T18:00:00.000Z'],
  ] as const){const next=(await pool.query('SELECT rank_next_due($1,$2,$3,$4,NULL,$5) AS at',[interval,zone,hour,minute,after])).rows[0].at;assert.equal(next.toISOString(),expected);}
  console.log('PASS reused native calendar preserves independent daylight gap, fold and leap month-end fixtures');

  const downtime=await fixture();await save(downtime);await due(downtime,'45 days');await claimDueSiteAuditOccurrence();await claimDueSiteAuditOccurrence();assert.equal((await rows(downtime)).length,1);assert.equal(await countRuns(downtime),1);assert.ok(Date.parse((await read(downtime)).schedule!.nextDueAt!)>Date.now());
  console.log('PASS recovery after downtime advances to a future occurrence without replaying the missed backlog');

  const retained=await fixture();await save(retained);await due(retained);await claimDueSiteAuditOccurrence();const retainedId=(await rows(retained))[0].run_id;
  await pool.query("UPDATE workspace SET derived_history_days=1 WHERE id=$1",[retained.workspace]);await pool.query("UPDATE site_audit_occurrence SET created_at=clock_timestamp()-interval '2 days' WHERE project_id=$1",[retained.project]);
  assert.equal((await read(retained)).schedule!.occurrences.length,0);await pool.query('UPDATE workspace SET derived_history_days=3650 WHERE id=$1',[retained.workspace]);assert.equal((await read(retained)).schedule!.occurrences.length,0);assert.equal(await status(retainedId),'queued');
  assert.equal((await rows(retained))[0].run_id,null);await pause(retained,1);assert.equal(await status(retainedId),'cancelled');
  const expiredRun=await fixture();await save(expiredRun);await due(expiredRun);await claimDueSiteAuditOccurrence();const expiredRunId=(await rows(expiredRun))[0].run_id;await finish(expiredRunId);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[expiredRunId]);
  const expiredRunHistory=(await read(expiredRun)).schedule!.occurrences[0];assert.equal(expiredRunHistory.status,'unavailable');assert.equal(expiredRunHistory.runId,null);assert.equal(await countRuns(expiredRun),1);
  const bulk=await fixture();await save(bulk);await pool.query('UPDATE workspace SET derived_history_days=1 WHERE id=$1',[bulk.workspace]);
  await pool.query("INSERT INTO site_audit_occurrence(id,project_id,approval_id,scheduled_for,request_id,status,reason,created_at) SELECT gen_random_uuid(),s.project_id,s.approval_id,clock_timestamp()-interval '3 days'+n*interval '1 second',gen_random_uuid(),'skipped','workspace_overlap',clock_timestamp()-interval '2 days' FROM site_audit_schedule s CROSS JOIN generate_series(1,1001) n WHERE s.project_id=$1",[bulk.project]);
  assert.deepEqual(await withAuditLock({internal:true,projectId:bulk.project},({client})=>expireSiteAuditScheduleHistory(client,bulk.project)),{expired:1000,pending:true});
  assert.deepEqual(await withAuditLock({internal:true,projectId:bulk.project},({client})=>expireSiteAuditScheduleHistory(client,bulk.project)),{expired:1,pending:false});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_audit_occurrence WHERE project_id=$1 AND data_expired_at IS NOT NULL AND run_id IS NULL AND reason IS NULL',[bulk.project])).rows[0].n,1001);
  const deleted=await fixture();await save(deleted);await due(deleted);await claimDueSiteAuditOccurrence();const deletedId=(await rows(deleted))[0].run_id;await finish(deletedId);await deleteSiteAudit(deleted.project,owner,deletedId,{});
  const deletedHistory=(await read(deleted)).schedule!.occurrences[0];assert.equal(deletedHistory.status,'unavailable');assert.equal(deletedHistory.runId,null);assert.equal(await countRuns(deleted),1);
  console.log('PASS history expiry cannot resurrect and deleted native runs lose their link without creating replacement work');

  const api=await fixture(),password=randomBytes(24).toString('hex'),passwordHash=await hashPassword(password),cookies=new Map<string,string>();
  for(const user of [owner,viewer]){await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,passwordHash]);const login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:config.appUrl},body:JSON.stringify({email:`${user}@schedule.integration.test`,password})}));assert.equal(login.status,200);cookies.set(user,login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));}
  const base=config.appUrl+'/api/projects/'+api.project+'/audits/schedule';let apiRequests=0;
  const request=(suffix='',method='GET',body?:unknown,user=owner,origin=config.appUrl)=>new Request(base+suffix,{method,headers:{cookie:cookies.get(user)!,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const invoke=(r:Request)=>{assert.ok(++apiRequests<=100);return handleApi(r);};
  assert.equal((await invoke(new Request(base))).status,401);assert.equal((await invoke(request('','POST',input(),owner,'https://foreign.example.org'))).status,403);assert.equal((await invoke(request('?extra=1'))).status,400);assert.equal((await invoke(request('','PUT'))).status,405);assert.equal((await invoke(request('','POST',input(),viewer))).status,404);
  const apiIntent=input();const result=await invoke(request('','POST',apiIntent));assert.equal(result.status,200);const dto=siteAuditScheduleMutationResponse.parse(await result.json());assert.equal(dto.ack.requestId,apiIntent.requestId);assert.equal(dto.schedule!.enabled,true);assert.equal(await countRuns(api),0);
  const repeated=await invoke(request('','POST',apiIntent));assert.equal(repeated.status,200);assert.deepEqual((await repeated.json()).ack,dto.ack);assert.equal((await invoke(request('','GET',undefined,viewer))).status,200);
  const pausedApi=await invoke(request('/pause','POST',{requestId:randomUUID(),expectedRevision:1}));assert.equal(pausedApi.status,200);assert.equal(siteAuditScheduleMutationResponse.parse(await pausedApi.json()).schedule!.enabled,false);assert.equal(outbound,0);
  console.log('PASS native schedule API enforces cookie and Origin authority, route contracts and request-only mutation recovery');
 }finally{globalThis.fetch=originalFetch;await stopJobs();await closeDatabase();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSiteAuditScheduleChecks();
