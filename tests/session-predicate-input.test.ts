import assert from 'node:assert/strict';
import test from 'node:test';
import {parseAdvancedPredicates} from '../src/server/advanced-predicate-input.ts';
import {explorerQuery} from '../src/server/explorer-input.ts';
import {parseSegmentDefinition} from '../src/server/segment-input.ts';
import {parseCohortDefinition} from '../src/server/cohort-input.ts';

const now=new Date('2026-10-14T12:00:00Z');
const field={field:'path',operator:'eq',value:'/optional'};
const row=(operator='eq',type='string',value:unknown='')=>({key:'a\\.b',operator,type,value});
const group=(sessionProperties:unknown[]=[],fields:unknown[]=[],properties:unknown[]=[],match='all')=>({version:1,match,fields,properties,sessionProperties});
const params=(predicates:unknown,extra:Record<string,string>={})=>new URLSearchParams({...extra,predicates:JSON.stringify(predicates)});
const session=(value:unknown)=>parseAdvancedPredicates(group([value])).sessionProperties![0];

test('absent and empty session groups preserve legacy canonical bytes through all input paths',()=>{
  const legacy={version:1,match:'all',fields:[field],properties:[row()]};
  const empty={sessionProperties:[],...legacy},canonical=JSON.stringify(legacy);
  for(const value of [legacy,empty]){
    assert.equal(JSON.stringify(parseAdvancedPredicates(value)),canonical);
    assert.equal(JSON.stringify(explorerQuery(params(value),now).predicates),canonical);
    assert.equal(Object.hasOwn(parseAdvancedPredicates(value),'sessionProperties'),false);
  }
  const definition=(query:string)=>({schemaVersion:1,name:'  Saved 🐎  ',query});
  assert.deepEqual(parseSegmentDefinition(definition(params(empty).toString())),parseSegmentDefinition(definition(params(legacy).toString())));
  const dates={from:'2024-02-29',to:'2024-03-01',timeZone:'Asia/Dubai',path:'/required'};
  assert.deepEqual(parseCohortDefinition(definition(params(empty,dates).toString()),now),parseCohortDefinition(definition(params(legacy,dates).toString()),now));
});

test('session clauses use their own ordered AND group; only fields can use any',()=>{
  const input={sessionProperties:[{value:' A,b%_\\ 🐎 ',type:'string',operator:'eq',key:'a\\.b'},row('neq')],properties:[],fields:[],match:'all',version:1};
  const parsed=parseAdvancedPredicates(input);
  assert.equal(JSON.stringify(parsed),JSON.stringify({version:1,match:'all',fields:[],properties:[],sessionProperties:[row('eq','string',' A,b%_\\ 🐎 '),row('neq')]}));
  assert.deepEqual(parseAdvancedPredicates(JSON.parse(JSON.stringify(parsed))),parsed);
  assert.equal(parsed.sessionProperties!.length,2);
  assert.throws(()=>parseAdvancedPredicates(group([row()],[],[],'any')),{status:400});
  assert.throws(()=>parseAdvancedPredicates(group()),{status:400});
  assert.doesNotThrow(()=>parseAdvancedPredicates(group([row()],[field],[],'any')));
  for(const extra of [{sessionMatch:'any'},{scope:'session'},{sessionProperties:undefined},{sessionProperties:null},{fields:undefined},{properties:undefined}]){
    assert.throws(()=>parseAdvancedPredicates({...group([row()]),...extra}),{status:400});
  }
});

