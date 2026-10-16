import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash} from './context-input.ts';
import {projectDeleteInput,projectDeleteState,projectDeleteResult} from '../lib/project-delete.ts';

const missing=()=>new FoundationError(404,'Website not found or unavailable.');
const changed=()=>new FoundationError(409,'This website or request changed. Reload access before confirming a new deletion.');
async function workspace<T>(workspaceId:string,projectId:string,userId:string,write:boolean,work:(client:PoolClient,role:'owner'|'admin')=>Promise<T>):Promise<T>{
 if(![workspaceId,projectId,userId].every(id=>z.uuid().safeParse(id).success))throw missing();
 const client=await getDatabase().pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='2s';SET LOCAL transaction_timeout='15s'");
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR '+(write?'UPDATE':'SHARE'),[workspaceId]);
  const authority=(await client.query("SELECT m.role FROM membership m JOIN workspace w ON w.id=m.workspace_id WHERE w.id=$1 AND m.user_id=$2 AND m.role IN('owner','admin')",[workspaceId,userId])).rows[0];if(!authority)throw missing();
  const result=await work(client,authority.role);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03','25P04'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Website deletion is busy or exceeds its bounded transaction. Retry only the same request ID and confirmation.');throw error;}finally{client.release();}
}
export async function getProjectDeletion(workspaceId:string,projectId:string,userId:string){return workspace(workspaceId,projectId,userId,false,async(client,role)=>{
 const row=(await client.query('SELECT name,analytics_revision AS revision FROM project WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,projectId])).rows[0];
 // Null does not acknowledge any POST; a current workspace owner may retry a held request.
 return projectDeleteState.parse({workspaceId,projectId,role,item:row??null});
 });}
export async function deleteProject(workspaceId:string,projectId:string,userId:string,raw:unknown){
 const parsed=projectDeleteInput.safeParse(raw);if(!parsed.success)throw new FoundationError(400,'Type DELETE exactly and reload the current website revision.');const input=parsed.data;
 return workspace(workspaceId,projectId,userId,true,async(client,role)=>{
  const inputHash=canonicalHash({operation:'project.delete.v1',workspaceId,projectId,actorId:userId,...input});
  const prior=(await client.query("SELECT actor_id,project_id,input_hash,applied_revision,to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM project_deletion_request WHERE workspace_id=$1 AND request_id=$2",[workspaceId,input.requestId])).rows[0];
  if(prior){if(prior.actor_id!==userId||prior.project_id!==projectId||prior.input_hash!==inputHash)throw changed();return projectDeleteResult.parse({workspaceId,role,ack:{workspaceId,projectId,requestId:input.requestId,appliedRevision:prior.applied_revision,deletedAt:prior.at},deleted:true,replayed:true});}
  const target=(await client.query('SELECT analytics_revision AS revision FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,workspaceId])).rows[0];if(!target)throw missing();if(target.revision!==input.revision)throw changed();
  // These seven existing FK families own every charged project request. Saved-keyword
  // refreshes use keyword runs; backlinks use domain runs; cached views create no ledger.
  const active=await client.query(`WITH ids AS(
   SELECT id FROM keyword_research_run WHERE project_id=$1 UNION ALL SELECT e.id FROM prompt_execution e JOIN prompt_comparison c ON c.id=e.comparison_id WHERE c.project_id=$1
   UNION ALL SELECT d.id FROM rank_dispatch d JOIN rank_run r ON r.id=d.run_id WHERE r.project_id=$1 UNION ALL SELECT id FROM ai_suggestion_run WHERE project_id=$1
   UNION ALL SELECT id FROM ai_search_run WHERE project_id=$1 UNION ALL SELECT id FROM ai_content_support_run WHERE project_id=$1
   UNION ALL SELECT id FROM domain_research_run WHERE project_id=$1)
   SELECT 1 FROM provider_request p JOIN ids ON ids.id=p.id WHERE p.workspace_id=$2 AND p.status IN('reserved','dispatched','uncertain') LIMIT 1`,[projectId,workspaceId]);
  if(active.rowCount)throw new FoundationError(409,'Finish or cancel reserved work and reconcile uncertain provider charges before deleting this website.');
  // Same W gate serializes all reserve/dispatch/settle paths. No financial row is modified.
  // Break the existing recurring quote/occurrence cycle, then only the NO ACTION/RESTRICT
  // children. Remaining exact-project dependents use their existing FK cascade.
  await client.query('UPDATE prompt_execution_quote SET recurring_occurrence_id=NULL,recurring_models_hash=NULL WHERE project_id=$1',[projectId]);
  for(const table of ['prompt_occurrence','prompt_tracker','prompt_comparison_item','prompt_execution','prompt_comparison','rank_task','rank_dispatch','rank_run','rank_keyword','rank_config','ai_suggestion_run','saved_keyword_tag_assignment'] as const)await client.query('DELETE FROM '+table+' WHERE project_id=$1',[projectId]);
  if((await client.query('DELETE FROM project WHERE id=$1 AND workspace_id=$2',[projectId,workspaceId])).rowCount!==1)throw missing();
  const at=(await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at")).rows[0].at;
  await client.query('INSERT INTO project_deletion_request(workspace_id,request_id,actor_id,project_id,input_hash,applied_revision,deleted_at)VALUES($1,$2,$3,$4,$5,$6,$7)',[workspaceId,input.requestId,userId,projectId,inputHash,input.revision,at]);
  return projectDeleteResult.parse({workspaceId,role,ack:{workspaceId,projectId,requestId:input.requestId,appliedRevision:input.revision,deletedAt:at},deleted:true,replayed:false});
 });
}
