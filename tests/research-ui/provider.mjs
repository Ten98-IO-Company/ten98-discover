// Strict synthetic provider transport. It never calls the original fetch.
import assert from 'node:assert/strict';
import {appendFileSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixtureGuard,evidenceDir} from './guard.mjs';

const models=['openai/gpt-4o-mini','openai/gpt-4o'];
const dfs='https://api.dataforseo.com/v3/';
const or='https://openrouter.ai/api/v1/';
const modes=new Set(['ok','empty','receipt-only','unknown']);
function record(operation){
  appendFileSync(resolve(evidenceDir,'research-provider-calls.ndjson'),JSON.stringify({operation,at:Date.now(),pid:process.pid})+'\n',{mode:0o600});
}
const free=result=>Response.json({status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result}]});

export function createSyntheticProviderFetch({allowDispatch=false,promptMode='ok',keywordMode='ok'}={}){
  fixtureGuard();assert.ok(modes.has(promptMode));assert.ok(modes.has(keywordMode));
  const receipts=resolve(evidenceDir,'research-receipts');mkdirSync(receipts,{recursive:true});
  return async(input,init={})=>{
    const address=input instanceof URL?input.href:typeof input==='string'?input:null;
    assert.ok(address,'Only explicit provider URL strings are accepted.');
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal);
    if(address===dfs+'dataforseo_labs/locations_and_languages'){
      assert.equal(init.method,'GET');record('keyword-catalog');
      // https://cdn.dataforseo.com/v3/locations/locations_and_languages_dataforseo_labs_2026_09_01.csv
      return free([{location_code:2840,location_name:'United States',location_type:'Country',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']}]},
        {location_code:2158,location_name:'Taiwan',location_type:'Region',available_languages:[{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]},
        {location_code:2344,location_name:'Hong Kong',location_type:'Region',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']},{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]}]);
    }
    if(address===dfs+'appendix/user_data'){
      assert.equal(init.method,'GET');record('keyword-price');
      const prices={priority_normal:[{cost_type:'per_request',cost:0.012},{cost_type:'per_result',cost:0.00012}]};
      return free([{login:'synthetic-provider@keywords.integration.test',price:{dataforseo_labs:{keyword_overview:{live:prices},keyword_ideas:{live:prices}}}}]);
    }
    if(address===dfs+'dataforseo_labs/id_list'){
      assert.equal(init.method,'POST');record('keyword-reconcile');
      return free(readdirSync(receipts).filter(name=>/^keyword-[a-f0-9-]+\.json$/.test(name)).map(name=>JSON.parse(readFileSync(resolve(receipts,name),'utf8'))));
    }
    if(address===or+'key'){
      assert.equal(init.method??'GET','GET');record('prompt-account');return Response.json({data:{is_free_tier:false,is_management_key:false}});
    }
    const model=models.find(model=>address===or+'models/'+model+'/endpoints');
    if(model){
      assert.equal(init.method??'GET','GET');record('prompt-route');
      return Response.json({data:{id:model,endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing:{prompt:'0.00000015',completion:'0.0000006',input_cache_read:'0.000000075',discount:0}}]}});
    }
    if(address.startsWith(or+'generation?')){
      const url=new URL(address),id=url.searchParams.get('id');
      assert.equal(url.searchParams.size,1);assert.match(id??'',/^gen-[a-f0-9-]{36}$/);assert.equal(init.method??'GET','GET');record('prompt-reconcile');
      return Response.json({data:JSON.parse(readFileSync(resolve(receipts,id+'.json'),'utf8'))});
    }
    const keywordOperation=['keyword_overview','keyword_ideas'].find(op=>address===dfs+'dataforseo_labs/google/'+op+'/live');
    if(keywordOperation){
      assert.equal(allowDispatch,true,'Web fixture cannot dispatch paid jobs.');assert.equal(init.method,'POST');
      const payload=JSON.parse(String(init.body));assert.equal(payload.length,1);const data=payload[0];assert.match(data.tag,/^ten98:keyword:[a-f0-9-]{36}$/);
      record('keyword-dispatch');if(keywordMode==='unknown')throw new Error('Synthetic response unavailable.');
      const id='fixture-'+randomUUID(),cost=0.01212;
      writeFileSync(resolve(receipts,'keyword-'+randomUUID()+'.json'),JSON.stringify({id,url:new URL(address).pathname.slice(1),metadata:data,status:'20000',cost}),{flag:'wx',mode:0o600});
      if(keywordMode==='receipt-only')return new Response('{incomplete');
      const items=keywordMode==='empty'?[]:[{keyword:data.keywords[0],keyword_info:{search_volume:0,cpc:null,competition:null,monthly_searches:[{year:2026,month:1,search_volume:0}]}}];
      return Response.json({status_code:20000,cost,tasks_count:1,tasks:[{id,status_code:20000,cost,path:new URL(address).pathname.slice(1).split('/'),data,result:[{se_type:'google',location_code:data.location_code,language_code:data.language_code,items_count:items.length,items,total_count:keywordOperation==='keyword_ideas'?250:items.length}]}]});
    }
    if(address===or+'chat/completions'){
      assert.equal(allowDispatch,true,'Web fixture cannot dispatch paid jobs.');assert.equal(init.method,'POST');
      const data=JSON.parse(String(init.body));assert.ok(models.includes(data.model));assert.deepEqual(data.provider.only,['openai']);assert.equal(data.provider.allow_fallbacks,false);
      assert.match(data.session_id,/^[a-f0-9-]{36}$/);record('prompt-dispatch');
      if(promptMode==='unknown')throw new Error('Synthetic response unavailable.');
      const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000),cost=0.000012345;
      writeFileSync(resolve(receipts,id+'.json'),JSON.stringify({id,model:data.model,provider_name:'OpenAI',session_id:data.session_id,external_user:data.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',is_byok:false,total_cost:cost,upstream_inference_cost:0}),{flag:'wx',mode:0o600});
      if(promptMode==='receipt-only')return new Response('{incomplete',{headers:{'x-generation-id':id}});
      const content=promptMode==='empty'?'':'Synthetic answer: <script>window.syntheticUnsafe=true</script>\n**Plain text stays plain.**\n'+('Readable answer text. '.repeat(25));
      const annotations=[{type:'url_citation',url_citation:{url:'https://citation.example.com/'+('long-observed-path-'.repeat(20)),title:'<img src=x onerror=syntheticUnsafe=true>'}},
        {type:'url_citation',url_citation:{url:'javascript:alert(1)',title:'Unsupported scheme'}}];
      return Response.json({id,model:data.model,provider:'OpenAI',created,choices:[{finish_reason:'stop',message:{content,annotations}}],usage:{cost,is_byok:false,prompt_tokens:12,completion_tokens:20}},{headers:{'x-generation-id':id}});
    }
    record('blocked-unexpected-fetch');throw new Error('Unexpected outbound request blocked by synthetic UI fixture.');
  };
}
