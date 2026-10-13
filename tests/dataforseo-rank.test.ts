import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {dataforseoJson} from '../src/server/dataforseo-transport.ts';
import {keywordProviderJson,parseKeywordAccount} from '../src/server/dataforseo-keywords.ts';
import {keywordAccountEndpoint,keywordEndpoints} from '../src/server/keyword-research-input.ts';
import {parseRankAccount,parseRankLocations,parseRankLanguages,readRankCatalog,pageRankLocations,validateRankCatalogSelection,requestRankTasks,readRankTask,readRankReconciliation,type RankCatalog} from '../src/server/dataforseo-rank.ts';
import {rankSerpEndpoints,type RankSerpRequest} from '../src/server/rank-serp-input.ts';

const credentials={login:'synthetic@rank.integration.test',password:'synthetic:never-live'};
const taskId='02261816-2027-0066-0000-c27d02864073';
const request:RankSerpRequest={keyword:'C++ %20',domain:'example.com',locationCode:2840,languageCode:'en',device:'desktop',depth:100,maxCrawlPages:1};
const envelope=(url:string,result:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,result_count:result.length,path:new URL(url).pathname.slice(1).split('/'),result}]}});
const countries=[{location_code:2840,location_name:'United States',location_code_parent:null,country_iso_code:'US',location_type:'Country'},{location_code:2826,location_name:'United Kingdom',location_code_parent:null,country_iso_code:'GB',location_type:'Country'}];
const locals=[{location_code:21132,location_name:'Alaska,United States',location_code_parent:2840,country_iso_code:'US',location_type:'State'},{location_code:100,location_name:'Literal 50%_Town,Alaska,United States',location_code_parent:21132,country_iso_code:'US',location_type:'City'},{location_code:200,location_name:'London,England,United Kingdom',location_code_parent:2826,country_iso_code:'GB',location_type:'City'}];
const languages=[{language_code:'en',language_name:'English'},{language_code:'zh-TW',language_name:'Chinese (Traditional)'}];
function catalog():RankCatalog{
  const locations=parseRankLocations(envelope(rankSerpEndpoints.locations,[...locals,...countries]));
  return {locations,countries:locations.filter(row=>row.type==='Country'),languages:parseRankLanguages(envelope(rankSerpEndpoints.languages,languages))};
}
const safeError=(error:unknown)=>error instanceof Error&&!error.message.includes(credentials.login)&&!error.message.includes(credentials.password)&&!error.message.includes('Basic ')&&!error.cause;

test('fixed endpoint and method allowlists reject authority/path/query/credential injection before sending',async()=>{
  let calls=0;const send:typeof fetch=async()=>{calls++;return Response.json({});};
  for(const url of ['http://api.dataforseo.com/v3/appendix/user_data','https://api.dataforseo.com.evil.test/v3/appendix/user_data','https://api.dataforseo.com:443/v3/appendix/user_data',keywordAccountEndpoint+'?x=1',keywordAccountEndpoint+'#x',keywordAccountEndpoint+'/',keywordAccountEndpoint+'\n','https://synthetic@api.dataforseo.com/v3/appendix/user_data','https://api.dataforseo.com/v3/serp/google/locations/us/../languages','https://api.dataforseo.com/v3/serp/google/locations/%75s'])await assert.rejects(dataforseoJson(url,credentials,'GET',undefined,send),safeError);
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'POST',{},send),safeError);
  await assert.rejects(dataforseoJson(rankSerpEndpoints.live,credentials,'GET',undefined,send),safeError);
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',{},send),safeError);
  await assert.rejects(keywordProviderJson(rankSerpEndpoints.locations,credentials,undefined,send));
  for(const secret of [{login:'other:account',password:'x'},{login:'x\r\nHost:evil',password:'x'},{login:'x',password:'x\0y'},{login:'x',password:'\ud800'},null,{login:'x',password:''}])await assert.rejects(dataforseoJson(keywordAccountEndpoint,secret,'GET',undefined,send),safeError);
  assert.equal(calls,0);
});

