import assert from 'node:assert/strict';
import test from 'node:test';
import {InputError} from '../src/server/validation.ts';
import {normalizeSavedKeyword,savedKeywordRefreshable,normalizeSavedTags,tagColors,
  parseSavedKeywordSave,parseSavedKeywordTagChange,parseSavedKeywordRemove,parseSavedTagUpdate,parseSavedTagDelete,
  parseSavedKeywordFilters,parseSavedKeywordList,parseSavedKeywordSelection,parseSavedKeywordExport,
  parseSavedKeywordRefreshQuote,parseSavedKeywordRefreshStart} from '../src/server/saved-keyword-input.ts';

const a='badea601-d8f1-4ced-a178-b7523e4e3b80',b='d19cbf8c-d330-49de-a1ee-a7dd8080a86e';
const base={requestId:a,revision:1};
const manual={...base,source:{type:'manual',keywords:[' Blue  Shoes ','blue shoes','C++','%20'],locationCode:2840,languageCode:'en'}};
const message='Check the saved keyword fields and try again.';
const rejected=(fn:()=>unknown)=>assert.throws(fn,(error:unknown)=>error instanceof InputError&&error.status===400&&error.message===message);

test('saved keyword identities preserve literal text and distinguish authored capacity from paid eligibility',()=>{
  assert.equal(normalizeSavedKeyword('  Blue\u00a0 \u2003Shoes '),'blue shoes');
  for(const [raw,expected]of [['C++','c++'],['%20','%20'],['Ａ','ａ'],['İ','i\u0307']]as const)assert.equal(normalizeSavedKeyword(raw),expected);
  assert.notEqual(normalizeSavedKeyword('é'),normalizeSavedKeyword('e\u0301'));
  assert.equal(normalizeSavedKeyword('x'.repeat(500)),'x'.repeat(500));assert.equal(normalizeSavedKeyword('😀'.repeat(250)),'😀'.repeat(250));
  assert.equal(savedKeywordRefreshable(normalizeSavedKeyword('x'.repeat(81))),false);
  assert.equal(savedKeywordRefreshable('word '.repeat(10)+'word'),false);assert.equal(savedKeywordRefreshable('blue shoes'),true);assert.equal(savedKeywordRefreshable(' Blue Shoes '),false);
  for(const raw of ['', ' ', 'x'.repeat(501),' '.repeat(500)+'x','İ'.repeat(500),'\0','a\tb','a\nb','a\rb','a\x7fb','\ud800','\udc00',0,null,undefined,new String('text')])rejected(()=>normalizeSavedKeyword(raw));
});

test('tag normalization preserves first display spelling and punctuation with bounded raw input',()=>{
  assert.deepEqual(normalizeSavedTags(['  Intent   High ','intent high','x,y','=SUM(A1)','+risk','@risk']),[
    {name:'Intent High',normalizedName:'intent high'},{name:'x,y',normalizedName:'x,y'},{name:'=SUM(A1)',normalizedName:'=sum(a1)'},{name:'+risk',normalizedName:'+risk'},{name:'@risk',normalizedName:'@risk'},
  ]);
  assert.deepEqual(normalizeSavedTags([]),[]);assert.equal(normalizeSavedTags(['x'.repeat(64)]).length,1);
  assert.deepEqual(tagColors,['slate','rose','amber','lime','emerald','sky','violet','fuchsia']);
  for(const raw of [Array(21).fill('same'),[' '],['x'.repeat(65)],['İ'.repeat(33)],['x\ny'],['bad\ud800'],[null],['okay',undefined],'tags'])rejected(()=>normalizeSavedTags(raw));
});

