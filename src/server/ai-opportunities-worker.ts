import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,parse} from './context-input.ts';
import {dispatchRequest,settleRequest} from './provider-requests.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {executionActor,keyFingerprint,generationId,readOpportunitiesRoute,executionRequestBody,requestOpportunitiesExecution,unknownExecution,type ExecutionOutcome} from './openrouter.ts';
import {opportunitiesContract,opportunitiesLimits} from '../lib/ai-opportunities.ts';
import {withOpportunitiesProject,opportunitiesQueue,type OpportunitiesProject} from './ai-opportunities.ts';
import {opportunityPreparationRow,opportunityRunSelect,verifyOpportunitySource,availableOpportunityPreparations,markOpportunityUnavailable,type OpportunityPreparationRow,type OpportunityRunRow} from './ai-opportunities-rows.ts';
import {selectOpportunitiesSource} from './ai-opportunities-source.ts';
import {assertOpportunitiesSourceCurrent,parseOpportunitiesProposal} from './ai-opportunities-input.ts';

type Run=OpportunityRunRow&{lease_owner:string|null;lease_expired:boolean;request_status:string;request_input_hash:string;request_connection_id:string;request_connection_revision:number;request_user_id:string;request_key:string;request_operation:string};
const changed=()=>new FoundationError(409,'The opportunity request or its original authority changed.');
async function row(c:PoolClient,pid:string,id:string){const r=(await c.query<Run>(opportunityRunSelect.replace('SELECT r.*,','SELECT r.*,r.lease_expires_at<=clock_timestamp() AS lease_expired,pr.status AS request_status,pr.input_hash AS request_input_hash,pr.connection_id AS request_connection_id,pr.connection_revision AS request_connection_revision,pr.user_id AS request_user_id,pr.request_key,pr.operation AS request_operation,')+' JOIN provider_request pr ON pr.id=r.id AND pr.workspace_id=r.workspace_id WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r',[pid,id])).rows[0];if(!r)throw new FoundationError(404,'Opportunity run not found.');return r;}
async function withRun<T>(id:string,work:(c:PoolClient,p:OpportunitiesProject,r:Run,q:OpportunityPreparationRow)=>Promise<T>){parse(z.uuid(),id);const ref=(await getDatabase().pool.query<{project_id:string}>('SELECT project_id FROM ai_opportunity_run WHERE id=$1',[id])).rows[0];if(!ref)throw new FoundationError(404,'Opportunity run not found.');return withOpportunitiesProject(ref.project_id,null,false,async(c,p)=>{const r=await row(c,p.id,id);return work(c,p,r,await opportunityPreparationRow(c,p.id,r.preparation_id));},id);}
async function actor(c:PoolClient,p:OpportunitiesProject,userId:string){return {...p,role:(await c.query<{role:NonNullable<OpportunitiesProject['role']>}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[p.workspaceId,userId])).rows[0]?.role??null};}
function matches(r:Run,q:OpportunityPreparationRow){return r.request_input_hash===q.input_hash&&r.request_connection_id===q.connection_id&&r.request_connection_revision===q.connection_revision&&r.request_user_id===q.user_id&&r.request_operation==='ai.opportunities.semantic'&&r.request_key===r.request_id&&r.user_id===q.user_id&&r.workspace_id===q.workspace_id&&r.project_id===q.project_id&&q.request_actor===executionActor(q.user_id);}
async function cancel(c:PoolClient,r:Run){if(r.status!=='queued'||r.dispatched!==null||!['reserved','cancelled'].includes(r.request_status))return;await c.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[r.id]);await c.query("UPDATE ai_opportunity_run SET status='cancelled',completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,diagnostic='Stopped before dispatch. No provider request was sent.' WHERE id=$1",[r.id]);}
/** Owner admission precedes every broad population read, including first publication. */
async function current(c:PoolClient,p:OpportunitiesProject,r:Run,q:OpportunityPreparationRow,preparationExpiry:boolean){
 const authorized=await actor(c,p,q.user_id);if(authorized.role!=='owner'||!matches(r,q))return null;
 try{const payload=await verifyOpportunitySource(c,q);if(!payload)return null;const connection=await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision),credentials=suggestionCredentials(connection);if(keyFingerprint(credentials)!==q.key_fingerprint)return null;
  const source=await selectOpportunitiesSource(c,{...authorized,role:authorized.role},payload.input.expectedSource.scope,()=>{});assertOpportunitiesSourceCurrent(payload.snapshot,source.snapshot.source);if(source.evidenceHash!==q.evidence_hash||canonicalHash(source.dependencies)!==canonicalHash(payload.dependencies))return null;
  if(!(await availableOpportunityPreparations(c,p.id,[q.id])).has(q.id)||preparationExpiry&&(await opportunityPreparationRow(c,p.id,q.id)).expired)return null;
  return {payload,credentials};
 }catch(error){if(error instanceof FoundationError&&[400,403,404,409,410,413].includes(error.status))return null;throw error;}
}
const token=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2000000?value:null;
async function finish(id:string,lease:string,outcome:ExecutionOutcome){return withRun(id,async(c,p,r,q)=>{
 if(r.status!=='running'||r.lease_owner!==lease||!['dispatched','uncertain'].includes(r.request_status))return;
 if(outcome.reference&&!generationId(outcome.reference)||r.generation_id&&outcome.reference&&r.generation_id!==outcome.reference)outcome=unknownExecution(r.generation_id);
 const reference=outcome.reference??r.generation_id;await settleRequest(c,p.workspaceId,id,{known:outcome.known,providerReference:reference});
 let admitted:Awaited<ReturnType<typeof current>>=null;try{admitted=await current(c,p,r,q,false);}catch(error){if(!(error instanceof FoundationError))throw error;}
 let proposal=null,raw:string|null=null;if(admitted&&outcome.known&&outcome.result){try{proposal=parseOpportunitiesProposal(outcome.result.text,admitted.payload.snapshot,outcome.result.finishReason);raw=outcome.result.text;}catch(error){if(!(error instanceof FoundationError))throw error;}}
 // Parsing/hashing may cross retention. Latch with a new database clock immediately before publication.
 let resultHash=proposal?canonicalHash(proposal):null;
 const available=(await availableOpportunityPreparations(c,p.id,[q.id])).has(q.id);if(!available){proposal=null;raw=null;admitted=null;resultHash=null;}
 if(!admitted){const role=(await actor(c,p,q.user_id)).role;await markOpportunityUnavailable(c,q,role==='owner'?'source_changed':'authority_changed');proposal=null;raw=null;resultHash=null;}
 const status=!outcome.known?'uncertain':proposal?'completed':'failed',promptTokens=token(outcome.result?.promptTokens??outcome.evidence.promptTokens),completionTokens=token(outcome.result?.completionTokens??outcome.evidence.completionTokens);
 const evidence={source:outcome.evidence.source==='refusal'?'refusal':'response',generationId:reference,promptTokens,completionTokens,...(typeof outcome.evidence.httpStatus==='number'?{httpStatus:outcome.evidence.httpStatus}:{})};
 await c.query(`UPDATE ai_opportunity_run SET status=$2,generation_id=$3,raw_result=$4,proposal=$5,result_hash=$6,prompt_tokens=$7,completion_tokens=$8,request_evidence=$9,diagnostic=$10,completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,result_purged_at=CASE WHEN $11 THEN COALESCE(result_purged_at,clock_timestamp()) ELSE result_purged_at END WHERE id=$1`,[id,status,reference,raw,proposal?JSON.stringify(proposal):null,resultHash,promptTokens,completionTokens,JSON.stringify(evidence),status==='completed'?null:status==='uncertain'?'The original request outcome is unknown. Recovery never resends inference.':'The provider outcome is retained, but no current validated conclusion is available.',!admitted]);
 });}