test('one bounded send omits cookies, preserves Basic password colons, and redacts provider/JSON errors',async()=>{
  let calls=0;const send:typeof fetch=async(url,init)=>{
    calls++;assert.equal(url,keywordAccountEndpoint);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);assert.equal(init?.body,undefined);
    assert.equal(new Headers(init?.headers).get('authorization'),'Basic '+Buffer.from(credentials.login+':'+credentials.password).toString('base64'));return Response.json({plain:'valid'});
  };
  assert.deepEqual(await dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,send),{httpStatus:200,body:{plain:'valid'}});assert.equal(calls,1);
  calls=0;await assert.rejects(dataforseoJson(rankSerpEndpoints.live,credentials,'POST',[{}],async()=>{calls++;throw new Error(JSON.stringify(credentials));}),safeError);assert.equal(calls,1);
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,async()=>new Response(JSON.stringify(credentials).slice(0,-1))),safeError);
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,async()=>new Response(Uint8Array.of(0xc3,0x28))),safeError);
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,async()=>new Response('{}',{status:302,headers:{location:'https://evil.test'}})),safeError);
  await assert.rejects(dataforseoJson(keywordEndpoints.overview,credentials,'POST',{x:'x'.repeat(131_073)},async()=>{calls++;return Response.json({});}),safeError);assert.equal(calls,1);
});

test('byte and chunk ceilings cancel response streams, including false declared length',async()=>{
  for(const advertised of [undefined,'1','4194305']){
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(4_194_305));},cancel(){cancelled=true;}});
    await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,async()=>new Response(stream,{headers:advertised?{'content-length':advertised}:{}})),safeError);assert.equal(cancelled,true);
  }
  let cancelled=false;
  const fragmented=new ReadableStream<Uint8Array>({pull(c){c.enqueue(Uint8Array.of(32));},cancel(){cancelled=true;}});
  await assert.rejects(dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,async()=>new Response(fragmented)),safeError);assert.equal(cancelled,true);
  await assert.rejects(dataforseoJson(rankSerpEndpoints.locations,credentials,'GET',undefined,async()=>new Response('{}',{headers:{'content-length':'67108865'}})),safeError);
});

test('large SERP results have an explicit32MiB ceiling and only Live receives150seconds',async()=>{
  const original=AbortSignal.timeout,deadlines:number[]=[];
  AbortSignal.timeout=(ms:number)=>{deadlines.push(ms);return original(ms);};
  try{
    for(const [url,method,body,maximum,timeout] of [
      [rankSerpEndpoints.live,'POST',[{}],33_554_432,150_000],
      [rankSerpEndpoints.task+taskId,'GET',undefined,33_554_432,30_000],
      [keywordEndpoints.overview,'POST',[{}],4_194_304,30_000],
      [rankSerpEndpoints.locations,'GET',undefined,67_108_864,30_000],
      [rankSerpEndpoints.queued,'POST',[{}],4_194_304,30_000],
    ] as const){
      await dataforseoJson(url,credentials,method,body,async()=>new Response('{}',{headers:{'content-length':String(maximum)}}));
      assert.equal(deadlines.at(-1),timeout);
      await assert.rejects(dataforseoJson(url,credentials,method,body,async()=>new Response('{}',{headers:{'content-length':String(maximum+1)}})),safeError);
    }
    const larger=JSON.stringify({data:'x'.repeat(4_194_305)});
    const result=await dataforseoJson(rankSerpEndpoints.live,credentials,'POST',[{}],async()=>new Response(larger));
    assert.equal((result.body as {data:string}).data.length,4_194_305);
    await assert.rejects(dataforseoJson(keywordEndpoints.overview,credentials,'POST',[{}],async()=>new Response(larger)),safeError);
  }finally{AbortSignal.timeout=original;}
});

