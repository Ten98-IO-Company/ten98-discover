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
for(const [specifier,target]of [['react',import.meta.resolve('react')],['react/jsx-runtime',import.meta.resolve('react/jsx-runtime')],['@ten98/runtime/browser',import.meta.resolve('@ten98/runtime/browser')],['../lib/api',new URL('../src/lib/api.ts',import.meta.url).href],['../lib/openrouter-models',new URL('../src/lib/openrouter-models.ts',import.meta.url).href]])compiled=compiled.replaceAll(JSON.stringify(specifier),JSON.stringify(target));
const {readModelCatalog,validObservedModels,validModelPreparationRoute,validModelPreparation,modelApi,ModelResponseError,OpenRouterModelPicker}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64')) as typeof Picker;
const model={id:'vendor/text-v1',canonicalSlug:'vendor/text-v1',name:'Text model',contextLength:1000,maxCompletionTokens:100,structuredOutput:true,expirationDate:null,admission:'candidate' as const,reason:null};
const catalog={version:'openrouter-text-catalog-v1' as const,status:'fresh' as const,fetchedAt:'2026-10-15T12:00:00.000Z',revision:'a'.repeat(64),complete:true,models:[model]};
const route={model:model.id,tag:'vendor/exact',providerName:'Actual Provider',profile:'openrouter-api-text-no-search-v2' as const,contextLength:1000,promptCapacity:3,completionCapacity:100};

test('complete catalog preserves unknown capacities and rejects partial or malformed identity',()=>{
 const unknown={...model,id:'vendor/unknown',canonicalSlug:'vendor/unknown',contextLength:null,admission:'unsupported' as const,reason:'Context capacity is unavailable.'};
 const unsupported={...model,id:'vendor/unsupported',canonicalSlug:'vendor/unsupported',structuredOutput:false,admission:'unsupported' as const,reason:'Structured output is unavailable.'};
 const value={...catalog,models:[model,unknown,unsupported]};assert.deepEqual(readModelCatalog(value),value);assert.deepEqual(readModelCatalog({version:catalog.version,status:'unavailable',fetchedAt:null,revision:null,complete:false,models:[]}).models,[]);
 for(const invalid of [{...catalog,complete:false},{...catalog,models:[model,model]},{...catalog,models:[{...model,contextLength:null}]},{...catalog,models:[{...model,id:'vendor/text-v1\n'}]},{...catalog,models:[{...model,contextLength:'1000'}]},{...catalog,models:[{...model,reason:'candidate cannot carry refusal'}]},{...catalog,models:[{...model,expirationDate:'2026-02-30'}]},{...catalog,extra:true},{...catalog,models:Array.from({length:2001},(_,i)=>({...model,id:'vendor/m'+i}))}])assert.throws(()=>readModelCatalog(invalid));
 assert.equal(unknown.contextLength,null);assert.equal(unsupported.structuredOutput,false);
});

test('observed options are historical syntax, independent of current discovery and bounded honestly',()=>{
 assert.equal(validObservedModels({values:['retired/old-model'],complete:true}),true);assert.equal(validObservedModels({values:[],complete:false}),true);
 for(const value of [{values:['retired/old-model','retired/old-model'],complete:true},{values:['vendor/m\n'],complete:true},{values:Array.from({length:1001},(_,i)=>'vendor/m'+i),complete:false},{values:[],complete:'false'},{values:[],complete:false,extra:0}])assert.equal(validObservedModels(value),false);
});
test('preparation validates exact route identity, capacity, ordering and complete selection',()=>{
 assert.equal(validModelPreparationRoute(route),true);assert.equal(validModelPreparation([route],[route.model],16),true);
 const second={...route,model:'other/text',tag:'other',providerName:'Other Provider'};
 assert.equal(validModelPreparation([route,second],[route.model,second.model],16),true);
 for(const [routes,models,output]of [[[second,route],[route.model,second.model],16],[[route,route],[route.model,route.model],16],[[route],[route.model],101],[[{...route,contextLength:16}],[route.model],16],[[route],[],16],[[route],[route.model],15]] as const)assert.equal(validModelPreparation(routes,[...models],output),false);
 for(const invalid of [{...route,estimateMicros:'1'},{...route,profile:'other-profile'},{...route,providerName:''},{...route,tag:'vendor/../other'},{...route,contextLength:2},{...route,estimateUsd:'0.000000'}])assert.equal(validModelPreparationRoute(invalid),false);
 const {profile:_,contextLength:__,...old}=route;assert.equal(validModelPreparationRoute({...old,model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI'}),true);assert.equal(validModelPreparationRoute(old),false);
});

test('passive picker renders selections and capacities without starting a request',()=>{
 let changes=0,refreshes=0;const html=renderToStaticMarkup(createElement(OpenRouterModelPicker,{catalog,selected:['retired/old-model'],maximum:2,disabled:false,refreshing:false,canRefresh:true,onChange:()=>changes++,onRefresh:()=>refreshes++}));
 assert.match(html,/retired\/old-model/);assert.match(html,/not in the saved catalog/);assert.match(html,/Context 1000/);assert.match(html,/Output capacity 100/);assert.doesNotMatch(html,/USD|price|charge|cost|budget/i);assert.match(html,/Refresh model list/);assert.match(html,/type="search"/);assert.match(html,/type="button"/);assert.equal(changes,0);assert.equal(refreshes,0);
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
