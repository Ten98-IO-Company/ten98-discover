import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash,contextOp,parse,revision} from './context-input.ts';
import {applyProjectContextUpdates,contentCursor,contentProfile,contentReceipt,readContentCursor,withContentProject,type ContentProject} from './project-context.ts';
import {cancelSiteAuditInTransaction,queueSiteAuditInTransaction,readSiteAnalysisPages,withAuditLock,type AuditLock,type AuditRunRow} from './site-audits.ts';
import {markSiteAuditReadExpiry} from './site-audit-retention.ts';
import {reserveRequestInTransaction} from './provider-requests.ts';
import {providerRequestDiagnostic} from './providers.ts';
import {executionActor,executionRequestBody,keyFingerprint,readAnalysisRoute} from './openrouter.ts';
import {suggestionConnection,suggestionCredentials,suggestionQueue,suggestionSelect,suggestionWorkspace} from './ai-suggestions.ts';
import {recoverSuggestionRequest} from './ai-suggestion-worker.ts';
import {analysisMessages,analysisOutputTokens,analysisPurpose,analysisStartInput,assertAnalysisSnapshot,type AnalysisProposal,type AnalysisSnapshot,type AnalysisStartInput} from './site-analysis-input.ts';

type Identified<T>=T&{id:string};
export type SiteAnalysisProposal=Omit<AnalysisProposal,'brand'|'competitors'|'pages'|'personas'>&{
 brand:Identified<NonNullable<AnalysisProposal['brand']>>|null;
 competitors:Identified<AnalysisProposal['competitors'][number]>[];
 pages:Identified<AnalysisProposal['pages'][number]>[];
 personas:Identified<AnalysisProposal['personas'][number]>[];
};
type AnalysisRow={id:string;workspace_id:string;project_id:string;user_id:string;request_id:string;request_hash:string;
 connection_id:string;connection_revision:number;key_fingerprint:string;model:string;origin:string;context_revision:number;
 audit_id:string|null;child_request_id:string;ai_run_id:string|null;status:'crawling'|'analysing'|'failed'|'cancelled';diagnostic:string|null;
 proposal_revision:number;accepted_candidate_ids:string[];created_at:Date;completed_at:Date|null};
const unavailable=()=>new FoundationError(404,'Website analysis not found or unavailable.');
const actionInput=z.object({requestId:z.uuid()}).strict();
const acceptInput=z.object({requestId:z.uuid(),expectedContextRevision:revision,expectedProposalRevision:revision,
 selections:z.array(z.object({candidateId:z.uuid(),updates:z.array(contextOp).min(1).max(2)}).strict()).min(1).max(21)
 .refine(rows=>new Set(rows.map(row=>row.candidateId)).size===rows.length)}).strict();
