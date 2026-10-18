import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt,contentCursor,readContentCursor} from './project-context.ts';
import {usd,usdMicros} from './providers.ts';
import {reserveSpendInTransaction} from './spending.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {executionActor,keyFingerprint,readContentSupportRoute} from './openrouter.ts';
import {prepareContentSupportQuote} from './ai-content-support-quote.ts';
import {createContentSupportSnapshot,contentSupportQueryId,type ContentSupportSnapshot} from './ai-content-support-input.ts';
import {deriveSearchQueries} from './ai-search-evidence.ts';
import {aggregateAiSearchQueryPopulation} from './ai-search-analysis.ts';
import {readAiSearchCoverageSource,readAiSearchAnalysisPopulation} from './ai-search.ts';
import {readContentCoverageSourceInLock,readProjectContentCoverageSourceInLock} from './ai-content-coverage.ts';
import {auditAuthorityCurrent,readAuditCoveragePages,materializeAuditCoveragePages,parseSiteAuditPagesExport,type AuditLock,type AuditRole,type AuditRunRow} from './site-audits.ts';
import {markSiteAuditReadExpiry} from './site-audit-retention.ts';
import {csvCell} from './explorer-input.ts';
import {contentSupportContract,contentSupportQuoteInputSchema,contentSupportStoredInputSchema,contentSupportStartInputSchema,contentSupportActionInputSchema,contentSupportExportInputSchema,contentSupportDependenciesSchema,contentSupportSelectionSchema,contentSupportQuoteDtoSchema,contentSupportRunDtoSchema,type ContentSupportQuoteInput} from '../lib/ai-content-support.ts';

