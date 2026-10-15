import {contentCoverageLimits as limits,contentCoverageMethod,normalizeContentText,contentPhraseMatches} from '../lib/ai-content-coverage.ts';
import {contentCoverageInputSchema,contentCoverageExportInputSchema,contentCoverageReportSchema,contentPageStates,type ContentCoverageInput,type ContentCoverageReport} from '../lib/ai-content-coverage.ts';
import {withAuditLock,readAuditCoveragePages,parseSiteAuditPagesExport} from './site-audits.ts';
import {readAiSearchCoverageSource} from './ai-search.ts';
import {deriveSearchQueries,SearchEvidenceError,queryDerivationVersion} from './ai-search-evidence.ts';
import {canonicalHash,parse} from './context-input.ts';
import {FoundationError} from './auth.ts';
import {csvCell} from './explorer-input.ts';

export class ContentCoverageCapacityError extends Error{}
export type ContentPageState=typeof contentPageStates[number];
export type ContentPage={id:string;url:string;observedAt:string|null;state:ContentPageState;extractionVersion:string|null;bodySha256:string|null;text:string|null};
export type ContentQuery={key:string;firstIndex:number;indexes:number[]};
const states=contentPageStates;
const capacity=():never=>{throw new ContentCoverageCapacityError('Narrow the selection. Website-text comparison exceeds its complete-report capacity.');};

/** Receives only receipt-validated, currently authorized immutable source snapshots. */
export function calculateLiteralCoverage(queries:ContentQuery[]|null,pages:ContentPage[],check:()=>void=()=>{}){
 if(pages.length>limits.selectedPages||queries!==null&&queries.length>limits.queries)capacity();
 if(new Set(pages.map(p=>p.id)).size!==pages.length||queries&&new Set(queries.map(q=>q.key)).size!==queries.length)throw new Error('Duplicate coverage identity.');
 const counts=Object.fromEntries(states.map(s=>[s,0])) as Record<ContentPageState,number>;
 let rawBytes=0;
 for(const page of pages){
  check();if(!states.includes(page.state))throw new Error('Unknown content state.');counts[page.state]++;
  if(page.state==='available'||page.state==='empty'){
   if(typeof page.text!=='string'||page.extractionVersion!=='static-dom-body-v1'||!page.observedAt||!page.bodySha256||!/^[a-f0-9]{64}$/.test(page.bodySha256)||(page.state==='empty')!==(page.text===''))throw new Error('Invalid readable page receipt.');
   const bytes=Buffer.byteLength(page.text);if(bytes>65536)throw new Error('Invalid whole captured body.');rawBytes+=bytes;
  }else if(page.text!==null)throw new Error('Unreadable content must not be materialized.');
 }
 const readable=counts.available+counts.empty;if(readable>limits.readablePages||rawBytes>limits.rawBytes)capacity();
 const pageCoverage={selected:pages.length,readable,unassessable:pages.length-readable,states:counts};
 if(queries===null)return {method:contentCoverageMethod,queryPopulation:'unavailable' as const,pageCoverage,rows:null,rate:{numerator:null,denominator:null,value:null},work:0};
 const rows=queries.map(q=>{
  if(!q.key||q.key.length>4000||!Number.isInteger(q.firstIndex)||q.firstIndex<0||q.firstIndex>99||!q.indexes.length||q.indexes.length>100||q.indexes[0]!==q.firstIndex||q.indexes.some((v,i)=>!Number.isInteger(v)||v<0||v>99||i>0&&v<=q.indexes[i-1]))throw new Error('Invalid source query identity.');
  return {...q,indexes:[...q.indexes],state:readable?'not_found_in_readable_pages' as const:'not_assessed' as const,matchedPageCount:0,assessedPageCount:readable,unassessableSelectedPageCount:pages.length-readable,examples:[] as Omit<ContentPage,'state'|'text'>[]};
 });
 const needles=queries.map(q=>normalizeContentText(q.key));let work=0;
 // ponytail: complete bounded literal scan, <=100 million UTF-16-unit/query work;
 // use measured indexing if a future corpus/query ceiling must grow.
 for(const page of pages){
  check();if(page.state!=='available'&&page.state!=='empty')continue;
  const body=normalizeContentText(page.text!);work+=body.length*queries.length;if(work>limits.work)capacity();
  for(let i=0;i<rows.length;i++){
   check();if(!contentPhraseMatches(body,needles[i]))continue;
   const row=rows[i];row.matchedPageCount++;
   if(row.examples.length<limits.examples){const {text,state,...reference}=page;row.examples.push(reference);}
  }
 }
 const resultRows=rows.map(row=>({...row,state:row.matchedPageCount?'found' as const:row.state,returnedExamples:row.examples.length,exampleLimit:limits.examples}));
 const numerator=resultRows.filter(row=>row.matchedPageCount>0).length,denominator=readable?queries.length:0;
 return {method:contentCoverageMethod,queryPopulation:'reported' as const,pageCoverage,rows:resultRows,rate:{numerator,denominator,value:denominator?numerator/denominator:null},work};
}

