import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs,startWorker} from '../src/server/jobs.ts';
import {getAuth} from '../src/server/auth.ts';
import {saveProvider,saveBudget,revokeProvider,saveProviderLimit} from '../src/server/providers.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {createPrompts,listPrompts,updatePrompt} from '../src/server/prompts.ts';
import {quoteAiSuggestions,startAiSuggestions,getAiSuggestion,getAiSuggestions,cancelAiSuggestion,acceptAiSuggestions} from '../src/server/ai-suggestions.ts';
import {executeAiSuggestion,reconcileAiSuggestion,reconcileAiSuggestionJobs} from '../src/server/ai-suggestion-worker.ts';
import {runRetentionBatch} from '../src/server/retention.ts';
import {handleApi} from '../src/server/api.ts';
import {suggestionProfiles} from '../src/server/ai-suggestion-input.ts';

export async function runSuggestionChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_AI_SUGGESTIONS_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_ai_suggestions_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_ai_suggestions_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('External provider traffic forbidden.');};
 const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomBytes(24).toString('hex');
 for(const user of [owner,editor,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Suggestion fixture\',$2)',[user,`${user}@suggestions.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 let paid=0,free=0,mode:'ok'|'invalid'|'lost'|'unknown'|'empty'='ok',changedPrice=false;
 let afterPaid:(()=>Promise<void>)|null=null;const receipts=new Map<string,any>();
 const send:typeof fetch=async(address,init)=>{
  const url=String(address);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
  if(url==='https://openrouter.ai/api/v1/models?output_modalities=text&offset=0&limit=500'){free++;const data=suggestionProfiles.map(p=>p.model).map(model=>({id:model,canonical_slug:model,name:model,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:'0.00000015',completion:'0.0000006',request:'0'}}));return Response.json({data,total_count:data.length,links:{next:null}});}
  if(url==='https://openrouter.ai/api/v1/key'){free++;return Response.json({data:{is_free_tier:false,is_management_key:false}});}
  if(url.endsWith('/endpoints')){free++;const model=new URL(url).pathname.slice('/api/v1/models/'.length,-'/endpoints'.length);assert.ok(suggestionProfiles.some(p=>p.model===model));return Response.json({data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:changedPrice?'0.00000016':'0.00000015',completion:'0.0000006',discount:0}}]}});}
  if(url.startsWith('https://openrouter.ai/api/v1/generation?id=')){free++;const data=receipts.get(new URL(url).searchParams.get('id')!);assert.ok(data);return Response.json({data});}
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');paid++;
  const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.strict,true);assert.deepEqual(body.provider.only,['openai']);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.tools,undefined);assert.deepEqual(body.plugins,[{id:'context-compression',enabled:false}]);
  if(afterPaid)await afterPaid();if(mode==='unknown')throw new Error('Synthetic lost response');
  const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000);receipts.set(id,{id,model:body.model,provider_name:'OpenAI',session_id:body.session_id,external_user:body.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',is_byok:false,total_cost:0.000012345});
  if(mode==='lost')return new Response('{broken',{headers:{'x-generation-id':id}});
  const content=mode==='invalid'?'not JSON':JSON.stringify({version:1,limitation:mode==='empty'?'insufficient_context':'none',prompts:mode==='empty'?[]:[{text:'Which grinder is easy to clean?',tags:['Care'],rationale:'Useful for the saved coffee topic.',evidenceIds:['profile']},{text:'Which grinder works for a small kitchen?',tags:[],rationale:'A distinct topic question.',evidenceIds:['profile']}]});
  return Response.json({id,created,model:body.model,provider:'OpenAI',usage:{cost:0.000012345,is_byok:false},choices:[{finish_reason:'stop',message:{content}}]},{headers:{'x-generation-id':id}});
 };
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Suggestion fixture')",[workspace]);
  for(const [user,role] of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Coffee','https://coffee.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const conn=(await saveProvider(workspace,owner,{provider:'openrouter',name:'Synthetic',credentials:{apiKey:'synthetic-only-'+project},monthlyLimitUsd:'5'})).connection;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[conn.id]);await saveBudget(workspace,owner,{monthlyLimitUsd:'5',paused:false});
  return {workspace,project,connectionId:conn.id,input:{requestId:randomUUID(),connectionId:conn.id,contextRevision:1,profileId:'benchmark-mini-v1' as const,benchmark:true as const,fundedCredits:true as const,maxSpendUsd:'1',topic:'Coffee',country:'Global',language:'English',sectionKeys:[],competitorIds:[],excludedPrompts:[]}};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const quote=async(f:Fixture)=>(await quoteAiSuggestions(f.project,owner,f.input,send)).quote;
 const start=async(f:Fixture)=>(await startAiSuggestions(f.project,owner,{requestId:randomUUID(),quoteId:(await quote(f)).id})).run;
 const detail=async(f:Fixture,id:string)=>(await getAiSuggestion(f.project,owner,id)).run;
 const expireQuote=async(id:string)=>pool.query("UPDATE ai_suggestion_quote SET created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 const acceptance=(run:Awaited<ReturnType<typeof detail>>)=>({requestId:randomUUID(),expectedProposalRevision:run.proposalRevision,expectedContextRevision:run.acceptance!.contextRevision,expectedTopicLibraryHash:run.acceptance!.topicLibraryHash,selections:run.proposal!.prompts.map(p=>({candidateId:p.id,text:p.text,tags:p.tags}))});
 try{
  const f=await fixture();for(const user of [editor,viewer,foreign])await assert.rejects(quoteAiSuggestions(f.project,user,f.input,send));assert.equal(free,0);
  const q=await quote(f);assert.equal(q.estimateUsd,'0.020429');const before=free;assert.equal((await quote(f)).id,q.id);assert.equal(free,before);
  await assert.rejects(quoteAiSuggestions(f.project,owner,{...f.input,topic:'Different'},send),{status:409});
  const startBody={requestId:randomUUID(),quoteId:q.id};const [a,b]=await Promise.all([startAiSuggestions(f.project,owner,startBody),startAiSuggestions(f.project,owner,startBody)]);assert.equal(a.run.id,b.run.id);
  await Promise.all([executeAiSuggestion(a.run.id,send),executeAiSuggestion(a.run.id,send)]);assert.equal(paid,1);const done=await detail(f,a.run.id);assert.equal(done.status,'completed');assert.equal(done.actualUsd,'0.000013');assert.equal(done.proposal!.prompts.length,2);
  const save=acceptance(done),accepted=await acceptAiSuggestions(f.project,owner,done.id,save);assert.equal(accepted.acknowledgement.accepted.length,2);
  const authored=await listPrompts(f.project,owner,new URLSearchParams());assert.equal(authored.items.length,2);assert.ok(authored.items.every(p=>!p.enabled));
  await revokeProvider(f.workspace,owner,f.connectionId);await pool.query("UPDATE ai_suggestion_quote SET expires_at=created_at+interval '1 second',created_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[q.id]);
  assert.equal((await startAiSuggestions(f.project,owner,startBody)).run.id,done.id);assert.equal((await quote(f)).id,q.id);
  assert.deepEqual((await acceptAiSuggestions(f.project,owner,done.id,save)).acknowledgement,accepted.acknowledgement);assert.equal(paid,1);
  await assert.rejects(acceptAiSuggestions(f.project,editor,done.id,save),{status:409});await assert.rejects(getAiSuggestion((await fixture()).project,owner,done.id),{status:404});
  assert.equal((await getAiSuggestions(f.project,viewer)).defaults.economy,null);console.log('PASS scoped benchmark authority, quote/start/accept replay, concurrent worker fencing and disabled prompt creation');

  const rollback=await fixture(),rq=await quote(rollback),boss=await getBoss(),originalSend=boss.send.bind(boss);let queuedId:string|undefined;
  boss.send=(async(...args:any[])=>{queuedId=await (originalSend as any)(...args);throw new Error('Synthetic queue rollback');}) as typeof boss.send;
  try{await assert.rejects(startAiSuggestions(rollback.project,owner,{requestId:randomUUID(),quoteId:rq.id}));}finally{boss.send=originalSend;}
  assert.ok(queuedId);assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[rollback.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[queuedId])).rowCount,0);
  const budget=await fixture();await saveProviderLimit(budget.workspace,owner,budget.connectionId,{revision:1,expectedMonthlyLimitUsd:'5',monthlyLimitUsd:'0.01'});await assert.rejects(start(budget),{status:409});
  const cap=await fixture();await assert.rejects(quoteAiSuggestions(cap.project,owner,{...cap.input,maxSpendUsd:'0.01'},send),{status:409});
  const busy=await fixture(),first=await start(busy);busy.input.requestId=randomUUID();await assert.rejects(start(busy),{status:409});await cancelAiSuggestion(busy.project,owner,first.id,{requestId:randomUUID()});
  console.log('PASS queue rollback, conservative per-request/workspace caps and one active project request');

  const baseline=paid;
  for(const kind of ['role','context','library','price','connection','cancel'] as const){
   const f=await fixture(),run=await start(f);
   if(kind==='role')await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,owner]);
   if(kind==='context')await updateProjectContext(f.project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Changed'}]});
   if(kind==='library')await createPrompts(f.project,owner,{requestId:randomUUID(),prompts:[{text:'New concurrent question',topic:'Coffee'}]});
   if(kind==='price')changedPrice=true;if(kind==='connection')await revokeProvider(f.workspace,owner,f.connectionId);if(kind==='cancel')await cancelAiSuggestion(f.project,owner,run.id,{requestId:randomUUID()});
   await executeAiSuggestion(run.id,send);changedPrice=false;assert.equal(paid,baseline);assert.equal((await detail(f,run.id)).status,'cancelled',kind);
  }
  const held=await fixture(),heldRun=await start(held);let ready!:()=>void,release!:()=>void;const atPreflight=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
  const waiting=executeAiSuggestion(heldRun.id,async(...args)=>{if(String(args[0]).endsWith('/endpoints')){ready();await gate;}return send(...args);});await atPreflight;
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[held.workspace,owner]);release();await waiting;assert.equal(paid,baseline);assert.equal((await detail(held,heldRun.id)).status,'cancelled');
  const charged=await fixture(),chargedRun=await start(charged);afterPaid=async()=>{await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[charged.workspace,owner]);};
  await executeAiSuggestion(chargedRun.id,send);afterPaid=null;const charge=(await pool.query('SELECT status,actual_micros FROM provider_request WHERE id=$1',[chargedRun.id])).rows[0];assert.deepEqual(charge,{status:'settled',actual_micros:'13'});
  console.log('PASS preflight and locked dispatch rechecks, held-read demotion, and financial settlement after role revocation');

  for(const phase of ['queued','preflight','final update'] as const){
   const f=await fixture(),run=await start(f);const paidBefore:number=paid,freeBefore:number=free;
   if(phase==='queued'){await expireQuote(run.quoteId);await executeAiSuggestion(run.id,send);}
   if(phase==='preflight')await executeAiSuggestion(run.id,async(...args)=>{if(String(args[0]).endsWith('/endpoints'))await expireQuote(run.quoteId);return send(...args);});
   if(phase==='final update'){
    let ready!:()=>void,release!:()=>void;const atUpdate=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
    const queries=new Map<PoolClient,PoolClient['query']>();
    const acquire=(client:PoolClient)=>{
     if(queries.has(client))return;const query=client.query;queries.set(client,query);
     client.query=function(this:PoolClient,...args:any[]){
      if(typeof args[0]==='string'&&args[0].startsWith("UPDATE ai_suggestion_run SET status='running'")&&args[1]?.[0]===run.id&&!args.some(arg=>typeof arg==='function')){
       ready();return gate.then(()=>Reflect.apply(query,this,args));
      }
      return Reflect.apply(query,this,args);
     } as typeof client.query;
    };
    pool.on('acquire',acquire);const waiting=executeAiSuggestion(run.id,send);
    try{
     await Promise.race([atUpdate,new Promise<never>((_,reject)=>{setTimeout(()=>reject(new Error('Final dispatch update was not reached.')),5000).unref();})]);
     assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[run.id])).rows[0].status,'reserved');
     await expireQuote(run.quoteId);release();await waiting;
    }finally{release();try{await waiting;}finally{pool.off('acquire',acquire);for(const [client,query] of queries)client.query=query;}}
   }
   assert.equal(paid,paidBefore,phase);assert.equal(free,freeBefore+(phase==='queued'?0:2),phase);
   const cancelled=(await pool.query(`SELECT r.status,p.status AS charge_status,r.dispatched_at,r.generation_id,p.actual_micros,p.provider_reference
    FROM ai_suggestion_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1`,[run.id])).rows[0];
   assert.deepEqual(cancelled,{status:'cancelled',charge_status:'cancelled',dispatched_at:null,generation_id:null,actual_micros:null,provider_reference:null},phase);
   assert.match((await detail(f,run.id)).diagnostic!,/quote expiry/);
  }
  const sentExpiry=await fixture(),sentExpiryRun=await start(sentExpiry),beforeSentExpiry=paid;
  afterPaid=async()=>{await expireQuote(sentExpiryRun.quoteId);};
  try{await executeAiSuggestion(sentExpiryRun.id,send);}finally{afterPaid=null;}
  const sentExpired=await detail(sentExpiry,sentExpiryRun.id);assert.equal(paid,beforeSentExpiry+1);assert.equal(sentExpired.status,'completed');assert.equal(sentExpired.chargeStatus,'settled');assert.equal(sentExpired.actualUsd,'0.000013');assert.equal(sentExpired.proposal!.prompts.length,2);assert.equal(sentExpired.inputExpired,false);assert.equal(sentExpired.resultExpired,false);
  console.log('PASS expired queued/preflight/final authorization cancels without dispatch, and expiry after POST preserves known charge and proposal');

  for(const variant of ['invalid','empty'] as const){const f=await fixture(),run=await start(f);mode=variant;await executeAiSuggestion(run.id,send);mode='ok';const row=await detail(f,run.id);assert.equal(row.chargeStatus,'settled');assert.equal(row.actualUsd,'0.000013');assert.equal(row.status,variant==='invalid'?'failed':'completed');if(variant==='empty')assert.deepEqual(row.proposal!.prompts,[]);else assert.equal(row.proposal,null);assert.equal((await listPrompts(f.project,owner,new URLSearchParams())).items.length,0);}
  const lost=await fixture(),lostRun=await start(lost);mode='lost';const paidBefore=paid;await executeAiSuggestion(lostRun.id,send);mode='ok';await expireQuote(lostRun.quoteId);const lostFree=free;await executeAiSuggestion(lostRun.id,send);assert.equal(free,lostFree);assert.equal(paid,paidBefore+1);assert.equal((await detail(lost,lostRun.id)).chargeStatus,'uncertain');
  const recovery={requestId:randomUUID()},recovered=await reconcileAiSuggestion(lost.project,owner,lostRun.id,recovery,send);assert.equal(recovered.run.chargeStatus,'settled');assert.equal(recovered.run.actualUsd,'0.000013');assert.equal(recovered.run.proposal,null);const freeBefore=free;await reconcileAiSuggestion(lost.project,owner,lostRun.id,recovery,send);await executeAiSuggestion(lostRun.id,send);assert.equal(free,freeBefore);assert.equal(paid,paidBefore+1);
  const crashed=await fixture(),crashRun=await start(crashed);await pool.query("UPDATE ai_suggestion_run SET status='running',lease_owner=$2,lease_expires_at=clock_timestamp()-interval '1 second',dispatched_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[crashRun.id,randomUUID()]);await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[crashRun.id]);
  await reconcileAiSuggestionJobs();await executeAiSuggestion(crashRun.id,send);assert.equal((await detail(crashed,crashRun.id)).chargeStatus,'uncertain');assert.equal(paid,paidBefore+1);
  console.log('PASS known charge with invalid/empty proposal, durable lost-response recovery, and crash never re-POSTs');

  const cas=await fixture(),casRun=await start(cas);await executeAiSuggestion(casRun.id,send);const stale=await detail(cas,casRun.id),staleSave=acceptance(stale);
  await updateProjectContext(cas.project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'New authored identity'}]});await assert.rejects(acceptAiSuggestions(cas.project,owner,casRun.id,staleSave),{status:409});
  const current=await detail(cas,casRun.id),freshSave=acceptance(current);assert.equal(current.snapshot!.profile.name,'Coffee');assert.equal(current.acceptance!.contextRevision,2);
  await createPrompts(cas.project,owner,{requestId:randomUUID(),prompts:[{text:freshSave.selections[1].text,topic:'Other'}]});
  await assert.rejects(acceptAiSuggestions(cas.project,owner,casRun.id,freshSave),{status:409});assert.equal((await listPrompts(cas.project,owner,new URLSearchParams())).items.length,1,'Earlier selected insert must roll back on later duplicate');
  freshSave.selections=freshSave.selections.slice(0,1);freshSave.requestId=randomUUID();const saved=await acceptAiSuggestions(cas.project,owner,casRun.id,freshSave);assert.equal(saved.acknowledgement.accepted.length,1);
  const again=acceptance(await detail(cas,casRun.id));again.selections=again.selections.slice(0,1);await assert.rejects(acceptAiSuggestions(cas.project,owner,casRun.id,again),{status:409});
  console.log('PASS current-context CAS review, exact global duplicate rollback and one acceptance per candidate');

  const exclusions=await fixture(),excludedQuote=(await quoteAiSuggestions(exclusions.project,owner,{...exclusions.input,excludedPrompts:['Excluded grinder guide?']},send)).quote;
  const exclusionsRun=(await startAiSuggestions(exclusions.project,owner,{requestId:randomUUID(),quoteId:excludedQuote.id})).run;await executeAiSuggestion(exclusionsRun.id,send);
  const beforeLibrary=acceptance(await detail(exclusions,exclusionsRun.id));
  const library=(await createPrompts(exclusions.project,owner,{requestId:randomUUID(),prompts:[{text:'Initial office question',topic:'Coffee'}]})).items[0];
  await updatePrompt(exclusions.project,owner,library.id,{requestId:randomUUID(),revision:library.revision,text:'Which grinder fits an office?'});
  await assert.rejects(acceptAiSuggestions(exclusions.project,owner,exclusionsRun.id,beforeLibrary),{status:409});
  const review=acceptance(await detail(exclusions,exclusionsRun.id)),paidAtReview=paid;
  const acceptanceState=async()=>(await pool.query(`SELECT r.accepted_candidate_ids,r.proposal_revision,
   (SELECT count(*)::int FROM project_prompt WHERE project_id=$2) AS prompts,
   (SELECT count(*)::int FROM prompt_text_version WHERE project_id=$2) AS versions,
   (SELECT count(*)::int FROM project_content_request WHERE project_id=$2) AS receipts FROM ai_suggestion_run r WHERE r.id=$1`,[exclusionsRun.id,exclusions.project])).rows[0];
  const untouched=await acceptanceState();
  for(const [texts,status] of [
   [['Unique clean guide?','Ｗｈｉｃｈ　ｇｒｉｎｄｅｒ　ｆｉｔｓ　ａｎ　ｏｆｆｉｃｅ？'],409],
   [['Unique clean guide?','Ｅｘｃｌｕｄｅｄ　ｇｒｉｎｄｅｒ　ｇｕｉｄｅ？'],409],
   [['Office grinder?','Ｏｆｆｉｃｅ　ｇｒｉｎｄｅｒ？'],400],
  ] as const){
   const save={...review,requestId:randomUUID(),selections:review.selections.map((s,i)=>({...s,text:texts[i]}))};
   await assert.rejects(acceptAiSuggestions(exclusions.project,owner,exclusionsRun.id,save),{status});assert.deepEqual(await acceptanceState(),untouched,'Mixed selections must not insert prompts, versions, receipts or acceptance state');
  }
  const preservedText='Ｐｒｅｍｉｕｍ\t  grinder?',valid={...review,requestId:randomUUID(),selections:review.selections.map((s,i)=>({...s,text:i?preservedText:'Unique clean guide?'}))};
  await acceptAiSuggestions(exclusions.project,owner,exclusionsRun.id,valid);const savedEdits=await listPrompts(exclusions.project,owner,new URLSearchParams());
  assert.ok(savedEdits.items.some(p=>p.text===preservedText&&!p.enabled));assert.equal(savedEdits.items.length,3);assert.equal(paid,paidAtReview);
  console.log('PASS edited exclusions use fresh topic text and captured exclusions, reject mixed saves atomically and preserve authored Unicode');

  const legacy=await fixture(),legacyRun=await start(legacy);await executeAiSuggestion(legacyRun.id,send);const legacySave=acceptance(await detail(legacy,legacyRun.id));
  legacySave.selections[0].text='Office grinder?';legacySave.selections[1].text='Ｏｆｆｉｃｅ　ｇｒｉｎｄｅｒ？';
  assert.equal(new Set(legacySave.selections.map(s=>s.text.trim().replace(/\s+/gu,' ').toLowerCase())).size,2,'This completed receipt was admissible under the prior comparison policy');
  const legacyPrompts=(await createPrompts(legacy.project,owner,{requestId:randomUUID(),prompts:legacySave.selections.map(s=>({text:s.text,topic:'Coffee',tags:s.tags,enabled:false}))})).items;
  const legacyAccepted=legacySave.selections.map((s,i)=>({candidateId:s.candidateId,promptId:legacyPrompts[i].id,versionId:legacyPrompts[i].currentVersionId}));
  await pool.query('INSERT INTO project_content_request(project_id,request_id,operation,input_hash,result) VALUES($1,$2,$3,$4,$5)',[legacy.project,legacySave.requestId,'ai-suggestion.accept',canonicalHash({userId:owner,id:legacyRun.id,input:legacySave}),JSON.stringify({id:legacyRun.id,accepted:legacyAccepted})]);
  await pool.query('UPDATE ai_suggestion_run SET accepted_candidate_ids=$2,proposal_revision=proposal_revision+1 WHERE id=$1',[legacyRun.id,JSON.stringify(legacyAccepted.map(s=>s.candidateId))]);
  await updateProjectContext(legacy.project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Later authored context'}]});
  const legacyPaid=paid,legacyState=(await pool.query('SELECT count(*)::int AS prompts FROM project_prompt WHERE project_id=$1',[legacy.project])).rows[0];
  const replay=await acceptAiSuggestions(legacy.project,owner,legacyRun.id,legacySave);assert.equal(replay.replayed,true);assert.deepEqual(replay.acknowledgement.accepted,legacyAccepted);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS prompts FROM project_prompt WHERE project_id=$1',[legacy.project])).rows[0],legacyState);assert.equal(paid,legacyPaid);
  await assert.rejects(acceptAiSuggestions(legacy.project,viewer,legacyRun.id,legacySave),{status:404});await assert.rejects(acceptAiSuggestions(legacy.project,editor,legacyRun.id,legacySave),{status:409});
  await assert.rejects(acceptAiSuggestions(legacy.project,owner,legacyRun.id,{...legacySave,selections:legacySave.selections.map(s=>({...s,text:s.text+' changed'}))}),{status:409});
  console.log('PASS pre-policy Unicode acceptance receipts replay under fresh authorization without regeneration or reinsertion');
  const beforeCandidates=paid;
  for(const profile of suggestionProfiles.slice(2)){
   const f=await fixture(),oldQuote=await quote(f),candidateInput={...f.input,requestId:randomUUID(),profileId:profile.id};
   await assert.rejects(quoteAiSuggestions(f.project,owner,{...f.input,profileId:profile.id},send),{status:409},'Changed model cannot reuse an existing quote receipt');
   const q=(await quoteAiSuggestions(f.project,owner,candidateInput,send)).quote;assert.notEqual(q.id,oldQuote.id);assert.equal(q.input!.profileId,profile.id);assert.equal(q.route.model,profile.model);assert.equal(q.estimateUsd,'0.020429');
   assert.equal((await quote(f)).route.model,'openai/gpt-4o-mini');assert.equal((await getAiSuggestions(f.project,owner)).runs.length,0,'Model discovery and quotation do not generate or reserve');
   const started=(await startAiSuggestions(f.project,owner,{requestId:randomUUID(),quoteId:q.id})).run;await executeAiSuggestion(started.id,send);
   const result=await detail(f,started.id);assert.equal(result.model,profile.model);assert.equal(result.status,'completed');assert.equal(result.actualUsd,'0.000013');assert.equal((await listPrompts(f.project,owner,new URLSearchParams())).items.length,0);
   assert.equal((await pool.query('SELECT route FROM ai_suggestion_quote WHERE id=$1',[oldQuote.id])).rows[0].route.model,'openai/gpt-4o-mini');
  }
  assert.equal(paid,beforeCandidates+2);const choices=await getAiSuggestions(cas.project,viewer);assert.deepEqual(choices.profiles.map(p=>[p.id,p.model]),[...suggestionProfiles.map(p=>[p.id,p.model]),['catalog-text-schema-v1',null]]);assert.deepEqual(choices.profiles.filter(p=>p.id==='catalog-text-schema-v1'),[{id:'catalog-text-schema-v1',model:null,label:'Choose a model — evaluation only',admission:'benchmark'}]);assert.deepEqual(choices.defaults,{economy:null,balanced:null});assert.equal(choices.canQuote,false);
  console.log('PASS candidate-only metadata, permanent old receipts, fresh immutable model quotes and exact candidate dispatch');

  for(const profile of suggestionProfiles.slice(2)){
   const f=await fixture(),q=(await quoteAiSuggestions(f.project,owner,{...f.input,profileId:profile.id},send)).quote,started=(await startAiSuggestions(f.project,owner,{requestId:randomUUID(),quoteId:q.id})).run;const prior:number=paid;
   changedPrice=true;await executeAiSuggestion(started.id,send);changedPrice=false;assert.equal(paid,prior);assert.equal((await detail(f,started.id)).status,'cancelled');
  }
  console.log('PASS fresh candidate route changes cancel before completion without fallback or new quote');

  const retained=await fixture(),retainedRun=await start(retained);await executeAiSuggestion(retainedRun.id,send);const originalProposal=(await detail(retained,retainedRun.id)).proposal!;
  await pool.query("UPDATE ai_suggestion_quote SET created_at=clock_timestamp()-interval '91 days' WHERE id=$1",[retainedRun.quoteId]);
  const expired=await detail(retained,retainedRun.id);assert.equal(expired.snapshot,null);assert.equal(expired.proposal,null);assert.equal(expired.resultExpired,true);
  const cleaned=await runRetentionBatch(retained.project);assert.equal(cleaned!.expiredSuggestionResults,1);assert.equal(cleaned!.expiredSuggestionInputs,1);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[retained.workspace]);await executeAiSuggestion(retainedRun.id,send);const masked=await detail(retained,retainedRun.id);assert.equal(masked.proposal,null);assert.equal(masked.snapshot,null);
  await assert.rejects(acceptAiSuggestions(retained.project,owner,retainedRun.id,{requestId:randomUUID(),expectedProposalRevision:1,expectedContextRevision:1,expectedTopicLibraryHash:'a'.repeat(64),selections:[{candidateId:originalProposal.prompts[0].id,text:'Never resurrect',tags:[]}]}),{status:409});
  console.log('PASS immediate raw cutoff, bounded cleanup and irreversible input/proposal tombstones');

  // Earlier groups called the handler directly; settle their already-terminal
  // synthetic queue entries before measuring the actual registered worker.
  const terminal=(await pool.query("SELECT id FROM ai_suggestion_run WHERE status NOT IN('queued','running')")).rows.map(r=>r.id);
  if(terminal.length)await boss.complete('ai-suggestion',terminal,undefined,{includeQueued:true});
  const api=await fixture(),login=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:config.appUrl},body:JSON.stringify({email:`${owner}@suggestions.integration.test`,password})}));assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),base=`${config.appUrl}/api/projects/${api.project}/ai-suggestions`;
  const request=(path='',method='GET',body?:unknown,origin=config.appUrl)=>new Request(base+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await handleApi(new Request(base))).status,401);assert.equal((await handleApi(request('/quote','POST',api.input,'https://foreign.test'))).status,403);assert.equal((await handleApi(request('?unknown=x'))).status,400);assert.equal((await handleApi(request('','PUT'))).status,405);
  const sentBefore=paid;globalThis.fetch=send;const apiQuote=await handleApi(request('/quote','POST',api.input));assert.equal(apiQuote.status,200);const quoteBody=await apiQuote.json();assert.equal(paid,sentBefore);
  const apiStart=await handleApi(request('/runs','POST',{requestId:randomUUID(),quoteId:quoteBody.quote.id}));assert.equal(apiStart.status,202);const started=await apiStart.json();
  await startWorker();const until=Date.now()+15000;while(Date.now()<until){if((await detail(api,started.run.id)).status==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal((await detail(api,started.run.id)).status,'completed');assert.equal(paid,sentBefore+1);await stopJobs();globalThis.fetch=async()=>{outbound++;throw new Error('External provider traffic forbidden.');};
  console.log('PASS real cookie/Origin/method/query API and production worker handler with contained provider transport');
  assert.equal(outbound,0);
 }finally{globalThis.fetch=original;await stopJobs();await closeDatabase();}
}
if(import.meta.url===new URL(process.argv[1]??'', 'file:').href||process.argv[1]?.endsWith('ai-suggestions-integration.ts'))await runSuggestionChecks();
