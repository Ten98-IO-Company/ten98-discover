import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {normalizePublicHostname} from './domains.ts';
import {getBoss} from './jobs.ts';
import {resolveAuditCandidate} from './site-audit-policy.ts';
import {markSiteAuditReadExpiry} from './site-audit-retention.ts';
import type {CrawlFacts,CrawlCoverage,CrawlPageInput} from './crawl-analysis.ts';

export const siteAuditQueue='site-audit';
export const siteAuditLimits=Object.freeze({defaultPages:50,maxPages:1000,maxMinutes:30,requestsPerSecond:1,bodyCapacityBytes:524288000,frontier:10000,edges:100000,sitemapDocuments:20,sitemapDepth:3});
export type AuditRole='owner'|'admin'|'editor'|'viewer';
export type AuditStatus='queued'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled';
export type AuditConfig={mode:'static';startPath:string;startUrl:string;maxPages:number;requestLimit:number;bodyCapacityBytes:number;frontierLimit:number;edgeLimit:number;sitemapDocuments:number;sitemapDepth:number;minIntervalMs:number;maxAttempts:2;userAgent:'TenMonitorBot/1.0';robotsProductToken:'TenMonitorBot'};
export type AuditCoverage={reasons:string[];discoveryComplete:boolean;linksComplete:boolean;scopeExclusions:number;rawEvidenceRecorded:boolean;queryExclusions?:number;externalExclusions?:number;frontierOmissions?:number;edgeOmissions?:number;sitemapUnavailable?:number;unavailablePages?:number;unfetchedPages?:number};
export type AuditSummary={pagesObserved:number;pagesAnalyzed:number;htmlPagesDiscovered:number;issuesDetected:number;issuesRetained:number;findingsComplete:boolean;retainedBySeverity:{critical:number;warning:number;info:number};graph:Omit<import('./crawl-graph.ts').CrawlGraphResult,'findings'>};
export type AuditRunRow={
 id:string;workspace_id:string;project_id:string;user_id:string;request_id:string;request_hash:string;domain_id:string|null;origin:string|null;
 domain_hostname:string|null;domain_verified_at:Date|null;domain_revision:string|null;config:AuditConfig|null;rule_version:'static-html-v1';
 status:AuditStatus;phase:'robots'|'discovery'|'pages'|'finalizing'|null;stop_reason:string|null;created_at:Date;started_at:Date|null;completed_at:Date|null;deadline_at:Date;
 queue_job_id:string;generation:string;lease_owner:string|null;lease_expires_at:Date|null;heartbeat_at:Date|null;cancel_requested_at:Date|null;next_request_at:Date|null;
 request_count:number;html_pages_started:number;sitemap_documents_started:number;frontier_count:number;edge_count:number;
 budget_charged_bytes:string;wire_bytes:string;http_decoded_bytes:string;decoded_bytes:string;coverage:AuditCoverage;summary:AuditSummary|null;
 robots_state:'pending'|'present'|'absent'|'unavailable';robots_body:Buffer|null;robots_digest:string|null;robots_fetched_at:Date|null;
 raw_expired_at:Date|null;raw_cleanup_completed_at:Date|null;data_expired_at:Date|null;data_cleanup_completed_at:Date|null;deleted_at:Date|null;
};
export type AuditProject={id:string;workspaceId:string;origin:string};
export type AuditLock={client:PoolClient;project:AuditProject;run:AuditRunRow|null;role:AuditRole|null};
type ActorTarget={projectId:string;runId?:string;actor:{userId:string;permission:'read'|'manage'}};
type InternalTarget={runId:string;internal:true;claim?:true};
const managers=['owner','admin'];
const active=['queued','running','cancelling'];
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the audit fields and try again.');return result.data;}
const missing=()=>new FoundationError(404,'Audit or project not found or unavailable.');
const gone=()=>new FoundationError(410,'This audit was deleted. Use a new request to start another audit.');
function managed(role:AuditRole|null){return role!==null&&managers.includes(role);}
function iso(date:Date|null){return date?.toISOString()??null;}
function safeCount(value:string|number){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid audit counter.');return n;}

export function withAuditLock<T>(target:ActorTarget,operation:(locked:AuditLock)=>Promise<T>):Promise<T>;
export function withAuditLock<T>(target:InternalTarget,operation:(locked:AuditLock)=>Promise<T>):Promise<T|null>;
/** Short shared W → P → run gate. No network, parser or timer work belongs in its callback. */
export async function withAuditLock<T>(target:ActorTarget|InternalTarget,operation:(locked:AuditLock)=>Promise<T>):Promise<T|null>{
 const internal='internal' in target;
 const runId=target.runId===undefined?undefined:parse(z.uuid(),target.runId);
 const actor=internal?null:{userId:parse(z.uuid(),target.actor.userId),permission:target.actor.permission};
 const read=actor?.permission==='read';
 const client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN');
  // ponytail: one global claim gate matches the initial one-active-run installation limit.
  if(internal&&target.claim)await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ten98.site-audit.claim.v1',0))");
  const projectId=internal?(await client.query('SELECT project_id FROM site_audit_run WHERE id=$1',[runId])).rows[0]?.project_id:parse(z.uuid(),target.projectId);
  const hint=projectId?(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0]:null;
  if(!hint){if(internal){await client.query('COMMIT');return null;}throw missing();}
  const lock=read?'SHARE':'UPDATE';
  const workspace=await client.query(`SELECT id FROM workspace WHERE id=$1 FOR ${lock}`,[hint.workspace_id]);
  const project=(await client.query<AuditProject>(`SELECT id,workspace_id AS "workspaceId",origin FROM project WHERE id=$1 AND workspace_id=$2 FOR ${lock}`,[projectId,hint.workspace_id])).rows[0];
  if(!workspace.rowCount||!project){if(internal){await client.query('COMMIT');return null;}throw missing();}
  let role:AuditRole|null=null;
  if(actor){role=(await client.query<{role:AuditRole}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[project.workspaceId,actor.userId])).rows[0]?.role??null;
   if(role===null)throw missing();if(actor.permission==='manage'&&!managed(role))throw new FoundationError(403,'Only a workspace owner or admin can manage audits.');}
  // Reads can latch expiry: lock the run for UPDATE initially, never upgrade SHARE.
  const run=runId?(await client.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[runId,project.id])).rows[0]??null:null;
  if(runId&&!run){if(internal){await client.query('COMMIT');return null;}throw missing();}
  if(actor&&run)Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);
  const result=await operation({client,project,run,role});await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