export const contentSupportQueue='ai-content-support';
const clock=(field:string)=>`to_char((${field}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export type SupportProject={id:string;workspaceId:string;origin:string;role:AuditRole|null};
type Refusal={refusal:{status:number;message:string}};
const changed=()=>new FoundationError(409,'The selected evidence, authority or quote changed. Reload it and prepare a new quote.');
const missing=()=>new FoundationError(404,'Content assessment not found or unavailable.');
const reject=(status=409,message=changed().message):Refusal=>({refusal:{status,message}});
export function supportResult<T>(result:T|Refusal):T{if(result&&typeof result==='object'&&'refusal'in result)throw new FoundationError(result.refusal.status,result.refusal.message);return result as T;}
export function requireSupportOwner(p:SupportProject){if(p.role!=='owner')throw new FoundationError(403,'Only an owner can run this evaluation.');}
export function boundedSupport<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value))>2_097_152)throw new FoundationError(413,'The complete content assessment exceeds 2 MiB. Narrow the selection.');return value;}
export async function withSupportProject<T>(projectId:string,userId:string|null,owner:boolean,work:(c:PoolClient,p:SupportProject)=>Promise<T>,ledgerId?:string):Promise<T>{
 parse(z.uuid(),projectId);if(userId!==null)parse(z.uuid(),userId);const c=await getDatabase().pool.connect();
 try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const hint=(await c.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0];if(!hint)throw missing();
  await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[hint.workspace_id]);
  if(ledgerId)await c.query('SELECT id FROM provider_request WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[ledgerId,hint.workspace_id]);
  const row=(await c.query('SELECT id,workspace_id AS "workspaceId",origin FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,hint.workspace_id])).rows[0];if(!row)throw missing();
  const role=userId===null?null:(await c.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[row.workspaceId,userId])).rows[0]?.role??null;
  if(userId!==null&&!role)throw missing();const p:SupportProject={...row,role};if(owner)requireSupportOwner(p);
  const result=await work(c,p);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Content assessments are busy. Retry the same request ID.');throw error;}finally{c.release();}
}
export async function supportAudit(c:PoolClient,p:SupportProject,id:string):Promise<AuditLock|null>{
 const run=(await c.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,p.id])).rows[0];if(!run)return null;
 Object.assign(run,(await markSiteAuditReadExpiry(c,p.id,[id]))[0]);return {client:c,project:{id:p.id,workspaceId:p.workspaceId,origin:p.origin},role:p.role,run};
}
/** Same-client native source leaves. No reconstructed receipt or nested gate. */
async function source(c:PoolClient,p:SupportProject,input:ContentSupportQuoteInput,materialize:boolean){
 try{
  const locked=await supportAudit(c,p,input.source.selection.auditRunId);if(!locked||locked.run!.deleted_at)return reject(410,'Selected audit is unavailable.');
  if(!(await auditAuthorityCurrent(c,locked.run!)).allowed)return reject(409,'Audit authority changed.');
  const fields=parseSiteAuditPagesExport(input.source.selection.pages);
  const leaf=input.source.kind==='capture'?await readContentCoverageSourceInLock(locked,p.id,input.source.selection,fields,false):await readProjectContentCoverageSourceInLock(locked,p.id,input.source.selection,fields,false);
  if('coverageError'in leaf)return reject(leaf.coverageError==='audit_expired'?410:409,'Selected retained evidence is unavailable.');
  if(leaf.queryReceiptHash!==input.expectedQueryReceiptHash||leaf.corpusReceiptHash!==input.expectedCorpusReceiptHash)return reject();
  const pages=await readAuditCoveragePages(locked,fields,false);if(pages.coverageError)return reject();
  if(!materialize)return {leaf,pages,locked};
  const bodies=await materializeAuditCoveragePages(locked,pages.pages!,pages.receipt!.metadata,input.selectedPageIds);if('coverageError'in bodies)return reject();
  const queries=input.source.kind==='capture'?await readAiSearchCoverageSource(c,p.id,input.source.selection.captureId,true):await readAiSearchAnalysisPopulation(c,{id:p.id,workspace_id:p.workspaceId,role:p.role!},input.source.selection.filters,true);
  if('coverageError'in queries)return reject();return {leaf,pages,locked,bodies:bodies.pages,queries};
 }catch(error){if(error instanceof FoundationError)return reject(error.status,error.message);throw error;}
}
type Source=Exclude<Awaited<ReturnType<typeof source>>,Refusal>;
/** Bound the complete population before selecting IDs; never use B's top25. */
function selectEvidence(input:ContentSupportQuoteInput,s:Source){
 if(!s.queries||!s.bodies)throw changed();let keys:{key:string;runIds:string[]}[],receipts:any[],contextRevision:number|null=null,profileHash:string|null=null;
 if(input.source.kind==='capture'){
  const q=s.queries as Awaited<ReturnType<typeof readAiSearchCoverageSource>>,captured=q.source?.result;if(!captured)throw changed();
  const derived=deriveSearchQueries({evidence:captured.evidence,capturedPrompt:captured.capturedPrompt,subjects:[],method:'unicode-boundary-v1'});
  if(!derived.queries)throw changed();keys=derived.queries.map(row=>({key:row.key,runIds:[input.source.kind==='capture'?input.source.selection.captureId:'']}));receipts=[q.receipt];
 }else{
  const q=s.queries as Awaited<ReturnType<typeof readAiSearchAnalysisPopulation>>;
  if(q.selectionRevision!==input.source.selection.expectedSelectionRevision)throw changed();keys=aggregateAiSearchQueryPopulation(q.rows!,q.filters,q.brand,2000).completeQueries;receipts=q.receipts;contextRevision=q.contextRevision;profileHash=q.profileHash;
 }
 const byId=new Map(keys.map(q=>[contentSupportQueryId(q.key),q])),chosen=input.selectedQueryIds.map(id=>({id,row:byId.get(id)}));if(chosen.some(q=>!q.row))throw changed();
 const contributors=new Set(chosen.flatMap(q=>q.row!.runIds)),queryDeps=receipts.filter(r=>contributors.has(r.id)).map(r=>({kind:'query' as const,captureId:r.id,quoteId:r.quote_id,quoteCreatedAt:r.quote_created_at??r.captured_at,inputHash:r.input_hash,inputFingerprint:r.input_fingerprint,resultHash:r.result_hash}));
 if(queryDeps.length!==contributors.size)throw changed();const audit=s.pages.receipt!.run;
 const dependencies=parse(contentSupportDependenciesSchema,[...queryDeps,...s.bodies.map(page=>({kind:'body' as const,pageId:page.id,auditRunId:audit.id,auditCompletedAt:audit.completedAt,observedAt:page.observedAt,bodySha256:page.bodySha256}))]);
 if(Buffer.byteLength(JSON.stringify(dependencies))>1_048_576)throw new FoundationError(413,'The complete source dependencies exceed 1 MiB. Narrow the selection.');
 const selection=parse(contentSupportSelectionSchema,{queries:chosen.map(q=>({id:q.id,key:q.row!.key})),pages:s.bodies.map(page=>({id:page.id,auditRunId:audit.id,url:page.url,bodySha256:page.bodySha256,bodyLength:page.text!.length,observedAt:page.observedAt,extractionVersion:page.extractionVersion})),exclusions:{queries:keys.length-chosen.length,pages:s.pages.pages!.length-s.bodies.length}});
 const evidence={derivationVersion:contentSupportContract.derivationVersion,source:{kind:input.source.kind,queryReceiptHash:input.expectedQueryReceiptHash,corpusReceiptHash:input.expectedCorpusReceiptHash},queries:selection.queries,pages:s.bodies.map(page=>({id:page.id,bodySha256:page.bodySha256,body:page.text})),exclusions:selection.exclusions};
 const anchors=dependencies.map(d=>d.kind==='query'?d.quoteCreatedAt:d.auditCompletedAt).sort();return {evidence,selection,dependencies,contextRevision,profileHash,rawAnchor:anchors[0],derivedAnchor:anchors[0],policy:s.leaf.policy};
}
export function contentSupportIdentity(q:any){
 return canonicalHash({...contentSupportContract,id:q.id,workspaceId:q.workspace_id,projectId:q.project_id,userId:q.user_id,requestId:q.request_id,connectionId:q.connection_id,connectionRevision:q.connection_revision,requestActor:q.request_actor,keyFingerprint:q.key_fingerprint,payloadHash:q.payload_hash,schemaHash:q.schema_hash,selectionHash:canonicalHash(q.snapshot?.selection??null),queryReceiptHash:q.query_receipt_hash,corpusReceiptHash:q.corpus_receipt_hash,source:q.source_input,dependencies:q.dependencies,contextRevision:q.source_context_revision,profileHash:q.source_profile_hash,retentionRevision:q.retention_revision,rawDays:q.raw_days_at_quote,derivedDays:q.derived_days_at_quote,rawAnchor:q.raw_anchor,derivedAnchor:q.derived_anchor,route:q.route,estimateMicros:String(q.estimate_micros),maxSpendMicros:String(q.max_spend_micros),createdAt:q.quote_created,expiresAt:q.quote_expires});
}
const quoteSelect=`SELECT q.*,${clock('q.created_at')} AS quote_created,${clock('q.expires_at')} AS quote_expires,${clock('q.raw_anchor_at')} AS raw_anchor,${clock('q.derived_anchor_at')} AS derived_anchor,q.expires_at<=clock_timestamp() AS quote_expired FROM ai_content_support_quote q`;
export async function supportQuoteRow(c:PoolClient,pid:string,id:string){const q=(await c.query(quoteSelect+' WHERE q.project_id=$1 AND q.id=$2 FOR UPDATE',[pid,id])).rows[0];if(!q)throw missing();return q;}
export async function supportRunRow(c:PoolClient,pid:string,id:string){const r=(await c.query(`SELECT r.*,${clock('r.created_at')} AS run_created,${clock('r.dispatched_at')} AS run_dispatched,${clock('r.completed_at')} AS run_completed,r.lease_expires_at<=clock_timestamp() AS lease_expired,p.status AS charge_status,p.actual_micros,p.estimate_micros,p.input_hash AS ledger_input_hash,p.connection_id AS ledger_connection_id,p.user_id AS ledger_user_id,p.connection_revision AS ledger_connection_revision,p.operation AS ledger_operation FROM ai_content_support_run r JOIN provider_request p ON p.id=r.id AND p.workspace_id=r.workspace_id WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r`,[pid,id])).rows[0];if(!r)throw missing();return r;}
/** Stored payload identity is distinct from its actor/key/source-bound ledger hash. */
export function readSupportPayload(q:any){
 const input=parse(contentSupportStoredInputSchema,q.source_input),stored=parse(z.object({evidence:z.unknown(),selection:contentSupportSelectionSchema}).strict(),q.snapshot),e=stored.evidence as ContentSupportSnapshot;
 const prepared=prepareContentSupportQuote({derivationVersion:e.derivationVersion,source:e.source,queries:e.queries,pages:e.pages,exclusions:e.exclusions},q.route,input.maxSpendUsd);
 if(input.connectionId!==q.connection_id||input.model!==q.route.model||input.requestId!==q.request_id||input.source.kind!==q.source_kind||input.source.selection.auditRunId!==q.audit_run_id||usdMicros(input.maxSpendUsd).toString()!==String(q.max_spend_micros)||q.request_actor!==executionActor(q.user_id)||input.expectedQueryReceiptHash!==q.query_receipt_hash||input.expectedCorpusReceiptHash!==q.corpus_receipt_hash||canonicalHash(prepared.messages)!==canonicalHash(q.messages)||prepared.payloadHash!==q.payload_hash||prepared.schemaHash!==q.schema_hash||prepared.estimateMicros!==String(q.estimate_micros)||contentSupportIdentity(q)!==q.input_hash)throw changed();
 const dependencies=parse(contentSupportDependenciesSchema,q.dependencies),anchor=dependencies.map(d=>d.kind==='query'?d.quoteCreatedAt:d.auditCompletedAt).sort()[0];if(q.raw_anchor!==anchor||q.derived_anchor!==anchor)throw changed();const selected=parse(contentSupportSelectionSchema,stored.selection);
 if(canonicalHash(selected.queries)!==canonicalHash(prepared.snapshot.queries)||canonicalHash(input.selectedQueryIds)!==canonicalHash(selected.queries.map(v=>v.id))||canonicalHash(input.selectedPageIds)!==canonicalHash(selected.pages.map(v=>v.id))||selected.pages.some(p=>{const b=prepared.snapshot.pages.find(v=>v.id===p.id);return !b||b.bodySha256!==p.bodySha256||b.body.length!==p.bodyLength;}))throw changed();return {...prepared,input,selection:selected};
}
export async function markSupportUnavailable(c:PoolClient,id:string,reason='source_changed'){
 await c.query('UPDATE ai_content_support_quote SET raw_expired_at=COALESCE(raw_expired_at,clock_timestamp()),unavailable_reason=COALESCE(unavailable_reason,$2) WHERE id=$1',[id,reason]);
 await c.query('UPDATE ai_content_support_run SET raw_result=NULL,proposal=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp()) WHERE quote_id=$1',[id]);
}
/** Call inside W mutation admission. Native SQL time and original source anchors survive copies. */
export async function latchContentSupportExpiry(c:PoolClient,projectIds:string[],policy?:{rawDays:number;derivedDays:number},quoteIds?:string[]){
 if(!projectIds.length)return;
 await c.query(`UPDATE ai_content_support_quote q SET raw_expired_at=COALESCE(q.raw_expired_at,clock_timestamp()),unavailable_reason=COALESCE(q.unavailable_reason,'input_expired') FROM workspace w WHERE w.id=q.workspace_id AND q.project_id=ANY($1::text[]) AND($4::uuid[] IS NULL OR q.id=ANY($4::uuid[])) AND q.raw_expired_at IS NULL AND(q.raw_anchor_at<clock_timestamp()-LEAST(q.raw_days_at_quote,w.raw_provider_evidence_days,COALESCE($2,w.raw_provider_evidence_days))*interval '24 hours' OR q.derived_anchor_at<clock_timestamp()-LEAST(q.derived_days_at_quote,w.derived_history_days,COALESCE($3,w.derived_history_days))*interval '24 hours'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.dependencies)d WHERE d->>'kind'='query' AND NOT EXISTS(SELECT 1 FROM ai_search_quote s JOIN ai_search_run r ON r.quote_id=s.id WHERE s.id=(d->>'quoteId')::uuid AND r.id=(d->>'captureId')::uuid AND s.project_id=q.project_id AND s.raw_expired_at IS NULL AND s.input_purged_at IS NULL AND r.result_purged_at IS NULL))
 OR NOT EXISTS(SELECT 1 FROM site_audit_run a WHERE a.id=q.audit_run_id AND a.project_id=q.project_id AND a.deleted_at IS NULL AND a.raw_expired_at IS NULL AND a.data_expired_at IS NULL))`,[projectIds,policy?.rawDays??null,policy?.derivedDays??null,quoteIds??null]);
}
export async function verifySupportSource(c:PoolClient,p:SupportProject,q:any){
 await latchContentSupportExpiry(c,[p.id],undefined,[q.id]);q=await supportQuoteRow(c,p.id,q.id);if(q.raw_expired_at||q.input_purged_at)return reject(410,'The copied content assessment evidence expired.');
 let payload:ReturnType<typeof readSupportPayload>;try{payload=readSupportPayload(q);}catch{await markSupportUnavailable(c,q.id);return reject();}
 const current=await source(c,p,payload.input,false);if('refusal'in current){await markSupportUnavailable(c,q.id,current.refusal.status===410?'source_expired':'source_changed');return current;}
 if(canonicalHash(current.leaf.policy)!==canonicalHash({revision:q.retention_revision,rawProviderEvidenceDays:q.raw_days_at_quote,derivedHistoryDays:q.derived_days_at_quote})){await markSupportUnavailable(c,q.id);return reject();}
 // Audit/source locks may have waited after the first quote read. Use a fresh
 // native clock and re-latch before exposing text or authorizing a reservation.
 await latchContentSupportExpiry(c,[p.id],undefined,[q.id]);q=await supportQuoteRow(c,p.id,q.id);if(q.raw_expired_at||q.input_purged_at)return reject(410,'The copied content assessment evidence expired.');return {q,payload};
}
function quoteDto(p:SupportProject,q:any){const expired=!!q.raw_expired_at||!!q.input_purged_at;return boundedSupport(contentSupportQuoteDtoSchema.parse({version:'ai-content-support-quote-v1',role:p.role,projectId:p.id,quote:{...contentSupportContract,id:q.id,requestId:q.request_id,createdAt:q.quote_created,expiresAt:q.quote_expires,inputHash:q.input_hash,payloadHash:q.payload_hash,schemaHash:q.schema_hash,queryReceiptHash:q.query_receipt_hash,corpusReceiptHash:q.corpus_receipt_hash,route:q.route,estimateUsd:usd(q.estimate_micros),inputExpired:expired,input:expired?null:(({maxSpendUsd:_stored,...request})=>request)(q.source_input),selection:expired?null:q.snapshot.selection}}));}
export function supportRunDto(p:SupportProject,q:any,r:any){const expired=!!q.raw_expired_at||!!q.input_purged_at,resultExpired=expired||!!r.result_purged_at,proposal=resultExpired?null:r.proposal;return boundedSupport(contentSupportRunDtoSchema.parse({version:'ai-content-support-run-v1',role:p.role,projectId:p.id,run:{...contentSupportContract,id:r.id,quoteId:q.id,requestId:r.request_id,inputHash:q.input_hash,payloadHash:q.payload_hash,queryReceiptHash:q.query_receipt_hash,corpusReceiptHash:q.corpus_receipt_hash,resultHash:proposal?canonicalHash(proposal):null,route:q.route,status:r.status,chargeStatus:r.charge_status,estimateUsd:usd(r.estimate_micros),actualUsd:r.actual_micros===null?null:usd(r.actual_micros),createdAt:r.run_created,dispatchedAt:r.run_dispatched,completedAt:r.run_completed,generationId:r.generation_id,diagnostic:r.diagnostic,inputExpired:expired,resultExpired,selection:expired?null:q.snapshot.selection,proposal,canCancel:p.role==='owner'&&r.status==='queued'&&r.charge_status==='reserved',canReconcile:p.role==='owner'&&r.charge_status==='uncertain'&&r.generation_id!==null}}));}
async function detail(c:PoolClient,p:SupportProject,id:string){let r=await supportRunRow(c,p.id,id),q=await supportQuoteRow(c,p.id,r.quote_id);await verifySupportSource(c,p,q);q=await supportQuoteRow(c,p.id,q.id);r=await supportRunRow(c,p.id,id);return supportRunDto(p,q,r);}
export async function getContentSupportRun(projectId:string,userId:string,id:string){parse(z.uuid(),id);return withSupportProject(projectId,userId,false,(c,p)=>detail(c,p,id));}
export async function getContentSupport(projectId:string,userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one content assessment cursor.');
 return withSupportProject(projectId,userId,false,async(c,p)=>{const scope={projectId,list:'ai-content-support'},cursor=readContentCursor(params.get('cursor'),scope),rows=(await c.query('SELECT id,created_at FROM ai_content_support_run WHERE project_id=$1 AND($2::timestamptz IS NULL OR(created_at,id)<($2::timestamptz,$3::uuid))ORDER BY created_at DESC,id DESC LIMIT 21',[p.id,cursor?.at??null,cursor?.id??null])).rows;
  const runs=[];for(const row of rows.slice(0,20))runs.push((await detail(c,p,row.id)).run);
  const connections=(await c.query("SELECT id,name,revision,check_status AS \"checkStatus\" FROM provider_connection WHERE workspace_id=$1 AND provider='openrouter' AND revoked_at IS NULL ORDER BY created_at,id",[p.workspaceId])).rows;
  return boundedSupport({version:'ai-content-support-list-v1',role:p.role,projectId,canQuote:p.role==='owner',admission:'owner-evaluation',semanticConclusions:'unverified',connections,runs,nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null});
 });
}
// ponytail: one bounded quote preparation per process; distributed admission only if measured load needs it.
let quoting=false;
export async function quoteContentSupport(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(contentSupportQuoteInputSchema,raw);if(Buffer.byteLength(JSON.stringify(input))>32768)throw new FoundationError(413,'The complete quote input exceeds 32 KiB.');if(quoting)throw new FoundationError(503,'Another content quote is being prepared.');quoting=true;
 try{
  const body={userId,input},first=supportResult(await withSupportProject(projectId,userId,true,async(c,p)=>{
   const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.quote',body);if(receipt.replayed){const q=await supportQuoteRow(c,p.id,receipt.result.id);await verifySupportSource(c,p,q);return {prior:quoteDto(p,await supportQuoteRow(c,p.id,q.id))};}
   const conn=await suggestionConnection(c,p.workspaceId,input.connectionId),selected=await source(c,p,input,true);if('refusal'in selected)return selected;
   const cutoffs=(await c.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp() AS at)SELECT ${clock("at-w.raw_provider_evidence_days*interval '24 hours'")} AS raw,${clock("at-w.derived_history_days*interval '24 hours'")} AS derived FROM stamp JOIN workspace w ON w.id=$1`,[p.workspaceId])).rows[0];return {selected,cutoffs,revision:conn.revision,credentials:suggestionCredentials(conn),workspaceId:p.workspaceId};
  }));if('prior'in first)return {...first.prior,replayed:true};
  const selected=selectEvidence(input,first.selected);first.selected.queries=undefined;if(selected.rawAnchor<first.cutoffs.raw||selected.derivedAnchor<first.cutoffs.derived)throw new FoundationError(410,'The original selected query or audit evidence exceeded this assessment’s retention policy.');createContentSupportSnapshot(selected.evidence);
  // ponytail: since D3 the stored ceiling records the quoted estimate, so historical payload and identity hashes need no legacy reader; a later contract migration may make max_spend_micros nullable.
  const route=await readContentSupportRoute(first.credentials,input.model,send),recorded=usd(BigInt(route.estimateMicros)),prepared=prepareContentSupportQuote(selected.evidence,route,recorded);for(const page of first.selected.bodies??[])page.text=null;
  return supportResult(await withSupportProject(projectId,userId,true,async(c,p)=>{
   const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.quote',body);if(receipt.replayed){const q=await supportQuoteRow(c,p.id,receipt.result.id);await verifySupportSource(c,p,q);return {...quoteDto(p,await supportQuoteRow(c,p.id,q.id)),replayed:true};}
   const conn=await suggestionConnection(c,p.workspaceId,input.connectionId,first.revision);if(keyFingerprint(suggestionCredentials(conn))!==keyFingerprint(first.credentials))return reject();
   const current=await source(c,p,input,false);if('refusal'in current)return current;if(canonicalHash(current.leaf.policy)!==canonicalHash(selected.policy))return reject();
   const times=(await c.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT ${clock('at')} AS created,${clock("at+interval '5 minutes'")} AS expires,($1::timestamptz<at-LEAST($3::integer,w.raw_provider_evidence_days)*interval '24 hours' OR $2::timestamptz<at-LEAST($4::integer,w.derived_history_days)*interval '24 hours')AS expired FROM stamp JOIN workspace w ON w.id=$5`,[selected.rawAnchor,selected.derivedAnchor,selected.policy.rawProviderEvidenceDays,selected.policy.derivedHistoryDays,p.workspaceId])).rows[0];if(times.expired)return reject(410,'The original selected evidence expired while preparing this quote.');const q={id:randomUUID(),workspace_id:p.workspaceId,project_id:p.id,user_id:userId,request_id:input.requestId,connection_id:input.connectionId,connection_revision:first.revision,request_actor:executionActor(userId),key_fingerprint:keyFingerprint(first.credentials),...Object.fromEntries(Object.entries(contentSupportContract).map(([k,v])=>[k.replace(/[A-Z]/g,l=>'_'+l.toLowerCase()),v])),source_kind:input.source.kind,audit_run_id:input.source.selection.auditRunId,payload_hash:prepared.payloadHash,schema_hash:prepared.schemaHash,query_receipt_hash:input.expectedQueryReceiptHash,corpus_receipt_hash:input.expectedCorpusReceiptHash,source_context_revision:selected.contextRevision,source_profile_hash:selected.profileHash,retention_revision:selected.policy.revision,raw_days_at_quote:selected.policy.rawProviderEvidenceDays,derived_days_at_quote:selected.policy.derivedHistoryDays,raw_anchor_at:selected.rawAnchor,derived_anchor_at:selected.derivedAnchor,raw_anchor:selected.rawAnchor,derived_anchor:selected.derivedAnchor,dependencies:selected.dependencies,source_input:{...input,maxSpendUsd:recorded},snapshot:{evidence:prepared.snapshot,selection:selected.selection},messages:prepared.messages,route:prepared.route,estimate_micros:prepared.estimateMicros,max_spend_micros:prepared.maxSpendUsd,quote_created:times.created,quote_expires:times.expires,created_at:times.created,expires_at:times.expires};
   q.max_spend_micros=usdMicros(recorded).toString();const hash=contentSupportIdentity(q);
   const columns=['id','workspace_id','project_id','user_id','request_id','connection_id','connection_revision','request_actor','key_fingerprint','purpose','prompt_version','schema_version','method','derivation_version','source_kind','audit_run_id','input_hash','payload_hash','schema_hash','query_receipt_hash','corpus_receipt_hash','source_context_revision','source_profile_hash','retention_revision','raw_days_at_quote','derived_days_at_quote','raw_anchor_at','derived_anchor_at','dependencies','source_input','snapshot','messages','route','estimate_micros','max_spend_micros','created_at','expires_at'],data={...q,input_hash:hash} as Record<string,unknown>,json=new Set(['dependencies','source_input','snapshot','messages','route']);
   await c.query(`INSERT INTO ai_content_support_quote(${columns.join(',')})VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(k=>json.has(k)?JSON.stringify(data[k]):data[k]));await receipt.save({id:q.id});return {...quoteDto(p,await supportQuoteRow(c,p.id,q.id)),replayed:false};
  }));
 }finally{quoting=false;}
}
export async function startContentSupport(projectId:string,userId:string,raw:unknown){
 const input=parse(contentSupportStartInputSchema,raw),body={userId,input};
 const replay=await withSupportProject(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.start',body);return receipt.replayed?{...await detail(c,p,receipt.result.id),replayed:true}:null;});if(replay)return replay;const boss=await getBoss();
 return supportResult(await withSupportProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.start',body);if(receipt.replayed)return {...await detail(c,p,receipt.result.id),replayed:true};
  let q=await supportQuoteRow(c,p.id,input.quoteId);if(q.user_id!==userId)throw missing();const current=await verifySupportSource(c,p,q);if('refusal'in current)return current;q=current.q;
  if(q.quote_expired)return reject();const conn=await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision);if(keyFingerprint(suggestionCredentials(conn))!==q.key_fingerprint)return reject();
  if((await c.query("SELECT 1 FROM ai_content_support_run WHERE project_id=$1 AND(quote_id=$2 OR status IN('queued','running','uncertain'))",[p.id,q.id])).rowCount)return reject();
  const reservation=await reserveSpendInTransaction(c,p.workspaceId,userId,{connectionId:q.connection_id,requestKey:input.requestId,operation:'ai.content.semantic',inputHash:q.input_hash,estimateUsd:usd(q.estimate_micros)},async(tx,id)=>{
   await tx.query("INSERT INTO ai_content_support_run(id,quote_id,workspace_id,project_id,user_id,request_id,status)VALUES($1,$2,$3,$4,$5,$6,'queued')",[id,q.id,p.workspaceId,p.id,userId,input.requestId]);if(await boss.send(contentSupportQueue,{runId:id},{id,retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>tx.query(text,values)}})!==id)throw new FoundationError(503,'The assessment could not be queued. Retry the same request ID.');
  });await receipt.save({id:reservation.id});return {...await detail(c,p,reservation.id),replayed:false};
 }));
}
export async function cancelContentSupport(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(contentSupportActionInputSchema,raw);return withSupportProject(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.cancel',{userId,id,input}),r=await supportRunRow(c,p.id,id);if(!receipt.replayed){if(r.charge_status!=='reserved'&&r.charge_status!=='cancelled')throw changed();await cancelSupportReservation(c,r);await receipt.save({id});}return {...await detail(c,p,id),replayed:receipt.replayed};});
}
export async function cancelSupportReservation(c:PoolClient,r:any){if(r.status!=='queued'||!['reserved','cancelled'].includes(r.charge_status))return;await c.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[r.id]);await c.query("UPDATE ai_content_support_run SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic='Stopped before dispatch. No paid request was sent.' WHERE id=$1",[r.id]);}
export async function exportContentSupport(projectId:string,userId:string,id:string,raw:unknown,signal?:AbortSignal){
 parse(z.uuid(),id);const expected=parse(contentSupportExportInputSchema,raw),check=()=>{if(signal?.aborted)throw new FoundationError(499,'Content assessment export cancelled.');};check();
 const first=await getContentSupportRun(projectId,userId,id),r=first.run;if(!r.proposal||!r.selection||!r.resultHash)throw new FoundationError(410,'No retained content assessment is available.');
 const hashes={expectedPayloadHash:r.payloadHash,expectedResultHash:r.resultHash,expectedQueryReceiptHash:r.queryReceiptHash,expectedCorpusReceiptHash:r.corpusReceiptHash};if(canonicalHash(hashes)!==canonicalHash(expected))throw changed();
 const rows:unknown[][]=[['query','assessment','rationale','citations','purpose','method','model','provider','estimateUsd','actualUsd','payloadHash','resultHash','queryReceiptHash','corpusReceiptHash'],...r.proposal.rows.map(row=>[r.selection!.queries.find(q=>q.id===row.queryId)!.key,row.state,row.rationale,row.citations,contentSupportContract.purpose,contentSupportContract.method,r.route.model,r.route.providerName,r.estimateUsd,r.actualUsd,r.payloadHash,r.resultHash,r.queryReceiptHash,r.corpusReceiptHash])],parts:Buffer[]=[];let size=0;
 for(const row of rows){check();const part=Buffer.from(row.map(csvCell).join(',')+'\r\n');size+=part.length;if(size>2_097_152)throw new FoundationError(413,'The complete CSV exceeds 2 MiB.');parts.push(part);}const bytes=Buffer.concat(parts,size);check();
 const last=await getContentSupportRun(projectId,userId,id);check();if(last.role!==first.role||last.run.inputExpired||last.run.resultExpired||!last.run.proposal||canonicalHash({expectedPayloadHash:last.run.payloadHash,expectedResultHash:last.run.resultHash,expectedQueryReceiptHash:last.run.queryReceiptHash,expectedCorpusReceiptHash:last.run.corpusReceiptHash})!==canonicalHash(expected))throw changed();
 return new Response(new Uint8Array(bytes),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="ai-content-support.csv"','content-length':String(size),'x-export-row-count':String(r.proposal.rows.length),'x-export-payload-hash':r.payloadHash,'x-export-result-hash':r.resultHash,'x-export-query-receipt':r.queryReceiptHash,'x-export-corpus-receipt':r.corpusReceiptHash,'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'}});
}
export async function expireContentSupport(c:PoolClient,projectId:string){
 await latchContentSupportExpiry(c,[projectId]);
 const results=await c.query(`WITH candidates AS(SELECT r.id FROM ai_content_support_run r JOIN ai_content_support_quote q ON q.id=r.quote_id WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL AND(r.raw_result IS NOT NULL OR r.proposal IS NOT NULL)ORDER BY r.created_at,r.id LIMIT 100 FOR UPDATE OF r)UPDATE ai_content_support_run r SET raw_result=NULL,proposal=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp())FROM candidates a WHERE r.id=a.id`,[projectId]);
 const inputs=await c.query(`WITH candidates AS(SELECT id FROM ai_content_support_quote WHERE project_id=$1 AND raw_expired_at IS NOT NULL AND input_purged_at IS NULL ORDER BY created_at,id LIMIT 100 FOR UPDATE)UPDATE ai_content_support_quote q SET source_input=NULL,snapshot=NULL,messages=NULL,input_purged_at=clock_timestamp()FROM candidates a WHERE q.id=a.id`,[projectId]);
 const pending=(await c.query(`SELECT EXISTS(SELECT 1 FROM ai_content_support_quote q WHERE q.project_id=$1 AND q.raw_expired_at IS NOT NULL AND(q.input_purged_at IS NULL OR EXISTS(SELECT 1 FROM ai_content_support_run r WHERE r.quote_id=q.id AND(r.raw_result IS NOT NULL OR r.proposal IS NOT NULL))))AS pending`,[projectId])).rows[0].pending;return {expiredContentSupportInputs:inputs.rowCount??0,expiredContentSupportResults:results.rowCount??0,pending};
}
export async function previewContentSupportRetention(c:PoolClient,workspaceId:string,rawDays:number,derivedDays:number){
 const rows=(await c.query(`SELECT q.id,q.input_purged_at IS NULL AS input,EXISTS(SELECT 1 FROM ai_content_support_run r WHERE r.quote_id=q.id AND(r.raw_result IS NOT NULL OR r.proposal IS NOT NULL))AS result FROM ai_content_support_quote q JOIN workspace w ON w.id=q.workspace_id WHERE q.workspace_id=$1 AND(q.raw_expired_at IS NOT NULL OR q.raw_anchor_at<clock_timestamp()-LEAST(q.raw_days_at_quote,w.raw_provider_evidence_days,$2)*interval '24 hours' OR q.derived_anchor_at<clock_timestamp()-LEAST(q.derived_days_at_quote,w.derived_history_days,$3)*interval '24 hours')AND(q.input_purged_at IS NULL OR EXISTS(SELECT 1 FROM ai_content_support_run r WHERE r.quote_id=q.id AND(r.raw_result IS NOT NULL OR r.proposal IS NOT NULL)))ORDER BY q.created_at,q.id LIMIT 10001`,[workspaceId,rawDays,derivedDays])).rows;return {status:'available' as const,inputs:rows.slice(0,10000).filter(r=>r.input).length,results:rows.slice(0,10000).filter(r=>r.result).length,atLeast:rows.length>10000};
}