function owner(p:ContentProject){if(p.role!=='owner')throw new FoundationError(403,'Only a workspace owner can run website analysis.');}
async function parentRow(client:PoolClient,projectId:string,id:string){
 const row=(await client.query<AnalysisRow>('SELECT * FROM site_analysis_run WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];if(!row)throw unavailable();return row;
}
async function childRow(client:PoolClient,row:AnalysisRow){
 return row.ai_run_id?(await client.query(suggestionSelect+" WHERE r.id=$1 AND r.project_id=$2 AND r.purpose='site-analysis'",[row.ai_run_id,row.project_id])).rows[0]:null;
}
async function analysisDto(client:PoolClient,p:ContentProject,row:AnalysisRow,details=true){
 const child=await childRow(client,row),expired=!!child&&(child.input_expired||child.result_expired);
 const proposal=child&&!expired?child.proposal as SiteAnalysisProposal|null:null;
 const snapshot=child&&!child.input_expired?child.snapshot as AnalysisSnapshot:null;
 const status=child?child.status:row.status==='analysing'?'unavailable':row.status;
 return {id:row.id,status,model:row.model,auditId:row.audit_id,requestStatus:child?.request_status??null,
  createdAt:row.created_at,completedAt:child?.completed_at??row.completed_at,contextRevision:row.context_revision,
  proposalRevision:row.proposal_revision,acceptedCandidateIds:row.accepted_candidate_ids,
  resultExpired:expired,proposalStatus:expired?'expired':proposal?'available':'unavailable',
  diagnostic:child?.request_status==='uncertain'?'The original request outcome is unknown. Check the original request; it will not be sent again.':providerRequestDiagnostic(child?.diagnostic??row.diagnostic),
  canCancel:p.role==='owner'&&(row.status==='crawling'||child?.request_status==='reserved'),
  canRecover:p.role==='owner'&&child?.request_status==='uncertain'&&!!child?.generation_id,
  ...(details?{proposal,acceptance:proposal?{contextRevision:(await contentProfile(client,p)).revision,proposalRevision:row.proposal_revision}:null,
   evidence:snapshot?{auditId:snapshot.auditId,coverage:snapshot.coverage,pages:snapshot.pages.map(({text,...page})=>page)}:null}:{} )};
}
export async function getSiteAnalyses(projectId:string,userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one website analysis page cursor.');
 return withContentProject(projectId,userId,false,async(client,p)=>{
  const scope={projectId:p.id,list:'site-analysis'},cursor=readContentCursor(params.get('cursor'),scope);
  const rows=(await client.query<AnalysisRow>('SELECT * FROM site_analysis_run WHERE project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51',[p.id,cursor?.at??null,cursor?.id??null])).rows;
  return {role:p.role,canStart:p.role==='owner',runs:await Promise.all(rows.slice(0,50).map(row=>analysisDto(client,p,row,false))),
   nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
 });
}
export async function getSiteAnalysis(projectId:string,userId:string,id:string){
 parse(z.uuid(),id);return withContentProject(projectId,userId,false,async(client,p)=>({role:p.role,run:await analysisDto(client,p,await parentRow(client,p.id,id))}));
}
export async function startSiteAnalysis(projectId:string,userId:string,raw:unknown){
 const input=parse(analysisStartInput,raw),receiptBody={userId,input};
 const prior=await withContentProject(projectId,userId,true,async(client,p)=>{
  owner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'site-analysis.start',receiptBody);
  return receipt.replayed?{role:p.role,run:await analysisDto(client,p,await parentRow(client,p.id,receipt.result.id as string)),replayed:true as const}:null;
 });
 if(prior)return {...prior,acknowledgement:{requestId:input.requestId,runId:prior.run.id,operation:'start' as const}};
 const boss=await getBoss();
 return withContentProject(projectId,userId,true,async(client,p)=>{
  owner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'site-analysis.start',receiptBody);
  if(receipt.replayed){const run=await analysisDto(client,p,await parentRow(client,p.id,receipt.result.id as string));return {role:p.role,run,replayed:true,acknowledgement:{requestId:input.requestId,runId:run.id,operation:'start' as const}};}
  const profile=await contentProfile(client,p);if(profile.revision!==input.contextRevision)throw new FoundationError(409,'Project context changed. Review the current context before running analysis.');
  const wid=await suggestionWorkspace(client,p.id),conn=await suggestionConnection(client,wid,input.connectionId);
  if((await client.query("SELECT 1 FROM site_analysis_run WHERE project_id=$1 AND status='crawling' UNION ALL SELECT 1 FROM ai_suggestion_run WHERE project_id=$1 AND purpose='site-analysis' AND status IN('queued','running','uncertain')",[p.id])).rowCount)throw new FoundationError(409,'Finish or recover the original website analysis before running it again.');
  const paused=(await client.query('SELECT COALESCE((SELECT paused FROM workspace_provider_control WHERE workspace_id=$1),false) AS paused',[wid])).rows[0].paused;
  if(paused)throw new FoundationError(409,'Provider requests are paused. An owner can enable them in Connections.');
  const id=randomUUID(),audit=await queueSiteAuditInTransaction({client,project:{id:p.id,workspaceId:wid,origin:p.origin},run:null,role:p.role},userId,
   {requestId:randomUUID(),domainId:null,startPath:'/',maxPages:5,mode:'static',retainBodyText:true},boss);
  await client.query(`INSERT INTO site_analysis_run(id,workspace_id,project_id,user_id,request_id,request_hash,connection_id,connection_revision,key_fingerprint,model,origin,context_revision,audit_id,child_request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,wid,p.id,userId,input.requestId,canonicalHash(receiptBody),input.connectionId,conn.revision,keyFingerprint(suggestionCredentials(conn)),input.model,p.origin,input.contextRevision,audit.run.id,randomUUID()]);
  await receipt.save({id});return {role:p.role,run:await analysisDto(client,p,await parentRow(client,p.id,id)),replayed:false,acknowledgement:{requestId:input.requestId,runId:id,operation:'start' as const}};
 });
}

async function captureAnalysis(locked:AuditLock,row:AnalysisRow):Promise<AnalysisSnapshot>{
 const {client,project,run}=locked;
 if(!run||run.id!==row.audit_id||run.deleted_at||!['completed','partial'].includes(run.status)||project.origin!==row.origin||run.origin!==row.origin)throw new FoundationError(409,'The original website crawl is unavailable or its origin changed. Run analysis again.');
 Object.assign(run,(await markSiteAuditReadExpiry(client,project.id,[run.id]))[0]);
 if(run.raw_expired_at||run.data_expired_at)throw new FoundationError(409,'The website crawl evidence expired. Run analysis again.');
 const role=(await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[row.workspace_id,row.user_id])).rows[0]?.role;
 if(role!=='owner')throw new FoundationError(403,'The original analysis owner is unavailable.');
 const conn=await suggestionConnection(client,row.workspace_id,row.connection_id,row.connection_revision);
 if(keyFingerprint(suggestionCredentials(conn))!==row.key_fingerprint)throw new FoundationError(409,'The original provider connection changed. Run analysis again.');
 const evidence=await readSiteAnalysisPages(locked);
 if('coverageError' in evidence)throw new FoundationError(409,'The complete website text is unavailable or exceeds the analysis limit. Review the crawl before running analysis again.');
 const pages=evidence.pages.filter(page=>page.state==='available');
 if(!pages.length)throw new FoundationError(409,'The crawl retained no readable page text. Check the site audit before running analysis again.');
 const name=(await client.query('SELECT name FROM project WHERE id=$1',[project.id])).rows[0].name as string;
 const snapshot={version:1 as const,project:{id:project.id,name,origin:row.origin},contextRevision:row.context_revision,auditId:run.id,coverage:run.coverage,
  pages:pages.map(page=>({id:page.id,url:page.url,text:page.text!,bodySha256:page.bodySha256!,extractionVersion:'static-dom-body-v1' as const,observedAt:page.observedAt!}))};
 return assertAnalysisSnapshot({...snapshot,snapshotHash:canonicalHash(snapshot)});
}
/** Dispatch already holds W/P/child locks; recheck the original crawl before the fence commits. */
export async function assertSiteAnalysisDispatch(client:PoolClient,child:any){
 const row=(await client.query<AnalysisRow>('SELECT * FROM site_analysis_run WHERE ai_run_id=$1 AND project_id=$2',[child.id,child.project_id])).rows[0];
 if(!row||row.status!=='analysing')throw unavailable();
 const project=(await client.query('SELECT id,workspace_id AS "workspaceId",origin FROM project WHERE id=$1',[row.project_id])).rows[0];
 const run=(await client.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[row.audit_id,row.project_id])).rows[0]??null;
 const snapshot=await captureAnalysis({client,project,run,role:null},row);
 if(snapshot.snapshotHash!==child.snapshot_hash)throw new FoundationError(409,'The captured website evidence changed before dispatch.');
}
export function identifyAnalysisProposal(value:AnalysisProposal):SiteAnalysisProposal{
 return {...value,brand:value.brand?{id:randomUUID(),...value.brand}:null,competitors:value.competitors.map(p=>({id:randomUUID(),...p})),pages:value.pages.map(p=>({id:randomUUID(),...p})),personas:value.personas.map(p=>({id:randomUUID(),...p}))};
}
export async function advanceSiteAnalysis(id:string,send:typeof fetch=fetch){
 const hint=(await getDatabase().pool.query<AnalysisRow>("SELECT * FROM site_analysis_run WHERE id=$1 AND status='crawling'",[id])).rows[0];if(!hint)return;
 if(!hint.audit_id){await getDatabase().pool.query("UPDATE site_analysis_run SET status='failed',diagnostic='The original crawl is unavailable.',completed_at=clock_timestamp() WHERE id=$1 AND status='crawling'",[id]);return;}
 try{
  const captured=await withAuditLock({runId:hint.audit_id,internal:true},async locked=>{
   const row=await parentRow(locked.client,locked.project.id,id);if(row.status!=='crawling'||row.ai_run_id)return null;
   if(locked.run&&['queued','running','cancelling'].includes(locked.run.status))return null;
   const snapshot=await captureAnalysis(locked,row),conn=await suggestionConnection(locked.client,row.workspace_id,row.connection_id,row.connection_revision);
   return {row,snapshot,credentials:suggestionCredentials(conn)};
  });if(!captured)return;
  const route=await readAnalysisRoute(captured.credentials,captured.row.model,send),messages=analysisMessages(captured.snapshot);
  executionRequestBody(messages,route,analysisOutputTokens,captured.row.child_request_id,executionActor(captured.row.user_id),analysisPurpose);
  const boss=await getBoss();
  await withAuditLock({runId:hint.audit_id,internal:true},async locked=>{
   const {client}=locked,row=await parentRow(client,locked.project.id,id);if(row.status!=='crawling'||row.ai_run_id)return;
   const snapshot=await captureAnalysis(locked,row);if(snapshot.snapshotHash!==captured.snapshot.snapshotHash)throw new FoundationError(409,'The crawl changed while analysis was prepared. Run analysis again.');
   const input:AnalysisStartInput={requestId:row.child_request_id,connectionId:row.connection_id,contextRevision:row.context_revision,model:row.model};
   const hash=canonicalHash({input,snapshotHash:snapshot.snapshotHash,route}),preparationId=randomUUID();
   await client.query(`INSERT INTO ai_suggestion_quote(id,workspace_id,project_id,user_id,request_id,connection_id,connection_revision,request_actor,key_fingerprint,input_hash,snapshot_hash,input,snapshot,messages,route,expires_at,request_version,purpose)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp()+interval '5 minutes',1,'site-analysis')`,
    [preparationId,row.workspace_id,row.project_id,row.user_id,row.child_request_id,row.connection_id,row.connection_revision,executionActor(row.user_id),row.key_fingerprint,hash,snapshot.snapshotHash,JSON.stringify(input),JSON.stringify(snapshot),JSON.stringify(messages),JSON.stringify(route)]);
   const reservation=await reserveRequestInTransaction(client,row.workspace_id,row.user_id,{connectionId:row.connection_id,requestKey:row.child_request_id,operation:'website.analyse',inputHash:hash},async(tx,runId)=>{
    await tx.query("INSERT INTO ai_suggestion_run(id,quote_id,workspace_id,project_id,user_id,request_id,status,purpose) VALUES($1,$2,$3,$4,$5,$6,'queued','site-analysis')",[runId,preparationId,row.workspace_id,row.project_id,row.user_id,row.child_request_id]);
    if(!await boss.send(suggestionQueue,{runId},{id:runId,retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>tx.query(text,values)}}))throw new FoundationError(503,'Website analysis could not be queued.');
   });
   if(!reservation.created)throw new FoundationError(409,'The original website request already exists. It will not be sent again.');
   await client.query("UPDATE site_analysis_run SET status='analysing',ai_run_id=$2 WHERE id=$1",[id,reservation.id]);
  });
 }catch(error){
  // Persist a terminal failure only before a child exists. A lost dispatch can never re-enter preparation.
  await getDatabase().pool.query("UPDATE site_analysis_run SET status='failed',diagnostic=$2,completed_at=clock_timestamp() WHERE id=$1 AND status='crawling' AND ai_run_id IS NULL",[id,error instanceof FoundationError?providerRequestDiagnostic(error.message):'Website analysis could not be prepared. Review the site audit and connection before running it again.']);
 }
}
export async function reconcileSiteAnalyses(){
 const rows=(await getDatabase().pool.query("SELECT s.id FROM site_analysis_run s LEFT JOIN site_audit_run a ON a.id=s.audit_id WHERE s.status='crawling' AND (a.id IS NULL OR a.status NOT IN('queued','running','cancelling') OR a.deleted_at IS NOT NULL) ORDER BY s.created_at LIMIT 20")).rows;
 for(const row of rows)await advanceSiteAnalysis(row.id);
}

export async function acceptSiteAnalysis(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(acceptInput,raw);
 return withContentProject(projectId,userId,true,async(client,p)=>{
  const receipt=await contentReceipt(client,p.id,input.requestId,'site-analysis.accept',{userId,id,input}),row=await parentRow(client,p.id,id);
  if(!receipt.replayed){
   const child=await childRow(client,row),proposal=child?.proposal as SiteAnalysisProposal|null;
   if(!child||child.input_expired||child.result_expired||child.status!=='completed'||!proposal)throw new FoundationError(409,'The retained website proposal is unavailable.');
   if(row.proposal_revision!==input.expectedProposalRevision||row.proposal_revision>=2147483646)throw new FoundationError(409,'The proposal changed. Review it before saving.');
   for(const selection of input.selections){
    if(row.accepted_candidate_ids.includes(selection.candidateId))throw new FoundationError(409,'A selected suggestion was already saved.');
    const updates=selection.updates;
    const valid=proposal.brand?.id===selection.candidateId?updates[0].kind==='profile'&&(updates.length===1||updates.length===2&&updates[1].kind==='section'&&updates[1].key==='business_overview'&&updates[1].content.length>0):
     proposal.competitors.some(c=>c.id===selection.candidateId)?updates.length===1&&updates[0].kind==='competitor':
     proposal.pages.some(c=>c.id===selection.candidateId)?updates.length===1&&updates[0].kind==='key-page':
     proposal.personas.some(c=>c.id===selection.candidateId)?updates.length===1&&updates[0].kind==='persona'&&updates[0].id===selection.candidateId:false;
    if(!valid)throw new FoundationError(400,'Select a retained suggestion and edit only its corresponding context fields.');
   }
   await applyProjectContextUpdates(client,p,userId,{requestId:input.requestId,revision:input.expectedContextRevision,updates:input.selections.flatMap(s=>s.updates)});
   const accepted=[...row.accepted_candidate_ids,...input.selections.map(s=>s.candidateId)];
   await client.query('UPDATE site_analysis_run SET accepted_candidate_ids=$2,proposal_revision=proposal_revision+1 WHERE id=$1',[id,JSON.stringify(accepted)]);
   await receipt.save({id,accepted:input.selections.map(s=>s.candidateId)});
  }
  return {role:p.role,run:await analysisDto(client,p,await parentRow(client,p.id,id)),replayed:receipt.replayed,acknowledgement:{requestId:input.requestId,runId:id,operation:'accept' as const}};
 });
}
export async function recoverSiteAnalysis(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
 parse(z.uuid(),id);const input=parse(actionInput,raw);
 const child=await withContentProject(projectId,userId,true,async(client,p)=>{owner(p);const row=await parentRow(client,p.id,id);if(!row.ai_run_id)throw unavailable();return row.ai_run_id;});
 await recoverSuggestionRequest(projectId,userId,child,input,'site-analysis',send);
 return {...await getSiteAnalysis(projectId,userId,id),acknowledgement:{requestId:input.requestId,runId:id,operation:'recover' as const}};
}
export async function cancelSiteAnalysis(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(actionInput,raw);
 return withContentProject(projectId,userId,true,async(client,p)=>{
  owner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'site-analysis.cancel',{userId,id,input}),row=await parentRow(client,p.id,id);
  if(!receipt.replayed){
   const child=await childRow(client,row);
   if(child&&['dispatched','uncertain'].includes(child.request_status))throw new FoundationError(409,'This request was sent. Check its original status before trying again.');
   if(child?.request_status==='reserved'){
    await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[child.id]);
    await client.query("UPDATE ai_suggestion_run SET status='cancelled',completed_at=clock_timestamp(),diagnostic='Stopped before dispatch.' WHERE id=$1",[child.id]);
   }
   if(row.status==='crawling'){
    const run=(await client.query<AuditRunRow>('SELECT * FROM site_audit_run WHERE id=$1 AND project_id=$2 FOR UPDATE',[row.audit_id,p.id])).rows[0];
    if(run)await cancelSiteAuditInTransaction(client,run);
    await client.query("UPDATE site_analysis_run SET status='cancelled',completed_at=clock_timestamp() WHERE id=$1",[id]);
   }
   await receipt.save({id});
  }
  return {role:p.role,run:await analysisDto(client,p,await parentRow(client,p.id,id)),replayed:receipt.replayed,acknowledgement:{requestId:input.requestId,runId:id,operation:'cancel' as const}};
 });
}