/** Caller already holds W/P/run. Refusal must permit safe terminalization after revocation. */
export async function auditAuthorityCurrent(client:PoolClient,run:AuditRunRow):Promise<{allowed:true}|{allowed:false;reason:'permission_changed'|'scope_changed'}>{
 const role=(await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[run.workspace_id,run.user_id])).rows[0]?.role;
 if(!managers.includes(role))return {allowed:false,reason:'permission_changed'};
 const result=await client.query(`SELECT 1 FROM site_audit_run r JOIN project p ON p.id=r.project_id AND p.workspace_id=r.workspace_id
  WHERE r.id=$1 AND r.deleted_at IS NULL AND ((r.domain_id IS NULL AND p.origin=r.origin) OR
   EXISTS(SELECT 1 FROM project_domain d WHERE d.id=r.domain_id AND d.project_id=r.project_id AND d.role='serving'
    AND d.revoked_at IS NULL AND d.verified_at IS NOT NULL AND d.hostname=r.domain_hostname
    AND d.verified_at=r.domain_verified_at AND d.redirect_revision=r.domain_revision AND 'https://'||d.hostname=r.origin))`,[run.id]);
 return result.rowCount?{allowed:true}:{allowed:false,reason:'scope_changed'};
}

function publicHttpsOrigin(value:string):string|null{
 try{const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||u.origin!==value)return null;return normalizePublicHostname(u.hostname)===u.hostname?u.origin:null;}catch{return null;}
}

