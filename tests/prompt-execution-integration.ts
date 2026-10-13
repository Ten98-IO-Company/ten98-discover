import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs,startWorker} from '../src/server/jobs.ts';
import {saveProvider,saveBudget,revokeProvider} from '../src/server/providers.ts';
import {createPrompts,updatePrompt,setPromptArchived} from '../src/server/prompts.ts';
import {getPromptExecutions,getPromptComparison,quotePromptExecution,startPromptExecution,cancelPromptComparison,executePromptComparison,reconcilePromptExecution,reconcilePromptExecutionJobs} from '../src/server/prompt-execution.ts';
import {runRetentionBatch,previewRetention,getRetention} from '../src/server/retention.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

export async function runPromptExecutionChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
 const config=getConfig();assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));
 const pool=getDatabase().pool,owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomBytes(32).toString('base64url');
 for(const user of [owner,editor,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Prompt fixture\',$2)',[user,`${user}@execution.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 const mini='openai/gpt-4o-mini' as const,models=[mini,'openai/gpt-4o'] as const;
 let paid=0,free=0,mode:'ok'|'unknown'|'truncated'|'over'|'byok'|'invalid'|'empty'|'pending'='ok',priceChanged=false,receiptChange:Record<string,unknown>={};
 const receipts=new Map<string,any>(),sent:string[]=[];
 const send:typeof fetch=async(url,init)=>{
  assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);const address=String(url);
  if(address==='https://openrouter.ai/api/v1/key'){free++;return Response.json({data:{is_free_tier:false,is_management_key:false}});}
  if(address.endsWith('/endpoints')){free++;const model=address.includes('gpt-4o-mini')?mini:models[1];return Response.json({data:{id:model,endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing:{prompt:priceChanged?'0.00000016':'0.00000015',completion:'0.0000006',input_cache_read:'0.000000075',discount:0}}]}});}
  if(address.startsWith('https://openrouter.ai/api/v1/generation?id=')){free++;return Response.json({data:{...receipts.get(new URL(address).searchParams.get('id')!),...receiptChange}});}
  assert.equal(address,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');paid++;const input=JSON.parse(String(init?.body));sent.push(input.session_id);assert.deepEqual(input.provider.only,['openai']);assert.equal(input.provider.allow_fallbacks,false);
  if(mode==='unknown')throw new Error('Synthetic unavailable response, never live.');
  const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000),cost=mode==='over'?0.04:0.000012345;
  receipts.set(id,{id,model:input.model,provider_name:'OpenAI',session_id:input.session_id,external_user:input.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',is_byok:mode==='byok',total_cost:cost,upstream_inference_cost:mode==='byok'?0.01:0});
  if(mode==='truncated')return new Response('{broken',{headers:{'x-generation-id':id}});
  return Response.json({id,model:input.model,provider:'OpenAI',created,choices:[{finish_reason:mode==='pending'?null:'stop',message:{content:mode==='invalid'?'bad\0':mode==='empty'?'':'Synthetic untrusted answer'}}],usage:{cost,is_byok:mode==='byok',prompt_tokens:12,completion_tokens:20}},{headers:{'x-generation-id':id}});
 };
 const blocked:typeof fetch=async()=>{throw new Error('Real provider traffic is forbidden in execution tests.');};
 const originalFetch=globalThis.fetch;globalThis.fetch=blocked;
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Prompt execution integration')",[workspace]);
  for(const [user,role] of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Prompts','https://'||$1||'.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const connection=(await saveProvider(workspace,owner,{provider:'openrouter',name:'Synthetic only',credentials:{apiKey:'synthetic-never-live'},monthlyLimitUsd:'10'})).connection;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[connection.id]);await saveBudget(workspace,owner,{monthlyLimitUsd:'10',paused:false});
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Exact original prompt',enabled:false}]})).items[0];
  return {workspace,project,connectionId:connection.id,prompt,request:{connectionId:connection.id,promptId:prompt.id,versionId:prompt.currentVersionId,systemText:'Explicit system text',models:[...models],maxCompletionTokens:2048,fundedCredits:true as const}};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const quote=async(f:Fixture,user=owner)=>(await quotePromptExecution(f.project,user,f.request,send)).quote;
 const start=async(f:Fixture,user=owner)=>(await startPromptExecution(f.project,user,{quoteId:(await quote(f,user)).id,requestKey:randomUUID()})).comparison;
 const detail=async(f:Fixture,id:string)=>(await getPromptComparison(f.project,owner,id)).comparison;
 const ledger=async(id:string)=>(await pool.query('SELECT status,actual_micros,provider_reference FROM provider_request WHERE id=$1',[id])).rows[0];
 try{
  const f=await fixture(),freeBefore=free;assert.equal((await getPromptExecutions(f.project,viewer)).role,'viewer');assert.equal(free,freeBefore);assert.equal(paid,0);
  await assert.rejects(quote(f,viewer),{status:404});await assert.rejects(getPromptExecutions(f.project,foreign),{status:404});
  const q=await quote(f),key=randomUUID();assert.equal(q.estimateUsd,'0.040858');assert.deepEqual(q.messages,[{role:'system',content:'Explicit system text'},{role:'user',content:'Exact original prompt'}]);
  const [first,retry]=await Promise.all([startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key}),startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key})]);assert.equal(first.comparison.id,retry.comparison.id);assert.equal(first.comparison.runs.length,2);
  const q2=await quote(f);await assert.rejects(startPromptExecution(f.project,owner,{quoteId:q2.id,requestKey:key}),{status:409});await assert.rejects(startPromptExecution(f.project,editor,{quoteId:q.id,requestKey:randomUUID()}),{status:404});
  await updatePrompt(f.project,owner,f.prompt.id,{requestId:randomUUID(),revision:1,text:'Later prompt text'});
  await Promise.all([executePromptComparison(first.comparison.id,send),executePromptComparison(first.comparison.id,send)]);assert.equal(paid,2);const done=await detail(f,first.comparison.id);assert.equal(done.messages[1].content,'Exact original prompt');assert.deepEqual(done.runs.map((r:any)=>r.status),['completed','completed']);assert.equal(done.runs[0].actualUsd,'0.000013');
  await executePromptComparison(done.id,send);assert.equal(paid,2);assert.equal((await startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key})).comparison.id,done.id);
  const other=await fixture();await assert.rejects(getPromptComparison(other.project,owner,done.id),{status:404});
  console.log('PASS actor/project/immutable-version binding, exact quote, atomic retry and one dispatch per comparison child');

  const budget=await fixture();await saveBudget(budget.workspace,owner,{monthlyLimitUsd:'0.03',paused:false});await assert.rejects(start(budget),{status:409});assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[budget.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM prompt_comparison WHERE workspace_id=$1',[budget.workspace])).rowCount,0);
  const rollback=await fixture(),rq=await quote(rollback),boss=await getBoss(),originalSend=boss.send.bind(boss);let insertedQueueId:string|undefined;boss.send=(async(...args:any[])=>{insertedQueueId=await (originalSend as any)(...args);throw new Error('Synthetic failure after queue insertion');}) as typeof boss.send;
  try{await assert.rejects(startPromptExecution(rollback.project,owner,{quoteId:rq.id,requestKey:randomUUID()}));}finally{boss.send=originalSend;}
  assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[rollback.workspace])).rowCount,0);assert.ok(insertedQueueId);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[insertedQueueId])).rowCount,0);
  const expired=await fixture(),eq=await quote(expired);await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[eq.id]);await assert.rejects(startPromptExecution(expired.project,owner,{quoteId:eq.id,requestKey:randomUUID()}),{status:409});
  const competition=await fixture();await saveBudget(competition.workspace,owner,{monthlyLimitUsd:'0.06',paused:false});const cq1=await quote(competition),cq2=await quote(competition);const concurrent=await Promise.allSettled([startPromptExecution(competition.project,owner,{quoteId:cq1.id,requestKey:randomUUID()}),startPromptExecution(competition.project,owner,{quoteId:cq2.id,requestKey:randomUUID()})]);assert.equal(concurrent.filter(v=>v.status==='fulfilled').length,1);
  console.log('PASS second-child budget failure and enqueue failure roll back every reservation; concurrent budgets serialize');

  let before=paid;
  for(const changed of ['role','archive','credentials','price','cancel'] as const){
   const g=await fixture(),run=await start(g,editor);
   if(changed==='role')await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[g.workspace,editor]);
   if(changed==='archive')await setPromptArchived(g.project,owner,g.prompt.id,true,{requestId:randomUUID(),revision:1});
   if(changed==='credentials')await revokeProvider(g.workspace,owner,g.connectionId);
   if(changed==='price')priceChanged=true;
   if(changed==='cancel')await cancelPromptComparison(g.project,owner,run.id,{});
   await executePromptComparison(run.id,send);priceChanged=false;assert.equal(paid,before);assert.ok((await detail(g,run.id)).runs.every((r:any)=>r.status==='cancelled'));
  }
  const inFlight=await fixture(),inFlightRun=await start(inFlight,editor);let ready!:()=>void,release!:()=>void;
  const preflightReady=new Promise<void>(r=>ready=r),preflightGate=new Promise<void>(r=>release=r);
  const waiting=executePromptComparison(inFlightRun.id,async(...args)=>{if(String(args[0]).endsWith('/endpoints')){ready();await preflightGate;}return send(...args);});
  await preflightReady;await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[inFlight.workspace,editor]);release();await waiting;assert.equal(paid,before);assert.ok((await detail(inFlight,inFlightRun.id)).runs.every((r:any)=>r.status==='cancelled'));
  for(const kind of ['invalid','empty','over','byok'] as const){
   mode='ok';const g=await fixture(),run=await start(g);mode=kind;await executePromptComparison(run.id,send);const result=await detail(g,run.id);assert.equal(result.runs[0].chargeStatus,'settled');
   if(kind==='invalid'){assert.equal(result.runs[0].status,'failed');assert.ok(result.runs[0].diagnostic);}
   if(kind==='empty')assert.equal(result.runs[0].result.text,'');
   if(kind==='over'||kind==='byok'){assert.equal(result.runs[1].status,'cancelled');assert.equal((await getPromptExecutions(g.project,owner)).spendingPaused,true);}
  }
  console.log('PASS live role/archive/key/price/cancel gates, charged malformed or empty answers, overrun/BYOK stops remaining children');

  mode='ok';const uncertain=await fixture(),uncertainRun=await start(uncertain);mode='truncated';await executePromptComparison(uncertainRun.id,send);const unresolved=await detail(uncertain,uncertainRun.id),child=unresolved.runs[0];assert.equal(child.status,'uncertain');assert.ok(child.generationId);assert.equal(unresolved.runs[1].status,'cancelled');before=paid;await executePromptComparison(uncertainRun.id,send);assert.equal(paid,before);
  await saveBudget(uncertain.workspace,owner,{monthlyLimitUsd:'10',paused:false});await assert.rejects(start(uncertain),{status:409});
  await assert.rejects(reconcilePromptExecution(uncertain.project,editor,child.id,{},send),{status:404});
  for(const change of [{id:'gen-other'},{session_id:'foreign'},{external_user:'foreign'},{finish_reason:null},{total_cost:'0.01'}]){receiptChange=change;assert.equal((await reconcilePromptExecution(uncertain.project,owner,child.id,{},send)).reconciliation.status,'inconclusive');assert.equal((await ledger(child.id)).status,'uncertain');}
  receiptChange={};assert.equal((await reconcilePromptExecution(uncertain.project,owner,child.id,{},send)).reconciliation.status,'matched');const recovered=(await detail(uncertain,uncertainRun.id)).runs[0];assert.equal(recovered.status,'reconciled');assert.equal(recovered.result,null);assert.equal((await getPromptExecutions(uncertain.project,owner)).spendingPaused,true);assert.equal(paid,before);
  mode='ok';const missing=await fixture(),missingRun=await start(missing);mode='unknown';await executePromptComparison(missingRun.id,send);const noId=(await detail(missing,missingRun.id)).runs[0];const freeCount=free;assert.equal((await reconcilePromptExecution(missing.project,owner,noId.id,{},send)).reconciliation.status,'inconclusive');assert.equal(free,freeCount);
  const rotated=await fixture(),rotatedRun=await start(rotated),authBefore=process.env.AUTH_SECRET;
  const storedActor=(await pool.query('SELECT q.request_actor FROM prompt_comparison c JOIN prompt_execution_quote q ON q.id=c.quote_id WHERE c.id=$1',[rotatedRun.id])).rows[0].request_actor;
  try{process.env.AUTH_SECRET=randomBytes(32).toString('hex');mode='truncated';await executePromptComparison(rotatedRun.id,send);const item=(await detail(rotated,rotatedRun.id)).runs[0];assert.equal(receipts.get(item.generationId).external_user,storedActor);assert.equal((await reconcilePromptExecution(rotated.project,owner,item.id,{},send)).reconciliation.status,'matched');}finally{process.env.AUTH_SECRET=authBefore;}
  console.log('PASS captured generation recovery, exact owner/account/context evidence, no replay and no inferred missing charge');

  mode='ok';const crashed=await fixture(),cr=await start(crashed);await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[cr.runs[0].id]);await pool.query("UPDATE prompt_execution SET status='running',dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[cr.runs[0].id]);before=paid;await reconcilePromptExecutionJobs();const stopped=await detail(crashed,cr.id);assert.equal(stopped.runs[0].status,'uncertain');assert.equal(stopped.runs[1].status,'cancelled');assert.equal(paid,before);
  const evidence=(await pool.query('SELECT row_to_json(p) AS ledger,r.evidence FROM provider_request p JOIN prompt_execution r ON r.id=p.id WHERE p.id=$1',[done.runs[0].id])).rows[0];await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[done.id]);const policy=await getRetention(f.workspace,owner);const preview=await previewRetention(f.workspace,owner,{revision:policy.revision,settings:policy.settings});assert.equal(preview.promptEstimate.results,2);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=100 WHERE id=$1',[f.workspace]);await runRetentionBatch(f.project);assert.notEqual((await detail(f,done.id)).runs[0].result,null);await pool.query('UPDATE workspace SET raw_provider_evidence_days=90 WHERE id=$1',[f.workspace]);assert.equal((await runRetentionBatch(f.project))?.expiredPromptResults,2);assert.equal((await detail(f,done.id)).runs[0].resultExpired,true);assert.equal((await detail(f,done.id)).inputExpired,true);assert.equal((await detail(f,done.id)).messages,null);assert.deepEqual((await pool.query('SELECT row_to_json(p) AS ledger,r.evidence FROM provider_request p JOIN prompt_execution r ON r.id=p.id WHERE p.id=$1',[done.runs[0].id])).rows[0],evidence);
  console.log('PASS crash uncertainty, scoped retention preview and expiry preserve charge/quote/authored-version evidence');

  // A stale sweeper snapshot cannot overwrite a real result or its exact reported charge.
  const racing=await fixture(),race=await start(racing);let networkReady!:()=>void,releaseNetwork!:()=>void;
  const observed=new Promise<void>(r=>networkReady=r),networkGate=new Promise<void>(r=>releaseNetwork=r);
  const executing=executePromptComparison(race.id,async(...args)=>{if(String(args[0]).endsWith('/chat/completions')){networkReady();await networkGate;}return send(...args);});await observed;
  await pool.query("UPDATE prompt_execution SET dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[race.runs[0].id]);
  let sweepReady!:()=>void,releaseSweep!:()=>void;const snapshot=new Promise<void>(r=>sweepReady=r),sweepGate=new Promise<void>(r=>releaseSweep=r),originalQuery=pool.query;
  pool.query=(async(...args:any[])=>{const result=await (originalQuery as any).apply(pool,args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT r.*,c.quote_id')&&args[0].includes("r.status='running' AND r.dispatched_at<")){sweepReady();await sweepGate;}return result;}) as typeof pool.query;
  try{const sweeping=reconcilePromptExecutionJobs();await snapshot;releaseNetwork();await executing;const prior=(await (originalQuery as any).call(pool,'SELECT result,evidence,status FROM prompt_execution WHERE id=$1',[race.runs[0].id])).rows[0];releaseSweep();await sweeping;assert.deepEqual((await (originalQuery as any).call(pool,'SELECT result,evidence,status FROM prompt_execution WHERE id=$1',[race.runs[0].id])).rows[0],prior);assert.equal(prior.status,'completed');}finally{releaseNetwork();releaseSweep();pool.query=originalQuery;}

  // Quote payloads with no answer still require bounded cleanup and cannot make a batch falsely complete.
  const raw=await fixture(),rawRun=await start(raw);await cancelPromptComparison(raw.project,owner,rawRun.id,{});await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[rawRun.id]);
  const source=(await pool.query('SELECT * FROM prompt_comparison WHERE id=$1',[rawRun.id])).rows[0];
  const seed=await pool.connect();try{await seed.query('BEGIN');for(let n=0;n<101;n++){
   const qid=randomUUID(),cid=randomUUID(),rid=randomUUID();
   await seed.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,expires_at)
    SELECT $1,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,clock_timestamp()+interval '5 minutes' FROM prompt_execution_quote WHERE id=$2`,[qid,source.quote_id]);
   await seed.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,cancel_requested) VALUES($1,$2,$3,$4,$5,$6,true)',[cid,qid,raw.workspace,raw.project,owner,randomUUID()]);
   await seed.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,$5,'prompt.execute',$6,20429,'cancelled','2026-01-01')`,[rid,raw.workspace,raw.connectionId,owner,randomUUID(),'a'.repeat(64)]);
   await seed.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,completed_at)
    SELECT $1,$2,workspace_id,project_id,0,route,'cancelled',clock_timestamp()-interval '91 days' FROM prompt_execution WHERE id=$3`,[rid,cid,rawRun.runs[0].id]);
  }await seed.query('COMMIT');}finally{await seed.query('ROLLBACK').catch(()=>{});seed.release();}
  const rawPolicy=await getRetention(raw.workspace,owner);assert.equal((await previewRetention(raw.workspace,owner,{revision:rawPolicy.revision,settings:rawPolicy.settings})).promptEstimate.inputs,102);
  await pool.query(`CREATE FUNCTION fail_prompt_payload_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.input_purged_at IS NOT NULL AND OLD.input_purged_at IS NULL THEN RAISE EXCEPTION 'synthetic retention failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_prompt_payload_test BEFORE UPDATE ON prompt_execution_quote FOR EACH ROW EXECUTE FUNCTION fail_prompt_payload_test()');
  try{await assert.rejects(runRetentionBatch(raw.project));assert.equal((await pool.query('SELECT count(*)::int AS n FROM prompt_execution_quote WHERE project_id=$1 AND input_purged_at IS NULL',[raw.project])).rows[0].n,102);}finally{await pool.query('DROP TRIGGER fail_prompt_payload_test ON prompt_execution_quote');await pool.query('DROP FUNCTION fail_prompt_payload_test()');}
  const batch=await runRetentionBatch(raw.project);assert.equal(batch?.expiredPromptInputs,100);assert.equal(batch?.expiredPromptResults,0);assert.equal(batch?.complete,false);const last=await runRetentionBatch(raw.project);assert.equal(last?.expiredPromptInputs,2);assert.equal(last?.complete,true);
  assert.equal((await detail(raw,rawRun.id)).inputExpired,true);assert.equal((await pool.query('SELECT text FROM prompt_text_version WHERE id=$1',[raw.prompt.currentVersionId])).rows[0].text,'Exact original prompt');
  console.log('PASS stale crash snapshot, payload-only bounded retention, rollback and preserved authored prompts');

  const worker=await fixture(),wr=await start(worker);assert.equal((await pool.query('SELECT retry_limit FROM pgboss.job WHERE id=$1',[wr.id])).rows[0].retry_limit,0);await pool.query('UPDATE pgboss.job SET priority=100 WHERE id=$1',[wr.id]);globalThis.fetch=send;await startWorker();const deadline=Date.now()+15_000;while((await detail(worker,wr.id)).runs.some((r:any)=>['queued','running'].includes(r.status))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));await stopJobs();globalThis.fetch=blocked;assert.deepEqual((await detail(worker,wr.id)).runs.map((r:any)=>r.status),['completed','completed']);for(const r of wr.runs)assert.equal(sent.filter(v=>v===r.id).length,1);
  const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${owner}@execution.integration.test`,password})}));assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),endpoint=`${config.appUrl}/api/projects/${f.project}/prompt-executions`;
  assert.equal((await handleApi(new Request(endpoint))).status,401);const read=await handleApi(new Request(endpoint,{headers:{cookie}}));assert.equal(read.status,200);const text=await read.text();for(const secret of ['synthetic-never-live','key_fingerprint','encrypted_credentials'])assert.ok(!text.includes(secret));assert.equal((await handleApi(new Request(endpoint+'?unexpected=1',{headers:{cookie}}))).status,400);
  assert.equal((await handleApi(new Request(endpoint+'/quote',{method:'POST',headers:{cookie,origin:'https://foreign.test','content-type':'application/json'},body:'{}'}))).status,403);const keyToken=await createApiKey(f.workspace,owner,{name:'No execution permission',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+keyToken.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);
  console.log('PASS actual queue worker, cookie/Origin/API-key/current-membership enforcement and secret-free execution metadata');
 }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runPromptExecutionChecks();}finally{await closeDatabase();}}
