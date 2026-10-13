import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {addDomain,issueDomainChallenge,verifyDomain,revokeDomain,updateDomain} from '../src/server/domains.ts';
import {siteAuditQueue,getSiteAuditSetup,startSiteAudit,getSiteAudit,listSiteAudits,listSiteAuditPages,getSiteAuditPage,listSiteAuditIssues,listSiteAuditLinks,cancelSiteAudit,deleteSiteAudit,withAuditLock,auditAuthorityCurrent} from '../src/server/site-audits.ts';

export async function runSiteAuditChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');const config=getConfig();
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));await assertSchema();
 const pool=getDatabase().pool,owner=randomUUID(),admin=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),foreignProject=randomUUID();
 const password=randomBytes(32).toString('base64url'),email=`${owner}@audit.integration.test`;
 for(const id of [owner,admin,viewer,stranger])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,'Audit fixture',`${id}@audit.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 for(const id of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Audit fixture')",[id]);
 for(const [user,role] of [[owner,'owner'],[admin,'admin'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
 await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,owner]);
 for(const [id,wid] of [[project,workspace],[foreignProject,foreignWorkspace]])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Audit fixture','https://audit.example.com',$3,'infinity')",[id,wid,randomUUID()]);
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External fetch forbidden in audit API fixtures.');};
 const input=(requestId=randomUUID(),domainId:string|null=null)=>({requestId,domainId,startPath:'/',mode:'static' as const,maxPages:50});
 async function start(pid=project,user=owner,body=input()){return startSiteAudit(pid,user,body);}
 async function finish(id:string){await pool.query("UPDATE site_audit_run SET status='completed',phase=NULL,completed_at=GREATEST(created_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[id]);}
 async function serving(){const hostname=`serving-${randomUUID()}.example.com`,state=await addDomain(project,owner,{hostname,role:'serving'}),id=state.domains.find(d=>d.hostname===hostname)!.id;
  const proof=await issueDomainChallenge(project,owner,id,{});await verifyDomain(project,owner,id,{},async()=>[[proof.challenge.value]]);return id;}
 try{
  const queuesBefore=(await pool.query("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='pgboss' AND table_name='queue') AS present")).rows[0].present;
  const setup=await getSiteAuditSetup(project,viewer);assert.equal(setup.role,'viewer');assert.equal(setup.canStart,false);assert.deepEqual(setup.origins,[{domainId:null,origin:'https://audit.example.com',authority:'canonical_project'}]);assert.ok(['ready','unavailable'].includes(setup.worker.status));
  if(!queuesBefore)assert.equal((await pool.query("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='pgboss' AND table_name='queue') AS present")).rows[0].present,false);
  await assert.rejects(start(project,viewer),{status:403});await assert.rejects(getSiteAuditSetup(project,stranger),{status:404});
  const boss=await getBoss();await boss.createQueue(siteAuditQueue);
  const intent=input(),[first,replay]=await Promise.all([start(project,owner,intent),start(project,owner,intent)]);
  assert.equal(first.run.id,replay.run.id);assert.notEqual(first.created,replay.created);assert.equal(first.run.progress.frontier,2);
  const persisted=(await pool.query('SELECT queue_job_id,request_hash FROM site_audit_run WHERE id=$1',[first.run.id])).rows[0];
  const queued=(await pool.query('SELECT retry_limit,expire_seconds AS seconds,data FROM pgboss.job WHERE id=$1',[persisted.queue_job_id])).rows[0];
  assert.equal(queued.retry_limit,0);assert.equal(queued.seconds,2100);assert.deepEqual(queued.data,{runId:first.run.id});
  assert.equal((await pool.query('SELECT 1 FROM site_audit_page WHERE run_id=$1',[first.run.id])).rowCount,2);
  assert.ok(!JSON.stringify(first).includes(persisted.request_hash));assert.ok(!JSON.stringify(first).includes(persisted.queue_job_id));
  await assert.rejects(start(project,owner,{...intent,maxPages:51}),{status:409});await assert.rejects(start(),{status:409});await assert.rejects(getSiteAudit(foreignProject,owner,first.run.id),{status:404});
  await assert.rejects(deleteSiteAudit(project,owner,first.run.id,{}),{status:409});
  await cancelSiteAudit(project,admin,first.run.id,{});assert.equal((await start(project,owner,intent)).run.status,'cancelled');
  const doomed=input(),send=boss.send.bind(boss);let insertedJob:string|undefined;
  boss.send=(async(...args:Parameters<typeof boss.send>)=>{const result=await (send as (...a:unknown[])=>Promise<string|null>)(...args);insertedJob=result??undefined;throw new Error('Synthetic queue acknowledgment failure');}) as unknown as typeof boss.send;
  try{await assert.rejects(start(project,owner,doomed));}finally{boss.send=send;}
  assert.ok(insertedJob);assert.equal((await pool.query('SELECT 1 FROM pgboss.job WHERE id=$1',[insertedJob])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM site_audit_run WHERE request_id=$1',[doomed.requestId])).rowCount,0);
  console.log('PASS audit setup without queue startup; live roles, tenant scope, request replay and actual atomic queue rollback');

  const domain=await serving(),selected=await start(project,admin,input(randomUUID(),domain));
  const check=()=>withAuditLock({runId:selected.run.id,internal:true},async({client,run})=>auditAuthorityCurrent(client,run!));
  assert.deepEqual(await check(),{allowed:true});
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);assert.deepEqual(await check(),{allowed:false,reason:'permission_changed'});
  await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);
  await updateDomain(project,owner,domain,{role:'redirect_alias'});await updateDomain(project,owner,domain,{role:'serving'});assert.deepEqual(await check(),{allowed:false,reason:'scope_changed'});
  await finish(selected.run.id);const newSelected=await start(project,admin,input(randomUUID(),domain));
  await revokeDomain(project,owner,domain,{});assert.deepEqual(await withAuditLock({runId:newSelected.run.id,internal:true},async({client,run})=>auditAuthorityCurrent(client,run!)),{allowed:false,reason:'scope_changed'});
  await cancelSiteAudit(project,owner,newSelected.run.id,{});assert.ok(!(await getSiteAuditSetup(project,owner)).origins.some(o=>o.domainId===domain));
  console.log('PASS exact serving proof snapshots, revoke/role changes and current-role authority helper');

  const running=await start(),foreign=await start(foreignProject),lease=randomUUID();
  await withAuditLock({runId:running.run.id,internal:true,claim:true},async({client})=>{await client.query("UPDATE site_audit_run SET status='running',phase='robots',started_at=clock_timestamp(),lease_owner=$2,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1",[running.run.id,lease]);});
  await assert.rejects(withAuditLock({runId:foreign.run.id,internal:true,claim:true},async({client})=>{await client.query("UPDATE site_audit_run SET status='running',phase='robots',started_at=clock_timestamp(),lease_owner=$2,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1",[foreign.run.id,randomUUID()]);}),{code:'23505'});
  const before=(await pool.query('SELECT generation FROM site_audit_run WHERE id=$1',[running.run.id])).rows[0].generation;
  assert.equal((await cancelSiteAudit(project,owner,running.run.id,{})).run.status,'cancelling');
  const cancelled=(await pool.query('SELECT generation,lease_owner FROM site_audit_run WHERE id=$1',[running.run.id])).rows[0];assert.equal(cancelled.generation,String(Number(before)+1));assert.equal(cancelled.lease_owner,lease);
  await cancelSiteAudit(project,owner,running.run.id,{});assert.equal((await pool.query('SELECT generation FROM site_audit_run WHERE id=$1',[running.run.id])).rows[0].generation,cancelled.generation);
  await pool.query("UPDATE site_audit_run SET status='cancelled',phase=NULL,completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND status='cancelling' AND lease_owner=$2",[running.run.id,lease]);await finish(foreign.run.id);
  console.log('PASS cross-workspace active constraint and cancellation generation preserves exact draining owner');

  const history=await start();await finish(history.run.id);
  const h1=await listSiteAudits(project,owner,new URLSearchParams('limit=1'));assert.equal(h1.runs.length,1);assert.ok(h1.nextCursor);
  const h2=await listSiteAudits(project,owner,new URLSearchParams({limit:'1',cursor:h1.nextCursor!}));assert.notEqual(h1.runs[0].id,h2.runs[0].id);
  await assert.rejects(listSiteAudits(foreignProject,owner,new URLSearchParams({cursor:h1.nextCursor!})),{status:400});
  const pages=(await listSiteAuditPages(project,owner,history.run.id,new URLSearchParams())).pages;assert.equal(pages.length,1);const pageId=pages[0].id;
  const otherPage=(await listSiteAuditPages(foreignProject,owner,foreign.run.id,new URLSearchParams())).pages[0].id;
  await assert.rejects(pool.query("INSERT INTO site_audit_edge(id,run_id,source_page_id,kind,target_url) VALUES($1,$2,$3,'link','https://audit.example.com/')",[randomUUID(),history.run.id,otherPage]),{code:'23503'});
  await assert.rejects(pool.query("INSERT INTO site_audit_issue(id,run_id,page_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,$4,'static-html-v1','missing-title','critical','{}')",[randomUUID(),history.run.id,otherPage,'a'.repeat(64)]),{code:'23503'});
  await pool.query("UPDATE site_audit_page SET evidence=' {\"title\":\"Synthetic title\"}'::jsonb,evidence_recorded=true,analysis_coverage='unavailable',reasons='[\"fixture_unobserved\"]' WHERE id=$1",[pageId]);
  const edgeId=randomUUID();await pool.query("INSERT INTO site_audit_edge(id,run_id,source_page_id,kind,target_url,anchor) VALUES($1,$2,$3,'link','https://audit.example.com/','Synthetic anchor')",[edgeId,history.run.id,pageId]);
  const issueId=randomUUID();await pool.query("INSERT INTO site_audit_issue(id,run_id,page_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,$4,'static-html-v1','missing-title','critical','{}')",[issueId,history.run.id,pageId,'b'.repeat(64)]);
  const detail=await getSiteAuditPage(project,viewer,history.run.id,pageId);assert.equal(detail.page.evidence?.title,'Synthetic title');assert.equal(detail.page.analysis.facts,null);
  assert.equal((await listSiteAuditLinks(project,viewer,history.run.id,pageId,new URLSearchParams())).links[0].targetPageId,pageId);
  assert.equal((await listSiteAuditIssues(project,viewer,history.run.id,new URLSearchParams('code=missing-title'))).matchingRetainedCount,1);
  await assert.rejects(getSiteAuditPage(project,owner,history.run.id,otherPage),{status:404});
  await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);assert.equal((await getSiteAuditPage(project,owner,history.run.id,pageId)).page.evidence,null);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);
  const expired=await listSiteAuditPages(project,owner,history.run.id,new URLSearchParams());assert.equal(expired.run.dataStatus,'expired');assert.deepEqual(expired.pages,[]);
  const expiredIssues=await listSiteAuditIssues(project,owner,history.run.id,new URLSearchParams());assert.equal(expiredIssues.matchingRetainedCount,null);assert.deepEqual(expiredIssues.issues,[]);
  await assert.rejects(getSiteAuditPage(project,owner,history.run.id,pageId),{status:410});
  await deleteSiteAudit(project,owner,first.run.id,{});assert.equal((await deleteSiteAudit(project,owner,first.run.id,{})).deleted,true);await assert.rejects(start(project,owner,intent),{status:410});
  assert.ok(!(await listSiteAudits(project,owner,new URLSearchParams())).runs.some(r=>r.id===first.run.id));
  console.log('PASS scoped cursors and composite foreign keys; raw/derived expiry is unavailable, never empty facts; deletion preserves replay tombstone');

  const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email,password})}));assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),endpoint=`${config.appUrl}/api/projects/${project}/audits`;
  assert.equal((await handleApi(new Request(endpoint))).status,401);assert.equal((await handleApi(new Request(endpoint+'/setup',{headers:{cookie}}))).status,200);
  assert.equal((await handleApi(new Request(endpoint+'?limit=1&limit=2',{headers:{cookie}}))).status,400);
  assert.equal((await handleApi(new Request(endpoint,{method:'POST',headers:{cookie,origin:'https://foreign.example.com','content-type':'application/json'},body:JSON.stringify(input())}))).status,403);
  const token=await createApiKey(workspace,owner,{name:'No audit scope',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token.token}}))).status,403);
  assert.equal((await handleApi(new Request(endpoint,{headers:{cookie,authorization:'Bearer '+token.token}}))).status,400);
  const body=input();const httpStart=await handleApi(new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify(body)}));assert.equal(httpStart.status,202);const created=await httpStart.json() as {run:{id:string}};
  assert.equal((await handleApi(new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify(body)}))).status,200);
  // Body consumption happens before the final manage gate; held parsing cannot preserve a removed privilege.
  await cancelSiteAudit(project,owner,created.run.id,{});
  let unblock!:()=>void;const held=new Promise<void>(resolve=>{unblock=resolve;});let reading!:()=>void;const entered=new Promise<void>(resolve=>{reading=resolve;});
  const request=new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:new ReadableStream({async start(controller){reading();await held;controller.enqueue(new TextEncoder().encode(JSON.stringify(input())));controller.close();}}),duplex:'half'} as RequestInit);
  const delayed=handleApi(request);await entered;await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);unblock();assert.equal((await delayed).status,403);
  assert.equal((await getSiteAuditSetup(project,owner)).canStart,false);await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);
  console.log('PASS actual cookie/Origin/bearer/API routes and delayed-body live-role revocation; no website requests');
 }finally{
  try{await pool.query("UPDATE site_audit_run SET status='cancelled',phase=NULL,completed_at=GREATEST(created_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=ANY($1::text[]) AND status IN('queued','running','cancelling')",[[workspace,foreignWorkspace]]);}
  finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
 }
}
if(import.meta.main){try{await runSiteAuditChecks();}finally{await closeDatabase();}}