export function auditRunDto(run:AuditRunRow,role:AuditRole|null){
 if(run.deleted_at)throw gone();if(!run.config||!run.origin)throw new Error('Audit configuration unavailable.');
 return {id:run.id,projectId:run.project_id,domainId:run.domain_id,origin:run.origin,config:run.config,status:run.status,phase:run.phase,
  createdAt:run.created_at.toISOString(),startedAt:iso(run.started_at),completedAt:iso(run.completed_at),deadlineAt:run.deadline_at.toISOString(),
  stopReason:run.stop_reason,coverage:run.coverage,summary:run.summary,progress:{requests:run.request_count,htmlPagesStarted:run.html_pages_started,
   sitemapDocumentsStarted:run.sitemap_documents_started,frontier:run.frontier_count,edges:run.edge_count,bodyCapacityChargedBytes:safeCount(run.budget_charged_bytes),
   observedWireBytes:safeCount(run.wire_bytes),observedHttpDecodedBytes:safeCount(run.http_decoded_bytes),observedDecodedBytes:safeCount(run.decoded_bytes)},
  dataStatus:run.data_expired_at?'expired' as const:'available' as const,rawEvidenceStatus:run.raw_expired_at?'expired' as const:run.coverage.rawEvidenceRecorded?'available' as const:'not_recorded' as const,
  rawExpiredAt:iso(run.raw_expired_at),dataExpiredAt:iso(run.data_expired_at),canCancel:managed(role)&&active.includes(run.status),canDelete:managed(role)&&!active.includes(run.status)};
}
export async function getSiteAuditSetup(projectId:string,userId:string){
 return withAuditLock({projectId,actor:{userId,permission:'read'}},async({client,project,role})=>{
  const origins:{domainId:string|null;origin:string;authority:'canonical_project'|'verified_serving'}[]=[];
  const canonical=publicHttpsOrigin(project.origin);if(canonical)origins.push({domainId:null,origin:canonical,authority:'canonical_project'});
  const domains=await client.query("SELECT id,hostname FROM project_domain WHERE project_id=$1 AND role='serving' AND verified_at IS NOT NULL AND revoked_at IS NULL ORDER BY hostname,id",[project.id]);
  for(const row of domains.rows){const origin=publicHttpsOrigin(`https://${row.hostname}`);if(origin&&origin!==canonical)origins.push({domainId:row.id,origin,authority:'verified_serving'});}
  const worker=(await client.query("SELECT last_seen_at AS at,last_seen_at>clock_timestamp()-interval '30 seconds' AS recent FROM worker_heartbeat WHERE id='foundation-worker'")).rows[0];
  return {role:role!,canStart:managed(role)&&origins.length>0,mode:'static' as const,origins,limits:siteAuditLimits,
   worker:{status:worker?.recent?'ready' as const:'unavailable' as const,lastHeartbeatAt:worker?.at?.toISOString()??null}};
 });
}
const startInput=z.object({requestId:z.uuid(),domainId:z.uuid().nullable(),startPath:z.string().min(1).max(2048),maxPages:z.number().int().min(1).max(1000).default(50),mode:z.literal('static')}).strict();
export function parseSiteAuditStart(raw:unknown){
 const input=parse(startInput,raw);
 if(!input.startPath.startsWith('/')||input.startPath.startsWith('//')||input.startPath.includes('#'))throw new FoundationError(400,'Use a query-free rooted start path.');
 const candidate=resolveAuditCandidate(input.startPath,'https://example.com/','https://example.com');
 if(candidate.status!=='accepted')throw new FoundationError(400,'Use a valid query-free start path.');
 return {...input,startPath:new URL(candidate.url).pathname};
}
function intentHash(input:ReturnType<typeof parseSiteAuditStart>){return createHash('sha256').update(JSON.stringify({version:1,mode:input.mode,domainId:input.domainId,startPath:input.startPath,maxPages:input.maxPages})).digest('hex');}
async function priorStart(client:PoolClient,projectId:string,userId:string,input:ReturnType<typeof parseSiteAuditStart>,role:AuditRole|null){
 const prior=(await client.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE project_id=$1 AND user_id=$2 AND request_id=$3 FOR UPDATE',[projectId,userId,input.requestId])).rows[0];
 if(!prior)return null;if(prior.request_hash!==intentHash(input))throw new FoundationError(409,'This request ID was already used for a different audit. Use a new request ID.');
 Object.assign(prior,(await markSiteAuditReadExpiry(client,projectId,[prior.id]))[0]);
 return {created:false,role:role!,run:auditRunDto(prior,role)};
}
async function selectedOrigin(client:PoolClient,project:AuditProject,domainId:string|null){
 if(domainId===null){const origin=publicHttpsOrigin(project.origin);if(!origin)throw new FoundationError(400,'Select a public HTTPS origin for this audit.');return {origin,hostname:null,verified:null,revision:null};}
 const row=(await client.query<{hostname:string;verified:string;revision:string}>("SELECT hostname,verified_at::text AS verified,redirect_revision::text AS revision FROM project_domain WHERE id=$1 AND project_id=$2 AND role='serving' AND verified_at IS NOT NULL AND revoked_at IS NULL",[domainId,project.id])).rows[0];
 if(!row)throw new FoundationError(404,'Serving domain not found or unavailable.');const origin=publicHttpsOrigin(`https://${row.hostname}`);
 if(!origin||origin===project.origin)throw new FoundationError(400,'Select the canonical project origin for this hostname.');return {...row,origin};
}
export async function startSiteAudit(projectId:string,userId:string,raw:unknown){
 const input=parseSiteAuditStart(raw),target={projectId,actor:{userId,permission:'manage' as const}};
 // Replays and denied roles do not initialize the queue. The insertion rechecks everything after startup.
 const prior=await withAuditLock(target,({client,role})=>priorStart(client,projectId,userId,input,role));if(prior)return prior;
 const boss=await getBoss();
 return withAuditLock(target,async({client,project,role})=>{
  const replay=await priorStart(client,project.id,userId,input,role);if(replay)return replay;
  const selected=await selectedOrigin(client,project,input.domainId);
  const candidate=resolveAuditCandidate(input.startPath,`${selected.origin}/`,selected.origin);
  if(candidate.status!=='accepted')throw new FoundationError(400,'Use a valid query-free start path on the selected origin.');
  if((await client.query("SELECT 1 FROM site_audit_run WHERE workspace_id=$1 AND status IN('queued','running','cancelling')",[project.workspaceId])).rowCount)throw new FoundationError(409,'This workspace already has an active audit. Wait or cancel it first.');
  const config:AuditConfig={mode:'static',startPath:input.startPath,startUrl:candidate.url,maxPages:input.maxPages,requestLimit:3*input.maxPages+100,bodyCapacityBytes:siteAuditLimits.bodyCapacityBytes,
   frontierLimit:siteAuditLimits.frontier,edgeLimit:siteAuditLimits.edges,sitemapDocuments:20,sitemapDepth:3,minIntervalMs:1000,maxAttempts:2,userAgent:'TenMonitorBot/1.0',robotsProductToken:'TenMonitorBot'};
  const runId=randomUUID(),jobId=randomUUID();
  const result=await client.query<AuditRunRow>(`WITH stamp AS (SELECT clock_timestamp() AS at)
   INSERT INTO site_audit_run(id,workspace_id,project_id,user_id,request_id,request_hash,domain_id,origin,domain_hostname,domain_verified_at,domain_revision,config,created_at,deadline_at,queue_job_id,frontier_count)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,at,at+interval '30 minutes',$13,2 FROM stamp RETURNING *`,
   [runId,project.workspaceId,project.id,userId,input.requestId,intentHash(input),input.domainId,selected.origin,selected.hostname,selected.verified,selected.revision,JSON.stringify(config),jobId]);
  await client.query(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,discovered_start,link_depth)
   VALUES($1,$2,$3,'html',$4,true,0),($5,$2,$3,'robots',$6,false,NULL)`,[randomUUID(),runId,project.id,candidate.url,randomUUID(),`${selected.origin}/robots.txt`]);
  const sent=await boss.send(siteAuditQueue,{runId},{id:jobId,retryLimit:0,expireInSeconds:2100,db:{executeSql:(text,values)=>client.query(text,values)}});
  if(sent!==jobId)throw new FoundationError(503,'The audit could not be queued. Retry the same request.');
  return {created:true,role:role!,run:auditRunDto(result.rows[0],role)};
 });
}
const pageSchema=z.object({v:z.literal(1),scope:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),id:z.uuid()}).strict();
function cursorScope(scope:unknown){return createHash('sha256').update(JSON.stringify(scope)).digest('hex');}
function cursor(value:string|null,scope:unknown){
 if(value===null)return null;if(value.length>512||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))throw new FoundationError(400,'Reload this audit list.');
 let raw:unknown;try{raw=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new FoundationError(400,'Reload this audit list.');}
 const input=parse(pageSchema,raw);if(input.scope!==cursorScope(scope))throw new FoundationError(400,'This cursor belongs to different audit filters.');return input.id;
}
function nextCursor(id:string|undefined,scope:unknown){return id?Buffer.from(JSON.stringify({v:1,scope:cursorScope(scope),id})).toString('base64url'):null;}
const coverages=['unavailable','blocked','rate_limited','robots_disallowed','not_fetched','http_error','redirect','non_html','partial','shell','analyzed'];
const issueCodes=new Set(['blocked-page','rate-limited-page','server-error','broken-page','slow-response','noindex-page','canonical-conflict','canonicalized-page','deep-page','javascript-rendering-suspected','missing-title','title-too-long','title-too-short','missing-meta-description','meta-description-too-long','meta-description-too-short','missing-h1','multiple-h1','heading-order-skip','thin-content','images-missing-alt','no-outgoing-links','duplicate-title','duplicate-meta-description','duplicate-content','redirect-chain','redirect-loop','broken-internal-link','orphan-page']);
export function parseAuditListQuery(params:URLSearchParams,kind:'runs'|'pages'|'issues'|'links'){
 const extra=kind==='pages'?['coverage','resourceKind']:kind==='issues'?['code','severity','pageId']:kind==='links'?['direction']:[];
 if([...params.keys()].some(key=>!['cursor','limit',...extra].includes(key)||params.getAll(key).length!==1))throw new FoundationError(400,'Use supported audit filters once each.');
 const rawLimit=params.get('limit');if(rawLimit!==null&&!/^[1-9][0-9]{0,2}$(?![\s\S])/.test(rawLimit))throw new FoundationError(400,'Use a page limit from 1 to 100.');
 const limit=rawLimit===null?50:Number(rawLimit);if(limit>100)throw new FoundationError(400,'Use a page limit from 1 to 100.');
 const coverage=params.get('coverage'),resourceKind=params.get('resourceKind')??'html',code=params.get('code'),severity=params.get('severity'),pageId=params.get('pageId'),direction=params.get('direction')??'out';
 if(coverage!==null&&!coverages.includes(coverage)||!['html','robots','sitemap'].includes(resourceKind)||code!==null&&!issueCodes.has(code)||severity!==null&&!['critical','warning','info'].includes(severity)||pageId!==null&&!z.uuid().safeParse(pageId).success||!['in','out'].includes(direction))throw new FoundationError(400,'Use a supported audit filter.');
 return {limit,cursor:params.get('cursor'),coverage,resourceKind,code,severity,pageId,direction};
}
function requireRun(run:AuditRunRow|null){if(!run)throw missing();if(run.deleted_at)throw gone();return run;}
function actorTarget(projectId:string,userId:string,runId?:string,manage=false):ActorTarget{return {projectId,runId,actor:{userId,permission:manage?'manage':'read'}};}
const runDtoColumns='id,project_id,domain_id,origin,config,status,phase,created_at,started_at,completed_at,deadline_at,stop_reason,coverage,summary,request_count,html_pages_started,sitemap_documents_started,frontier_count,edge_count,budget_charged_bytes,wire_bytes,http_decoded_bytes,decoded_bytes,raw_expired_at,data_expired_at,deleted_at';
export async function listSiteAudits(projectId:string,userId:string,params:URLSearchParams){
 const query=parseAuditListQuery(params,'runs'),scope={projectId,list:'audits'},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId),async({client,role})=>{
  if(before&&!(await client.query('SELECT id FROM site_audit_run WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',[before,projectId])).rowCount)throw new FoundationError(400,'This audit cursor is no longer available.');
  const rows=(await client.query<AuditRunRow>(`SELECT ${runDtoColumns} FROM site_audit_run WHERE project_id=$1 AND deleted_at IS NULL
   AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM site_audit_run WHERE id=$2 AND project_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3 FOR UPDATE`,[projectId,before,query.limit+1])).rows;
  const expired=new Map((await markSiteAuditReadExpiry(client,projectId,rows.map(row=>row.id))).map(row=>[row.id,row]));
  for(const row of rows)Object.assign(row,expired.get(row.id));
  return {role:role!,runs:rows.slice(0,query.limit).map(row=>auditRunDto(row,role)),nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null};
 });
}
export async function getSiteAudit(projectId:string,userId:string,runId:string){return withAuditLock(actorTarget(projectId,userId,runId),async({run,role})=>({role:role!,run:auditRunDto(requireRun(run),role)}));}

type PageRow={id:string;url:string;resource_kind:'html'|'robots'|'sitemap';state:string;discovered_start:boolean;discovered_link:boolean;discovered_sitemap:boolean;link_depth:number|null;sitemap_depth:number;observed_at:Date|null;http_status:number|null;fetch_state:CrawlPageInput['fetchState'];analysis_coverage:CrawlCoverage;reasons:string[];facts:CrawlFacts|null;response_time_ms:number|null;evidence:Record<string,unknown>|null;evidence_recorded:boolean;evidence_truncated:boolean};
const pageColumns='p.id,p.url,p.resource_kind,p.state,p.discovered_start,p.discovered_link,p.discovered_sitemap,p.link_depth,p.sitemap_depth,p.observed_at,p.http_status,p.fetch_state,p.analysis_coverage,p.reasons,p.facts,p.response_time_ms,p.evidence_recorded,p.evidence_truncated';
function pageDto(row:PageRow,run:AuditRunRow,includeEvidence:boolean){
 const rawEvidenceStatus=!row.evidence_recorded?'not_recorded' as const:run.raw_expired_at?'expired' as const:row.evidence_truncated?'truncated' as const:'available' as const;
 return {id:row.id,url:row.url,resourceKind:row.resource_kind,state:row.state,sources:{start:row.discovered_start,link:row.discovered_link,sitemap:row.discovered_sitemap},linkDepth:row.link_depth,sitemapDepth:row.sitemap_depth,
  observedAt:iso(row.observed_at),httpStatus:row.http_status,fetchState:row.fetch_state,analysis:{coverage:row.analysis_coverage,reasons:row.reasons,facts:row.facts},responseTimeMs:row.response_time_ms,
  rawEvidenceStatus,evidenceIncluded:includeEvidence,evidence:includeEvidence&&!run.raw_expired_at?row.evidence:null};
}
async function scopedPage(client:PoolClient,runId:string,pageId:string){
 const id=parse(z.uuid(),pageId);if(!(await client.query('SELECT 1 FROM site_audit_page WHERE id=$1 AND run_id=$2',[id,runId])).rowCount)throw missing();return id;
}
export async function listSiteAuditPages(projectId:string,userId:string,runId:string,params:URLSearchParams){
 const query=parseAuditListQuery(params,'pages'),scope={projectId,runId,list:'pages',coverage:query.coverage,resourceKind:query.resourceKind},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved),envelope={role:role!,run:auditRunDto(run,role)};
  if(run.data_expired_at)return {...envelope,pages:[],nextCursor:null};
  if(before)await scopedPage(client,run.id,before);
  const rows=(await client.query<PageRow>(`SELECT ${pageColumns},NULL AS evidence FROM site_audit_page p WHERE p.run_id=$1 AND p.resource_kind=$2
   AND ($3::text IS NULL OR p.analysis_coverage=$3) AND ($4::uuid IS NULL OR p.id>$4) ORDER BY p.id LIMIT $5`,[run.id,query.resourceKind,query.coverage,before,query.limit+1])).rows;
  return {...envelope,pages:rows.slice(0,query.limit).map(row=>pageDto(row,run,false)),nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null};
 });
}
export async function getSiteAuditPage(projectId:string,userId:string,runId:string,pageId:string){
 parse(z.uuid(),pageId);const result=await withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved);if(run.data_expired_at)return null;
  const page=(await client.query<PageRow>(`SELECT ${pageColumns},CASE WHEN $3::boolean THEN NULL ELSE p.evidence END AS evidence FROM site_audit_page p WHERE p.run_id=$1 AND p.id=$2`,[run.id,pageId,run.raw_expired_at!==null])).rows[0];
  if(!page)throw missing();return {role:role!,run:auditRunDto(run,role),page:pageDto(page,run,true)};
 });
 // Commit the irreversible read marker before reporting expiry to the caller.
 if(result===null)throw new FoundationError(410,'Audit page data expired under this workspace’s retention policy.');
 return result;
}
export async function listSiteAuditIssues(projectId:string,userId:string,runId:string,params:URLSearchParams){
 const query=parseAuditListQuery(params,'issues'),scope={projectId,runId,list:'issues',code:query.code,severity:query.severity,pageId:query.pageId},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved),base={role:role!,run:auditRunDto(run,role),findingsComplete:run.summary?.findingsComplete??false,countBasis:'retained' as const};
  if(run.data_expired_at)return {...base,issues:[],nextCursor:null,matchingRetainedCount:null};
  if(query.pageId)await scopedPage(client,run.id,query.pageId);
  if(before&&!(await client.query('SELECT 1 FROM site_audit_issue WHERE run_id=$1 AND id=$2',[run.id,before])).rowCount)throw new FoundationError(400,'This issue cursor is no longer available.');
  const filter='run_id=$1 AND ($2::text IS NULL OR code=$2) AND ($3::text IS NULL OR severity=$3) AND ($4::uuid IS NULL OR page_id=$4)';
  const values=[run.id,query.code,query.severity,query.pageId];
  const rows=(await client.query(`SELECT id,page_id AS "pageId",target_page_id AS "targetPageId",related_page_ids AS "relatedPageIds",code,severity,rule_version AS "ruleVersion",details
   FROM site_audit_issue WHERE ${filter} AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6`,[...values,before,query.limit+1])).rows;
  const count=active.includes(run.status)?null:(await client.query(`SELECT count(*)::int AS count FROM site_audit_issue WHERE ${filter}`,values)).rows[0].count as number;
  return {...base,issues:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null,matchingRetainedCount:count};
 });
}
export async function listSiteAuditLinks(projectId:string,userId:string,runId:string,pageId:string,params:URLSearchParams){
 parse(z.uuid(),pageId);const query=parseAuditListQuery(params,'links'),scope={projectId,runId,pageId,list:'links',direction:query.direction},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved),base={role:role!,run:auditRunDto(run,role)};
  if(run.data_expired_at)return {...base,links:[],nextCursor:null};
  await scopedPage(client,run.id,pageId);
  if(before&&!(await client.query('SELECT 1 FROM site_audit_edge WHERE run_id=$1 AND id=$2',[run.id,before])).rowCount)throw new FoundationError(400,'This link cursor is no longer available.');
  const rows=(await client.query(`SELECT e.id,e.kind,e.source_page_id AS "sourcePageId",target.id AS "targetPageId",e.target_url AS "targetUrl",e.nofollow,
    CASE WHEN $6::boolean THEN NULL ELSE e.anchor END AS anchor,
    CASE WHEN $6::boolean THEN 'expired' WHEN e.anchor IS NULL THEN 'not_recorded' ELSE 'available' END AS "anchorStatus"
   FROM site_audit_edge e LEFT JOIN site_audit_page target ON target.run_id=e.run_id AND target.resource_kind='html' AND target.url=e.target_url
   WHERE e.run_id=$1 AND ($2::text='out' AND e.source_page_id=$3 OR $2::text='in' AND target.id=$3)
    AND ($4::uuid IS NULL OR e.id>$4) ORDER BY e.id LIMIT $5`,[run.id,query.direction,pageId,before,query.limit+1,run.raw_expired_at!==null])).rows;
  return {...base,links:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null};
 });
}
const emptyInput=z.object({}).strict();
export async function cancelSiteAudit(projectId:string,userId:string,runId:string,raw:unknown){
 parse(emptyInput,raw);return withAuditLock(actorTarget(projectId,userId,runId,true),async({client,run:saved,role})=>{
  let run=requireRun(saved);
  if(run.status==='queued')run=(await client.query<AuditRunRow>(`UPDATE site_audit_run SET status='cancelled',stop_reason='user_cancelled',completed_at=GREATEST(clock_timestamp(),created_at),cancel_requested_at=clock_timestamp(),generation=generation+1,phase=NULL WHERE id=$1 RETURNING *`,[run.id])).rows[0];
  else if(run.status==='running')run=(await client.query<AuditRunRow>(`UPDATE site_audit_run SET status='cancelling',stop_reason='user_cancelled',cancel_requested_at=clock_timestamp(),generation=generation+1 WHERE id=$1 RETURNING *`,[run.id])).rows[0];
  return {role:role!,run:auditRunDto(run,role)};
 });
}
export async function deleteSiteAudit(projectId:string,userId:string,runId:string,raw:unknown){
 parse(emptyInput,raw);return withAuditLock(actorTarget(projectId,userId,runId,true),async({client,project,run})=>{
  if(!run)throw missing();if(active.includes(run.status))throw new FoundationError(409,'Cancel or finish the audit before deleting it.');
  if(!run.deleted_at)await client.query('UPDATE site_audit_run SET deleted_at=clock_timestamp() WHERE id=$1',[run.id]);
  await client.query('UPDATE project SET retention_next_run_at=clock_timestamp() WHERE id=$1',[project.id]);return {deleted:true as const,id:run.id};
 });
}
