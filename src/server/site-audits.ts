import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {authorizeApiKey} from './api-keys.ts';
import {getDatabase} from './db.ts';
import {normalizePublicHostname} from './domains.ts';
import {getBoss} from './jobs.ts';
import {resolveAuditCandidate} from './site-audit-policy.ts';
import {markSiteAuditReadExpiry} from './site-audit-retention.ts';
import type {CrawlFacts,CrawlCoverage,CrawlPageInput} from './crawl-analysis.ts';
import {canonicalHash} from './context-input.ts';
import {normalizeAuditPageFields} from '../lib/site-audit-pages.ts';
import {csvCell} from './explorer-input.ts';
import {contentCoverageLimits,contentPageStates} from '../lib/ai-content-coverage.ts';
import type {ContentPage,ContentPageState} from './ai-content-coverage.ts';

export const siteAuditQueue='site-audit';
export const siteAuditLimits=Object.freeze({defaultPages:50,maxPages:1000,maxMinutes:30,requestsPerSecond:1,bodyCapacityBytes:524288000,frontier:10000,edges:100000,sitemapDocuments:20,sitemapDepth:3});
export type AuditRole='owner'|'admin'|'editor'|'viewer';
export type AuditStatus='queued'|'running'|'cancelling'|'completed'|'partial'|'failed'|'cancelled';
export type AuditConfig={retainBodyText?:boolean;mode:'static';startPath:string;startUrl:string;maxPages:number;requestLimit:number;bodyCapacityBytes:number;frontierLimit:number;edgeLimit:number;sitemapDocuments:number;sitemapDepth:number;minIntervalMs:number;maxAttempts:2;userAgent:'TenMonitorBot/1.0';robotsProductToken:'TenMonitorBot'};
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
type ActorTarget={projectId:string;runId?:string;actor:{userId:string;permission:'read'|'manage'};apiToken?:string};
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
 const read=actor?.permission==='read',token=internal?undefined:target.apiToken,actorProject=internal?undefined:parse(z.uuid(),target.projectId);
 if(token!==undefined&&!read)throw new FoundationError(403,'The API key does not permit this action.');
 const client=await getDatabase().pool.connect();
 // Bearer reads bind the key's current issuer to this actor after lock admission, before commit and on the error path (project-context.ts contract).
 const keyCheck=async(ws:string)=>{if((await authorizeApiKey(token!,ws,'audits:read',client)).userId!==actor!.userId)throw missing();};
 let workspaceId:string|undefined;
 try{
  await client.query('BEGIN');
  if(read)await client.query(`SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='${token===undefined?30:5}s'`);
  // ponytail: one global claim gate matches the initial one-active-run installation limit.
  if(internal&&target.claim)await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ten98.site-audit.claim.v1',0))");
  const projectId=internal?(await client.query('SELECT project_id FROM site_audit_run WHERE id=$1',[runId])).rows[0]?.project_id:actorProject;
  const hint=projectId?(await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0]:null;
  if(!hint){if(internal){await client.query('COMMIT');return null;}throw missing();}
  const lock=read?'SHARE':'UPDATE';workspaceId=hint.workspace_id;
  const workspace=await client.query(`SELECT id FROM workspace WHERE id=$1 FOR ${lock}`,[hint.workspace_id]);
  if(token!==undefined)await keyCheck(hint.workspace_id);
  const project=(await client.query<AuditProject>(`SELECT id,workspace_id AS "workspaceId",origin FROM project WHERE id=$1 AND workspace_id=$2 FOR ${lock}`,[projectId,hint.workspace_id])).rows[0];
  if(!workspace.rowCount||!project){if(internal){await client.query('COMMIT');return null;}throw missing();}
  let role:AuditRole|null=null;
  if(actor){role=(await client.query<{role:AuditRole}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[project.workspaceId,actor.userId])).rows[0]?.role??null;
   if(role===null)throw missing();if(actor.permission==='manage'&&!managed(role))throw new FoundationError(403,'Only a workspace owner or admin can manage audits.');}
  // Reads can latch expiry: lock the run for UPDATE initially, never upgrade SHARE.
  const run=runId?(await client.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[runId,project.id])).rows[0]??null:null;
  if(runId&&!run){if(internal){await client.query('COMMIT');return null;}throw missing();}
  if(actor&&run)Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);
  const result=await operation({client,project,run,role});if(token!==undefined)await keyCheck(project.workspaceId);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});
  // Stale key authority outranks the read's own 404/409/503, rechecked on this connection even when the lock wait itself failed.
  if(token!==undefined){const ws=workspaceId??(await client.query<{workspace_id:string}>('SELECT workspace_id FROM project WHERE id=$1',[actorProject])).rows[0]?.workspace_id;if(ws!==undefined)await keyCheck(ws);}
  if(read&&['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Audit results are busy. Try again shortly.');throw error;}finally{client.release();}
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
 return {id:run.id,projectId:run.project_id,domainId:run.domain_id,origin:run.origin,config:{...run.config,retainBodyText:run.config.retainBodyText===true},status:run.status,phase:run.phase,
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
const startInput=z.object({retainBodyText:z.boolean().default(false),requestId:z.uuid(),domainId:z.uuid().nullable(),startPath:z.string().min(1).max(2048),maxPages:z.number().int().min(1).max(1000).default(50),mode:z.literal('static')}).strict();
export function parseSiteAuditStart(raw:unknown){
 const input=parse(startInput,raw);
 if(!input.startPath.startsWith('/')||input.startPath.startsWith('//')||input.startPath.includes('#'))throw new FoundationError(400,'Use a query-free rooted start path.');
 const candidate=resolveAuditCandidate(input.startPath,'https://example.com/','https://example.com');
 if(candidate.status!=='accepted')throw new FoundationError(400,'Use a valid query-free start path.');
 return {...input,startPath:new URL(candidate.url).pathname};
}
function intentHash(input:ReturnType<typeof parseSiteAuditStart>){return createHash('sha256').update(JSON.stringify({version:1,mode:input.mode,domainId:input.domainId,startPath:input.startPath,maxPages:input.maxPages,...(input.retainBodyText?{retainBodyText:true}:{})})).digest('hex');}
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
  const config:AuditConfig={retainBodyText:input.retainBodyText,mode:'static',startPath:input.startPath,startUrl:candidate.url,maxPages:input.maxPages,requestLimit:3*input.maxPages+100,bodyCapacityBytes:siteAuditLimits.bodyCapacityBytes,
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
 const extra=kind==='pages'?['coverage','resourceKind','search','searchIn','sort','order']:kind==='issues'?['code','severity','pageId']:kind==='links'?['direction']:[];
 if([...params.keys()].some(key=>!['cursor','limit',...extra].includes(key)||params.getAll(key).length!==1))throw new FoundationError(400,'Use supported audit filters once each.');
 const rawLimit=params.get('limit');if(rawLimit!==null&&!/^[1-9][0-9]{0,2}$(?![\s\S])/.test(rawLimit))throw new FoundationError(400,'Use a page limit from 1 to 100.');
 const limit=rawLimit===null?50:Number(rawLimit);if(limit>100)throw new FoundationError(400,'Use a page limit from 1 to 100.');
 const coverage=params.get('coverage'),resourceKind=params.get('resourceKind')??'html',code=params.get('code'),severity=params.get('severity'),pageId=params.get('pageId'),direction=params.get('direction')??'out';
 if(coverage!==null&&!coverages.includes(coverage)||!['html','robots','sitemap'].includes(resourceKind)||code!==null&&!issueCodes.has(code)||severity!==null&&!['critical','warning','info'].includes(severity)||pageId!==null&&!z.uuid().safeParse(pageId).success||!['in','out'].includes(direction))throw new FoundationError(400,'Use a supported audit filter.');
 const fields=normalizeAuditPageFields(Object.fromEntries(['search','searchIn','sort','order'].filter(key=>params.has(key)).map(key=>[key,params.get(key)])));
 if(!fields)throw new FoundationError(400,'Use supported page search and sorting fields.');
 return {limit,cursor:params.get('cursor'),coverage,resourceKind,code,severity,pageId,direction,...fields};
}
function requireRun(run:AuditRunRow|null){if(!run)throw missing();if(run.deleted_at)throw gone();return run;}
function actorTarget(projectId:string,userId:string,runId?:string,manage=false,apiToken?:string):ActorTarget{return {projectId,runId,actor:{userId,permission:manage?'manage':'read'},apiToken};}
const runDtoColumns='id,project_id,domain_id,origin,config,status,phase,created_at,started_at,completed_at,deadline_at,stop_reason,coverage,summary,request_count,html_pages_started,sitemap_documents_started,frontier_count,edge_count,budget_charged_bytes,wire_bytes,http_decoded_bytes,decoded_bytes,raw_expired_at,data_expired_at,deleted_at';
export async function listSiteAudits(projectId:string,userId:string,params:URLSearchParams,apiToken?:string){
 const query=parseAuditListQuery(params,'runs'),scope={projectId,list:'audits'},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId,undefined,false,apiToken),async({client,role})=>{
  if(before&&!(await client.query('SELECT id FROM site_audit_run WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',[before,projectId])).rowCount)throw new FoundationError(400,'This audit cursor is no longer available.');
  const rows=(await client.query<AuditRunRow>(`SELECT ${runDtoColumns} FROM site_audit_run WHERE project_id=$1 AND deleted_at IS NULL
   AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM site_audit_run WHERE id=$2 AND project_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3 FOR UPDATE`,[projectId,before,query.limit+1])).rows;
  const expired=new Map((await markSiteAuditReadExpiry(client,projectId,rows.map(row=>row.id))).map(row=>[row.id,row]));
  for(const row of rows)Object.assign(row,expired.get(row.id));
  return {role:role!,runs:rows.slice(0,query.limit).map(row=>auditRunDto(row,role)),nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null};
 });
}
export async function getSiteAudit(projectId:string,userId:string,runId:string,apiToken?:string){return withAuditLock(actorTarget(projectId,userId,runId,false,apiToken),async({run,role})=>({role:role!,run:auditRunDto(requireRun(run),role)}));}

