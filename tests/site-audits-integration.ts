import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import pg from 'pg';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {addDomain,issueDomainChallenge,verifyDomain,revokeDomain,updateDomain} from '../src/server/domains.ts';
import {siteAuditQueue,getSiteAuditSetup,startSiteAudit,getSiteAudit,listSiteAudits,listSiteAuditPages,exportSiteAuditPages,siteAuditPagesExportMaxBytes,getSiteAuditPage,listSiteAuditIssues,listSiteAuditLinks,cancelSiteAudit,deleteSiteAudit,withAuditLock,auditAuthorityCurrent} from '../src/server/site-audits.ts';
import {auditPageSort} from '../src/lib/site-audit-pages.ts';

export async function runSiteAuditChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');const config=getConfig();
 const db=new URL(config.databaseUrl),ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_site_api';
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_site_api_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);await assertSchema();assert.equal((await getDatabase().pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
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
  assert.equal(persisted.request_hash,createHash('sha256').update(JSON.stringify({version:1,mode:'static',domainId:null,startPath:'/',maxPages:50})).digest('hex'),'Legacy opt-out hash is unchanged, not merely self-consistent.');
  const queued=(await pool.query('SELECT retry_limit,expire_seconds AS seconds,data FROM pgboss.job WHERE id=$1',[persisted.queue_job_id])).rows[0];
  assert.equal(queued.retry_limit,0);assert.equal(queued.seconds,2100);assert.deepEqual(queued.data,{runId:first.run.id});
  assert.equal((await pool.query('SELECT 1 FROM site_audit_page WHERE run_id=$1',[first.run.id])).rowCount,2);
  assert.ok(!JSON.stringify(first).includes(persisted.request_hash));assert.ok(!JSON.stringify(first).includes(persisted.queue_job_id));
  await assert.rejects(start(project,owner,{...intent,maxPages:51}),{status:409});await assert.rejects(start(),{status:409});await assert.rejects(getSiteAudit(foreignProject,owner,first.run.id),{status:404});
  await assert.rejects(deleteSiteAudit(project,owner,first.run.id,{}),{status:409});
  assert.equal(first.run.config.retainBodyText,false);
  await pool.query("UPDATE site_audit_run SET config=config-'retainBodyText' WHERE id=$1",[first.run.id]);
  assert.equal((await startSiteAudit(project,owner,{...intent,retainBodyText:false})).run.id,first.run.id,'Explicit false must replay the legacy hash.');
  assert.equal((await startSiteAudit(project,owner,intent)).run.config.retainBodyText,false);
  await assert.rejects(startSiteAudit(project,owner,{...intent,retainBodyText:true}),{status:409});
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

  const opted=await startSiteAudit(project,owner,{...input(),retainBodyText:true});
  const pending=(await listSiteAuditPages(project,viewer,opted.run.id,new URLSearchParams())).pages[0];
  assert.deepEqual(pending.bodyEvidence,{status:'pending',version:null,utf8Bytes:null,textIncluded:false,text:null});
  await finish(opted.run.id);
  assert.deepEqual((await getSiteAuditPage(project,viewer,opted.run.id,pending.id)).page.bodyEvidence,{status:'unavailable',version:null,utf8Bytes:null,textIncluded:false,text:null});
  await assert.rejects(pool.query("UPDATE site_audit_page SET body_capture_state='available',body_extraction_version='static-dom-body-v1',body_text='not analyzed' WHERE id=$1",[pending.id]),{code:'23514'});
  for(const [state,text] of [['available','A 🐎 body'],['empty',''],['unavailable',null],['over_limit',null]] as const){
   await pool.query("UPDATE site_audit_page SET state='done',observed_at=clock_timestamp(),analysis_coverage='analyzed',body_capture_state=$2,body_extraction_version='static-dom-body-v1',body_text=$3 WHERE id=$1",[pending.id,state,text]);
   const list=(await listSiteAuditPages(project,viewer,opted.run.id,new URLSearchParams())).pages[0].bodyEvidence;
   assert.deepEqual(list,{status:state,version:'static-dom-body-v1',utf8Bytes:text===null?null:Buffer.byteLength(text),textIncluded:false,text:null});
   const detail=(await getSiteAuditPage(project,viewer,opted.run.id,pending.id)).page.bodyEvidence;
   assert.deepEqual(detail,{...list,textIncluded:text!==null,text});
  }
  await pool.query("UPDATE site_audit_page SET body_capture_state='available',body_text=NULL WHERE id=$1",[pending.id]);
  assert.equal((await getSiteAuditPage(project,viewer,opted.run.id,pending.id)).page.bodyEvidence.status,'unavailable');
  await assert.rejects(getSiteAuditPage(foreignProject,owner,opted.run.id,pending.id),{status:404});
  for(const values of [['available',null,'x'],['available','static-dom-body-v1','x'.repeat(65537)],['empty','static-dom-body-v1','nonempty'],['unavailable','static-dom-body-v1','secret'],['not_recorded','static-dom-body-v1',null]])await assert.rejects(pool.query('UPDATE site_audit_page SET body_capture_state=$2,body_extraction_version=$3,body_text=$4 WHERE id=$1',[pending.id,...values]),{code:'23514'});
  console.log('PASS body opt-in is immutable and legacy compatible; member list/detail bytes, empty/unavailable, tenant and schema bounds');
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
  const grouped=await start(),groupPage=(await listSiteAuditPages(project,viewer,grouped.run.id,new URLSearchParams())).pages[0],targetOne=randomUUID(),targetTwo=randomUUID();
  const emptyPending=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams());assert.deepEqual(emptyPending.groups,[]);assert.equal(emptyPending.matchingRetainedCount,null);
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) VALUES($1,$3,$4,'html','https://audit.example.com/target-one'),($2,$3,$4,'html','https://audit.example.com/target-two')",[targetOne,targetTwo,grouped.run.id,project]);
  const recordId=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const records:{id:string;page:string|null;target:string|null;code:string;severity:string;related:string[];details:Record<string,number>}[]=Array.from({length:52},(_,n)=>({id:recordId(n+1),page:groupPage.id,target:null,code:'missing-title',severity:'critical',related:[],details:{titleLength:0}}));
  records.push(
   {id:recordId(53),page:groupPage.id,target:targetOne,code:'broken-internal-link',severity:'critical',related:[otherPage],details:{httpStatus:404}},
   {id:recordId(54),page:groupPage.id,target:targetTwo,code:'broken-internal-link',severity:'critical',related:[targetOne],details:{httpStatus:404}},
   {id:recordId(55),page:null,target:null,code:'broken-internal-link',severity:'critical',related:[],details:{httpStatus:404}},
   {id:recordId(56),page:groupPage.id,target:targetOne,code:'broken-internal-link',severity:'warning',related:[],details:{httpStatus:404}});
  for(const record of records)await pool.query(`INSERT INTO site_audit_issue(id,run_id,page_id,target_page_id,issue_key,rule_version,code,severity,related_page_ids,details)
   VALUES($1,$2,$3,$4,$5,'static-graph-v1',$6,$7,$8,$9)`,[record.id,grouped.run.id,record.page,record.target,createHash('sha256').update(record.id).digest('hex'),record.code,record.severity,JSON.stringify(record.related),record.details]);
  await assert.rejects(pool.query("INSERT INTO site_audit_issue(id,run_id,page_id,target_page_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,$4,$5,'static-graph-v1','broken-internal-link','critical','{}')",[randomUUID(),grouped.run.id,groupPage.id,otherPage,'c'.repeat(64)]),{code:'23503'});
  for(const state of ['queued','running','cancelling']){
   if(state==='running')await withAuditLock({runId:grouped.run.id,internal:true,claim:true},async({client})=>{await client.query("UPDATE site_audit_run SET status='running',phase='robots',started_at=clock_timestamp(),lease_owner=$2,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1",[grouped.run.id,randomUUID()]);});
   if(state==='cancelling')await cancelSiteAudit(project,owner,grouped.run.id,{});
   const pendingGroups=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams());assert.equal(pendingGroups.run.status,state);assert.equal(pendingGroups.role,'viewer');assert.equal(pendingGroups.matchingRetainedCount,null);
   assert.equal(pendingGroups.groups?.length,3);assert.ok(pendingGroups.groups?.every(g=>g.retainedFindingCount===null&&g.affectedUrlCount===null&&g.unassignedFindingCount===null));assert.equal(pendingGroups.run.canCancel,false);
  }
  await finish(grouped.run.id);
  const expectedGroups=[
   {code:'broken-internal-link',severity:'critical',retainedFindingCount:3,affectedUrlCount:1,unassignedFindingCount:1},
   {code:'broken-internal-link',severity:'warning',retainedFindingCount:1,affectedUrlCount:1,unassignedFindingCount:0},
   {code:'missing-title',severity:'critical',retainedFindingCount:52,affectedUrlCount:1,unassignedFindingCount:0}];
  const overview=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams());assert.equal(overview.issues.length,50);assert.ok(overview.issues.every(i=>i.code==='missing-title'));assert.ok(overview.nextCursor);assert.equal(overview.matchingRetainedCount,56);assert.equal(overview.countBasis,'retained');assert.equal(overview.findingsComplete,false);assert.equal(overview.run.summary,null);assert.deepEqual(overview.groups,expectedGroups);
  const remaining=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({cursor:overview.nextCursor!}));assert.equal(remaining.issues.length,6);assert.equal(remaining.nextCursor,null);assert.deepEqual(remaining.groups,overview.groups);assert.equal(remaining.matchingRetainedCount,56);assert.equal(new Set([...overview.issues,...remaining.issues].map(i=>i.id)).size,56);
  assert.deepEqual(remaining.issues.find(i=>i.id===recordId(55)),{id:recordId(55),pageId:null,pageUrl:null,targetPageId:null,targetPageUrl:null,relatedPageIds:[],code:'broken-internal-link',severity:'critical',ruleVersion:'static-graph-v1',details:{httpStatus:404}});
  for(const [id,target,url] of [[recordId(53),targetOne,'https://audit.example.com/target-one'],[recordId(54),targetTwo,'https://audit.example.com/target-two']]){
   const issue:typeof remaining.issues[number]=remaining.issues.find(i=>i.id===id)!;assert.equal(issue.pageId,groupPage.id);assert.equal(issue.pageUrl,groupPage.url);assert.equal(issue.targetPageId,target);assert.equal(issue.targetPageUrl,url);assert.deepEqual(issue.details,{httpStatus:404});
  }
  assert.deepEqual(remaining.issues.find(i=>i.id===recordId(53))?.relatedPageIds,[otherPage]);assert.ok(!JSON.stringify(remaining).includes(foreign.run.id));
  const narrowed={code:'broken-internal-link',severity:'critical',pageId:groupPage.id,limit:'1'};
  const narrowFirst=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams(narrowed));assert.equal(narrowFirst.issues.length,1);assert.equal(narrowFirst.matchingRetainedCount,2);assert.deepEqual(narrowFirst.groups,[{...expectedGroups[0],retainedFindingCount:2,unassignedFindingCount:0}]);assert.ok(narrowFirst.nextCursor);
  const narrowSecond=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({...narrowed,cursor:narrowFirst.nextCursor!}));assert.equal(narrowSecond.issues.length,1);assert.notEqual(narrowFirst.issues[0].id,narrowSecond.issues[0].id);assert.equal(narrowSecond.nextCursor,null);assert.deepEqual(narrowSecond.groups,narrowFirst.groups);
  assert.deepEqual((await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams('code=broken-internal-link'))).groups,expectedGroups.slice(0,2));
  assert.deepEqual((await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams('severity=critical'))).groups,[expectedGroups[0],expectedGroups[2]]);
  const pageScoped=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({pageId:groupPage.id}));assert.equal(pageScoped.matchingRetainedCount,55);assert.deepEqual(pageScoped.groups,[{...expectedGroups[0],retainedFindingCount:2,unassignedFindingCount:0},expectedGroups[1],expectedGroups[2]]);
  const absent=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams('code=orphan-page'));assert.deepEqual(absent.groups,[]);assert.deepEqual(absent.issues,[]);assert.equal(absent.matchingRetainedCount,0);assert.equal(absent.nextCursor,null);
  for(const change of [{severity:'warning'},{pageId:targetOne},{code:'missing-title'}])await assert.rejects(listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({...narrowed,...change,cursor:narrowFirst.nextCursor!})),{status:400});
  for(const raw of ['code=missing-title&code=broken-page','severity=critical&severity=warning','pageId=bad','search=title','sort=code','code=unknown-rule','cursor=not-a-valid-cursor'])await assert.rejects(listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams(raw)),{status:400});
  await assert.rejects(listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({pageId:otherPage})),{status:404});await assert.rejects(listSiteAuditIssues(foreignProject,owner,grouped.run.id,new URLSearchParams()),{status:404});await assert.rejects(listSiteAuditIssues(project,stranger,grouped.run.id,new URLSearchParams()),{status:404});
  await assert.rejects(listSiteAuditIssues(project,viewer,history.run.id,new URLSearchParams({cursor:overview.nextCursor!})),{status:400});
  for(const state of ['partial','failed','cancelled']){await pool.query('UPDATE site_audit_run SET status=$2 WHERE id=$1',[grouped.run.id,state]);const terminal=await listSiteAuditIssues(project,admin,grouped.run.id,new URLSearchParams());assert.equal(terminal.role,'admin');assert.equal(terminal.matchingRetainedCount,56);assert.deepEqual(terminal.groups,expectedGroups);}
  await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[grouped.run.id]);
  const rawGroups=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams(narrowed));assert.equal(rawGroups.run.rawEvidenceStatus,'expired');assert.deepEqual(rawGroups.groups,narrowFirst.groups);assert.deepEqual(rawGroups.issues,narrowFirst.issues);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[grouped.run.id]);
  const expiredGroups=await listSiteAuditIssues(project,viewer,grouped.run.id,new URLSearchParams({...narrowed,cursor:narrowFirst.nextCursor!}));assert.equal(expiredGroups.run.dataStatus,'expired');assert.equal(expiredGroups.groups,null);assert.deepEqual(expiredGroups.issues,[]);assert.equal(expiredGroups.nextCursor,null);assert.equal(expiredGroups.matchingRetainedCount,null);
  console.log('PASS complete retained issue groups beyond the first page, distinct primary URLs, target joins, pending/terminal counts, strict scoped paging and expiry');
  await assert.rejects(getSiteAuditPage(project,owner,history.run.id,otherPage),{status:404});
  await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);assert.equal((await getSiteAuditPage(project,owner,history.run.id,pageId)).page.evidence,null);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);
  const expired=await listSiteAuditPages(project,owner,history.run.id,new URLSearchParams());assert.equal(expired.run.dataStatus,'expired');assert.deepEqual(expired.pages,[]);
  const expiredIssues=await listSiteAuditIssues(project,owner,history.run.id,new URLSearchParams());assert.equal(expiredIssues.matchingRetainedCount,null);assert.deepEqual(expiredIssues.issues,[]);assert.equal(expiredIssues.groups,null);assert.equal(expiredIssues.nextCursor,null);
  await assert.rejects(getSiteAuditPage(project,owner,history.run.id,pageId),{status:410});
  await deleteSiteAudit(project,owner,first.run.id,{});assert.equal((await deleteSiteAudit(project,owner,first.run.id,{})).deleted,true);await assert.rejects(start(project,owner,intent),{status:410});
  assert.ok(!(await listSiteAudits(project,owner,new URLSearchParams())).runs.some(r=>r.id===first.run.id));
  console.log('PASS scoped cursors and composite foreign keys; raw/derived expiry is unavailable, never empty facts; deletion preserves replay tombstone');

  {
  const searchable=await start(),searchRun=searchable.run.id;await finish(searchRun);
  const basePage=(await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams())).pages[0].id;
  const facts=(n:number)=>({titleLength:7,titleHash:null,descriptionLength:7,descriptionHash:null,headingCounts:[n%4,0,0,0,0,0],headingOrder:[],wordCount:n%5,contentHash:null,imagesTotal:n%6,imagesMissingAlt:n%3,linksTotal:0,internalLinks:0,externalLinks:0,unresolvedLinks:0,structuredDataPresent:false,hreflangCount:0,indexability:'unknown',canonical:'none',invalidCanonicals:0});
  const records=Array.from({length:125},(_,n)=>({id:randomUUID(),url:`https://audit.example.com/page-${String(n).padStart(3,'0')}`,http_status:n%9===0?null:200+n%3,response_time_ms:n%11===0?null:n%7,facts:n%10===0?null:facts(n),evidence:n===0?{title:'100%_\\ Éléphant 🐎',description:'Private searchable meta'}:n===1?{title:'',description:''}:n===2?null:n===3?{description:'Missing title field'}:n===4?{title:'🐎'.repeat(600),description:'Long title'}:n===5?{title:'🐎'.repeat(512),description:'Exact title bound'}:{title:`Title ${n%4}`,description:`Meta ${n%3}`},recorded:n!==2,truncated:n===6}));
  for(const record of records)if(record.facts){record.facts.titleLength=record.evidence?.title?.length??0;record.facts.descriptionLength=record.evidence?.description.length??0;}
  await pool.query(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,state,observed_at,http_status,response_time_ms,analysis_coverage,facts,evidence,evidence_recorded,evidence_truncated)
   SELECT x.id,$1,$2,'html',x.url,'done',clock_timestamp(),x.http_status,x.response_time_ms,'analyzed',x.facts,x.evidence,x.recorded,x.truncated
   FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,url text,http_status integer,response_time_ms integer,facts jsonb,evidence jsonb,recorded boolean,truncated boolean)`,[searchRun,project,JSON.stringify(records)]);
  const firstPages=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams());
  assert.equal(firstPages.pages.length,50);assert.equal(firstPages.matchingRetainedCount,126);assert.equal(firstPages.countBasis,'retained');assert.match(firstPages.selectionRevision!,/^[a-f0-9]{64}$/);assert.ok(Number.isFinite(Date.parse(firstPages.asOf)));assert.equal(firstPages.pages[0].id,basePage,'The explicit new default is URL ascending, not UUID ascending.');
  const secondPages=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({cursor:firstPages.nextCursor!}));
  const thirdPages=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({cursor:secondPages.nextCursor!}));
  assert.equal(secondPages.pages.length,50);assert.equal(thirdPages.pages.length,26);assert.equal(thirdPages.nextCursor,null);assert.equal(new Set([...firstPages.pages,...secondPages.pages,...thirdPages.pages].map(p=>p.id)).size,126);
  assert.equal(secondPages.selectionRevision,firstPages.selectionRevision);assert.equal(thirdPages.selectionRevision,firstPages.selectionRevision);
  const all=[...firstPages.pages,...secondPages.pages,...thirdPages.pages];
  const exportInput=(fields:Record<string,string>,revision:string)=>({coverage:null,resourceKind:'html',search:'',searchIn:'url_title_meta',sort:'url',order:'asc',...fields,expectedSelectionRevision:revision});
  function csvRecords(text:string){const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;for(let n=0;n<text.length;n++){const c=text[n];if(c==='"'){if(quoted&&text[n+1]==='"'){cell+='"';n++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\r'&&text[n+1]==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';n++;}else cell+=c;}assert.equal(quoted,false);assert.equal(cell,'');assert.deepEqual(row,[]);return rows;}
  async function downloaded(fields:Record<string,string>={},revision?:string){const list=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams(fields)),response=await exportSiteAuditPages(project,viewer,searchRun,exportInput(fields,revision??list.selectionRevision!));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/csv; charset=utf-8');assert.equal(response.headers.get('cache-control'),'no-store, no-transform');assert.equal(response.headers.get('content-disposition'),'attachment; filename="audit-pages.csv"');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-export-revision'),list.selectionRevision);assert.ok(Number.isFinite(Date.parse(response.headers.get('x-export-as-of')!)));const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.length,Number(response.headers.get('content-length')));assert.ok(bytes.length<=siteAuditPagesExportMaxBytes);const csv=csvRecords(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),columns=csv[0],metadata=Object.fromEntries(columns.map((key,n)=>[key,csv[1][n]])),pages=csv.slice(2).map(row=>{assert.equal(row.length,columns.length);return Object.fromEntries(columns.map((key,n)=>[key,row[n]]));});assert.equal(pages.length,list.matchingRetainedCount);assert.equal(pages.length,Number(response.headers.get('x-export-row-count')));assert.equal(metadata.version,'audit-pages-v1');assert.equal(metadata.projectId,project);assert.equal(metadata.runId,searchRun);assert.equal(metadata.ruleVersion,'static-html-v1');assert.equal(metadata.selectionRevision,list.selectionRevision);assert.equal(metadata.matchingRetainedCount,String(pages.length));assert.deepEqual(JSON.parse(metadata.appliedQuery),Object.fromEntries(Object.entries(exportInput(fields,list.selectionRevision!)).filter(([key])=>key!=='expectedSelectionRevision')));return {pages,metadata,text:new TextDecoder().decode(bytes)};}
  const scalar=(p:typeof all[number],sort:typeof auditPageSort[number])=>sort==='url'?p.url:sort==='title'?p.titlePreview.text:sort==='httpStatus'?p.httpStatus:sort==='h1'?p.analysis.facts?.headingCounts[0]??null:sort==='wordCount'?p.analysis.facts?.wordCount??null:sort==='images'?p.analysis.facts?.imagesMissingAlt??null:p.responseTimeMs;
  const compare=(a:string|number|null,b:string|number|null,direction:number)=>a===null?(b===null?0:1):b===null?-1:(typeof a==='string'&&typeof b==='string'?Buffer.compare(Buffer.from(a),Buffer.from(b)):Number(a)-Number(b))*direction;
  for(const sort of auditPageSort)for(const order of ['asc','desc'] as const){
   const scope={sort,order,limit:'100'},one=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams(scope)),two=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({...scope,cursor:one.nextCursor!}));
   // Long titles differ only beyond the preview: use the fixture's readable raw title for this ordering oracle.
   const title=(p:typeof all[number])=>records.find(r=>r.id===p.id)?.evidence?.title??null;
   const expected=[...all].sort((a,b)=>compare(sort==='title'?title(a):scalar(a,sort),sort==='title'?title(b):scalar(b,sort),order==='asc'?1:-1)||(sort==='images'?compare(a.analysis.facts?.imagesTotal??null,b.analysis.facts?.imagesTotal??null,order==='asc'?1:-1):0)||(a.id<b.id?-1:a.id>b.id?1:0));
   assert.deepEqual([...one.pages,...two.pages].map(p=>p.id),expected.map(p=>p.id),`${sort} ${order}: exact numeric/text/tie order with null last and zero retained`);assert.equal(two.nextCursor,null);
   const csv=await downloaded({sort,order});assert.deepEqual(csv.pages.map(p=>p.pageId),expected.map(p=>p.id),`Export ${sort} ${order} covers the whole matching selection beyond the first 50 rows.`);
  }
  const csv=await downloaded();assert.equal(csv.pages.length,126);const exported=new Map(csv.pages.map(p=>[p.pageId,p]));assert.equal(exported.get(records[1].id)!.titlePreview,'');assert.equal(exported.get(records[1].id)!.titlePreviewStatus,'empty');assert.equal(exported.get(records[2].id)!.titlePreview,'Unavailable');assert.equal(exported.get(records[2].id)!.titlePreviewStatus,'not_recorded');assert.equal(exported.get(records[3].id)!.titlePreviewStatus,'unavailable');assert.equal(Array.from(exported.get(records[4].id)!.titlePreview).length,512);assert.equal(exported.get(records[4].id)!.titlePreviewStatus,'truncated');assert.equal(exported.get(records[5].id)!.titlePreviewStatus,'available');assert.equal(exported.get(records[10].id)!.h1,'Unavailable');assert.equal(exported.get(records[12].id)!.h1,'0');assert.ok(!csv.text.includes('Private searchable meta'));assert.ok(!csv.text.includes('body_text'));assert.ok(!csv.text.includes('titleHash'));
  for(const search of ['100%_\\','éléphant','🐎','Private searchable meta','page-000 100%_\\']){const rows=await downloaded({search});assert.ok(rows.pages.some(p=>p.pageId===records[0].id));}
  for(const fields of [{search:'100%X\\'},{search:'Private searchable meta',searchIn:'url'},{search:'page-',coverage:'blocked'}] as Record<string,string>[])assert.equal((await downloaded(fields)).pages.length,0);
  assert.equal((await downloaded({resourceKind:'robots'})).pages.length,1);
  const kept=await exportSiteAuditPages(project,viewer,searchRun,exportInput({},firstPages.selectionRevision!));await assert.rejects(exportSiteAuditPages(project,viewer,searchRun,exportInput({},firstPages.selectionRevision!)),{status:503});await kept.body!.cancel();assert.equal((await downloaded()).pages.length,126);
  const abort=new AbortController(),aborted=await exportSiteAuditPages(project,viewer,searchRun,exportInput({},firstPages.selectionRevision!),abort.signal);abort.abort();await assert.rejects(aborted.arrayBuffer());assert.equal((await downloaded()).pages.length,126);
  await assert.rejects(exportSiteAuditPages(project,stranger,searchRun,exportInput({},firstPages.selectionRevision!)),{status:404});await assert.rejects(exportSiteAuditPages(foreignProject,owner,searchRun,exportInput({},firstPages.selectionRevision!)),{status:404});await assert.rejects(exportSiteAuditPages(project,viewer,searchRun,exportInput({search:'changed'},firstPages.selectionRevision!)),{status:409});await assert.rejects(exportSiteAuditPages(project,viewer,first.run.id,exportInput({},firstPages.selectionRevision!)),{status:404});
  const formula=' \uFEFF=HYPERLINK("https://example.test","x")\r\nquoted,🦄';await pool.query("UPDATE site_audit_page SET evidence=jsonb_set(evidence,'{title}',to_jsonb($2::text)) WHERE id=$1",[records[0].id,formula]);const safeCsv=await downloaded();assert.equal(safeCsv.pages.find(p=>p.pageId===records[0].id)!.titlePreview,"'"+formula);await pool.query("UPDATE site_audit_page SET evidence=$2 WHERE id=$1",[records[0].id,records[0].evidence]);
  const boundaryTitle=' =SUM("é🐎",1)\r\n'+'🐎'.repeat(490),boundaryRecords=records.slice(0,33);
  await pool.query("UPDATE site_audit_page SET evidence=jsonb_set(coalesce(evidence,'{}'::jsonb),'{title}',to_jsonb($2::text)) WHERE id=ANY($1::uuid[])",[boundaryRecords.filter(row=>row.recorded).map(row=>row.id),boundaryTitle]);
  try{
   const expected=await downloaded({search:'page-0'});assert.ok(Buffer.byteLength(expected.text)>64*1024&&Buffer.byteLength(expected.text)<512*1024);
   for(const record of boundaryRecords.filter(row=>row.recorded))assert.equal(expected.pages.find(row=>row.pageId===record.id)!.titlePreview,"'"+boundaryTitle);
   const selected=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'page-0'})),response=await exportSiteAuditPages(project,viewer,searchRun,exportInput({search:'page-0'},selected.selectionRevision!));
   const decoder=new TextDecoder('utf-8',{fatal:true}),digest=createHash('sha256'),reader=response.body!.getReader();let text='',size=0,chunks=0,splitUnicode=false;
   for(;;){const next=await reader.read();if(next.done)break;const bytes=next.value;size+=bytes.length;chunks++;assert.ok(bytes.length>0&&bytes.length<=64*1024);assert.equal(bytes.buffer.byteLength,bytes.length);digest.update(bytes);const horse=Buffer.from(bytes).indexOf(Buffer.from('🐎'));if(horse>=0){text+=decoder.decode(bytes.subarray(0,horse+1),{stream:true});text+=decoder.decode(bytes.subarray(horse+1),{stream:true});splitUnicode=true;}else text+=decoder.decode(bytes,{stream:true});}
   text+=decoder.decode();const expectedText=expected.text.replace(expected.metadata.asOf,response.headers.get('x-export-as-of')!);
   assert.ok(chunks>=2&&splitUnicode);assert.equal(size,Number(response.headers.get('content-length')));assert.equal(digest.digest('hex'),createHash('sha256').update(expectedText).digest('hex'));assert.equal(text,expectedText);assert.deepEqual(csvRecords(text),csvRecords(expectedText));
  }finally{await pool.query('UPDATE site_audit_page p SET evidence=x.evidence FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,evidence jsonb) WHERE p.id=x.id',[JSON.stringify(boundaryRecords.map(({id,evidence})=>({id,evidence})))]);}
  console.log('PASS exact CSV bytes across owned 64 KiB chunks, quoted CRLF/formula titles and split four-byte UTF-8 decoding');
  console.log('PASS complete Pages CSV selection/order/search/metadata, Unicode title states, zero versus unknown, formula quoting, Viewer scope and body lease/cancel/abort');
  for(const search of ['100%_\\','éléphant','🐎','Private searchable meta']){const found=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search}));assert.ok(found.pages.some(p=>p.id===records[0].id));}
  assert.equal((await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'100%X\\'}))).matchingRetainedCount,0,'Percent and underscore are literal, not SQL wildcard syntax.');
  assert.equal((await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'Private searchable meta',searchIn:'url'}))).matchingRetainedCount,0);
  assert.equal((await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'page-000 100%_\\'}))).pages[0].id,records[0].id,'The joined substring may cross the URL/title boundary.');
  assert.equal((await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'page-',coverage:'blocked'}))).matchingRetainedCount,0);
  assert.equal((await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({resourceKind:'robots'}))).matchingRetainedCount,1);
  const byId=new Map(all.map(p=>[p.id,p]));
  assert.deepEqual(byId.get(records[1].id)!.titlePreview,{status:'empty',text:''});assert.deepEqual(byId.get(records[2].id)!.titlePreview,{status:'not_recorded',text:null});assert.deepEqual(byId.get(records[3].id)!.titlePreview,{status:'unavailable',text:null});
  const clipped=byId.get(records[4].id)!.titlePreview;assert.equal(clipped.status,'truncated');assert.equal(Array.from(clipped.text!).length,512);assert.equal(Buffer.byteLength(clipped.text!),2048);
  assert.equal(byId.get(records[5].id)!.titlePreview.status,'available');assert.equal(byId.get(records[6].id)!.titlePreview.status,'available');assert.equal(byId.get(records[6].id)!.rawEvidenceStatus,'truncated','Other-field evidence truncation does not misclassify the readable title.');assert.equal(byId.get(basePage)!.titlePreview.status,'not_recorded');
  for(const p of all){assert.equal(p.evidence,null);assert.equal(p.evidenceIncluded,false);assert.equal(p.bodyEvidence.text,null);assert.ok(!JSON.stringify(p).includes('Private searchable meta'));}
  await assert.rejects(listSiteAuditPages(project,stranger,searchRun,new URLSearchParams()),{status:404});await assert.rejects(listSiteAuditPages(foreignProject,owner,searchRun,new URLSearchParams()),{status:404});
  const changedScopes:Record<string,string>[]=[{search:'Title'},{searchIn:'url'},{sort:'httpStatus'},{order:'desc'},{coverage:'analyzed'},{resourceKind:'robots'}];
  for(const change of changedScopes)await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({...change,cursor:firstPages.nextCursor!})),{status:400});
  await assert.rejects(listSiteAuditPages(foreignProject,owner,foreign.run.id,new URLSearchParams({cursor:firstPages.nextCursor!})),{status:400});
  const cursorValue=JSON.parse(Buffer.from(firstPages.nextCursor!,'base64url').toString('utf8'));
  for(const change of [{v:1},{afterId:randomUUID()},{extra:true}])await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({cursor:Buffer.from(JSON.stringify({...cursorValue,...change})).toString('base64url')})),{status:400});
  const numericFirst=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({sort:'wordCount',limit:'1'}));await pool.query("UPDATE site_audit_page SET facts=jsonb_set(facts,'{wordCount}','999'::jsonb) WHERE id=$1",[numericFirst.pages[0].id]);
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({sort:'wordCount',limit:'1',cursor:numericFirst.nextCursor!})),{status:409});
  console.log('PASS retained Pages >125 pagination, all seven sorts/directions, null/zero/ties, literal Unicode search, preview states, scope and revision refusal');

  // The physical raw evidence deliberately remains. A dependent read must latch expiry before its recoverable error.
  const retentionCursor=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({searchIn:'url',limit:'1'}));assert.ok(retentionCursor.nextCursor);
  await pool.query("WITH age AS (SELECT clock_timestamp()-interval '91 days' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1",[searchRun]);
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({searchIn:'url',limit:'1',cursor:retentionCursor.nextCursor!})),{status:409});
  const latchedRaw=(await pool.query('SELECT raw_expired_at FROM site_audit_run WHERE id=$1',[searchRun])).rows[0].raw_expired_at as Date;assert.ok(latchedRaw);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[workspace]);
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({sort:'title'})),{status:409});
  assert.equal((await pool.query('SELECT raw_expired_at FROM site_audit_run WHERE id=$1',[searchRun])).rows[0].raw_expired_at.toISOString(),latchedRaw.toISOString(),'A recoverable stale-cursor read commits expiry; later policy extension cannot resurrect it.');
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=90 WHERE id=$1',[workspace]);
  assert.equal((await pool.query("SELECT evidence->>'title' AS title FROM site_audit_page WHERE id=$1",[records[0].id])).rows[0].title,'100%_\\ Éléphant 🐎');
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'Private searchable meta'})),{status:409});
  const rawExpired=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({search:'page-',searchIn:'url',sort:'images',limit:'100'}));
  assert.equal(rawExpired.matchingRetainedCount,125);for(const p of rawExpired.pages){assert.equal(p.titlePreview.text,null);assert.equal(p.titlePreview.status,p.id===records[2].id?'not_recorded':'expired');assert.equal(p.evidence,null);assert.ok(!JSON.stringify(p).includes('Private searchable meta'));}
  await assert.rejects(exportSiteAuditPages(project,viewer,searchRun,exportInput({sort:'title'},rawExpired.selectionRevision!)),{status:409});await assert.rejects(exportSiteAuditPages(project,viewer,searchRun,exportInput({search:'Private searchable meta'},rawExpired.selectionRevision!)),{status:409});
  const retainedCsv=await downloaded({search:'page-',searchIn:'url',sort:'images'});assert.equal(retainedCsv.pages.length,125);assert.ok(retainedCsv.pages.every(p=>p.titlePreview==='Unavailable'&&(p.titlePreviewStatus==='expired'||p.titlePreviewStatus==='not_recorded')));assert.ok(!retainedCsv.text.includes('Private searchable meta'));
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({cursor:firstPages.nextCursor!})),{status:409});
  await pool.query("WITH age AS (SELECT clock_timestamp()-interval '366 days' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1",[searchRun]);
  const pagesExpired=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({sort:'title',search:'private'}));assert.equal(pagesExpired.run.dataStatus,'expired');assert.deepEqual(pagesExpired.pages,[]);assert.equal(pagesExpired.nextCursor,null);assert.equal(pagesExpired.selectionRevision,null);assert.equal(pagesExpired.matchingRetainedCount,null);
  assert.ok((await pool.query('SELECT data_expired_at FROM site_audit_run WHERE id=$1',[searchRun])).rows[0].data_expired_at);assert.ok((await pool.query('SELECT evidence FROM site_audit_page WHERE id=$1',[records[0].id])).rows[0].evidence);
  await assert.rejects(exportSiteAuditPages(project,viewer,searchRun,exportInput({},firstPages.selectionRevision!)),{status:410});
  console.log('PASS raw-dependent expiry commits its latch, physical evidence stays hidden, numeric/URL selection survives, derived expiry short-circuits');

  const changing=await start(),changingRun=changing.run.id;
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) SELECT gen_random_uuid(),$1,$2,'html','https://audit.example.com/active-'||n FROM generate_series(1,125) n",[changingRun,project]);
  const activePages=await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams());assert.equal(activePages.matchingRetainedCount,null);assert.ok(activePages.nextCursor);
  await assert.rejects(exportSiteAuditPages(project,viewer,changingRun,exportInput({},activePages.selectionRevision!)),{status:409});
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) VALUES($1,$2,$3,'html','https://audit.example.com/new-active')",[randomUUID(),changingRun,project]);
  await assert.rejects(listSiteAuditPages(project,viewer,changingRun,new URLSearchParams({cursor:activePages.nextCursor!})),{status:409});
  const beforeFinish=await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams());await finish(changingRun);
  await assert.rejects(listSiteAuditPages(project,viewer,changingRun,new URLSearchParams({cursor:beforeFinish.nextCursor!})),{status:409});assert.equal((await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams())).matchingRetainedCount,127);
  const oversized=await start();await finish(oversized.run.id);await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) SELECT gen_random_uuid(),$1,$2,'html','https://audit.example.com/over-'||n FROM generate_series(1,10000) n",[oversized.run.id,project]);
  await assert.rejects(listSiteAuditPages(project,viewer,oversized.run.id,new URLSearchParams()),{status:409});
  await assert.rejects(exportSiteAuditPages(project,viewer,oversized.run.id,exportInput({},'a'.repeat(64))),{status:409});
  console.log('PASS active membership/status revisions and over-10,000 population refusal without truncated success');

  const large=await start();await finish(large.run.id);const prefix='https://audit.example.com/large-';
  await pool.query(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,state,fetch_state,analysis_coverage,evidence_recorded,evidence)
   SELECT gen_random_uuid(),$1,$2,'html',$3::text||lpad(n::text,5,'0')||repeat('a',2048-octet_length($3::text)-5),'done','ok','partial',true,jsonb_build_object('title',$4::text,'description','PRIVATE_DESCRIPTION_SENTINEL') FROM generate_series(1,9999) n`,[large.run.id,project,prefix,'🐎'.repeat(512)]);
  const largeList=await listSiteAuditPages(project,viewer,large.run.id,new URLSearchParams());assert.equal(largeList.pages.length,50);assert.equal(largeList.matchingRetainedCount,10000);
  const queries:string[]=[],nativeQuery=pg.Client.prototype.query;let sampledRss=process.memoryUsage().rss;
  pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){if(typeof args[0]==='string'){queries.push(args[0]);sampledRss=Math.max(sampledRss,process.memoryUsage().rss);}return (nativeQuery as (...values:unknown[])=>unknown).apply(this,args);} as typeof nativeQuery;
  try{
   const response=await exportSiteAuditPages(project,viewer,large.run.id,exportInput({},largeList.selectionRevision!));sampledRss=Math.max(sampledRss,process.memoryUsage().rss);const length=Number(response.headers.get('content-length'));assert.ok(length>40*1024*1024&&length<=siteAuditPagesExportMaxBytes);assert.equal(response.headers.get('x-export-row-count'),'10000');
   const reader=response.body!.getReader(),firstChunk=await reader.read();assert.equal(firstChunk.value!.length,64*1024);assert.equal(firstChunk.value!.buffer.byteLength,64*1024,'The chunk cannot retain the completed 40+ MiB backing buffer.');await assert.rejects(exportSiteAuditPages(project,viewer,large.run.id,exportInput({},largeList.selectionRevision!)),{status:503});await reader.cancel();
   const afterCancel=await exportSiteAuditPages(project,viewer,large.run.id,exportInput({},largeList.selectionRevision!));let received=0;const stream=afterCancel.body!.getReader();for(;;){const chunk=await stream.read();if(chunk.done)break;received+=chunk.value.length;sampledRss=Math.max(sampledRss,process.memoryUsage().rss);}assert.equal(received,length);const peakRss=process.resourceUsage().maxRSS*1024;assert.ok(peakRss>0&&peakRss<512*1024*1024,`Measured OS peak process RSS ${peakRss} must stay below 512 MiB for this fixture.`);assert.ok(sampledRss<=peakRss);
   const projection=queries.find(sql=>sql.startsWith('DECLARE site_audit_pages_export'))!;assert.ok(projection);assert.ok(!/p\.(body_text|reasons)\b|p\.(facts|evidence)\s*(,|AS\b)/i.test(projection),'Cursor returns selected scalars, not raw JSON, body or reasons.');assert.ok(projection.includes("left(p.evidence->>'title',512)"));assert.ok(queries.filter(sql=>sql==='FETCH FORWARD 100 FROM site_audit_pages_export').length>=202);
   console.log('PASS 10,000 max-URL/Unicode-title scalar CSV rows; bytes='+length+' peakSampledRss='+sampledRss+' osPeakRss='+peakRss+'; slow-reader lease, copied 64 KiB chunks and cancel/drain release');
  }finally{pg.Client.prototype.query=nativeQuery;}

  for(const expiry of ['raw','derived']){
   const due=await start();await finish(due.run.id);if(expiry==='derived')await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[due.run.id]);const current=await listSiteAuditPages(project,viewer,due.run.id,new URLSearchParams());
   await pool.query(`WITH age AS (SELECT clock_timestamp()-$2::int*interval '24 hours'+interval '500 milliseconds' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1`,[due.run.id,expiry==='raw'?90:365]);
   let slept=false;pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){const result=(nativeQuery as (...values:unknown[])=>unknown).apply(this,args);if(args[0]==='FETCH FORWARD 100 FROM site_audit_pages_export'&&!slept){slept=true;return Promise.resolve(result).then(async row=>{await (nativeQuery as (...values:unknown[])=>Promise<unknown>).call(this,'SELECT pg_sleep(0.75)');return row;});}return result;} as typeof nativeQuery;
   try{await assert.rejects(exportSiteAuditPages(project,viewer,due.run.id,exportInput({},current.selectionRevision!)),{status:expiry==='raw'?409:410});assert.equal(slept,true,'Expiry must occur during generation after the first locked read.');}finally{pg.Client.prototype.query=nativeQuery;}
   const latched=(await pool.query('SELECT raw_expired_at,data_expired_at FROM site_audit_run WHERE id=$1',[due.run.id])).rows[0];assert.ok(latched[expiry==='raw'?'raw_expired_at':'data_expired_at']);await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650,derived_history_days=3650 WHERE id=$1',[workspace]);const extended=(await getSiteAudit(project,viewer,due.run.id)).run;assert.equal(expiry==='raw'?extended.rawEvidenceStatus:extended.dataStatus,'expired');await pool.query('UPDATE workspace SET raw_provider_evidence_days=90,derived_history_days=365 WHERE id=$1',[workspace]);
  }
  const lockHolder=await pool.connect();try{await lockHolder.query('BEGIN');await lockHolder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);const waiting=performance.now();await assert.rejects(listSiteAuditPages(project,viewer,large.run.id,new URLSearchParams()),{status:503});assert.ok(performance.now()-waiting<8000);}finally{await lockHolder.query('ROLLBACK');lockHolder.release();}
  console.log('PASS post-generation raw/derived expiry commits irreversible markers, extension cannot revive evidence, and read lock timeout is bounded before the workspace gate');
  }

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
  const exportList=await listSiteAuditPages(project,viewer,created.run.id,new URLSearchParams()),exportEndpoint=endpoint+'/'+created.run.id+'/pages/export',exportBody={coverage:null,resourceKind:'html',search:'',searchIn:'url_title_meta',sort:'url',order:'asc',expectedSelectionRevision:exportList.selectionRevision};
  const exportRequest=(body:unknown=exportBody,extra:Record<string,string>={},suffix='')=>new Request(exportEndpoint+suffix,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await handleApi(new Request(exportEndpoint))).status,401);assert.equal((await handleApi(new Request(exportEndpoint,{headers:{cookie}}))).status,405);assert.equal((await handleApi(exportRequest(exportBody,{},'?limit=50'))).status,400);assert.equal((await handleApi(exportRequest({...exportBody,pageIds:[randomUUID()]}))).status,400);assert.equal((await handleApi(exportRequest(exportBody,{origin:'https://foreign.example.com'}))).status,403);assert.equal((await handleApi(new Request(exportEndpoint,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json',authorization:'Bearer '+token.token},body:JSON.stringify(exportBody)}))).status,403);
  const httpCsv=await handleApi(exportRequest(exportBody,{'accept-encoding':'gzip'}));assert.equal(httpCsv.status,200);assert.equal(httpCsv.headers.get('content-encoding'),null);assert.equal(httpCsv.headers.get('cache-control'),'no-store, no-transform');assert.equal(httpCsv.headers.get('x-export-row-count'),'1');assert.equal(httpCsv.headers.get('x-export-revision'),exportList.selectionRevision);const actualBytes=await httpCsv.arrayBuffer();assert.equal(actualBytes.byteLength,Number(httpCsv.headers.get('content-length')));
  const leasedHttp=await handleApi(exportRequest()),busyHttp=await handleApi(exportRequest());assert.equal(busyHttp.status,503);assert.equal(busyHttp.headers.get('retry-after'),'5');await leasedHttp.body!.cancel();
  let releaseExport!:()=>void,enteredExport!:()=>void;const exportHeld=new Promise<void>(resolve=>{releaseExport=resolve;}),exportReading=new Promise<void>(resolve=>{enteredExport=resolve;});const delayedExport=new Request(exportEndpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:new ReadableStream({async start(controller){enteredExport();await exportHeld;controller.enqueue(new TextEncoder().encode(JSON.stringify(exportBody)));controller.close();}}),duplex:'half'} as RequestInit),exportPending=handleApi(delayedExport);await exportReading;await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);releaseExport();assert.equal((await exportPending).status,404);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
  console.log('PASS exact CSV HTTP route, cookie/Origin/bearer scope, strict body/query, identity encoding/length headers and live read-membership revocation during body parsing');
  {
  // audits:read admits the list, run detail and issues only: equal to the member read, through the same durable expiry latch.
  const reader=await createApiKey(workspace,owner,{name:'Audit reader',scopes:['audits:read']});
  const keyed=(suffix:string,key=reader.token,init:RequestInit={})=>handleApi(new Request(endpoint+suffix,{...init,headers:{authorization:'Bearer '+key,...init.headers as Record<string,string>}}));
  const wire=(value:unknown)=>JSON.parse(JSON.stringify(value)),keyedRun=await start();await finish(keyedRun.run.id);const runPath='/'+keyedRun.run.id;
  const keyedPage=(await listSiteAuditPages(project,owner,keyedRun.run.id,new URLSearchParams())).pages[0].id;
  await pool.query("INSERT INTO site_audit_issue(id,run_id,page_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,$4,'static-html-v1','missing-title','critical','{}')",[randomUUID(),keyedRun.run.id,keyedPage,'d'.repeat(64)]);
  const reads:[string,(key?:string)=>Promise<unknown>][]=[['?limit=2',key=>listSiteAudits(project,owner,new URLSearchParams('limit=2'),key)],[runPath,key=>getSiteAudit(project,owner,keyedRun.run.id,key)],[runPath+'/issues?code=missing-title',key=>listSiteAuditIssues(project,owner,keyedRun.run.id,new URLSearchParams('code=missing-title'),key)]];
  for(const [suffix,read] of reads){
   const response=await keyed(suffix);assert.equal(response.status,200,suffix);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();
   assert.deepEqual(body,wire(await read()),'The key read equals the member read: '+suffix);assert.deepEqual(wire(await read(reader.token)),body,'The direct key read equals the HTTP key read: '+suffix);
  }
  const keyedIssues=await (await keyed(runPath+'/issues')).json();assert.equal(keyedIssues.issues.length,1);assert.equal(keyedIssues.matchingRetainedCount,1);assert.equal(keyedIssues.run.canDelete,true,'The run DTO is the issuer role DTO, unchanged under a key.');
  // The earlier analytics key went with the owner's removed membership above; a fresh one shows the wrong scope is refused on every admitted route.
  const analyticsOnly=await createApiKey(workspace,owner,{name:'Analytics only',scopes:['analytics:read']});
  for(const suffix of ['',runPath,runPath+'/issues'])assert.equal((await keyed(suffix,analyticsOnly.token)).status,403,'analytics:read never reaches audits: '+suffix);
  assert.equal((await keyed('',reader.token,{headers:{cookie}})).status,400,'Cookie plus bearer is refused.');
  assert.equal((await keyed('?limit=1&limit=2')).status,400);assert.equal((await keyed(runPath+'?limit=1')).status,400);
  assert.equal((await handleApi(new Request(`${config.appUrl}/api/projects/${project}/events`,{headers:{authorization:'Bearer '+reader.token}}))).status,403,'audits:read does not reach analytics.');
  // Setup, pages, page detail, links, export, start, cancel and delete stay cookie-only; nothing changes.
  const runsBefore=(await pool.query('SELECT count(*)::int AS n FROM site_audit_run WHERE project_id=$1',[project])).rows[0].n;
  for(const [suffix,method] of [['','POST'],[runPath+'/cancel','POST'],[runPath+'/delete','POST'],[runPath+'/pages/export','POST'],['/setup','GET'],[runPath+'/pages','GET'],[runPath+'/pages/'+keyedPage,'GET'],[runPath+'/pages/'+keyedPage+'/links','GET']] as const)
   assert.equal((await keyed(suffix,reader.token,method==='POST'?{method,headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify(input())}:{})).status,403,method+' '+suffix);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM site_audit_run WHERE project_id=$1',[project])).rows[0].n,runsBefore);const unchanged=(await getSiteAudit(project,owner,keyedRun.run.id)).run;assert.equal(unchanged.status,'completed');assert.equal(unchanged.dataStatus,'available');
  // Tenancy, revocation and the viewer allowlist.
  const foreignReader=await createApiKey(foreignWorkspace,owner,{name:'Foreign audit reader',scopes:['audits:read']});
  assert.equal((await keyed('',foreignReader.token)).status,404,'A key cannot reach a project of another workspace.');
  assert.equal((await handleApi(new Request(`${config.appUrl}/api/projects/${foreignProject}/audits`,{headers:{authorization:'Bearer '+reader.token}}))).status,404);
  const revoked=await createApiKey(workspace,owner,{name:'Revoked audit reader',scopes:['audits:read']});await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[revoked.key.id]);
  assert.equal((await keyed('',revoked.token)).status,401,'A revoked key is refused.');
  const viewerKey=await createApiKey(workspace,admin,{name:'Viewer audit reader',scopes:['audits:read']});await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);
  try{const viewed=await keyed(runPath+'/issues',viewerKey.token);assert.equal(viewed.status,200,'audits:read is on the viewer allowlist.');const viewedBody=await viewed.json();assert.equal(viewedBody.role,'viewer');assert.equal(viewedBody.run.canDelete,false);}
  finally{await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);}
  // A key read latches due expiry durably, exactly as a member read; a later policy extension cannot re-reveal the retained issue.
  const aged=await start();await finish(aged.run.id);const agedPath='/'+aged.run.id;
  await pool.query("INSERT INTO site_audit_issue(id,run_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,'static-graph-v1','orphan-page','info','{}')",[randomUUID(),aged.run.id,'e'.repeat(64)]);
  await pool.query("WITH age AS (SELECT clock_timestamp()-interval '366 days' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1",[aged.run.id]);
  const markers=async()=>(await pool.query('SELECT raw_expired_at,data_expired_at FROM site_audit_run WHERE id=$1',[aged.run.id])).rows[0] as {raw_expired_at:Date|null;data_expired_at:Date|null};
  assert.deepEqual(await markers(),{raw_expired_at:null,data_expired_at:null},'Nothing latched the aged run before the key read.');
  const agedRead=await keyed(agedPath+'/issues');assert.equal(agedRead.status,200);const agedBody=await agedRead.json();
  assert.equal(agedBody.run.dataStatus,'expired');assert.deepEqual(agedBody.issues,[]);assert.equal(agedBody.groups,null);assert.equal(agedBody.matchingRetainedCount,null);assert.equal(agedBody.nextCursor,null);
  const latched=await markers();assert.ok(latched.raw_expired_at&&latched.data_expired_at,'The key read committed both expiry markers.');assert.equal(agedBody.run.dataExpiredAt,latched.data_expired_at!.toISOString());
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650,derived_history_days=3650 WHERE id=$1',[workspace]);
  try{
   const extended=await (await keyed(agedPath+'/issues')).json();assert.equal(extended.run.dataStatus,'expired','A later policy extension cannot revive key-latched data.');assert.deepEqual(extended.issues,[]);assert.equal(extended.groups,null);
   assert.equal((await (await keyed(agedPath)).json()).run.rawEvidenceStatus,'expired');assert.equal((await (await keyed('?limit=100')).json()).runs.find((r:{id:string})=>r.id===aged.run.id).dataStatus,'expired');
   assert.deepEqual(await markers(),latched,'Markers never move once latched.');assert.equal((await pool.query('SELECT 1 FROM site_audit_issue WHERE run_id=$1',[aged.run.id])).rowCount,1,'The retained row still exists; only the durable latch hides it.');
  }finally{await pool.query('UPDATE workspace SET raw_provider_evidence_days=90,derived_history_days=365 WHERE id=$1',[workspace]);}
  // Bounded wait: behind a held workspace UPDATE lock a key read answers 503 within the 5 s bound, and a key revoked during that wait outranks it with 401.
  const stale=await createApiKey(workspace,owner,{name:'Stale audit reader',scopes:['audits:read']}),lockHolder=await pool.connect();
  try{
   await lockHolder.query('BEGIN');await lockHolder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
   const waited=performance.now(),busy=await keyed('');assert.equal(busy.status,503);const busyMs=performance.now()-waited;assert.ok(busyMs>=4500&&busyMs<8000,'A key read waits the 5 s lock bound, then answers 503 ('+Math.round(busyMs)+' ms).');
   const pending=keyed('',stale.token),end=Date.now()+4000;let reached=false;
   while(!reached&&Date.now()<end){reached=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",['SELECT id FROM workspace WHERE id=$1 FOR SHARE%'])).rowCount;if(!reached)await new Promise(resolve=>setTimeout(resolve,10));}
   assert.ok(reached,'The stale key read reached the workspace lock wait.');await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[stale.key.id]);
   assert.equal((await pending).status,401,'Stale key authority outranks the 503 on the error path.');
  }finally{await lockHolder.query('ROLLBACK').catch(()=>{});lockHolder.release();}
  // The pre-COMMIT key recheck is the HTTP path's only guard after the read (api.ts publishes json(result) directly): a key revoked while its issues
  // read waits, after the raw expiry latch was written, is refused 401 and the latch rolls back; a current key read then latches it.
  const rawDue=await start();await finish(rawDue.run.id);const rawDueIssues='/'+rawDue.run.id+'/issues';
  await pool.query("INSERT INTO site_audit_issue(id,run_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,$3,'static-graph-v1','orphan-page','info','{}')",[randomUUID(),rawDue.run.id,'f'.repeat(64)]);
  await pool.query("WITH age AS (SELECT clock_timestamp()-interval '100 days' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1",[rawDue.run.id]);
  const rawMarkers=async()=>(await pool.query('SELECT raw_expired_at,data_expired_at FROM site_audit_run WHERE id=$1',[rawDue.run.id])).rows[0] as {raw_expired_at:Date|null;data_expired_at:Date|null};
  const midRead=await createApiKey(workspace,owner,{name:'Mid-read audit reader',scopes:['audits:read']}),issueLock=await pool.connect();
  try{
   await issueLock.query('BEGIN');await issueLock.query('LOCK TABLE site_audit_issue IN ACCESS EXCLUSIVE MODE');
   const pending=keyed(rawDueIssues,midRead.token),end=Date.now()+4000;let reached=false;
   while(!reached&&Date.now()<end){reached=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",['SELECT i.id,i.page_id AS "pageId"%'])).rowCount;if(!reached)await new Promise(resolve=>setTimeout(resolve,10));}
   assert.ok(reached,'The key read passed the gate and the expiry latch and reached the issue lock wait.');
   await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[midRead.key.id]);await issueLock.query('COMMIT');
   assert.equal((await pending).status,401,'A key revoked while its read ran is refused before COMMIT.');
  }finally{await issueLock.query('ROLLBACK').catch(()=>{});issueLock.release();}
  assert.deepEqual(await rawMarkers(),{raw_expired_at:null,data_expired_at:null},'The stale key committed no expiry latch.');
  const rawLatched=await (await keyed(rawDueIssues)).json();assert.equal(rawLatched.run.rawEvidenceStatus,'expired');assert.equal(rawLatched.run.dataStatus,'available');assert.equal(rawLatched.issues.length,1);
  const rawAfter=await rawMarkers();assert.ok(rawAfter.raw_expired_at,'A current key read latches the due raw expiry.');assert.equal(rawAfter.data_expired_at,null);
  console.log('PASS audits:read list/detail/issues equal the member read, every other audit route 403 under a key, mixed credentials 400, strict query, foreign 404, revoked 401, viewer allowlist, durable key-read expiry latch that a policy extension cannot revive, bounded 503 and stale-key 401 on the error path, and a key revoked mid-read refused 401 before COMMIT with its latch rolled back');
  }
  let unblock!:()=>void;const held=new Promise<void>(resolve=>{unblock=resolve;});let reading!:()=>void;const entered=new Promise<void>(resolve=>{reading=resolve;});
  const request=new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:new ReadableStream({async start(controller){reading();await held;controller.enqueue(new TextEncoder().encode(JSON.stringify(input())));controller.close();}}),duplex:'half'} as RequestInit);
  const delayed=handleApi(request);await entered;await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);unblock();assert.equal((await delayed).status,403);
  assert.equal((await getSiteAuditSetup(project,owner)).canStart,false);assert.equal((await listSiteAuditIssues(project,owner,history.run.id,new URLSearchParams())).role,'viewer');await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);await assert.rejects(listSiteAuditIssues(project,owner,history.run.id,new URLSearchParams()),{status:404});
  console.log('PASS actual cookie/Origin/bearer/API routes and delayed-body live-role revocation; no website requests');
 }finally{
  try{await pool.query("UPDATE site_audit_run SET status='cancelled',phase=NULL,completed_at=GREATEST(created_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=ANY($1::text[]) AND status IN('queued','running','cancelling')",[[workspace,foreignWorkspace]]);}
  finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
 }
}
if(import.meta.main){try{await runSiteAuditChecks();}finally{await closeDatabase();}}