test('complete catalog keeps every country, resolves unordered parents, and pages only validated local scope',async()=>{
  const c=catalog();assert.equal(c.countries.length,2);assert.equal(c.locations.find(row=>row.code===100)?.countryCode,2840);
  assert.deepEqual(pageRankLocations(c,{kind:'countries',limit:1}).rows.map(row=>row.name),['United Kingdom']);assert.equal(pageRankLocations(c,{kind:'countries',limit:1}).nextOffset,1);
  assert.deepEqual(pageRankLocations(c,{kind:'local',countryCode:2840,query:'50%_'}).rows.map(row=>row.code),[100]);
  assert.equal(pageRankLocations(c,{kind:'local',countryCode:2840,query:'London'}).total,0);
  assert.equal(validateRankCatalogSelection(c,{countryCode:2840,locationCode:100,languageCode:'zh-TW'}).country.code,2840);
  for(const query of [{kind:'local'},{kind:'local',countryCode:999},{kind:'countries',countryCode:2840},{kind:'countries',offset:1.2},{kind:'countries',limit:51},{kind:'countries',query:'bad\0'},{kind:'countries',query:'\ud800'},{kind:'countries',unknown:true}])assert.throws(()=>pageRankLocations(c,query));
  assert.throws(()=>validateRankCatalogSelection(c,{countryCode:2826,locationCode:100,languageCode:'en'}));assert.throws(()=>validateRankCatalogSelection(c,{countryCode:2840,locationCode:2840,languageCode:'unsupported'}));
  const visited:string[]=[];const loaded=await readRankCatalog(credentials,async(url,init)=>{visited.push(String(url));assert.equal(init?.method,'GET');return Response.json(envelope(String(url),String(url)===rankSerpEndpoints.locations?[...countries,...locals]:languages).body);});
  assert.deepEqual(visited,[rankSerpEndpoints.locations,rankSerpEndpoints.languages]);assert.equal(loaded.countries.length,2);assert.equal(loaded.locations.length,5);assert.ok(!JSON.stringify(loaded).includes(credentials.login));
});

test('catalog corruption or truncation fails wholly rather than trusting an incomplete location hierarchy',()=>{
  const valid=[...countries,...locals];
  for(const rows of [[],[...valid,countries[0]],valid.filter(row=>row.location_code!==21132),[countries[0],{...locals[0],location_code_parent:100},{...locals[1],location_code_parent:21132}],[...countries,{...locals[0],location_code_parent:2826}],[{...countries[0],country_iso_code:'US\n'}],[{...countries[0],location_code:2147483648}],[{...countries[0],location_name:'bad\0'}],[{...countries[0],location_name:'\ud800'}],[...valid,{...countries[0],location_code:999}]])assert.throws(()=>parseRankLocations(envelope(rankSerpEndpoints.locations,rows)));
  for(const change of ['count','charged','path','tasks'] as const){const value=envelope(rankSerpEndpoints.locations,valid);if(change==='count')value.body.tasks[0].result_count++;if(change==='charged')value.body.cost=0.000001;if(change==='path')value.body.tasks[0].path=['v3','serp','bing','locations'];if(change==='tasks')value.body.tasks_count=2;assert.throws(()=>parseRankLocations(value));}
  const joined=envelope(rankSerpEndpoints.locations,valid);joined.body.tasks[0].path=['v3/serp','google','locations'];assert.throws(()=>parseRankLocations(joined));
  for(const rows of [[],[...languages,languages[0]],[{language_code:'en\n',language_name:'English'}],[{language_code:'en',language_name:'\ud800'}]])assert.throws(()=>parseRankLanguages(envelope(rankSerpEndpoints.languages,rows)));
});

test('deep catalog parents resolve iteratively and deterministically without recursive stack growth',()=>{
  const deep:unknown[]=[countries[0]];for(let n=0;n<10_000;n++)deep.push({location_code:100_000+n,location_name:'Location '+n,location_code_parent:n===9999?2840:100_001+n,country_iso_code:'US',location_type:'City'});
  const rows=parseRankLocations(envelope(rankSerpEndpoints.locations,deep));assert.equal(rows.length,10_001);assert.ok(rows.every(row=>row.countryCode===2840));
});

