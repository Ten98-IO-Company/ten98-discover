import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import type {PgBoss} from 'pg-boss';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {auditAuthorityCurrent,siteAuditQueue,withAuditLock,type AuditRunRow,type AuditCoverage,type AuditSummary} from './site-audits.ts';
import {fetchCrawlDocument,type CrawlDocumentKind,type CrawlDocumentObservation} from './crawl-network.ts';
import {evaluateCrawlRobotsIsolated} from './crawl-robots-isolated.ts';
import {prepareAuditObservation} from './site-audit-observation.ts';
import {planAuditRequest,resolveAuditCandidate,resolveRobotsRedirect} from './site-audit-policy.ts';
import {analyzeCrawlGraph,type GraphPage} from './crawl-graph.ts';
import {crawlBodyVersion,type CrawlAnalysis,type CrawlPageInput} from './crawl-analysis.ts';

type Page={id:string;run_id:string;project_id:string;resource_kind:CrawlDocumentKind;url:string;discovered_start:boolean;discovered_link:boolean;discovered_sitemap:boolean;link_depth:number|null;sitemap_depth:number;redirect_hops:number;state:'pending'|'leased'|'done'|'excluded'|'unavailable';attempts_started:number;attempt_id:string|null;attempt_generation:string|null;reserved_bytes:number|null;retry_after_at:Date|null;http_status:number|null;fetch_state:CrawlPageInput['fetchState'];analysis_coverage:CrawlAnalysis['coverage'];facts:CrawlAnalysis['facts']};
type Work={id:string;owner:string;generation:string;controller:AbortController;reason:string|null;task:Promise<void>};
type Candidate={kind:CrawlDocumentKind;url:string;link:boolean;sitemap:boolean;depth:number|null;sitemapDepth:number;hops:number};
type Edge={kind:'link'|'redirect'|'sitemap';url:string;nofollow:boolean;anchor:string|null};
type Discovery={candidates:Candidate[];edges:Edge[];coverage:AuditCoverage;robotsFailure:string|null};
const capacity={html:1048576,robots:524288,sitemap:5242880};
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const redirectStatuses=new Set([301,302,303,307,308]);
const active=new Map<string,Work>();
let stopping=false;
class AuditStopped extends Error {readonly reason:string;constructor(reason:string){super('Audit stopped.');this.reason=reason;}}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const addReason=(coverage:AuditCoverage,reason:string)=>{if(!coverage.reasons.includes(reason)&&coverage.reasons.length<64)coverage.reasons.push(reason);};
const now=async(client:PoolClient)=>(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;

function abort(work:Work,reason:string){work.reason??=reason;work.controller.abort();}
function ownedBy(run:AuditRunRow,work:Work){return run.lease_owner===work.owner&&run.generation===work.generation;}
/** Fresh permission, deadline and lease checks precede every dispatch and publication. */
async function gate<T>(work:Work,operation:(client:PoolClient,run:AuditRunRow,at:Date)=>Promise<T>):Promise<T>{
 const result=await withAuditLock({runId:work.id,internal:true},async({client,run})=>{
  const at=await now(client);
  if(!run||run.status!=='running'||!ownedBy(run,work)||run.lease_expires_at!.getTime()<=at.getTime())throw new AuditStopped('lease_lost');
  if(work.controller.signal.aborted)throw new AuditStopped(work.reason??'interrupted');
  if(run.deadline_at.getTime()<=at.getTime())throw new AuditStopped('deadline_exceeded');
  const authority=await auditAuthorityCurrent(client,run);if(!authority.allowed)throw new AuditStopped(authority.reason);
  return {value:await operation(client,run,at)};
 });
 if(!result)throw new AuditStopped('run_removed');return result.value;
}

async function settleAbandoned(client:PoolClient,runId:string,at:Date,outcome:'unknown'|'cancelled'){
 // Keep the entire reservation: an interrupted request cannot prove its actual consumption.
 await client.query(`UPDATE site_audit_page SET state=CASE WHEN attempts_started<2 THEN 'pending' ELSE 'unavailable' END,
  attempt_settled_at=$2,last_attempt_outcome=$3,fetch_state=CASE WHEN attempts_started<2 THEN 'not_fetched' ELSE 'error' END,
  analysis_coverage=CASE WHEN attempts_started<2 THEN 'not_fetched' ELSE 'unavailable' END,reasons=jsonb_build_array('interrupted_attempt')
  WHERE run_id=$1 AND state='leased'`,[runId,at,outcome]);
}
async function terminal(client:PoolClient,run:AuditRunRow,at:Date,reason:string){
 const status=run.cancel_requested_at?'cancelled':run.html_pages_started>0?'partial':'failed';
 const coverage=structuredClone(run.coverage);addReason(coverage,reason);coverage.discoveryComplete=false;coverage.linksComplete=false;
 await settleAbandoned(client,run.id,at,run.cancel_requested_at?'cancelled':'unknown');
 await client.query(`UPDATE site_audit_run SET status=$2,phase=NULL,stop_reason=$3,completed_at=$4,
  lease_owner=NULL,lease_expires_at=NULL,generation=generation+1,coverage=$5 WHERE id=$1`,[run.id,status,reason,at,coverage]);
}
async function claim(runId:string,jobId:string,owner:string):Promise<AuditRunRow|null>{
 return withAuditLock({runId,internal:true,claim:true},async({client,run})=>{
  if(!run||run.queue_job_id!==jobId||!['queued','running'].includes(run.status))return null;
  const at=await now(client);
  if(run.status==='running'&&run.lease_expires_at!.getTime()>at.getTime())return null;
  if(run.deadline_at.getTime()<=at.getTime()){await terminal(client,run,at,'deadline_exceeded');return null;}
  const authority=await auditAuthorityCurrent(client,run);if(!authority.allowed){await terminal(client,run,at,authority.reason);return null;}
  if((await client.query("SELECT 1 FROM site_audit_run WHERE id<>$1 AND status IN('running','cancelling') LIMIT 1",[runId])).rowCount)return null;
  if(run.status==='queued'){
   const oldest=(await client.query("SELECT id FROM site_audit_run WHERE status='queued' AND deadline_at>$1 ORDER BY created_at,id LIMIT 1",[at])).rows[0];
   if(oldest?.id!==runId)return null;
  }
  await settleAbandoned(client,runId,at,'unknown');
  return (await client.query<AuditRunRow>(`UPDATE site_audit_run SET status='running',phase=CASE WHEN robots_state='pending' THEN 'robots' ELSE 'discovery' END,
   started_at=coalesce(started_at,$3),generation=generation+1,lease_owner=$2,heartbeat_at=$3,lease_expires_at=$3::timestamptz+interval '45 seconds'
   WHERE id=$1 RETURNING *`,[runId,owner,at])).rows[0];
 });
}

function discoveries(run:AuditRunRow):Discovery{
 return {candidates:[],edges:[],coverage:structuredClone(run.coverage),robotsFailure:null};
}
function candidate(discovery:Discovery,run:AuditRunRow,page:Page,raw:string,kind:CrawlDocumentKind,edge:Edge['kind'],nofollow=false,anchor:string|null=null){
 const base=page.resource_kind==='robots'?`${run.origin}/robots.txt`:page.url;
 const normalized=kind==='robots'?resolveRobotsRedirect(raw,page.url,run.origin!):resolveAuditCandidate(raw,base,run.origin!);
 if(normalized.status!=='accepted'){
  discovery.coverage.scopeExclusions++;
  if(normalized.reason==='query'){discovery.coverage.queryExclusions=(discovery.coverage.queryExclusions??0)+1;addReason(discovery.coverage,'query_urls_excluded');}
  else if(normalized.reason==='outside_origin'){
   discovery.coverage.externalExclusions=(discovery.coverage.externalExclusions??0)+1;
   // External observations are evidence only. The public URL validator never grants frontier authority.
   const outside=resolveRobotsRedirect(raw,base,run.origin!);
   if(outside.status==='accepted')discovery.edges.push({kind:edge,url:outside.url,nofollow,anchor});
   if(edge!=='link')addReason(discovery.coverage,'discovery_outside_origin');
  }else addReason(discovery.coverage,'invalid_discovery_url');
  if(kind==='robots')discovery.robotsFailure='robots_redirect_excluded';
  return;
 }
 discovery.edges.push({kind:edge,url:normalized.url,nofollow,anchor});
 const hops=edge==='redirect'?page.redirect_hops+1:0;
 const sitemapDepth=kind==='sitemap'&&edge==='sitemap'&&page.resource_kind==='sitemap'?page.sitemap_depth+1:page.resource_kind==='sitemap'?page.sitemap_depth:0;
 if(hops>(kind==='robots'?5:8)||kind==='sitemap'&&sitemapDepth>run.config!.sitemapDepth){
  addReason(discovery.coverage,hops>5&&kind==='robots'?'robots_redirect_limit':hops>8?'redirect_limit':'sitemap_depth_limit');
  if(kind==='robots')discovery.robotsFailure='robots_redirect_limit';return;
 }
 discovery.candidates.push({kind,url:normalized.url,link:kind==='html'&&(edge==='link'||page.discovered_link),sitemap:kind==='html'&&(edge==='sitemap'||page.discovered_sitemap),
  depth:kind==='html'?(edge==='link'&&page.link_depth!==null?Math.min(10000,page.link_depth+1):edge==='redirect'?page.link_depth:null):null,sitemapDepth,hops});
}

/** One bounded bulk insert per frontier/edge set; no per-link transaction loop. */
async function publishDiscovery(client:PoolClient,run:AuditRunRow,page:Page,discovery:Discovery){
 const existing=(await client.query<{resource_kind:CrawlDocumentKind;url:string;state:Page['state']}>('SELECT resource_kind,url,state FROM site_audit_page WHERE run_id=$1',[run.id])).rows;
 const known=new Map(existing.map(row=>[`${row.resource_kind}\n${row.url}`,row]));
 const unique=new Map<string,Candidate>();let omissions=0,newPages=0;
 for(const next of discovery.candidates){
  const key=`${next.kind}\n${next.url}`,old=unique.get(key);
  if(next.kind==='robots'&&known.has(key)&&known.get(key)!.state!=='pending')discovery.robotsFailure='robots_redirect_loop';
  if(old){old.link||=next.link;old.sitemap||=next.sitemap;if(next.depth!==null)old.depth=Math.min(old.depth??10000,next.depth);old.hops=Math.min(old.hops,next.hops);continue;}
  if(!known.has(key)&&existing.length+newPages>=run.config!.frontierLimit){omissions++;continue;}
  if(!known.has(key))newPages++;
  unique.set(key,next);
 }
 if(omissions){discovery.coverage.frontierOmissions=(discovery.coverage.frontierOmissions??0)+omissions;addReason(discovery.coverage,'frontier_limit');}
 const rows=[...unique.values()].map(c=>({...c,id:randomUUID()}));
 if(rows.length)await client.query(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,discovered_link,discovered_sitemap,link_depth,sitemap_depth,redirect_hops)
  SELECT x.id,$1,$2,x.kind,x.url,x.link,x.sitemap,x.depth,x."sitemapDepth",x.hops FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,kind text,url text,link boolean,sitemap boolean,depth integer,"sitemapDepth" integer,hops integer)
  ON CONFLICT(run_id,resource_kind,url) DO UPDATE SET discovered_link=site_audit_page.discovered_link OR excluded.discovered_link,
   discovered_sitemap=site_audit_page.discovered_sitemap OR excluded.discovered_sitemap,link_depth=least(site_audit_page.link_depth,excluded.link_depth),
   sitemap_depth=least(site_audit_page.sitemap_depth,excluded.sitemap_depth),redirect_hops=least(site_audit_page.redirect_hops,excluded.redirect_hops)`,[run.id,run.project_id,JSON.stringify(rows)]);
 const seen=new Set<string>(),edges:object[]=[];const slots=run.config!.edgeLimit-run.edge_count;
 for(const e of discovery.edges){const key=`${e.kind}\n${e.url}`;if(seen.has(key))continue;seen.add(key);if(edges.length>=slots)continue;
  edges.push({id:randomUUID(),kind:e.kind,url:e.url,nofollow:e.nofollow,anchor:e.anchor===null?null:Array.from(e.anchor).slice(0,400).join('')});}
 if(seen.size>edges.length){discovery.coverage.edgeOmissions=(discovery.coverage.edgeOmissions??0)+seen.size-edges.length;addReason(discovery.coverage,'edge_limit');}
 if(edges.length)await client.query(`INSERT INTO site_audit_edge(id,run_id,source_page_id,kind,target_url,nofollow,anchor)
  SELECT x.id,$1,$2,x.kind,x.url,x.nofollow,x.anchor FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,kind text,url text,nofollow boolean,anchor text)
  ON CONFLICT(run_id,source_page_id,kind,target_url) DO NOTHING`,[run.id,page.id,JSON.stringify(edges)]);
 await client.query(`UPDATE site_audit_run SET frontier_count=(SELECT count(*) FROM site_audit_page WHERE run_id=$1),edge_count=(SELECT count(*) FROM site_audit_edge WHERE run_id=$1),coverage=$2 WHERE id=$1`,[run.id,discovery.coverage]);
}

async function nextPage(work:Work){
 return gate(work,async(client,run)=>{
  if(run.robots_state==='unavailable')throw new AuditStopped('robots_unavailable');
  const page=(await client.query<Page>(`SELECT * FROM site_audit_page WHERE run_id=$1 AND state='pending'
   AND ($2<>'pending' OR resource_kind='robots') ORDER BY CASE resource_kind WHEN 'robots' THEN 0 WHEN 'sitemap' THEN 1 ELSE 2 END,
   discovered_start DESC,link_depth NULLS LAST,id LIMIT 1`,[run.id,run.robots_state])).rows[0];
  return {run,page};
 });
}
async function robotsPermission(work:Work,run:AuditRunRow,page:Page):Promise<number|null>{
 if(page.resource_kind==='robots'||run.robots_state==='absent')return 1000;
 if(run.robots_state!=='present'||!run.robots_body)throw new AuditStopped('robots_evidence_unavailable');
 const policy=await evaluateCrawlRobotsIsolated({robotsUrl:`${run.origin}/robots.txt`,body:run.robots_body,productToken:run.config!.robotsProductToken,targetUrls:[page.url],maxCrawlDelaySeconds:1800},work.controller.signal);
 if(policy.status!=='ok'||policy.evaluation.policyStatus!=='ready'||policy.evaluation.digest!==run.robots_digest)throw new AuditStopped('robots_unavailable');
 const decision=policy.evaluation.decisions[0];
 if(decision.status==='unavailable')throw new AuditStopped('robots_unavailable');
 if(decision.status==='disallowed'){
  await gate(work,async(client,current)=>{
   const coverage=structuredClone(current.coverage);addReason(coverage,'robots_exclusions');
   await client.query("UPDATE site_audit_page SET state='excluded',fetch_state='robots_disallowed',analysis_coverage='robots_disallowed',reasons='[\"robots_disallowed\"]' WHERE id=$1 AND state='pending'",[page.id]);
   await client.query('UPDATE site_audit_run SET coverage=$2 WHERE id=$1',[work.id,coverage]);
  });return null;
 }
 return Math.max(1000,Math.ceil((decision.crawlDelaySeconds??0)*1000));
}
async function dispatch(work:Work,page:Page,intervalMs:number):Promise<Page|null>{
 for(;;){
  const result=await gate(work,async(client,run,at)=>{
   const fresh=(await client.query<Page>("SELECT * FROM site_audit_page WHERE id=$1 AND run_id=$2 AND state='pending'",[page.id,run.id])).rows[0];
   if(!fresh)return {kind:'gone' as const};
   const next=Math.max(run.next_request_at?.getTime()??0,fresh.retry_after_at?.getTime()??0);
   if(next>=run.deadline_at.getTime())return {kind:'stop' as const,reason:'pacing_exceeds_deadline'};
   if(next>at.getTime())return {kind:'wait' as const,ms:Math.min(next-at.getTime(),10000)};
   let limit:string|null=null;
   if(run.request_count>=run.config!.requestLimit)limit='request_limit';
   else if(Number(run.budget_charged_bytes)+capacity[page.resource_kind]>run.config!.bodyCapacityBytes)limit='body_capacity_limit';
   else if(page.resource_kind==='html'&&fresh.attempts_started===0&&run.html_pages_started>=run.config!.maxPages)limit='page_limit';
   else if(page.resource_kind==='sitemap'&&fresh.attempts_started===0&&run.sitemap_documents_started>=run.config!.sitemapDocuments)limit='sitemap_document_limit';
   if(limit)return {kind:'stop' as const,reason:limit};
   if(fresh.attempts_started>=2){await client.query("UPDATE site_audit_page SET state='unavailable',fetch_state='error',analysis_coverage='unavailable',reasons='[\"attempt_limit\"]' WHERE id=$1",[fresh.id]);return {kind:'gone' as const};}
   const attemptId=randomUUID();
   const reserved=(await client.query<Page>(`UPDATE site_audit_page SET state='leased',attempts_started=attempts_started+1,attempt_id=$2,attempt_generation=$3,
    dispatched_at=$4,reserved_bytes=$5,attempt_settled_at=NULL,last_attempt_outcome=NULL WHERE id=$1 RETURNING *`,[fresh.id,attemptId,work.generation,at,capacity[page.resource_kind]])).rows[0];
   await client.query(`UPDATE site_audit_run SET request_count=request_count+1,budget_charged_bytes=budget_charged_bytes+$2,
    html_pages_started=html_pages_started+$3,sitemap_documents_started=sitemap_documents_started+$4,next_request_at=$5,
    phase=$6,heartbeat_at=$7,lease_expires_at=$7::timestamptz+interval '45 seconds' WHERE id=$1`,[run.id,capacity[page.resource_kind],page.resource_kind==='html'&&fresh.attempts_started===0?1:0,
    page.resource_kind==='sitemap'&&fresh.attempts_started===0?1:0,new Date(at.getTime()+intervalMs),page.resource_kind==='robots'?'robots':page.resource_kind==='sitemap'?'discovery':'pages',at]);
   return {kind:'dispatch' as const,page:reserved};
  });
  if(result.kind==='gone')return null;if(result.kind==='stop')throw new AuditStopped(result.reason);
  if(result.kind==='dispatch')return result.page;
  await sleep(result.ms,undefined,{signal:work.controller.signal});
 }
}

async function publish(work:Work,run:AuditRunRow,page:Page,download:CrawlDocumentObservation){
 const prepared=await prepareAuditObservation(page.resource_kind==='html'?{kind:'html',url:page.url,download,crawlDepth:page.link_depth,retainBodyText:run.config?.retainBodyText===true}:page.resource_kind==='robots'?{kind:'robots',url:page.url,download,policyOrigin:run.origin!}:{kind:'sitemap',url:page.url,download},work.controller.signal);
 const discovery=discoveries(run);
 const redirect=!download.headers.challenge&&download.status!==null&&redirectStatuses.has(download.status);
 const transient=download.status===429||!download.headers.challenge&&([500,502,503,504].includes(download.status??0)||!download.complete&&['dns_error','network_error','timeout','incomplete_body'].includes(download.reason));
 const retry=transient&&page.attempts_started<2;
 if(!retry&&redirect){if(download.headers.location)candidate(discovery,run,page,download.headers.location,page.resource_kind,'redirect');else{addReason(discovery.coverage,'redirect_location_unavailable');if(page.resource_kind==='robots')discovery.robotsFailure='robots_redirect_unavailable';}}
 if(!retry&&prepared.status==='prepared'&&prepared.kind==='html'){
  for(const link of prepared.links)candidate(discovery,run,page,link.url,'html','link',link.nofollow,link.anchor);
  if(prepared.analysis.coverage!=='analyzed'&&prepared.analysis.coverage!=='redirect'&&prepared.analysis.coverage!=='non_html')addReason(discovery.coverage,'page_coverage_incomplete');
  if((prepared.analysis.facts?.unresolvedLinks??0)>0||prepared.analysis.reasons.length)addReason(discovery.coverage,'page_analysis_incomplete');
 }else if(!retry&&prepared.status==='prepared'&&prepared.kind==='sitemap'){
  for(const item of prepared.analysis.entries)candidate(discovery,run,page,item.url,prepared.analysis.kind==='sitemapindex'?'sitemap':'html','sitemap');
  if(prepared.analysis.status!=='complete')addReason(discovery.coverage,'sitemap_incomplete');
 }
 let stop:string|null=null;
 await gate(work,async(client,current,at)=>{
  const owned=(await client.query('SELECT 1 FROM site_audit_page WHERE id=$1 AND run_id=$2 AND state=\'leased\' AND attempt_id=$3 AND attempt_generation=$4',[page.id,work.id,page.attempt_id,work.generation])).rowCount;
  if(!owned)throw new AuditStopped('attempt_lost');
  const bytes=Math.max(download.wireBytes,download.httpDecodedBytes,download.decodedBytes);
  const released=download.complete?Math.max(0,page.reserved_bytes!-bytes):0;
  const pace=planAuditRequest({nowMs:at.getTime(),nextRequestAtMs:current.next_request_at?.getTime()??null,deadlineMs:current.deadline_at.getTime(),retryAfter:download.headers.retryAfter});
  if(pace.status!=='ready')stop='pacing_exceeds_deadline';
  if(bytes>page.reserved_bytes!)stop='body_capacity_exceeded';
  if(pace.status!=='invalid_input'&&pace.retryAfter==='malformed')addReason(discovery.coverage,'retry_after_malformed');
  const analysis=prepared.status==='prepared'&&prepared.kind==='html'?prepared.analysis:null;
  const evidence=prepared.status==='prepared'&&prepared.kind==='html'?prepared.evidence:null;
  const body=(!retry||stop!==null)&&page.resource_kind==='html'&&current.config?.retainBodyText===true?analysis?.bodyCapture??{state:'unavailable',version:crawlBodyVersion,text:null}:null;
  const failed=prepared.status==='unavailable';
  const robotsAbsent=page.resource_kind==='robots'&&!download.headers.challenge&&[404,410].includes(download.status??0);
  if(failed&&!redirect&&!retry&&!robotsAbsent){addReason(discovery.coverage,page.resource_kind==='sitemap'?'sitemap_unavailable':'page_coverage_incomplete');if(page.resource_kind==='sitemap')discovery.coverage.sitemapUnavailable=(discovery.coverage.sitemapUnavailable??0)+1;}
  const fetchState=prepared.status==='prepared'&&prepared.kind==='html'?prepared.fetchState:failed?'error':'ok';
  const reasons=failed?[prepared.reason]:analysis?.reasons??[];
  await client.query(`UPDATE site_audit_page SET state=$2,attempt_settled_at=$3,last_attempt_outcome=$4,observed_at=$3,http_status=$5,
   fetch_state=$6,analysis_coverage=$7,reasons=$8,response_time_ms=$9,facts=$10,evidence=$11,evidence_recorded=$12,evidence_truncated=$13,retry_after_at=$14,body_capture_state=$15,body_extraction_version=$16,body_text=$17 WHERE id=$1`,
   [page.id,retry&&!stop?'pending':failed&&!redirect?'unavailable':'done',at,download.complete?'complete':'failed',download.status,
    retry?'not_fetched':fetchState,retry?'not_fetched':analysis?.coverage??(redirect?'redirect':failed?'unavailable':'non_html'),JSON.stringify(reasons),Math.round(download.durationMs),
    retry?null:analysis?.facts??null,retry?null:evidence,!retry&&evidence!==null,!retry&&prepared.status==='prepared'&&prepared.kind==='html'&&prepared.evidenceTruncated,
    pace.status==='ready'?new Date(pace.nextRequestAtMs!):null,body?.state??'not_recorded',body?.version??null,body?.text??null]);
  await client.query(`UPDATE site_audit_run SET budget_charged_bytes=budget_charged_bytes-$2,wire_bytes=wire_bytes+$3,http_decoded_bytes=http_decoded_bytes+$4,decoded_bytes=decoded_bytes+$5,
   next_request_at=CASE WHEN $6::timestamptz IS NULL THEN next_request_at ELSE greatest(next_request_at,$6) END WHERE id=$1`,[work.id,released,download.wireBytes,download.httpDecodedBytes,download.decodedBytes,pace.status==='ready'?new Date(pace.nextRequestAtMs!):null]);
  if(!retry&&analysis?.findings.length){
   const findings=analysis.findings.map(f=>({id:randomUUID(),key:digest(`${analysis.ruleVersion}:${f.code}:${page.id}`),code:f.code,severity:f.severity,details:f.details}));
   await client.query(`INSERT INTO site_audit_issue(id,run_id,page_id,issue_key,rule_version,code,severity,details)
    SELECT x.id,$1,$2,x.key,'static-html-v1',x.code,x.severity,x.details FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,key text,code text,severity text,details jsonb) ON CONFLICT(run_id,issue_key) DO NOTHING`,[work.id,page.id,JSON.stringify(findings)]);
  }
  if(evidence!==null&&!retry)discovery.coverage.rawEvidenceRecorded=true;
  if(!retry&&page.resource_kind==='robots'&&!redirect){
   const valid=prepared.status==='prepared'&&prepared.kind==='robots'&&prepared.evaluation.policyStatus==='ready'&&download.complete;
   if(robotsAbsent||valid){
    const evaluation=prepared.status==='prepared'&&prepared.kind==='robots'?prepared.evaluation:null;
    await client.query(`UPDATE site_audit_run SET robots_state=$2,robots_body=$3,robots_digest=$4,robots_fetched_at=$5 WHERE id=$1`,[work.id,robotsAbsent?'absent':'present',valid&&download.complete?download.body:null,valid?evaluation!.digest:null,at]);
    if(valid)discovery.coverage.rawEvidenceRecorded=true;
    const interval=Math.max(1000,Math.ceil((evaluation?.crawlDelaySeconds??0)*1000));
    await client.query('UPDATE site_audit_run SET next_request_at=greatest(next_request_at,$2) WHERE id=$1',[work.id,new Date(at.getTime()+interval)]);
    candidate(discovery,run,page,`${run.origin}/sitemap.xml`,'sitemap','sitemap');
    for(const url of evaluation?.sitemaps??[])candidate(discovery,run,page,url,'sitemap','sitemap');
   }else discovery.robotsFailure='robots_unavailable';
  }
  await publishDiscovery(client,current,page,discovery);
  if(discovery.robotsFailure){stop=discovery.robotsFailure;await client.query("UPDATE site_audit_run SET robots_state='unavailable' WHERE id=$1",[work.id]);}
 });
 if(stop)throw new AuditStopped(stop);
}

async function finalize(work:Work,stopReason:string|null){
 const snapshot=await gate(work,async(client,run)=>{
  const coverage=structuredClone(run.coverage);if(stopReason)addReason(coverage,stopReason);
  const pending=Number((await client.query("SELECT count(*) AS n FROM site_audit_page WHERE run_id=$1 AND state IN('pending','leased')",[run.id])).rows[0].n);
  coverage.unfetchedPages=Number((await client.query("SELECT count(*) AS n FROM site_audit_page WHERE run_id=$1 AND resource_kind='html' AND attempts_started=0",[run.id])).rows[0].n);
  coverage.unavailablePages=Number((await client.query("SELECT count(*) AS n FROM site_audit_page WHERE run_id=$1 AND resource_kind='html' AND analysis_coverage IN('unavailable','blocked','rate_limited','partial','shell','not_fetched')",[run.id])).rows[0].n);
  if(pending)addReason(coverage,'frontier_incomplete');
  coverage.discoveryComplete=!stopReason&&!pending&&!coverage.reasons.length;
  coverage.linksComplete=coverage.discoveryComplete;
  await client.query("UPDATE site_audit_run SET phase='finalizing',coverage=$2 WHERE id=$1",[run.id,coverage]);
  const pages=(await client.query<Pick<Page,'id'|'http_status'|'fetch_state'|'analysis_coverage'|'facts'|'discovered_start'|'discovered_link'|'discovered_sitemap'|'attempts_started'>>(`SELECT id,http_status,fetch_state,analysis_coverage,facts,
   discovered_start,discovered_link,discovered_sitemap,attempts_started FROM site_audit_page WHERE run_id=$1 AND resource_kind='html' ORDER BY id LIMIT 10000`,[run.id])).rows;
  const edges=(await client.query<{sourceId:string;kind:string;targetId:string|null;internal:boolean}>(`SELECT e.source_page_id AS "sourceId",e.kind,p.id AS "targetId",
   left(e.target_url,length($2)+1)=$2||'/' AS internal FROM site_audit_edge e
   JOIN site_audit_page s ON s.run_id=e.run_id AND s.id=e.source_page_id AND s.resource_kind='html'
   LEFT JOIN site_audit_page p ON p.run_id=e.run_id AND p.resource_kind='html' AND p.url=e.target_url
   WHERE e.run_id=$1 AND e.kind IN('link','redirect') ORDER BY e.id LIMIT 100000`,[run.id,run.origin])).rows;
  return {run,coverage,pages,edges};
 });
 const redirects=new Map(snapshot.edges.filter(e=>e.kind==='redirect').map(e=>[e.sourceId,e]));
 const pages:GraphPage[]=snapshot.pages.map(p=>({id:p.id,status:p.http_status,fetchState:p.fetch_state,analysis:{ruleVersion:'static-html-v1',coverage:p.analysis_coverage,facts:p.facts},
  sitemapOnly:p.discovered_sitemap&&!p.discovered_link&&!p.discovered_start,redirect:p.analysis_coverage!=='redirect'?null:redirects.get(p.id)?.targetId?{kind:'page',targetId:redirects.get(p.id)!.targetId!}:redirects.get(p.id)?.internal===false?{kind:'outside_scope'}:{kind:'unresolved'}}));
 const analyzed=new Set(pages.filter(p=>p.analysis.coverage==='analyzed').map(p=>p.id));
 const graph=analyzeCrawlGraph({startPageId:snapshot.pages.find(p=>p.discovered_start)!.id,pages,
  links:snapshot.edges.filter(e=>e.kind==='link'&&e.targetId&&analyzed.has(e.sourceId)).map(e=>({sourceId:e.sourceId,targetId:e.targetId!})),
  coverage:{runComplete:!stopReason,discoveryComplete:snapshot.coverage.discoveryComplete,linksComplete:snapshot.coverage.linksComplete,dataState:'available'}});
 await gate(work,async(client,run,at)=>{
  if(run.phase!=='finalizing')throw new AuditStopped('phase_changed');
  await client.query("DELETE FROM site_audit_issue WHERE run_id=$1 AND rule_version='static-graph-v1'",[run.id]);
  const findings=graph.findings.map(f=>({id:randomUUID(),key:digest(f.key),code:f.code,severity:f.severity,pageId:f.pageId,targetPageId:f.targetPageId,related:f.relatedPageIds,details:f.details}));
  if(findings.length)await client.query(`INSERT INTO site_audit_issue(id,run_id,page_id,target_page_id,issue_key,rule_version,code,severity,details,related_page_ids)
   SELECT x.id,$1,x."pageId",x."targetPageId",x.key,'static-graph-v1',x.code,x.severity,x.details,x.related FROM jsonb_to_recordset($2::jsonb)
   AS x(id uuid,"pageId" uuid,"targetPageId" uuid,key text,code text,severity text,details jsonb,related jsonb)`,[run.id,JSON.stringify(findings)]);
  const counts=(await client.query<{severity:'critical'|'warning'|'info';n:string;page_n:string}>('SELECT severity,count(*) AS n,count(*) FILTER(WHERE rule_version=\'static-html-v1\') AS page_n FROM site_audit_issue WHERE run_id=$1 GROUP BY severity',[run.id])).rows;
  const {findings:_findings,...graphSummary}=graph;
  const summary:AuditSummary={pagesObserved:snapshot.pages.filter(p=>p.attempts_started>0).length,pagesAnalyzed:snapshot.pages.filter(p=>p.analysis_coverage==='analyzed').length,htmlPagesDiscovered:pages.length,
   issuesDetected:counts.reduce((n,c)=>n+Number(c.page_n),0)+graph.counts.findings,issuesRetained:counts.reduce((n,c)=>n+Number(c.n),0),findingsComplete:graph.findingsComplete,
   retainedBySeverity:{critical:0,warning:0,info:0},graph:graphSummary};
  for(const c of counts)summary.retainedBySeverity[c.severity]=Number(c.n);
  const complete=snapshot.coverage.discoveryComplete&&snapshot.coverage.linksComplete&&graph.status==='complete';
  await client.query(`UPDATE site_audit_run SET status=$2,phase=NULL,completed_at=$3,stop_reason=$4,summary=$5,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,[run.id,complete?'completed':'partial',at,stopReason,summary]);
 });
}

