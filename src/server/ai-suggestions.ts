import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {decryptCredentials} from './credential-vault.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentCursor,readContentCursor,contentProfile,contentReceipt,withContentProject,type ContentProject} from './project-context.ts';
import {usd,usdMicros} from './providers.ts';
import {reserveSpendInTransaction} from './spending.ts';
import {keyFingerprint,executionActor,readSuggestionRoute} from './openrouter.ts';
import {insertPromptInTransaction} from './prompts.ts';
import {suggestionQuoteInput,suggestionStartInput,suggestionActionInput,suggestionAcceptInput,suggestionProfiles,suggestionProfile,suggestionMessages,
 suggestionBodyHash,suggestionTextKey,type SuggestionInput,type SuggestionSnapshot,type SuggestionProposal} from './ai-suggestion-input.ts';

export const suggestionQueue='ai-suggestion';
export const suggestionSelect=`SELECT r.*,q.connection_id,q.connection_revision,q.key_fingerprint,q.request_actor,q.input,q.snapshot,q.messages,q.route,q.input_hash,q.snapshot_hash,q.input_purged_at,
 q.created_at AS captured_at,q.expires_at<=clock_timestamp() AS quote_expired,p.status AS charge_status,p.estimate_micros,p.actual_micros,
 (q.input_purged_at IS NOT NULL OR q.created_at<transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours') AS input_expired,
 (r.result_purged_at IS NOT NULL OR q.input_purged_at IS NOT NULL OR q.created_at<transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours'
  OR r.completed_at<transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours') AS result_expired
 FROM ai_suggestion_run r JOIN ai_suggestion_quote q ON q.id=r.quote_id JOIN provider_request p ON p.id=r.id JOIN workspace w ON w.id=r.workspace_id`;
