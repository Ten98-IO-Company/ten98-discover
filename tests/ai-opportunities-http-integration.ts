import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,assertSchema,closeDatabase} from '../src/server/db.ts';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {startWorker,stopJobs} from '../src/server/jobs.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {opportunitiesActionDtoSchema,opportunitiesDetailDtoSchema,opportunitiesListDtoSchema,opportunitiesSourceDtoSchema} from '../src/lib/ai-opportunities-api.ts';
import {opportunitiesPreparationDtoSchema} from '../src/lib/ai-opportunities-run.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {refreshOpenRouterCatalog} from '../src/server/openrouter-models.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_HTTP_TEST,'1');
const config=getConfig(),db=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
assert.equal(config.appUrl,origin);assert.equal(db.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_opportunities_http_ci';assert.equal(db.port,ci?'5432':'55501');if(!ci)assert.match(db.pathname,/^\/ten98_opportunities_http_[a-f0-9]{12}$/);assert.equal(db.search,'');assert.equal(db.hash,'');
for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
const original=globalThis.fetch;let external=0,requests=0;globalThis.fetch=async()=>{external++;throw Error('HTTP contract checks forbid all outbound calls.');};
const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),workspace=randomUUID(),project=randomUUID(),connection=randomUUID(),password=randomBytes(24).toString('hex'),passwordHash=await hashPassword(password),cookies=new Map<string,string>();
async function login(user:string){const response=await getAuth().handler(new Request(origin+'/api/auth/sign-in/email',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:user+'@recommendations.test',password})}));assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);cookies.set(user,cookie);}
async function request(path='',options:{user?:string|null;method?:string;body?:unknown;raw?:string;origin?:string;token?:string;extra?:Record<string,string>}={}){
 requests++;assert.ok(requests<=100);const user=options.user===undefined?owner:options.user;
 return handleApi(new Request(origin+'/api/projects/'+project+'/ai-opportunities'+path,{method:options.method??(options.body===undefined&&options.raw===undefined?'GET':'POST'),headers:{...user?{cookie:cookies.get(user)!}:{},origin:options.origin??origin,'content-type':'application/json',...options.token?{authorization:'Bearer '+options.token}:{},...options.extra},...options.body===undefined&&options.raw===undefined?{}:{body:options.raw??JSON.stringify(options.body)}}));
}
async function expect(response:Promise<Response>,status:number){const r=await response,body=await r.json();assert.equal(r.status,status,JSON.stringify(body));assert.doesNotMatch(JSON.stringify(body),new RegExp(password));return body;}
try{
 for(const user of [owner,viewer,foreign]){await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Recommendations HTTP fixture\',$2)',[user,user+'@recommendations.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,passwordHash]);await login(user);}
 await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Recommendations HTTP fixture')",[workspace]);
 for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,user,role]);
 await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Acme','https://acme.test',$3,'infinity')",[project,workspace,randomUUID()]);
 await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name)VALUES($1,$2,'openrouter','Unconfigured synthetic connection')",[connection,workspace]);
 await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme',aliases:[]}]});
 const ownerList=opportunitiesListDtoSchema.parse(await expect(request(),200));assert.equal(ownerList.canPrepare,true);assert.equal(ownerList.connections[0].checkStatus,'untested');assert.deepEqual(ownerList.runs,[]);
 const memberList=opportunitiesListDtoSchema.parse(await expect(request('/runs',{user:viewer}),200));assert.equal(memberList.canPrepare,false);assert.deepEqual(memberList.connections,[]);
 await expect(request('',{user:null}),401);await expect(request('',{user:foreign}),404);
 console.log('PASS native cookie authorization, bounded empty history and owner-only connection disclosure');
 const day=new Date().toISOString().slice(0,10),scope={from:day,to:day,timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1'};
 const source=opportunitiesSourceDtoSchema.parse(await expect(request('/source',{user:viewer,body:scope}),200));assert.equal(source.availability,'insufficient-evidence');assert.equal(source.coverage.eligible,0);assert.equal(source.prompts,0);assert.equal(source.citations,0);
 await expect(request('/source',{user:foreign,body:scope}),404);await expect(request('/source',{body:{...scope,model:'invalid'}}),400);await expect(request('/source',{body:{...scope,internal:true}}),400);await expect(request('/source',{body:scope,origin:'https://foreign.test'}),403);
 await expect(request('/source',{body:{...scope,tag:'x'.repeat(5000)}}),413);await expect(request('/prepare',{raw:'x'.repeat(32769)}),413);await expect(request('/prepare',{raw:'{' }),400);
 console.log('PASS strict retained-source coverage, no evidence distinction, origin and body bounds');
 await expect(request('?cursor=x&cursor=y'),400);await expect(request('?unknown=1'),400);await expect(request('/runs/'+randomUUID()+'?unknown=1'),400);await expect(request('/runs/'+randomUUID()),404);
 await expect(request('/source'),405);await expect(request('/prepare/'+randomUUID(),{body:{}}),405);await expect(request('/source?extra=1',{body:scope}),400);await expect(request('',{extra:{'content-length':'1'}}),400);
 await expect(request('/runs',{user:viewer,body:{preparationId:randomUUID(),requestId:randomUUID()}}),403);
 await expect(request('/runs',{raw:'x'.repeat(2049)}),413);await expect(request('/runs',{body:{preparationId:randomUUID(),requestId:randomUUID(),extra:true}}),400);
 await expect(request('/runs/'+randomUUID()+'/cancel',{user:viewer,body:{requestId:randomUUID()}}),403);await expect(request('/runs/'+randomUUID()+'/cancel',{body:{requestId:randomUUID()}}),404);await expect(request('/runs/'+randomUUID()+'/cancel'),405);
 const key=await createApiKey(workspace,owner,{name:'Synthetic read scope',scopes:['analytics:read']});await expect(request('',{user:null,token:key.token}),403);await expect(request('/source',{user:null,token:key.token,body:scope}),403);await expect(request('',{token:key.token}),400);
 await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer]);await expect(request('',{user:viewer}),404);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal(external,0);
 console.log('PASS method/query checks, API-key default denial, membership revocation and zero provider work');
 const flowOwner=randomUUID(),model='openai/gpt-4o-mini';
 await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Recommendations flow owner\',$2)',[flowOwner,flowOwner+'@recommendations.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),flowOwner,passwordHash]);await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[workspace,flowOwner]);await login(flowOwner);
 const flowRequest=(path='',options:Parameters<typeof request>[1]={})=>request(path,{...options,user:flowOwner});
 await pool.query("UPDATE provider_connection SET encrypted_credentials=$2,check_status='ok' WHERE id=$1",[connection,JSON.stringify(encryptCredentials({apiKey:'synthetic-flow-key'},{id:connection,workspaceId:workspace,provider:'openrouter',revision:1}))]);
 const prompt=(await createPrompts(project,flowOwner,{requestId:randomUUID(),prompts:[{text:'Which product should I choose?',enabled:false}]})).items[0];
 const answerId=randomUUID(),answerInput={connectionId:connection,promptId:prompt.id,versionId:prompt.currentVersionId,systemText:'',models:[model],maxCompletionTokens:1024};
 await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,created_at,expires_at,request_version)VALUES($1,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),$8,$9,'[]',repeat('c',64),clock_timestamp()-interval '3 seconds',clock_timestamp()+interval '5 minutes',1)`,[answerId,workspace,project,flowOwner,prompt.id,prompt.currentVersionId,connection,JSON.stringify(answerInput),JSON.stringify([{role:'user',content:prompt.text}])]);
 await pool.query("INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at)VALUES($1,$1,$2,$3,$4,$1,clock_timestamp()-interval '2 seconds')",[answerId,workspace,project,flowOwner]);await pool.query("INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,status)VALUES($1,$2,$3,1,$4,$1,'fixture.answer',repeat('d',64),'settled')",[answerId,workspace,connection,flowOwner]);
 await pool.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at)VALUES($1,$1,$2,$3,0,$4,'completed',$5,clock_timestamp()-interval '1 second')",[answerId,workspace,project,JSON.stringify({model,tag:'openai',providerName:'OpenAI'}),JSON.stringify({text:'Acme is mentioned.',resolvedModel:model,provider:'OpenAI',finishReason:'stop',citations:[]})]);
 await refreshOpenRouterCatalog(async()=>Response.json({data:[{id:model,canonical_slug:model,name:model,context_length:128000,top_provider:{max_completion_tokens:8192},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','response_format','structured_outputs']}],total_count:1,links:{next:null}}));
 let metadata=0,inference=0,runId:string|null=null,uncertain=false,recoveryReads=0;
 globalThis.fetch=async(url,init)=>{
  assert.ok(metadata+inference<100,'Synthetic provider request cap');const address=String(url);
  if(address==='https://openrouter.ai/api/v1/key'){metadata++;assert.equal(init?.method,undefined);return Response.json({data:{is_free_tier:false,is_management_key:false}});}
  if(address===`https://openrouter.ai/api/v1/models/${model}/endpoints`){metadata++;assert.equal(init?.method,undefined);return Response.json({data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:100000,max_completion_tokens:8192,supported_parameters:['max_tokens','response_format','structured_outputs']}]}});}
  if(address.startsWith('https://openrouter.ai/api/v1/generation?')){
   recoveryReads++;assert.equal(init?.method,undefined);assert.equal(new URL(address).searchParams.get('id'),'gen-'+runId);
   const saved=(await pool.query('SELECT r.dispatched_at,q.request_actor FROM ai_opportunity_run r JOIN ai_opportunity_preparation q ON q.id=r.preparation_id WHERE r.id=$1',[runId])).rows[0];
   return Response.json({data:{id:'gen-'+runId,model,provider_name:'OpenAI',session_id:runId,external_user:saved.request_actor,created_at:saved.dispatched_at.toISOString(),finish_reason:'stop',tokens_prompt:12,tokens_completion:5}});
  }
  if(address==='https://openrouter.ai/api/v1/chat/completions'){
   inference++;assert.equal(init?.method,'POST');const body=JSON.parse(String(init.body));assert.equal(body.service_tier,'default');
   const state=(await pool.query('SELECT r.status,p.status AS request_status FROM ai_opportunity_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1',[body.session_id])).rows[0];assert.equal(state.status,'running');assert.equal(state.request_status,'dispatched');
   if(uncertain)return new Response('{',{headers:{'x-generation-id':'gen-'+body.session_id}});
   return Response.json({id:'gen-'+body.session_id,model,provider:'OpenAI',created:Math.floor(Date.now()/1000),choices:[{index:0,message:{role:'assistant',content:JSON.stringify({version:1,summary:['No supported change identified.'],opportunities:[],risks:[]})},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:5}});
  }
  external++;throw Error('Unexpected outbound request in synthetic native flow.');
 };
 const selected=opportunitiesSourceDtoSchema.parse(await expect(flowRequest('/source',{body:scope}),200));assert.equal(selected.availability,'available');
 const preparation=opportunitiesPreparationDtoSchema.parse(await expect(flowRequest('/prepare',{body:{requestId:randomUUID(),connectionId:connection,model,expectedSource:selected.expectedSource}}),200));
 const start={preparationId:preparation.id,requestId:randomUUID()},admitted=opportunitiesActionDtoSchema.parse(await expect(flowRequest('/runs',{body:start}),202));runId=admitted.runId;
 const replay=opportunitiesActionDtoSchema.parse(await expect(flowRequest('/runs',{body:start}),202));assert.equal(replay.runId,runId);assert.equal(replay.replayed,true);
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(inference,0);assert.equal((await pool.query('SELECT status FROM ai_opportunity_run WHERE id=$1',[runId])).rows[0].status,'queued');
 await stopJobs();await startWorker();const deadline=Date.now()+15000;let status='queued';while(Date.now()<deadline){status=(await pool.query('SELECT status FROM ai_opportunity_run WHERE id=$1',[runId])).rows[0].status;if(!['queued','running'].includes(status))break;await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(status,'completed');
 const detail=opportunitiesDetailDtoSchema.parse(await expect(flowRequest('/runs/'+runId),200));assert.equal(detail.run.available,true);assert.deepEqual(detail.run.report?.opportunities,[]);assert.equal(detail.run.promptTokens,12);assert.equal(detail.run.completionTokens,5);assert.equal(inference,1);
 const history=opportunitiesListDtoSchema.parse(await expect(flowRequest(),200));assert.equal(history.runs.length,1);assert.equal(history.runs[0].id,runId);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[runId])).rows[0].status,'settled');assert.equal(external,0);
 console.log('PASS native HTTP prepare/start replay, producer-only queued state, actual worker dispatch, retained empty report and useful usage without external requests');
 const next=opportunitiesPreparationDtoSchema.parse(await expect(flowRequest('/prepare',{body:{requestId:randomUUID(),connectionId:connection,model,expectedSource:selected.expectedSource}}),200));uncertain=true;
 runId=opportunitiesActionDtoSchema.parse(await expect(flowRequest('/runs',{body:{preparationId:next.id,requestId:randomUUID()}}),202)).runId;
 const recoveryDeadline=Date.now()+15000;while(Date.now()<recoveryDeadline){status=(await pool.query('SELECT status FROM ai_opportunity_run WHERE id=$1',[runId])).rows[0].status;if(!['queued','running'].includes(status))break;await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(status,'uncertain');assert.equal(inference,2);
 assert.equal(opportunitiesDetailDtoSchema.parse(await expect(flowRequest('/runs/'+runId),200)).run.canRecover,true);
 await expect(request('/runs/'+runId+'/recover',{user:foreign,body:{requestId:randomUUID()}}),404);await expect(flowRequest('/runs/'+runId+'/recover'),405);
 const recoveryBody={requestId:randomUUID()},recovered=opportunitiesActionDtoSchema.parse(await expect(flowRequest('/runs/'+runId+'/recover',{body:recoveryBody}),200));assert.equal(recovered.runId,runId);assert.equal(recovered.replayed,false);
 assert.equal(opportunitiesActionDtoSchema.parse(await expect(flowRequest('/runs/'+runId+'/recover',{body:recoveryBody}),200)).replayed,true);assert.equal(recoveryReads,1);assert.equal(inference,2);
 const recoveredDetail=opportunitiesDetailDtoSchema.parse(await expect(flowRequest('/runs/'+runId),200));assert.equal(recoveredDetail.run.status,'failed');assert.equal(recoveredDetail.run.available,false);assert.equal(recoveredDetail.run.report,null);assert.equal(recoveredDetail.run.canRecover,false);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[runId])).rows[0].status,'settled');assert.equal(external,0);
 console.log('PASS native owner recovery endpoint, original metadata identity, receipt replay and settled outcome without repeated inference or reconstructed report');
}finally{globalThis.fetch=original;await stopJobs();await closeDatabase();}