type PageRow={title_preview:string|null;title_length:number|null;body_capture_state:'not_recorded'|'available'|'empty'|'unavailable'|'over_limit';body_extraction_version:string|null;body_text:string|null;body_present:boolean;body_bytes:number|null;id:string;url:string;resource_kind:'html'|'robots'|'sitemap';state:string;discovered_start:boolean;discovered_link:boolean;discovered_sitemap:boolean;link_depth:number|null;sitemap_depth:number;observed_at:Date|null;http_status:number|null;fetch_state:CrawlPageInput['fetchState'];analysis_coverage:CrawlCoverage;reasons:string[];facts:CrawlFacts|null;response_time_ms:number|null;evidence:Record<string,unknown>|null;evidence_recorded:boolean;evidence_truncated:boolean};
const pageColumns='p.id,p.url,p.resource_kind,p.state,p.discovered_start,p.discovered_link,p.discovered_sitemap,p.link_depth,p.sitemap_depth,p.observed_at,p.http_status,p.fetch_state,p.analysis_coverage,p.reasons,p.facts,p.response_time_ms,p.evidence_recorded,p.evidence_truncated,p.body_capture_state,p.body_extraction_version';
const titleColumns=`CASE WHEN $3::boolean OR NOT p.evidence_recorded OR jsonb_typeof(p.evidence->'title') IS DISTINCT FROM 'string' THEN NULL ELSE left(p.evidence->>'title',512) END AS title_preview,
 CASE WHEN $3::boolean OR NOT p.evidence_recorded OR jsonb_typeof(p.evidence->'title') IS DISTINCT FROM 'string' THEN NULL ELSE length(p.evidence->>'title') END AS title_length`;