test('manual and observed save shapes are strict, immutable and apply bounds before deduplication',()=>{
  const snapshot=structuredClone(manual);Object.freeze(manual.source.keywords);Object.freeze(manual.source);Object.freeze(manual);
  assert.deepEqual(parseSavedKeywordSave(manual),{...base,source:{type:'manual',keywords:['blue shoes','c++','%20'],locationCode:2840,languageCode:'en'},tags:[],tagMode:'append'});assert.deepEqual(manual,snapshot);
  assert.deepEqual(parseSavedKeywordSave({...base,source:{type:'run',runId:b.toUpperCase(),rowIndexes:[99,0,99]}}).source,{type:'run',runId:b,rowIndexes:[99,0]});
  assert.equal(parseSavedKeywordSave({...manual,source:{...manual.source,keywords:Array(500).fill('same')}}).source.type,'manual');
  for(const raw of [
    {...manual,tags:undefined},{...manual,tagMode:undefined},{...manual,tagMode:'replace',tags:[]},{...manual,metrics:{searchVolume:1}},
    {...manual,source:{...manual.source,keywords:Array(501).fill('same')}},{...manual,source:{...manual.source,keywords:[]}},
    {...base,source:{type:'run',runId:b,rowIndexes:[100]}},{...base,source:{type:'run',runId:b,rowIndexes:[-1]}},
    {...base,source:{type:'run',runId:b,rowIndexes:[0.5]}},{...base,source:{type:'run',runId:b,rowIndexes:Array(101).fill(0)}},
    {...base,source:{type:'run',runId:b,rowIndexes:[0],locationCode:2840}},{...base,source:{type:'run',runId:b,rowIndexes:[0],metrics:{cpcUsd:'1'}}},
    {...base,source:{type:'run',runId:b,rowIndexes:[0],keyword:'forged'}},{...manual,requestId:'not-a-uuid'},
  ])rejected(()=>parseSavedKeywordSave(raw));
});

test('market, revision and UUID primitives reject coercion, newline and overflow',()=>{
  assert.equal(parseSavedKeywordSave({...manual,requestId:a.toUpperCase(),revision:2147483646}).requestId,a);
  assert.equal(parseSavedKeywordSave({...manual,source:{...manual.source,locationCode:2147483647,languageCode:'fil-PH'}}).source.type,'manual');
  for(const revision of [0,-1,1.5,2147483647,'1',null,undefined,NaN,Infinity])rejected(()=>parseSavedKeywordSave({...manual,revision}));
  for(const locationCode of [0,-1,1.2,2147483648,'2840',null,undefined])rejected(()=>parseSavedKeywordSave({...manual,source:{...manual.source,locationCode}}));
  for(const languageCode of ['EN','en-us','e','english','en-US\n','en\n','en_US',' en',null])rejected(()=>parseSavedKeywordSave({...manual,source:{...manual.source,languageCode}}));
});

test('tag operations require explicit intent; clear cannot be confused with an empty replacement',()=>{
  const ids=[a.toUpperCase(),a,b];assert.deepEqual(parseSavedKeywordRemove({...base,keywordIds:ids}),{...base,keywordIds:[a,b]});
  assert.deepEqual(parseSavedKeywordTagChange({...base,keywordIds:ids,operation:'clear'}),{...base,keywordIds:[a,b],operation:'clear'});
  assert.deepEqual(parseSavedKeywordTagChange({...base,keywordIds:[a],operation:'remove',tagIds:[b,b.toUpperCase()]}),{...base,keywordIds:[a],operation:'remove',tagIds:[b]});
  assert.deepEqual(parseSavedKeywordTagChange({...base,keywordIds:[a],operation:'replace',tags:['Intent']}),{...base,keywordIds:[a],operation:'replace',tags:[{name:'Intent',normalizedName:'intent'}]});
  for(const raw of [
    {...base,keywordIds:[a],operation:'clear',tags:[]},{...base,keywordIds:[a],operation:'clear',tagIds:undefined},
    {...base,keywordIds:[a],operation:'add',tags:[]},{...base,keywordIds:[a],operation:'replace',tags:[]},
    {...base,keywordIds:[a],operation:'remove',tagIds:[]},{...base,keywordIds:[a],operation:'remove',tagIds:[b],tags:[]},
    {...base,keywordIds:[a],operation:'add',tags:['x'],tagIds:[b]},{...base,keywordIds:[],operation:'clear'},
    {...base,keywordIds:Array(2001).fill(a),operation:'clear'},{...base,keywordIds:[a],operation:'remove',tagIds:Array(51).fill(b)},
  ])rejected(()=>parseSavedKeywordTagChange(raw));
  rejected(()=>parseSavedKeywordRemove({...base,keywordIds:[a],all:true}));
});

