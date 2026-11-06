import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {withSupportProject,type SupportProject} from './ai-content-support.ts';
import {contentReceipt} from './project-context.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {generationId,keyFingerprint,reconcileOpenRouter} from './openrouter.ts';
import {settleRequest} from './provider-requests.ts';
import {opportunitiesActionInputSchema} from '../lib/ai-opportunities.ts';
import {opportunityPreparationRow,opportunityRunSelect,type OpportunityPreparationRow,type OpportunityRunRow} from './ai-opportunities-rows.ts';

const receiptSchema=z.object({runId:z.uuid(),replayed:z.boolean()}).strict();
const changed=()=>new FoundationError(409,'The original opportunity request or recovery authority changed.');
type Run=OpportunityRunRow&{request_status:string;request_input_hash:string;request_connection_id:string;request_connection_revision:number;request_user_id:string;request_key:string;request_operation:string;provider_reference:string|null};

/** Recovery permits a newly checked revision only when it still holds the original key. */
export async function opportunityRecoveryCredentials(c:PoolClient,p:SupportProject,q:OpportunityPreparationRow,revision?:number){
 if(p.role!=='owner')throw new FoundationError(403,'Only an owner can recover this request.');
 const connection=await suggestionConnection(c,p.workspaceId,q.connection_id,revision),credentials=suggestionCredentials(connection);
 if(keyFingerprint(credentials)!==q.key_fingerprint)throw new FoundationError(409,'Recovery requires the original provider key.');
 return {credentials,revision:connection.revision as number};
}
async function recoveryState(c:PoolClient,p:SupportProject,id:string){
 const r=(await c.query<Run>(opportunityRunSelect.replace('SELECT r.*,','SELECT r.*,pr.status AS request_status,pr.input_hash AS request_input_hash,pr.connection_id AS request_connection_id,pr.connection_revision AS request_connection_revision,pr.user_id AS request_user_id,pr.request_key,pr.operation AS request_operation,pr.provider_reference,')+' JOIN provider_request pr ON pr.id=r.id AND pr.workspace_id=r.workspace_id WHERE r.id=$1 AND r.project_id=$2 AND r.workspace_id=$3 FOR UPDATE OF r',[id,p.id,p.workspaceId])).rows[0];
 if(!r)throw new FoundationError(404,'Opportunity run not found.');
 const q=await opportunityPreparationRow(c,p.id,r.preparation_id);
 if(r.status!=='uncertain'||r.request_status!=='uncertain'||!r.generation_id||!generationId(r.generation_id)||r.generation_id.trim()!==r.generation_id||!r.dispatched||!Number.isFinite(Date.parse(r.dispatched))||r.provider_reference!==r.generation_id||r.request_input_hash!==q.input_hash||r.request_connection_id!==q.connection_id||r.request_connection_revision!==q.connection_revision||r.request_user_id!==q.user_id||r.request_operation!=='ai.opportunities.semantic'||r.request_key!==r.request_id||r.user_id!==q.user_id||r.workspace_id!==q.workspace_id||r.project_id!==q.project_id||!q.request_actor)throw changed();
 // Only retained request identity is required: payload/source expiry cannot prevent settlement.
 const identity=canonicalHash({id:r.id,preparationId:q.id,userId:q.user_id,requestId:r.request_id,inputHash:q.input_hash,connectionId:q.connection_id,connectionRevision:q.connection_revision,key:q.key_fingerprint,actor:q.request_actor,route:q.route,generation:r.generation_id,dispatched:r.dispatched});
 return {r,q,identity};
}
const token=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2000000?value:null;
export async function recoverOpportunities(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const input=parse(opportunitiesActionInputSchema,raw),body={userId,id,input};
 const first=await withSupportProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.recover',body);
  if(receipt.replayed)return {prior:receiptSchema.parse({runId:receipt.result.runId,replayed:true})};
  const state=await recoveryState(c,p,id);return {...state,...await opportunityRecoveryCredentials(c,p,state.q)};
 },id);if('prior'in first){if(!first.prior)throw changed();return first.prior;}
 // GET metadata for the saved generation; recovery never requests inference or report text.
 const outcome=await reconcileOpenRouter(first.credentials,first.r.generation_id!,first.q.route,new Date(first.r.dispatched!),id,first.q.request_actor,send);
 return withSupportProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.recover',body);
  if(receipt.replayed)return receiptSchema.parse({runId:receipt.result.runId,replayed:true});
  const current=await recoveryState(c,p,id);
  if(current.identity!==first.identity||outcome.reference!==current.r.generation_id)throw changed();
  await opportunityRecoveryCredentials(c,p,current.q,first.revision);
  const settled=await settleRequest(c,p.workspaceId,id,{known:outcome.known,providerReference:outcome.reference}),promptTokens=token(outcome.evidence.promptTokens),completionTokens=token(outcome.evidence.completionTokens);
  await c.query("UPDATE ai_opportunity_run SET status=$2,prompt_tokens=$3,completion_tokens=$4,request_evidence=$5,diagnostic='Request recovery does not recreate opportunity evidence.',completed_at=COALESCE(completed_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[id,settled.recoveryRequired?'uncertain':'failed',promptTokens,completionTokens,JSON.stringify({source:'generation',generationId:outcome.reference,promptTokens,completionTokens})]);
  await receipt.save({runId:id});return receiptSchema.parse({runId:id,replayed:false});
 },id);
}