export async function executeOpportunities(id:string,send:typeof fetch=fetch){
 const lease=randomUUID(),claimed=await withRun(id,async(c,p,r,q)=>{if(r.status==='queued'&&r.request_status==='cancelled'){await cancel(c,r);return null;}if(r.status!=='queued'||r.request_status!=='reserved'||r.lease_owner)return null;const admitted=await current(c,p,r,q,true);if(!admitted){await cancel(c,r);return null;}await c.query("UPDATE ai_opportunity_run SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1",[id,lease]);return {q,...admitted};});if(!claimed)return;
 let credentials:unknown,dispatchedAt:Date|undefined;
 try{
  const fresh=await readOpportunitiesRoute(claimed.credentials,claimed.q.route.model,send,claimed.q.route.tag);if(canonicalHash(fresh)!==canonicalHash(claimed.q.route))throw changed();executionRequestBody(claimed.payload.messages,fresh,opportunitiesLimits.outputTokens,id,claimed.q.request_actor,opportunitiesContract.purpose);
  await dispatchRequest(claimed.q.workspace_id,claimed.q.user_id,id,async c=>{
   const p=(await c.query<OpportunitiesProject>('SELECT id,name,origin,workspace_id AS "workspaceId" FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[claimed.q.project_id,claimed.q.workspace_id])).rows[0];if(!p)throw changed();const r=await row(c,p.id,id),q=await opportunityPreparationRow(c,p.id,r.preparation_id);if(r.status!=='queued'||r.request_status!=='reserved'||r.lease_owner!==lease||r.lease_expired||q.input_hash!==claimed.q.input_hash)throw changed();const admitted=await current(c,p,r,q,true);if(!admitted)throw changed();credentials=admitted.credentials;
   const changedRow=(await c.query<{dispatched_at:Date}>(`UPDATE ai_opportunity_run r SET status='running',dispatched_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '120 seconds' FROM ai_opportunity_preparation q WHERE r.id=$1 AND r.preparation_id=q.id AND r.lease_owner=$2 AND r.lease_expires_at>clock_timestamp() AND q.expires_at>clock_timestamp() AND q.raw_expired_at IS NULL AND q.input_purged_at IS NULL RETURNING r.dispatched_at`,[id,lease])).rows[0];if(!changedRow)throw changed();dispatchedAt=changedRow.dispatched_at;
  },'5s');
 }catch(error){if(!(error instanceof FoundationError))throw error;await withRun(id,async(c,p,r,q)=>{await availableOpportunityPreparations(c,p.id,[q.id]);if(r.lease_owner!==lease||r.status!=='queued')return;if([400,403,404,409,410,413].includes(error.status))await cancel(c,r);else await c.query('UPDATE ai_opportunity_run SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[id]);});if(![400,403,404,409,410,413].includes(error.status))throw error;return;}
 let receiptFailure:unknown;
 const outcome=await requestOpportunitiesExecution(credentials,claimed.payload.messages,claimed.q.route,id,claimed.q.request_actor,dispatchedAt!,async generation=>{try{if(!generationId(generation)||generation.trim()!==generation)throw changed();await withRun(id,async(c,_p,r)=>{if(r.status!=='running'||r.lease_owner!==lease||!['dispatched','uncertain'].includes(r.request_status)||r.generation_id&&r.generation_id!==generation)throw changed();await c.query('UPDATE ai_opportunity_run SET generation_id=$2 WHERE id=$1',[id,generation]);});}catch(error){receiptFailure=error;throw error;}},send);
 await finish(id,lease,outcome);
 if(receiptFailure&&!(receiptFailure instanceof FoundationError))throw receiptFailure;
}
/** Local crash repair preserves the original request. It never dispatches or resends inference. */
export async function reconcileOpportunitiesJobs(){
 const candidates=(await getDatabase().pool.query<{id:string}>(`SELECT r.id FROM ai_opportunity_run r JOIN ai_opportunity_preparation q ON q.id=r.preparation_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1 WHERE r.status IN('queued','running') AND(r.lease_expires_at<=clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed') OR q.expires_at<=clock_timestamp() OR q.raw_expired_at IS NOT NULL OR EXISTS(SELECT 1 FROM provider_request pr WHERE pr.id=r.id AND pr.status='cancelled')) ORDER BY r.created_at,r.id LIMIT 50`,[opportunitiesQueue])).rows;
 for(const {id}of candidates){try{await withRun(id,async(c,p,r,q)=>{
  if(r.status==='queued'){
   const stale=(await c.query(`SELECT 1 FROM ai_opportunity_run r JOIN ai_opportunity_preparation q ON q.id=r.preparation_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$2 WHERE r.id=$1 AND(r.lease_expires_at<=clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed') OR q.expires_at<=clock_timestamp() OR q.raw_expired_at IS NOT NULL)`,[id,opportunitiesQueue])).rowCount;
   if(stale||r.request_status==='cancelled'){await availableOpportunityPreparations(c,p.id,[q.id]);await cancel(c,r);}
  }else if(r.status==='running'&&r.lease_expired&&['dispatched','uncertain'].includes(r.request_status)){
   await settleRequest(c,p.workspaceId,id,{known:false,providerReference:r.generation_id});await c.query("UPDATE ai_opportunity_run SET status='uncertain',completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,diagnostic='Worker stopped after dispatch. Recover the original request; inference is never retried.' WHERE id=$1",[id]);
  }
 });}catch(error){if(!(error instanceof FoundationError&&error.status===404))throw error;}}
}
