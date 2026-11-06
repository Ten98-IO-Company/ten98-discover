import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {opportunitiesContract,opportunitiesLimits,opportunitiesPrepareInputSchema,opportunitiesReportSchema} from '../lib/ai-opportunities.ts';
import {opportunitiesMessages,opportunitiesOutputSchema,opportunitiesEvidenceHash,opportunitiesBusinessIdentity,parseOpportunitiesProposal,type OpportunitiesSnapshot} from './ai-opportunities-input.ts';
import {executionInput,validateExecutionPayload,type RouteSnapshot} from './openrouter-input.ts';
import {executionRequestBody} from './openrouter.ts';
import {openRouterRouteIdentity} from '../lib/openrouter-models.ts';
import {latchOpportunitiesExpiry} from './ai-opportunities-retention.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/),stamp=z.iso.datetime({precision:6});
export const opportunityDependenciesSchema=z.array(z.object({executionId:z.uuid(),comparisonId:z.uuid(),quoteId:z.uuid(),promptId:z.uuid(),versionId:z.uuid(),quoteCreatedAt:stamp,requestedAt:stamp,completedAt:stamp,resultHash:hash,requestHash:hash}).strict()).min(1).max(1000).refine(v=>new Set(v.map(d=>d.executionId)).size===v.length);
export type OpportunityPreparationRow={id:string;workspace_id:string;project_id:string;user_id:string;request_id:string;connection_id:string;connection_revision:number;request_actor:string;key_fingerprint:string;purpose:string;prompt_version:string;schema_version:number;method:string;source_kind:string;input_hash:string;payload_hash:string;schema_hash:string;evidence_hash:string;business_input_hash:string;retention_revision:number;raw_days_at_preparation:number;derived_days_at_preparation:number;raw_anchor:string;derived_anchor:string;dependencies:unknown;source_input:unknown;snapshot:unknown;messages:unknown;route:RouteSnapshot;created:string;expires:string;expired:boolean;raw_expired_at:Date|null;input_purged_at:Date|null;unavailable_reason:string|null};
export type OpportunityRunRow={id:string;preparation_id:string;project_id:string;workspace_id:string;user_id:string;request_id:string;status:'queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled';generation_id:string|null;raw_result:string|null;proposal:unknown;result_hash:string|null;result_purged_at:Date|null;prompt_tokens:number|null;completion_tokens:number|null;diagnostic:string|null;created:string;dispatched:string|null;completed:string|null};
export const opportunityClock=(field:string)=>`to_char((${field}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const opportunityPreparationSelect=`SELECT q.*,${opportunityClock('q.created_at')} AS created,${opportunityClock('q.expires_at')} AS expires,${opportunityClock('q.raw_anchor_at')} AS raw_anchor,${opportunityClock('q.derived_anchor_at')} AS derived_anchor,q.expires_at<=clock_timestamp() AS expired FROM ai_opportunity_preparation q`;
export const opportunityRunSelect=`SELECT r.*,${opportunityClock('r.created_at')} AS created,${opportunityClock('r.dispatched_at')} AS dispatched,${opportunityClock('r.completed_at')} AS completed FROM ai_opportunity_run r`;
const changed=()=>new FoundationError(409,'The saved opportunity evidence is unavailable.');
export async function opportunityPreparationRow(c:PoolClient,projectId:string,id:string){const q=(await c.query<OpportunityPreparationRow>(opportunityPreparationSelect+' WHERE q.project_id=$1 AND q.id=$2',[projectId,id])).rows[0];if(!q)throw new FoundationError(404,'Opportunity preparation not found.');return q;}
export function opportunityIdentity(q:OpportunityPreparationRow){return canonicalHash({id:q.id,workspaceId:q.workspace_id,projectId:q.project_id,userId:q.user_id,requestId:q.request_id,connectionId:q.connection_id,connectionRevision:q.connection_revision,actor:q.request_actor,key:q.key_fingerprint,purpose:q.purpose,promptVersion:q.prompt_version,schemaVersion:q.schema_version,method:q.method,sourceKind:q.source_kind,payloadHash:q.payload_hash,schemaHash:q.schema_hash,evidenceHash:q.evidence_hash,businessInputHash:q.business_input_hash,retentionRevision:q.retention_revision,rawDays:q.raw_days_at_preparation,derivedDays:q.derived_days_at_preparation,rawAnchor:q.raw_anchor,derivedAnchor:q.derived_anchor,dependencies:q.dependencies,input:q.source_input,route:q.route,created:q.created,expires:q.expires});}
export function readOpportunityPayload(q:OpportunityPreparationRow){
 if(q.raw_expired_at||q.input_purged_at||opportunityIdentity(q)!==q.input_hash)throw changed();
 const input=parse(opportunitiesPrepareInputSchema,q.source_input),snapshot=q.snapshot as OpportunitiesSnapshot,messages=opportunitiesMessages(snapshot),dependencies=parse(opportunityDependenciesSchema,q.dependencies),schemaHash=canonicalHash(opportunitiesOutputSchema);
 executionRequestBody(messages,q.route,opportunitiesLimits.outputTokens,q.id,q.request_actor,opportunitiesContract.purpose);
 const payloadHash=canonicalHash({snapshot,messages,route:q.route,schemaHash,outputTokens:opportunitiesLimits.outputTokens});
 if(q.purpose!==opportunitiesContract.purpose||q.prompt_version!==opportunitiesContract.promptVersion||q.schema_version!==1||q.method!==opportunitiesContract.method||q.source_kind!==opportunitiesContract.sourceKind||input.requestId!==q.request_id||input.connectionId!==q.connection_id||input.model!==q.route.model||snapshot.source.projectId!==q.project_id||canonicalHash(input.expectedSource)!==canonicalHash(snapshot.source)||q.schema_hash!==schemaHash||q.payload_hash!==payloadHash||canonicalHash(messages)!==canonicalHash(q.messages)||opportunitiesEvidenceHash(snapshot)!==q.evidence_hash||opportunitiesBusinessIdentity(snapshot)!==q.business_input_hash||q.raw_anchor!==snapshot.source.rawAnchorAt||q.derived_anchor!==snapshot.source.derivedAnchorAt||q.retention_revision!==snapshot.source.retentionRevision||q.raw_days_at_preparation!==snapshot.source.rawDays||q.derived_days_at_preparation!==snapshot.source.derivedDays)throw changed();
 if(dependencies.length!==snapshot.executions.length||dependencies.some(d=>{const e=snapshot.executions.find(e=>e.id===d.executionId);return !e||e.promptId!==d.promptId||e.versionId!==d.versionId||e.requestedAt!==d.requestedAt||e.completedAt!==d.completedAt||e.resultHash!==d.resultHash||e.requestHash!==d.requestHash;}))throw changed();
 return {input,snapshot,messages,dependencies,route:q.route,payloadHash,schemaHash};
}
export async function markOpportunityUnavailable(c:PoolClient,q:OpportunityPreparationRow,reason='source_changed'){
 await c.query('UPDATE ai_opportunity_preparation SET raw_expired_at=COALESCE(raw_expired_at,clock_timestamp()),unavailable_reason=COALESCE(unavailable_reason,$3) WHERE id=$1 AND project_id=$2',[q.id,q.project_id,reason]);
 await c.query('UPDATE ai_opportunity_run SET raw_result=NULL,proposal=NULL,result_hash=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp()) WHERE preparation_id=$1 AND project_id=$2',[q.id,q.project_id]);
}
/** A fresh database clock closes CPU/query time between validation and publication.
 * The caller retains the workspace/project locks; expiry remains permanently latched. */
export async function availableOpportunityPreparations(c:PoolClient,projectId:string,ids:string[]){
 if(!ids.length)return new Set<string>();
 await latchOpportunitiesExpiry(c,[projectId],undefined,ids);
 const rows=(await c.query<{id:string}>('SELECT id FROM ai_opportunity_preparation WHERE project_id=$1 AND id=ANY($2::uuid[]) AND raw_expired_at IS NULL AND input_purged_at IS NULL',[projectId,ids])).rows;
 return new Set(rows.map(r=>r.id));
}
/** Saved generations verify only their immutable dependency set, never today's population/context. */
export async function verifyOpportunitySource(c:PoolClient,q:OpportunityPreparationRow){
 await latchOpportunitiesExpiry(c,[q.project_id],undefined,[q.id]);q=await opportunityPreparationRow(c,q.project_id,q.id);if(q.raw_expired_at||q.input_purged_at)return null;
 try{
  const payload=readOpportunityPayload(q);
  const rows=(await c.query<{id:string;comparison_id:string;quote_id:string;prompt_id:string;version_id:string;result_hash:string;input:unknown;messages:unknown;text:string;route:RouteSnapshot;request_version:number}>(`SELECT e.id,c.id AS comparison_id,s.id AS quote_id,s.prompt_id,s.version_id,encode(sha256(convert_to(e.result::text,'UTF8')),'hex') AS result_hash,s.input,s.messages,s.request_version,v.text,e.route FROM prompt_execution e JOIN prompt_comparison c ON c.id=e.comparison_id AND c.project_id=e.project_id AND c.workspace_id=e.workspace_id JOIN prompt_execution_quote s ON s.id=c.quote_id AND s.project_id=c.project_id AND s.workspace_id=c.workspace_id JOIN prompt_text_version v ON v.id=s.version_id AND v.prompt_id=s.prompt_id AND v.project_id=s.project_id WHERE e.project_id=$1 AND e.workspace_id=$2 AND e.id=ANY($3::uuid[]) AND e.status='completed' AND e.result IS NOT NULL AND e.result_purged_at IS NULL AND s.input_purged_at IS NULL`,[q.project_id,q.workspace_id,payload.dependencies.map(d=>d.executionId)])).rows;
  if(rows.length!==payload.dependencies.length)throw changed();
  for(const d of payload.dependencies){const r=rows.find(r=>r.id===d.executionId);if(!r||r.comparison_id!==d.comparisonId||r.quote_id!==d.quoteId||r.prompt_id!==d.promptId||r.version_id!==d.versionId||r.result_hash!==d.resultHash||![0,1].includes(r.request_version))throw changed();
   let raw=r.input;if(r.request_version===0&&raw&&typeof raw==='object'&&!Array.isArray(raw)&&'fundedCredits'in raw){const {fundedCredits,...rest}=raw;raw=fundedCredits===true?rest:null;}
   const input=parse(executionInput,raw),messages=[...(input.systemText?[{role:'system' as const,content:input.systemText}]:[]),{role:'user' as const,content:r.text}];
   if(input.promptId.toLowerCase()!==d.promptId||input.versionId.toLowerCase()!==d.versionId||!openRouterRouteIdentity(r.route)||!input.models.includes(r.route.model)||canonicalHash(messages)!==canonicalHash(r.messages)||payload.snapshot.prompts.find(p=>p.versionId===d.versionId)?.text!==r.text)throw changed();
   validateExecutionPayload(messages,r.route,input.maxCompletionTokens);
   if(canonicalHash({profile:r.route.profile??'openrouter-api-text-no-search-v1',promptId:d.promptId,versionId:d.versionId,messages,maxCompletionTokens:input.maxCompletionTokens,model:r.route.model,provider:r.route.tag,serviceTier:'default',fallback:false})!==d.requestHash)throw changed();
  }return (await availableOpportunityPreparations(c,q.project_id,[q.id])).has(q.id)?payload:null;
 }catch(error){if(!(error instanceof FoundationError)&&!(error instanceof z.ZodError)&&!(error instanceof TypeError))throw error;await markOpportunityUnavailable(c,q);return null;}
}
export function readOpportunityReport(r:OpportunityRunRow,payload:ReturnType<typeof readOpportunityPayload>){const report=parse(opportunitiesReportSchema,r.proposal);if(canonicalHash(report)!==r.result_hash)throw changed();const {sourceKind:_,evidenceHash:__,semanticConclusions:___,evidenceValidation:____,...proposal}=report;const verified=parseOpportunitiesProposal(JSON.stringify(proposal),payload.snapshot,'stop');if(canonicalHash(verified)!==r.result_hash)throw changed();return verified;}
