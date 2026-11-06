import {recoverOpportunities} from '../src/server/ai-opportunities-recovery.ts';
import {startOpportunities} from '../src/server/ai-opportunities-execution.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {refreshOpenRouterCatalog} from '../src/server/openrouter-models.ts';
import {readOpportunitiesSource} from '../src/server/ai-opportunities-source.ts';
import {prepareOpportunities,getOpportunitiesRun as getProductionRun,opportunitiesQueue} from '../src/server/ai-opportunities.ts';

const model='openai/gpt-4o-mini';
export async function runAiOpportunitiesRecoveryChecks(getOpportunitiesRun=getProductionRun){

 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_RECOVERY_TEST,'1');
 const database=new URL(getConfig().databaseUrl);assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_opportunities_recovery_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_opportunities_recovery_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
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

 const boss=await getBoss();await boss.createQueue(opportunitiesQueue);let contexts=0,reads=0;
 async function queued(){assert.ok(++contexts<=24);const f=await fixture(),execution=await answer(f),p=await prepareOpportunities(f.project,owner,await input(f),send),run=await startOpportunities(f.project,owner,{preparationId:p.id,requestId:randomUUID()});return {...f,execution,preparationId:p.id,runId:run.runId};}
 type Queued=Awaited<ReturnType<typeof queued>>;
 const state=async(id:string)=>(await pool.query('SELECT r.*,p.status AS request_status,p.provider_reference FROM ai_opportunity_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1',[id])).rows[0];
 async function uncertain(){const f=await queued();await pool.query("UPDATE provider_request SET status='uncertain',provider_reference=$2 WHERE id=$1",[f.runId,'gen-'+f.runId]);await pool.query("UPDATE ai_opportunity_run SET status='uncertain',generation_id=$2,dispatched_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1",[f.runId,'gen-'+f.runId]);return f;}
 async function rotate(f:Queued,key='synthetic-not-live'){const revision=(await pool.query('SELECT revision FROM provider_connection WHERE id=$1',[f.connection])).rows[0].revision+1;const encrypted=encryptCredentials({apiKey:key},{id:f.connection,workspaceId:f.workspace,provider:'openrouter',revision});await pool.query("UPDATE provider_connection SET revision=$2,encrypted_credentials=$3,check_status='ok',revoked_at=NULL WHERE id=$1",[f.connection,revision,JSON.stringify(encrypted)]);}
 const action=()=>({requestId:randomUUID()});
 const refused=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
 function metadataFor(f:Queued,alter?:(data:Record<string,unknown>)=>void,during?:()=>Promise<void>):typeof fetch{return async(url,init)=>{
  assert.ok(++reads+metadata<=100);assert.equal(init?.method,undefined);assert.equal(String(url),'https://openrouter.ai/api/v1/generation?id=gen-'+f.runId);
  const r=await state(f.runId),q=(await pool.query('SELECT request_actor FROM ai_opportunity_preparation WHERE id=$1',[f.preparationId])).rows[0];
  const data:Record<string,unknown>={id:r.generation_id,model,provider_name:'OpenAI',session_id:f.runId,external_user:q.request_actor,created_at:r.dispatched_at.toISOString(),finish_reason:'stop',tokens_prompt:31,tokens_completion:17,cost:999,apiKey:'never return this'};
  alter?.(data);if(during)await during();return Response.json({data});
 };}
 async function noReceipt(requestId:string){assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[requestId])).rowCount,0);}
 async function unresolved(f:Queued){const r=await state(f.runId);assert.equal(r.status,'uncertain');assert.equal(r.request_status,'uncertain');assert.equal(r.proposal,null);assert.equal(r.raw_result,null);}
 try{
  const f=await uncertain(),request=action(),before=(await pool.query('SELECT input_hash,business_input_hash,request_actor,connection_revision FROM ai_opportunity_preparation WHERE id=$1',[f.preparationId])).rows[0];
  await rotate(f);const secret=process.env.AUTH_SECRET;process.env.AUTH_SECRET='rotated-synthetic-auth-secret-at-least-thirty-two-characters';
  try{assert.equal((await getOpportunitiesRun(f.project,owner,f.runId)).run.canRecover,true);assert.deepEqual(await recoverOpportunities(f.project,owner,f.runId,request,metadataFor(f)),{runId:f.runId,replayed:false});}finally{process.env.AUTH_SECRET=secret;}
  const recovered=await state(f.runId);assert.equal(recovered.status,'failed');assert.equal(recovered.request_status,'settled');assert.equal(recovered.provider_reference,'gen-'+f.runId);assert.equal(recovered.prompt_tokens,31);assert.equal(recovered.completion_tokens,17);for(const field of ['raw_result','proposal','result_hash'])assert.equal(recovered[field],null);
  assert.deepEqual(Object.keys(recovered.request_evidence).sort(),['completionTokens','generationId','promptTokens','source']);assert.deepEqual((await pool.query('SELECT input_hash,business_input_hash,request_actor,connection_revision FROM ai_opportunity_preparation WHERE id=$1',[f.preparationId])).rows[0],before);
  const used=reads;assert.deepEqual(await recoverOpportunities(f.project,owner,f.runId,request,metadataFor(f)),{runId:f.runId,replayed:true});assert.equal(reads,used);assert.equal((await getOpportunitiesRun(f.project,owner,f.runId)).run.canRecover,false);
  const other=await uncertain();await assert.rejects(recoverOpportunities(f.project,owner,other.runId,request,metadataFor(other)),refused(409));await assert.rejects(recoverOpportunities(other.project,owner,other.runId,{...action(),extra:true},metadataFor(other)),refused(400));
  console.log('PASS exact original identity, checked same-key newer revision, rotated authentication secret, strict receipt, useful usage and no report reconstruction');

  for(const when of ['before','during'])for(const mutation of ['key','unverified','revoked','revision','owner']){
   const f=await uncertain(),request=action(),prior=reads;
   const mutate=async()=>{if(mutation==='key')await rotate(f,'different-synthetic-key');if(mutation==='revision')await rotate(f);if(mutation==='unverified')await pool.query("UPDATE provider_connection SET check_status='error' WHERE id=$1",[f.connection]);if(mutation==='revoked')await pool.query('UPDATE provider_connection SET revoked_at=clock_timestamp() WHERE id=$1',[f.connection]);if(mutation==='owner')await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,owner]);};
   if(when==='before')await mutate();
   if(when==='before'&&mutation==='revision'){assert.equal((await getOpportunitiesRun(f.project,owner,f.runId)).run.canRecover,true);await recoverOpportunities(f.project,owner,f.runId,request,metadataFor(f));continue;}
   if(when==='before'&&mutation!=='owner')assert.equal((await getOpportunitiesRun(f.project,owner,f.runId)).run.canRecover,false);
   await assert.rejects(recoverOpportunities(f.project,owner,f.runId,request,metadataFor(f,undefined,when==='during'?mutate:undefined)),error=>!!error&&typeof error==='object'&&'status'in error&&[403,404,409].includes(Number(error.status)));
   assert.equal(reads,prior+(when==='during'?1:0));await unresolved(f);await noReceipt(request.requestId);
  }
  const denied=await uncertain();for(const user of [viewer,foreign])await assert.rejects(recoverOpportunities(denied.project,user,denied.runId,action(),metadataFor(denied)),refused(user===viewer?403:404));
  await assert.rejects(recoverOpportunities(denied.project,owner,f.runId,action(),metadataFor(f)),refused(404));
  console.log('PASS wrong/unverified/revoked keys, revision and owner changes before/during metadata; member and foreign access denied');

  const malformed=await uncertain();for(const field of ['id','model','provider_name','session_id','external_user','created_at','finish_reason'])for(const mode of ['missing','wrong']){
   const request=action();await assert.rejects(recoverOpportunities(malformed.project,owner,malformed.runId,request,metadataFor(malformed,data=>{if(mode==='missing')delete data[field];else data[field]=field==='created_at'?'2000-01-01T00:00:00Z':field==='finish_reason'?'in_progress':'wrong';})),refused(409));await unresolved(malformed);await noReceipt(request.requestId);
  }
  await assert.rejects(recoverOpportunities(malformed.project,owner,malformed.runId,action(),async()=>{assert.ok(++reads+metadata<=100);throw Error('Synthetic unavailable metadata');}),refused(409));
  const originalGeneration=(await state(malformed.runId)).generation_id;await pool.query('UPDATE ai_opportunity_run SET generation_id=NULL WHERE id=$1',[malformed.runId]);const prior=reads;await assert.rejects(recoverOpportunities(malformed.project,owner,malformed.runId,action(),metadataFor(malformed)),refused(409));assert.equal(reads,prior);await pool.query('UPDATE ai_opportunity_run SET generation_id=$2 WHERE id=$1',[malformed.runId,originalGeneration]);
  await pool.query("UPDATE provider_request SET input_hash=repeat('f',64) WHERE id=$1",[malformed.runId]);await assert.rejects(recoverOpportunities(malformed.project,owner,malformed.runId,action(),metadataFor(malformed)),refused(409));assert.equal(reads,prior);
  const independent=await uncertain();await recoverOpportunities(independent.project,owner,independent.runId,action(),metadataFor(independent));await unresolved(malformed);
  console.log('PASS missing/wrong generation, model, provider, session, actor, time and finish evidence; unavailable metadata and mismatched ledger remain isolated');

  const concurrent=await uncertain(),same=action();let arrived=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const concurrentSend=metadataFor(concurrent,undefined,async()=>{if(++arrived===2)release();await gate;});
  const concurrentResults=await Promise.all([recoverOpportunities(concurrent.project,owner,concurrent.runId,same,concurrentSend),recoverOpportunities(concurrent.project,owner,concurrent.runId,same,concurrentSend)]);assert.deepEqual(concurrentResults.map(r=>r.replayed).sort(),[false,true]);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[same.requestId])).rowCount,1);
  const expired=await uncertain();await pool.query("UPDATE ai_opportunity_preparation SET raw_expired_at=clock_timestamp(),unavailable_reason='input_expired',source_input=NULL,snapshot=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1",[expired.preparationId]);const saved=(await pool.query('SELECT input_hash,business_input_hash,raw_expired_at,input_purged_at,unavailable_reason FROM ai_opportunity_preparation WHERE id=$1',[expired.preparationId])).rows[0];
  await updateProjectContext(expired.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',name:'Changed context'}]});await recoverOpportunities(expired.project,owner,expired.runId,action(),metadataFor(expired));const history=await getOpportunitiesRun(expired.project,viewer,expired.runId);assert.equal(history.run.status,'failed');assert.equal(history.run.report,null);assert.equal(history.run.savedEvidence,null);assert.equal(history.run.available,false);assert.deepEqual((await pool.query('SELECT input_hash,business_input_hash,raw_expired_at,input_purged_at,unavailable_reason FROM ai_opportunity_preparation WHERE id=$1',[expired.preparationId])).rows[0],saved);
  assert.equal(outbound,0);assert.ok(contexts<=24);assert.ok(reads+metadata<=100);console.log(`PASS concurrent same-action replay, expired/purged evidence and changed context settle without report restoration; ${contexts} contexts, ${reads+metadata} synthetic GETs, zero inference POSTs/external requests`);
 }finally{globalThis.fetch=original;await stopJobs();}
}
if(import.meta.main){try{await runAiOpportunitiesRecoveryChecks();}finally{await stopJobs();await closeDatabase();}}
