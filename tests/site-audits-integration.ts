import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {addDomain,issueDomainChallenge,verifyDomain,revokeDomain,updateDomain} from '../src/server/domains.ts';
import {siteAuditQueue,getSiteAuditSetup,startSiteAudit,getSiteAudit,listSiteAudits,listSiteAuditPages,getSiteAuditPage,listSiteAuditIssues,listSiteAuditLinks,cancelSiteAudit,deleteSiteAudit,withAuditLock,auditAuthorityCurrent} from '../src/server/site-audits.ts';
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
  await assert.rejects(getSiteAuditPage(project,owner,history.run.id,otherPage),{status:404});
  await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);assert.equal((await getSiteAuditPage(project,owner,history.run.id,pageId)).page.evidence,null);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[history.run.id]);
  const expired=await listSiteAuditPages(project,owner,history.run.id,new URLSearchParams());assert.equal(expired.run.dataStatus,'expired');assert.deepEqual(expired.pages,[]);
  const expiredIssues=await listSiteAuditIssues(project,owner,history.run.id,new URLSearchParams());assert.equal(expiredIssues.matchingRetainedCount,null);assert.deepEqual(expiredIssues.issues,[]);
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
  const scalar=(p:typeof all[number],sort:typeof auditPageSort[number])=>sort==='url'?p.url:sort==='title'?p.titlePreview.text:sort==='httpStatus'?p.httpStatus:sort==='h1'?p.analysis.facts?.headingCounts[0]??null:sort==='wordCount'?p.analysis.facts?.wordCount??null:sort==='images'?p.analysis.facts?.imagesMissingAlt??null:p.responseTimeMs;
  const compare=(a:string|number|null,b:string|number|null,direction:number)=>a===null?(b===null?0:1):b===null?-1:(typeof a==='string'&&typeof b==='string'?Buffer.compare(Buffer.from(a),Buffer.from(b)):Number(a)-Number(b))*direction;
  for(const sort of auditPageSort)for(const order of ['asc','desc'] as const){
   const scope={sort,order,limit:'100'},one=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams(scope)),two=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({...scope,cursor:one.nextCursor!}));
   // Long titles differ only beyond the preview: use the fixture's readable raw title for this ordering oracle.
   const title=(p:typeof all[number])=>records.find(r=>r.id===p.id)?.evidence?.title??null;
   const expected=[...all].sort((a,b)=>compare(sort==='title'?title(a):scalar(a,sort),sort==='title'?title(b):scalar(b,sort),order==='asc'?1:-1)||(sort==='images'?compare(a.analysis.facts?.imagesTotal??null,b.analysis.facts?.imagesTotal??null,order==='asc'?1:-1):0)||(a.id<b.id?-1:a.id>b.id?1:0));
   assert.deepEqual([...one.pages,...two.pages].map(p=>p.id),expected.map(p=>p.id),`${sort} ${order}: exact numeric/text/tie order with null last and zero retained`);assert.equal(two.nextCursor,null);
  }
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
  await assert.rejects(listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({cursor:firstPages.nextCursor!})),{status:409});
  await pool.query("WITH age AS (SELECT clock_timestamp()-interval '366 days' AS at) UPDATE site_audit_run SET created_at=age.at,completed_at=age.at,deadline_at=age.at+interval '30 minutes' FROM age WHERE id=$1",[searchRun]);
  const pagesExpired=await listSiteAuditPages(project,viewer,searchRun,new URLSearchParams({sort:'title',search:'private'}));assert.equal(pagesExpired.run.dataStatus,'expired');assert.deepEqual(pagesExpired.pages,[]);assert.equal(pagesExpired.nextCursor,null);assert.equal(pagesExpired.selectionRevision,null);assert.equal(pagesExpired.matchingRetainedCount,null);
  assert.ok((await pool.query('SELECT data_expired_at FROM site_audit_run WHERE id=$1',[searchRun])).rows[0].data_expired_at);assert.ok((await pool.query('SELECT evidence FROM site_audit_page WHERE id=$1',[records[0].id])).rows[0].evidence);
  console.log('PASS raw-dependent expiry commits its latch, physical evidence stays hidden, numeric/URL selection survives, derived expiry short-circuits');

  const changing=await start(),changingRun=changing.run.id;
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) SELECT gen_random_uuid(),$1,$2,'html','https://audit.example.com/active-'||n FROM generate_series(1,125) n",[changingRun,project]);
  const activePages=await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams());assert.equal(activePages.matchingRetainedCount,null);assert.ok(activePages.nextCursor);
  await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) VALUES($1,$2,$3,'html','https://audit.example.com/new-active')",[randomUUID(),changingRun,project]);
  await assert.rejects(listSiteAuditPages(project,viewer,changingRun,new URLSearchParams({cursor:activePages.nextCursor!})),{status:409});
  const beforeFinish=await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams());await finish(changingRun);
  await assert.rejects(listSiteAuditPages(project,viewer,changingRun,new URLSearchParams({cursor:beforeFinish.nextCursor!})),{status:409});assert.equal((await listSiteAuditPages(project,viewer,changingRun,new URLSearchParams())).matchingRetainedCount,127);
  const oversized=await start();await finish(oversized.run.id);await pool.query("INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url) SELECT gen_random_uuid(),$1,$2,'html','https://audit.example.com/over-'||n FROM generate_series(1,10000) n",[oversized.run.id,project]);
  await assert.rejects(listSiteAuditPages(project,viewer,oversized.run.id,new URLSearchParams()),{status:409});
  console.log('PASS active membership/status revisions and over-10,000 population refusal without truncated success');
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