function titleDto(row:Pick<PageRow,'evidence_recorded'|'title_preview'|'title_length'>&{facts:{titleLength:number}|null},run:AuditRunRow):{status:'available'|'empty'|'truncated'|'expired'|'not_recorded'|'unavailable';text:string|null}{
 if(!row.evidence_recorded)return {status:'not_recorded',text:null};
 if(run.raw_expired_at)return {status:'expired',text:null};
 if(row.title_preview===null)return {status:'unavailable',text:null};
 const truncated=(row.title_length??0)>512||(row.facts?.titleLength??0)>row.title_preview.length;
 return {status:truncated?'truncated':row.title_preview===''?'empty':'available',text:row.title_preview};
}
function bodyDto(row:Pick<PageRow,'body_capture_state'|'body_extraction_version'|'body_present'|'body_bytes'|'body_text'|'resource_kind'|'state'>,run:AuditRunRow,include:boolean){
 const captured=row.body_capture_state==='available'||row.body_capture_state==='empty';
 const status=captured?(run.raw_expired_at?'expired':row.body_present?row.body_capture_state:'unavailable'):
  row.body_capture_state==='not_recorded'&&run.config?.retainBodyText===true&&row.resource_kind==='html'?
   (active.includes(run.status)&&['pending','leased'].includes(row.state)?'pending':'unavailable'):row.body_capture_state;
 const readable=status==='available'||status==='empty';
 return {status,version:status==='pending'||status==='not_recorded'?null:row.body_extraction_version,
  utf8Bytes:readable?row.body_bytes:null,textIncluded:include&&readable,text:include&&readable?row.body_text:null};
}
function pageDto(row:PageRow,run:AuditRunRow,includeEvidence:boolean){
 const rawEvidenceStatus=!row.evidence_recorded?'not_recorded' as const:run.raw_expired_at?'expired' as const:row.evidence_truncated?'truncated' as const:'available' as const;
 return {id:row.id,url:row.url,resourceKind:row.resource_kind,state:row.state,sources:{start:row.discovered_start,link:row.discovered_link,sitemap:row.discovered_sitemap},linkDepth:row.link_depth,sitemapDepth:row.sitemap_depth,
  observedAt:iso(row.observed_at),httpStatus:row.http_status,fetchState:row.fetch_state,analysis:{coverage:row.analysis_coverage,reasons:row.reasons,facts:row.facts},responseTimeMs:row.response_time_ms,
  titlePreview:titleDto(row,run),bodyEvidence:bodyDto(row,run,includeEvidence),rawEvidenceStatus,evidenceIncluded:includeEvidence,evidence:includeEvidence&&!run.raw_expired_at?row.evidence:null};
}
async function scopedPage(client:PoolClient,runId:string,pageId:string){
 const id=parse(z.uuid(),pageId);if(!(await client.query('SELECT 1 FROM site_audit_page WHERE id=$1 AND run_id=$2',[id,runId])).rowCount)throw missing();return id;
}
const pagesCursorSchema=z.object({v:z.literal(2),scope:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),revision:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),afterId:z.uuid()}).strict();
function pagesCursor(raw:string|null,scope:string){
 if(raw===null)return null;
 let value:unknown;try{if(!raw||raw.length>512||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw))throw new Error();value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw new FoundationError(400,'Reload these audit pages.');}
 const parsed=pagesCursorSchema.safeParse(value);if(!parsed.success||parsed.data.scope!==scope)throw new FoundationError(400,'This cursor belongs to different audit page filters.');return parsed.data;
}
type PageSelectionQuery=Pick<ReturnType<typeof parseAuditListQuery>,'coverage'|'resourceKind'|'search'|'searchIn'|'sort'|'order'>;
function pageSelectionScope(projectId:string,runId:string,query:PageSelectionQuery){return canonicalHash({projectId,runId,list:'pages',...query});}
async function selectAuditPages(client:PoolClient,run:AuditRunRow,query:PageSelectionQuery,scope:string){
  // Commit the existing expiry latch before reporting that copied text can no longer govern selection.
  if(run.raw_expired_at&&(query.sort==='title'||query.search!==''&&query.searchIn==='url_title_meta'))return {pageReadError:'raw_expired' as const};
  const title=`CASE WHEN p.evidence_recorded AND jsonb_typeof(p.evidence->'title')='string' THEN p.evidence->>'title' ELSE NULL END`;
  const description=`CASE WHEN p.evidence_recorded AND jsonb_typeof(p.evidence->'description')='string' THEN p.evidence->>'description' ELSE NULL END`;
  const sortColumns={url:'p.url COLLATE "C"',httpStatus:'p.http_status',title:`(${title}) COLLATE "C"`,h1:"(p.facts->'headingCounts'->>0)::numeric",wordCount:"(p.facts->>'wordCount')::numeric",images:"(p.facts->>'imagesMissingAlt')::numeric",responseTimeMs:'p.response_time_ms'};
  const direction=query.order==='asc'?'ASC':'DESC',order=`${sortColumns[query.sort]} ${direction} NULLS LAST${query.sort==='images'?`,(p.facts->>'imagesTotal')::numeric ${direction} NULLS LAST`:''},p.id ASC`;
  const searchTarget=query.searchIn==='url_title_meta'&&query.search!==''?`p.url||' '||coalesce(${title},'')||' '||coalesce(${description},'')`:'p.url';
  // ponytail: bounded O(n) ordered-ID selection, at most 10,000 frontier rows; add indexed keysets only after measured larger audit capacity or query cost.
  const ids=(await client.query<{id:string}>(`SELECT p.id FROM site_audit_page p WHERE p.run_id=$1 AND p.resource_kind=$2
   AND ($3::text IS NULL OR p.analysis_coverage=$3) AND strpos(lower(${searchTarget}),lower($4::text))>0 ORDER BY ${order} LIMIT 10001`,[run.id,query.resourceKind,query.coverage,query.search])).rows.map(row=>row.id);
  if(ids.length>siteAuditLimits.frontier)return {pageReadError:'population' as const};
  const selectionRevision=canonicalHash({scope,status:run.status,rawExpiredAt:iso(run.raw_expired_at),dataExpiredAt:iso(run.data_expired_at),ids});
  return {ids,selectionRevision};
}
function pageReadFailure(reason:'raw_expired'|'population'|'selection_changed'|'missing_anchor'){
 const messages={raw_expired:'The title and description evidence expired. Use URL search and another sort.',population:'This audit exceeds the supported page reporting population.',selection_changed:'These page results changed. Reload matching pages.',missing_anchor:'This audit page cursor is no longer available.'};
 return new FoundationError(reason==='missing_anchor'?400:409,messages[reason]);
}
export async function listSiteAuditPages(projectId:string,userId:string,runId:string,params:URLSearchParams){
 const query=parseAuditListQuery(params,'pages'),fields:PageSelectionQuery={coverage:query.coverage,resourceKind:query.resourceKind,search:query.search,searchIn:query.searchIn,sort:query.sort,order:query.order},scope=pageSelectionScope(projectId,runId,fields),before=pagesCursor(query.cursor,scope);
 const result=await withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved),asOf=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(),envelope={role:role!,run:auditRunDto(run,role),asOf,countBasis:'retained' as const};
  if(run.data_expired_at)return {...envelope,pages:[],nextCursor:null,selectionRevision:null,matchingRetainedCount:null};
  const selection=await selectAuditPages(client,run,fields,scope);if(selection.pageReadError)return selection;
  const {ids,selectionRevision}=selection;
  if(before&&before.revision!==selectionRevision)return {pageReadError:'selection_changed' as const};
  const anchor=before?ids.indexOf(before.afterId):-1;if(before&&anchor<0)return {pageReadError:'missing_anchor' as const};
  const selected=ids.slice(anchor+1,anchor+1+query.limit);
  const rows=selected.length?(await client.query<PageRow>(`SELECT ${pageColumns},${titleColumns},NULL AS evidence,NULL::text AS body_text,p.body_text IS NOT NULL AS body_present,CASE WHEN $3::boolean THEN NULL ELSE octet_length(p.body_text) END AS body_bytes
   FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position) JOIN site_audit_page p ON p.id=selected.id AND p.run_id=$1 ORDER BY selected.position`,[run.id,selected,run.raw_expired_at!==null])).rows:[];
  const next=anchor+1+selected.length<ids.length?Buffer.from(JSON.stringify({v:2,scope,revision:selectionRevision,afterId:selected.at(-1)})).toString('base64url'):null;
  return {...envelope,pages:rows.map(row=>pageDto(row,run,false)),nextCursor:next,selectionRevision,matchingRetainedCount:active.includes(run.status)?null:safeCount(ids.length)};
 });
 // Logical selection failures also commit newly observed retention tombstones; auth/DB failures still roll back.
 if(result.pageReadError!==undefined)throw pageReadFailure(result.pageReadError);
 return result;
}
const pageExportSchema=z.object({coverage:z.string().nullable(),resourceKind:z.enum(['html','robots','sitemap']),search:z.string(),searchIn:z.string(),sort:z.string(),order:z.string(),expectedSelectionRevision:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/)}).strict();
export function parseSiteAuditPagesExport(raw:unknown){
 const input=parse(pageExportSchema,raw),params=new URLSearchParams();
 for(const key of ['coverage','resourceKind','search','searchIn','sort','order'] as const)if(input[key]!==null)params.set(key,input[key]);
 const query=parseAuditListQuery(params,'pages');
 return {coverage:query.coverage,resourceKind:query.resourceKind,search:query.search,searchIn:query.searchIn,sort:query.sort,order:query.order,expectedSelectionRevision:input.expectedSelectionRevision};
}
/** Internal retained-body leaf. Caller holds the existing authorized W/P/run gate. */
export async function readAuditCoveragePages(locked:AuditLock,query:ReturnType<typeof parseSiteAuditPagesExport>,materialize=true){
 const {client,project}=locked,run=requireRun(locked.run);
 if(run.data_expired_at)return {coverageError:'audit_expired' as const};
 if(active.includes(run.status)||!run.completed_at)return {coverageError:'audit_active' as const};
 if(query.resourceKind!=='html')throw new FoundationError(400,'Website-text comparison requires HTML pages.');
 const {expectedSelectionRevision,...fields}=query,selection=await selectAuditPages(client,run,fields,pageSelectionScope(project.id,run.id,fields));
 if(selection.pageReadError)return {coverageError:selection.pageReadError};
 if(selection.selectionRevision!==expectedSelectionRevision)return {coverageError:'selection_changed' as const};
 const expired=run.raw_expired_at!==null,clocks=(await client.query(`SELECT to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedAt",to_char(raw_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "rawExpiredAt",to_char(data_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dataExpiredAt" FROM site_audit_run WHERE id=$1`,[run.id])).rows[0];
 const metadata=(await client.query(`WITH policy AS MATERIALIZED(SELECT $3::boolean OR r.completed_at<clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' OR r.completed_at<clock_timestamp()-w.derived_history_days*interval '24 hours' AS expired FROM site_audit_run r JOIN workspace w ON w.id=r.workspace_id WHERE r.id=$1)
  SELECT p.id,p.url,p.resource_kind,p.state,p.fetch_state,p.analysis_coverage,p.body_capture_state,p.body_extraction_version,policy.expired AS policy_expired,
  to_char(p.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
  p.facts->>'contentHash' AS content_hash,
  CASE WHEN policy.expired OR p.body_capture_state NOT IN('available','empty') THEN NULL ELSE octet_length(p.body_text) END AS bytes,
  CASE WHEN policy.expired OR p.body_capture_state NOT IN('available','empty') THEN NULL ELSE encode(sha256(convert_to(p.body_text,'UTF8')),'hex') END AS body_hash
  FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position) JOIN site_audit_page p ON p.id=selected.id AND p.run_id=$1 CROSS JOIN policy ORDER BY selected.position`,[run.id,selection.ids,expired])).rows;
 if(metadata.length!==selection.ids.length)return {coverageError:'selection_changed' as const};
 if(!expired&&metadata.some(row=>row.policy_expired)){Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);return {coverageError:'selection_changed' as const};}
 const pages:ContentPage[]=metadata.map(row=>{
  const native=bodyDto({...row,body_present:row.body_hash!==null,body_bytes:row.bytes,body_text:null},run,false);
  let state:ContentPageState=contentPageStates.includes(native.status as ContentPageState)?native.status as ContentPageState:'invalid';
  if((state==='available'||state==='empty')&&(run.config?.retainBodyText!==true||row.resource_kind!=='html'||row.analysis_coverage!=='analyzed'||row.body_extraction_version!=='static-dom-body-v1'||row.observed_at===null||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>65536||!row.body_hash||(state==='empty'?row.bytes!==0||row.content_hash!==null:row.bytes===0||row.content_hash!==row.body_hash)))state='invalid';
  return {id:row.id,url:row.url,observedAt:row.observed_at,state,extractionVersion:row.body_extraction_version,bodySha256:state==='available'||state==='empty'?row.body_hash:null,text:null};
 });
 const readable=pages.filter(p=>p.state==='available'||p.state==='empty'),rawBytes=metadata.reduce((sum,row,index)=>sum+(pages[index].state==='available'||pages[index].state==='empty'?row.bytes:0),0);
 if(readable.length>contentCoverageLimits.readablePages||rawBytes>contentCoverageLimits.rawBytes)return {coverageError:'body_capacity' as const};
 if(materialize){const hydrated=await materializeAuditCoveragePages(locked,pages,metadata);if('coverageError'in hydrated)return hydrated;}
 return {pages,selectionRevision:selection.selectionRevision,receipt:{run:{id:run.id,origin:run.origin,domainId:run.domain_id,config:run.config,status:run.status,...clocks,coverage:run.coverage},query:fields,selectionRevision:selection.selectionRevision,metadata}};
}
/** Materializes only checked metadata in the caller's current W/P/audit gate.
 * selectedIds is the bounded C3 subset; omission preserves the complete C1/C2 read.
 * These values are internal evidence, never a substitute for current authority. */
