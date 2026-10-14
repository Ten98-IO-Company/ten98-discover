import assert from 'node:assert/strict';
import test from 'node:test';
import {parseAdvancedPredicates} from '../src/server/advanced-predicate-input.ts';

const group=(fields:unknown[]=[],properties:unknown[]=[],match='all')=>({version:1,match,fields,properties});
const field=(operator='eq',value:unknown='a,b%_\\ 🐎')=>({field:'path',operator,value});
const property=(operator='eq',type='string',value:unknown='')=>({key:'a\\.b',operator,type,value});
const parseProperty=(input:unknown)=>parseAdvancedPredicates(group([],[input])).properties[0];

test('flat predicates canonicalize member order without changing literals, order or repeated clauses',()=>{
  const raw={properties:[{value:'2024-02-29T23:10:20.123456789+04:00',type:'date',operator:'eq',key:'when'}],
    fields:[{value:' A,b%_\\ 🐎 ',operator:'eq',field:'path'},{operator:'missing',field:'referrer'},field('neq','')],match:'any',version:1};
  const parsed=parseAdvancedPredicates(raw);
  assert.equal(JSON.stringify(parsed),JSON.stringify({version:1,match:'any',fields:[{field:'path',operator:'eq',value:' A,b%_\\ 🐎 '},
    {field:'referrer',operator:'missing'},{field:'path',operator:'neq',value:''}],properties:[{key:'when',operator:'eq',type:'date',value:'2024-02-29T19:10:20.123456789Z'}]}));
  assert.deepEqual(parseAdvancedPredicates(JSON.parse(JSON.stringify(parsed))),parsed);
  const repeated=parseAdvancedPredicates(group([field(),field()],[],'any'));
  assert.equal(repeated.fields.length,2);assert.notEqual(repeated.fields[0],repeated.fields[1]);
});

test('field operators retain literal text and leave PostgreSQL regex validation to the database',()=>{
  const operators=['eq','neq','contains','not_contains','prefix','suffix','regex','not_regex'];
  const value='a,b%_\\[[:digit:]] 🐎';
  const parsed=parseAdvancedPredicates(group(operators.map(operator=>field(operator,value))));
  assert.deepEqual(parsed.fields.map(item=>'value' in item?item.value:null),operators.map(()=>value));
  assert.doesNotThrow(()=>parseAdvancedPredicates(group([field('regex','[')])));
  assert.doesNotThrow(()=>parseAdvancedPredicates(group([{field:'origin',operator:'eq',value:'https://example.com:8443'}])));
  assert.doesNotThrow(()=>parseAdvancedPredicates(group([{field:'origin',operator:'contains',value:'example'}])));
  for(const operator of ['eq','neq'])assert.throws(()=>parseAdvancedPredicates(group([{field:'origin',operator,value:'https://example.com/'}])),{status:400});
  for(const operator of operators.slice(2)){
    assert.throws(()=>parseAdvancedPredicates(group([field(operator,'')])),{status:400});
    assert.throws(()=>parseProperty(property(operator,'string','')),{status:400});
  }
  for(const operator of ['eq','neq'])assert.equal((parseProperty(property(operator)) as {value:string}).value,'');
  for(const operator of ['exists','missing']){
    assert.deepEqual(parseAdvancedPredicates(group([{field:'path',operator}])).fields,[{field:'path',operator}]);
    assert.deepEqual(parseProperty({key:'a\\.b',operator}),{key:'a\\.b',operator});
  }
});

test('typed properties preserve false, null, arrays, date-looking strings and scalar membership types',()=>{
  for(const [type,value] of [['string','2024-02-29T00:00:00Z'],['number',0],['number',-1e15],['boolean',false],['null',null],['array',[]],['array',['1',1,null,false]]] as const){
    for(const operator of ['eq','neq'])assert.deepEqual(parseProperty(property(operator,type,value)),{key:'a\\.b',operator,type,value});
  }
  for(const operator of ['gt','gte','lt','lte'])assert.deepEqual(parseProperty(property(operator,'number',12.3456789)),{key:'a\\.b',operator,type:'number',value:12.3456789});
  for(const operator of ['contains','not_contains','prefix','suffix','regex','not_regex'])assert.deepEqual(parseProperty(property(operator,'string',' A%_\\ ')),{key:'a\\.b',operator,type:'string',value:' A%_\\ '});
  for(const value of ['1',1,false,null,'','2024-02-29T00:00:00Z']){
    for(const operator of ['includes','not_includes'])assert.deepEqual(parseProperty(property(operator,'array',value)),{key:'a\\.b',operator,type:'array',value});
  }
  const values=[null,true,1,'date'],parsed=parseProperty(property('eq','array',values));
  values.push('later');assert.deepEqual('value' in parsed?parsed.value:null,[null,true,1,'date']);
});

