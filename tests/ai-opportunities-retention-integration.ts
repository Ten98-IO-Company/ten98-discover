import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {readOpportunitiesSource,type OpportunitySourceDependency} from '../src/server/ai-opportunities-source.ts';
import {latchOpportunitiesExpiry,expireOpportunities,previewOpportunitiesRetention} from '../src/server/ai-opportunities-retention.ts';
import {getRetention,previewRetention,saveRetention,runRetentionBatch} from '../src/server/retention.ts';

export async function runAiOpportunitiesRetentionChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_RETENTION_TEST,'1');
 const database=new URL(getConfig().databaseUrl);assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_opportunities_retention_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_opportunities_retention_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
 for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Retention checks prohibit all outbound requests.');};
 const user=randomUUID();await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Retention fixture\',$2)',[user,`${user}@opportunities.integration.test`]);
 async function fixture(age=0){
  const workspace=randomUUID(),project=randomUUID(),connection=randomUUID(),execution=randomUUID();
  await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Retention fixture')",[workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[workspace,user]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name)VALUES($1,$2,'openrouter','No credentials')",[connection,workspace]);
  const prompt=(await createPrompts(project,user,{requestId:randomUUID(),prompts:[{text:'Which product?',enabled:false}]})).items[0];
  await updateProjectContext(project,user,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme'}]});
  const times=(await pool.query("SELECT clock_timestamp()-$1::integer*interval '24 hours'-interval '10 seconds' AS requested",[age])).rows[0],requested=times.requested as Date,completed=new Date(requested.getTime()+1000);
  const input={connectionId:connection,promptId:prompt.id,versionId:prompt.currentVersionId,systemText:'',models:['openai/gpt-4o-mini'],maxCompletionTokens:1024};
  const messages=[{role:'user',content:prompt.text}],route={model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI'};
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,created_at,expires_at,request_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),$8,$9,'[]',repeat('c',64),$10::timestamptz-interval '1 second',$10::timestamptz+interval '5 minutes',1)`,[execution,workspace,project,user,prompt.id,prompt.currentVersionId,connection,JSON.stringify(input),JSON.stringify(messages),requested]);
  await pool.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at)VALUES($1,$1,$2,$3,$4,$1,$5)',[execution,workspace,project,user,requested]);
  await pool.query("INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,status)VALUES($1,$2,$3,1,$4,$1,'fixture.retention',repeat('d',64),'settled')",[execution,workspace,connection,user]);
  await pool.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at)VALUES($1,$1,$2,$3,0,$4,'completed',$5,$6)",[execution,workspace,project,JSON.stringify(route),JSON.stringify({text:'Acme is mentioned.',resolvedModel:route.model,provider:'OpenAI',finishReason:'stop',citations:[]}),completed]);
  const day=requested.toISOString().slice(0,10),source=await readOpportunitiesSource(project,user,{from:day,to:day,timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1'});
  return {workspace,project,connection,execution,source};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function locked<T>(f:Fixture,run:(client:PoolClient)=>Promise<T>){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[f.project]);const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
 async function seed(f:Fixture,n=1,options:{rawDays?:number;derivedDays?:number;dependencies?:OpportunitySourceDependency[];status?:'completed'|'uncertain';preparationOnly?:boolean}={}){
  const ids=Array.from({length:n},()=>randomUUID()),source=f.source.snapshot.source,deps=options.dependencies??f.source.dependencies;
  await pool.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) INSERT INTO ai_opportunity_preparation(id,workspace_id,project_id,user_id,request_id,connection_id,connection_revision,request_actor,key_fingerprint,purpose,prompt_version,schema_version,method,source_kind,input_hash,payload_hash,schema_hash,evidence_hash,business_input_hash,retention_revision,raw_days_at_preparation,derived_days_at_preparation,raw_anchor_at,derived_anchor_at,dependencies,source_input,snapshot,messages,route,created_at,expires_at)
   SELECT id,$2,$3,$4,id,$5,1,repeat('a',64),repeat('b',64),'ai-opportunities','retained-api-opportunities-v1',1,'evidence-linked-opportunities-v1','api-model-answer',repeat('c',64),repeat('d',64),repeat('e',64),$6,$7,1,$8,$9,$10,$11,$12,'{"retained":"input"}','{"retained":"snapshot"}','[{"role":"system","content":"retained"},{"role":"user","content":"retained"}]','{}',tick.at,tick.at+interval '5 minutes'
   FROM unnest($1::uuid[])id CROSS JOIN tick`,[ids,f.workspace,f.project,user,f.connection,f.source.evidenceHash,f.source.businessInputHash,options.rawDays??90,options.derivedDays??365,source.rawAnchorAt,source.derivedAnchorAt,JSON.stringify(deps)]);
  if(!options.preparationOnly){const status=options.status??'completed';
   await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,status)SELECT id,$2,$3,1,$4,id,'fixture.opportunity',repeat('f',64),$5 FROM unnest($1::uuid[])id`,[ids,f.workspace,f.connection,user,status==='uncertain'?'uncertain':'settled']);
   await pool.query(`INSERT INTO ai_opportunity_run(id,preparation_id,workspace_id,project_id,user_id,request_id,status,generation_id,raw_result,proposal,result_hash,created_at,dispatched_at,completed_at)
    SELECT id,id,$2,$3,$4,id,$5,'gen-fixture','retained result',CASE WHEN $5='completed' THEN '{"retained":"proposal"}'::jsonb END,CASE WHEN $5='completed' THEN repeat('a',64) END,clock_timestamp()-interval '3 seconds',clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second' FROM unnest($1::uuid[])id`,[ids,f.workspace,f.project,user,status]);
  }return ids;
 }
 const state=async(id:string)=>(await pool.query(`SELECT q.raw_expired_at,q.unavailable_reason,q.input_purged_at,q.source_input,q.snapshot,q.messages,q.dependencies,q.input_hash,q.payload_hash,q.schema_hash,q.evidence_hash,q.business_input_hash,q.request_id,q.created_at,r.status,r.raw_result,r.proposal,r.result_hash,r.result_purged_at,r.generation_id,p.status AS request_status FROM ai_opportunity_preparation q LEFT JOIN ai_opportunity_run r ON r.preparation_id=q.id LEFT JOIN provider_request p ON p.id=r.id WHERE q.id=$1`,[id])).rows[0];
 try{
  const current=await fixture(),currentIds=await seed(current),before=await state(currentIds[0]);
  assert.deepEqual(await locked(current,c=>previewOpportunitiesRetention(c,current.workspace,90,365)),{status:'available',inputs:0,results:0,atLeast:false});
  assert.deepEqual(await locked(current,c=>expireOpportunities(c,current.project)),{expiredOpportunityInputs:0,expiredOpportunityResults:0,pending:false});assert.deepEqual(await state(currentIds[0]),before);
  const raw=await fixture(10),rawIds=await seed(raw,2);assert.deepEqual(await locked(raw,c=>previewOpportunitiesRetention(c,raw.workspace,5,365)),{status:'available',inputs:2,results:2,atLeast:false});assert.equal((await state(rawIds[0])).raw_expired_at,null);
  await locked(raw,c=>latchOpportunitiesExpiry(c,[raw.project],{rawDays:5,derivedDays:365},[rawIds[0]]));assert.equal((await state(rawIds[0])).unavailable_reason,'input_expired');assert.equal((await state(rawIds[1])).raw_expired_at,null);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=365,derived_history_days=3650 WHERE id=$1',[raw.workspace]);
  assert.deepEqual(await locked(raw,c=>expireOpportunities(c,raw.project)),{expiredOpportunityInputs:1,expiredOpportunityResults:1,pending:false});const purged=await state(rawIds[0]);for(const key of ['source_input','snapshot','messages','raw_result','proposal','result_hash'])assert.equal(purged[key],null);assert.ok(purged.input_purged_at&&purged.result_purged_at);
  const derived=await fixture(10),derivedId=(await seed(derived,1,{derivedDays:5}))[0];await locked(derived,c=>expireOpportunities(c,derived.project));assert.equal((await state(derivedId)).unavailable_reason,'input_expired');
  const currentPolicy=await fixture(10),currentPolicyId=(await seed(currentPolicy))[0];await pool.query('UPDATE workspace SET raw_provider_evidence_days=5 WHERE id=$1',[currentPolicy.workspace]);
  await locked(currentPolicy,c=>latchOpportunitiesExpiry(c,[currentPolicy.project],{rawDays:3650,derivedDays:3650}));assert.equal((await state(currentPolicyId)).unavailable_reason,'input_expired');
  const proposedDerived=await fixture(10),proposedDerivedId=(await seed(proposedDerived))[0];await locked(proposedDerived,c=>latchOpportunitiesExpiry(c,[proposedDerived.project],{rawDays:90,derivedDays:5}));assert.equal((await state(proposedDerivedId)).unavailable_reason,'input_expired');
  console.log('PASS unchanged source, nonmutating preview, selected latch, raw/derived cutoff and permanent policy shortening');

  const missing=await fixture(),foreign=await fixture(),badKeys=['executionId','comparisonId','quoteId','promptId','versionId'] as const;
  for(const key of badKeys){const deps=structuredClone(missing.source.dependencies);deps[0][key]=foreign.source.dependencies[0][key];const id=(await seed(missing,1,{dependencies:deps}))[0];await locked(missing,c=>latchOpportunitiesExpiry(c,[missing.project],undefined,[id]));assert.equal((await state(id)).unavailable_reason,'source_expired',key);}
  const malformed=structuredClone(missing.source.dependencies);malformed[0].executionId='malformed-uuid';const malformedId=(await seed(missing,1,{dependencies:malformed}))[0];await locked(missing,c=>latchOpportunitiesExpiry(c,[missing.project],undefined,[malformedId]));assert.equal((await state(malformedId)).unavailable_reason,'source_expired');
  const duplicateId=(await seed(missing,1,{dependencies:[...missing.source.dependencies,...missing.source.dependencies]}))[0];await locked(missing,c=>latchOpportunitiesExpiry(c,[missing.project],undefined,[duplicateId]));assert.equal((await state(duplicateId)).unavailable_reason,'source_expired');
  const sourcePurged=await fixture(),sourcePurgedId=(await seed(sourcePurged))[0];await pool.query('UPDATE prompt_execution SET result=NULL,result_purged_at=clock_timestamp() WHERE id=$1',[sourcePurged.execution]);
  assert.deepEqual(await locked(sourcePurged,c=>previewOpportunitiesRetention(c,sourcePurged.workspace,90,365)),{status:'available',inputs:1,results:1,atLeast:false});await locked(sourcePurged,c=>expireOpportunities(c,sourcePurged.project));assert.equal((await state(sourcePurgedId)).unavailable_reason,'source_expired');
  const inputPurged=await fixture(),inputPurgedId=(await seed(inputPurged))[0];await pool.query('UPDATE prompt_execution_quote SET input=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1',[inputPurged.execution]);await locked(inputPurged,c=>expireOpportunities(c,inputPurged.project));assert.equal((await state(inputPurgedId)).unavailable_reason,'source_expired');
  const deleted=await fixture(),deletedId=(await seed(deleted))[0];await pool.query('DELETE FROM prompt_comparison_item WHERE execution_id=$1 AND project_id=$2',[deleted.execution,deleted.project]);await pool.query('DELETE FROM prompt_execution WHERE id=$1 AND project_id=$2',[deleted.execution,deleted.project]);await locked(deleted,c=>expireOpportunities(c,deleted.project));assert.equal((await state(deletedId)).unavailable_reason,'source_expired');
  console.log('PASS missing/cross-project dependencies, malformed IDs, purged result/input and deleted source');

  const unknown=await fixture(10),unknownId=(await seed(unknown,1,{rawDays:5,status:'uncertain'}))[0],unknownBefore=await state(unknownId);await locked(unknown,c=>expireOpportunities(c,unknown.project));const unknownAfter=await state(unknownId);
  for(const key of ['dependencies','input_hash','payload_hash','schema_hash','evidence_hash','business_input_hash','request_id','created_at','status','request_status','generation_id'])assert.deepEqual(unknownAfter[key],unknownBefore[key],key);assert.equal(unknownAfter.status,'uncertain');assert.equal(unknownAfter.request_status,'uncertain');assert.equal(unknownAfter.raw_result,null);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650,derived_history_days=3650 WHERE id=$1',[unknown.workspace]);await pool.query("UPDATE prompt_execution SET result=jsonb_set(result,'{text}','\"Changed source\"') WHERE id=$1",[unknown.execution]);
  assert.deepEqual(await locked(unknown,c=>expireOpportunities(c,unknown.project)),{expiredOpportunityInputs:0,expiredOpportunityResults:0,pending:false});assert.deepEqual(await state(unknownId),unknownAfter);
  const batches=await fixture(10);await seed(batches,205,{rawDays:5});for(const expected of [100,100,5]){const result=await locked(batches,c=>expireOpportunities(c,batches.project));assert.equal(result.expiredOpportunityInputs,expected);assert.equal(result.expiredOpportunityResults,expected);assert.equal(result.pending,expected===100);}
  assert.deepEqual(await locked(batches,c=>previewOpportunitiesRetention(c,batches.workspace,1,1)),{status:'available',inputs:0,results:0,atLeast:false});assert.deepEqual(await state(currentIds[0]),before);
  console.log('PASS unknown request/history/hash preservation, nonresurrection and 100-row batch closure');

  const wired=await fixture(10),wiredIds=await seed(wired,205),policy=await getRetention(wired.workspace,user);
  const preview=await previewRetention(wired.workspace,user,{revision:policy.revision,settings:{...policy.settings,rawProviderEvidenceDays:5}});
  assert.ok('opportunitiesEstimate' in preview,'Workspace preview includes opportunities');
  assert.deepEqual(preview.opportunitiesEstimate,{status:'available',inputs:205,results:205,atLeast:false});
  await saveRetention(wired.workspace,user,{previewToken:preview.previewToken});
  assert.equal((await state(wiredIds[204])).unavailable_reason,'input_expired','Policy save latches every affected preparation atomically');
  const shortened=await getRetention(wired.workspace,user),lengthened=await previewRetention(wired.workspace,user,{revision:shortened.revision,settings:{...shortened.settings,rawProviderEvidenceDays:90}});
  await saveRetention(wired.workspace,user,{previewToken:lengthened.previewToken});
  for(const expected of [100,100,5]){
   const batch=await runRetentionBatch(wired.project);
   assert.ok(batch&&'expiredOpportunityInputs' in batch&&'expiredOpportunityResults' in batch&&'complete' in batch);
   assert.equal(batch.expiredOpportunityInputs,expected);assert.equal(batch.expiredOpportunityResults,expected);assert.equal(batch.complete,expected<100);
  }
  assert.equal((await state(wiredIds[204])).proposal,null);assert.deepEqual(await state(currentIds[0]),before);
  console.log('PASS workspace preview/save and native cleanup scheduling preserve permanent expiry through policy lengthening');

  const capped=await fixture(10);await seed(capped,10001,{preparationOnly:true});
  assert.deepEqual(await locked(capped,c=>previewOpportunitiesRetention(c,capped.workspace,5,365)),{status:'available',inputs:10000,results:0,atLeast:true});
  assert.deepEqual(await locked(current,c=>previewOpportunitiesRetention(c,current.workspace,90,365)),{status:'available',inputs:0,results:0,atLeast:false});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_opportunity_preparation WHERE project_id=$1 AND raw_expired_at IS NOT NULL',[capped.project])).rows[0].n,0);
  assert.equal(outbound,0);console.log('PASS 10001 preview cap, workspace isolation and zero outbound calls');
 }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runAiOpportunitiesRetentionChecks();}finally{await closeDatabase();}}