export async function materializeAuditCoveragePages(locked:AuditLock,pages:ContentPage[],metadata:readonly {id:string;bytes:number|null}[],selectedIds?:readonly string[]):Promise<{pages:ContentPage[]}|{coverageError:'selection_changed'}>{
 const {client,project}=locked,run=requireRun(locked.run);
 if(run.project_id!==project.id||run.workspace_id!==project.workspaceId)throw new FoundationError(404,'Audit or project not found or unavailable.');
 let readable=pages.filter(p=>p.state==='available'||p.state==='empty');
 if(selectedIds!==undefined){
  const ids=parse(z.array(z.uuid().transform(v=>v.toLowerCase())).min(1).max(20).refine(v=>new Set(v).size===v.length),selectedIds),byId=new Map(pages.map(p=>[p.id,p])),bytesById=new Map(metadata.map(p=>[p.id,p.bytes]));
  if(active.includes(run.status)||!run.completed_at||run.deleted_at||run.config?.retainBodyText!==true||byId.size!==pages.length||bytesById.size!==metadata.length||pages.some(p=>p.text!==null))throw new FoundationError(409,'Reload the current retained page selection before materializing its text.');
  const selected=ids.map(id=>byId.get(id));if(selected.some(p=>!p||!['available','empty'].includes(p.state)||p.extractionVersion!=='static-dom-body-v1'||!p.observedAt||!p.bodySha256||!/^[a-f0-9]{64}$/.test(p.bodySha256)))throw new FoundationError(409,'A selected readable page is unavailable. Reload the selection.');
  let bytes=0;for(const id of ids){const size=bytesById.get(id);if(typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>65536)throw new FoundationError(409,'Selected page metadata is inconsistent. Reload the selection.');bytes+=size;}
  if(bytes>65536)throw new FoundationError(413,'The complete selected bodies exceed 64 KiB. Select fewer or smaller pages.');readable=selected as ContentPage[];
 }
  // Read complete bodies in bounded batches only after the full metadata/byte preflight.
  for(let offset=0;offset<readable.length;offset+=100){
   Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);if(run.raw_expired_at)return {coverageError:'selection_changed' as const};
   const batch=readable.slice(offset,offset+100),rows=(await client.query<{id:string;body_text:string}>(`SELECT p.id,CASE WHEN r.completed_at<clock_timestamp()-w.raw_provider_evidence_days*interval '24 hours' OR r.completed_at<clock_timestamp()-w.derived_history_days*interval '24 hours' THEN NULL ELSE p.body_text END AS body_text FROM site_audit_page p JOIN site_audit_run r ON r.id=p.run_id JOIN workspace w ON w.id=r.workspace_id WHERE p.run_id=$1 AND p.id=ANY($2::uuid[])`,[run.id,batch.map(p=>p.id)])).rows,byId=new Map(rows.map(row=>[row.id,row.body_text]));
   for(const page of batch){const text=byId.get(page.id);if(typeof text!=='string'||Buffer.byteLength(text)>65536||createHash('sha256').update(text).digest('hex')!==page.bodySha256){Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);return {coverageError:'selection_changed' as const};}page.text=text;}
  }
 if(selectedIds!==undefined&&readable.reduce((sum,p)=>sum+Buffer.byteLength(p.text!),0)>65536)throw new FoundationError(413,'The complete selected bodies exceed 64 KiB. Select fewer or smaller pages.');
 return {pages:readable};
}
export const siteAuditPagesExportMaxBytes=64*1024*1024;
// ponytail: one export body per web process, capped at 64 MiB; use an async artifact job if measured demand needs concurrent large exports.
let pageExportActive=false;
type ExportPageRow=Pick<PageRow,'id'|'url'|'resource_kind'|'state'|'discovered_start'|'discovered_link'|'discovered_sitemap'|'link_depth'|'sitemap_depth'|'observed_at'|'http_status'|'fetch_state'|'analysis_coverage'|'response_time_ms'|'evidence_recorded'|'title_preview'|'title_length'>&{fact_title_length:number|null;h1:number|null;word_count:string|null;images_total:string|null;images_missing_alt:string|null};
const pageExportColumns=['recordType','version','projectId','runId','ruleVersion','asOf','selectionRevision','appliedQuery','matchingRetainedCount','rawEvidenceStatus','dataStatus','auditStatus','coverage','pageId','url','resourceKind','pageState','httpStatus','titlePreview','titlePreviewStatus','h1','wordCount','imagesTotal','imagesMissingAlt','responseTimeMs','discoveredStart','discoveredLink','discoveredSitemap','linkDepth','sitemapDepth','fetchState','analysisCoverage','observedAt'];
function exportAborted(signal?:AbortSignal){if(signal?.aborted)throw new FoundationError(499,'Audit export cancelled.');}
/** The database transaction ends before the native response can wait for a reader. */
function pagesCsvResponse(parts:Buffer[],length:number,rowCount:number,selectionRevision:string,asOf:string,release:()=>void,signal?:AbortSignal){
 let index=0,offset=0,remaining=length,controller:ReadableStreamDefaultController<Uint8Array>|null=null;
 const finish=()=>{parts.length=0;remaining=0;controller=null;signal?.removeEventListener('abort',abort);release();};
 const abort=()=>{const current=controller;finish();current?.error(new FoundationError(499,'Audit export cancelled.'));};
 try{
  const stream=new ReadableStream<Uint8Array>({
   start(value){controller=value;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();},
   pull(value){try{
    if(!remaining){value.close();finish();return;}
    const chunk=Buffer.allocUnsafeSlow(Math.min(64*1024,remaining));let written=0;
    while(written<chunk.length){const part=parts[index],take=Math.min(chunk.length-written,part.length-offset);part.copy(chunk,written,offset,offset+take);written+=take;offset+=take;if(offset===part.length){parts[index]=Buffer.alloc(0);index++;offset=0;}}
    remaining-=written;value.enqueue(chunk);if(!remaining){value.close();finish();}
   }catch(error){finish();value.error(error);}},
   cancel(){finish();},
  },{highWaterMark:0});
  return new Response(stream,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="audit-pages.csv"','content-length':String(length),'x-export-row-count':String(rowCount),'x-export-revision':selectionRevision,'x-export-as-of':asOf,'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'}});
 }catch(error){finish();throw error;}
}
export async function exportSiteAuditPages(projectId:string,userId:string,runId:string,raw:unknown,signal?:AbortSignal):Promise<Response>{
 const {expectedSelectionRevision,...query}=parseSiteAuditPagesExport(raw);exportAborted(signal);
 if(pageExportActive)throw new FoundationError(503,'Another audit export is still downloading. Try again shortly.');
 pageExportActive=true;let transferred=false,released=false;
 const release=()=>{if(!released){released=true;pageExportActive=false;}};
 try{
  const result=await withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
   if(!saved||saved.deleted_at)throw missing();const run=saved;
   if(run.data_expired_at)return {exportError:'derived_expired' as const};
   if(active.includes(run.status))throw new FoundationError(409,'Finish or cancel this audit before exporting pages.');
   const scope=pageSelectionScope(projectId,runId,query),selection=await selectAuditPages(client,run,query,scope);
   if(selection.pageReadError)return selection;
   if(selection.selectionRevision!==expectedSelectionRevision)return {pageReadError:'selection_changed' as const};
   const asOf=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(),dto=auditRunDto(run,role),wasRawExpired=run.raw_expired_at!==null;
   const parts:Buffer[]=[];let size=0,count=0;
   const line=(values:unknown[])=>{exportAborted(signal);const bytes=Buffer.from(values.map(csvCell).join(',')+'\r\n');if(size+bytes.length>siteAuditPagesExportMaxBytes)throw new FoundationError(413,'Audit export exceeds 64 MiB. Narrow the page filters.');size+=bytes.length;parts.push(bytes);};
   line(pageExportColumns);
   line(['metadata','audit-pages-v1',projectId,runId,run.rule_version,asOf,selection.selectionRevision,query,selection.ids.length,dto.rawEvidenceStatus,dto.dataStatus,run.status,run.coverage,...Array(20).fill('')]);
   await client.query(`DECLARE site_audit_pages_export NO SCROLL CURSOR FOR SELECT p.id,p.url,p.resource_kind,p.state,p.discovered_start,p.discovered_link,p.discovered_sitemap,p.link_depth,p.sitemap_depth,p.observed_at,p.http_status,p.fetch_state,p.analysis_coverage,p.response_time_ms,p.evidence_recorded,${titleColumns},
    (p.facts->>'titleLength')::integer AS fact_title_length,(p.facts->'headingCounts'->>0)::integer AS h1,(p.facts->>'wordCount')::bigint AS word_count,(p.facts->>'imagesTotal')::bigint AS images_total,(p.facts->>'imagesMissingAlt')::bigint AS images_missing_alt
    FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position) JOIN site_audit_page p ON p.id=selected.id AND p.run_id=$1 ORDER BY selected.position`,[run.id,selection.ids,wasRawExpired]);
   for(;;){
    exportAborted(signal);const batch=(await client.query<ExportPageRow>('FETCH FORWARD 100 FROM site_audit_pages_export')).rows;if(!batch.length)break;
    for(const page of batch){
     const title=titleDto({...page,facts:page.fact_title_length===null?null:{titleLength:page.fact_title_length}},run);
     line(['page',...Array(12).fill(''),page.id,page.url,page.resource_kind,page.state,page.http_status,title.text,title.status,page.h1,page.word_count,page.images_total,page.images_missing_alt,page.response_time_ms,page.discovered_start,page.discovered_link,page.discovered_sitemap,page.link_depth,page.sitemap_depth,page.fetch_state,page.analysis_coverage,iso(page.observed_at)]);count++;
    }
   }
   await client.query('CLOSE site_audit_pages_export');
   if(count!==selection.ids.length)throw new FoundationError(409,'These page results changed. Reload matching pages.');
   // Recheck database time after generation; commit newly reached expiry before refusing release of copied bytes.
   Object.assign(run,(await markSiteAuditReadExpiry(client,projectId,[run.id]))[0]);
   if(run.data_expired_at)return {exportError:'derived_expired' as const};
   if(!wasRawExpired&&run.raw_expired_at)return {pageReadError:'selection_changed' as const};
   const current=await selectAuditPages(client,run,query,scope);if(current.pageReadError)return current;
   if(current.selectionRevision!==selection.selectionRevision)return {pageReadError:'selection_changed' as const};
   exportAborted(signal);
   return {parts,size,rowCount:count,selectionRevision:selection.selectionRevision,asOf};
  });
  if(result.pageReadError)throw pageReadFailure(result.pageReadError);
  if(result.exportError)throw new FoundationError(410,'Audit page data expired under this workspace’s retention policy.');
  exportAborted(signal);const response=pagesCsvResponse(result.parts,result.size,result.rowCount,result.selectionRevision,result.asOf,release,signal);transferred=true;return response;
 }finally{if(!transferred)release();}
}
export async function getSiteAuditPage(projectId:string,userId:string,runId:string,pageId:string){
 parse(z.uuid(),pageId);const result=await withAuditLock(actorTarget(projectId,userId,runId),async({client,run:saved,role})=>{
  const run=requireRun(saved);if(run.data_expired_at)return null;
  const page=(await client.query<PageRow>(`SELECT ${pageColumns},${titleColumns},CASE WHEN $3::boolean THEN NULL ELSE p.evidence END AS evidence,CASE WHEN $3::boolean THEN NULL ELSE p.body_text END AS body_text,p.body_text IS NOT NULL AS body_present,CASE WHEN $3::boolean THEN NULL ELSE octet_length(p.body_text) END AS body_bytes FROM site_audit_page p WHERE p.run_id=$1 AND p.id=$2`,[run.id,pageId,run.raw_expired_at!==null])).rows[0];
  if(!page)throw missing();return {role:role!,run:auditRunDto(run,role),page:pageDto(page,run,true)};
 });
 // Commit the irreversible read marker before reporting expiry to the caller.
 if(result===null)throw new FoundationError(410,'Audit page data expired under this workspace’s retention policy.');
 return result;
}
export async function listSiteAuditIssues(projectId:string,userId:string,runId:string,params:URLSearchParams,apiToken?:string){
 const query=parseAuditListQuery(params,'issues'),scope={projectId,runId,list:'issues',code:query.code,severity:query.severity,pageId:query.pageId},before=cursor(query.cursor,scope);
 return withAuditLock(actorTarget(projectId,userId,runId,false,apiToken),async({client,run:saved,role})=>{
  const run=requireRun(saved),base={role:role!,run:auditRunDto(run,role),findingsComplete:run.summary?.findingsComplete??false,countBasis:'retained' as const};
  if(run.data_expired_at)return {...base,issues:[],groups:null,nextCursor:null,matchingRetainedCount:null};
  if(query.pageId)await scopedPage(client,run.id,query.pageId);
  if(before&&!(await client.query('SELECT 1 FROM site_audit_issue WHERE run_id=$1 AND id=$2',[run.id,before])).rowCount)throw new FoundationError(400,'This issue cursor is no longer available.');
  const filter='i.run_id=$1 AND ($2::text IS NULL OR i.code=$2) AND ($3::text IS NULL OR i.severity=$3) AND ($4::uuid IS NULL OR i.page_id=$4)';
  const values=[run.id,query.code,query.severity,query.pageId];
  const rows=(await client.query(`SELECT i.id,i.page_id AS "pageId",primary_page.url AS "pageUrl",i.target_page_id AS "targetPageId",target_page.url AS "targetPageUrl",
    i.related_page_ids AS "relatedPageIds",i.code,i.severity,i.rule_version AS "ruleVersion",i.details
   FROM site_audit_issue i LEFT JOIN site_audit_page primary_page ON primary_page.id=i.page_id AND primary_page.run_id=i.run_id
    LEFT JOIN site_audit_page target_page ON target_page.id=i.target_page_id AND target_page.run_id=i.run_id
   WHERE ${filter} AND ($5::uuid IS NULL OR i.id>$5) ORDER BY i.id LIMIT $6`,[...values,before,query.limit+1])).rows;
  const pending=active.includes(run.status),groupRows=(await client.query<{code:string;severity:'critical'|'warning'|'info';findings:string;urls:string;unassigned:string}>(`
   SELECT i.code,i.severity,count(*) AS findings,count(DISTINCT primary_page.url) AS urls,count(*) FILTER(WHERE primary_page.id IS NULL) AS unassigned
   FROM site_audit_issue i LEFT JOIN site_audit_page primary_page ON primary_page.id=i.page_id AND primary_page.run_id=i.run_id
   WHERE ${filter} GROUP BY i.code,i.severity ORDER BY i.code,i.severity`,values)).rows;
  const groups=groupRows.map(row=>({code:row.code,severity:row.severity,retainedFindingCount:pending?null:safeCount(row.findings),
   affectedUrlCount:pending?null:safeCount(row.urls),unassignedFindingCount:pending?null:safeCount(row.unassigned)}));
  const count=pending?null:safeCount(groups.reduce((total,group)=>total+group.retainedFindingCount!,0));
  return {...base,issues:rows.slice(0,query.limit),groups,nextCursor:rows.length>query.limit?nextCursor(rows[query.limit-1].id,scope):null,matchingRetainedCount:count};
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
