import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCohortDefinition} from '../src/server/cohort-input.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';

const calendar={from:'2026-10-01',to:'2026-10-14',timeZone:'Asia/Dubai'};
const saved=(query:string,name='Cohort')=>parseCohortDefinition({schemaVersion:1,name,query});
const query=(fields:Record<string,string>={path:'/offer'})=>new URLSearchParams({...calendar,...fields}).toString();

test('cohort qualification rejects future local days without restricting ordinary report calendars',()=>{
  const now=new Date('2026-10-14T00:30:00Z');
  const definition=(day:string,timeZone:string)=>({schemaVersion:1,name:'Local day',query:query({path:'/offer',from:day,to:day,timeZone})});
  assert.doesNotThrow(()=>parseCohortDefinition(definition('2026-10-13','America/Los_Angeles'),now));
  assert.throws(()=>parseCohortDefinition(definition('2026-10-14','America/Los_Angeles'),now),{status:400});
  assert.doesNotThrow(()=>parseCohortDefinition(definition('2026-10-14','Asia/Dubai'),now));
  assert.throws(()=>parseCohortDefinition(definition('2026-10-15','Asia/Dubai'),now),{status:400});
  const future=definition('2099-01-01','UTC');
  assert.throws(()=>parseCohortDefinition(future,now),{status:400});
  assert.doesNotThrow(()=>explorerQuery(new URLSearchParams(future.query),now));
});

test('cohort qualification round trips fixed dates, exact literals, empty values and explicit event kind',()=>{
  const value=saved(new URLSearchParams({campaignSource:'',path:'/offer,100% 🐎',kind:'custom',...calendar}).toString(),'  Offers  ');
  assert.deepEqual(value,{schemaVersion:1,name:'Offers',query:'from=2026-10-01&to=2026-10-14&timeZone=Asia%2FDubai&kind=custom&path=%2Foffer%2C100%25+%F0%9F%90%8E&campaignSource='});
  const restored=explorerQuery(new URLSearchParams(value.query));
  assert.deepEqual(restored.filters,{path:'/offer,100% 🐎',campaignSource:''});
  assert.equal(Object.hasOwn(restored.filters,'campaignMedium'),false);
  assert.equal(restored.kind,'custom');assert.deepEqual(parseCohortDefinition(value),value);
  assert.equal(new URLSearchParams(saved(query()).query).get('kind'),'all');
  const actions:Record<string,string>[]=[{path:''},{eventName:''},{eventName:'  signup,paid  '}];
  for(const action of actions){
    const definition=saved(query(action));
    assert.deepEqual(explorerQuery(new URLSearchParams(definition.query)).filters,action);
    assert.deepEqual(parseCohortDefinition(definition),definition);
  }
  const fields={eventName:'signup',kind:'pageviews',origin:'https://example.com',referrer:'www.example.net',language:'en-AE',campaignSource:'',campaignMedium:'cpc',campaignName:'October',campaignTerm:'new homes',campaignContent:'a_b%'};
  const {kind,...filters}=fields,other=explorerQuery(new URLSearchParams(saved(query(fields)).query));
  assert.equal(other.kind,kind);assert.deepEqual(other.filters,filters);
});

test('cohort typed properties preserve exact type, escaped keys and timestamp fractional precision',()=>{
  for(const [type,value,expected] of [
    ['missing',undefined,null],['null',null,null],['string','', ''],['string','42','42'],['number',42,42],['boolean',false,false],
    ['string','2024-02-29T00:00:00Z','2024-02-29T00:00:00Z'],
    ['date','2024-02-29T12:00:00.123456+04:00','2024-02-29T08:00:00.123456Z'],['array',['42',42,null],['42',42,null]]] as const){
    const params=new URLSearchParams(query({eventName:'signup',propertyKey:'a\\.b 🐎',propertyType:type}));
    if(value!==undefined)params.set('propertyValue',JSON.stringify(value));
    const definition=saved(params.toString()),restored=new URLSearchParams(definition.query);
    assert.deepEqual(explorerQuery(restored).property,{key:'a\\.b 🐎',type,value:expected});
    assert.equal(restored.has('propertyValue'),type!=='missing');assert.deepEqual(parseCohortDefinition(definition),definition);
  }
});

