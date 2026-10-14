import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSegmentDefinition} from '../src/server/segment-input.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';

const saved=(query='',name='Saved filter')=>parseSegmentDefinition({schemaVersion:1,name,query});
test('saved filters preserve exact literals, explicit emptiness and absent fields with deterministic serialization',()=>{
  const value=saved(new URLSearchParams({campaignSource:'',path:'/offer_100% 🐎',eventName:'  signup  ',kind:'custom'}).toString(),'  Leads  ');
  assert.deepEqual(value,{schemaVersion:1,name:'Leads',query:'kind=custom&eventName=++signup++&path=%2Foffer_100%25+%F0%9F%90%8E&campaignSource='});
  const query=explorerQuery(new URLSearchParams(value.query));
  assert.deepEqual(query.filters,{eventName:'  signup  ',path:'/offer_100% 🐎',campaignSource:''});
  assert.equal(Object.hasOwn(query.filters,'campaignMedium'),false);
  assert.equal(saved().query,'kind=all');assert.deepEqual(parseSegmentDefinition(value),value);
});
test('saved typed predicates retain null versus missing and canonicalize dates without changing type',()=>{
  for(const [type,value,expected] of [
    ['missing',undefined,null],['null',null,null],['string','2024-02-29T00:00:00Z','2024-02-29T00:00:00Z'],
    ['number',42,42],['boolean',false,false],['date','2024-02-29T12:00:00+04:00','2024-02-29T08:00:00.000Z'],['array',['42',42,null],['42',42,null]]] as const){
    const params=new URLSearchParams({propertyKey:'a\\.b',propertyType:type});
    if(value!==undefined)params.set('propertyValue',JSON.stringify(value));
    const definition=saved(params.toString()),restored=new URLSearchParams(definition.query);
    assert.deepEqual(explorerQuery(restored).property,{key:'a\\.b',type,value:expected});
    assert.equal(restored.has('propertyValue'),type!=='missing');assert.deepEqual(parseSegmentDefinition(definition),definition);
  }
});
test('saved filters reject report state, ambiguous predicates, malformed values and unsupported schema',()=>{
  for(const query of ['from=2026-01-01','to=2026-01-01','timeZone=UTC','groupBy=event','groupProperty=x','cursor=x','kind=all&kind=custom',
    'path=a&path=b','kind=no','origin=https%3A%2F%2Fexample.com%2F','path=%00','path='+ 'x'.repeat(2049),
    'propertyKey=x&propertyType=missing&propertyValue=null','propertyKey=x&propertyType=number&propertyValue=%2242%22',
    'propertyKey=x&propertyType=date&propertyValue=%222024-02-30T00%3A00%3A00Z%22','propertyKey=x&propertyType=array&propertyValue=%7B%7D',
    'path=\ud800','path=\0','x'.repeat(20001)])assert.throws(()=>saved(query),{status:400});
  for(const raw of [null,[],{schemaVersion:2,name:'A',query:''},{schemaVersion:1,name:'A',query:'',unexpected:1},{name:'A',query:''}])assert.throws(()=>parseSegmentDefinition(raw),{status:400});
});
test('saved names are bounded Unicode text and queries do not lose supported exact fields',()=>{
  for(const name of ['', '   ', 'x'.repeat(201),'🐎'.repeat(101),'bad\0name','bad\ud800name'])assert.throws(()=>saved('',name),{status:400});
  assert.equal(saved('','🐎'.repeat(100)).name.length,200);
  const fields={origin:'https://example.com',referrer:'www.example.net',language:'en-AE',campaignMedium:'cpc',campaignName:'October',campaignTerm:'new homes',campaignContent:'a_b%'};
  assert.deepEqual(explorerQuery(new URLSearchParams(saved(new URLSearchParams(fields).toString()).query)).filters,fields);
});
test('adding a canonical default cannot save a filter that exceeds its own reload limit',()=>{
  let eventName='中'.repeat(170);
  const query=()=>new URLSearchParams({path:'中'.repeat(2048),eventName}).toString();
  while(query().length<19995)eventName+='a';
  assert.equal(query().length,19995);
  assert.doesNotThrow(()=>explorerQuery(new URLSearchParams(query())));
  assert.throws(()=>saved(query()),{status:400});
});

test('saved filters round trip additional groups after legacy predicates without moving required fields',()=>{
  const predicates={properties:[{operator:'missing',key:'absent'}],fields:[{value:'/a',field:'path',operator:'eq'},{operator:'eq',field:'path',value:'/b'}],match:'any',version:1};
  const definition=saved(new URLSearchParams({predicates:JSON.stringify(predicates),path:'/required',propertyKey:'empty',propertyType:'string',propertyValue:'""'}).toString());
  const params=new URLSearchParams(definition.query),parsed=explorerQuery(params);
  assert.deepEqual([...params.keys()],['kind','path','propertyKey','propertyType','propertyValue','predicates']);
  assert.deepEqual(parsed.filters,{path:'/required'});assert.deepEqual(parsed.property,{key:'empty',type:'string',value:''});
  assert.equal(parsed.predicates?.match,'any');assert.equal(parsed.predicates?.fields.length,2);
  assert.deepEqual(parseSegmentDefinition(definition),definition);
  assert.throws(()=>saved(definition.query+'&predicates='+params.get('predicates')),{status:400});
});

test('saved additional predicates include normalization and canonical defaults in the reload budget',()=>{
  const predicates={version:1,match:'all',fields:[],properties:[{key:'when',operator:'eq',type:'date',value:'2024-01-01T00:00:00Z'}]};
  const params=new URLSearchParams({path:'中'.repeat(2048),eventName:'中'.repeat(120),predicates:JSON.stringify(predicates),language:''});
  const padding=19988-params.toString().length;assert.ok(padding>=0&&padding<=320);
  params.set('language','a'.repeat(padding));assert.equal(params.toString().length,19988);
  assert.throws(()=>explorerQuery(params),{status:400});
  assert.throws(()=>saved(params.toString()),{status:400});
});