test('rank account uses the shared version2 identity and returns no login or wallet metadata',()=>{
  const response=envelope(keywordAccountEndpoint,[{login:credentials.login,price:{serp:{synthetic:true}},wallet:{unrelated:'private'}}]),binding={key:'synthetic-identity-key-'.repeat(3),version:2 as const};
  const parsed=parseRankAccount(response,binding);assert.equal(parsed.fingerprint,parseKeywordAccount(response,undefined,binding).fingerprint);assert.deepEqual(Object.keys(parsed).sort(),['fingerprint','price']);assert.ok(!JSON.stringify(parsed).includes(credentials.login));
  assert.throws(()=>parseRankAccount(envelope(keywordAccountEndpoint,[{login:credentials.login}]),binding));
});

test('rank paid batches are explicit, bounded and unique; payload extras never reach provider',async()=>{
  let calls=0;const id=randomUUID(),send:typeof fetch=async(url,init)=>{calls++;assert.equal(url,rankSerpEndpoints.live);assert.equal(init?.method,'POST');const body=JSON.parse(init?.body as string);assert.equal(body.length,1);assert.equal(body[0].keyword,'C%2B%2B %2520');assert.deepEqual(body[0].stop_crawl_on_match,[{match_value:'example.com',match_type:'with_subdomains'}]);assert.equal(body[0].tag,'ten98:rank:'+id);return Response.json({status_code:50000,cost:0});};
  assert.equal((await requestRankTasks(credentials,'live',[{id,request}],send)).httpStatus,200);assert.equal(calls,1);
  for(const tasks of [[],[{id,request},{id,request}],Array.from({length:101},()=>({id:randomUUID(),request})),[{id,request:{...request,pingback_url:'https://evil.test'}}],[{id:taskId,request}]])await assert.rejects(requestRankTasks(credentials,'queued',tasks as never,send));
  await assert.rejects(requestRankTasks(credentials,'live',[{id,request},{id:randomUUID(),request}],send));assert.equal(calls,1);
  const max=Array.from({length:100},()=>({id:randomUUID(),request}));await requestRankTasks(credentials,'queued',max,async(url,init)=>{assert.equal(url,rankSerpEndpoints.queued);assert.equal(JSON.parse(init?.body as string).length,100);return Response.json({});});
});

test('task reads accept provider UUID shape and preserve original charge without allowing URL injection',async()=>{
  let calls=0;const raw={cost:0.003,tasks:[{id:taskId,status_code:20000}]};const read=await readRankTask(credentials,taskId,async(url,init)=>{calls++;assert.equal(url,rankSerpEndpoints.task+taskId);assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);return Response.json(raw);});assert.deepEqual(read.body,raw);
  for(const id of [taskId+'?url=x',taskId+'\n','../user_data',taskId+'/extra',encodeURIComponent(taskId+'/'),taskId.toUpperCase()])await assert.rejects(readRankTask(credentials,id,async()=>{calls++;return Response.json({});}));assert.equal(calls,1);
});

test('free recovery pages use bounded dispatch windows, metadata and offsets without making charge decisions',async()=>{
  const now=new Date('2026-10-13T12:00:00Z'),dispatchedAt=new Date('2026-10-13T11:59:00Z');let calls=0;
  const send:typeof fetch=async(url,init)=>{calls++;assert.equal(url,rankSerpEndpoints.reconcile);assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(init?.body as string),[{datetime_from:'2026-10-13 11:58:00 +00:00',datetime_to:'2026-10-13 12:00:00 +00:00',limit:1000,offset:1000,sort:'asc',include_metadata:true}]);return Response.json(envelope(rankSerpEndpoints.reconcile,[{id:taskId,cost:0.003,status:'20000',metadata:{tag:'unverified'}}]).body);};
  const result=await readRankReconciliation(credentials,{dispatchedAt,offset:1000},send,now);assert.ok(result.body);assert.equal(calls,1);
  for(const input of [{dispatchedAt:new Date('invalid')},{dispatchedAt:new Date('2026-09-01')},{dispatchedAt:new Date('2026-10-13T12:01:00Z')},{dispatchedAt,offset:10000},{dispatchedAt,offset:1},{dispatchedAt,endpoint:'https://evil.test'}])await assert.rejects(readRankReconciliation(credentials,input as never,send,now));assert.equal(calls,1);
});
