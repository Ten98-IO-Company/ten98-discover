import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getAuth} from '../src/server/auth.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {saveProvider,saveBudget} from '../src/server/providers.ts';
import {listProviders} from '../src/server/providers.ts';
import {getProjectContext} from '../src/server/project-context.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {createPrompts,listPrompts} from '../src/server/prompts.ts';
import {handleApi} from '../src/server/api.ts';
import {refreshOpenRouterModels} from '../src/server/openrouter-models.ts';
import {quotePromptExecution,startPromptExecution,getPromptComparison,cancelPromptComparison,executePromptComparison,reconcilePromptExecution} from '../src/server/prompt-execution.ts';
import {getPromptInsights} from '../src/server/prompt-insights.ts';
import {getPromptInsightsComparison} from '../src/server/prompt-insights-comparison.ts';
import {quoteAiSuggestions,startAiSuggestions,getAiSuggestion,getAiSuggestions,acceptAiSuggestions} from '../src/server/ai-suggestions.ts';
import {executeAiSuggestion} from '../src/server/ai-suggestion-worker.ts';
import {runRetentionBatch} from '../src/server/retention.ts';

/** All upstream responses and financial rows in this suite are SYNTHETIC.
 * Services, cookie authentication, HTTP routing, vault, queue and worker are real.
 * No listener or real provider is required or permitted. */
