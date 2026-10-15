import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {parse,canonicalHash} from './context-input.ts';
import {contentReceipt,withContentProject} from './project-context.ts';
import {dispatchSpend,settleSpend} from './spending.ts';
import {keyFingerprint,readSuggestionRoute,executionRequestBody,requestSuggestionExecution,reconcileOpenRouter,unknownExecution,type ExecutionOutcome} from './openrouter.ts';
import {parseSuggestionProposal,suggestionActionInput,suggestionQuoteInput,suggestionModel,type SuggestionSnapshot} from './ai-suggestion-input.ts';
import {suggestionQueue,suggestionSelect,suggestionConnection,suggestionCredentials,assertSuggestionSnapshot,withSuggestionRun,getAiSuggestion} from './ai-suggestions.ts';

async function cancelReserved(client:PoolClient,row:any,message:string){
 if(row.status!=='queued'||!['reserved','cancelled'].includes(row.charge_status))return;
 await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[row.id]);
 await client.query("UPDATE ai_suggestion_run SET status='cancelled',diagnostic=$2,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1",[row.id,message]);
}
async function finish(id:string,owner:string,outcome:ExecutionOutcome,crashOnly=false){return withSuggestionRun(id,async(client,row)=>{
 if(row.lease_owner!==owner||!['dispatched','uncertain'].includes(row.charge_status)||crashOnly&&(row.status!=='running'||row.lease_expires_at.getTime()>Date.now()))return;
 if(row.generation_id&&outcome.reference&&row.generation_id!==outcome.reference)outcome=unknownExecution(row.generation_id,'Conflicting provider receipts require owner review.');
 const reference=outcome.reference??row.generation_id,settled=await settleSpend(client,row.workspace_id,id,outcome.cost,reference);
 let proposal=null,diagnostic=outcome.diagnostic,raw:string|null=null;
 if(!row.result_expired&&!row.input_expired&&outcome.result){
  raw=outcome.result.text;
  if(outcome.result.finishReason==='stop')try{const value=parseSuggestionProposal(raw,row.snapshot as SuggestionSnapshot);proposal={...value,prompts:value.prompts.map(p=>({id:randomUUID(),...p}))};}
  catch{diagnostic??='The charge was recorded, but the proposal did not pass validation. No prompts were saved.';}
  else diagnostic??='The charge was recorded, but the provider did not return a complete suggestion proposal.';
 }
 await client.query(`UPDATE ai_suggestion_run SET status=$2,diagnostic=$3,raw_result=$4,proposal=$5,evidence=$6,generation_id=$7,
 completed_at=COALESCE(completed_at,clock_timestamp()),result_purged_at=CASE WHEN $8 THEN COALESCE(result_purged_at,clock_timestamp()) ELSE result_purged_at END WHERE id=$1`,
 [id,settled.reconciliationRequired?'uncertain':proposal?'completed':'failed',diagnostic,raw,proposal===null?null:JSON.stringify(proposal),JSON.stringify(outcome.evidence),reference,!!row.result_expired||row.input_expired]);
 if(outcome.pause)await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[row.workspace_id]);
 });}

