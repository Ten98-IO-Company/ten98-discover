import assert from 'node:assert/strict';
import test from 'node:test';
import {parseAnalysisDefinition} from '../src/server/funnel-input.ts';

const path=(value='/start',match='exact')=>({type:'path',match,value});
const event=(properties:unknown[]=[])=>({type:'event',match:'exact',value:'purchase',properties});
const funnel=(extra:Record<string,unknown>={})=>({kind:'funnel',name:' Checkout ',windowMinutes:5,steps:[path(),event()],...extra});
const goal=(extra:Record<string,unknown>={})=>({kind:'goal',name:' Purchase ',condition:event(),...extra});
const rejected=(input:unknown)=>assert.throws(()=>parseAnalysisDefinition(input),{status:400});

test('saved definitions normalize labels and defaults without changing literal matching text',()=>{
  const raw=funnel({steps:[path('/literal%_*\\path'),{type:'event',match:'contains',value:' Sign Up '}]});
  const before=structuredClone(raw),parsed=parseAnalysisDefinition(raw);
  assert.deepEqual(raw,before,'Parsing must not rewrite caller-owned request objects.');
  assert.deepEqual(parsed,{kind:'funnel',name:'Checkout',description:'',windowMinutes:5,steps:[
    {...path('/literal%_*\\path'),pageViewsOnly:false,properties:[]},
    {type:'event',match:'contains',value:' Sign Up ',pageViewsOnly:false,properties:[]},
  ]});
  assert.deepEqual(parseAnalysisDefinition({kind:'goal',name:' Purchase ',condition:path('/thank-you')}),{
    kind:'goal',name:'Purchase',description:'',condition:path('/thank-you'),
  });
  assert.equal(parseAnalysisDefinition(funnel({windowMinutes:1440,steps:Array.from({length:8},()=>path())})).kind,'funnel');
  assert.equal(parseAnalysisDefinition(funnel({steps:[path('checkout','contains'),path('.html','suffix')]})).kind,'funnel');
});

test('definitions reject unknown fields, invalid kinds and ambiguous or unbounded predicates',()=>{
  for(const input of [null,[],{},funnel({unknown:true}),funnel({kind:'unknown'}),funnel({name:''}),funnel({name:'x'.repeat(201)}),
    funnel({description:'x'.repeat(501)}),funnel({windowMinutes:0}),funnel({windowMinutes:1441}),funnel({windowMinutes:1.5}),
    funnel({windowMinutes:'5'}),funnel({steps:[path()]}),funnel({steps:Array.from({length:9},()=>path())}),
    funnel({steps:[path('relative'),path()]}),funnel({steps:[path('relative','prefix'),path()]}),
    funnel({steps:[path('/?private=yes'),path()]}),funnel({steps:[path('/#fragment'),path()]}),
    funnel({steps:[path('/'+ 'x'.repeat(2048)),path()]}),funnel({steps:[path(''),path()]}),
    funnel({steps:[{...path(),match:'regex'},path()]}),funnel({steps:[{...event(),value:'x'.repeat(65)},path()]}),
    funnel({steps:[{...event(),pageViewsOnly:true},path()]}),funnel({steps:[{...path(),properties:[{key:'x',operator:'missing'}]},path()]}),
    {kind:'goal',name:'Goal',condition:path(),windowMinutes:5},goal(),
    {kind:'goal',name:'Goal',condition:{...path(),pageViewsOnly:true}},
    funnel({name:'bad\0name'}),funnel({description:'bad\ud800'}),funnel({steps:[path('/bad\0value'),path()]}),
  ]) rejected(input);
});

test('typed predicates retain present versus missing, literal negatives, dates and array element types',()=>{
  const predicates=[
    {key:'a\\.b',operator:'missing'},
    {key:'value',operator:'eq',type:'number',value:42},
    {key:'value',operator:'neq',type:'string',value:'42'},
    {key:'value',operator:'eq',type:'boolean',value:false},
    {key:'value',operator:'eq',type:'null',value:null},
    {key:'value',operator:'contains',type:'string',value:'%_\\'},
    {key:'value',operator:'not_contains',type:'string',value:''},
    {key:'value',operator:'eq',type:'date',value:'2024-02-29T12:00:00+04:00'},
    {key:'value',operator:'eq',type:'array',value:['42',42,null,false]},
    {key:'value',operator:'eq',type:'string',value:'2024-02-29T12:00:00+04:00'},
  ];
  const parsed=parseAnalysisDefinition(funnel({steps:[event(predicates),path()]}));
  assert.equal(parsed.kind,'funnel');if(parsed.kind!=='funnel')throw new Error('Wrong definition kind.');
  assert.deepEqual(parsed.steps[0].properties,predicates.map((p,index)=>index===7?{...p,value:'2024-02-29T08:00:00.000Z'}:p));
  for(const predicate of [
    {key:'value',operator:'missing',value:null}, {key:'value',operator:'eq',type:'number',value:'42'},
    {key:'value',operator:'neq',type:'boolean',value:0}, {key:'value',operator:'eq',type:'null',value:'null'},
    {key:'value',operator:'eq',type:'number',value:Infinity}, {key:'value',operator:'eq',type:'array',value:{}},
    {key:'value',operator:'eq',type:'array',value:[{}]}, {key:'value',operator:'eq',type:'date',value:'2024-02-30T00:00:00Z'},
    {key:'value',operator:'eq',type:'date',value:'2024-01-01T00:00:00Z\n'},
    {key:'value',operator:'contains',type:'number',value:42}, {key:'value',operator:'unknown'},
    {key:'',operator:'missing'}, {key:'x'.repeat(321),operator:'missing'}, {key:'bad\ud800',operator:'missing'},
  ]) rejected(funnel({steps:[event([predicate]),path()]}));
  rejected(funnel({steps:[event(Array.from({length:11},()=>({key:'value',operator:'missing'}))),path()]}));
});

test('definition trust boundary rejects disguised sparse arrays and undefined optional fields without invoking hooks',()=>{
  const sparse:unknown[]=[path(),path()];delete sparse[0];Object.assign(sparse,{extra:path()});
  assert.equal(Object.keys(sparse).length,sparse.length,'The fixture disguises its hole with an enumerable extra key.');
  rejected(funnel({steps:sparse}));
  const sparseProperties:unknown[]=[{key:'value',operator:'missing'}];delete sparseProperties[0];Object.assign(sparseProperties,{extra:{key:'value',operator:'missing'}});
  rejected(funnel({steps:[event(sparseProperties),path()]}));
  for(const input of [funnel({description:undefined}),funnel({steps:[{...path(),pageViewsOnly:undefined},path()]}),
    funnel({steps:[{...event(),properties:undefined},path()]}),{kind:'goal',name:'Goal',description:undefined,condition:path()}])rejected(input);
  let invoked=0;const accessor=funnel();Object.defineProperty(accessor,'name',{enumerable:true,get(){invoked++;return 'Getter';}});rejected(accessor);
  const array=[path(),path()];Object.defineProperty(array,'0',{enumerable:true,get(){invoked++;return path();}});rejected(funnel({steps:array}));
  rejected(new Proxy(funnel(),{getPrototypeOf(){invoked++;return Object.prototype;}}));
  assert.equal(invoked,0,'Validation must not execute object or array hooks.');
});
