import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {withSupportProject,type SupportProject} from './ai-content-support.ts';
import {contentReceipt,contentCursor,readContentCursor} from './project-context.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {executionActor,keyFingerprint,readOpportunitiesRoute,executionRequestBody} from './openrouter.ts';
import {opportunitiesContract,opportunitiesLimits,opportunitiesPrepareInputSchema} from '../lib/ai-opportunities.ts';
import {opportunitiesPreparationDtoSchema,opportunitiesRunDtoSchema,opportunitiesHistorySummarySchema} from '../lib/ai-opportunities-run.ts';
import {assertOpportunitiesSourceCurrent,opportunitiesMessages,opportunitiesOutputSchema} from './ai-opportunities-input.ts';
import {selectOpportunitiesSource} from './ai-opportunities-source.ts';
import {opportunityRecoveryCredentials} from './ai-opportunities-recovery.ts';
import {opportunityClock,opportunityIdentity,opportunityPreparationRow,opportunityRunSelect,verifyOpportunitySource,readOpportunityReport,markOpportunityUnavailable,availableOpportunityPreparations,type OpportunityPreparationRow,type OpportunityRunRow} from './ai-opportunities-rows.ts';

export const opportunitiesQueue='ai-opportunities';
export type OpportunitiesProject=SupportProject&{name:string};
export async function withOpportunitiesProject<T>(projectId:string,userId:string|null,owner:boolean,work:(c:PoolClient,p:OpportunitiesProject)=>Promise<T>,ledgerId?:string){return withSupportProject(projectId,userId,owner,async(c,p)=>{const row=(await c.query<{name:string}>('SELECT name FROM project WHERE id=$1',[p.id])).rows[0];return work(c,{...p,name:row.name});},ledgerId);}
const changed=()=>new FoundationError(409,'The opportunity source or connection changed. Prepare this request again.');
const visibleRoute=(q:OpportunityPreparationRow)=>({model:q.route.model,provider:q.route.providerName});
function preparationDto(q:OpportunityPreparationRow,replayed:boolean){return opportunitiesPreparationDtoSchema.parse({id:q.id,requestId:q.request_id,createdAt:q.created,expiresAt:q.expires,expired:q.expired,available:!q.raw_expired_at&&!q.input_purged_at,route:visibleRoute(q),replayed});}
async function replay(c:PoolClient,p:OpportunitiesProject,id:string){let q=await opportunityPreparationRow(c,p.id,id);await verifyOpportunitySource(c,q);q=await opportunityPreparationRow(c,p.id,id);return preparationDto(q,true);}
export async function prepareOpportunities(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(opportunitiesPrepareInputSchema,raw),body={userId,input};
 if(Buffer.byteLength(JSON.stringify(input))>32768)throw new FoundationError(413,'The preparation input exceeds its capacity.');
 const first=await withOpportunitiesProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.prepare',body);if(receipt.replayed)return {prior:await replay(c,p,receipt.result.id)};
  const connection=await suggestionConnection(c,p.workspaceId,input.connectionId),source=await selectOpportunitiesSource(c,{...p,role:p.role!},input.expectedSource.scope,()=>{});
  assertOpportunitiesSourceCurrent(source.snapshot,input.expectedSource);if(source.availability!=='available')throw new FoundationError(409,'No eligible retained API answers are available for these filters.');
  return {source,revision:connection.revision as number,credentials:suggestionCredentials(connection)};
 });if('prior'in first){if(!first.prior)throw changed();return first.prior;}
 const route=await readOpportunitiesRoute(first.credentials,input.model,send),messages=opportunitiesMessages(first.source.snapshot),schemaHash=canonicalHash(opportunitiesOutputSchema),payloadHash=canonicalHash({snapshot:first.source.snapshot,messages,route,schemaHash,outputTokens:opportunitiesLimits.outputTokens}),id=randomUUID(),actor=executionActor(userId);
 executionRequestBody(messages,route,opportunitiesLimits.outputTokens,id,actor,opportunitiesContract.purpose);
 return withOpportunitiesProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.prepare',body);if(receipt.replayed)return replay(c,p,receipt.result.id);
  const connection=await suggestionConnection(c,p.workspaceId,input.connectionId,first.revision);if(keyFingerprint(suggestionCredentials(connection))!==keyFingerprint(first.credentials))throw changed();
  const current=await selectOpportunitiesSource(c,{...p,role:p.role!},input.expectedSource.scope,()=>{});assertOpportunitiesSourceCurrent(current.snapshot,input.expectedSource);
  if(current.evidenceHash!==first.source.evidenceHash||canonicalHash(current.dependencies)!==canonicalHash(first.source.dependencies))throw changed();
  const s=current.snapshot.source,times=(await c.query<{created:string;expires:string}>(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT ${opportunityClock('at')} AS created,${opportunityClock("at+interval '5 minutes'")} AS expires FROM tick`)).rows[0];
  const q:OpportunityPreparationRow={id,workspace_id:p.workspaceId,project_id:p.id,user_id:userId,request_id:input.requestId,connection_id:input.connectionId,connection_revision:first.revision,request_actor:actor,key_fingerprint:keyFingerprint(first.credentials),purpose:opportunitiesContract.purpose,prompt_version:opportunitiesContract.promptVersion,schema_version:1,method:opportunitiesContract.method,source_kind:opportunitiesContract.sourceKind,input_hash:'',payload_hash:payloadHash,schema_hash:schemaHash,evidence_hash:current.evidenceHash,business_input_hash:current.businessInputHash,retention_revision:s.retentionRevision,raw_days_at_preparation:s.rawDays,derived_days_at_preparation:s.derivedDays,raw_anchor:s.rawAnchorAt!,derived_anchor:s.derivedAnchorAt!,dependencies:current.dependencies,source_input:input,snapshot:current.snapshot,messages,route,...times,expired:false,raw_expired_at:null,input_purged_at:null,unavailable_reason:null};q.input_hash=opportunityIdentity(q);
  const {created,expires,expired:_,raw_anchor,derived_anchor,...stored}=q,record={...stored,created_at:created,expires_at:expires,raw_anchor_at:raw_anchor,derived_anchor_at:derived_anchor},columns=Object.keys(record),json=new Set(['dependencies','source_input','snapshot','messages','route']);
  await c.query(`INSERT INTO ai_opportunity_preparation(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.entries(record).map(([key,value])=>json.has(key)?JSON.stringify(value):value));
  await receipt.save({id});return preparationDto(await opportunityPreparationRow(c,p.id,id),false);
 });
}
async function runDto(c:PoolClient,p:OpportunitiesProject,r:OpportunityRunRow){
 let q=await opportunityPreparationRow(c,p.id,r.preparation_id),payload=await verifyOpportunitySource(c,q),report=null;
 if(payload&&r.status==='completed'&&!r.result_purged_at){try{report=readOpportunityReport(r,payload);}catch{await markOpportunityUnavailable(c,q);payload=null;}}
 let canRecover=false;if(p.role==='owner'&&r.status==='uncertain'&&r.generation_id&&r.dispatched){try{await opportunityRecoveryCredentials(c,p,q);canRecover=true;}catch{/* Recovery never bypasses the original credential binding. */}}
 return opportunitiesRunDtoSchema.parse({id:r.id,preparationId:r.preparation_id,status:r.status,createdAt:r.created,dispatchedAt:r.dispatched,completedAt:r.completed,route:visibleRoute(q),promptTokens:r.prompt_tokens,completionTokens:r.completion_tokens,diagnostic:r.diagnostic?r.status==='uncertain'?'The original request outcome is unknown.':r.status==='failed'?'This request did not produce a valid report.':null:null,canRecover,available:report!==null,savedEvidence:payload?{scope:payload.snapshot.source.scope,subjects:payload.snapshot.subjects,prompts:payload.snapshot.prompts,citations:payload.snapshot.citations}:null,report});
}
export async function getOpportunitiesRun(projectId:string,userId:string,id:string){parse(z.uuid(),id);return withOpportunitiesProject(projectId,userId,false,async(c,p)=>{const r=(await c.query<OpportunityRunRow>(opportunityRunSelect+' WHERE r.project_id=$1 AND r.id=$2',[p.id,id])).rows[0];if(!r)throw new FoundationError(404,'Opportunity run not found.');const run=await runDto(c,p,r);if(!(await availableOpportunityPreparations(c,p.id,[r.preparation_id])).has(r.preparation_id)){run.available=false;run.report=null;run.savedEvidence=null;}return {projectId,role:p.role,run};});}
export async function getOpportunities(projectId:string,userId:string,params=new URLSearchParams()){
 if(params.toString().length>2048||[...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one opportunity history cursor.');
 return withOpportunitiesProject(projectId,userId,false,async(c,p)=>{
  // Native content cursors preserve milliseconds; use that same precision for both ordering and comparison.
  const scope={projectId,list:opportunitiesQueue},cursor=readContentCursor(params.get('cursor'),scope),rows=(await c.query<OpportunityRunRow>(opportunityRunSelect+" WHERE r.project_id=$1 AND($2::timestamptz IS NULL OR(date_trunc('milliseconds',r.created_at),r.id)<($2::timestamptz,$3::uuid)) ORDER BY date_trunc('milliseconds',r.created_at) DESC,r.id DESC LIMIT 21",[p.id,cursor?.at??null,cursor?.id??null])).rows,runs=[];
  for(const r of rows.slice(0,20)){const {savedEvidence:_,report:__,...summary}=await runDto(c,p,r);runs.push(opportunitiesHistorySummarySchema.parse(summary));}
  const connections=p.role==='owner'?(await c.query<{id:string;name:string;revision:number;checkStatus:string}>(`SELECT id,name,revision,check_status AS "checkStatus" FROM provider_connection WHERE workspace_id=$1 AND provider='openrouter' AND revoked_at IS NULL ORDER BY created_at,id LIMIT 100`,[p.workspaceId])).rows:[];
  const available=await availableOpportunityPreparations(c,p.id,runs.map(r=>r.preparationId));for(const run of runs)if(!available.has(run.preparationId))run.available=false;
  return {projectId,role:p.role,canPrepare:p.role==='owner',connections,runs,nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created},scope):null};
 });
}
