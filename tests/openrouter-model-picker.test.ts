import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type * as Picker from '../src/components/OpenRouterModelPicker.tsx';

// Same installed JSX transform used by rank-tracking-fields.test.ts. No app,
// listener, database or provider is started; the transport uses in-memory bodies.
const source=await readFile(new URL('../src/components/OpenRouterModelPicker.tsx',import.meta.url),'utf8');
let compiled=(await transformWithOxc(source,'OpenRouterModelPicker.tsx',{jsx:{runtime:'automatic'}})).code;
for(const [specifier,target]of [['react',import.meta.resolve('react')],['react/jsx-runtime',import.meta.resolve('react/jsx-runtime')],['@ten98/runtime',import.meta.resolve('@ten98/runtime')],['../lib/api',new URL('../src/lib/api.ts',import.meta.url).href],['../lib/openrouter-models',new URL('../src/lib/openrouter-models.ts',import.meta.url).href]])compiled=compiled.replaceAll(JSON.stringify(specifier),JSON.stringify(target));
const {readModelCatalog,validObservedModels,validModelQuoteRoute,validModelReservation,modelUsdMicros,modelApi,ModelResponseError,OpenRouterModelPicker}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64')) as typeof Picker;
const model={id:'vendor/text-v1',canonicalSlug:'vendor/text-v1',name:'Text model',contextLength:1000,maxCompletionTokens:100,promptPrice:'0.0000001',completionPrice:'0.00000001',requestPrice:'0',structuredOutput:true,expirationDate:null,admission:'candidate' as const,reason:null};
const catalog={version:'openrouter-text-catalog-v1' as const,status:'fresh' as const,fetchedAt:'2026-10-15T12:00:00.000Z',revision:'a'.repeat(64),complete:true,models:[model]};
const route={model:model.id,tag:'vendor/exact',providerName:'Actual Provider',profile:'openrouter-api-text-no-search-v2' as const,contextLength:1000,promptCapacity:3,completionCapacity:100,promptPrice:model.promptPrice,completionPrice:model.completionPrice,requestPrice:'0',estimateUsd:'0.000001'};