const unavailable=()=>new FoundationError(404,'Suggestion not found or unavailable.');
export async function suggestionConnection(client:PoolClient,workspaceId:string,id:string,revision?:number){
 const row=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='openrouter' AND revoked_at IS NULL",[id,workspaceId])).rows[0];
 if(!row)throw unavailable();if(row.check_status!=='ok'||revision!==undefined&&row.revision!==revision)throw new FoundationError(409,'Check the current connection and prepare a new quote.');return row;
}
export function suggestionCredentials(row:any){return decryptCredentials(row.encrypted_credentials,{id:row.id,workspaceId:row.workspace_id,provider:row.provider,revision:row.revision});}
export async function suggestionWorkspace(client:PoolClient,projectId:string){return (await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0].workspace_id as string;}
function requireOwner(p:ContentProject){if(p.role!=='owner')throw new FoundationError(403,'Only an owner can run evaluation-only suggestion profiles.');}
async function topicLibrary(client:PoolClient,projectId:string,topic:string){
 const bound=(await client.query(`SELECT count(*)::integer AS count,COALESCE(sum(octet_length(v.text)),0)::integer AS bytes FROM project_prompt p
 JOIN prompt_text_version v ON v.id=p.current_version_id AND v.project_id=p.project_id WHERE p.project_id=$1 AND p.topic=$2 AND p.archived_at IS NULL`,[projectId,topic])).rows[0];
 if(bound.count>100||bound.bytes>100_000)throw new FoundationError(413,'This topic exceeds the suggestion context limit. Choose a narrower topic.');
 const rows=(await client.query(`SELECT p.id,p.current_version_id AS "versionId",p.revision,v.text FROM project_prompt p
 JOIN prompt_text_version v ON v.id=p.current_version_id AND v.project_id=p.project_id WHERE p.project_id=$1 AND p.topic=$2 AND p.archived_at IS NULL ORDER BY p.id`,[projectId,topic])).rows as SuggestionSnapshot['existingPrompts'];
 return {rows,hash:canonicalHash(rows)};
}
export async function captureSuggestionSnapshot(client:PoolClient,p:ContentProject,input:SuggestionInput):Promise<SuggestionSnapshot>{
 const profile=await contentProfile(client,p);if(profile.revision!==input.contextRevision)throw new FoundationError(409,'Project context changed. Reload it before preparing suggestions.');
 const sections=(await client.query('SELECT key,content FROM context_section WHERE project_id=$1 AND key=ANY($2::text[]) ORDER BY key',[p.id,input.sectionKeys])).rows as SuggestionSnapshot['sections'];
 if(sections.length!==input.sectionKeys.length)throw new FoundationError(409,'A selected context section is unavailable.');
 const competitors=(await client.query('SELECT id,name,primary_domain AS domain FROM context_competitor WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[p.id,input.competitorIds])).rows as SuggestionSnapshot['competitors'];
 if(competitors.length!==input.competitorIds.length)throw new FoundationError(409,'A selected competitor is unavailable.');
 const selectedProfile={name:profile.name,aliases:profile.aliases,citationDomains:profile.citationDomains},library=await topicLibrary(client,p.id,input.topic);
 const evidence:SuggestionSnapshot['evidence']=[{id:'profile',kind:'profile',sha256:canonicalHash(selectedProfile),value:selectedProfile},
  ...sections.map(s=>({id:`section:${s.key}`,kind:'section' as const,sha256:canonicalHash(s),value:s})),
  ...competitors.map(c=>({id:`competitor:${c.id}`,kind:'competitor' as const,sha256:canonicalHash(c),value:c}))];
 const value={version:1 as const,project:{id:p.id,name:p.name,origin:p.origin},contextRevision:profile.revision,profile:selectedProfile,sections,competitors,
  topic:input.topic,country:input.country,language:input.language,existingPrompts:library.rows,excludedPrompts:input.excludedPrompts,evidence,topicLibraryHash:library.hash};
 const snapshot={...value,snapshotHash:canonicalHash(value)};suggestionMessages(snapshot);return snapshot;
}
export async function assertSuggestionSnapshot(client:PoolClient,projectId:string,input:SuggestionInput,snapshotHash:string){
 const p=(await client.query('SELECT id,name,origin FROM project WHERE id=$1',[projectId])).rows[0];if(!p)throw unavailable();
 if((await captureSuggestionSnapshot(client,p,input)).snapshotHash!==snapshotHash)throw new FoundationError(409,'The captured context changed. Prepare a new suggestion quote.');
}
async function runRow(client:PoolClient,projectId:string,id:string){const row=(await client.query(suggestionSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];if(!row)throw unavailable();return row;}
async function runDto(client:PoolClient,p:ContentProject,row:any,details:boolean){
 const snapshot=row.input_expired?null:row.snapshot as SuggestionSnapshot|null,proposal=row.result_expired?null:row.proposal as SuggestionProposal|null;
 let acceptance=null;
 if(details&&snapshot&&proposal){const profile=await contentProfile(client,p);try{const library=await topicLibrary(client,p.id,snapshot.topic);acceptance={contextRevision:profile.revision,topicLibraryHash:library.hash,proposalRevision:row.proposal_revision};}catch(error){if(!(error instanceof FoundationError&&error.status===413))throw error;}}
 return {id:row.id,quoteId:row.quote_id,status:row.status,chargeStatus:row.charge_status,model:row.route.model,provider:row.route.providerName,
  estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),createdAt:row.created_at,dispatchedAt:row.dispatched_at,completedAt:row.completed_at,
  proposalRevision:row.proposal_revision,acceptedCandidateIds:row.accepted_candidate_ids,inputExpired:row.input_expired,resultExpired:!!row.result_expired,
  proposalStatus:row.result_expired?'expired':row.proposal?'available':'unavailable',diagnostic:row.diagnostic,
  canCancel:p.role==='owner'&&row.charge_status==='reserved',canReconcile:p.role==='owner'&&row.charge_status==='uncertain'&&!!row.generation_id,
  ...(details?{snapshot,proposal,acceptance,generationId:row.generation_id}:{} )};
}
async function quoteDto(client:PoolClient,projectId:string,id:string){
 const q=(await client.query(`SELECT q.*,(q.input_purged_at IS NOT NULL OR q.created_at<transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours') AS expired
 FROM ai_suggestion_quote q JOIN workspace w ON w.id=q.workspace_id WHERE q.id=$1 AND q.project_id=$2`,[id,projectId])).rows[0];if(!q)throw unavailable();
 return {id:q.id,requestId:q.request_id,inputHash:q.input_hash,snapshotHash:q.snapshot_hash,createdAt:q.created_at,expiresAt:q.expires_at,
  input:q.expired?null:q.input,snapshot:q.expired?null:q.snapshot,inputExpired:q.expired,route:{...q.route,estimateMicros:undefined,estimateUsd:usd(q.route.estimateMicros)},estimateUsd:usd(q.route.estimateMicros)};
}
export async function getAiSuggestions(projectId:string,userId:string,params=new URLSearchParams()){
 if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one suggestion page cursor.');
 return withContentProject(projectId,userId,false,async(client,p)=>{
  const scope={projectId:p.id,list:'ai-suggestions'},cursor=readContentCursor(params.get('cursor'),scope);
  const rows=(await client.query(suggestionSelect+` WHERE r.project_id=$1 AND ($2::timestamptz IS NULL OR (r.created_at,r.id)<($2::timestamptz,$3::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[p.id,cursor?.at??null,cursor?.id??null])).rows;
  return {role:p.role,profiles:suggestionProfiles.map(profile=>({...profile,admission:'benchmark' as const})),defaults:{economy:null,balanced:null},canQuote:p.role==='owner',runs:await Promise.all(rows.slice(0,50).map(r=>runDto(client,p,r,false))),
   nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
 });
}
export async function getAiSuggestion(projectId:string,userId:string,id:string){parse(z.uuid(),id);return withContentProject(projectId,userId,false,async(client,p)=>({role:p.role,run:await runDto(client,p,await runRow(client,p.id,id),true)}));}
export async function quoteAiSuggestions(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 const input=parse(suggestionQuoteInput,raw),receiptBody={userId,input};
 const saved=await withContentProject(projectId,userId,true,async(client,p)=>{
  requireOwner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.quote',receiptBody);
  if(receipt.replayed)return {prior:await quoteDto(client,p.id,receipt.result.id as string),role:p.role} as const;
  const wid=await suggestionWorkspace(client,p.id),conn=await suggestionConnection(client,wid,input.connectionId),snapshot=await captureSuggestionSnapshot(client,p,input);
  return {snapshot,credentials:suggestionCredentials(conn),connectionRevision:conn.revision} as const;
 });
 const result=(role:ContentProject['role'],quote:Awaited<ReturnType<typeof quoteDto>>,replayed:boolean)=>({role,acknowledgement:{requestId:input.requestId,quoteId:quote.id,inputHash:quote.inputHash},quote,replayed});
 if('prior' in saved)return result(saved.role!,saved.prior!,true);
 const route=await readSuggestionRoute(saved.credentials,suggestionProfile(input.profileId).model,send);
 if(BigInt(route.estimateMicros)>usdMicros(input.maxSpendUsd))throw new FoundationError(409,'The verified reservation exceeds the selected per-request ceiling.');
 return withContentProject(projectId,userId,true,async(client,p)=>{
  requireOwner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.quote',receiptBody);if(receipt.replayed)return result(p.role,await quoteDto(client,p.id,receipt.result.id as string),true);
  const wid=await suggestionWorkspace(client,p.id);await suggestionConnection(client,wid,input.connectionId,saved.connectionRevision);await assertSuggestionSnapshot(client,p.id,input,saved.snapshot.snapshotHash);
  const id=randomUUID(),hash=canonicalHash({input,snapshotHash:saved.snapshot.snapshotHash,route});
  await client.query(`INSERT INTO ai_suggestion_quote(id,workspace_id,project_id,user_id,request_id,connection_id,connection_revision,request_actor,key_fingerprint,input_hash,snapshot_hash,input,snapshot,messages,route,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp()+interval '5 minutes')`,
   [id,wid,p.id,userId,input.requestId,input.connectionId,saved.connectionRevision,executionActor(userId),keyFingerprint(saved.credentials),hash,saved.snapshot.snapshotHash,JSON.stringify(input),JSON.stringify(saved.snapshot),JSON.stringify(suggestionMessages(saved.snapshot)),JSON.stringify(route)]);
  await receipt.save({id});return result(p.role,await quoteDto(client,p.id,id),false);
 });
}
export async function startAiSuggestions(projectId:string,userId:string,raw:unknown){
 const input=parse(suggestionStartInput,raw),boss=await getBoss();
 return withContentProject(projectId,userId,true,async(client,p)=>{
  requireOwner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.start',{userId,input});
  const result=async(id:string,replayed:boolean)=>({role:p.role,acknowledgement:{requestId:input.requestId,runId:id,quoteId:input.quoteId,operation:'start' as const},run:await runDto(client,p,await runRow(client,p.id,id),true),replayed});
  if(receipt.replayed)return result(receipt.result.id as string,true);
  const q=(await client.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM ai_suggestion_quote WHERE id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE',[input.quoteId,p.id,userId])).rows[0];if(!q)throw unavailable();
  if(q.expired||q.input_purged_at)throw new FoundationError(409,'This quote expired. Prepare another quote.');
  if((await client.query("SELECT id FROM ai_suggestion_run WHERE project_id=$1 AND (quote_id=$2 OR status IN('queued','running','uncertain'))",[p.id,q.id])).rowCount)throw new FoundationError(409,'This quote started already or another suggestion request is unfinished.');
  await suggestionConnection(client,q.workspace_id,q.connection_id,q.connection_revision);await assertSuggestionSnapshot(client,p.id,q.input,q.snapshot_hash);
  const reservation=await reserveSpendInTransaction(client,q.workspace_id,userId,{connectionId:q.connection_id,requestKey:input.requestId,operation:'ai.suggest',inputHash:q.input_hash,estimateUsd:usd(q.route.estimateMicros)},async(tx,id)=>{
   await tx.query("INSERT INTO ai_suggestion_run(id,quote_id,workspace_id,project_id,user_id,request_id,status) VALUES($1,$2,$3,$4,$5,$6,'queued')",[id,q.id,q.workspace_id,p.id,userId,input.requestId]);
   if(!await boss.send(suggestionQueue,{runId:id},{id,retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>tx.query(text,values)}}))throw new Error('Suggestion could not be queued.');
  });
  await receipt.save({id:reservation.id});return result(reservation.id,false);
 });
}
export async function cancelAiSuggestion(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(suggestionActionInput,raw);
 return withContentProject(projectId,userId,true,async(client,p)=>{
  requireOwner(p);const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.cancel',{userId,id,input});
  const row=await runRow(client,p.id,id);
  if(!receipt.replayed){if(row.charge_status==='reserved'){
   await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[id]);
   await client.query("UPDATE ai_suggestion_run SET status='cancelled',completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic='Stopped before dispatch.' WHERE id=$1",[id]);
  }else if(row.charge_status==='dispatched'||row.charge_status==='uncertain')throw new FoundationError(409,'This request was sent. Its charge must be retained and reconciled.');await receipt.save({id});}
  return {role:p.role,acknowledgement:{requestId:input.requestId,runId:id,operation:'cancel' as const},run:await runDto(client,p,await runRow(client,p.id,id),true),replayed:receipt.replayed};
 });
}
export async function acceptAiSuggestions(projectId:string,userId:string,id:string,raw:unknown){
 parse(z.uuid(),id);const input=parse(suggestionAcceptInput,raw);
 if(new Set(input.selections.map(s=>suggestionTextKey(s.text))).size!==input.selections.length)throw new FoundationError(400,'Select distinct prompt drafts.');
 return withContentProject(projectId,userId,true,async(client,p)=>{
  const receipt=await contentReceipt(client,p.id,input.requestId,'ai-suggestion.accept',{userId,id,input}),row=await runRow(client,p.id,id);
  let accepted=receipt.result?.accepted as {candidateId:string;promptId:string;versionId:string}[]|undefined;
  if(!receipt.replayed){
   if(row.input_expired||row.result_expired||!row.proposal)throw new FoundationError(409,'The retained proposal is unavailable.');
   const snapshot=row.snapshot as SuggestionSnapshot,proposal=row.proposal as SuggestionProposal,profile=await contentProfile(client,p),library=await topicLibrary(client,p.id,snapshot.topic);
   if(row.proposal_revision!==input.expectedProposalRevision||row.proposal_revision>=2147483646||profile.revision!==input.expectedContextRevision||library.hash!==input.expectedTopicLibraryHash)throw new FoundationError(409,'The proposal or project context changed. Review current context before saving.');
   if(input.selections.some(s=>!proposal.prompts.some(c=>c.id===s.candidateId)||(row.accepted_candidate_ids as string[]).includes(s.candidateId)))throw new FoundationError(409,'A selected draft is unavailable or already saved.');
   accepted=[];for(const selected of input.selections){const saved=await insertPromptInTransaction(client,p.id,userId,{text:selected.text,tags:selected.tags,topic:snapshot.topic,enabled:false});accepted.push({candidateId:selected.candidateId,promptId:saved.id,versionId:saved.versionId});}
   await client.query('UPDATE ai_suggestion_run SET accepted_candidate_ids=$2,proposal_revision=proposal_revision+1 WHERE id=$1',[id,JSON.stringify([...row.accepted_candidate_ids,...accepted.map(a=>a.candidateId)])]);await receipt.save({id,accepted});
  }
  return {role:p.role,acknowledgement:{requestId:input.requestId,runId:id,operation:'accept' as const,accepted:accepted!},run:await runDto(client,p,await runRow(client,p.id,id),true),replayed:receipt.replayed};
 });
}
// Worker settlement owns W -> P -> run locks independently of later actor membership.
export async function withSuggestionRun<T>(id:string,work:(client:PoolClient,row:any)=>Promise<T>){
 const client=await getDatabase().pool.connect();try{await client.query('BEGIN');
  const ref=(await client.query('SELECT workspace_id,project_id FROM ai_suggestion_run WHERE id=$1',[id])).rows[0];if(!ref)throw unavailable();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[ref.workspace_id]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[ref.project_id]);
  await client.query('SELECT id FROM ai_suggestion_run WHERE id=$1 FOR UPDATE',[id]);const result=await work(client,await runRow(client,ref.project_id,id));await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