async function runAudit(work:Work,initial:AuditRunRow){
 const timer=setTimeout(()=>abort(work,'deadline_exceeded'),Math.max(1,initial.deadline_at.getTime()-Date.now()));timer.unref();
 let renewal:Promise<unknown>|undefined;
 const heartbeat=setInterval(()=>{if(!renewal)renewal=gate(work,async(client,run,at)=>client.query('UPDATE site_audit_run SET heartbeat_at=$2,lease_expires_at=$2::timestamptz+interval \'45 seconds\' WHERE id=$1',[run.id,at])).catch(error=>abort(work,error instanceof AuditStopped?error.reason:'lease_renewal_failed')).finally(()=>{renewal=undefined;});},10000);heartbeat.unref();
 try{
  let stopReason:string|null=null;
  for(;;){
   const {run,page}=await nextPage(work);if(!page)break;
   const interval=await robotsPermission(work,run,page);if(interval===null)continue;
   let dispatched:Page|null;
   try{dispatched=await dispatch(work,page,interval);}catch(error){if(error instanceof AuditStopped&&['page_limit','sitemap_document_limit','request_limit','body_capacity_limit','pacing_exceeds_deadline'].includes(error.reason)){stopReason=error.reason;break;}throw error;}
   if(!dispatched)continue;
   const download=await fetchCrawlDocument(dispatched.url,dispatched.resource_kind,work.controller.signal);
   try{await publish(work,run,dispatched,download);}catch(error){if(error instanceof AuditStopped&&['body_capacity_exceeded','pacing_exceeds_deadline'].includes(error.reason)){stopReason=error.reason;break;}throw error;}
  }
  await finalize(work,stopReason);
 }catch(error){work.reason??=error instanceof AuditStopped?error.reason:work.controller.signal.aborted?'interrupted':'worker_error';}
 finally{
  clearTimeout(timer);clearInterval(heartbeat);work.controller.abort();await renewal;
  await withAuditLock({runId:work.id,internal:true},async({client,run})=>{
   if(!run)return;
   const at=await now(client);
   // Cancellation increments the generation, but only the retained owner may acknowledge drain.
   if(run.status==='cancelling'&&run.lease_owner===work.owner){await terminal(client,run,at,run.stop_reason??'cancelled');return;}
   if(run.status!=='running'||!ownedBy(run,work))return;
   if(stopping&&work.reason==='worker_shutdown'){
    await settleAbandoned(client,run.id,at,'unknown');
    await client.query("UPDATE site_audit_run SET status='queued',phase=NULL,generation=generation+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[run.id]);
   }else await terminal(client,run,at,work.reason??'interrupted');
  }).catch(()=>console.error('Audit cleanup could not finish; its lease will expire.'));
 }
}

export async function executeSiteAudit(input:{runId:unknown;jobId:unknown}):Promise<void>{
 if(stopping||typeof input?.runId!=='string'||typeof input?.jobId!=='string'||!uuid.test(input.runId)||!uuid.test(input.jobId)||active.has(input.runId))return;
 const runId=input.runId,jobId=input.jobId;
 const work:Work={id:runId,owner:randomUUID(),generation:'0',controller:new AbortController(),reason:null,task:Promise.resolve()};
 active.set(runId,work);
 work.task=(async()=>{const run=await claim(runId,jobId,work.owner);if(!run)return;work.generation=run.generation;if(stopping)abort(work,'worker_shutdown');await runAudit(work,run);})();
 try{await work.task;}finally{if(active.get(runId)===work)active.delete(runId);}
}

export async function reconcileSiteAudits(){
 if(stopping)return;
 const candidates=(await getDatabase().pool.query<{id:string}>("SELECT id FROM site_audit_run WHERE status IN('queued','running','cancelling') ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END,created_at,id LIMIT 20")).rows;
 if(!candidates.length)return;const boss=await getBoss();
 for(const candidate of candidates)await withAuditLock({runId:candidate.id,internal:true,claim:true},async({client,run})=>{
  if(!run||!['queued','running','cancelling'].includes(run.status))return;
  const at=await now(client),authority=await auditAuthorityCurrent(client,run);
  const expired=run.deadline_at.getTime()<=at.getTime(),leaseLive=run.lease_expires_at!==null&&run.lease_expires_at.getTime()>at.getTime();
  if(run.status==='cancelling'||expired||!authority.allowed){
   const reason=run.stop_reason??(expired?'deadline_exceeded':!authority.allowed?authority.reason:'cancelled');
   if(run.status!=='queued'&&leaseLive){
    if(run.status!=='cancelling')await client.query("UPDATE site_audit_run SET status='cancelling',generation=generation+1,stop_reason=$2 WHERE id=$1",[run.id,reason]);
    const local=active.get(run.id);if(local)abort(local,reason);
   }else await terminal(client,run,at,reason);
   return;
  }
  if(leaseLive)return;
  if(run.status==='queued'){
   if((await client.query("SELECT 1 FROM site_audit_run WHERE status IN('running','cancelling') LIMIT 1")).rowCount)return;
   if((await client.query("SELECT id FROM site_audit_run WHERE status='queued' AND deadline_at>$1 ORDER BY created_at,id LIMIT 1",[at])).rows[0]?.id!==run.id)return;
  }
  // Pinned pg-boss 12: repair only a missing/terminal wakeup, or a worker whose app lease expired.
  const job=(await client.query('SELECT state FROM pgboss.job WHERE id=$1 AND name=$2',[run.queue_job_id,siteAuditQueue])).rows[0];
  if(job&&['created','retry'].includes(job.state))return;
  if(job?.state==='active'&&run.status==='queued')return;
  const jobId=randomUUID();
  const sent=await boss.send(siteAuditQueue,{runId:run.id},{id:jobId,retryLimit:0,expireInSeconds:2100,db:{executeSql:(text,values)=>client.query(text,values)}});
  if(!sent)throw new Error('Audit wakeup unavailable.');
  await client.query('UPDATE site_audit_run SET queue_job_id=$2,generation=generation+1 WHERE id=$1',[run.id,jobId]);
 });
}
export async function startSiteAuditWorker(boss:PgBoss){
 stopping=false;await reconcileSiteAudits();
 await boss.work<{runId:string}>(siteAuditQueue,{batchSize:1},async jobs=>{for(const job of jobs)await executeSiteAudit({runId:job.data?.runId,jobId:job.id});});
}
export async function stopSiteAudits(){
 stopping=true;for(const work of active.values())abort(work,'worker_shutdown');
 await Promise.allSettled([...active.values()].map(work=>work.task));
}
