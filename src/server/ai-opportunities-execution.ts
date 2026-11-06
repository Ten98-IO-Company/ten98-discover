import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {opportunitiesStartInputSchema,opportunitiesActionInputSchema} from '../lib/ai-opportunities.ts';
import {withOpportunitiesProject,opportunitiesQueue} from './ai-opportunities.ts';
import {opportunityPreparationRow,verifyOpportunitySource,availableOpportunityPreparations} from './ai-opportunities-rows.ts';
import {selectOpportunitiesSource} from './ai-opportunities-source.ts';
import {assertOpportunitiesSourceCurrent} from './ai-opportunities-input.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {executionActor,keyFingerprint} from './openrouter.ts';
import {reserveRequestInTransaction} from './provider-requests.ts';
import {getBoss} from './jobs.ts';

const receiptSchema=z.object({runId:z.uuid(),replayed:z.boolean()}).strict();
type Receipt=z.infer<typeof receiptSchema>;
type Refusal={refusal:{status:number;message:string}};
const refuse=(status=409,message='This opportunity preparation is no longer current. Prepare a new request.'):Refusal=>({refusal:{status,message}});
const result=(value:Receipt|Refusal)=>{if('refusal'in value)throw new FoundationError(value.refusal.status,value.refusal.message);return receiptSchema.parse(value);};

export async function startOpportunities(projectId:string,userId:string,raw:unknown):Promise<Receipt>{
 const input=parse(opportunitiesStartInputSchema,raw),body={userId,input};
 const prior=await withOpportunitiesProject(projectId,userId,true,async(c,p)=>{const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.start',body);return receipt.replayed?receiptSchema.parse({runId:receipt.result.runId,replayed:true}):null;});if(prior)return prior;
 const boss=await getBoss();
 return result(await withOpportunitiesProject(projectId,userId,true,async(c,p):Promise<Receipt|Refusal>=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.start',body);if(receipt.replayed)return {runId:receipt.result.runId,replayed:true};
  let q=await opportunityPreparationRow(c,p.id,input.preparationId);if(q.user_id!==userId)throw new FoundationError(404,'Opportunity preparation not found.');
  const payload=await verifyOpportunitySource(c,q);if(!payload)return refuse(410,'The original opportunity evidence is unavailable.');
  const connection=await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision);
  if(q.request_actor!==executionActor(userId)||keyFingerprint(suggestionCredentials(connection))!==q.key_fingerprint)return refuse();
  try{const current=await selectOpportunitiesSource(c,{...p,role:p.role!},payload.input.expectedSource.scope,()=>{});assertOpportunitiesSourceCurrent(payload.snapshot,current.snapshot.source);if(current.evidenceHash!==q.evidence_hash||canonicalHash(current.dependencies)!==canonicalHash(payload.dependencies))return refuse();}
  catch(error){if(!(error instanceof FoundationError))throw error;await availableOpportunityPreparations(c,p.id,[q.id]);return refuse(error.status,error.message);}
  if(!(await availableOpportunityPreparations(c,p.id,[q.id])).has(q.id))return refuse(410,'The original opportunity evidence expired.');
  q=await opportunityPreparationRow(c,p.id,q.id);if(q.expired)return refuse();
  if((await c.query("SELECT 1 FROM ai_opportunity_run WHERE project_id=$1 AND(preparation_id=$2 OR status IN('queued','running'))",[p.id,q.id])).rowCount)return refuse(409,'An opportunity run already uses this preparation or is active in this project.');
  if((await c.query(`SELECT 1 FROM ai_opportunity_run r JOIN ai_opportunity_preparation previous ON previous.id=r.preparation_id AND previous.project_id=r.project_id JOIN provider_request pr ON pr.id=r.id AND pr.workspace_id=r.workspace_id WHERE r.project_id=$1 AND previous.business_input_hash=$2 AND(r.status='uncertain' OR pr.status='uncertain') LIMIT 1`,[p.id,q.business_input_hash])).rowCount)return refuse(409,'An equivalent opportunity request has an unknown outcome. Recover that original request.');
  // Admission queries may consume the remaining lifetime; reserve only after a fresh clock check.
  if(!(await availableOpportunityPreparations(c,p.id,[q.id])).has(q.id))return refuse(410,'The original opportunity evidence expired.');
  if((await opportunityPreparationRow(c,p.id,q.id)).expired)return refuse();
  const reservation=await reserveRequestInTransaction(c,p.workspaceId,userId,{connectionId:q.connection_id,requestKey:input.requestId,operation:'ai.opportunities.semantic',inputHash:q.input_hash},async(tx,id)=>{
   await tx.query("INSERT INTO ai_opportunity_run(id,preparation_id,workspace_id,project_id,user_id,request_id,status)VALUES($1,$2,$3,$4,$5,$6,'queued')",[id,q.id,p.workspaceId,p.id,userId,input.requestId]);
   if(await boss.send(opportunitiesQueue,{runId:id},{id,retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>tx.query(text,values)}})!==id)throw new FoundationError(503,'The opportunity run could not be queued. Retry the same request ID.');
  });
  if(!reservation.created)throw new FoundationError(409,'This provider request identity is already in use. Recover the original request.');
  await receipt.save({runId:reservation.id});return {runId:reservation.id,replayed:false};
 }));
}

export async function cancelOpportunities(projectId:string,userId:string,id:string,raw:unknown):Promise<Receipt>{
 parse(z.uuid(),id);const input=parse(opportunitiesActionInputSchema,raw);
 return withOpportunitiesProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.opportunities.cancel',{userId,id,input});
  const row=(await c.query<{status:string;dispatched_at:Date|null;request_status:string}>(`SELECT r.status,r.dispatched_at,pr.status AS request_status FROM ai_opportunity_run r JOIN provider_request pr ON pr.id=r.id AND pr.workspace_id=r.workspace_id WHERE r.id=$1 AND r.project_id=$2 AND r.workspace_id=$3 FOR UPDATE OF r`,[id,p.id,p.workspaceId])).rows[0];if(!row)throw new FoundationError(404,'Opportunity run not found.');
  if(receipt.replayed)return receiptSchema.parse({runId:receipt.result.runId,replayed:true});
  if(row.status!=='queued'||row.dispatched_at!==null||row.request_status!=='reserved')throw new FoundationError(409,'Only a queued, undispatched opportunity request can be cancelled.');
  await c.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND status='reserved'",[id,p.workspaceId]);
  await c.query("UPDATE ai_opportunity_run SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),diagnostic='Stopped before dispatch. No provider request was sent.' WHERE id=$1 AND project_id=$2",[id,p.id]);
  await receipt.save({runId:id});return receiptSchema.parse({runId:id,replayed:false});
 },id);
}