test('date equality preserves precision while before and after require bounded real calendar days',()=>{
  assert.deepEqual(parseProperty(property('neq','date','0000-02-29T00:00:00.123456789Z')),{key:'a\\.b',operator:'neq',type:'date',value:'0000-02-29T00:00:00.123456789Z'});
  for(const value of ['1970-01-01','2024-02-29','9998-12-31']){
    for(const operator of ['before','after'])assert.deepEqual(parseProperty(property(operator,'date',value)),{key:'a\\.b',operator,type:'date',value});
  }
  for(const value of ['1969-12-31','9999-01-01','2023-02-29','2024-02-30','2024-01-01T00:00:00Z','2024-01-01\n',' 2024-01-01'])assert.throws(()=>parseProperty(property('before','date',value)),{status:400});
  assert.throws(()=>parseProperty(property('eq','date','2024-01-01')),{status:400});
});

test('strict flat shape rejects unknown scope, nested logic and invalid operator/type/value combinations',()=>{
  const valid=group([field()]);
  for(const raw of [null,[],{}, {...valid,version:2},{...valid,match:'or'},{...valid,sessionProperty:[]},{...valid,not:valid},
    {...valid,fields:undefined},{...valid,properties:undefined},group(),group([],[property()],'any'),
    group([{...field(),field:'visitorId'}]),group([{...field(),operator:'not_prefix'}]),group([{...field(),type:'string'}]),
    group([{field:'path',operator:'exists',value:undefined}]),group([{field:'path',operator:'eq'}]),group([{all:[field()]}])]){
    assert.throws(()=>parseAdvancedPredicates(raw),{status:400});
  }
  for(const input of [{key:'x',operator:'missing',type:'null'},{key:'x',operator:'exists',value:null},{...property(),unknown:true},
    {key:'x',operator:'eq',type:'string'},property('eq','missing',null),property('eq','string',1),property('eq','number','1'),
    property('eq','boolean',0),property('eq','null','null'),property('eq','date','2024-02-30T00:00:00Z'),property('eq','array',{}),
    property('before','string','2024-01-01'),property('gt','string','1'),property('contains','array','1'),property('includes','string','x'),
    property('includes','array',[]),property('includes','array',{}),property('eq','number',NaN),property('eq','number',1e15+1),property('eq','number',Infinity)]){
    assert.throws(()=>parseProperty(input),{status:400});
  }
});

test('bounded counts, UTF-16 text and native array limits cannot expand into an oversized canonical query',()=>{
  assert.equal(parseAdvancedPredicates(group(Array(10).fill(field()),Array(10).fill(property()))).fields.length,10);
  assert.equal(parseAdvancedPredicates(group(Array(20).fill(field()))).fields.length,20);
  for(const input of [group(Array(21).fill(field())),group(Array(11).fill(field()),Array(10).fill(property())),group([] ,Array(11).fill(property()))])assert.throws(()=>parseAdvancedPredicates(input),{status:400});
  assert.doesNotThrow(()=>parseAdvancedPredicates(group([{field:'language',operator:'eq',value:'🐎'.repeat(160)}])));
  assert.doesNotThrow(()=>parseProperty({key:'🐎'.repeat(160),operator:'missing'}));
  for(const value of ['🐎'.repeat(161),'bad\ud800','bad\0']){
    assert.throws(()=>parseAdvancedPredicates(group([{field:'language',operator:'eq',value}])),{status:400});
    assert.throws(()=>parseProperty({key:value,operator:'missing'}),{status:400});
  }
  assert.doesNotThrow(()=>parseProperty(property('eq','string','🐎'.repeat(500))));
  assert.throws(()=>parseProperty(property('eq','string','🐎'.repeat(501))),{status:400});
  assert.throws(()=>parseProperty(property('eq','array',Array(51).fill(1))),{status:400});
  assert.throws(()=>parseAdvancedPredicates(group(Array(4).fill(field('eq','中'.repeat(1000))))),{status:400});
});

test('data-only parsing rejects sparse arrays and hooks without invoking them',()=>{
  let calls=0;
  const getter=Object.defineProperty({},'field',{enumerable:true,get(){calls++;return 'path';}});
  const proxy=new Proxy({}, {getPrototypeOf(){calls++;return Object.prototype;}});
  const hooked=Object.defineProperty(group([field()]),'toJSON',{value(){calls++;return {};}});
  const arrayGetter=Object.defineProperty([field()],'0',{get(){calls++;return field();}});
  for(const value of [getter,proxy,hooked,group([getter]),group(Array(1)),group(arrayGetter)])assert.throws(()=>parseAdvancedPredicates(value),{status:400});
  assert.equal(calls,0);
});