export async function executeAiSuggestion(id:string,send:typeof fetch=fetch){
 parse(z.uuid(),id);const owner=randomUUID();
 const captured=await withSuggestionRun(id,async(client,row)=>{
  if(row.status==='queued'&&row.charge_status==='cancelled'){await cancelReserved(client,row,'The reserved request was cancelled before dispatch.');return null;}
  if(row.status!=='queued'||row.charge_status!=='reserved'||row.lease_owner)return null;
  await client.query("UPDATE ai_suggestion_run SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1",[id,owner]);return row;
 });if(!captured)return;
 let secret:unknown,dispatchedAt:Date|undefined;
 try{
  if(captured.quote_expired)throw new FoundationError(409,'The suggestion quote expired. Prepare another quote.');
  if(captured.input_expired)throw new FoundationError(409,'The captured input expired.');
  const input=parse(suggestionQuoteInput,captured.input);
  const credentials=await withContentProject(captured.project_id,captured.user_id,true,async(client,p)=>{
   if(p.role!=='owner')throw new FoundationError(403,'The evaluation owner is unavailable.');
   return suggestionCredentials(await suggestionConnection(client,captured.workspace_id,captured.connection_id,captured.connection_revision));
  });
  if(keyFingerprint(credentials)!==captured.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
  executionRequestBody(captured.messages,captured.route,2048,id,captured.request_actor,true);
  const fresh=await readSuggestionRoute(credentials,suggestionModel(input),send,captured.route.profile,captured.route.profile?captured.route.tag:undefined);
  if(canonicalHash(fresh)!==canonicalHash(captured.route))throw new FoundationError(409,'Endpoint price or capacity changed.');
  await dispatchSpend(captured.workspace_id,captured.user_id,id,async(client)=>{
   await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[captured.project_id]);
   const row=(await client.query(suggestionSelect+' WHERE r.id=$1',[id])).rows[0];
   const member=(await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[row.workspace_id,row.user_id])).rows[0];
   if(member?.role!=='owner'||row.status!=='queued'||row.lease_owner!==owner||row.lease_expires_at.getTime()<=Date.now()||row.input_expired)throw new FoundationError(409,'Suggestion authority changed before dispatch.');
   await assertSuggestionSnapshot(client,row.project_id,input,row.snapshot_hash);
   secret=suggestionCredentials(await suggestionConnection(client,row.workspace_id,row.connection_id,row.connection_revision));if(keyFingerprint(secret)!==row.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
   const dispatched=(await client.query(`UPDATE ai_suggestion_run SET status='running',dispatched_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1
    AND EXISTS(SELECT 1 FROM ai_suggestion_quote q WHERE q.id=ai_suggestion_run.quote_id AND q.expires_at>clock_timestamp()) RETURNING dispatched_at`,[id])).rows[0];
   if(!dispatched)throw new FoundationError(409,'The suggestion quote expired. Prepare another quote.');
   dispatchedAt=dispatched.dispatched_at;
  });
 }catch{await withSuggestionRun(id,async(client,row)=>{if(row.lease_owner===owner)await cancelReserved(client,row,'Not sent: quote expiry, permissions, context, credentials, endpoint or spending limits changed. Prepare a new quote.');});return;}
 const outcome=await requestSuggestionExecution(secret,captured.messages,captured.route,id,captured.request_actor,dispatchedAt!,async generation=>{
  await withSuggestionRun(id,async(client,row)=>{
   if(row.lease_owner!==owner||!['dispatched','uncertain'].includes(row.charge_status)||row.generation_id&&row.generation_id!==generation)throw new Error('Suggestion receipt changed.');
   await client.query('UPDATE ai_suggestion_run SET generation_id=$2 WHERE id=$1',[id,generation]);
  });
 },send);
 await finish(id,owner,outcome);
}

