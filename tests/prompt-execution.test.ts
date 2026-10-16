import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {decimalSumMicros,decimalText,executionInput,executionBody,parseOpenRouterJson,ExactCost,promptCacheKey} from '../src/server/openrouter-input.ts';
import {parseRoute,parseExecutionOutcome,readOpenRouterRoutes,requestPromptExecution,reconcileOpenRouter,executionActor} from '../src/server/openrouter.ts';
import {openRouterTextProfile} from '../src/lib/openrouter-models.ts';
import {refreshOpenRouterCatalog} from '../src/server/openrouter-models.ts';
process.env.AUTH_SECRET='prompt-unit-auth-only-'.repeat(4);process.env.BOOTSTRAP_TOKEN='prompt-unit-bootstrap-only-'.repeat(4);process.env.DATABASE_URL='postgresql://synthetic:synthetic@localhost/unused_prompt_unit';
delete process.env.AUTH_SECRET_FILE;delete process.env.BOOTSTRAP_TOKEN_FILE;delete process.env.DATABASE_URL_FILE;
const model='openai/gpt-4o-mini' as const,now=new Date('2026-10-13T12:00:00Z'),id=randomUUID(),actor=executionActor(randomUUID());
// Current public OpenAI endpoint shape: optional request omitted, null input capacity and numeric discount.
function endpoint(){return {data:{id:model,endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing:{prompt:'0.00000015',completion:'0.0000006',discount:0,input_cache_read:'0.000000075'}}]}};}
const route=parseRoute(model,endpoint(),2048);
test('per-model cache identity preserves case/system/policy and ignores selected model order',()=>{
 const input=executionInput.parse({connectionId:randomUUID(),promptId:randomUUID(),versionId:randomUUID(),systemText:'Exact system',models:[model,'openai/gpt-4o'],maxCompletionTokens:2048,fundedCredits:true,reuseCached:true});
 const wid=randomUUID(),pid=randomUUID(),messages=[{role:'system' as const,content:input.systemText},{role:'user' as const,content:'  Compare Go\tvs\n go  '}];
 const key=(patch:Partial<typeof input>={},text=messages,revision=1,provider=route,canonical:string=model,project=pid)=>promptCacheKey(wid,project,{...input,...patch},text,provider,canonical,revision,'a'.repeat(64));
 assert.equal(key(),key({models:[...input.models].reverse(),reuseCached:false},[messages[0],{role:'user',content:'Compare Go vs go'}]));
 assert.notEqual(key(),key({},[messages[0],{role:'user',content:'Compare go vs go'}]));
 assert.notEqual(key(),key({},[{role:'system',content:'Exact  system'},messages[1]]));
 assert.notEqual(key(),key({maxCompletionTokens:1024}));assert.notEqual(key(),key({},messages,2));
 assert.notEqual(key(),key({},messages,1,{...route,tag:'other'}));assert.notEqual(key(),key({},messages,1,route,'openai/different-version'));assert.notEqual(key(),key({},messages,1,route,model,randomUUID()));
 const legacy={connectionId:input.connectionId,promptId:input.promptId,versionId:input.versionId,systemText:input.systemText,models:input.models,maxCompletionTokens:input.maxCompletionTokens,fundedCredits:true};
 assert.equal(Object.hasOwn(executionInput.parse(legacy),'reuseCached'),false);
});
function body(){return parseOpenRouterJson(JSON.stringify({id:'gen-test-one',model,provider:'OpenAI',created:now.getTime()/1000,choices:[{finish_reason:'stop',message:{content:'Untrusted https://example.test answer'}}],usage:{is_byok:false,cost:0.000012345,prompt_tokens:12,completion_tokens:20,cost_details:{upstream_inference_cost:0}}}));}
test('exact decimal pricing rounds once and preserves JSON cost lexemes',()=>{
 assert.equal(decimalSumMicros([{price:'1.5e-7',count:128000},{price:'6e-7',count:2048},{price:'0',count:1}]),20429n);
 assert.equal(decimalSumMicros([{price:'0.0000004',count:1},{price:'0.0000004',count:1}]),1n);
 const exact=parseOpenRouterJson('{"cost":9007199254740993,"total_cost":1.234567890123456789e-7,"upstream_inference_cost":1e-30}');assert.equal(exact.cost.source,'9007199254740993');assert.equal(exact.total_cost.source,'1.234567890123456789e-7');assert.equal(exact.upstream_inference_cost.source,'1e-30');
 for(const price of ['1\n','-1','NaN','Infinity','01','.2','1e99','1'.repeat(101)])assert.throws(()=>decimalSumMicros([{price,count:1}]));
 assert.equal(decimalText('1.5e-7',true),'0.15');const precise={...route,promptPrice:'1.234567890123456789e-7'};assert.match(JSON.stringify(executionBody([{role:'user',content:'Only this'}],precise,16,id,actor)),/"prompt":0.1234567890123456789/);
});
test('strict inputs and catalog readiness reject hidden billable options or route variants',()=>{
 const input={connectionId:randomUUID(),promptId:randomUUID(),versionId:randomUUID(),systemText:'Explicit',models:[model],maxCompletionTokens:2048,fundedCredits:true};assert.ok(executionInput.safeParse(input).success);
 for(const delta of [{tools:[]},{models:[model,model]},{models:['auto']},{maxCompletionTokens:4097},{fundedCredits:false},{systemText:'bad\ud800'}])assert.equal(executionInput.safeParse({...input,...delta}).success,false);
 assert.equal(route.estimateMicros,'20429');assert.equal(route.requestPrice,'0');
 for(const mutate of [(e:any)=>e.tag='openai/default',(e:any)=>e.provider_name='Other',(e:any)=>e.status=1,(e:any)=>e.supported_parameters=[],(e:any)=>e.max_completion_tokens=8,(e:any)=>e.pricing.input_cache_write='0.01',(e:any)=>e.pricing.surprise='0',(e:any)=>e.pricing.input_cache_read='0.01',(e:any)=>e.pricing.discount=0.2,(e:any)=>e.pricing.request=null]){const value=endpoint();mutate(value.data.endpoints[0]);assert.throws(()=>parseRoute(model,value,2048));}
 const variant=endpoint();variant.data.endpoints.push({...variant.data.endpoints[0],tag:'openai/other'});assert.throws(()=>parseRoute(model,variant,2048));
 const out=executionBody([{role:'user',content:'Rendered'}],route,2048,id,actor);assert.deepEqual(out.provider.only,['openai']);assert.equal(out.provider.allow_fallbacks,false);assert.equal(out.provider.require_parameters,true);assert.equal(out.session_id,id);assert.equal(out.user,actor);assert.ok(!('plugins' in out));
});
test('known terminal charges survive malformed answers; missing finality stays uncertain',()=>{
 const result=parseExecutionOutcome(body(),200,'gen-test-one',route,now);assert.equal(result.cost,'0.000013');assert.equal(result.result?.citations.length,0);assert.equal(result.evidence.reportedCost,'0.000012345');
 for(const malformed of [null,{content:12},{content:'escaped\0NUL'},{content:'lone\ud800'},{content:'x',annotations:[{type:'url_citation',url_citation:{url:'https://example.test',title:'unsafe\0'}}]},{content:'x',annotations:'bad'}]){const value=body();value.choices[0].message=malformed;const out=parseExecutionOutcome(value,200,'gen-test-one',route,now);assert.equal(out.cost,'0.000013');assert.equal(out.result,null);assert.ok(out.diagnostic);}
 for(const reason of [null,'pending','unknown',200]){const value=body();value.choices[0].finish_reason=reason;const out=parseExecutionOutcome(value,200,'gen-test-one',route,now);assert.equal(out.cost,null);assert.equal(out.evidence.reportedCost,'0.000012345');}
 for(const change of [{model:'other'},{provider:'Other'},{created:0},{id:'gen-other'}])assert.equal(parseExecutionOutcome({...body(),...change},200,'gen-test-one',route,now).cost,null);
 const wrongCost=body();wrongCost.usage.cost='0.1';assert.equal(parseExecutionOutcome(wrongCost,200,null,route,now).cost,null);
 const huge=body();huge.usage.cost=new ExactCost('1000001');const oversized=parseExecutionOutcome(huge,200,null,route,now);assert.equal(oversized.cost,null);assert.equal(oversized.evidence.reportedCost,'1000001');assert.equal(oversized.pause,true);
 const byok=body();byok.usage.is_byok=true;const actual=parseExecutionOutcome(byok,200,null,route,now);assert.equal(actual.cost,'0.000013');assert.equal(actual.pause,true);assert.match(actual.diagnostic!,/invoice/);
 const negative=body();negative.usage.cost=new ExactCost('-1');assert.equal(parseExecutionOutcome(negative,200,null,route,now).cost,null);
});
test('only real safe HTTPS citation annotations are retained and truncation preserves Unicode',()=>{
 const value=body();value.choices[0].message.annotations=[{type:'url_citation',url_citation:{url:'https://example.test/source',title:'Evidence'}},{type:'url_citation',url_citation:{url:'javascript:alert(1)'}},{type:'url_citation',url_citation:{url:'https://user:secret@example.test/'}},{type:'other',url_citation:{url:'https://example.test/ignored'}}];assert.deepEqual(parseExecutionOutcome(value,200,null,route,now).result?.citations,[{url:'https://example.test/source',title:'Evidence'}]);
 value.choices[0].message.annotations=[{type:'url_citation',url_citation:{url:'https://example.test',title:'a'.repeat(299)+'\u{1F600}tail'}}];const boundary=parseExecutionOutcome(value,200,null,route,now);assert.equal(boundary.cost,'0.000013');assert.equal(boundary.result?.citations[0].title,'a'.repeat(299)+'\u{1F600}');
});
test('one paid send captures its generation header before parsing and never retries',async()=>{
 let sends=0;const captured:string[]=[],secret={apiKey:'synthetic-never-live'};
 const send:typeof fetch=async(url,init)=>{sends++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);assert.equal(JSON.parse(String(init?.body)).stream,false);return new Response('{broken',{headers:{'x-generation-id':'gen-header'}});};
 const failed=await requestPromptExecution(secret,[{role:'user',content:'Public test'}],route,2048,id,actor,now,async v=>{captured.push(v);},send);assert.equal(sends,1);assert.deepEqual(captured,['gen-header']);assert.equal(failed.cost,null);assert.equal(failed.reference,'gen-header');
 const thrown=await requestPromptExecution(secret,[],route,2048,id,actor,now,async()=>{},async()=>{sends++;throw new Error('private-detail');});assert.equal(sends,2);assert.ok(!JSON.stringify(thrown).includes('private-detail'));
 const oversized=await requestPromptExecution(secret,[],route,2048,id,actor,now,async()=>{},async()=>new Response('x'.repeat(2_097_153)));assert.equal(oversized.cost,null);
});
test('read-only readiness and reconciliation require exact route/session/actor/time evidence',async()=>{
 let calls=0;const secret={apiKey:'synthetic-never-live'};
 const routes=await readOpenRouterRoutes(secret,[model],2048,async(url,init)=>{calls++;assert.equal(init?.method,undefined);assert.equal(init?.redirect,'error');return String(url).endsWith('/key')?Response.json({data:{is_free_tier:false,is_management_key:false}}):Response.json(endpoint());});assert.deepEqual(routes,[route]);assert.equal(calls,2);
 const receipt={id:'gen-test-one',model,provider_name:'OpenAI',session_id:id,external_user:actor,created_at:now.toISOString(),finish_reason:'stop',is_byok:false,total_cost:0.000012345,upstream_inference_cost:0};
 const out=await reconcileOpenRouter(secret,receipt.id,route,now,id,actor,async(url)=>{assert.equal(url,'https://openrouter.ai/api/v1/generation?id=gen-test-one');return Response.json({data:receipt});});assert.equal(out.cost,'0.000013');assert.equal(out.result,null);
 for(const change of [{id:'gen-other'},{model:'other'},{session_id:null},{external_user:'other'},{created_at:'2020-01-01'},{finish_reason:null},{total_cost:'0.01'}])await assert.rejects(reconcileOpenRouter(secret,receipt.id,route,now,id,actor,async()=>Response.json({data:{...receipt,...change}})));
 let unknownSent=false;await assert.rejects(reconcileOpenRouter(secret,null as any,route,now,id,actor,async()=>{unknownSent=true;return Response.json({});}));assert.equal(unknownSent,false);
});
test('one through four literal models are admitted without admitting a fifth or duplicates',()=>{
 const input={connectionId:randomUUID(),promptId:randomUUID(),versionId:randomUUID(),systemText:'Exact\n  whitespace',models:[],maxCompletionTokens:16,fundedCredits:true};
 const models=['openai/gpt-4o-mini','openai/gpt-4o','mistralai/fixture-a','google/fixture-b'];
 for(const count of [1,3,4])assert.deepEqual(executionInput.parse({...input,models:models.slice(0,count)}).models,models.slice(0,count));
 for(const selected of [[],[...models,'other/fifth'],[...models.slice(0,3),models[0]]])assert.equal(executionInput.safeParse({...input,models:selected}).success,false);
});
test('free endpoint discovery has at most two in flight and keeps the selected model order',{timeout:5000},async()=>{
 const models=['fixture/one','fixture/two','fixture/three','fixture/four'],pending:{finish:()=>void}[]=[];
 let active=0,maximum=0,firstReady!:()=>void,secondReady!:()=>void;
 const first=new Promise<void>(r=>firstReady=r),second=new Promise<void>(r=>secondReady=r);
 const send:typeof fetch=async(url,init)=>{
  assert.equal(init?.method,undefined);assert.ok(init?.signal);const path=String(url);
  if(path.includes('/models?'))return Response.json({data:models.map(id=>({id,canonical_slug:id,name:id,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens'],pricing:{prompt:'0.00000015',completion:'0.0000006',request:'0'}})),total_count:4,links:{next:null}});
  if(path.endsWith('/key'))return Response.json({data:{is_free_tier:false,is_management_key:false}});
  const selected=models.find(id=>path.endsWith('/'+id+'/endpoints'));assert.ok(selected);active++;maximum=Math.max(maximum,active);
  await new Promise<void>(finish=>{pending.push({finish});if(pending.length===2)firstReady();if(pending.length===4)secondReady();});active--;
  const data=endpoint().data;return Response.json({data:{...data,id:selected,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:data.endpoints.map(e=>({...e,model_id:selected}))}});
 };
 await refreshOpenRouterCatalog(send);
 const reading=readOpenRouterRoutes({apiKey:'synthetic-never-live'},models,16,send,openRouterTextProfile);
 await first;assert.equal(active,2);assert.equal(pending.length,2);pending[1].finish();pending[0].finish();
 await second;assert.equal(active,2);pending[3].finish();pending[2].finish();
 assert.deepEqual((await reading).map(r=>r.model),models);assert.equal(maximum,2);assert.equal(active,0);
 let released!:()=>void,started!:()=>void,finished=false;
 const held=new Promise<void>(r=>released=r),inFlight=new Promise<void>(r=>started=r);
 const failing=readOpenRouterRoutes({apiKey:'synthetic-never-live'},models.slice(0,2),16,async url=>{
  if(String(url).endsWith('/key'))return Response.json({data:{is_free_tier:false,is_management_key:false}});
  if(String(url).endsWith('/'+models[0]+'/endpoints'))throw Error('Synthetic metadata refusal.');
  started();await held;const data=endpoint().data;return Response.json({data:{...data,id:models[1],architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:data.endpoints.map(e=>({...e,model_id:models[1]}))}});
 },openRouterTextProfile).then(()=>{finished=true;return null;},error=>{finished=true;return error;});
 try{await inFlight;await new Promise<void>(r=>setImmediate(r));assert.equal(finished,false,'A failed batch must await its other started free request.');}
 finally{released();}
 assert.equal((await failing)?.status,502);assert.equal(finished,true);
});
