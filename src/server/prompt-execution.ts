import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {credentialKeys,decryptCredentials} from './credential-vault.ts';
import {providerTransaction,usd} from './providers.ts';
import {reserveSpendInTransaction,dispatchSpend,settleSpend,requestHash} from './spending.ts';
import {executionInput,executionParse,promptModels,type RenderedInput,type RouteSnapshot} from './openrouter-input.ts';
import {readOpenRouterRoutes,keyFingerprint,executionActor,requestPromptExecution,reconcileOpenRouter,unknownExecution,type ExecutionOutcome} from './openrouter.ts';

export const promptExecutionQueue='prompt-execution';
const writers=['owner','admin','editor'],readers=[...writers,'viewer'];
const runSelect=`SELECT r.*,c.quote_id,c.user_id,c.cancel_requested,q.prompt_id,q.version_id,q.connection_id,q.connection_revision,q.key_fingerprint,q.request_actor,
 q.input,q.messages,q.input_purged_at,q.input_hash,q.expires_at,p.status AS charge_status,p.estimate_micros,p.actual_micros,p.provider_reference
 FROM prompt_execution r JOIN prompt_comparison c ON c.id=r.comparison_id JOIN prompt_execution_quote q ON q.id=c.quote_id JOIN provider_request p ON p.id=r.id`;
async function scoped<T>(projectId:string,userId:string,roles:string[],run:(client:PoolClient,wid:string,role:string)=>Promise<T>){
  z.uuid().parse(projectId);z.uuid().parse(userId);
  const project=(await getDatabase().pool.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0];
  if(!project)throw new FoundationError(404,'Project not found or unavailable.');
  return providerTransaction(project.workspace_id,userId,roles,async(client,role)=>{
    if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,project.workspace_id])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
    return run(client,project.workspace_id,role);
  });
}
async function connection(client:PoolClient,wid:string,id:string,revision?:number){
  const row=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='openrouter' AND revoked_at IS NULL",[id,wid])).rows[0];
  if(!row)throw new FoundationError(404,'OpenRouter connection not found or unavailable.');
  if(row.check_status!=='ok'||revision!==undefined&&row.revision!==revision)throw new FoundationError(409,'Check the current OpenRouter connection and prepare a new quote.');return row;
}
function credentials(row:any){return decryptCredentials(row.encrypted_credentials,{id:row.id,workspaceId:row.workspace_id,provider:row.provider,revision:row.revision});}
async function promptVersion(client:PoolClient,projectId:string,promptId:string,versionId:string){
  const row=(await client.query(`SELECT v.text FROM prompt_text_version v JOIN project_prompt p ON p.id=v.prompt_id AND p.project_id=v.project_id
    WHERE v.project_id=$1 AND v.prompt_id=$2 AND v.id=$3 AND p.archived_at IS NULL`,[projectId,promptId,versionId])).rows[0];
  if(!row)throw new FoundationError(409,'The chosen prompt version is unavailable or archived. Review the prompt before running it.');return row.text as string;
}
function summary(row:any,details=false){return {id:row.id,model:row.route.model,provider:row.route.providerName,status:row.status,chargeStatus:row.charge_status,
  estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),dispatchedAt:row.dispatched_at,completedAt:row.completed_at,
  diagnostic:row.diagnostic,resultExpired:row.result_purged_at!==null,...(details?{result:row.result,reportedCost:row.evidence?.reportedCost??null,
    isByok:row.evidence?.isByok??null,upstreamReportedCost:row.evidence?.upstreamReportedCost??null,generationId:row.generation_id}:{} )};}
