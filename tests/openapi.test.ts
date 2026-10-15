import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {nativeOpenApi} from '../src/server/openapi.ts';
import {handleApi} from '../src/server/api.ts';
import {promptBatch,promptPatch} from '../src/server/context-input.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';
import {analyticsQuery} from '../src/server/analytics.ts';
import {geographySearch} from '../src/lib/analytics-geography.ts';

test('static OpenAPI exposes exactly the supported 18 native operations with local references',()=>{
 assert.equal(nativeOpenApi.openapi,'3.1.2');assert.deepEqual(nativeOpenApi.servers,[{url:'/'}]);
 const ids:string[]=[];for(const[path,item]of Object.entries(nativeOpenApi.paths))for(const[method,op]of Object.entries(item)){
  assert.ok(['get','post'].includes(method));ids.push(op.operationId);assert.deepEqual(op.security,[{bearerAuth:[]}]);assert.equal(op['x-ten98-scopes'].length,1);
  assert.deepEqual([...path.matchAll(/\{([^}]+)\}/g)].map(x=>x[1]).sort(),op.parameters.filter((x:any)=>x.in==='path').map((x:any)=>x.name).sort());
  const names=op.parameters.map((x:any)=>x.in+':'+x.name);assert.equal(new Set(names).size,names.length);
 }
 assert.equal(ids.length,18);assert.equal(new Set(ids).size,18);assert.equal(ids.filter(x=>/Prompt/.test(x)).length,7);
 const walk=(x:any)=>{if(!x||typeof x!=='object')return;if(x.$ref){assert.match(x.$ref,/^#\/components\/schemas\//);assert.ok(Object.hasOwn(nativeOpenApi.components.schemas,x.$ref.split('/').at(-1)));}for(const v of Object.values(x))walk(v);};walk(nativeOpenApi);
 const params=nativeOpenApi.paths['/api/projects/{projectId}/explore'].get.parameters as any[];
 assert.ok(params.some(x=>x.name==='eventName'));assert.ok(!params.some(x=>x.name==='event'||x.name==='screenWidth'));
 assert.equal(explorerQuery(new URLSearchParams({eventName:'signup'})).filters.eventName,'signup');
});
test('published batch/patch limits match native strict input and atomic batch semantics',()=>{
 const schemas=nativeOpenApi.components.schemas;assert.equal(schemas.PromptBatch.additionalProperties,false);assert.equal((schemas.PromptBatch.properties.prompts as {maxItems:number}).maxItems,100);
 const input={requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'  Prompt '+i+'  '}))};assert.equal(promptBatch.parse(input).prompts[0].text,'Prompt 0');
 assert.equal(promptBatch.safeParse({...input,prompts:[...input.prompts,{text:'101'}]}).success,false);assert.equal(promptBatch.safeParse({...input,execute:true}).success,false);
 assert.equal(promptPatch.safeParse({requestId:randomUUID(),revision:1}).success,false);assert.equal(promptPatch.safeParse({requestId:randomUUID(),revision:1,enabled:false}).success,true);
});
test('published location detail choices match the native parser and preserve normalized search bounds',()=>{
 const params=nativeOpenApi.paths['/api/projects/{projectId}/analytics'].get.parameters as any[];
 const schema=(name:string)=>params.find(x=>x.name===name)?.schema;
 assert.deepEqual(schema('geoDetail').enum,['region','city']);assert.deepEqual(schema('geoPeriod').enum,['current','comparison']);assert.equal(schema('geoPeriod').default,'current');assert.equal(schema('geoSearch').default,'');assert.equal(schema('geoSearch').maxLength,2048);
 for(const field of schema('geoDetail').enum)for(const period of schema('geoPeriod').enum){
  const result=analyticsQuery(new URLSearchParams({from:'2025-01-01',to:'2026-01-01',geoDetail:field,geoPeriod:period,compare:'yoy',geoSearch:'  Cafe\u0301%_  '}));
  assert.deepEqual(result.detail,{field,period,search:'Café%_'});
 }
 assert.deepEqual(analyticsQuery(new URLSearchParams({geoDetail:'city'})).detail,{field:'city',period:schema('geoPeriod').default,search:schema('geoSearch').default});
 assert.equal(Object.hasOwn(analyticsQuery(new URLSearchParams()),'detail'),false);
 const detail=(geoSearch:string)=>analyticsQuery(new URLSearchParams({geoDetail:'region',geoSearch})).detail;
 assert.equal(detail(' '.repeat(1920)+'x'.repeat(128))?.search,'x'.repeat(128));assert.equal(detail('😀'.repeat(128))?.search,'😀'.repeat(128));
 for(const value of [' '.repeat(1921)+'x'.repeat(128),'x'.repeat(129),'x\u0000'])assert.throws(()=>detail(value));
 assert.equal(geographySearch('\ud800'),null); // URLSearchParams replaces lone surrogates before the query parser sees them.
 const invalid:Record<string,string>[]=[{geoSearch:'x'},{geoPeriod:'current'},{geoDetail:'country'},{geoDetail:'city',geoPeriod:'comparison'},{geoDetail:'city',geoPeriod:'previous'},{geoDetail:'city',offset:'500'}];
 for(const value of invalid)assert.throws(()=>analyticsQuery(new URLSearchParams(value)));
 for(const name of ['geoDetail','geoPeriod','geoSearch']){const query=new URLSearchParams({geoDetail:'city'});query.append(name,name==='geoDetail'?'city':'');query.append(name,'');assert.throws(()=>analyticsQuery(query));}
});
test('specification bypasses invalid configuration and database/setup, with no reflected host or credentials',async()=>{
 const previous=process.env.APP_URL;process.env.APP_URL='not a URL';
 try{const response=await handleApi(new Request('https://untrusted.example/api/openapi.json',{headers:{authorization:'Bearer private-sentinel'}}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.deepEqual(body,nativeOpenApi);assert.equal(JSON.stringify(body).includes('untrusted.example'),false);assert.equal(JSON.stringify(body).includes('private-sentinel'),false);
 for(const request of [new Request('https://untrusted.example/api/openapi.json?x=1'),new Request('https://untrusted.example/api/openapi.json',{headers:{'content-length':'1'}})])assert.equal((await handleApi(request)).status,400);
 assert.equal((await handleApi(new Request('https://untrusted.example/api/openapi.json',{method:'POST',body:'{}'}))).status,405);
 }finally{if(previous===undefined)delete process.env.APP_URL;else process.env.APP_URL=previous;}
});