test('session rows reuse the complete typed matrix without coercion or losing exact values',()=>{
  const cases:unknown[]=[{key:'a\\.b',operator:'exists'},{key:'a\\.b',operator:'missing'}];
  for(const operator of ['eq','neq','contains','not_contains','prefix','suffix','regex','not_regex'])cases.push(row(operator,'string',' A,b%_\\ 🐎 '));
  for(const operator of ['eq','neq','gt','gte','lt','lte'])cases.push(row(operator,'number',-12.3456789));
  for(const [type,value]of [['string',''],['string','2024-02-29T00:00:00Z'],['number',0],['boolean',false],['null',null],['array',[]],['array',['1',1,null,false]],['date','0000-02-29T00:00:00.123456789Z']] as const){
    for(const operator of ['eq','neq'])cases.push(row(operator,type,value));
  }
  for(const operator of ['includes','not_includes'])for(const value of ['1',1,false,null,'','2024-02-29T00:00:00Z'])cases.push(row(operator,'array',value));
  for(const operator of ['before','after'])for(const value of ['1970-01-01','2024-02-29','9998-12-31'])cases.push(row(operator,'date',value));
  for(const value of cases){
    assert.deepEqual(session(value),value);
    assert.deepEqual(session(value),parseAdvancedPredicates(group([],[],[value])).properties[0]);
  }
  assert.deepEqual(session(row('eq','date','2024-02-29T23:10:20.123456789+04:00')),row('eq','date','2024-02-29T19:10:20.123456789Z'));
  assert.doesNotThrow(()=>session(row('regex','string','['))); // PostgreSQL validates its own regex engine later.
  const values=[null,true,1,'date'],parsed=session(row('eq','array',values));
  values.push('later');assert.deepEqual('value'in parsed?parsed.value:null,[null,true,1,'date']);
});

test('session types, presence operands, aliases and native text/array limits stay strict',()=>{
  for(const value of [{key:'x',operator:'exists',value:undefined},{key:'x',operator:'missing',type:'null'},
    {...row(),scope:'session'},{...row(),source:'event'},row('eq','number','1'),row('eq','boolean',0),row('eq','null','null'),
    row('gt','string','1'),row('contains','array','1'),row('includes','array',[]),row('eq','number',Infinity),row('eq','number',1e15+1),
    row('eq','date','2024-02-30T00:00:00Z'),row('before','date','2024-02-29T00:00:00Z'),row('after','date','1969-12-31'),
    row('before','date','9999-01-01'),row('before','date','2023-02-29'),row('eq','array',Array(51).fill(1)),
    row('eq','string','🐎'.repeat(501)),row('eq','string','bad\ud800'),row('eq','string','bad\0'),{key:'🐎'.repeat(161),operator:'missing'}]){
    assert.throws(()=>session(value),{status:400});
  }
  for(const operator of ['contains','not_contains','prefix','suffix','regex','not_regex'])assert.throws(()=>session(row(operator)),{status:400});
  assert.doesNotThrow(()=>session(row('eq','string','🐎'.repeat(500))));
  assert.doesNotThrow(()=>session({key:'🐎'.repeat(160),operator:'missing'}));
});

test('event and session properties share ten slots and all groups share twenty',()=>{
  const mixed=group(Array(5).fill(row()),Array(10).fill(field),Array(5).fill(row()));
  const parsed=parseAdvancedPredicates(mixed);
  assert.equal(parsed.fields.length+parsed.properties.length+parsed.sessionProperties!.length,20);
  assert.equal(parseAdvancedPredicates(group(Array(10).fill(row()))).sessionProperties!.length,10);
  for(const value of [group(Array(11).fill(row())),group(Array(6).fill(row()),[],Array(5).fill(row())),
    group(Array(5).fill(row()),Array(11).fill(field),Array(5).fill(row())),group([row()],Array(20).fill(field))]){
    assert.throws(()=>parseAdvancedPredicates(value),{status:400});
  }
});

test('session containers and operands reject hooks, holes, symbols and extras without executing them',()=>{
  let calls=0;
  const hooked=Object.defineProperty(row(),'toJSON',{value(){calls++;return {};}});
  const getter=Object.defineProperty(row(),'value',{enumerable:true,get(){calls++;return '';}});
  const proxy=new Proxy(row(),{getPrototypeOf(){calls++;return Object.prototype;}});
  const arrayGetter=Object.defineProperty([row()],'0',{get(){calls++;return row();}});
  const arrayExtra=Object.assign([row()],{extra:true});
  const arraySymbol=Object.assign([row()],{[Symbol('extra')]:true});
  const arrayProxy=new Proxy([row()],{get(){calls++;return 1;}});
  const topGetter=Object.defineProperty(group([row()]),'sessionProperties',{enumerable:true,get(){calls++;return [];}});
  for(const value of [group([hooked]),group([getter]),group([proxy]),group(Array(1)),group(arrayGetter),group(arrayExtra),group(arraySymbol),group(arrayProxy),topGetter,
    group([{...row(),[Symbol('extra')]:true}]),group([row('eq','array',Object.assign([1],{extra:true}))])]){
    assert.throws(()=>parseAdvancedPredicates(value),{status:400});
  }
  assert.equal(calls,0);
});

