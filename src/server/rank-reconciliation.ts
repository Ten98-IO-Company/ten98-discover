import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {withKeywordProject,keywordConnection,keywordCredentials} from './keyword-research.ts';
import {readRankAccount,readRankReconciliation} from './dataforseo-rank.ts';
import {readRankPlan,rankGroupTasks} from './rank-execution-plan.ts';
import {parseRankReconciliation,type RankExpectedTask} from './rank-provider-outcome.ts';
import {rankDispatchSnapshot,rankRecoveryAvailable,applyReconciledRankOutcome} from './rank-worker.ts';
import {getRankRun} from './rank-execution.ts';

const inputSchema=z.object({requestId:z.uuid(),dispatchId:z.uuid(),connectionId:z.uuid()}).strict();
const inconclusive='The provider evidence could not uniquely confirm every captured task. The recorded charges and spending pause are unchanged.';
export async function reconcileRankCheck(projectId:string,userId:string,runId:string,raw:unknown,send:typeof fetch=fetch){
  runId=parse(z.uuid(),runId);const input=parse(inputSchema,raw),operation='rank.reconcile:'+runId,receiptInput={userId,...input};
  const before=await withKeywordProject(projectId,userId,['owner'],async(client,wid)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,operation,receiptInput);
    if(receipt.replayed)return {replay:true as const};
    const row=await rankDispatchSnapshot(client,input.dispatchId);
    if(!row||row.project_id!==projectId||row.workspace_id!==wid||row.run_id!==runId)throw new FoundationError(404,'Rank dispatch not found or unavailable.');
    if(!row.dispatched_at||!await rankRecoveryAvailable(client,row))throw new FoundationError(409,'This rank dispatch does not require recovery. Reload the check.');
    const age=Date.now()-row.dispatched_at.getTime();
    if(age<120_000)throw new FoundationError(409,'Wait two minutes after dispatch before recovering the provider task. This allows the complete request window to close.');
    if(age>28*86400000)throw new FoundationError(409,'The provider metadata recovery window ended. The recorded charge cannot be changed automatically.');
    const plan=readRankPlan(row.run_request,row.run_hash),group=plan.groups[row.ordinal];
    if(!group)throw new FoundationError(409,'The saved rank dispatch is inconsistent.');
    const saved=(await client.query('SELECT id,provider_task_id FROM rank_task WHERE dispatch_id=$1',[row.id])).rows;
    if(saved.length!==group.taskIds.length)throw new FoundationError(409,'The saved rank tasks are inconsistent.');
    const ids=new Map(saved.map(task=>[task.id,task.provider_task_id]));
    const expected:RankExpectedTask[]=rankGroupTasks(plan,group).map(task=>{
      if(!ids.has(task.id))throw new FoundationError(409,'The saved rank tasks are inconsistent.');
      return {...task,...(ids.get(task.id)?{providerTaskId:ids.get(task.id)}:{})};
    });
    const connection=await keywordConnection(client,wid,input.connectionId);
    return {replay:false as const,row,expected,connectionRevision:connection.revision as number,credentials:keywordCredentials(connection)};
  });
  if(before.replay)return {...await getRankRun(projectId,userId,runId),reconciliation:{status:'matched' as const,message:'The saved recovery request was already applied.',replayed:true}};
  // Both requests are free fixed provider endpoints. Never resend a paid POST.
  const account=await readRankAccount(before.credentials,send);
  if(account.fingerprint!==before.row.account_fingerprint||before.row.account_fingerprint_version!==2)throw new FoundationError(409,'Choose credentials for the provider account that received this check.');
  const response=await readRankReconciliation(before.credentials,{dispatchedAt:before.row.dispatched_at!},send);
  const outcome=parseRankReconciliation(response,before.row.method,before.expected,before.row.dispatched_at!);
  const matched=outcome.tasks.some(task=>task.state!=='uncertain');
  const result=await withKeywordProject(projectId,userId,['owner'],async(client,wid)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,operation,receiptInput);
    if(receipt.replayed)return {replayed:true,matched:true};
    await keywordConnection(client,wid,input.connectionId,before.connectionRevision);
    const row=await rankDispatchSnapshot(client,input.dispatchId);
    if(!row||row.project_id!==projectId||row.run_id!==runId||row.generation!==before.row.generation||row.account_fingerprint!==account.fingerprint||row.dispatched_at?.getTime()!==before.row.dispatched_at!.getTime())throw new FoundationError(409,'The rank dispatch changed during recovery. Reload it.');
    if(!matched)return {replayed:false,matched:false};
    await applyReconciledRankOutcome(client,row.id,row.generation,outcome,{connectionId:input.connectionId,connectionRevision:before.connectionRevision,approvedBy:userId});
    await receipt.save({id:runId});return {replayed:false,matched:true};
  });
  return {...await getRankRun(projectId,userId,runId),reconciliation:{status:result.matched?'matched' as const:'inconclusive' as const,
    message:result.matched?'Provider task evidence was recovered. Available results can be fetched without submitting another paid check. Spending remains subject to the current budget settings.':inconclusive,replayed:result.replayed}};
}
