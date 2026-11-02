import {providerRequestDiagnostic} from './providers.ts';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getBoss} from './jobs.ts';
import {reserveRequestInTransaction,requestHash} from './provider-requests.ts';
import {readKeywordAccount} from './dataforseo-keywords.ts';
import {parseKeywordRequest,type KeywordMarket,type KeywordRequest} from './keyword-research-input.ts';
import {parseSavedKeywordRefreshPreparation,parseSavedKeywordRefreshStart} from './saved-keyword-input.ts';
import {resolveSavedRefreshTargets,assertSavedRefreshTargets,markSavedRefreshAttempt,type SavedKeywordTarget} from './saved-keywords.ts';
import {withKeywordProject,keywordConnection,keywordCredentials,savedKeywordTargets,keywordQueue,recoverKeywordResearch} from './keyword-research.ts';
import type {WorkspaceRole} from '@ten98/runtime';

type Role=WorkspaceRole;
const writers=['owner','admin','editor'],readers=[...writers,'viewer'];
type RunStatus='queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'reconciled';
type RequestStatus='reserved'|'dispatched'|'uncertain'|'settled'|'cancelled';
type PlanStatus='prepared'|'expired'|'queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'partial';
export type SavedRefreshPreparationChild={preparationId:string;request:KeywordRequest;targetIds:string[]};
export type SavedRefreshPreparation={id:string;createdAt:string;expiresAt:string;connectionName:string;targetCount:number;children:SavedRefreshPreparationChild[]};
export type SavedRefreshChild=SavedRefreshPreparationChild&{runId:string|null;status:RunStatus|'prepared'|'expired';requestStatus:RequestStatus|null;diagnostic:string|null;resultExpired:boolean;canRecover:boolean};
export type SavedRefreshPlan=Omit<SavedRefreshPreparation,'children'>&{startedAt:string|null;status:PlanStatus;canCancel:boolean;children:SavedRefreshChild[]};

function invalid(message='Check the saved keyword refresh fields and try again.'):never {throw new FoundationError(400,message);}
function uuid(value:unknown):string {const result=z.uuid().safeParse(value);if(!result.success)invalid();return result.data.toLowerCase();}
function parse<T extends z.ZodType>(schema:T,input:unknown):z.output<T> {const result=schema.safeParse(input);if(!result.success)invalid();return result.data;}
const iso=(value:Date|string)=>new Date(value).toISOString();
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const childSelect=`SELECT q.*,r.id AS run_id,r.status AS run_status,r.diagnostic,r.result_purged_at,
 p.status AS request_status FROM keyword_quote q
 LEFT JOIN keyword_research_run r ON r.quote_id=q.id AND r.project_id=q.project_id AND r.workspace_id=q.workspace_id
 LEFT JOIN provider_request p ON p.id=r.id AND p.workspace_id=r.workspace_id`;

async function planRow(client:PoolClient,projectId:string,id:string) {
  const row=(await client.query('SELECT * FROM saved_keyword_refresh_plan WHERE project_id=$1 AND id=$2',[projectId,id])).rows[0];
  if(!row)throw new FoundationError(404,'Saved keyword refresh not found or unavailable.');return row;
}
async function childRows(client:PoolClient,plan:any) {
  return (await client.query(childSelect+' WHERE q.saved_refresh_plan_id=$1 AND q.project_id=$2 AND q.workspace_id=$3 ORDER BY q.created_at,q.id',[plan.id,plan.project_id,plan.workspace_id])).rows;
}
function quoteChild(row:any):SavedRefreshPreparationChild {
  return {preparationId:row.id,request:parseKeywordRequest(row.request),targetIds:row.saved_target_ids};
}
function quoteDto(row:any,children:any[]):SavedRefreshPreparation {
  return {id:row.id,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),connectionName:row.connection_name,targetCount:row.target_count,
    children:children.map(quoteChild)};
}
async function planDto(client:PoolClient,row:any,userId:string,role:string):Promise<SavedRefreshPlan> {
  const rows=await childRows(client,row),expired=row.request_version!==1||row.expires_at.getTime()<=Date.now();
  const children:SavedRefreshChild[]=rows.map(child=>({...quoteChild(child),runId:child.run_id??null,status:child.run_status??(expired?'expired':'prepared'),
    requestStatus:child.request_status??null,
    diagnostic:providerRequestDiagnostic(child.diagnostic),resultExpired:child.result_purged_at!=null,canRecover:role==='owner'&&child.run_status==='uncertain'&&child.request_status==='uncertain'}));
  let status:PlanStatus=row.started_at?'partial':expired?'expired':'prepared';
  if(row.started_at) {
    if(children.some(c=>c.status==='uncertain'))status='uncertain';
    else if(children.some(c=>c.status==='running'))status='running';
    else if(children.some(c=>c.status==='queued'))status='queued';
    else if(children.length&&children.every(c=>c.status==='completed'))status='completed';
    else if(children.length&&children.every(c=>c.status==='cancelled'))status='cancelled';
    else if(children.length&&children.every(c=>c.status==='failed'||c.status==='reconciled'))status='failed';
  }
  return {...quoteDto(row,rows),startedAt:row.started_at?iso(row.started_at):null,status,
    canCancel:writers.includes(role)&&(row.user_id===userId||role==='owner')&&children.some(c=>c.status==='queued'&&c.requestStatus==='reserved'),children};
}
function chunks(targets:SavedKeywordTarget[]) {
  if(!targets.length)throw new FoundationError(409,'Choose at least one saved keyword.');
  if(targets.length>2000)throw new FoundationError(413,'Choose at most 2,000 keywords for one refresh.');
  if(targets.some(target=>!target.eligible))throw new FoundationError(409,'Exclude keywords marked unavailable for refresh before preparing a request.');
  const groups:SavedKeywordTarget[][]=[];
  for(const target of [...targets].sort((a,b)=>a.locationCode-b.locationCode||compare(a.languageCode,b.languageCode)||compare(a.keyword,b.keyword)||compare(a.id,b.id))) {
    const last=groups.at(-1);
    if(!last||last.length===100||last[0].locationCode!==target.locationCode||last[0].languageCode!==target.languageCode)groups.push([target]);else last.push(target);
  }
  if(groups.length>20)throw new FoundationError(413,'Choose fewer keywords or markets: one refresh can approve at most 20 batches.');
  return groups;
}
async function checkMarkets(client:PoolClient,workspaceId:string,groups:SavedKeywordTarget[][]) {
  const catalog=(await client.query("SELECT markets FROM keyword_market_catalog WHERE workspace_id=$1 AND updated_at>clock_timestamp()-interval '7 days'",[workspaceId])).rows[0];
  if(!catalog||groups.some(group=>!(catalog.markets as KeywordMarket[]).some(m=>m.locationCode===group[0].locationCode&&m.languageCode===group[0].languageCode)))throw new FoundationError(409,'Refresh the supported markets before preparing this request.');
}