export async function reconcileAiSuggestion(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const input=parse(suggestionActionInput,raw),receiptBody={userId,id,input};
 const saved=await withContentProject(projectId,userId,true,async(client,p)=>{
  if(p.role!=='owner')throw new FoundationError(403,'Only an owner can reconcile a suggestion charge.');
  const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.reconcile',receiptBody);if(receipt.replayed)return {replayed:true as const};
  const row=(await client.query(suggestionSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,p.id])).rows[0];if(!row)throw new FoundationError(404,'Suggestion not found or unavailable.');
  if(row.charge_status!=='uncertain'||!row.generation_id||!row.dispatched_at)throw new FoundationError(409,'No reconcilable generation receipt is available.');
  const conn=await suggestionConnection(client,row.workspace_id,row.connection_id),credentials=suggestionCredentials(conn);
  if(keyFingerprint(credentials)!==row.key_fingerprint)throw new FoundationError(409,'Recovery requires the original key identity.');
  return {replayed:false as const,row,credentials,revision:conn.revision};
 });
 if(!saved.replayed){
  const outcome=await reconcileOpenRouter(saved.credentials,saved.row.generation_id,saved.row.route,saved.row.dispatched_at,id,saved.row.request_actor,send);
  await withContentProject(projectId,userId,true,async(client,p)=>{
   if(p.role!=='owner')throw new FoundationError(403,'Owner access changed.');
   const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.reconcile',receiptBody);if(receipt.replayed)return;
   const conn=await suggestionConnection(client,saved.row.workspace_id,saved.row.connection_id,saved.revision);if(keyFingerprint(suggestionCredentials(conn))!==saved.row.key_fingerprint)throw new FoundationError(409,'The key changed during recovery.');
   const row=(await client.query(suggestionSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,p.id])).rows[0];
   if(row.charge_status!=='uncertain'||row.generation_id!==outcome.reference)throw new FoundationError(409,'The receipt changed. Reload this suggestion.');
   const settled=await settleSpend(client,row.workspace_id,id,outcome.cost,outcome.reference);
   await client.query('UPDATE ai_suggestion_run SET status=$2,evidence=$3,diagnostic=$4,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',
    [id,settled.reconciliationRequired?'uncertain':row.proposal?'completed':'failed',JSON.stringify(outcome.evidence),'Charge recovery does not recover an unavailable proposal. Spending remains paused for owner review.']);
   await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[row.workspace_id]);await receipt.save({id});
  });
 }
 return {...await getAiSuggestion(projectId,userId,id),acknowledgement:{requestId:input.requestId,runId:id,operation:'reconcile' as const},replayed:saved.replayed};
}
export async function reconcileAiSuggestionJobs(){
 const rows=(await getDatabase().pool.query(`SELECT r.id FROM ai_suggestion_run r LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1
 WHERE r.status IN('queued','running') AND (r.lease_expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed')
 OR EXISTS(SELECT 1 FROM provider_request p WHERE p.id=r.id AND p.status='cancelled')) ORDER BY r.created_at LIMIT 50`,[suggestionQueue])).rows;
 for(const {id} of rows){
  const row=await withSuggestionRun(id,async(client,row)=>{
   if(row.charge_status==='cancelled'){await cancelReserved(client,row,'The reserved request was cancelled before dispatch.');return null;}
   if(row.status==='running')return row;
   const stale=(await client.query(`SELECT 1 FROM ai_suggestion_run r LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$2 WHERE r.id=$1 AND
    (r.lease_expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed'))`,[id,suggestionQueue])).rowCount;
   if(stale)await cancelReserved(client,row,'The queued suggestion did not complete dispatch. Prepare a new quote.');return null;
  });
  if(row?.lease_owner)await finish(id,row.lease_owner,unknownExecution(row.generation_id,'The worker stopped after dispatch. Reconcile the generation receipt; no paid request will be retried.'),true);
 }
}
export async function expireAiSuggestions(client:PoolClient,projectId:string,cutoff:Date){
 const expired=await client.query(`WITH candidates AS (SELECT r.id FROM ai_suggestion_run r JOIN ai_suggestion_quote q ON q.id=r.quote_id
 WHERE r.project_id=$1 AND (r.raw_result IS NOT NULL OR r.proposal IS NOT NULL) AND (r.completed_at<$2 OR q.created_at<$2)
 ORDER BY r.created_at,r.id LIMIT 100 FOR UPDATE OF r)
 UPDATE ai_suggestion_run r SET raw_result=NULL,proposal=NULL,result_purged_at=COALESCE(result_purged_at,clock_timestamp()) FROM candidates c WHERE r.id=c.id`,[projectId,cutoff]);
 const inputs=await client.query(`WITH candidates AS (SELECT id FROM ai_suggestion_quote WHERE project_id=$1 AND input IS NOT NULL AND created_at<$2 ORDER BY created_at,id LIMIT 100 FOR UPDATE)
 UPDATE ai_suggestion_quote q SET input=NULL,snapshot=NULL,messages=NULL,input_purged_at=clock_timestamp() FROM candidates c WHERE q.id=c.id`,[projectId,cutoff]);
 const pending=(await client.query(`SELECT EXISTS(SELECT 1 FROM ai_suggestion_quote WHERE project_id=$1 AND input IS NOT NULL AND created_at<$2)
 OR EXISTS(SELECT 1 FROM ai_suggestion_run r JOIN ai_suggestion_quote q ON q.id=r.quote_id WHERE r.project_id=$1 AND (r.raw_result IS NOT NULL OR r.proposal IS NOT NULL) AND (r.completed_at<$2 OR q.created_at<$2)) AS pending`,[projectId,cutoff])).rows[0].pending as boolean;
 return {expiredSuggestionResults:expired.rowCount??0,expiredSuggestionInputs:inputs.rowCount??0,pending};
}