export async function runOpenRouterModelChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_MODELS_DYNAMIC_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55501');assert.match(url.pathname,/^\/ten98_dynamic_models_[a-f0-9]{12}$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 assert.equal(new URL(config.appUrl).hostname,'127.0.0.1');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const roles=['owner','admin','editor','viewer'] as const,users=Object.fromEntries([...roles,'foreign'].map(role=>[role,randomUUID()])) as Record<typeof roles[number]|'foreign',string>;
 const password=randomBytes(24).toString('hex'),passwordHash=await hashPassword(password),cookies=new Map<string,string>();
 for(const user of Object.values(users)){
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Dynamic models synthetic fixture\',$2)',[user,`${user}@models.integration.test`]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,passwordHash]);
 }
 const model='mistralai/mistral-small-3.2-24b-instruct',otherModel='qwen/qwen3-32b',provider='Synthetic Compute',tags=['compute/leaf-a','compute/leaf-b'];
 let catalog=[model,otherModel],preferred=0,architecture:unknown={input_modalities:['text'],output_modalities:['text']},reasoning:unknown=undefined,paid=0,free=0,unexpected=0,mode:'ok'|'lost'='ok',receiptChange:Record<string,unknown>={};
 const receipts=new Map<string,Record<string,unknown>>(),sent:{model:string;tag:string;runId:string;structured:boolean}[]=[],captures:Record<string,unknown>={},groups:string[]=[];
 const originalFetch=globalThis.fetch,blocked:typeof fetch=async()=>{unexpected++;throw new Error('Real provider traffic forbidden.');};globalThis.fetch=blocked;
 const send:typeof fetch=async(address,init)=>{
  const endpoint=String(address);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
  if(endpoint==='https://openrouter.ai/api/v1/models?output_modalities=text&offset=0&limit=500'){
   free++;assert.equal(new Headers(init?.headers).has('authorization'),false);assert.equal(init?.body,undefined);
   const data=catalog.map(id=>({id,canonical_slug:id,name:id,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:'0.00000015',completion:'0.0000006',request:'0'}}));return Response.json({data,total_count:data.length,links:{next:null}});
  }
  assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Bearer synthetic-'));
  if(endpoint==='https://openrouter.ai/api/v1/key'){free++;return Response.json({data:{is_free_tier:false,is_management_key:false}});}
  if(endpoint.startsWith('https://openrouter.ai/api/v1/models/')&&endpoint.endsWith('/endpoints')){
   free++;const id=new URL(endpoint).pathname.slice('/api/v1/models/'.length,-'/endpoints'.length);assert.ok([model,otherModel].includes(id));
   return Response.json({data:{id,architecture,...(reasoning===undefined?{}:{reasoning}),endpoints:tags.map((tag,i)=>({tag,provider_name:provider,model_id:id,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:i===preferred?'0.00000015':'0.00000016',completion:'0.0000006',request:'0',discount:0}}))}});
  }
  if(endpoint.startsWith('https://openrouter.ai/api/v1/generation?id=')){free++;const saved=receipts.get(new URL(endpoint).searchParams.get('id')!);assert.ok(saved);return Response.json({data:{...saved,...receiptChange}});}
  assert.equal(endpoint,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');const body=JSON.parse(String(init?.body));
  assert.ok([model,otherModel].includes(body.model));assert.deepEqual(body.provider.only,[tags[preferred]]);assert.deepEqual(body.provider.order,[tags[preferred]]);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.provider.require_parameters,true);assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.deepEqual(body.plugins,[{id:'context-compression',enabled:false}]);
  assert.ok(Buffer.byteLength(String(init?.body))<=163840);paid++;sent.push({model:body.model,tag:body.provider.only[0],runId:body.session_id,structured:body.response_format!==undefined});
  const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000);receipts.set(id,{id,model:body.model,provider_name:provider,session_id:body.session_id,external_user:body.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',is_byok:false,total_cost:0.000012345});
  if(mode==='lost')return new Response('{broken',{headers:{'x-generation-id':id}});
  const content=body.response_format?JSON.stringify({version:1,limitation:'none',prompts:[{text:'Which practical monitoring reports help a small team?',tags:['Research'],rationale:'An unverified draft grounded in the supplied profile.',evidenceIds:['profile']}]}):'Acme is mentioned in this synthetic model answer.';
  if(body.response_format){assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.response_format.json_schema.name,'suggestion_proposal_v1');}
  return Response.json({id,created,model:body.model,provider,usage:{cost:0.000012345,is_byok:false,prompt_tokens:12,completion_tokens:20},choices:[{finish_reason:'stop',message:{content}}]},{headers:{'x-generation-id':id}});
 };
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Dynamic models synthetic')",[workspace]);
  for(const role of roles)await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,users[role],role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Acme','https://acme.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const connection=(await saveProvider(workspace,users.owner,{provider:'openrouter',name:'Synthetic model fixture',credentials:{apiKey:'synthetic-'+project},monthlyLimitUsd:'1'})).connection;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[connection.id]);await saveBudget(workspace,users.owner,{paused:false,monthlyLimitUsd:'1'});
  const prompt=(await createPrompts(project,users.owner,{requestId:randomUUID(),prompts:[{text:'Which monitoring product is useful?',enabled:false}]})).items[0];
  return {workspace,project,connectionId:connection.id,prompt,input:{connectionId:connection.id,promptId:prompt.id,versionId:prompt.currentVersionId,systemText:'Use the exact question.',models:[model],maxCompletionTokens:256,fundedCredits:true as const}};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const quote=(f:Fixture,user=users.owner)=>quotePromptExecution(f.project,user,f.input,send);
 async function start(f:Fixture,user=users.owner){const q=await quote(f,user);return(await startPromptExecution(f.project,user,{quoteId:q.quote.id,requestKey:randomUUID()})).comparison;}
 const detail=(f:Fixture,id:string)=>getPromptComparison(f.project,users.owner,id);
 async function login(user:string){if(!cookies.has(user)){const response=await getAuth().handler(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${user}@models.integration.test`,password})}));assert.equal(response.status,200);cookies.set(user,response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '));}return cookies.get(user)!;}
 async function http(f:Fixture,user:string,path:string,method='GET',body?:unknown,expected=200){const cookie=await login(user);globalThis.fetch=send;try{const response=await handleApi(new Request(config.appUrl+`/api/projects/${f.project}/`+path,{method,headers:{cookie,origin:config.appUrl,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.equal(response.status,expected,path);const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.byteLength<=2097152);const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);for(const secret of ['synthetic-'+f.project,'encrypted_credentials','key_fingerprint',password])assert.ok(!text.includes(secret));return JSON.parse(text);}finally{globalThis.fetch=blocked;}}
 const record=(name:string,value:unknown)=>{assert.equal(captures[name],undefined);captures[name]=value;};
 const pass=(name:string)=>{groups.push(name);console.log('PASS '+name);};
 try{
  const f=await fixture(),before=paid;
  assert.equal((await handleApi(new Request(config.appUrl+`/api/projects/${f.project}/openrouter-models`))).status,401);
  for(const role of roles){const response=await http(f,users[role],'openrouter-models');assert.equal(response.role,role);assert.equal(response.catalog.status,'unavailable');}
  await http(f,users.foreign,'openrouter-models','GET',undefined,404);await http(f,users.viewer,'openrouter-models','POST',{},404);
  for(const role of ['owner','admin','editor'] as const){const refreshed=await http(f,users[role],'openrouter-models','POST',{});assert.equal(refreshed.catalog.status,'fresh');assert.equal(refreshed.role,role);assert.deepEqual(refreshed.catalog.models.map((r:{id:string})=>r.id),[model,otherModel].sort());}
  await http(f,users.owner,'openrouter-models?unexpected=1','GET',undefined,400);
  const ownerCookie=await login(users.owner),catalogUrl=config.appUrl+`/api/projects/${f.project}/openrouter-models`;
  assert.equal((await handleApi(new Request(catalogUrl,{method:'PUT',headers:{cookie:ownerCookie,origin:config.appUrl}}))).status,405);
  assert.equal((await handleApi(new Request(catalogUrl,{headers:{cookie:ownerCookie,'content-length':'1'}}))).status,400);
  assert.equal((await handleApi(new Request(catalogUrl,{method:'POST',headers:{cookie:ownerCookie,origin:'https://foreign.test','content-type':'application/json'},body:'{}'}))).status,403);
  const token=await createApiKey(f.workspace,users.owner,{name:'No model permission',scopes:['prompts:read','prompts:write']});assert.equal((await handleApi(new Request(config.appUrl+`/api/projects/${f.project}/openrouter-models`,{headers:{authorization:'Bearer '+token.token}}))).status,403);
  for(const role of ['owner','admin','editor'] as const){const q=await quote(f,users[role]);assert.equal(q.role,role);assert.equal(q.quote.routes[0].model,model);assert.equal(q.quote.routes[0].profile,'openrouter-api-text-no-search-v2');}
  await assert.rejects(quote(f,users.viewer),{status:404});await assert.rejects(quote(f,users.foreign),{status:404});assert.equal(paid,before);
  record('catalog',await http(f,users.viewer,'openrouter-models'));record('catalogOwner',await http(f,users.owner,'openrouter-models'));record('executionsInitial',await http(f,users.owner,'prompt-executions'));record('quoteTwoModels',await quotePromptExecution(f.project,users.owner,{...f.input,models:[model,otherModel]},send));pass('actual catalog HTTP, all four current roles, foreign/API-key denial and writer quote admission without paid calls');

  record('executionsInitialEditor',await http(f,users.editor,'prompt-executions'));
  const q=await http(f,users.editor,'prompt-executions/quote','POST',f.input);record('quote',q);const started=await http(f,users.editor,'prompt-executions/comparisons','POST',{quoteId:q.quote.id,requestKey:randomUUID()},202);record('started',started);
  await getBoss();globalThis.fetch=send;
  try{await startWorker();const until=Date.now()+15000;while(Date.now()<until){if((await detail(f,started.comparison.id)).comparison.runs.every(r=>r.status==='completed'))break;await new Promise(resolve=>setTimeout(resolve,100));}}finally{await stopJobs();globalThis.fetch=blocked;}
  const first=await detail(f,started.comparison.id);assert.equal(first.comparison.runs[0].status,'completed');assert.equal(first.comparison.runs[0].actualUsd,'0.000013');assert.equal(paid,before+1);assert.equal(sent.at(-1)!.tag,tags[0]);record('completed',first);
  preferred=1;const second=await start(f);await executePromptComparison(second.id,send);assert.equal((await detail(f,second.id)).comparison.runs[0].status,'completed');assert.equal(paid,before+2);
  const foreignScope=await fixture();foreignScope.input.models=[otherModel];const foreignRun=await start(foreignScope);await cancelPromptComparison(foreignScope.project,users.owner,foreignRun.id,{});
  const dates=(await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS today")).rows[0];const params=new URLSearchParams({from:dates.today,to:dates.today,timeZone:'UTC'});

  // Additive UI bootstrap captures: real current actors, original process vault,
  // explicit UTC dates. These reads neither dispatch nor alter the original oracles.
  const uiFrom=new Date(Date.parse(dates.today)-6*86400000).toISOString().slice(0,10),uiParams=new URLSearchParams({from:uiFrom,to:dates.today,timeZone:'UTC',matcher:'unicode-boundary-v1',outcome:'all'});
  record('uiClock',dates.today+'T12:00:00.000Z');
  record('mainViewerPrompts',await http(f,users.viewer,'prompts?status=all&q='));
  record('mainOwnerPrompts',await http(f,users.owner,'prompts?status=all&q='));
  record('mainViewerInitialInsights',await http(f,users.viewer,'prompt-insights?'+uiParams));
  record('mainOwnerInitialInsights',await http(f,users.owner,'prompt-insights?'+uiParams));
  record('mainOwnerNeutralComparison',await http(f,users.owner,'prompt-insights/comparison?'+new URLSearchParams({...Object.fromEntries(params),matcher:'unicode-boundary-v1',cohort:'current-neutral',view:'cells'})));
  const report=await getPromptInsights(f.project,users.viewer,params);assert.equal(report.coverage.eligible,2);assert.deepEqual(report.modelOptions,{values:[model],complete:true});record('insights',report);
  const comparison=await getPromptInsightsComparison(f.project,users.owner,new URLSearchParams({...Object.fromEntries(params),cohort:'all'}));assert.equal(comparison.cellCount,2);assert.equal(comparison.page.kind,'cells');assert.equal(comparison.page.rows.length,2);assert.ok(comparison.page.rows.every(row=>'provider' in row&&row.provider===provider&&row.model===model));assert.equal(new Set(comparison.page.rows.map(row=>row.id)).size,2);assert.deepEqual((await pool.query('SELECT route->>\'tag\' AS tag FROM prompt_execution WHERE comparison_id=ANY($1::uuid[]) ORDER BY tag',[[started.comparison.id,second.id]])).rows.map(row=>row.tag),tags);record('comparison',comparison);
  assert.equal((await http(f,users.viewer,'prompt-insights?'+params)).coverage.eligible,2);pass('actual cookie quote/start and registered production worker; same model/provider across two serving leaves remains two comparison cells');

  // Separate causal UI fixture; never changes the original two-leaf report above.
  const paired=await fixture(),chosenModels=[model,otherModel],pairedBefore=paid;
  record('pairedScope',{project:paired.project,workspace:paired.workspace,user:users.owner,role:'owner'});
  const pairedMetadata=await http(paired,users.owner,'prompt-executions');assert.equal(pairedMetadata.role,'owner');assert.equal(pairedMetadata.comparisons.length,0);record('pairedMetadata',pairedMetadata);
  const pairedQuote=await http(paired,users.owner,'prompt-executions/quote','POST',{...paired.input,models:chosenModels});assert.deepEqual(pairedQuote.quote.routes.map((route:{model:string})=>route.model),chosenModels);record('pairedQuote',pairedQuote);
  const pairedStarted=await http(paired,users.owner,'prompt-executions/comparisons','POST',{quoteId:pairedQuote.quote.id,requestKey:randomUUID()},202);assert.deepEqual(pairedStarted.comparison.runs.map((run:{model:string})=>run.model),chosenModels);record('pairedStarted',pairedStarted);
  await executePromptComparison(pairedStarted.comparison.id,send);
  const pairedCompleted=await http(paired,users.owner,'prompt-executions/comparisons/'+pairedStarted.comparison.id);assert.equal(pairedCompleted.role,'owner');assert.equal(pairedCompleted.comparison.id,pairedStarted.comparison.id);assert.deepEqual(pairedCompleted.comparison.runs.map((run:{model:string})=>run.model),chosenModels);assert.ok(pairedCompleted.comparison.runs.every((run:{model:string;status:string;provider:string;actualUsd:string;result:{resolvedModel:string;provider:string}})=>run.status==='completed'&&run.provider===provider&&!run.provider.includes('OpenAI')&&run.actualUsd==='0.000013'&&run.result.resolvedModel===run.model&&run.result.provider===provider));assert.equal(paid,pairedBefore+2);
  const pairedLedger=(await pool.query('SELECT sum(actual_micros)::text AS actual_micros FROM provider_request WHERE id=ANY($1::uuid[])',[pairedCompleted.comparison.runs.map((run:{id:string})=>run.id)])).rows[0];assert.equal(pairedLedger.actual_micros,'26');record('pairedCompleted',pairedCompleted);

  record('pairedMetadataCompleted',await http(paired,users.owner,'prompt-executions'));

  catalog=[otherModel];await refreshOpenRouterModels(f.project,users.owner,{},send);const afterFree=free;
  const retired=await getPromptInsights(f.project,users.owner,new URLSearchParams({...Object.fromEntries(params),model}));assert.equal(retired.coverage.eligible,2);assert.deepEqual(retired.modelOptions,{values:[model],complete:true});assert.equal(free,afterFree);assert.deepEqual((await detail(f,started.comparison.id)).comparison.runs[0].result,first.comparison.runs[0].result);
  const noPaid=paid;await assert.rejects(quote(f),{status:502});assert.equal(paid,noPaid);record('retiredHistory',retired);pass('retired catalog never rewrites historical answers or observed model filters; new quotes refuse retirement');

  catalog=[model,otherModel];preferred=0;await refreshOpenRouterModels(f.project,users.owner,{},send);
  for(const drift of ['retired','image','missing-architecture','mixed-output','reasoning-boolean','reasoning-array','reasoning-mandatory'] as const){
   const target=await fixture(),run=await start(target),paidBefore=paid;
   if(drift==='retired'){catalog=[otherModel];await refreshOpenRouterModels(target.project,users.owner,{},send);}
   if(drift==='image')architecture={input_modalities:['image'],output_modalities:['image']};
   if(drift==='missing-architecture')architecture=undefined;
   if(drift==='mixed-output')architecture={input_modalities:['text'],output_modalities:['text','image']};
   if(drift==='reasoning-boolean')reasoning=true;if(drift==='reasoning-array')reasoning=[];if(drift==='reasoning-mandatory')reasoning={mandatory:true,default_enabled:false};
   await executePromptComparison(run.id,send);assert.equal(paid,paidBefore);const result=(await detail(target,run.id)).comparison;assert.ok(result.runs.every(r=>r.status==='cancelled'&&r.chargeStatus==='cancelled'));record('blocked-'+drift,result);
   catalog=[model,otherModel];architecture={input_modalities:['text'],output_modalities:['text']};reasoning=undefined;await refreshOpenRouterModels(target.project,users.owner,{},send);
  }
  pass('retired-after-start and fresh endpoint architecture/reasoning drift cancel reservations before every paid send');

  const suggestions=await fixture(),suggestionInput={requestId:randomUUID(),connectionId:suggestions.connectionId,contextRevision:1,profileId:'catalog-text-schema-v1',model,benchmark:true,fundedCredits:true,maxSpendUsd:'0.1',topic:'Monitoring',country:'Global',language:'English',sectionKeys:[],competitorIds:[],excludedPrompts:[]};

  record('suggestionContext',await getProjectContext(suggestions.project,users.owner));
  record('suggestionProviders',await listProviders(suggestions.workspace,users.owner));
  record('suggestionCatalog',await http(suggestions,users.owner,'openrouter-models'));
  for(const role of ['admin','editor','viewer'] as const)record('suggestionsInitial-'+role,await http(suggestions,users[role],'ai-suggestions'));
  const freeBefore=free;for(const role of ['admin','editor','viewer'] as const){const metadata=await getAiSuggestions(suggestions.project,users[role]);assert.equal(metadata.canQuote,false);assert.deepEqual(metadata.defaults,{economy:null,balanced:null});await assert.rejects(quoteAiSuggestions(suggestions.project,users[role],suggestionInput,send),{status:role==='viewer'?404:403});}await assert.rejects(quoteAiSuggestions(suggestions.project,users.foreign,suggestionInput,send),{status:404});assert.equal(free,freeBefore);
  record('suggestionScope',{project:suggestions.project,workspace:suggestions.workspace,owner:users.owner});record('suggestionsInitial',await getAiSuggestions(suggestions.project,users.owner));const sq=await quoteAiSuggestions(suggestions.project,users.owner,suggestionInput,send);record('suggestionQuote',sq);assert.equal((await http(suggestions,users.owner,'ai-suggestions/quote','POST',suggestionInput)).quote.id,sq.quote.id);await http(suggestions,users.admin,'ai-suggestions/quote','POST',{...suggestionInput,requestId:randomUUID()},403);
  const sr=await startAiSuggestions(suggestions.project,users.owner,{requestId:randomUUID(),quoteId:sq.quote.id}),beforeSuggestion=paid;record('suggestionStarted',sr);await executeAiSuggestion(sr.run.id,send);
  const suggestion=(await getAiSuggestion(suggestions.project,users.owner,sr.run.id)).run;assert.equal(suggestion.status,'completed');assert.equal(suggestion.actualUsd,'0.000013');assert.equal(paid,beforeSuggestion+1);assert.equal(sent.at(-1)!.structured,true);assert.ok(suggestion.proposal);assert.equal((await listPrompts(suggestions.project,users.owner,new URLSearchParams())).items.length,1);

  record('suggestionCompleted',await http(suggestions,users.owner,'ai-suggestions/runs/'+sr.run.id));
  const accepted=await acceptAiSuggestions(suggestions.project,users.owner,sr.run.id,{requestId:randomUUID(),expectedProposalRevision:suggestion.proposalRevision,expectedContextRevision:suggestion.acceptance!.contextRevision,expectedTopicLibraryHash:suggestion.acceptance!.topicLibraryHash,selections:suggestion.proposal!.prompts.map(p=>({candidateId:p.id,text:p.text,tags:p.tags}))});assert.equal(accepted.acknowledgement.accepted.length,1);assert.ok((await listPrompts(suggestions.project,users.owner,new URLSearchParams())).items.every(p=>!p.enabled));assert.deepEqual((await getAiSuggestions(suggestions.project,users.owner)).defaults,{economy:null,balanced:null});record('suggestion',suggestion);pass('owner-only dynamic structured evaluation, explicit review/save and no automatic quality promotion');

  const uncertain=await fixture(),uncertainRun=await start(uncertain);mode='lost';const beforeUncertain=paid;await executePromptComparison(uncertainRun.id,send);mode='ok';const unknown=(await detail(uncertain,uncertainRun.id)).comparison.runs[0];assert.equal(unknown.status,'uncertain');assert.equal(unknown.chargeStatus,'uncertain');assert.ok(unknown.generationId);assert.equal(paid,beforeUncertain+1);
  await executePromptComparison(uncertainRun.id,send);assert.equal(paid,beforeUncertain+1);await assert.rejects(reconcilePromptExecution(uncertain.project,users.editor,unknown.id,{},send),{status:404});
  for(const changed of [{model:otherModel},{provider_name:'Foreign Compute'},{session_id:randomUUID()},{external_user:'foreign'},{id:'gen-foreign'}]){receiptChange=changed;assert.equal((await reconcilePromptExecution(uncertain.project,users.owner,unknown.id,{},send)).reconciliation.status,'inconclusive');assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[unknown.id])).rows[0].status,'uncertain');}
  receiptChange={};const identitySql='SELECT r.route,r.generation_id,r.dispatched_at,q.request_actor,q.key_fingerprint,q.input_hash FROM prompt_execution r JOIN prompt_comparison c ON c.id=r.comparison_id JOIN prompt_execution_quote q ON q.id=c.quote_id WHERE r.id=$1';const identity=(await pool.query(identitySql,[unknown.id])).rows[0];
  await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[uncertainRun.id]);await runRetentionBatch(uncertain.project);const expired=(await detail(uncertain,uncertainRun.id)).comparison;assert.equal(expired.inputExpired,true);assert.equal(expired.input,null);assert.equal(expired.messages,null);assert.deepEqual((await pool.query(identitySql,[unknown.id])).rows[0],identity);
  const recovered=await reconcilePromptExecution(uncertain.project,users.owner,unknown.id,{},send);assert.equal(recovered.reconciliation.status,'matched');assert.equal(recovered.comparison.inputExpired,true);assert.equal(recovered.comparison.runs[0].status,'reconciled');assert.equal(recovered.comparison.runs[0].result,null);assert.equal((await pool.query('SELECT actual_micros::text AS micros,status FROM provider_request WHERE id=$1',[unknown.id])).rows[0].micros,'13');assert.equal(paid,beforeUncertain+1);assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[uncertain.workspace])).rows[0].paused,true);record('recoveredExpired',recovered);
  const rotated=await fixture(),rotatedRun=await start(rotated);mode='lost';await executePromptComparison(rotatedRun.id,send);mode='ok';const rotatedChild=(await detail(rotated,rotatedRun.id)).comparison.runs[0];assert.equal(rotatedChild.status,'uncertain');const unchanged=(await pool.query(identitySql,[rotatedChild.id])).rows[0],beforeKeyRead=free,beforeKeyPaid=paid;
  await saveProvider(rotated.workspace,users.owner,{name:'Deliberately replaced synthetic key',credentials:{apiKey:'synthetic-replacement-'+rotated.project}},rotated.connectionId);await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[rotated.connectionId]);await assert.rejects(reconcilePromptExecution(rotated.project,users.owner,rotatedChild.id,{},send),{status:409});assert.equal(free,beforeKeyRead);assert.equal(paid,beforeKeyPaid);assert.deepEqual((await pool.query(identitySql,[rotatedChild.id])).rows[0],unchanged);record('originalKeyRequired',await detail(rotated,rotatedRun.id));
  pass('uncertain dynamic charge requires original model/provider/actor/generation/key, no replay and no expired raw-input resurrection');

  // Deliberately seeded METADATA, not 1000 real upstream models or paid sends.
  // Clone an actual cancelled service quote/run through the real stored schema.
  const many=await fixture(),seed=await start(many);await cancelPromptComparison(many.project,users.owner,seed.id,{});const template=(await pool.query('SELECT q.*,e.id AS execution_id FROM prompt_execution_quote q JOIN prompt_comparison c ON c.quote_id=q.id JOIN prompt_execution e ON e.comparison_id=c.id WHERE c.id=$1',[seed.id])).rows[0];
  const extra=(await createPrompts(many.project,users.owner,{requestId:randomUUID(),prompts:[{text:'Separate metadata inventory scope',enabled:false}]})).items[0];

  record('manyScope',{project:many.project,workspace:many.workspace,user:users.owner,role:'owner',promptId:many.prompt.id});
  record('manyPromptsBeforeSeed',await http(many,users.owner,'prompts?status=all&q='));
  record('manyInitialBeforeSeed',await http(many,users.owner,'prompt-insights?'+uiParams));
  const entries=Array.from({length:1000},(_,i)=>({quote:randomUUID(),comparison:randomUUID(),execution:randomUUID(),request:randomUUID(),model:'fixture/observed-'+String(i).padStart(4,'0')}));
  const client=await pool.connect();try{await client.query('BEGIN');
   await client.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at,created_at)
    SELECT x.quote,q.workspace_id,q.project_id,q.user_id,$3::uuid,$4::uuid,q.connection_id,q.connection_revision,q.request_actor,q.key_fingerprint,
     q.input||jsonb_build_object('promptId',$3::text,'versionId',$4::text,'systemText','','models',jsonb_build_array(x.model)),jsonb_build_array(jsonb_build_object('role','user','content',$5::text)),jsonb_build_array((q.routes->0)||jsonb_build_object('model',x.model)),q.input_hash,q.expires_at,q.created_at
    FROM prompt_execution_quote q CROSS JOIN jsonb_to_recordset($2::jsonb) x(quote uuid,model text) WHERE q.id=$1`,[template.id,JSON.stringify(entries),extra.id,extra.currentVersionId,extra.text]);
   await client.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) SELECT x.comparison,x.quote,q.workspace_id,q.project_id,q.user_id,x.request,q.created_at FROM jsonb_to_recordset($1::jsonb) x(comparison uuid,quote uuid,request uuid) JOIN prompt_execution_quote q ON q.id=x.quote`,[JSON.stringify(entries)]);
   await client.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month) SELECT x.execution,q.workspace_id,q.connection_id,q.connection_revision,q.user_id,x.request,'prompt.execute',q.input_hash,1,0,'cancelled',date_trunc('month',q.created_at)::date FROM jsonb_to_recordset($1::jsonb) x(execution uuid,quote uuid,request uuid) JOIN prompt_execution_quote q ON q.id=x.quote`,[JSON.stringify(entries)]);
   await client.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,completed_at) SELECT x.execution,x.comparison,c.workspace_id,c.project_id,0,q.routes->0,'cancelled',clock_timestamp() FROM jsonb_to_recordset($1::jsonb) x(execution uuid,comparison uuid) JOIN prompt_comparison c ON c.id=x.comparison JOIN prompt_execution_quote q ON q.id=c.quote_id`,[JSON.stringify(entries)]);await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  catalog=[];await refreshOpenRouterModels(many.project,users.owner,{},send);const atCapacity=paid;
  await assert.rejects(getPromptInsights(many.project,users.owner,params),{status:413});

  record('manyPromptsAfterSeed',await http(many,users.owner,'prompts?status=all&q='));
  record('manyDefaultRefusal',await http(many,users.owner,'prompt-insights?'+uiParams,'GET',undefined,413));
  record('manyPromptNarrowed',await http(many,users.owner,'prompt-insights?'+new URLSearchParams({...Object.fromEntries(uiParams),promptId:many.prompt.id})));
  const narrowed=await getPromptInsights(many.project,users.owner,new URLSearchParams({...Object.fromEntries(params),model}));assert.equal(narrowed.coverage.attempted,1);assert.equal(narrowed.modelOptions.values.length,1000);assert.equal(narrowed.modelOptions.complete,false);assert.ok(!narrowed.modelOptions.values.includes(otherModel));
  const recoveredOptions=await getPromptInsights(many.project,users.owner,new URLSearchParams({...Object.fromEntries(params),model,promptId:many.prompt.id}));assert.deepEqual(recoveredOptions.modelOptions,{values:[model],complete:true});assert.equal(paid,atCapacity);await assert.rejects(getPromptInsights(many.project,users.foreign,params),{status:404});record('optionsIncomplete',narrowed);record('optionsRecovered',recoveredOptions);pass('1001 synthetic stored model observations: explicit incomplete options ignore selected model, survive retirement, exclude foreign scope and narrow to a complete prompt inventory');

  assert.equal(groups.length,7);assert.equal(unexpected,0);assert.equal(paid,sent.length);assert.ok(sent.every(row=>!row.model.startsWith('openai/')));
  const states=(await pool.query('SELECT operation,status,count(*)::int AS rows,COALESCE(sum(actual_micros),0)::text AS actual_micros FROM provider_request GROUP BY operation,status ORDER BY operation,status')).rows;
  assert.equal(paid,7);const unsettled=(await pool.query("SELECT id,status,actual_micros FROM provider_request WHERE status='uncertain'")).rows;assert.equal(unsettled.length,1);assert.equal(unsettled[0].id,rotatedChild.id);assert.equal(unsettled[0].actual_micros,null);

  record('uiCaptureProvenance',{version:3,clock:'uiClock is an explicit UTC browser clock; each quote uses its own original createdAt',transport:'http helper is cookie-authenticated handleApi(Request), not a socket transport',serviceOnly:['suggestionContext','suggestionProviders'],main:{project:f.project,workspace:f.workspace,owner:users.owner,editor:users.editor,viewer:users.viewer},paired:{project:paired.project,workspace:paired.workspace,owner:users.owner},suggestions:{project:suggestions.project,workspace:suggestions.workspace,owner:users.owner},many:{project:many.project,workspace:many.workspace,owner:users.owner},manyBefore:'One original cancelled run, before1000 added metadata rows; not empty',manyAfter:'Default seven-day413 and current prompt metadata captured after1000 metadata rows; narrow read remains actual'});
  const settled=states.filter(row=>row.status==='settled').reduce((sum,row)=>sum+BigInt(row.actual_micros),0n);assert.equal(settled,78n);
  const capturePath=process.env.TEN98_MODELS_DYNAMIC_CAPTURE;if(capturePath){assert.ok(capturePath.replaceAll('\\','/').startsWith(config.artifactDir.replaceAll('\\','/')+'/'));writeFileSync(capturePath,JSON.stringify({kind:'ACTUAL SAFE SERVICE/HTTP DTOs; synthetic provider and metadata only',scope:{users,model,otherModel,provider,tags,project:f.project,workspace:f.workspace},groups,paid,free,sent,syntheticLedger:states,captures},null,2)+'\n');}
 }finally{globalThis.fetch=originalFetch;await stopJobs();await closeDatabase();}
}
if(import.meta.main)await runOpenRouterModelChecks();