test('tag edit separates explicit nullable color reset from missing input',()=>{
  assert.deepEqual(parseSavedTagUpdate({...base,name:' High Intent ',color:'violet'}),{...base,name:{name:'High Intent',normalizedName:'high intent'},color:'violet'});
  assert.deepEqual(parseSavedTagUpdate({...base,color:null}),{...base,color:null});assert.deepEqual(parseSavedTagDelete(base),base);
  for(const extra of [{},{name:null},{name:undefined},{color:undefined},{color:'blue'},{color:'#fff'},{name:'x',normalizedName:'forged'}])rejected(()=>parseSavedTagUpdate({...base,...extra}));
  rejected(()=>parseSavedTagDelete({...base,force:true}));
});

test('shared filter defaults and literal terms never decode or broaden the selected scope',()=>{
  assert.deepEqual(parseSavedKeywordFilters({}),{search:'',includeTerms:[],excludeTerms:[],locationCode:null,languageCode:null,tagIds:[],minVolume:null,maxVolume:null,minDifficulty:null,maxDifficulty:null,minCpcUsd:null,maxCpcUsd:null,metrics:'all',sort:'createdAt',order:'desc'});
  const parsed=parseSavedKeywordFilters({search:'  A  %_\\+  ',includeTerms:[' C++ ','c++','%20'],excludeTerms:['A  B'],tagIds:[a.toUpperCase(),a]});
  assert.equal(parsed.search,'a  %_\\+');assert.deepEqual(parsed.includeTerms,['c++','%20']);assert.deepEqual(parsed.excludeTerms,['a  b']);assert.deepEqual(parsed.tagIds,[a]);
  for(const raw of [{search:undefined},{search:null},{tagIds:null},{languageCode:'en\n'},{minVolume:null},{minVolume:1,maxVolume:0},{minDifficulty:101},{minDifficulty:1,maxDifficulty:0},{minVolume:1.1},{minVolume:Number.MAX_SAFE_INTEGER+1},{includeTerms:['']},{includeTerms:Array(21).fill('same')},{tagNames:['x']},{metrics:'empty'},{sort:'rank'},{order:'ASC'}])rejected(()=>parseSavedKeywordFilters(raw));
});

test('CPC filter parsing compares canonical exact micro-units including zero and decimal boundaries',()=>{
  for(const [raw,canonical]of [['0','0.000000'],['0.000000','0.000000'],['0.1','0.100000'],['0.000001','0.000001'],['999999.999999','999999.999999'],['1000000','1000000.000000']]as const){const value=parseSavedKeywordFilters({minCpcUsd:raw,maxCpcUsd:canonical});assert.equal(value.minCpcUsd,canonical);assert.equal(value.maxCpcUsd,canonical);}
  for(const raw of [0.1,'1e-6','+1','-0','01','00.1','.1','1.','1.0000000','1\n',' 1','1 ','NaN','Infinity','1000000.000001','1000001',null,undefined])rejected(()=>parseSavedKeywordFilters({minCpcUsd:raw}));
  rejected(()=>parseSavedKeywordFilters({minCpcUsd:'0.300000',maxCpcUsd:'0.299999'}));
  rejected(()=>parseSavedKeywordFilters({minCpcUsd:'0.000001',maxCpcUsd:'0'}));
});