test('cohorts require explicit valid bounded calendar dates, timezone and exactly one action field',()=>{
  for(const omitted of ['from','to','timeZone','path']){
    const params=new URLSearchParams(query());params.delete(omitted);
    assert.throws(()=>saved(params.toString()),{status:400});
  }
  const invalid:Record<string,string>[]=[{path:'/offer',eventName:'signup'},{path:'',eventName:''},{path:'/offer',from:''},{path:'/offer',timeZone:''},
    {path:'/offer',timeZone:'No/Such_Zone'},{path:'/offer',from:'2024-02-30'},{path:'/offer',to:'2026-09-30'},
    {path:'/offer',from:'2024-01-01',to:'2025-01-01'}];
  for(const fields of invalid)assert.throws(()=>saved(query(fields)),{status:400});
  assert.doesNotThrow(()=>saved(query({path:'/offer',from:'2024-01-01',to:'2024-12-31'})));
  assert.doesNotThrow(()=>saved(query({eventName:'signup',to:calendar.from})));
  const value=saved(query({path:'/offer',timeZone:'Etc/UTC'}));
  assert.equal(new URLSearchParams(value.query).get('timeZone'),'UTC');
});

test('cohorts reject report state, recursive references, repeated fields and malformed native predicates',()=>{
  for(const extra of ['groupBy=event','groupProperty=x','cursor=x','cohortId=x','cohort=x','revision=1','segment=x','match=any','visitorId=x','unknown=x',
    'from=2026-10-02','timeZone=UTC','path=b','kind=all&kind=custom','propertyKey=x&propertyKey=y&propertyType=missing']){
    assert.throws(()=>saved(query()+'&'+extra),{status:400},extra);
  }
  const invalid:Record<string,string>[]=[{path:'/offer',kind:'no'},{path:'/offer',origin:'https://example.com/'},{path:'\0'},{path:'\ud800'},
    {path:'x'.repeat(2049)},{eventName:'x'.repeat(321)},
    {path:'/offer',propertyKey:'x',propertyType:'missing',propertyValue:'null'},
    {path:'/offer',propertyKey:'x',propertyType:'number',propertyValue:'"42"'},
    {path:'/offer',propertyKey:'x',propertyType:'date',propertyValue:'"2024-02-30T00:00:00Z"'}];
  for(const fields of invalid){
    // Raw lone surrogates must be checked before URLSearchParams replaces them.
    const raw=fields.path==='\ud800'?query().replace('%2Foffer','\ud800'):query(fields);
    assert.throws(()=>saved(raw),{status:400});
  }
  for(const raw of [null,[],{schemaVersion:2,name:'A',query:query()},{schemaVersion:1,name:'A',query:query(),unexpected:1},{name:'A',query:query()}])assert.throws(()=>parseCohortDefinition(raw),{status:400});
});

test('cohort names use the saved-filter UTF-16 boundary and reject malformed Unicode',()=>{
  for(const name of ['', '   ', 'x'.repeat(201),'🐎'.repeat(101),'bad\0name','bad\ud800name'])assert.throws(()=>saved(query(),name),{status:400});
  assert.equal(saved(query(),'  '+'🐎'.repeat(100)+'  ').name.length,200);
});

test('canonical defaults cannot save a cohort larger than its reload limit',()=>{
  let language='中'.repeat(160);
  const oversized=()=>query({path:'中'.repeat(2048),language});
  while(oversized().length<19991)language+='a';
  const boundary=saved(oversized());
  assert.equal(boundary.query.length,20000);assert.deepEqual(parseCohortDefinition(boundary),boundary);
  language+='aaaa';
  assert.equal(oversized().length,19995);
  assert.doesNotThrow(()=>explorerQuery(new URLSearchParams(oversized())));
  assert.throws(()=>saved(oversized()),{status:400});
});
