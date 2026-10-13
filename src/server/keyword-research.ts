import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {credentialKeys,decryptCredentials} from './credential-vault.ts';
import {providerTransaction,usd} from './providers.ts';
import {reserveSpend,dispatchSpend,settleSpend,requestHash} from './spending.ts';
import {parseKeywordRequest,microUsd,type KeywordRequest,type KeywordMarket} from './keyword-research-input.ts';
import {readKeywordMarkets,readKeywordAccount,requestKeywordResearch,reconcileKeywordCharge,type KeywordOutcome} from './dataforseo-keywords.ts';

export const keywordQueue='keyword-research';
const writers=['owner','admin','editor'];
const readers=[...writers,'viewer'];
const runSelect=`SELECT r.*,q.request,q.connection_id,q.connection_revision,q.account_fingerprint,q.expires_at,q.estimate_micros,
 p.actual_micros,p.provider_reference,p.status AS charge_status,p.request_key FROM keyword_research_run r
 JOIN keyword_quote q ON q.id=r.quote_id JOIN provider_request p ON p.id=r.id`;
const fieldInput=z.object({connectionId:z.uuid()}).strict();
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the keyword research fields and try again.');return result.data;}
async function projectContext(projectId:string,userId:string){
  z.uuid().parse(projectId);z.uuid().parse(userId);
  const row=(await getDatabase().pool.query('SELECT p.workspace_id,m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0];
  if(!row)throw new FoundationError(404,'Project not found or unavailable.');return row as {workspace_id:string;role:string};
}
async function scoped<T>(projectId:string,userId:string,roles:string[],run:(client:PoolClient,workspaceId:string,role:string)=>Promise<T>){
  const context=await projectContext(projectId,userId);
  return providerTransaction(context.workspace_id,userId,roles,async(client,role)=>{
    if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2',[projectId,context.workspace_id])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
    return run(client,context.workspace_id,role);
  });
}
async function connection(client:PoolClient,workspaceId:string,id:string,revision?:number){
  const row=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='dataforseo' AND revoked_at IS NULL",[id,workspaceId])).rows[0];
  if(!row)throw new FoundationError(404,'DataForSEO connection not found or unavailable.');
  if(revision!==undefined&&row.revision!==revision)throw new FoundationError(409,'The provider credentials changed. Prepare a new quote.');return row;
}
function credentials(row:any){return decryptCredentials(row.encrypted_credentials,{id:row.id,workspaceId:row.workspace_id,provider:row.provider,revision:row.revision});}
function summary(row:any){return {id:row.id,mode:row.request.mode,keywords:row.request.keywords,locationCode:row.request.locationCode,languageCode:row.request.languageCode,status:row.status,createdAt:row.created_at,completedAt:row.completed_at,estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),chargeStatus:row.charge_status};}
function dto(row:any,userId:string,role:string){return {...summary(row),request:row.request,canCancel:row.status==='queued'&&row.charge_status==='reserved'&&(row.user_id===userId||role==='owner'),diagnostic:row.diagnostic,result:row.result,resultExpired:row.result_purged_at!==null};}
async function runRow(client:PoolClient,projectId:string,id:string){const row=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];if(!row)throw new FoundationError(404,'Research run not found or unavailable.');return row;}
export async function getKeywordResearch(projectId:string,userId:string){return scoped(projectId,userId,readers,async(client,workspaceId,role)=>{
  const connections=await client.query("SELECT id,name,check_status AS \"checkStatus\" FROM provider_connection WHERE workspace_id=$1 AND provider='dataforseo' AND revoked_at IS NULL ORDER BY created_at,id",[workspaceId]);
  const catalog=(await client.query('SELECT updated_at AS "updatedAt",markets FROM keyword_market_catalog WHERE workspace_id=$1',[workspaceId])).rows[0]??{updatedAt:null,markets:[]};
  const budget=(await client.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[workspaceId])).rows[0];
  const rows=await client.query(runSelect+' WHERE r.project_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 20',[projectId]);
  return {role,vaultConfigured:credentialKeys()!==null,spendingPaused:budget?.paused??true,connections:connections.rows,catalog,runs:rows.rows.map(summary)};
});}
export async function getKeywordRun(projectId:string,userId:string,id:string){z.uuid().parse(id);return scoped(projectId,userId,readers,async(client,_workspace,role)=>({run:dto(await runRow(client,projectId,id),userId,role)}));}
export async function refreshKeywordMarkets(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
  const {connectionId}=parse(fieldInput,raw);
  const saved=await scoped(projectId,userId,writers,async(client,wid)=>{const row=await connection(client,wid,connectionId);return {revision:row.revision,credentials:credentials(row)};});
  const markets=await readKeywordMarkets(saved.credentials,send);
  return scoped(projectId,userId,writers,async(client,wid)=>{await connection(client,wid,connectionId,saved.revision);const result=await client.query('INSERT INTO keyword_market_catalog(workspace_id,markets) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET markets=excluded.markets,updated_at=clock_timestamp() RETURNING updated_at AS "updatedAt",markets',[wid,JSON.stringify(markets)]);return {catalog:result.rows[0]};});
}
export async function quoteKeywordResearch(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
  const request=parseKeywordRequest(raw);
  const saved=await scoped(projectId,userId,writers,async(client,wid)=>{
    const catalog=(await client.query("SELECT markets FROM keyword_market_catalog WHERE workspace_id=$1 AND updated_at>clock_timestamp()-interval '7 days'",[wid])).rows[0];
    if(!catalog||(catalog.markets as KeywordMarket[]).every(m=>m.locationCode!==request.locationCode||m.languageCode!==request.languageCode))throw new FoundationError(409,'Refresh markets and choose a supported country and language before preparing a quote.');
    const row=await connection(client,wid,request.connectionId);return {revision:row.revision,name:row.name,credentials:credentials(row)};
  });
  const price=await readKeywordAccount(saved.credentials,request.mode,send);
  const upperItems=request.mode==='overview'?request.keywords.length:request.limit;
  const estimate=price.perTask+price.perItem*BigInt(upperItems);
  if(estimate<1n||estimate>1_000_000_000_000n)throw new FoundationError(502,'The provider price is outside supported budget limits.');
  return scoped(projectId,userId,writers,async(client,wid)=>{
    await connection(client,wid,request.connectionId,saved.revision);
    const row=(await client.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),clock_timestamp()+interval '5 minutes') RETURNING id,expires_at,price_as_of`,[randomUUID(),wid,projectId,userId,request.connectionId,saved.revision,JSON.stringify(request),price.fingerprint,price.perTask.toString(),price.perItem.toString(),estimate.toString()])).rows[0];
    return {quote:{id:row.id,expiresAt:row.expires_at,request,connectionName:saved.name,estimateUsd:microUsd(estimate),perTaskUsd:microUsd(price.perTask),perItemUsd:microUsd(price.perItem),upperItems,priceAsOf:row.price_as_of}};
  });
}
export async function startKeywordResearch(projectId:string,userId:string,raw:unknown){
  const {quoteId,requestKey}=parse(z.object({quoteId:z.uuid(),requestKey:z.uuid()}).strict(),raw);
  const saved=await scoped(projectId,userId,writers,async(client,wid)=>{
    const quote=(await client.query('SELECT * FROM keyword_quote WHERE id=$1 AND project_id=$2 AND user_id=$3',[quoteId,projectId,userId])).rows[0];
    if(!quote)throw new FoundationError(404,'Quote not found or unavailable.');return {quote,wid};
  });
  const boss=await getBoss();
  const input={connectionId:saved.quote.connection_id,requestKey,operation:'keyword.'+saved.quote.request.mode,inputHash:requestHash(JSON.stringify({projectId,quoteId,request:saved.quote.request})),estimateUsd:usd(saved.quote.estimate_micros)};
  const reservation=await reserveSpend(saved.wid,userId,input,async(client,id)=>{
    const quote=(await client.query('SELECT * FROM keyword_quote WHERE id=$1 AND project_id=$2 AND user_id=$3 AND workspace_id=$4 FOR UPDATE',[quoteId,projectId,userId,saved.wid])).rows[0];
    if(!quote||quote.expires_at.getTime()<=Date.now())throw new FoundationError(409,'The quote expired. Prepare a new quote before running research.');
    await connection(client,saved.wid,quote.connection_id,quote.connection_revision);
    if((await client.query('SELECT 1 FROM keyword_research_run WHERE quote_id=$1',[quoteId])).rowCount)throw new FoundationError(409,'This quote already started a run. Open that run or prepare a new quote.');
    await client.query("INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[id,saved.wid,projectId,userId,quoteId]);
    const job=await boss.send(keywordQueue,{runId:id},{id,retryLimit:0,expireInSeconds:60,db:{executeSql:(text,values)=>client.query(text,values)}});
    if(!job)throw new Error('Research could not be queued.');
  });
  return getKeywordRun(projectId,userId,reservation.id);
}
export async function cancelKeywordResearch(projectId:string,userId:string,id:string,raw:unknown){
  z.uuid().parse(id);parse(z.object({}).strict(),raw);
  return scoped(projectId,userId,writers,async(client,wid,role)=>{
    const row=await runRow(client,projectId,id);
    if(row.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can cancel this run.');
    if(row.status!=='queued'||row.charge_status!=='reserved')throw new FoundationError(409,'Only an undispatched run can be cancelled.');
    await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND status='reserved'",[id,wid]);
    await client.query("UPDATE keyword_research_run SET status='cancelled',completed_at=clock_timestamp(),diagnostic='Cancelled before dispatch.' WHERE id=$1",[id]);
    return {run:dto(await runRow(client,projectId,id),userId,role)};
  });
}
async function cancelUndispatched(id:string,message:string){
  const client=await getDatabase().pool.connect();
  try{await client.query('BEGIN');const run=(await client.query('SELECT workspace_id FROM keyword_research_run WHERE id=$1',[id])).rows[0];if(run){await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[run.workspace_id]);await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[id]);const cancelled=await client.query("SELECT id FROM provider_request WHERE id=$1 AND status='cancelled'",[id]);if(cancelled.rowCount)await client.query("UPDATE keyword_research_run SET status='cancelled',completed_at=clock_timestamp(),diagnostic=$2 WHERE id=$1 AND status='queued'",[id,message]);}await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function finishResearch(id:string,outcome:KeywordOutcome,crashOnly=false){
  const client=await getDatabase().pool.connect();
  try{await client.query('BEGIN');const location=(await client.query('SELECT workspace_id FROM keyword_research_run WHERE id=$1',[id])).rows[0];if(!location)throw new Error('Research no longer exists.');
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[location.workspace_id]);
    const row=(await client.query(runSelect+' WHERE r.id=$1',[id])).rows[0];if(!row)throw new Error('Research no longer exists.');
    if(crashOnly&&(row.status!=='running'||row.charge_status!=='dispatched'||!row.dispatched_at||row.dispatched_at.getTime()>Date.now()-90_000)){await client.query('COMMIT');return;}
    const settled=await settleSpend(client,row.workspace_id,id,outcome.cost,outcome.reference);
    const status=settled.reconciliationRequired?'uncertain':outcome.result?'completed':'failed';
    await client.query('UPDATE keyword_research_run SET status=$2,diagnostic=$3,result=$4,reconciliation_evidence=$5,completed_at=clock_timestamp() WHERE id=$1',[id,status,outcome.diagnostic,outcome.result===null?null:JSON.stringify(outcome.result),JSON.stringify(outcome.evidence)]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
export async function executeKeywordResearch(id:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(id).success)throw new Error('Invalid research job.');
  const initial=(await getDatabase().pool.query(runSelect+' WHERE r.id=$1',[id])).rows[0];if(!initial||initial.status!=='queued')return;
  let secret:unknown;let request:KeywordRequest;
  try{await dispatchSpend(initial.workspace_id,initial.user_id,id,async(client,ledger)=>{
    const row=await runRow(client,initial.project_id,id);
    if(row.status!=='queued'||row.expires_at.getTime()<=Date.now())throw new FoundationError(409,'Research authorization expired.');
    const stored=await connection(client,initial.workspace_id,ledger.connection_id,ledger.connection_revision);
    secret=credentials(stored);request=parseKeywordRequest(row.request);
    await client.query("UPDATE keyword_research_run SET status='running',dispatched_at=clock_timestamp() WHERE id=$1",[id]);
  });}catch(error){if(error instanceof FoundationError){await cancelUndispatched(id,'Research was not dispatched because its quote, permissions, connection or spending limits changed.');return;}throw error;}
  const outcome=await requestKeywordResearch(secret,request!,id,send);
  await finishResearch(id,outcome);
}
export async function reconcileKeywordResearch(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
  z.uuid().parse(id);const {connectionId}=parse(fieldInput,raw);
  const saved=await scoped(projectId,userId,['owner'],async(client,wid)=>{const row=await runRow(client,projectId,id);if(row.status!=='uncertain'||row.charge_status!=='uncertain'||!row.dispatched_at)throw new FoundationError(409,'This run does not require charge reconciliation.');const conn=await connection(client,wid,connectionId);return {row,revision:conn.revision,credentials:credentials(conn)};});
  let matched:{reference:string;cost:string;statusCode:number};
  try{const account=await readKeywordAccount(saved.credentials,undefined,send);if(account.fingerprint!==saved.row.account_fingerprint)throw new FoundationError(409,'Choose credentials for the provider account that received this request.');matched=await reconcileKeywordCharge(saved.credentials,saved.row.request,id,saved.row.dispatched_at,send);if(saved.row.provider_reference!==null&&matched.reference!==saved.row.provider_reference)throw new FoundationError(409,'The provider task differs from the recorded request. Its charge remains unresolved.');}
  catch(error){if(error instanceof FoundationError)return {...await getKeywordRun(projectId,userId,id),reconciliation:{status:'inconclusive' as const,message:error.message}};throw error;}
  return scoped(projectId,userId,['owner'],async(client,wid,role)=>{
    await connection(client,wid,connectionId,saved.revision);const current=await runRow(client,projectId,id);
    if(current.provider_reference!==null&&matched.reference!==current.provider_reference)throw new FoundationError(409,'The provider task changed during reconciliation. Reload this run.');
    if(current.charge_status!=='uncertain')throw new FoundationError(409,'The charge changed during reconciliation. Reload this run.');
    const settled=await settleSpend(client,wid,id,matched.cost,matched.reference);
    await client.query('UPDATE keyword_research_run SET status=$2,diagnostic=$3,reconciliation_evidence=$4,completed_at=clock_timestamp() WHERE id=$1',[id,settled.reconciliationRequired?'uncertain':current.result?'completed':'reconciled',settled.reconciliationRequired?'The reported charge is outside supported limits; spending remains blocked.':current.result?null:'The charge was recovered. The original live result is unavailable; a new result requires a new paid quote.',JSON.stringify({source:'dataforseo_labs/id_list',taskId:matched.reference,statusCode:matched.statusCode,actualUsd:matched.cost,checkedAt:new Date().toISOString()})]);
    return {run:dto(await runRow(client,projectId,id),userId,role),reconciliation:{status:settled.reconciliationRequired?'inconclusive' as const:'matched' as const,message:settled.reconciliationRequired?'The charge remains unresolved.':'Provider charge matched. Spending stays paused until an owner reviews the budget.'}};
  });
}
// No paid replay: terminal queue state can cancel an unsubmitted reservation or mark a lost dispatch uncertain.
export async function reconcileKeywordJobs(){
  const rows=await getDatabase().pool.query(`SELECT r.id,r.status FROM keyword_research_run r JOIN keyword_quote q ON q.id=r.quote_id
    LEFT JOIN pgboss.job j ON j.id=r.id AND j.name=$1
    WHERE (r.status='queued' AND (q.expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed')))
       OR (r.status='running' AND r.dispatched_at<clock_timestamp()-interval '90 seconds') ORDER BY r.created_at LIMIT 50`,[keywordQueue]);
  for(const row of rows.rows){if(row.status==='queued')await cancelUndispatched(row.id,'The queued research did not run. Prepare a new quote to try again.');else await finishResearch(row.id,{cost:null,reference:null,result:null,diagnostic:'The worker stopped after dispatch. The provider charge must be reconciled before spending again.',evidence:{httpStatus:null,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}},true);}
}
export async function pruneKeywordResults(workspaceId?:string){
  // ponytail: one short workspace batch shares the worker heartbeat; increase measured throughput before adding cleanup jobs.
  const client=await getDatabase().pool.connect();
  try{
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='250ms'");await client.query("SET LOCAL statement_timeout='2s'");
    const candidate=(await client.query(`SELECT w.id FROM workspace w WHERE ($1::text IS NULL OR w.id=$1) AND (
      EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.workspace_id=w.id AND r.result IS NOT NULL AND r.completed_at<clock_timestamp()-w.derived_history_days*interval '1 day')
      OR EXISTS(SELECT 1 FROM keyword_quote q WHERE q.workspace_id=w.id AND q.expires_at<clock_timestamp()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id)))
      ORDER BY w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,[workspaceId??null])).rows[0];
    if(candidate){
      // Read the current policy after its serialization lock; a concurrent extension must protect its newly retained data.
      const cutoff=(await client.query("SELECT clock_timestamp()-derived_history_days*interval '1 day' AS cutoff FROM workspace WHERE id=$1",[candidate.id])).rows[0].cutoff;
      await client.query(`WITH expired AS (SELECT id FROM keyword_research_run WHERE workspace_id=$1 AND result IS NOT NULL AND completed_at<$2 ORDER BY completed_at,id LIMIT 100)
        UPDATE keyword_research_run r SET result=NULL,result_purged_at=clock_timestamp() FROM expired e WHERE r.id=e.id`,[candidate.id,cutoff]);
      await client.query(`DELETE FROM keyword_quote WHERE id IN(SELECT q.id FROM keyword_quote q WHERE q.workspace_id=$1 AND q.expires_at<clock_timestamp()-interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM keyword_research_run r WHERE r.quote_id=q.id) ORDER BY q.expires_at,q.id LIMIT 100)`,[candidate.id]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