test('complete catalog preserves zero/unknown/unsupported facts and rejects partial or malformed identity',()=>{
 const unknown={...model,id:'vendor/unknown',canonicalSlug:'vendor/unknown',promptPrice:null,admission:'unsupported' as const,reason:'Published prices are unavailable.'};
 const free={...model,id:'vendor/free',canonicalSlug:'vendor/free',promptPrice:'0',completionPrice:'0',admission:'unsupported' as const,reason:'Free routes need zero-reservation accounting.'};
 const value={...catalog,models:[model,unknown,free]};assert.deepEqual(readModelCatalog(value),value);assert.deepEqual(readModelCatalog({version:catalog.version,status:'unavailable',fetchedAt:null,revision:null,complete:false,models:[]}).models,[]);
 for(const invalid of [{...catalog,complete:false},{...catalog,models:[model,model]},{...catalog,models:[{...model,promptPrice:null}]},{...catalog,models:[{...model,id:'vendor/text-v1\n'}]},{...catalog,models:[{...model,promptPrice:0}]},{...catalog,models:[{...model,reason:'candidate cannot carry refusal'}]},{...catalog,models:[{...free,admission:'candidate',reason:null}]},{...catalog,models:[{...model,expirationDate:'2026-02-30'}]},{...catalog,extra:true},{...catalog,models:Array.from({length:2001},(_,i)=>({...model,id:'vendor/m'+i}))}])assert.throws(()=>readModelCatalog(invalid));
 assert.equal(unknown.promptPrice,null);assert.equal(free.promptPrice,'0');
});
test('observed options are historical syntax, independent of current discovery and bounded honestly',()=>{
 assert.equal(validObservedModels({values:['retired/old-model'],complete:true}),true);assert.equal(validObservedModels({values:[],complete:false}),true);
 for(const value of [{values:['retired/old-model','retired/old-model'],complete:true},{values:['vendor/m\n'],complete:true},{values:Array.from({length:1001},(_,i)=>'vendor/m'+i),complete:false},{values:[],complete:'false'},{values:[],complete:false,extra:0}])assert.equal(validObservedModels(value),false);
});
test('actual quote DTO validates exact per-route microUSD rounding, ordered selection and summed reservation',()=>{
 assert.equal(validModelQuoteRoute(route),true);assert.equal(validModelReservation([route],'0.000001',[route.model],16),true);
 const second={...route,model:'other/text',tag:'other',providerName:'Other Provider'};
 // Each 0.46 microUSD route rounds independently; a single combined rounding is wrong.
 assert.equal(validModelReservation([route,second],'0.000002',[route.model,second.model],16),true);
 const high={...route,contextLength:2_000_000,promptCapacity:1_000_000,promptPrice:'1',completionPrice:'0',estimateUsd:'1000000.000000'};
 assert.equal(validModelReservation([high,{...high,model:second.model}],'2000000.000000',[high.model,second.model],16),true,'Two independent admitted routes may have a sum above the per-route ceiling.');
 for(const [routes,total,models,output]of [[[route,second],'0.000001',[route.model,second.model],16],[[second,route],'0.000002',[route.model,second.model],16],[[route,route],'0.000002',[route.model,route.model],16],[[{...route,estimateUsd:'0.000002'}],'0.000002',[route.model],16],[[route],'0.000001',[route.model],101],[[{...route,contextLength:16}],'0.000001',[route.model],16]] as const)assert.equal(validModelReservation(routes,total,[...models],output),false);
 for(const invalid of [{...route,estimateMicros:'1'},{...route,profile:'other-profile'},{...route,providerName:''},{...route,tag:'vendor/../other'},{...route,contextLength:2},{...route,estimateUsd:'0.000000'}])assert.equal(validModelQuoteRoute(invalid),false);
 const {profile:_,contextLength:__,...old}=route;assert.equal(validModelQuoteRoute({...old,model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI'}),true);assert.equal(validModelQuoteRoute(old),false);
 assert.equal(modelUsdMicros('1000000.000000'),1_000_000_000_000n);assert.equal(modelUsdMicros('1000000.000001'),null);assert.equal(modelUsdMicros('1e-6'),null);
});
test('passive picker renders exact selections and pricing without selecting, refreshing or requesting a quote',()=>{
 let changes=0,refreshes=0;const html=renderToStaticMarkup(createElement(OpenRouterModelPicker,{catalog,selected:['retired/old-model'],maximum:2,disabled:false,refreshing:false,canRefresh:true,onChange:()=>changes++,onRefresh:()=>refreshes++}));
 assert.match(html,/retired\/old-model/);assert.match(html,/not in the saved catalog/);assert.match(html,/USD 0\.0000001/);assert.match(html,/\/ token/);assert.match(html,/Refresh model list/);assert.match(html,/type="search"/);assert.match(html,/type="button"/);assert.equal(changes,0);assert.equal(refreshes,0);
 const empty=renderToStaticMarkup(createElement(OpenRouterModelPicker,{catalog,selected:[],maximum:1,structured:true,disabled:false,refreshing:false,canRefresh:false,onChange:()=>changes++,onRefresh:()=>refreshes++}));assert.match(empty,/0 of 1 selected/);assert.ok(!empty.includes('checked=""'));assert.equal(changes,0);
});
test('bounded JSON transport checks complete bytes, fatal UTF8, refusals and cancellation without network',async()=>{
 const originalFetch=globalThis.fetch,originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');const origin='http://127.0.0.1:3111',path='/api/projects/00000000-0000-4000-8000-000000000001/openrouter-models';let calls=0,cancelled=0;
 Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin}}});
 const response=(body:BodyInit|ReadableStream,headers:Record<string,string>={},status=200)=>{const r=new Response(body,{status,headers:{'content-type':'application/json',...headers}});Object.defineProperty(r,'url',{value:origin+path});return r;};
 const mock=(r:Response)=>{globalThis.fetch=async()=>{calls++;return r;};};
 try{
  const bytes='"'+'x'.repeat(2*1024*1024-2)+'"';mock(response(bytes,{'content-length':String(bytes.length)}));assert.equal((await modelApi<string>(path)).length,bytes.length-2);
  mock(response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled++;}})));await assert.rejects(modelApi(path),/size limit/);assert.equal(cancelled,1);
  mock(response(new Uint8Array([34,0xc3,34])));await assert.rejects(modelApi(path),(e:any)=>e instanceof ModelResponseError&&e.readOnly);
  mock(response('bad'));await assert.rejects(modelApi(path,{method:'POST',body:{}}),(e:any)=>e instanceof ModelResponseError&&!e.readOnly,'An unconfirmed write must retain its manual retry identity.');
  mock(response('{}',{'content-length':'3'}));await assert.rejects(modelApi(path),/incomplete/);
  mock(response('bad',{},401));await assert.rejects(modelApi(path),(e:any)=>e.status===401);
  mock(response('{"error":"Try later"}',{},502));await assert.rejects(modelApi(path),(e:any)=>e.status===502&&e.message==='Try later');
  mock(response('{}'));assert.deepEqual(await modelApi(path),{});
  const ac=new AbortController();mock(response(new ReadableStream({cancel(){cancelled++;}})));const pending=modelApi(path,{signal:ac.signal});ac.abort();await assert.rejects(pending);assert.equal(cancelled,2);
  const before=calls;await assert.rejects(modelApi('https://example.test/'));assert.equal(calls,before);
 }finally{globalThis.fetch=originalFetch;if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');}
});
