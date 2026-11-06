import {executeOpportunities as executeProduction,reconcileOpportunitiesJobs as reconcileProduction} from '../src/server/ai-opportunities-worker.ts';
import {startOpportunities} from '../src/server/ai-opportunities-execution.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import assert from 'node:assert/strict';
import {randomUUID,Hash} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {refreshOpenRouterCatalog} from '../src/server/openrouter-models.ts';
import {readOpportunitiesSource} from '../src/server/ai-opportunities-source.ts';
import {prepareOpportunities,opportunitiesQueue} from '../src/server/ai-opportunities.ts';

const model='openai/gpt-4o-mini';
export async function runAiOpportunitiesDispatchChecks(worker={executeOpportunities:executeProduction,reconcileOpportunitiesJobs:reconcileProduction}){
 const {executeOpportunities,reconcileOpportunitiesJobs}=worker;
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_DISPATCH_TEST,'1');
 const database=new URL(getConfig().databaseUrl);assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_opportunities_dispatch_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_opportunities_dispatch_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
 for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const original=globalThis.fetch;let outbound=0,metadata=0;globalThis.fetch=async()=>{outbound++;throw Error('External requests are forbidden.');};
 const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID();for(const user of [owner,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Preparation fixture\',$2)',[user,`${user}@opportunities.integration.test`]);
 const today=new Date().toISOString().slice(0,10),scope={from:new Date(Date.now()-86400000).toISOString().slice(0,10),to:today,timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1' as const};
 const endpoint=()=>({data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:100000,max_completion_tokens:8192,supported_parameters:['max_tokens','response_format','structured_outputs']}]}});
 const send:typeof fetch=async(url,init)=>{metadata++;assert.ok(metadata<=100);assert.equal(init?.method,undefined);if(String(url).endsWith('/key'))return Response.json({data:{is_free_tier:false,is_management_key:false}});assert.equal(String(url),`https://openrouter.ai/api/v1/models/${model}/endpoints`);return Response.json(endpoint());};
 await refreshOpenRouterCatalog(async()=>Response.json({data:[{id:model,canonical_slug:model,name:model,context_length:128000,top_provider:{max_completion_tokens:8192},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','response_format','structured_outputs']}],total_count:1,links:{next:null}}));
 async function fixture(){const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Preparation fixture')",[workspace]);for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  const credentials=encryptCredentials({apiKey:'synthetic-not-live'},{id:connection,workspaceId:workspace,provider:'openrouter',revision:1});await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name,encrypted_credentials,check_status)VALUES($1,$2,'openrouter','Synthetic',$3,'ok')",[connection,workspace,JSON.stringify(credentials)]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Which product should I choose?',enabled:false}]})).items[0];await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme'}]});return {workspace,project,connection,prompt};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function answer(f:Fixture,text='Acme is mentioned.'){
  const id=randomUUID(),input={connectionId:f.connection,promptId:f.prompt.id,versionId:f.prompt.currentVersionId,systemText:'',models:[model],maxCompletionTokens:1024},messages=[{role:'user',content:f.prompt.text}],route={model,tag:'openai',providerName:'OpenAI'};
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,created_at,expires_at,request_version)VALUES($1,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),$8,$9,'[]',repeat('c',64),clock_timestamp()-interval '3 seconds',clock_timestamp()+interval '5 minutes',1)`,[id,f.workspace,f.project,owner,f.prompt.id,f.prompt.currentVersionId,f.connection,JSON.stringify(input),JSON.stringify(messages)]);
  await pool.query("INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at)VALUES($1,$1,$2,$3,$4,$1,clock_timestamp()-interval '2 seconds')",[id,f.workspace,f.project,owner]);await pool.query("INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,status)VALUES($1,$2,$3,1,$4,$1,'fixture.answer',repeat('d',64),'settled')",[id,f.workspace,f.connection,owner]);
  await pool.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at)VALUES($1,$1,$2,$3,0,$4,'completed',$5,clock_timestamp()-interval '1 second')",[id,f.workspace,f.project,JSON.stringify(route),JSON.stringify({text,resolvedModel:model,provider:'OpenAI',finishReason:'stop',citations:[]})]);return id;
 }
 const input=async(f:Fixture)=>({requestId:randomUUID(),connectionId:f.connection,model,expectedSource:(await readOpportunitiesSource(f.project,owner,scope)).snapshot.source});

 const boss=await getBoss();await boss.createQueue(opportunitiesQueue);let inference=0;
 async function queued(){const f=await fixture(),execution=await answer(f),p=await prepareOpportunities(f.project,owner,await input(f),send),run=await startOpportunities(f.project,owner,{preparationId:p.id,requestId:randomUUID()});return {...f,execution,preparationId:p.id,runId:run.runId};}
 type Queued=Awaited<ReturnType<typeof queued>>;
 const state=async(id:string)=>(await pool.query('SELECT r.*,p.status AS request_status,p.provider_reference FROM ai_opportunity_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1',[id])).rows[0];
 const valid=(f:Queued,empty=false)=>({version:1,summary:['Retained answer evidence.'],opportunities:empty?[]:[{category:'creation',priority:1,title:'Explain the product choice',why:'The supplied answer mentions this brand.',promptIds:[f.prompt.id],evidenceIds:[],targetEvidenceId:null}],risks:[]});
 function transport(f:Queued,mode='valid',during?:()=>Promise<void>):typeof fetch{return async(url,init)=>{
  if(!String(url).endsWith('/chat/completions')){if(mode==='route'&&String(url).endsWith('/endpoints')){metadata++;const altered=endpoint();altered.data.endpoints[0].max_completion_tokens=8000;return Response.json(altered);}return send(url,init);}
  inference++;assert.ok(inference+metadata<=100);assert.equal(init?.method,'POST');const body=JSON.parse(String(init.body));assert.equal(body.session_id,f.runId);assert.equal(body.max_completion_tokens,4096);assert.equal(body.service_tier,'default');const before=await state(f.runId);assert.equal(before.status,'running');assert.equal(before.request_status,'dispatched');assert.equal(body.user,(await pool.query('SELECT request_actor FROM ai_opportunity_preparation WHERE id=$1',[f.preparationId])).rows[0].request_actor);
  if(during)await during();if(mode==='lost')throw Error('Synthetic lost response');const generation='gen-'+f.runId;
  if(mode==='receipt-only')return new Response('{',{headers:{'x-generation-id':generation}});
  const text=mode==='malformed'?'{':mode==='oversized'?'x'.repeat(65537):JSON.stringify(valid(f,mode==='empty'));
  return Response.json({id:generation,model,provider:'OpenAI',created:Math.floor(Date.now()/1000),usage:{prompt_tokens:12,completion_tokens:8,cost:999},choices:[{finish_reason:mode==='truncated'?'length':'stop',message:{content:text}}]},{headers:{'x-generation-id':mode==='bad-receipt'?'invalid':generation}});
 };}
 async function spy<T>(before:(text:string)=>void,work:()=>Promise<T>){const c=await pool.connect(),prototype=Object.getPrototypeOf(c) as {query:typeof c.query},query=prototype.query;c.release();prototype.query=(function(this:typeof c,...args:unknown[]){if(typeof args[0]==='string')before(args[0]);return(query as(...a:unknown[])=>unknown).apply(this,args);}) as typeof c.query;try{return await work();}finally{prototype.query=query;}}
 try{
  for(const mode of ['valid','empty','malformed','truncated','oversized']){const f=await queued(),before=inference;await Promise.all([executeOpportunities(f.runId,transport(f,mode)),executeOpportunities(f.runId,transport(f,mode))]);const r=await state(f.runId);assert.equal(inference,before+1);assert.equal(r.request_status,'settled');assert.equal(r.status,['valid','empty'].includes(mode)?'completed':'failed');assert.equal(r.prompt_tokens,12);assert.equal(r.completion_tokens,8);assert.equal(r.request_evidence.cost,undefined);assert.equal(r.lease_owner,null);if(mode==='empty')assert.equal(r.proposal.opportunities.length,0);if(r.status==='completed'){assert.ok(r.raw_result&&r.result_hash);assert.equal(r.proposal.evidenceValidation,'supplied-api-evidence-ids-v1');}else assert.equal(r.proposal,null);await executeOpportunities(f.runId,transport(f));assert.equal(inference,before+1);}
  console.log('PASS single dispatch, fixed request identity, valid/empty results, malformed/truncated/oversized output and useful nonmonetary usage');

  for(const mutation of ['owner','key','source','route','retention','pause']){const f=await queued(),before=inference;
   if(mutation==='owner')await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,owner]);
   if(mutation==='key')await pool.query('UPDATE provider_connection SET revision=revision+1 WHERE id=$1',[f.connection]);
   if(mutation==='source')await answer(f,'New source answer.');
   if(mutation==='retention')await pool.query('UPDATE workspace SET retention_revision=retention_revision+1 WHERE id=$1',[f.workspace]);
   if(mutation==='pause')await pool.query('INSERT INTO workspace_provider_control(workspace_id,paused)VALUES($1,true)',[f.workspace]);
   let broad=0;await spy(sql=>{if(mutation==='owner'&&sql.includes('pg_timezone_names'))broad++;},()=>executeOpportunities(f.runId,transport(f,mutation==='route'?'route':'valid')));assert.equal(inference,before);assert.equal((await state(f.runId)).status,'cancelled');assert.equal((await state(f.runId)).request_status,'cancelled');assert.equal(broad,0);
  }
  console.log('PASS owner/key/source/route/retention admission changes and operational pause before dispatch');

  for(const mutation of ['owner','key','source','route','retention']){const f=await queued();let changed=false,broad=0;await spy(sql=>{if(changed&&mutation==='owner'&&sql.includes('pg_timezone_names'))broad++;},()=>executeOpportunities(f.runId,transport(f,'valid',async()=>{if(mutation==='owner')await pool.query("DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2",[f.workspace,owner]);if(mutation==='key')await pool.query('UPDATE provider_connection SET revision=revision+1 WHERE id=$1',[f.connection]);if(mutation==='source')await answer(f,'Changed while running.');if(mutation==='route')await pool.query("UPDATE ai_opportunity_preparation SET route=jsonb_set(route,'{completionCapacity}','7000') WHERE id=$1",[f.preparationId]);if(mutation==='retention')await pool.query('UPDATE workspace SET retention_revision=retention_revision+1 WHERE id=$1',[f.workspace]);changed=true;})));const r=await state(f.runId);assert.equal(r.request_status,'settled');assert.equal(r.status,'failed');assert.equal(r.proposal,null);assert.equal(r.raw_result,null);assert.equal(r.prompt_tokens,12);assert.equal(r.completion_tokens,8);assert.equal(broad,0);}
  console.log('PASS independent known settlement after authority/key/source/route/retention changes with no broad read after owner loss');

  for(const mode of ['receipt-only','bad-receipt']){const f=await queued(),before=inference;await executeOpportunities(f.runId,transport(f,mode));const r=await state(f.runId);assert.equal(r.status,'uncertain');assert.equal(r.request_status,'uncertain');assert.equal(r.generation_id,mode==='receipt-only'?'gen-'+f.runId:null);assert.equal(r.provider_reference,r.generation_id);await executeOpportunities(f.runId,transport(f));assert.equal(inference,before+1);}
  const crash=await queued();let interrupted=false;await assert.rejects(spy(sql=>{if(!interrupted&&sql.startsWith('UPDATE ai_opportunity_run SET status=$2,generation_id')){interrupted=true;throw Error('Synthetic settlement interruption.');}},()=>executeOpportunities(crash.runId,transport(crash))),/Synthetic settlement interruption/);assert.equal(interrupted,true);const pending=await state(crash.runId);assert.equal(pending.status,'running');assert.equal(pending.request_status,'dispatched');assert.equal(pending.generation_id,'gen-'+crash.runId);
  await pool.query("UPDATE ai_opportunity_run SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[crash.runId]);const calls=inference;await reconcileOpportunitiesJobs();assert.equal((await state(crash.runId)).status,'uncertain');assert.equal((await state(crash.runId)).request_status,'uncertain');assert.equal((await state(crash.runId)).generation_id,pending.generation_id);await executeOpportunities(crash.runId,transport(crash));assert.equal(inference,calls);
  const noReceipt=await queued();await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[noReceipt.runId]);await pool.query("UPDATE ai_opportunity_run SET status='running',dispatched_at=clock_timestamp(),lease_owner=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[noReceipt.runId,randomUUID()]);await reconcileOpportunitiesJobs();assert.equal((await state(noReceipt.runId)).status,'uncertain');assert.equal((await state(noReceipt.runId)).generation_id,null);assert.equal(inference,calls);
  const failedJob=await queued();await pool.query("UPDATE pgboss.job SET state='failed' WHERE id=$1",[failedJob.runId]);await reconcileOpportunitiesJobs();assert.equal((await state(failedJob.runId)).status,'cancelled');assert.equal((await state(failedJob.runId)).request_status,'cancelled');assert.equal(outbound,0);
  console.log('PASS callback receipt preservation, malformed receipt, crash before/after receipt and queued-job reconciliation without inference replay');

  const f=await fixture(),execution=await answer(f);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=1 WHERE id=$1',[f.workspace]);
  await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '24 hours'+interval '5 seconds' WHERE id=$1",[execution]);
  await pool.query("UPDATE prompt_comparison c SET created_at=e.completed_at-interval '1 second' FROM prompt_execution e WHERE e.id=$1 AND c.id=e.id",[execution]);
  await pool.query("UPDATE prompt_execution_quote q SET created_at=e.completed_at-interval '2 seconds' FROM prompt_execution e WHERE e.id=$1 AND q.id=e.id",[execution]);
  const preparation=await prepareOpportunities(f.project,owner,await input(f),send),started=await startOpportunities(f.project,owner,{preparationId:preparation.id,requestId:randomUUID()}),boundary={...f,execution,preparationId:preparation.id,runId:started.runId};
  const remaining=(await pool.query<{ms:number}>("SELECT EXTRACT(EPOCH FROM(completed_at+interval '24 hours'-clock_timestamp()))::double precision*1000 AS ms FROM prompt_execution WHERE id=$1",[execution])).rows[0].ms,deadline=performance.now()+remaining;
  assert.ok(remaining>500&&remaining<5000,'The source must still be live before dispatch.');
  const originalUpdate=Hash.prototype.update,originalDigest=Hash.prototype.digest,reportHashes=new WeakSet<Hash>();let crossed=false;
  // Report hashing occurs after current-source validation and proposal parsing.
  // Waiting after the actual digest targets the gap before the publication latch,
  // without altering source rows, policy, SQL results or the production worker.
  Hash.prototype.update=(function(this:Hash,...args:unknown[]){const data=args[0];if(typeof data==='string'&&data.includes('"evidenceValidation":"supplied-api-evidence-ids-v1"')&&data.includes('"semanticConclusions":"unverified"'))reportHashes.add(this);return(originalUpdate as(...a:unknown[])=>Hash).apply(this,args);}) as typeof originalUpdate;
  Hash.prototype.digest=(function(this:Hash,...args:unknown[]){const value=(originalDigest as(...a:unknown[])=>unknown).apply(this,args);if(reportHashes.has(this)){assert.equal(crossed,false);assert.ok(performance.now()<deadline,'Earlier validation must finish before expiry.');crossed=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(0,deadline-performance.now())+150);}return value;}) as typeof originalDigest;
  try{await executeOpportunities(boundary.runId,transport(boundary));}finally{Hash.prototype.update=originalUpdate;Hash.prototype.digest=originalDigest;}
  assert.equal(crossed,true,'The validated report hash must be reached before the final latch.');
  const expired=await state(boundary.runId);assert.equal(expired.request_status,'settled');assert.equal(expired.status,'failed');assert.equal(expired.prompt_tokens,12);assert.equal(expired.completion_tokens,8);assert.equal(expired.generation_id,'gen-'+boundary.runId);
  for(const field of ['proposal','raw_result','result_hash'])assert.equal(expired[field],null,field);
  const latched=(await pool.query('SELECT raw_expired_at,unavailable_reason,business_input_hash,input_hash FROM ai_opportunity_preparation WHERE id=$1',[preparation.id])).rows[0];assert.ok(latched.raw_expired_at);assert.equal(latched.unavailable_reason,'input_expired');
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=90 WHERE id=$1',[f.workspace]);const priorCalls=inference;await executeOpportunities(boundary.runId,transport(boundary));await reconcileOpportunitiesJobs();
  assert.equal(inference,priorCalls);assert.deepEqual(await state(boundary.runId),expired);assert.deepEqual((await pool.query('SELECT raw_expired_at,unavailable_reason,business_input_hash,input_hash FROM ai_opportunity_preparation WHERE id=$1',[preparation.id])).rows[0],latched);assert.equal(outbound,0);
  console.log('PASS source expiry after validated report hashing blocks publication permanently while preserving known settlement');
 }finally{globalThis.fetch=original;await stopJobs();}
}
if(import.meta.main){try{await runAiOpportunitiesDispatchChecks();}finally{await stopJobs();await closeDatabase();}}
