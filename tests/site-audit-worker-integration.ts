import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {Resolver} from 'node:dns/promises';
import {Readable} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {startSiteAudit,cancelSiteAudit,getSiteAudit,type AuditRunRow} from '../src/server/site-audits.ts';
import {executeSiteAudit,reconcileSiteAudits,stopSiteAudits} from '../src/server/site-audit-worker.ts';

type Response={status?:number;body?:string;headers?:string[];hold?:Promise<void>};
const html=(links='')=>`<!doctype html><html><head><title>A complete synthetic page</title><meta name="description" content="${'Description '.repeat(9)}"></head><body><h1>Synthetic page</h1><p>${'word '.repeat(170)}</p>${links}</body></html>`;
const sitemap=(origin:string,paths=['/'])=>`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path=>`<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(done=>{resolve=done;}),resolve:()=>resolve()};}

export async function runSiteAuditWorkerChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
 const config=getConfig(),db=new URL(config.databaseUrl);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.match(db.pathname,/^\/ten98_site_worker_[a-z0-9]+$/);
 await assertSchema();const pool=getDatabase().pool;
 assert.equal((await pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n,'0','Use a fresh worker-only database.');
 const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),otherWorkspace=randomUUID(),otherProject=randomUUID();
 const origin='https://audit.example.com';
 await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Synthetic audit owner\',$2)',[owner,`${owner}@audit.test`]);
 for(const [wid,pid] of [[workspace,project],[otherWorkspace,otherProject]]){
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Synthetic audit')",[wid]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[wid,owner]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Synthetic audit',$3,$4,'infinity')",[pid,wid,origin,randomUUID()]);
 }
 const read=async(id:string)=>(await pool.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1',[id])).rows[0];
 const start=async(maxPages=50,pid=project)=>{
  const result=await startSiteAudit(pid,owner,{requestId:randomUUID(),domainId:null,startPath:'/',maxPages,mode:'static'});return read(result.run.id);
 };
 const execute=async(run:AuditRunRow)=>{
  await executeSiteAudit({runId:run.id,jobId:run.queue_job_id});
  // Direct invocation must also acknowledge its synthetic wakeup, just as pg-boss
  // does after a handler returns. Otherwise terminal fixtures backlog the real worker.
  await (await getBoss()).complete('site-audit',run.queue_job_id,null,{includeQueued:true});
 };
 let route:(url:URL)=>Response|Promise<Response>=url=>url.pathname==='/robots.txt'?{body:'User-agent: *\nAllow: /',headers:['Content-Type','text/plain']}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:{body:html()};
 const requests:{url:string;at:number;destroyed:boolean}[]=[];
 const responses=new Set<Readable>();
 const mocks=[mock.method(Resolver.prototype,'resolve4',async()=>['1.1.1.1']),mock.method(Resolver.prototype,'resolve6',async()=>[])];
 const request=((url:URL,options:any,callback:(response:any)=>void)=>{
  const state={url:url.href,at:Date.now(),destroyed:false};requests.push(state);
  assert.equal(options.method,'GET');assert.equal(options.headers['user-agent'],'TenMonitorBot/1.0');assert.deepEqual(options.agent.options.proxyEnv,{});
  const req=new EventEmitter() as any;req.destroy=()=>{state.destroyed=true;};
  req.end=()=>queueMicrotask(()=>{void(async()=>{
   if(state.destroyed)return;const socket=new EventEmitter() as any;socket.remoteAddress='1.1.1.1';req.emit('socket',socket);socket.emit(url.protocol==='https:'?'secureConnect':'connect');
   const spec=await route(url);await spec.hold;if(state.destroyed)return;
   let supplied=false;const response=new Readable({read(){if(supplied)return;supplied=true;if(spec.body)this.push(Buffer.from(spec.body));this.push(null);}}) as Readable&{statusCode:number;rawHeaders:string[];complete:boolean};
   response.statusCode=spec.status??200;response.rawHeaders=spec.headers??['Content-Type','text/html; charset=utf-8'];response.complete=true;responses.add(response);response.once('close',()=>responses.delete(response));callback(response);
  })().catch(error=>req.emit('error',error));});return req;
 }) as typeof http.request;
 const hm=mock.method(http,'request',request),sm=mock.method(https,'request',request as typeof https.request);
 const fm=mock.method(globalThis,'fetch',async()=>{throw new Error('External fetch forbidden in audit fixture.');});
 try{
  const clean=await start();await execute(clean);let saved=await read(clean.id);
  assert.equal(saved.status,'completed');assert.equal(saved.request_count,3);assert.equal(saved.summary?.pagesAnalyzed,1);assert.equal(saved.coverage.discoveryComplete,true);
  assert.equal(saved.summary?.graph.status,'complete');assert.equal(saved.robots_state,'present');assert.ok(saved.robots_body);
  assert.ok(Number(saved.budget_charged_bytes)<10000);assert.equal(saved.wire_bytes,saved.decoded_bytes);
  assert.ok(requests.slice(1).every((r,i)=>r.at-requests[i].at>=950),'Persisted pacing must delay each actual request.');
  const count=requests.length;await execute(clean);await executeSiteAudit({runId:clean.id,jobId:randomUUID()});assert.equal(requests.length,count);
  console.log('PASS real queue receipt, native request settings, robots/sitemap/HTML children, graph publication, pacing and repeat no-op');

  route=url=>url.pathname==='/robots.txt'?{status:302,headers:['Location','https://policy.example.net/robots']}:
   url.hostname==='policy.example.net'?{body:'User-agent: *\nDisallow: /private\nSitemap: https://audit.example.com/sitemap.xml',headers:['Content-Type','text/plain']}:
   url.pathname==='/sitemap.xml'?{body:sitemap(origin,['/','/two','/private','/missing']),headers:['Content-Type','application/xml']}:
   url.pathname==='/missing'?{status:404}: {body:html('<a href="/two">Second</a><a href="/private">Private</a><a href="/missing">Missing</a><a href="/search?secret=value">Query</a><a href="https://outside.example.com/page">Outside</a>')};
  const graph=await start();const graphStart=requests.length;await execute(graph);saved=await read(graph.id);
  assert.equal(saved.status,'partial');assert.equal(saved.robots_state,'present');assert.ok(saved.coverage.queryExclusions!>0);
  const graphRequests=requests.slice(graphStart).map(r=>r.url);assert.ok(graphRequests.includes('https://policy.example.net/robots'));assert.ok(!graphRequests.some(url=>url.includes('/private')||url.includes('?')||url.includes('outside.')));
  assert.equal((await pool.query("SELECT state FROM site_audit_page WHERE run_id=$1 AND url=$2",[graph.id,origin+'/private'])).rows[0].state,'excluded');
  const codes=(await pool.query('SELECT code FROM site_audit_issue WHERE run_id=$1',[graph.id])).rows.map(r=>r.code);
  assert.ok(codes.includes('duplicate-title'));assert.ok(codes.includes('broken-internal-link'));assert.ok(!codes.includes('orphan-page'));
  assert.equal((await pool.query("SELECT count(*) AS n FROM site_audit_edge WHERE run_id=$1 AND target_url LIKE '%secret%'",[graph.id])).rows[0].n,'0');
  console.log('PASS cross-origin robots keeps original policy scope, query/private/external exclusions and conservative duplicate/broken/orphan findings');

  route=()=>({status:404,headers:['Cf-Mitigated','challenge']});
  const blocked=await start(),beforeBlocked=requests.length;await execute(blocked);saved=await read(blocked.id);
  assert.equal(saved.status,'failed');assert.equal(saved.robots_state,'unavailable');assert.equal(requests.length-beforeBlocked,1);assert.equal(saved.summary,null);
  let rootAttempts=0;
  route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:
   ++rootAttempts===1?{status:429,headers:['Retry-After','0','Cf-Mitigated','challenge']}:{body:html()};
  const retry=await start();await execute(retry);saved=await read(retry.id);
  assert.equal(saved.robots_state,'absent');assert.equal(rootAttempts,2);assert.equal(saved.html_pages_started,1);assert.equal(saved.request_count,4);
  assert.equal(saved.status,'completed');assert.ok(Number(saved.budget_charged_bytes)>=1048576+524288);
  const retryPage=(await pool.query('SELECT attempts_started,facts FROM site_audit_page WHERE run_id=$1 AND resource_kind=\'html\'',[retry.id])).rows[0];assert.equal(retryPage.attempts_started,2);assert.ok(retryPage.facts);
  console.log('PASS challenge prevents false absent robots; 429 priority, one paced retry and conservative reservations survive failed attempts');

  route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin,['/','/two']),headers:['Content-Type','application/xml']}:{body:html()};
  const capped=await start(1);await execute(capped);saved=await read(capped.id);assert.equal(saved.status,'partial');assert.equal(saved.stop_reason,'page_limit');assert.equal(saved.html_pages_started,1);assert.equal(saved.summary?.graph.checks.orphans,'unavailable');
  route=()=>({status:429,headers:['Retry-After','999999999999999999999999999999999']});
  const delayed=await start(),beforeDelay=requests.length;await execute(delayed);saved=await read(delayed.id);assert.equal(requests.length-beforeDelay,1);assert.equal(saved.stop_reason,'pacing_exceeds_deadline');assert.notEqual(saved.status,'completed');
  console.log('PASS page/resource limits and Retry-After beyond deadline stop without early retry or false complete coverage');

  route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:{body:html()};
  const interrupted=await start(),expiredOwner=randomUUID(),attempt=randomUUID();
  await pool.query("UPDATE site_audit_run SET status='running',phase='robots',started_at=created_at,lease_owner=$2,lease_expires_at=clock_timestamp()-interval '1 second',request_count=1,budget_charged_bytes=524288 WHERE id=$1",[interrupted.id,expiredOwner]);
  await pool.query("UPDATE site_audit_page SET state='leased',attempts_started=1,attempt_id=$2,attempt_generation=1,dispatched_at=clock_timestamp()-interval '1 minute',reserved_bytes=524288 WHERE run_id=$1 AND resource_kind='robots'",[interrupted.id,attempt]);
  await pool.query("UPDATE pgboss.job SET state='active' WHERE id=$1",[interrupted.queue_job_id]);
  await reconcileSiteAudits();const replacement=await read(interrupted.id);assert.notEqual(replacement.queue_job_id,interrupted.queue_job_id);
  const beforeOld=requests.length;await execute(interrupted);assert.equal(requests.length,beforeOld);await execute(replacement);saved=await read(interrupted.id);
  assert.equal(saved.status,'completed');assert.ok(Number(saved.budget_charged_bytes)>=1048576);assert.equal((await pool.query("SELECT attempts_started FROM site_audit_page WHERE run_id=$1 AND resource_kind='robots'",[interrupted.id])).rows[0].attempts_started,2);
  console.log('PASS expired lease replacement fences old actual job ID and retains unknown attempt charges across recovery');

  // Revocation after claim but before the pacing wait completes must be checked
  // at actual dispatch. No reconciler/heartbeat is needed to discover the loss.
  for(const action of ['revoke','cancel'] as const){
   const waiting=await start(),beforeWaiting=requests.length;
   await pool.query("UPDATE site_audit_run SET next_request_at=clock_timestamp()+interval '1200 milliseconds' WHERE id=$1",[waiting.id]);
   const waitingWork=execute(waiting),claimDeadline=Date.now()+5000;
   while((saved=await read(waiting.id)).status==='queued'&&Date.now()<claimDeadline)await sleep(10);
   assert.equal(saved.status,'running');assert.equal(requests.length,beforeWaiting);
   try{
    if(action==='cancel')await cancelSiteAudit(project,owner,waiting.id,{});
    else await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
    await waitingWork;saved=await read(waiting.id);
    assert.equal(requests.length,beforeWaiting,'A completed pacing wait must not reuse prior permission.');
    assert.equal(saved.request_count,0);assert.equal(saved.budget_charged_bytes,'0');assert.equal(saved.html_pages_started,0);
    assert.equal(saved.status,action==='cancel'?'cancelled':'failed');
    assert.equal(saved.stop_reason,action==='cancel'?'user_cancelled':'permission_changed');assert.equal(saved.lease_owner,null);
   }finally{
    if(action==='revoke')await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
   }
  }
  console.log('PASS fresh dispatch authorization after pacing wait prevents requests and reservations on revocation/cancellation');

  // Unlike the seeded abandoned attempt above, this old owner has a real native
  // response callback still waiting when its generation and queue ID are fenced.
  const staleEntered=deferred(),staleRelease=deferred();let staleRootAttempts=0;
  route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:
   (++staleRootAttempts,staleEntered.resolve(),{body:html(),...(staleRootAttempts===1?{hold:staleRelease.promise}:{})});
  const stale=await start(),staleWork=execute(stale);await staleEntered.promise;
  const beforeStale=await read(stale.id);
  try{
   await pool.query("UPDATE site_audit_run SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[stale.id]);
   await pool.query("UPDATE pgboss.job SET state='active' WHERE id=$1",[stale.queue_job_id]);
   await reconcileSiteAudits();const fenced=await read(stale.id);
   assert.notEqual(fenced.queue_job_id,stale.queue_job_id);assert.notEqual(fenced.generation,beforeStale.generation);
   staleRelease.resolve();await staleWork;saved=await read(stale.id);
   assert.equal(saved.status,'running','A stale callback cannot terminalize the replacement generation.');
   assert.equal(saved.queue_job_id,fenced.queue_job_id);assert.equal(saved.generation,fenced.generation);
   assert.equal(saved.budget_charged_bytes,beforeStale.budget_charged_bytes,'A stale completion must not refund its reservation.');
   assert.equal(saved.request_count,beforeStale.request_count);assert.equal(saved.wire_bytes,beforeStale.wire_bytes);
   const stalePage=(await pool.query("SELECT state,facts,evidence,attempt_settled_at FROM site_audit_page WHERE run_id=$1 AND resource_kind='html'",[stale.id])).rows[0];
   assert.equal(stalePage.state,'leased');assert.equal(stalePage.facts,null);assert.equal(stalePage.evidence,null);assert.equal(stalePage.attempt_settled_at,null);
   await execute(fenced);saved=await read(stale.id);
   assert.equal(saved.status,'completed');assert.equal(staleRootAttempts,2);assert.equal(saved.html_pages_started,1);
   assert.equal(saved.request_count,beforeStale.request_count+1);assert.ok(Number(saved.budget_charged_bytes)>=Number(beforeStale.budget_charged_bytes));
   assert.equal((await pool.query("SELECT attempts_started FROM site_audit_page WHERE run_id=$1 AND resource_kind='html'",[stale.id])).rows[0].attempts_started,2);
  }finally{staleRelease.resolve();await staleWork;}
  console.log('PASS live stale-generation response cannot publish, refund or finish; replacement retains unknown charge and recovers once');

  for(const limit of ['request_limit','body_capacity_limit'] as const){
   const bounded=await start(limit==='body_capacity_limit'?1000:50),beforeBounded=requests.length;
   const requestCount=limit==='request_limit'?bounded.config!.requestLimit:0;
   const charged=limit==='body_capacity_limit'?bounded.config!.bodyCapacityBytes-524288+1:0;
   await pool.query('UPDATE site_audit_run SET request_count=$2,budget_charged_bytes=$3 WHERE id=$1',[bounded.id,requestCount,charged]);
   await execute(bounded);saved=await read(bounded.id);
   assert.equal(requests.length,beforeBounded,'Exhausted request/body capacity must fail before native dispatch.');
   assert.equal(saved.stop_reason,limit);assert.notEqual(saved.status,'completed');assert.ok(saved.completed_at);assert.equal(saved.lease_owner,null);
   assert.equal(saved.request_count,requestCount);assert.equal(saved.budget_charged_bytes,String(charged));assert.equal(saved.html_pages_started,0);
   assert.equal(saved.summary?.graph.checks.orphans,'unavailable');
   assert.equal((await pool.query("SELECT count(*) AS n FROM site_audit_page WHERE run_id=$1 AND attempts_started<>0",[bounded.id])).rows[0].n,'0');
  }
  console.log('PASS exact request ceiling and insufficient next-response body capacity stop before dispatch without counter inflation');

  for(const action of ['cancel','revoke'] as const){
   const entered=deferred(),release=deferred();
   route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:(entered.resolve(),{body:html(),hold:release.promise});
   const run=await start(),work=execute(run);await entered.promise;
   if(action==='cancel')await cancelSiteAudit(project,owner,run.id,{});else await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
   await reconcileSiteAudits();await work;release.resolve();saved=await read(run.id);
   assert.equal(saved.status,action==='cancel'?'cancelled':'partial');assert.equal(saved.lease_owner,null);
   assert.equal(saved.stop_reason,action==='cancel'?'user_cancelled':'permission_changed');
   assert.equal((await pool.query("SELECT facts FROM site_audit_page WHERE run_id=$1 AND resource_kind='html'",[run.id])).rows[0].facts,null);
   assert.ok(requests.at(-1)!.destroyed);assert.ok(Number(saved.budget_charged_bytes)>=1048576);
   if(action==='revoke')await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
  }
  console.log('PASS held native request is aborted on cancellation/revocation, owner drains, and late page results cannot publish');

  const expired=await start(),created=new Date(Date.now()-31*60000);
  await pool.query('UPDATE site_audit_run SET created_at=$2,deadline_at=$2::timestamptz+interval \'30 minutes\' WHERE id=$1',[expired.id,created]);
  const beforeExpired=requests.length;await reconcileSiteAudits();await execute(expired);assert.equal((await read(expired.id)).status,'failed');assert.equal(requests.length,beforeExpired);
  const queued=await start();await cancelSiteAudit(project,owner,queued.id,{});await execute(queued);assert.equal(requests.length,beforeExpired);
  console.log('PASS queued expiry and cancellation never send requests');

  const entered=deferred(),release=deferred();let hold=true;
  route=url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:sitemap(origin),headers:['Content-Type','application/xml']}:(entered.resolve(),{body:html(),...(hold?{hold:release.promise}:{})});
  const shutdown=await start(),work=execute(shutdown);await entered.promise;
  const other=await start(50,otherProject),beforeOther=requests.length;await execute(other);assert.equal(requests.length,beforeOther);assert.equal((await read(other.id)).status,'queued');
  await cancelSiteAudit(otherProject,owner,other.id,{});
  await stopSiteAudits();await work;hold=false;release.resolve();saved=await read(shutdown.id);assert.equal(saved.status,'queued');assert.equal(saved.lease_owner,null);
  await startWorker();const timeout=Date.now()+30000;
  while((saved=await read(shutdown.id)).completed_at===null&&Date.now()<timeout)await sleep(100);
  assert.equal(saved.status,'completed');assert.equal(saved.html_pages_started,1);assert.equal((await getSiteAudit(project,owner,shutdown.id)).run.summary?.pagesAnalyzed,1);
  console.log('PASS one installation run, cooperative shutdown, real pg-boss worker resume and final API result');
 }finally{await stopJobs();fm.mock.restore();hm.mock.restore();sm.mock.restore();for(const item of mocks)item.mock.restore();for(const response of responses)response.destroy();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await runSiteAuditWorkerChecks();}catch(error){console.error(error instanceof assert.AssertionError?error.message:error instanceof Error?`${error.name}: worker integration failed.`:'Worker integration failed.');process.exitCode=1;}
 finally{await stopJobs();await closeDatabase();}
}
