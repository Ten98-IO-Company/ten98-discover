import {startOpportunities,cancelOpportunities} from '../src/server/ai-opportunities-execution.ts';
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
import {opportunityPreparationRow,opportunityIdentity} from '../src/server/ai-opportunities-rows.ts';
import {prepareOpportunities,opportunitiesQueue,withOpportunitiesProject} from '../src/server/ai-opportunities.ts';

const model='openai/gpt-4o-mini';
export async function runAiOpportunitiesAdmissionChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_ADMISSION_TEST,'1');
 const database=new URL(getConfig().databaseUrl);assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_opportunities_admission_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_opportunities_admission_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
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

 const prepare=async(f:Fixture)=>prepareOpportunities(f.project,owner,await input(f),send);
 const startInput=(preparationId:string)=>({preparationId,requestId:randomUUID()});
 const state=async(id:string)=>(await pool.query('SELECT r.status,r.dispatched_at,p.status AS request_status,p.operation,p.connection_revision FROM ai_opportunity_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1',[id])).rows[0];
 const counts=async(projectId:string)=>(await pool.query(`SELECT (SELECT count(*)::int FROM ai_opportunity_run WHERE project_id=$1) AS runs,(SELECT count(*)::int FROM project_content_request WHERE project_id=$1 AND operation='ai.opportunities.start') AS receipts,(SELECT count(*)::int FROM provider_request p JOIN ai_opportunity_preparation q ON q.input_hash=p.input_hash WHERE q.project_id=$1 AND p.operation='ai.opportunities.semantic') AS requests`,[projectId])).rows[0];
 const boss=await getBoss();await boss.createQueue(opportunitiesQueue);
 try{
  const f=await fixture();await answer(f);const p=await prepare(f),request=startInput(p.id),other=await fixture();await answer(other);const op=await prepare(other);
  await assert.rejects(startOpportunities(f.project,viewer,request),{status:403});await assert.rejects(startOpportunities(f.project,foreign,request),{status:404});await assert.rejects(startOpportunities(f.project,owner,startInput(op.id)),{status:404});
  await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[f.workspace,foreign]);await assert.rejects(startOpportunities(f.project,foreign,request),{status:404});
  const calls=metadata,pair=await Promise.all([startOpportunities(f.project,owner,request),startOpportunities(f.project,owner,request)]);assert.equal(pair[0].runId,pair[1].runId);assert.equal(pair.filter(r=>r.replayed).length,1);assert.equal(metadata,calls);
  const run=pair[0].runId;assert.deepEqual(await counts(f.project),{runs:1,receipts:1,requests:1});assert.equal((await state(run)).status,'queued');assert.equal((await state(run)).request_status,'reserved');assert.equal((await state(run)).operation,'ai.opportunities.semantic');const job=await boss.getJobById(opportunitiesQueue,run);assert.ok(job);assert.equal(job.retryLimit,0);assert.equal(job.state,'created');assert.deepEqual(job.data,{runId:run});
  assert.deepEqual(await startOpportunities(f.project,owner,request),{runId:run,replayed:true});await assert.rejects(startOpportunities(f.project,owner,{...request,preparationId:op.id}),{status:409});await assert.rejects(startOpportunities(f.project,owner,startInput(p.id)),{status:409});
  const p2=await prepare(f);await assert.rejects(startOpportunities(f.project,owner,startInput(p2.id)),{status:409});
  const cancel={requestId:randomUUID()};await assert.rejects(cancelOpportunities(f.project,viewer,run,cancel),{status:403});await assert.rejects(cancelOpportunities(other.project,owner,run,cancel),{status:404});assert.deepEqual(await cancelOpportunities(f.project,owner,run,cancel),{runId:run,replayed:false});assert.deepEqual(await cancelOpportunities(f.project,owner,run,cancel),{runId:run,replayed:true});assert.equal((await state(run)).status,'cancelled');assert.equal((await state(run)).request_status,'cancelled');
  const distinct=await Promise.allSettled([startOpportunities(f.project,owner,startInput(p2.id)),startOpportunities(f.project,owner,startInput((await prepare(f)).id))]);assert.equal(distinct.filter(r=>r.status==='fulfilled').length,1);const winner=distinct.find(r=>r.status==='fulfilled')!;assert.equal(winner.status,'fulfilled');const active=winner.value.runId;
  await assert.rejects(cancelOpportunities(f.project,owner,active,cancel),{status:409});await cancelOpportunities(f.project,owner,active,{requestId:randomUUID()});
  console.log('PASS authorization, foreign preparation/initiator, exact/concurrent replay, one active run, transactional queue and cancellation receipts');

  const unknown=await fixture();await answer(unknown);const up=await prepare(unknown),ur=await startOpportunities(unknown.project,owner,startInput(up.id));
  await pool.query("UPDATE provider_request SET status='uncertain' WHERE id=$1",[ur.runId]);await pool.query("UPDATE ai_opportunity_run SET status='uncertain',dispatched_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1",[ur.runId]);
  await pool.query("UPDATE ai_opportunity_preparation SET raw_expired_at=clock_timestamp(),unavailable_reason='input_expired',source_input=NULL,snapshot=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1",[up.id]);
  const equivalent=await prepare(unknown);await assert.rejects(startOpportunities(unknown.project,owner,startInput(equivalent.id)),{status:409});assert.equal((await counts(unknown.project)).runs,1);
  await assert.rejects(cancelOpportunities(unknown.project,owner,ur.runId,{requestId:randomUUID()}),{status:409});await answer(unknown,'A distinct new answer.');const changed=await prepare(unknown);assert.equal((await state((await startOpportunities(unknown.project,owner,startInput(changed.id))).runId)).status,'queued');
  const unrelated=await startOpportunities(other.project,owner,startInput(op.id));assert.equal((await state(unrelated.runId)).status,'queued');
  console.log('PASS unknown equivalent business identity after purge, distinct business and unrelated project admission');

  for(const mutation of ['key','source','retention','expired','paused'] as const){const f=await fixture(),execution=await answer(f);if(mutation==='expired'){await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[execution]);await pool.query("UPDATE prompt_comparison SET created_at=clock_timestamp()-interval '10 minutes 1 second' WHERE id=$1",[execution]);await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes 2 seconds' WHERE id=$1",[execution]);}const p=await prepare(f),req=startInput(p.id);
   if(mutation==='key'){const encrypted=encryptCredentials({apiKey:'synthetic-rotated'},{id:f.connection,workspaceId:f.workspace,provider:'openrouter',revision:2});await pool.query('UPDATE provider_connection SET revision=2,encrypted_credentials=$2 WHERE id=$1',[f.connection,JSON.stringify(encrypted)]);}
   if(mutation==='source')await answer(f,'Changed population.');
   if(mutation==='retention')await pool.query('UPDATE workspace SET retention_revision=retention_revision+1 WHERE id=$1',[f.workspace]);
   if(mutation==='expired')await withOpportunitiesProject(f.project,owner,true,async c=>{await c.query("UPDATE ai_opportunity_preparation SET created_at=created_at-interval '6 minutes',expires_at=expires_at-interval '6 minutes' WHERE id=$1",[p.id]);const q=await opportunityPreparationRow(c,f.project,p.id);await c.query('UPDATE ai_opportunity_preparation SET input_hash=$2 WHERE id=$1',[p.id,opportunityIdentity(q)]);});
   if(mutation==='paused')await pool.query('INSERT INTO workspace_provider_control(workspace_id,paused)VALUES($1,true)',[f.workspace]);
   await assert.rejects(startOpportunities(f.project,owner,req),error=>!!error&&typeof error==='object'&&'status'in error&&[409,410].includes(Number(error.status)));assert.deepEqual(await counts(f.project),{runs:0,receipts:0,requests:0});
  }
  const rollback=await fixture();await answer(rollback);const rp=await prepare(rollback),req=startInput(rp.id),originalSend=boss.send;let rolledBackJob:string|null=null;boss.send=(async(...args:unknown[])=>{rolledBackJob=await(originalSend as(...a:unknown[])=>Promise<string|null>).apply(boss,args);throw Error('Synthetic failure after transactional job insert.');}) as typeof boss.send;
  try{await assert.rejects(startOpportunities(rollback.project,owner,req),/Synthetic failure/);}finally{boss.send=originalSend;}assert.ok(rolledBackJob);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[rolledBackJob])).rowCount,0);assert.deepEqual(await counts(rollback.project),{runs:0,receipts:0,requests:0});const retried=await startOpportunities(rollback.project,owner,req);assert.equal(retried.replayed,false);
  await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[retried.runId]);await assert.rejects(cancelOpportunities(rollback.project,owner,retried.runId,{requestId:randomUUID()}),{status:409});assert.equal((await state(retried.runId)).request_status,'dispatched');
  await pool.query("UPDATE provider_request SET status='settled' WHERE id=$1",[retried.runId]);await assert.rejects(cancelOpportunities(rollback.project,owner,retried.runId,{requestId:randomUUID()}),{status:409});
  console.log('PASS changed key/source/retention, expired preparation, operational pause, queue rollback and post-dispatch cancellation refusal');

  const late=await fixture(),execution=await answer(late);await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '24 hours'+interval '2 seconds' WHERE id=$1",[execution]);await pool.query("UPDATE prompt_comparison c SET created_at=e.completed_at-interval '1 second' FROM prompt_execution e WHERE e.id=$1 AND c.id=e.id",[execution]);const lp=await prepare(late);await pool.query('UPDATE workspace SET raw_provider_evidence_days=1 WHERE id=$1',[late.workspace]);
  const connect=pool.connect.bind(pool);let delayed=false;pool.connect=(async()=>{const client=await connect(),query=client.query.bind(client),release=client.release.bind(client);client.query=(async(...args:unknown[])=>{const result=await (query as (...a:unknown[])=>Promise<unknown>)(...args);if(!delayed&&typeof args[0]==='string'&&args[0].includes('encode(sha256(convert_to(e.result::text')){delayed=true;await query('SELECT pg_sleep(2.2)');}return result;}) as typeof client.query;client.release=(...args)=>{client.query=query;client.release=release;return release(...args);};return client;}) as typeof pool.connect;
  try{await assert.rejects(startOpportunities(late.project,owner,startInput(lp.id)),{status:410});}finally{pool.connect=connect;}assert.equal(delayed,true);assert.deepEqual(await counts(late.project),{runs:0,receipts:0,requests:0});assert.ok((await pool.query('SELECT raw_expired_at FROM ai_opportunity_preparation WHERE id=$1',[lp.id])).rows[0].raw_expired_at);
  assert.equal((await state(unrelated.runId)).status,'queued');assert.equal((await state(unrelated.runId)).dispatched_at,null);assert.equal((await boss.getJobById(opportunitiesQueue,unrelated.runId))!.state,'created');assert.equal(outbound,0);
  console.log('PASS expiry crossed during native read, permanent latch and queue producer without executor/network');
 }finally{globalThis.fetch=original;await stopJobs();}
}
if(import.meta.main){try{await runAiOpportunitiesAdmissionChecks();}finally{await stopJobs();await closeDatabase();}}