export async function prepareSavedKeywordRefresh(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch):Promise<{role:Role;preparation:SavedRefreshPreparation}> {
  const input=parseSavedKeywordRefreshPreparation(raw);
  const saved=await withKeywordProject(projectId,userId,writers,async(client,wid)=>{
    const selected=await resolveSavedRefreshTargets(client,projectId,input.selection),groups=chunks(selected.targets);
    await checkMarkets(client,wid,groups);const connection=await keywordConnection(client,wid,input.connectionId);
    return {groups,revision:connection.revision,credentials:keywordCredentials(connection)};
  });
  const account=await readKeywordAccount(saved.credentials,undefined,send);
  return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
    const connection=await keywordConnection(client,wid,input.connectionId,saved.revision);
    await assertSavedRefreshTargets(client,projectId,saved.groups.flat());await checkMarkets(client,wid,saved.groups);
    const plan=(await client.query(`INSERT INTO saved_keyword_refresh_plan(id,workspace_id,project_id,user_id,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,connection_name,target_count,request_version,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,1,clock_timestamp()+interval '5 minutes') RETURNING *`,
      [randomUUID(),wid,projectId,userId,input.connectionId,saved.revision,account.fingerprint,connection.name,saved.groups.flat().length])).rows[0];
    for(const group of saved.groups) {
      const request=parseKeywordRequest({connectionId:input.connectionId,mode:'overview',keywords:group.map(target=>target.keyword),locationCode:group[0].locationCode,languageCode:group[0].languageCode,limit:100});
      await client.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,account_fingerprint_version,request_version,expires_at,saved_refresh_plan_id,saved_target_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,1,$9,$10,$11)`,
        [randomUUID(),wid,projectId,userId,input.connectionId,saved.revision,JSON.stringify(request),account.fingerprint,plan.expires_at,plan.id,group.map(target=>target.id)]);
    }
    return {role:role as Role,preparation:quoteDto(plan,await childRows(client,plan))};
  });
}
export async function listSavedKeywordRefreshes(projectId:string,userId:string):Promise<{role:Role;plans:SavedRefreshPlan[]}> {
  return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>{
    const rows=(await client.query('SELECT * FROM saved_keyword_refresh_plan WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[projectId])).rows;
    const plans:SavedRefreshPlan[]=[];for(const row of rows)plans.push(await planDto(client,row,userId,role));return {role:role as Role,plans};
  });
}
export async function getSavedKeywordRefresh(projectId:string,userId:string,id:string):Promise<{role:Role;plan:SavedRefreshPlan}> {
  id=uuid(id);return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>({role:role as Role,plan:await planDto(client,await planRow(client,projectId,id),userId,role)}));
}
export async function startSavedKeywordRefresh(projectId:string,userId:string,raw:unknown):Promise<{role:Role;plan:SavedRefreshPlan}> {
  const {preparationId:quoteId,requestKey}=parseSavedKeywordRefreshStart(raw),boss=await getBoss();
  return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
    // Check the durable receipt first: an uncertain acknowledgement never becomes a new
    // request merely because its old preparation expired or a captured keyword was removed.
    const prior=(await client.query('SELECT * FROM saved_keyword_refresh_plan WHERE workspace_id=$1 AND request_key=$2',[wid,requestKey])).rows[0];
    if(prior) {
      if(prior.id!==quoteId||prior.project_id!==projectId||prior.user_id!==userId)throw new FoundationError(409,'This request key already identifies a different refresh.');
      return {role:role as Role,plan:await planDto(client,prior,userId,role)};
    }
    const plan=await planRow(client,projectId,quoteId);
    if(plan.user_id!==userId)throw new FoundationError(404,'Refresh preparation not found or unavailable.');
    if(plan.started_at)throw new FoundationError(409,'This refresh already started. Open its saved receipt.');
    if(plan.request_version!==1||plan.expires_at.getTime()<=Date.now())throw new FoundationError(409,'The preparation expired. Prepare it again.');
    await keywordConnection(client,wid,plan.connection_id,plan.connection_revision);
    const children=await childRows(client,plan);
    if(!children.length||children.length>20||children.some(child=>child.request_version!==1||child.run_id||child.expires_at.getTime()<=Date.now()||child.account_fingerprint!==plan.account_fingerprint||child.account_fingerprint_version!==plan.account_fingerprint_version||child.connection_id!==plan.connection_id||child.connection_revision!==plan.connection_revision))throw new FoundationError(409,'The refresh preparation changed. Prepare it again.');
    const targets=children.flatMap(savedKeywordTargets);
    if(targets.length!==plan.target_count||new Set(targets.map(target=>target.id)).size!==targets.length)throw new FoundationError(409,'The refresh targets changed. Prepare the request again.');
    await assertSavedRefreshTargets(client,projectId,targets);
    for(const child of children) {
      const request=parseKeywordRequest(child.request);
      const reservation=await reserveRequestInTransaction(client,wid,userId,{connectionId:plan.connection_id,requestKey:child.id,operation:'keyword.overview',
        inputHash:requestHash(JSON.stringify({planId:plan.id,quoteId:child.id,request,targetIds:child.saved_target_ids}))},async(tx,id)=>{
        await tx.query("INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[id,wid,projectId,userId,child.id]);
        // Two bounded 30-second requests (account identity check, then research) fit inside
        // this child deadline. Start authorizes each child; its 90 s job bounds execution, not preparation age.
        if(!await boss.send(keywordQueue,{runId:id},{id,retryLimit:0,expireInSeconds:90,db:{executeSql:(text,values)=>tx.query(text,values)}}))throw new Error('Saved keyword refresh could not be queued.');
      });
      if(!reservation.created)throw new FoundationError(409,'A child request already identifies different work. Prepare the request again.');
    }
    const started=(await client.query('UPDATE saved_keyword_refresh_plan SET started_at=clock_timestamp(),request_key=$2 WHERE id=$1 RETURNING *',[plan.id,requestKey])).rows[0];
    await markSavedRefreshAttempt(client,projectId,targets,String(plan.version),'queued',started.started_at);
    return {role:role as Role,plan:await planDto(client,started,userId,role)};
  });
}
export async function cancelSavedKeywordRefresh(projectId:string,userId:string,id:string,raw:unknown):Promise<{role:Role;plan:SavedRefreshPlan}> {
  id=uuid(id);parse(z.object({}).strict(),raw);
  return withKeywordProject(projectId,userId,writers,async(client,_wid,role)=>{
    const plan=await planRow(client,projectId,id),children=await childRows(client,plan);
    if(plan.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can cancel this refresh.');
    const queued=children.filter(child=>child.run_status==='queued'&&child.request_status==='reserved');
    if(!queued.length)throw new FoundationError(409,'This refresh has no undispatched requests to cancel.');
    for(const child of queued) {
      await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[child.run_id]);
      const cancelled=(await client.query("UPDATE keyword_research_run SET status='cancelled',diagnostic='Cancelled before dispatch.',completed_at=clock_timestamp() WHERE id=$1 AND status='queued' RETURNING completed_at",[child.run_id])).rows[0];
      await markSavedRefreshAttempt(client,projectId,savedKeywordTargets(child),String(plan.version),'cancelled',cancelled.completed_at);
    }
    return {role:role as Role,plan:await planDto(client,plan,userId,role)};
  });
}
export async function recoverSavedKeywordRefresh(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch) {
  id=uuid(id);const input=parse(z.object({runId:z.uuid(),connectionId:z.uuid()}).strict(),raw);
  await withKeywordProject(projectId,userId,['owner'],async(client)=>{
    const plan=await planRow(client,projectId,id);
    if(!(await childRows(client,plan)).some(child=>child.run_id===input.runId))throw new FoundationError(404,'Refresh request not found or unavailable.');
  });
  const result=await recoverKeywordResearch(projectId,userId,input.runId,{connectionId:input.connectionId},send);
  return {...await getSavedKeywordRefresh(projectId,userId,id),recovery:result.recovery};
}