test('list, export and refresh wrappers reject ambiguous selection or authority fields',()=>{
  const filters=parseSavedKeywordFilters({});assert.deepEqual(parseSavedKeywordList({}),{filters,pageSize:50,cursor:null});
  assert.equal(parseSavedKeywordList({pageSize:250,cursor:'A_-012'}).cursor,'A_-012');
  assert.deepEqual(parseSavedKeywordSelection({type:'filtered',filters:{}}),{type:'filtered',filters});
  assert.deepEqual(parseSavedKeywordExport({selection:{type:'ids',keywordIds:[a,a]},format:'tsv'}),{selection:{type:'ids',keywordIds:[a]},format:'tsv'});
  assert.deepEqual(parseSavedKeywordRefreshQuote({connectionId:b,selection:{type:'ids',keywordIds:[a]}}),{connectionId:b,selection:{type:'ids',keywordIds:[a]}});
  assert.deepEqual(parseSavedKeywordRefreshStart({quoteId:a.toUpperCase(),requestKey:b}),{quoteId:a,requestKey:b});
  for(const raw of [{pageSize:25},{pageSize:'50'},{filters:undefined},{cursor:null},{cursor:''},{cursor:'ok\n'},{cursor:'a'.repeat(513)},{cursor:'a='},{query:{}}])rejected(()=>parseSavedKeywordList(raw));
  for(const raw of [{type:'all'},{type:'filtered'},{type:'filtered',filters:{},keywordIds:[a]},{type:'ids',keywordIds:[a],filters:{}},{type:'ids',keywordIds:[]}])rejected(()=>parseSavedKeywordSelection(raw));
  rejected(()=>parseSavedKeywordExport({selection:{type:'ids',keywordIds:[a]},format:'sheets'}));
  rejected(()=>parseSavedKeywordRefreshQuote({connectionId:b,selection:{type:'ids',keywordIds:[a]},estimateUsd:'0'}));
  rejected(()=>parseSavedKeywordRefreshStart({quoteId:a,requestKey:b,userId:a}));
});

test('strict parser boundaries reject active, hidden and irregular objects without executing hooks',()=>{
  let touched=0;const getter=Object.defineProperty({...manual},'source',{enumerable:true,get(){touched++;return manual.source;}});
  const proxy=new Proxy({...manual},{get(){touched++;throw new Error('Proxy get executed.');},ownKeys(){touched++;throw new Error('Proxy enumeration executed.');},getPrototypeOf(){touched++;throw new Error('Proxy prototype executed.');}});
  const sourceGetter={...manual,source:Object.defineProperty({...manual.source},'keywords',{enumerable:true,get(){touched++;return ['x'];}})};
  const hidden=Object.defineProperty({...manual},'hidden',{value:'payload',enumerable:false});
  const symbol={...manual,[Symbol('hidden')]:'payload'},prototype=Object.assign(Object.create({extra:true}),manual),nullPrototype=Object.assign(Object.create(null),manual);
  const hook={...manual,toJSON(){touched++;return manual;},valueOf(){touched++;return 1;}};
  for(const raw of [getter,proxy,sourceGetter,hidden,symbol,prototype,nullPrototype,hook])rejected(()=>parseSavedKeywordSave(raw));
  const revokedObject=Proxy.revocable({...manual},{});revokedObject.revoke();rejected(()=>parseSavedKeywordSave(revokedObject.proxy));
  const sparse=Array(2);sparse[0]='x';(sparse as any).extra='y';
  const accessor=['x'];Object.defineProperty(accessor,'0',{enumerable:true,get(){touched++;return 'x';}});
  const extra=Object.assign(['x'],{extra:'y'}),nonenumerable=Object.defineProperty(['x'],'hidden',{value:'y'}),arraySymbol=Object.assign(['x'],{[Symbol('x')]:'y'});
  const arrayProxy=new Proxy(['x'],{get(){touched++;throw new Error('Array proxy get executed.');}});
  for(const raw of [sparse,accessor,extra,nonenumerable,arraySymbol,arrayProxy]){rejected(()=>normalizeSavedTags(raw));rejected(()=>parseSavedKeywordSave({...manual,source:{...manual.source,keywords:raw}}));}
  const revokedArray=Proxy.revocable(['x'],{});revokedArray.revoke();rejected(()=>normalizeSavedTags(revokedArray.proxy));
  assert.equal(touched,0,'No user-controlled accessor, proxy, coercion or serialization hook may execute.');
});