async function comparisonDto(client:PoolClient,projectId:string,id:string,details=false){
  const c=(await client.query('SELECT * FROM prompt_comparison WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
  if(!c)throw new FoundationError(404,'Comparison not found or unavailable.');
  const rows=(await client.query(runSelect+' WHERE r.comparison_id=$1 AND r.project_id=$2 ORDER BY r.position',[id,projectId])).rows;
  return {id:c.id,quoteId:c.quote_id,createdAt:c.created_at,cancelRequested:c.cancel_requested,runs:rows.map(r=>summary(r,details)),
    ...(details?{input:rows[0]?.input,messages:rows[0]?.messages,inputExpired:rows[0]?.input_purged_at!==null,cache:{reused:false,available:false}}:{})};
}
export async function getPromptExecutions(projectId:string,userId:string){return scoped(projectId,userId,readers,async(client,wid,role)=>{
  const connections=await client.query("SELECT id,name,check_status AS \"checkStatus\" FROM provider_connection WHERE workspace_id=$1 AND provider='openrouter' AND revoked_at IS NULL ORDER BY created_at,id",[wid]);
  const budget=(await client.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[wid])).rows[0];
  const comparisons=[];for(const row of (await client.query('SELECT id FROM prompt_comparison WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[projectId])).rows)comparisons.push(await comparisonDto(client,projectId,row.id));
  return {role,models:promptModels,vaultConfigured:credentialKeys()!==null,spendingPaused:budget?.paused??true,connections:connections.rows,comparisons,cache:{available:false},scheduling:{available:false}};
});}
export async function getPromptComparison(projectId:string,userId:string,id:string){z.uuid().parse(id);return scoped(projectId,userId,readers,async client=>({comparison:await comparisonDto(client,projectId,id,true)}));}
export async function quotePromptExecution(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
  const input=executionParse(executionInput,raw);
  const saved=await scoped(projectId,userId,writers,async(client,wid)=>{
    const text=await promptVersion(client,projectId,input.promptId,input.versionId),row=await connection(client,wid,input.connectionId);
    const messages:RenderedInput=[...(input.systemText?[{role:'system' as const,content:input.systemText}]:[]),{role:'user',content:text}];
    return {messages,revision:row.revision,credentials:credentials(row),name:row.name};
  });
  const routes=await readOpenRouterRoutes(saved.credentials,input.models,input.maxCompletionTokens,send),fingerprint=keyFingerprint(saved.credentials);
  return scoped(projectId,userId,writers,async(client,wid)=>{
    await connection(client,wid,input.connectionId,saved.revision);await promptVersion(client,projectId,input.promptId,input.versionId);
    const hash=requestHash(JSON.stringify({input,messages:saved.messages,routes}));
    const row=(await client.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '5 minutes') RETURNING id,created_at,expires_at`,
      [randomUUID(),wid,projectId,userId,input.promptId,input.versionId,input.connectionId,saved.revision,fingerprint,JSON.stringify(input),JSON.stringify(saved.messages),JSON.stringify(routes),hash,executionActor(userId)])).rows[0];
    return {quote:{id:row.id,createdAt:row.created_at,expiresAt:row.expires_at,input,messages:saved.messages,connectionName:saved.name,
      routes:routes.map(r=>({...r,estimateMicros:undefined,estimateUsd:usd(r.estimateMicros)})),estimateUsd:usd(routes.reduce((sum,r)=>sum+BigInt(r.estimateMicros),0n)),
      explanation:'Conservative reservation under the selected endpoint’s published limits. Actual credit charges are recorded after completion; external invoices, credit-purchase fees and taxes are excluded.',cacheReused:false}};
  });
}
export async function startPromptExecution(projectId:string,userId:string,raw:unknown){
  const {quoteId,requestKey}=executionParse(z.object({quoteId:z.uuid(),requestKey:z.uuid()}).strict(),raw),boss=await getBoss();
  return scoped(projectId,userId,writers,async(client,wid)=>{
    const prior=(await client.query('SELECT * FROM prompt_comparison WHERE workspace_id=$1 AND request_key=$2',[wid,requestKey])).rows[0];
    if(prior){if(prior.project_id!==projectId||prior.user_id!==userId||prior.quote_id!==quoteId)throw new FoundationError(409,'This request key already identifies different work.');return {comparison:await comparisonDto(client,projectId,prior.id,true)};}
    const q=(await client.query('SELECT * FROM prompt_execution_quote WHERE id=$1 AND project_id=$2 AND user_id=$3 AND workspace_id=$4 FOR UPDATE',[quoteId,projectId,userId,wid])).rows[0];
    if(!q)throw new FoundationError(404,'Quote not found or unavailable.');
    if(q.expires_at.getTime()<=Date.now())throw new FoundationError(409,'The quote expired. Prepare a new quote.');
    await connection(client,wid,q.connection_id,q.connection_revision);await promptVersion(client,projectId,q.prompt_id,q.version_id);
    if((await client.query('SELECT id FROM prompt_comparison WHERE quote_id=$1',[quoteId])).rowCount)throw new FoundationError(409,'This quote already started a comparison.');
    const id=randomUUID();await client.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key) VALUES($1,$2,$3,$4,$5,$6)',[id,quoteId,wid,projectId,userId,requestKey]);
    for(const [position,route] of (q.routes as RouteSnapshot[]).entries()){
      await reserveSpendInTransaction(client,wid,userId,{connectionId:q.connection_id,requestKey:randomUUID(),operation:'prompt.execute',inputHash:requestHash(`${q.input_hash}:${position}:${route.model}`),estimateUsd:usd(route.estimateMicros)},async(tx,child)=>{
        await tx.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status) VALUES($1,$2,$3,$4,$5,$6,'queued')",[child,id,wid,projectId,position,JSON.stringify(route)]);
      });
    }
    if(!await boss.send(promptExecutionQueue,{comparisonId:id},{id,retryLimit:0,expireInSeconds:180,db:{executeSql:(text,values)=>client.query(text,values)}}))throw new Error('Comparison could not be queued.');
    return {comparison:await comparisonDto(client,projectId,id,true)};
  });
}
async function cancelChildren(client:PoolClient,id:string,diagnostic:string){
  await client.query(`UPDATE provider_request p SET status='cancelled',updated_at=clock_timestamp() FROM prompt_execution r
    WHERE r.comparison_id=$1 AND p.id=r.id AND p.status='reserved'`,[id]);
  await client.query(`UPDATE prompt_execution r SET status='cancelled',diagnostic=$2,completed_at=clock_timestamp() FROM provider_request p
    WHERE r.comparison_id=$1 AND p.id=r.id AND p.status='cancelled' AND r.status='queued'`,[id,diagnostic]);
}
export async function cancelPromptComparison(projectId:string,userId:string,id:string,raw:unknown){
  z.uuid().parse(id);executionParse(z.object({}).strict(),raw);
  return scoped(projectId,userId,writers,async(client,_wid,role)=>{
    const row=(await client.query('SELECT * FROM prompt_comparison WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
    if(!row)throw new FoundationError(404,'Comparison not found or unavailable.');
    if(row.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can stop this comparison.');
    await client.query('UPDATE prompt_comparison SET cancel_requested=true WHERE id=$1',[id]);await cancelChildren(client,id,'Stopped before dispatch. Already dispatched work may still incur a charge.');
    return {comparison:await comparisonDto(client,projectId,id,true)};
  });
}
async function workerTransaction<T>(comparisonId:string,work:(client:PoolClient)=>Promise<T>){
  const client=await getDatabase().pool.connect();try{await client.query('BEGIN');const c=(await client.query('SELECT workspace_id FROM prompt_comparison WHERE id=$1',[comparisonId])).rows[0];if(!c)throw new Error('Comparison no longer exists.');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[c.workspace_id]);const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function finish(row:any,outcome:ExecutionOutcome,crashOnly=false){return workerTransaction(row.comparison_id,async client=>{
  const current=(await client.query(runSelect+' WHERE r.id=$1',[row.id])).rows[0];
  if(!current||crashOnly&&(current.status!=='running'||current.charge_status!=='dispatched'||current.dispatched_at.getTime()>Date.now()-90_000))return;
  if(!['dispatched','uncertain'].includes(current.charge_status))return;
  if(current.generation_id&&outcome.reference&&current.generation_id!==outcome.reference)outcome=unknownExecution(current.generation_id,'Conflicting provider generation receipts require investigation.');
  const reference=outcome.reference??current.generation_id;
  const settled=await settleSpend(client,current.workspace_id,current.id,outcome.cost,reference);
  await client.query(`UPDATE prompt_execution SET status=$2,diagnostic=$3,result=$4,evidence=$5,generation_id=$6,completed_at=clock_timestamp() WHERE id=$1`,
    [row.id,settled.reconciliationRequired?'uncertain':outcome.result?'completed':'failed',outcome.diagnostic,outcome.result===null?null:JSON.stringify(outcome.result),JSON.stringify(outcome.evidence),reference]);
  if(outcome.pause)await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[current.workspace_id]);
  const paused=(await client.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[current.workspace_id])).rows[0]?.paused;
  if(settled.reconciliationRequired||paused)await cancelChildren(client,current.comparison_id,'Remaining requests stopped because spending requires review.');
});}
export async function executePromptComparison(id:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(id).success)throw new Error('Invalid comparison job.');
  const children=(await getDatabase().pool.query(runSelect+' WHERE r.comparison_id=$1 ORDER BY r.position',[id])).rows;
  for(const child of children){
    const row=(await getDatabase().pool.query(runSelect+' WHERE r.id=$1',[child.id])).rows[0];if(!row)continue;
    if(row.status==='running'||row.status==='uncertain')return;if(row.status!=='queued')continue;
    let secret:unknown,dispatchedAt:Date|undefined;
    try{
      const saved=await scoped(row.project_id,row.user_id,writers,async(client,wid)=>({credentials:credentials(await connection(client,wid,row.connection_id,row.connection_revision))}));
      if(keyFingerprint(saved.credentials)!==row.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
      const [fresh]=await readOpenRouterRoutes(saved.credentials,[row.route.model],row.input.maxCompletionTokens,send);
      if(Object.entries(fresh).some(([key,value])=>row.route[key]!==value))throw new FoundationError(409,'Endpoint prices or capacity changed.');
      await dispatchSpend(row.workspace_id,row.user_id,row.id,async(client)=>{
        const live=(await client.query(runSelect+' WHERE r.id=$1',[row.id])).rows[0];
        if(live.status!=='queued'||live.cancel_requested||live.expires_at.getTime()<=Date.now())throw new FoundationError(409,'Execution authorization expired.');
        if((await client.query("SELECT id FROM prompt_execution WHERE comparison_id=$1 AND position<$2 AND status IN('queued','running','uncertain')",[id,live.position])).rowCount)throw new FoundationError(409,'An earlier comparison request is unfinished.');
        await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[row.project_id]);await promptVersion(client,row.project_id,row.prompt_id,row.version_id);
        secret=credentials(await connection(client,row.workspace_id,row.connection_id,row.connection_revision));if(keyFingerprint(secret)!==row.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
        dispatchedAt=(await client.query("UPDATE prompt_execution SET status='running',dispatched_at=clock_timestamp() WHERE id=$1 RETURNING dispatched_at",[row.id])).rows[0].dispatched_at;
      });
    }catch(error){
      if(error instanceof FoundationError){await workerTransaction(id,async client=>{
        // A duplicate worker must not cancel siblings after another worker advances this child.
        const current=(await client.query('SELECT status FROM prompt_execution WHERE id=$1',[row.id])).rows[0];
        if(current?.status!=='queued')return;
        await cancelChildren(client,id,'Not dispatched because the quote, endpoint, permissions, credentials or spending limits changed.');
      });return;}throw error;
    }
    const outcome=await requestPromptExecution(secret,row.messages,row.route,row.input.maxCompletionTokens,row.id,row.request_actor,dispatchedAt!,async generation=>{
      await workerTransaction(id,async client=>{const live=(await client.query('SELECT generation_id FROM prompt_execution WHERE id=$1',[row.id])).rows[0];if(live.generation_id&&live.generation_id!==generation)throw new Error('Generation receipt conflict.');await client.query('UPDATE prompt_execution SET generation_id=$2 WHERE id=$1',[row.id,generation]);});
    },send);
    await finish(row,outcome);
  }
}
export async function reconcilePromptExecution(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
  z.uuid().parse(id);executionParse(z.object({}).strict(),raw);
  const saved=await scoped(projectId,userId,['owner'],async(client,wid)=>{
    const row=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];
    if(!row)throw new FoundationError(404,'Execution not found or unavailable.');
    if(row.status!=='uncertain'||row.charge_status!=='uncertain'||!row.dispatched_at)throw new FoundationError(409,'This charge does not require reconciliation.');
    const conn=await connection(client,wid,row.connection_id),secret=credentials(conn);
    if(keyFingerprint(secret)!==row.key_fingerprint)throw new FoundationError(409,'Reconciliation requires the original OpenRouter key identity.');
    return {row,credentials:secret,revision:conn.revision};
  });
  let outcome:ExecutionOutcome;
  try{outcome=await reconcileOpenRouter(saved.credentials,saved.row.generation_id,saved.row.route,saved.row.dispatched_at,id,saved.row.request_actor,send);}
  catch(error){if(error instanceof FoundationError)return {...await getPromptComparison(projectId,userId,saved.row.comparison_id),reconciliation:{status:'inconclusive',message:error.message}};throw error;}
  return scoped(projectId,userId,['owner'],async(client,wid)=>{
    const conn=await connection(client,wid,saved.row.connection_id,saved.revision);if(keyFingerprint(credentials(conn))!==saved.row.key_fingerprint)throw new FoundationError(409,'The key changed during reconciliation.');
    const current=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];
    if(current.charge_status!=='uncertain'||current.generation_id!==outcome.reference)throw new FoundationError(409,'The receipt changed. Reload this comparison.');
    const settled=await settleSpend(client,wid,id,outcome.cost,outcome.reference);
    await client.query('UPDATE prompt_execution SET status=$2,evidence=$3,diagnostic=$4,completed_at=clock_timestamp() WHERE id=$1',[id,settled.reconciliationRequired?'uncertain':current.result?'completed':'reconciled',JSON.stringify(outcome.evidence),outcome.diagnostic??'The credit charge was recovered. The original answer is unavailable; a new answer requires a new paid quote.']);
    await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[wid]);
    return {comparison:await comparisonDto(client,projectId,current.comparison_id,true),reconciliation:{status:settled.reconciliationRequired?'inconclusive':'matched',message:'Spending remains paused until an owner reviews the charge.'}};
  });
}
export async function reconcilePromptExecutionJobs(){
  const pending=(await getDatabase().pool.query(`SELECT c.id FROM prompt_comparison c JOIN prompt_execution_quote q ON q.id=c.quote_id
    LEFT JOIN pgboss.job j ON j.id=c.id AND j.name=$1 WHERE EXISTS(SELECT 1 FROM prompt_execution r WHERE r.comparison_id=c.id AND r.status IN('queued','running'))
    AND (q.expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed') OR EXISTS(SELECT 1 FROM prompt_execution r WHERE r.comparison_id=c.id AND r.status='running' AND r.dispatched_at<clock_timestamp()-interval '90 seconds'))
    ORDER BY c.created_at LIMIT 50`,[promptExecutionQueue])).rows;
  for(const comparison of pending){
    const running=(await getDatabase().pool.query(runSelect+" WHERE r.comparison_id=$1 AND r.status='running' AND r.dispatched_at<clock_timestamp()-interval '90 seconds'",[comparison.id])).rows;
    for(const row of running)await finish(row,unknownExecution(row.generation_id,'The worker stopped after dispatch. Reconcile the captured generation receipt; no request will be replayed.'),true);
    await workerTransaction(comparison.id,async client=>{
      // Recheck queue/expiry after the gate; a stale sweep must not cancel freshly active work.
      const stale=(await client.query(`SELECT 1 FROM prompt_comparison c JOIN prompt_execution_quote q ON q.id=c.quote_id LEFT JOIN pgboss.job j ON j.id=c.id AND j.name=$2
        WHERE c.id=$1 AND (q.expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed'))`,[comparison.id,promptExecutionQueue])).rowCount;
      if(stale)await cancelChildren(client,comparison.id,'The queued comparison did not run. Prepare a new quote to try again.');
    });
  }
}
