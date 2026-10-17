import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt,contentCursor,readContentCursor} from './project-context.ts';
import {usd,usdMicros} from './providers.ts';
import {executionInput,type ExecutionInput,type RouteSnapshot} from './openrouter-input.ts';
import {cachedOpenRouterModels} from './openrouter-models.ts';
import {withPromptProject,promptConnection,quotePromptExecution,startPromptExecution,cancelPromptChildren} from './prompt-execution.ts';
import {createPromptTrackerInput,approvePromptTrackerInput,changePromptTrackerInput,promptCalendar,promptTrackerStatus,type PromptCalendar} from '../lib/prompt-recurring.ts';
import type {z} from 'zod';
import type {promptTrackerAck} from '../lib/prompt-recurring.ts';

const readers=['owner','admin','editor','viewer'],dueText=`to_char(next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type Due={id:string;workspace_id:string;project_id:string;approval_id:string;due_at:string};
const deny=():never=>{throw new FoundationError(409,'The recurring approval changed or is disabled. Review a fresh quote and explicitly approve again.');};
const iso=(value:Date|null)=>value?.toISOString()??null;
function inputOf(raw:unknown):ExecutionInput{const result=executionInput.safeParse(raw);if(!result.success||result.data.reuseCached!==false)throw new FoundationError(409,'Recurring tracking requires an exact fresh-answer quote. Saved answers cannot be reused.');return result.data;}
/** Prices are observed per occurrence; the approved model/serving definition stays fixed. */
export function promptModelDefinition(input:ExecutionInput,routes:RouteSnapshot[]){
 const catalog=cachedOpenRouterModels();if(catalog.status!=='fresh'||routes.length!==input.models.length)deny();
 return canonicalHash(routes.map((route,i)=>{const model=catalog.models.find(m=>m.id===input.models[i]&&m.admission==='candidate');if(!model||route.model!==model.id)return deny();return {id:model.id,canonicalSlug:model.canonicalSlug,contextLength:model.contextLength,maxCompletionTokens:model.maxCompletionTokens,profile:route.profile,tag:route.tag,providerName:route.providerName};}));
}
async function tracker(client:PoolClient,projectId:string,id:string){const row=(await client.query(`SELECT *,${dueText} AS due_at FROM prompt_tracker WHERE id=$1 AND project_id=$2 FOR UPDATE`,[id,projectId])).rows[0];if(!row)throw new FoundationError(404,'Prompt tracker not found or unavailable.');return row;}
async function zone(client:PoolClient,calendar:PromptCalendar){if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[calendar.timezone])).rowCount)throw new FoundationError(400,'Choose a supported IANA/PostgreSQL time zone.');}
async function quote(client:PoolClient,projectId:string,userId:string,id:string){
 const q=(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT q.*,q.expires_at>read_clock.at AS current FROM prompt_execution_quote q CROSS JOIN read_clock WHERE q.id=$1 AND q.project_id=$2 AND q.user_id=$3`,[id,projectId,userId])).rows[0];
 if(!q)throw new FoundationError(404,'Quote not found or unavailable.');if(!q.current||q.recurring_occurrence_id||!q.input||q.input_purged_at||(await client.query('SELECT 1 FROM prompt_comparison WHERE quote_id=$1',[id])).rowCount)throw new FoundationError(409,'Prepare a fresh unused quote before approving recurring work.');
 const input=inputOf(q.input);await promptConnection(client,q.workspace_id,input.connectionId,q.connection_revision);return {q,input,modelsHash:promptModelDefinition(input,q.routes),estimate:(q.routes as RouteSnapshot[]).reduce((sum,r)=>sum+BigInt(r.estimateMicros),0n)};
}
function revision(row:any,value:number){if(row.revision!==value||row.revision>=2147483646)throw new FoundationError(409,'This tracker changed. Reload it before making another change.');}
async function dto(client:PoolClient,row:any){
 const occurrences=(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at) SELECT o.id,to_char(o.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "scheduledFor",o.trigger,o.status,o.quote_id AS "quoteId",o.comparison_id AS "comparisonId",o.reason FROM prompt_occurrence o JOIN workspace w ON w.id=o.workspace_id CROSS JOIN read_clock WHERE o.tracker_id=$1 AND o.created_at>=read_clock.at-w.derived_history_days*interval '24 hours' ORDER BY o.scheduled_for DESC,o.id DESC LIMIT 10`,[row.id])).rows;
 const input=inputOf(row.input);return {id:row.id,createdRequestId:row.created_request_id,name:row.name,revision:row.revision,enabled:row.enabled,archivedAt:iso(row.archived_at),calendar:row.calendar,maximumUsd:usd(row.maximum_micros),nextDueAt:iso(row.next_due_at),definition:{promptId:input.promptId,versionId:input.versionId,models:input.models,systemText:input.systemText,maxCompletionTokens:input.maxCompletionTokens},approval:row.approval_id?{id:row.approval_id,userId:row.approval_user_id,approvedAt:iso(row.approved_at),connectionId:input.connectionId,connectionRevision:row.approval_connection_revision}:null,lastStatus:row.last_status,occurrences};
}
function bounded<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value))>2097152)throw new FoundationError(413,'The complete tracker response is too large.');return value;}
async function response(client:PoolClient,projectId:string,role:string,ack:z.infer<typeof promptTrackerAck>){return bounded({projectId,role,item:await dto(client,await tracker(client,projectId,ack.trackerId)),ack});}
export async function getPromptTrackers(projectId:string,userId:string,params=new URLSearchParams()){
 for(const key of params.keys())if(!['status','cursor'].includes(key)||params.getAll(key).length!==1)throw new FoundationError(400,'Use each supported tracker filter once.');
 const status=parse(promptTrackerStatus,params.get('status')??'active'),scope={projectId,list:'prompt-trackers',status},cursor=readContentCursor(params.get('cursor'),scope);
 return withPromptProject(projectId,userId,readers,async(client,_wid,role)=>{
  // The reused cursor encodes milliseconds; resolve its retained native anchor
  // instead of comparing a rounded JavaScript timestamp and skipping tied rows.
  if(cursor){const anchor=(await client.query('SELECT created_at FROM prompt_tracker WHERE project_id=$1 AND id=$2',[projectId,cursor.id])).rows[0];if(!anchor||anchor.created_at.toISOString()!==cursor.at)throw new FoundationError(400,'Reload this tracker list before loading another page.');}
  const rows=(await client.query(`SELECT t.* FROM prompt_tracker t WHERE t.project_id=$1
   AND ($2='all' OR ($2='active' AND t.archived_at IS NULL) OR ($2='archived' AND t.archived_at IS NOT NULL))
   AND ($3::uuid IS NULL OR (t.created_at,t.id)<(SELECT a.created_at,a.id FROM prompt_tracker a WHERE a.project_id=$1 AND a.id=$3))
   ORDER BY t.created_at DESC,t.id DESC LIMIT 21`,[projectId,status,cursor?.id??null])).rows;
  const items=[];for(const row of rows.slice(0,20))items.push(await dto(client,row));
  return bounded({projectId,role,status,items,nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null});
 });
}
export async function getPromptTracker(projectId:string,userId:string,id:string){return withPromptProject(projectId,userId,readers,async(client,_wid,role)=>bounded({projectId,role,item:await dto(client,await tracker(client,projectId,id))}));}
async function approve(client:PoolClient,row:any,userId:string,q:any,modelsHash:string,calendar:PromptCalendar,maximum:string){
 if(row.archived_at)throw new FoundationError(409,'Restore this tracker before approving a fresh quote.');await zone(client,calendar);if(canonicalHash(inputOf(q.input))!==row.definition_hash)throw new FoundationError(409,'This quote belongs to a different immutable prompt/model/system/output definition.');
 const estimate=(q.routes as RouteSnapshot[]).reduce((sum,r)=>sum+BigInt(r.estimateMicros),0n);if(estimate===0n||estimate>usdMicros(maximum))throw new FoundationError(400,'The per-occurrence ceiling must cover every quoted model request.');
 await client.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) UPDATE prompt_tracker SET calendar=$2,maximum_micros=$3,enabled=true,next_due_at=rank_next_due($4,$5,$6,$7,$8,(SELECT at FROM tick)),approval_id=$9,approval_user_id=$10,approval_connection_revision=$11,approval_key_fingerprint=$12,approval_models_hash=$13,approved_at=(SELECT at FROM tick),revision=revision+1,last_status=NULL,updated_at=(SELECT at FROM tick) WHERE id=$1 AND $14::timestamptz>(SELECT at FROM tick)`,[row.id,JSON.stringify(calendar),usdMicros(maximum).toString(),calendar.interval,calendar.timezone,calendar.hour,calendar.minute,calendar.weekday,randomUUID(),userId,q.connection_revision,q.key_fingerprint,modelsHash,q.expires_at]).then(result=>{if(result.rowCount!==1)throw new FoundationError(409,'This quote expired before approval. Review a new quote.');});
}
export async function createPromptTracker(projectId:string,userId:string,raw:unknown){
 const input=parse(createPromptTrackerInput,raw);return withPromptProject(projectId,userId,['owner'],async(client,wid,role)=>{
  const receipt=await contentReceipt(client,projectId,input.requestId,'prompt.tracker.create',{userId,...input});if(receipt.replayed)return response(client,projectId,role,{requestId:input.requestId,trackerId:receipt.result.id,action:'create',quoteId:input.quoteId,occurrenceId:null});
  const saved=await quote(client,projectId,userId,input.quoteId);await zone(client,input.calendar);if(saved.estimate>usdMicros(input.maximumUsd))throw new FoundationError(400,'The ceiling must cover the full fresh quote.');
  const id=randomUUID();await client.query('INSERT INTO prompt_tracker(id,workspace_id,project_id,created_request_id,name,input,definition_hash,calendar,maximum_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,wid,projectId,input.requestId,input.name,JSON.stringify(saved.input),canonicalHash(saved.input),JSON.stringify(input.calendar),usdMicros(input.maximumUsd).toString()]);
  if(input.approve)await approve(client,await tracker(client,projectId,id),userId,saved.q,saved.modelsHash,input.calendar,input.maximumUsd);await receipt.save({id});return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'create',quoteId:input.quoteId,occurrenceId:null});
 });
}
export async function approvePromptTracker(projectId:string,userId:string,id:string,raw:unknown){
 const input=parse(approvePromptTrackerInput,raw);return withPromptProject(projectId,userId,['owner'],async(client,_wid,role)=>{const receipt=await contentReceipt(client,projectId,input.requestId,'prompt.tracker.approve:'+id,{userId,...input}),row=await tracker(client,projectId,id);if(receipt.replayed)return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'approve',quoteId:input.quoteId,occurrenceId:null});revision(row,input.revision);const saved=await quote(client,projectId,userId,input.quoteId);await approve(client,row,userId,saved.q,saved.modelsHash,input.calendar,input.maximumUsd);await receipt.save({id});return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'approve',quoteId:input.quoteId,occurrenceId:null});});
}
export async function pausePromptTracker(projectId:string,userId:string,id:string,raw:unknown){
 const input=parse(changePromptTrackerInput,raw);return withPromptProject(projectId,userId,['owner'],async(client,_wid,role)=>{const receipt=await contentReceipt(client,projectId,input.requestId,'prompt.tracker.pause:'+id,{userId,...input}),row=await tracker(client,projectId,id);if(receipt.replayed)return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'pause',quoteId:null,occurrenceId:null});if(row.revision!==input.revision)throw new FoundationError(409,'This tracker changed. Reload before pausing.');await client.query("UPDATE prompt_tracker SET enabled=false,next_due_at=NULL,revision=LEAST(revision+1,2147483646),last_status='Paused by an owner.',updated_at=clock_timestamp() WHERE id=$1",[id]);await cancelUndispatched(client,id);await receipt.save({id});return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'pause',quoteId:null,occurrenceId:null});});
}
async function cancelUndispatched(client:PoolClient,id:string){for(const c of(await client.query("UPDATE prompt_comparison c SET cancel_requested=true FROM (SELECT DISTINCT r.comparison_id FROM prompt_execution r JOIN prompt_occurrence o ON o.comparison_id=r.comparison_id WHERE r.status='queued' AND o.tracker_id=$1) pending WHERE c.id=pending.comparison_id RETURNING c.id",[id])).rows)await cancelPromptChildren(client,c.id,'Recurring tracking paused or archived before dispatch. Already sent requests may still be charged.');}
export async function setPromptTrackerArchived(projectId:string,userId:string,id:string,archived:boolean,raw:unknown){
 const input=parse(changePromptTrackerInput,raw),action=archived?'archive':'restore';return withPromptProject(projectId,userId,['owner'],async(client,_wid,role)=>{
  const receipt=await contentReceipt(client,projectId,input.requestId,'prompt.tracker.'+action+':'+id,{userId,...input}),row=await tracker(client,projectId,id);
  if(receipt.replayed)return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action,quoteId:null,occurrenceId:null});
  revision(row,input.revision);
  if((row.archived_at!==null)===archived)throw new FoundationError(409,archived?'This tracker is already archived.':'This tracker is not archived.');
  await client.query(`UPDATE prompt_tracker SET archived_at=${archived?'clock_timestamp()':'NULL'},enabled=false,next_due_at=NULL,approval_id=NULL,approval_user_id=NULL,approval_connection_revision=NULL,approval_key_fingerprint=NULL,approval_models_hash=NULL,approved_at=NULL,revision=LEAST(revision+1,2147483646),last_status=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,archived?'Archived by an owner. Already incurred charges remain available for reconciliation.':'Restored without spending approval. Review a fresh quote to enable tracking.']);
  await cancelUndispatched(client,id);await receipt.save({id});return response(client,projectId,role,{requestId:input.requestId,trackerId:id,action,quoteId:null,occurrenceId:null});
 });
}
/** W -> P -> tracker. A stopped grant never prevents settling an incurred charge. */
export async function assertPromptRecurringAuthority(client:PoolClient,quoteId:string,freshModels=false){
 const q=(await client.query('SELECT * FROM prompt_execution_quote WHERE id=$1',[quoteId])).rows[0];if(!q?.recurring_occurrence_id)return;
 const o=(await client.query('SELECT * FROM prompt_occurrence WHERE id=$1 AND quote_id=$2',[q.recurring_occurrence_id,q.id])).rows[0];if(!o)deny();const row=await tracker(client,q.project_id,o.tracker_id);
 if(row.archived_at||!row.enabled||!row.approval_id||row.approval_id!==o.approval_id||row.definition_hash!==o.definition_hash||canonicalHash(inputOf(q.input))!==row.definition_hash||q.user_id!==row.approval_user_id||q.connection_revision!==row.approval_connection_revision||q.key_fingerprint!==row.approval_key_fingerprint||q.recurring_models_hash!==row.approval_models_hash||!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[q.workspace_id,q.user_id])).rowCount)deny();
 await promptConnection(client,q.workspace_id,q.connection_id,row.approval_connection_revision);
 if(!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[q.workspace_id,o.requested_by])).rowCount)deny();
 if(freshModels&&promptModelDefinition(inputOf(q.input),q.routes)!==row.approval_models_hash)deny();
 // Owner decision D3: quote age is checked at Start alone (startPromptExecution); a started child is never refused for it.
}
async function transaction<T>(id:string,work:(client:PoolClient,row:any)=>Promise<T>){
 const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");const scope=(await client.query('SELECT workspace_id,project_id FROM prompt_tracker WHERE id=$1',[id])).rows[0];if(!scope)throw new FoundationError(404,'Prompt tracker not found or unavailable.');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[scope.workspace_id]);await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[scope.project_id,scope.workspace_id]);const value=await work(client,await tracker(client,scope.project_id,id));await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function current(client:PoolClient,row:any){
 if(row.archived_at||!row.enabled||!row.approval_id||canonicalHash(inputOf(row.input))!==row.definition_hash||!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,row.approval_user_id])).rowCount)deny();const connection=await promptConnection(client,row.workspace_id,row.input.connectionId,row.approval_connection_revision);return connection;
}
async function active(client:PoolClient,id:string){return !!(await client.query("SELECT 1 FROM prompt_occurrence o WHERE o.tracker_id=$1 AND (o.status='quoted' OR EXISTS(SELECT 1 FROM prompt_execution r WHERE r.comparison_id=o.comparison_id AND r.status IN('queued','running','uncertain')))",[id])).rowCount;}
async function advance(client:PoolClient,row:any,message:string|null){const c=parse(promptCalendar,row.calendar);await client.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) UPDATE prompt_tracker SET next_due_at=rank_next_due($2,$3,$4,$5,$6,(SELECT at FROM tick)),last_status=$7,updated_at=(SELECT at FROM tick) WHERE id=$1`,[row.id,c.interval,c.timezone,c.hour,c.minute,c.weekday,message]);}
/** Preparation is a real restart checkpoint: no reservation or paid call is made here. */
export async function preparePromptOccurrence(due:Due,trigger:'calendar'|'now'='calendar',requestKey:string=randomUUID(),send:typeof fetch=fetch,manual?:{userId:string;input:{requestId:string;revision:number}}){
 const saved=await transaction(due.id,async(client,row)=>{await current(client,row);if(row.approval_id!==due.approval_id||trigger==='calendar'&&row.due_at!==due.due_at)deny();if(await active(client,row.id))throw new FoundationError(409,'An earlier occurrence is still active.');return {project:row.project_id,user:row.approval_user_id,input:inputOf(row.input)};});
 let occurrenceId='';await quotePromptExecution(saved.project,saved.user,saved.input,send,{checkpoint:async(client,quoteId)=>{
  const row=await tracker(client,saved.project,due.id);await current(client,row);if(row.approval_id!==due.approval_id||trigger==='calendar'&&row.due_at!==due.due_at||await active(client,row.id))deny();
  const receipt=manual?await contentReceipt(client,saved.project,manual.input.requestId,'prompt.tracker.run:'+due.id,{userId:manual.userId,...manual.input}):null;
  if(manual&&(!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,manual.userId])).rowCount||receipt?.replayed))deny();
  const q=(await client.query('SELECT * FROM prompt_execution_quote WHERE id=$1',[quoteId])).rows[0],modelsHash=promptModelDefinition(saved.input,q.routes),maximum=(q.routes as RouteSnapshot[]).reduce((sum,r)=>sum+BigInt(r.estimateMicros),0n);
  if(q.connection_revision!==row.approval_connection_revision||q.key_fingerprint!==row.approval_key_fingerprint||modelsHash!==row.approval_models_hash)deny();if(maximum>BigInt(row.maximum_micros))throw new FoundationError(409,'The fresh quote exceeds this tracker’s standing per-occurrence ceiling.');
  occurrenceId=randomUUID();await client.query("INSERT INTO prompt_occurrence(id,tracker_id,workspace_id,project_id,user_id,requested_by,approval_id,definition_hash,scheduled_for,trigger,request_key,quote_id,status) VALUES($1,$2,$3,$4,$5,$12,$6,$7,$8,$9,$10,$11,'quoted')",[occurrenceId,row.id,row.workspace_id,row.project_id,saved.user,row.approval_id,row.definition_hash,due.due_at,trigger,requestKey,quoteId,manual?.userId??saved.user]);
  await client.query('UPDATE prompt_execution_quote SET recurring_occurrence_id=$2,recurring_models_hash=$3 WHERE id=$1',[quoteId,occurrenceId,modelsHash]);await advance(client,row,null);
  if(receipt)await receipt.save({id:occurrenceId});
 }});return occurrenceId;
}
export async function resumePromptOccurrence(id:string):Promise<{status:'started'|'skipped'|'quoted';comparisonId?:string}>{
 const o=(await getDatabase().pool.query('SELECT * FROM prompt_occurrence WHERE id=$1',[id])).rows[0];if(!o)throw new FoundationError(404,'Occurrence not found.');
 // An acknowledged or lost-ACK Start is recovered before testing quote age.
 if(o.comparison_id)return {status:'started',comparisonId:o.comparison_id};if(o.status!=='quoted')return {status:o.status};
 try{const saved=await startPromptExecution(o.project_id,o.user_id,{quoteId:o.quote_id,requestKey:o.request_key});return {status:'started',comparisonId:saved.comparison.id};}
 catch(error){if(!(error instanceof FoundationError))throw error;return transaction(o.tracker_id,async(client)=>{const live=(await client.query('SELECT * FROM prompt_occurrence WHERE id=$1 FOR UPDATE',[id])).rows[0];if(live.comparison_id)return {status:'started',comparisonId:live.comparison_id};await client.query("UPDATE prompt_occurrence SET status='skipped',reason='Not started: authorization, quote age, or spending controls require owner review.' WHERE id=$1 AND status='quoted'",[id]);return {status:'skipped'};});}
}
export async function runPromptTrackerNow(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(changePromptTrackerInput,raw),saved=await withPromptProject(projectId,userId,['owner'],async(client)=>{const row=await tracker(client,projectId,id),receipt=await contentReceipt(client,projectId,input.requestId,'prompt.tracker.run:'+id,{userId,...input});if(receipt.replayed)return {prior:receipt.result.id as string};if(row.revision!==input.revision)throw new FoundationError(409,'This tracker changed. Reload before running.');await current(client,row);return {due:{id,workspace_id:row.workspace_id,project_id:projectId,approval_id:row.approval_id,due_at:(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at} as Due};});
 let occurrenceId=saved.prior;
 if(!occurrenceId)try{occurrenceId=await preparePromptOccurrence(saved.due!,'now',input.requestId,send,{userId,input});}catch(error){if(!(error instanceof FoundationError))throw error;const recovered=await withPromptProject(projectId,userId,['owner'],async client=>contentReceipt(client,projectId,input.requestId,'prompt.tracker.run:'+id,{userId,...input}));if(!recovered.replayed)throw error;occurrenceId=recovered.result.id as string;}
 // A pruned nonfinancial occurrence leaves its durable request receipt: never recreate it.
 if((await getDatabase().pool.query('SELECT 1 FROM prompt_occurrence WHERE id=$1',[occurrenceId])).rowCount)await resumePromptOccurrence(occurrenceId);return withPromptProject(projectId,userId,['owner'],(client,_wid,role)=>response(client,projectId,role,{requestId:input.requestId,trackerId:id,action:'run',quoteId:null,occurrenceId:occurrenceId!}));
}
export async function claimDuePromptOccurrence(send:typeof fetch=fetch){
 const pending=(await getDatabase().pool.query("SELECT id FROM prompt_occurrence WHERE status='quoted' ORDER BY created_at,id LIMIT 1")).rows[0];if(pending)return resumePromptOccurrence(pending.id);
 const due=(await getDatabase().pool.query<Due>(`SELECT id,workspace_id,project_id,approval_id,${dueText} AS due_at FROM prompt_tracker WHERE enabled AND archived_at IS NULL AND next_due_at<=clock_timestamp() ORDER BY next_due_at,id LIMIT 1`)).rows[0];if(!due)return {status:'idle'};
 try{return resumePromptOccurrence(await preparePromptOccurrence(due,'calendar',undefined,send));}
 catch(error){if(!(error instanceof FoundationError))throw error;return transaction(due.id,async(client,row)=>{if(!row.enabled||row.approval_id!==due.approval_id||row.due_at!==due.due_at)return {status:'superseded'};const reason='Skipped: current approval, provider metadata, prices, overlap or spending controls require review.';await client.query("INSERT INTO prompt_occurrence(id,tracker_id,workspace_id,project_id,user_id,requested_by,approval_id,definition_hash,scheduled_for,trigger,request_key,status,reason) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'calendar',$9,'skipped',$10) ON CONFLICT(tracker_id,scheduled_for) DO NOTHING",[randomUUID(),row.id,row.workspace_id,row.project_id,row.approval_user_id,row.approval_id,row.definition_hash,due.due_at,randomUUID(),reason]);await advance(client,row,reason);return {status:'skipped'};});}
}
