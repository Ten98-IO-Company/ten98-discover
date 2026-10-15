import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {dispatchSpend,settleSpend} from './spending.ts';
import {suggestionConnection,suggestionCredentials} from './ai-suggestions.ts';
import {keyFingerprint,readContentSupportRoute,executionRequestBody,requestContentSupportExecution,reconcileOpenRouter,unknownExecution,type ExecutionOutcome} from './openrouter.ts';
import {contentSupportPurpose,parseContentSupportProposal} from './ai-content-support-input.ts';
import {contentSupportActionInputSchema} from '../lib/ai-content-support.ts';
import {contentSupportQueue,withSupportProject,supportAudit,supportRunRow,supportQuoteRow,verifySupportSource,readSupportPayload,markSupportUnavailable,cancelSupportReservation,getContentSupportRun,type SupportProject} from './ai-content-support.ts';

const changed=()=>new FoundationError(409,'The assessment or original provider identity changed.');
export function contentSupportDisposition(cost:string|null,valid:boolean,current:boolean){return cost===null?'uncertain' as const:valid&&current?'completed' as const:'failed' as const;}
async function withRun<T>(id:string,work:(c:PoolClient,p:SupportProject,r:any,q:any)=>Promise<T>){
 parse(z.uuid(),id);const ref=(await getDatabase().pool.query('SELECT project_id FROM ai_content_support_run WHERE id=$1',[id])).rows[0];if(!ref)throw new FoundationError(404,'Content assessment is unavailable.');
 return withSupportProject(ref.project_id,null,false,async(c,p)=>{
  const hint=(await c.query('SELECT q.audit_run_id FROM ai_content_support_run r JOIN ai_content_support_quote q ON q.id=r.quote_id WHERE r.id=$1 AND r.project_id=$2',[id,p.id])).rows[0];if(!hint)throw changed();
  await supportAudit(c,p,hint.audit_run_id);const r=await supportRunRow(c,p.id,id),q=await supportQuoteRow(c,p.id,r.quote_id);return work(c,p,r,q);
 },id);
}
async function actorProject(c:PoolClient,p:SupportProject,userId:string){return {...p,role:(await c.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[p.workspaceId,userId])).rows[0]?.role??null} as SupportProject;}
function ledgerMatches(r:any,q:any){return r.ledger_input_hash===q.input_hash&&r.ledger_connection_id===q.connection_id&&r.ledger_user_id===q.user_id&&r.ledger_connection_revision===q.connection_revision&&r.ledger_operation==='ai.content.semantic'&&String(r.estimate_micros)===String(q.estimate_micros)&&r.user_id===q.user_id;}
async function finish(id:string,owner:string,outcome:ExecutionOutcome,crashOnly=false){
 return withRun(id,async(c,p,r,q)=>{
  if(r.lease_owner!==owner||r.status!=='running'||!['dispatched','uncertain'].includes(r.charge_status)||crashOnly&&!r.lease_expired)return;
  if(r.generation_id&&outcome.reference&&r.generation_id!==outcome.reference)outcome=unknownExecution(r.generation_id,'Conflicting provider receipts require owner review.');
  // Settle incurred charges independently of later membership, source expiry or output validity.
  const reference=outcome.reference??r.generation_id,settled=await settleSpend(c,p.workspaceId,id,outcome.cost,reference);
  const actor=await actorProject(c,p,q.user_id),verified=await verifySupportSource(c,actor,q);let proposal=null,rawResult:string|null=null,diagnostic=outcome.diagnostic;
  let current=!('refusal'in verified)&&actor.role==='owner'&&ledgerMatches(r,q);
  if(current)try{const conn=await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision);current=keyFingerprint(suggestionCredentials(conn))===q.key_fingerprint;}catch(error){if(!(error instanceof FoundationError))throw error;current=false;}
  if(!current){await markSupportUnavailable(c,q.id,'authority_changed');diagnostic='The charge is retained; current source or execution authority is unavailable.';}
  if(current&&outcome.cost!==null&&!outcome.pause&&outcome.result){
   try{const payload=readSupportPayload(q);proposal=parseContentSupportProposal(outcome.result.text,payload.snapshot,outcome.result.finishReason);rawResult=outcome.result.text;}
   catch{diagnostic='The charge is recorded, but the complete output failed evidence validation. No usable conclusion is available.';}
  }
  if(!proposal&&outcome.cost!==null)diagnostic??='The charge is recorded, but no complete supported assessment is available.';
  const status=contentSupportDisposition(settled.reconciliationRequired?null:outcome.cost,proposal!==null,current);
  if(status!=='completed'){proposal=null;rawResult=null;}
  await c.query(`UPDATE ai_content_support_run SET status=$2,generation_id=$3,raw_result=$4,proposal=$5,financial_evidence=$6,diagnostic=$7,completed_at=COALESCE(completed_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL,result_purged_at=CASE WHEN $8 THEN COALESCE(result_purged_at,clock_timestamp())ELSE result_purged_at END WHERE id=$1`,[id,status,reference,rawResult,proposal?JSON.stringify(proposal):null,JSON.stringify(outcome.evidence),diagnostic?.slice(0,1000)??null,!current]);
  if(outcome.pause)await c.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[p.workspaceId]);
 });
}
export async function executeContentSupport(id:string,send:typeof fetch=fetch){
 const owner=randomUUID(),claimed=await withRun(id,async(c,p,r,q)=>{
  if(r.status==='queued'&&r.charge_status==='cancelled'){await cancelSupportReservation(c,r);return null;}
  if(r.status!=='queued'||r.charge_status!=='reserved'||r.lease_owner)return null;
  const actor=await actorProject(c,p,q.user_id),verified=await verifySupportSource(c,actor,q);
  if(actor.role!=='owner'||'refusal'in verified||verified.q.quote_expired||!ledgerMatches(r,q)){await cancelSupportReservation(c,r);return null;}
  await c.query("UPDATE ai_content_support_run SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1",[id,owner]);return {q:verified.q,payload:verified.payload};
 });if(!claimed)return;
 let secret:unknown,dispatchedAt:Date|undefined;
 try{
  const credentials=await withRun(id,async(c,p,r,q)=>{const actor=await actorProject(c,p,q.user_id);if(actor.role!=='owner'||r.lease_owner!==owner||r.lease_expired)throw changed();const verified=await verifySupportSource(c,actor,q);if('refusal'in verified||verified.q.quote_expired)throw changed();return suggestionCredentials(await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision));});
  if(keyFingerprint(credentials)!==claimed.q.key_fingerprint)throw changed();
  const fresh=await readContentSupportRoute(credentials,claimed.q.route.model,send,claimed.q.route.tag);if(canonicalHash(fresh)!==canonicalHash(claimed.q.route))throw changed();
  executionRequestBody(claimed.payload.messages,fresh,2048,id,claimed.q.request_actor,contentSupportPurpose);
  await dispatchSpend(claimed.q.workspace_id,claimed.q.user_id,id,async(c)=>{
   const p=(await c.query('SELECT id,workspace_id AS "workspaceId",origin FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[claimed.q.project_id,claimed.q.workspace_id])).rows[0];if(!p)throw changed();
   const actor=await actorProject(c,p,claimed.q.user_id);await supportAudit(c,actor,claimed.q.audit_run_id);const r=await supportRunRow(c,p.id,id),q=await supportQuoteRow(c,p.id,r.quote_id),verified=await verifySupportSource(c,actor,q);
   if(actor.role!=='owner'||'refusal'in verified||verified.q.quote_expired||r.status!=='queued'||r.charge_status!=='reserved'||r.lease_owner!==owner||r.lease_expired||!ledgerMatches(r,q)||q.input_hash!==claimed.q.input_hash)throw changed();
   secret=suggestionCredentials(await suggestionConnection(c,p.workspaceId,q.connection_id,q.connection_revision));if(keyFingerprint(secret)!==q.key_fingerprint)throw changed();
   const dispatched=(await c.query("UPDATE ai_content_support_run r SET status='running',dispatched_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '120 seconds' FROM ai_content_support_quote q WHERE r.id=$1 AND r.quote_id=q.id AND r.lease_owner=$2 AND r.lease_expires_at>clock_timestamp() AND q.expires_at>clock_timestamp() AND q.raw_expired_at IS NULL AND q.input_purged_at IS NULL RETURNING r.dispatched_at",[id,owner])).rows[0];if(!dispatched)throw changed();dispatchedAt=dispatched.dispatched_at;
  },'5s');
 }catch{
  // A failed dispatch transaction may have rolled back an observed expiry; re-latch
  // through the independent W-first gate before cancelling the unsent reservation.
  await withRun(id,async(c,p,r,q)=>{await verifySupportSource(c,await actorProject(c,p,q.user_id),q);if(r.lease_owner===owner)await cancelSupportReservation(c,r);});return;
 }
 const outcome=await requestContentSupportExecution(secret,claimed.payload.messages,claimed.q.route,id,claimed.q.request_actor,dispatchedAt!,async generation=>{
  await withRun(id,async(c,p,r)=>{if(r.lease_owner!==owner||r.status!=='running'||!['dispatched','uncertain'].includes(r.charge_status)||r.generation_id&&r.generation_id!==generation)throw changed();await c.query('UPDATE ai_content_support_run SET generation_id=$2 WHERE id=$1',[id,generation]);});
 },send);await finish(id,owner,outcome);
}
export async function reconcileContentSupport(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const input=parse(contentSupportActionInputSchema,raw),body={userId,id,input};
 const first=await withSupportProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.reconcile',body);if(receipt.replayed)return {replayed:true as const};const r=await supportRunRow(c,p.id,id),q=await supportQuoteRow(c,p.id,r.quote_id);if(r.charge_status!=='uncertain'||!r.generation_id||!r.dispatched_at||!ledgerMatches(r,q))throw changed();
  const conn=await suggestionConnection(c,p.workspaceId,q.connection_id),credentials=suggestionCredentials(conn);if(keyFingerprint(credentials)!==q.key_fingerprint)throw new FoundationError(409,'Recovery requires the original provider key.');return {replayed:false as const,r,q,revision:conn.revision,credentials};
 },id);if(first.replayed)return {...await getContentSupportRun(projectId,userId,id),replayed:true};
 // Metadata read only: reconcileOpenRouter never sends a completion or reconstructs text.
 const outcome=await reconcileOpenRouter(first.credentials,first.r.generation_id,first.q.route,first.r.dispatched_at,id,first.q.request_actor,send);
 await withSupportProject(projectId,userId,true,async(c,p)=>{
  const receipt=await contentReceipt(c,p.id,input.requestId,'ai.content.reconcile',body);if(receipt.replayed)return;
  const conn=await suggestionConnection(c,p.workspaceId,first.q.connection_id,first.revision);if(keyFingerprint(suggestionCredentials(conn))!==first.q.key_fingerprint)throw changed();
  const r=await supportRunRow(c,p.id,id),q=await supportQuoteRow(c,p.id,r.quote_id);if(r.charge_status!=='uncertain'||r.generation_id!==first.r.generation_id||outcome.reference!==r.generation_id||q.input_hash!==first.q.input_hash||!ledgerMatches(r,q))throw changed();
  const settled=await settleSpend(c,p.workspaceId,id,outcome.cost,outcome.reference);await c.query("UPDATE ai_content_support_run SET status=$2,financial_evidence=$3,diagnostic='Charge recovery does not recreate content evidence. Spending remains paused for owner review.',completed_at=COALESCE(completed_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[id,settled.reconciliationRequired?'uncertain':'failed',JSON.stringify(outcome.evidence)]);
  await c.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[p.workspaceId]);await receipt.save({id});
 },id);return {...await getContentSupportRun(projectId,userId,id),replayed:false};
}
/** Queue/lease repair is local only. It never calls a provider or retries dispatch. */
export async function reconcileContentSupportJobs(){
 const rows=(await getDatabase().pool.query(`SELECT r.id FROM ai_content_support_run r JOIN ai_content_support_quote q ON q.id=r.quote_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1 WHERE r.status IN('queued','running')AND(r.lease_expires_at<=clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed')OR q.expires_at<=clock_timestamp()OR EXISTS(SELECT 1 FROM provider_request p WHERE p.id=r.id AND p.status='cancelled'))ORDER BY r.created_at,r.id LIMIT 50`,[contentSupportQueue])).rows;
 for(const {id}of rows)await withRun(id,async(c,p,r,q)=>{
  if(r.status==='queued'){
   const stale=(await c.query(`SELECT 1 FROM ai_content_support_run r JOIN ai_content_support_quote q ON q.id=r.quote_id LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$2 WHERE r.id=$1 AND(r.lease_expires_at<=clock_timestamp()OR j.id IS NULL OR j.state IN('failed','cancelled','completed')OR q.expires_at<=clock_timestamp())`,[id,contentSupportQueue])).rowCount;
   if(stale||r.charge_status==='cancelled')await cancelSupportReservation(c,r);
  }else if(r.status==='running'&&r.lease_expired&&['dispatched','uncertain'].includes(r.charge_status)){
   await settleSpend(c,p.workspaceId,id,null,r.generation_id);await c.query("UPDATE ai_content_support_run SET status='uncertain',completed_at=COALESCE(completed_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL,diagnostic='Worker stopped after dispatch. Reconcile the original generation; no paid request is retried.' WHERE id=$1",[id]);
  }
 });
}