test('Explorer, saved filters and cohort qualification round-trip all groups without changing legacy constraints',()=>{
  const predicates=group([row('eq','date','2024-02-29T12:00:00.1234567+04:00'),{key:'absent',operator:'missing'}],[field],[row('eq','boolean',false)],'any');
  const exact={kind:'custom',path:'/required',campaignSource:'',propertyKey:'required',propertyType:'null',propertyValue:'null'};
  const request=params(predicates,{...exact,from:'2024-02-29',to:'2024-03-01',timeZone:'Asia/Dubai'}),original=request.toString();
  const report=explorerQuery(request,now),canonical=parseAdvancedPredicates(predicates);
  assert.deepEqual(report.predicates,canonical);assert.deepEqual(report.filters,{path:'/required',campaignSource:''});
  assert.deepEqual(report.property,{key:'required',type:'null',value:null});assert.equal(report.timeZone,'Asia/Dubai');
  assert.equal(request.toString(),original);
  const saved=parseSegmentDefinition({schemaVersion:1,name:'  Filters 🐎  ',query:params(predicates,exact).toString()});
  assert.equal(saved.name,'Filters 🐎');assert.deepEqual(parseSegmentDefinition(saved),saved);
  assert.deepEqual(explorerQuery(new URLSearchParams(saved.query),now).predicates,canonical);
  const cohort=parseCohortDefinition({schemaVersion:1,name:'  Qualified 🐎  ',query:original},now);
  assert.deepEqual(parseCohortDefinition(cohort,now),cohort);assert.equal(cohort.name,'Qualified 🐎');
  assert.deepEqual(explorerQuery(new URLSearchParams(cohort.query),now),report);
  for(const [key,value]of Object.entries({groupBy:'path',cursor:'next',cohortId:'4455af22-3e1b-4aa8-a837-20189d42a615'})){
    const forbidden=new URLSearchParams(cohort.query);forbidden.set(key,value);
    assert.throws(()=>parseCohortDefinition({...cohort,query:forbidden.toString()},now),{status:400});
    const segment=new URLSearchParams(saved.query);segment.set(key,value);
    assert.throws(()=>parseSegmentDefinition({...saved,query:segment.toString()}),{status:400});
  }
  const both=new URLSearchParams(cohort.query);both.set('eventName','also');
  assert.throws(()=>parseCohortDefinition({...cohort,query:both.toString()},now),{status:400});
  request.append('predicates',JSON.stringify(predicates));assert.throws(()=>explorerQuery(request,now),{status:400});
});

test('session normalization is included in the full query cap with report defaults',()=>{
  const predicates=group([row('eq','date','2024-01-01T00:00:00Z')]);
  const request=params(predicates,{path:'中'.repeat(2048),eventName:'中'.repeat(100),language:''});
  const canonical=new URLSearchParams(request);canonical.set('predicates',JSON.stringify(parseAdvancedPredicates(predicates)));
  for(const [key,value]of Object.entries({from:'2026-10-08',to:'2026-10-14',timeZone:'UTC',kind:'all',groupBy:'event'}))canonical.set(key,value);
  const padding=20000-canonical.toString().length;assert.ok(padding>=0&&padding<320);
  request.set('language','a'.repeat(padding));canonical.set('language','a'.repeat(padding));assert.equal(canonical.toString().length,20000);
  const original=request.toString();assert.doesNotThrow(()=>explorerQuery(request,now));assert.equal(request.toString(),original);
  request.set('language','a'.repeat(padding+1));assert.ok(request.toString().length<20000);
  assert.throws(()=>explorerQuery(request,now),{status:400});
  assert.throws(()=>parseAdvancedPredicates(group(Array(10).fill(row('eq','string','中'.repeat(1000))))),{status:400});
});