const busy=()=>Object.assign(new FoundationError(503,'Website-text comparison is busy. Try again shortly.'),{code:'CONTENT_COVERAGE_BUSY'});
function refused(reason:string):never{
 if(['source_capacity','body_capacity','population'].includes(reason))throw new FoundationError(413,'Narrow the selection. Website-text comparison exceeds its complete-report capacity.');
 if(reason==='audit_expired')throw new FoundationError(410,'This audit data expired. Choose another audit.');
 throw new FoundationError(409,reason==='audit_active'?'Finish or cancel this audit before comparing its text.':'The captured evidence or page selection changed. Reload the pages and compare again.');
}
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new FoundationError(499,'Website-text comparison was cancelled.');};

/** Internal two-phase read boundary; no network or nested transaction is used. */
export async function readContentCoverageSnapshot(projectId:string,userId:string,input:ContentCoverageInput,materialize=true,signal?:AbortSignal){
 abort(signal);const query=parseSiteAuditPagesExport(input.pages);
 const result=await withAuditLock({projectId,runId:input.auditRunId,actor:{userId,permission:'read'}},async locked=>{
  abort(signal);await locked.client.query("SET LOCAL statement_timeout='5s'");
  const source=await readAiSearchCoverageSource(locked.client,projectId,input.captureId,materialize);
  // Tagged logical refusals commit newly observed raw-expiry markers.
  if(source.coverageError)return source;
  const selected=await readAuditCoveragePages(locked,query,materialize);if(selected.coverageError)return selected;
  const policy=(await locked.client.query('SELECT retention_revision AS revision,raw_provider_evidence_days AS "rawProviderEvidenceDays",derived_history_days AS "derivedHistoryDays",clock_timestamp() AS at FROM workspace WHERE id=$1',[locked.project.workspaceId])).rows[0];
  if(!policy)throw new FoundationError(404,'Project not found or unavailable.');
  abort(signal);return {source:source.source,queryReceiptHash:canonicalHash({version:'captured-query-receipt-v1',derivationVersion:queryDerivationVersion,method:contentCoverageMethod,...source.receipt}),corpusReceiptHash:canonicalHash({version:'captured-body-receipt-v1',projectId,projectOrigin:locked.project.origin,policy:{revision:policy.revision,rawProviderEvidenceDays:policy.rawProviderEvidenceDays,derivedHistoryDays:policy.derivedHistoryDays},...selected.receipt}),pages:selected.pages,policy:{revision:policy.revision as number,rawProviderEvidenceDays:policy.rawProviderEvidenceDays as number,derivedHistoryDays:policy.derivedHistoryDays as number},audit:selected.receipt.run,projectOrigin:locked.project.origin,role:locked.role!,asOf:(policy.at as Date).toISOString(),sourceReceipt:source.receipt};
 });
 if('coverageError'in result)refused(result.coverageError!);return result;
}
type CoverageSnapshot=Awaited<ReturnType<typeof readContentCoverageSnapshot>>;
/** Publication rechecks the same immutable receipt after computation outside SQL locks. */
export async function confirmContentCoverageSnapshot(projectId:string,userId:string,input:ContentCoverageInput,snapshot:CoverageSnapshot,signal?:AbortSignal){
 const current=await readContentCoverageSnapshot(projectId,userId,input,false,signal);
 if(current.queryReceiptHash!==snapshot.queryReceiptHash||current.corpusReceiptHash!==snapshot.corpusReceiptHash)refused('selection_changed');return current;
}
// ponytail: one bounded calculation per web process; measure cluster-wide admission
// only if sustained concurrent content work becomes a requirement.
let active=false;
export async function getContentCoverage(projectId:string,userId:string,raw:unknown,signal?:AbortSignal):Promise<ContentCoverageReport>{
 const input=parse(contentCoverageInputSchema,raw);if(active)throw busy();active=true;
 try{
  const snapshot=await readContentCoverageSnapshot(projectId,userId,input,true,signal),source=snapshot.source!;
  abort(signal);const started=performance.now(),check=()=>{abort(signal);if(performance.now()-started>5000)throw busy();};
  let derived:ReturnType<typeof deriveSearchQueries>|null=null;
  try{if(source.result)derived=deriveSearchQueries({evidence:source.result.evidence,capturedPrompt:source.result.capturedPrompt,subjects:[],method:'unicode-boundary-v1'});}catch(error){if(error instanceof SearchEvidenceError)throw new FoundationError(413,'The captured query evidence exceeds its supported derivation capacity.');throw error;}
  check();if(derived)derived.words=null;
  const calculated=calculateLiteralCoverage(derived?.queries??null,snapshot.pages,check);
  // Body text never enters a response or survives the calculation's publication wait.
  for(const page of snapshot.pages)page.text=null;
  const verified=await confirmContentCoverageSnapshot(projectId,userId,input,snapshot,signal);abort(signal);
  const observed=snapshot.pages.map(p=>p.observedAt).filter((v):v is string=>v!==null).sort();
  const result={version:'ai-content-literal-v1',role:verified.role,projectId,snapshotAt:snapshot.asOf,asOf:verified.asOf,applied:input,queryReceiptHash:snapshot.queryReceiptHash,corpusReceiptHash:snapshot.corpusReceiptHash,
   querySource:{captureId:source.id,quoteId:snapshot.sourceReceipt.quote_id,promptId:source.promptId,versionId:source.versionId,requestedAt:source.requestedAt,quoteCreatedAt:snapshot.sourceReceipt.captured_at,receivedAt:source.result?.receivedAt??null,providerObservedAt:source.result?.providerObservedAt??null,rawState:source.rawState,queryState:derived?.queryState??'raw_unavailable',rawQueryCount:derived?.rawQueryCount??null,blankQueries:derived?.blankIndexes?.length??null,echoQueries:derived?.echoIndexes?.length??null},
   audit:{id:input.auditRunId,origin:snapshot.audit.origin,currentProjectOrigin:snapshot.projectOrigin,status:snapshot.audit.status,completedAt:snapshot.audit.completedAt,retainBodyText:snapshot.audit.config?.retainBodyText===true,mode:snapshot.audit.config?.mode,startPath:snapshot.audit.config?.startPath,maxPages:snapshot.audit.config?.maxPages,coverage:snapshot.audit.coverage,observationRange:{from:observed[0]??null,to:observed.at(-1)??null}},policy:snapshot.policy,
   ...calculated,rows:calculated.rows?.map(row=>({...row,examples:row.examples.map(ref=>({...ref,auditRunId:input.auditRunId}))}))??null};
  if(Buffer.byteLength(JSON.stringify(result))>limits.responseBytes)throw new FoundationError(413,'Narrow the selection. Website-text comparison exceeds its complete response limit.');
  try{return contentCoverageReportSchema.parse(result);}catch{throw new FoundationError(503,'Stored website-text evidence is inconsistent. Choose another audit or capture.');}
 }catch(error){if(error instanceof ContentCoverageCapacityError)throw new FoundationError(413,error.message);if(error instanceof FoundationError&&error.status===503)throw Object.assign(error,{code:'CONTENT_COVERAGE_BUSY'});throw error;}
 finally{active=false;}
}
export async function exportContentCoverage(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 const {expectedQueryReceiptHash,expectedCorpusReceiptHash,...input}=parse(contentCoverageExportInputSchema,raw),report=await getContentCoverage(projectId,userId,input,signal);abort(signal);
 if(report.queryReceiptHash!==expectedQueryReceiptHash||report.corpusReceiptHash!==expectedCorpusReceiptHash)refused('selection_changed');
 const rows:unknown[][]=[['recordType','version','method','projectId','captureId','auditRunId','snapshotAt','verifiedAt','queryReceiptHash','corpusReceiptHash','scope','query','state','matchedPages','assessedPages','unassessableSelectedPages','returnedExamples','exampleLimit','examplePageIds'],['metadata',report.version,report.method,projectId,input.captureId,input.auditRunId,report.snapshotAt,report.asOf,report.queryReceiptHash,report.corpusReceiptHash,{selection:report.applied.pages,querySource:report.querySource,audit:report.audit,policy:report.policy,pageCoverage:report.pageCoverage,rate:report.rate},...Array(8).fill('')]];
 for(const row of report.rows??[])rows.push(['query',...Array(10).fill(''),row.key,row.state,row.matchedPageCount,row.assessedPageCount,row.unassessableSelectedPageCount,row.returnedExamples,row.exampleLimit,row.examples.map(e=>e.id)]);
 const parts:Buffer[]=[];let size=0;for(const row of rows){abort(signal);const line=Buffer.from(row.map(csvCell).join(',')+'\r\n');size+=line.length;if(size>limits.responseBytes)throw new FoundationError(413,'The complete website-text CSV exceeds its capacity. Narrow the selection.');parts.push(line);}
 const bytes=Buffer.concat(parts,size);abort(signal);return new Response(new Uint8Array(bytes),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="ai-content-coverage.csv"','content-length':String(bytes.length),'x-export-row-count':String(report.rows?.length??0),'x-export-query-receipt':report.queryReceiptHash,'x-export-corpus-receipt':report.corpusReceiptHash,'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'}});
}
