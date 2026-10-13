import assert from 'node:assert/strict';
import test from 'node:test';
import {InputError} from '../src/server/validation.ts';
import {normalizeRankKeyword,parseRankKeywordAdd,parseRankKeywordRemove,parseRankKeywordPin} from '../src/server/rank-keyword-input.ts';

const a='badea601-d8f1-4ced-a178-b7523e4e3b80',b='d19cbf8c-d330-49de-a1ee-a7dd8080a86e';
const base={requestId:a,revision:1};
const message='Check the rank keyword fields and try again.';
const rejected=(action:()=>unknown)=>assert.throws(action,(error:unknown)=>error instanceof InputError&&error.status===400&&error.message===message);
const operations=[
  {parse:parseRankKeywordAdd,valid:{...base,keywords:['Blue']},field:'keywords',entry:'Blue'},
  {parse:parseRankKeywordRemove,valid:{...base,keywordIds:[a]},field:'keywordIds',entry:a},
  {parse:parseRankKeywordPin,valid:{...base,keywordIds:[a],pinned:true},field:'keywordIds',entry:a},
] as const;

test('rank queries preserve literal spelling and internal whitespace, with explicit case semantics',()=>{
  assert.equal(normalizeRankKeyword('  Blue  Shoes  '),'blue  shoes');
  assert.equal(normalizeRankKeyword('\u00a0Blue\u00a0\u2003Shoes\u2003'),'blue\u00a0\u2003shoes');
  assert.equal(normalizeRankKeyword('  Blue  Shoes  ',true),'Blue  Shoes');
  for(const [raw,expected]of [['C++','c++'],['%20','%20'],['%2B','%2b'],['Ａ','ａ'],['İ','i\u0307'],['a\u0085b','a\u0085b']]as const)assert.equal(normalizeRankKeyword(raw),expected);
  assert.notEqual(normalizeRankKeyword('é'),normalizeRankKeyword('e\u0301'),'Canonical Unicode spellings remain distinct.');
  assert.deepEqual(parseRankKeywordAdd({...base,keywords:[' Blue  Shoes ','blue  shoes','blue shoes','C++','%20']}),{...base,keywords:['blue  shoes','blue shoes','c++','%20'],matchCase:false});
  assert.deepEqual(parseRankKeywordAdd({...base,keywords:['Blue','blue',' Blue ','BLUE'],matchCase:true}).keywords,['Blue','blue','BLUE']);
});

test('rank normalization checks raw and normalized UTF-16 limits and rejects every prohibited control',()=>{
  assert.equal(normalizeRankKeyword('a'.repeat(200)),'a'.repeat(200));
  assert.equal(normalizeRankKeyword('😀'.repeat(100)),'😀'.repeat(100));
  assert.equal(normalizeRankKeyword('a'.repeat(198)+'İ'),'a'.repeat(198)+'i\u0307');
  assert.equal(normalizeRankKeyword('İ'.repeat(100)),'i\u0307'.repeat(100));
  assert.equal(normalizeRankKeyword('İ'.repeat(200),true),'İ'.repeat(200));
  for(const raw of ['', ' ', '\u00a0\u2003', 'a'.repeat(201), ' '+ 'a'.repeat(200), '😀'.repeat(101), 'a'.repeat(199)+'İ', 'İ'.repeat(101), '\ud800', '\udc00', 'ok\ud800x', 0, false, null, undefined, new String('text')])rejected(()=>normalizeRankKeyword(raw));
  for(const code of [...Array.from({length:32},(_,i)=>i),127]){
    rejected(()=>normalizeRankKeyword('a'+String.fromCharCode(code)+'b'));
    rejected(()=>normalizeRankKeyword(String.fromCharCode(code)+'okay'));
  }
  for(const mode of [null,0,1,'false',new Boolean(false)])rejected(()=>normalizeRankKeyword('text',mode as boolean));
  rejected(()=>parseRankKeywordAdd({...base,keywords:['valid','a'.repeat(199)+'İ']}));
});

test('raw batch limits apply before stable deduplication and no invalid entry is discarded',()=>{
  assert.deepEqual(parseRankKeywordAdd({...base,keywords:Array(2000).fill(' Same ')}).keywords,['same']);
  assert.deepEqual(parseRankKeywordRemove({...base,keywordIds:Array(2000).fill(a.toUpperCase())}).keywordIds,[a]);
  assert.deepEqual(parseRankKeywordPin({...base,keywordIds:[b.toUpperCase(),a,b],pinned:false}),{...base,keywordIds:[b,a],pinned:false});
  for(const operation of operations){
    for(const entries of [[],Array(2001).fill(operation.entry),[operation.entry,undefined],[operation.entry,null],[operation.entry,1]])rejected(()=>operation.parse({...operation.valid,[operation.field]:entries}));
  }
  rejected(()=>parseRankKeywordAdd({...base,keywords:['same',' same ','']}));
  rejected(()=>parseRankKeywordRemove({...base,keywordIds:[a,a,'not-a-uuid']}));
});

test('UUIDs, revisions and flags accept only exact primitives with no trailing-character coercion',()=>{
  for(const operation of operations){
    assert.equal(operation.parse({...operation.valid,requestId:a.toUpperCase(),revision:2147483646}).requestId,a);
    for(const revision of [0,-0,-1,1.5,2147483647,Number.MAX_SAFE_INTEGER+1,'1',1n,null,undefined,NaN,Infinity,new Number(1)])rejected(()=>operation.parse({...operation.valid,revision}));
    for(const requestId of [a+'\n',a+'\r',a+' ', ' '+a,a.slice(1),'{'+a+'}',a.replaceAll('-',''),'badea601-d8f1-4ced-7178-b7523e4e3b80',null,undefined,new String(a)])rejected(()=>operation.parse({...operation.valid,requestId}));
  }
  for(const keywordId of [a+'\n',a+' ',a.slice(1),null,undefined,new String(a)]){
    rejected(()=>parseRankKeywordRemove({...base,keywordIds:[keywordId]}));
    rejected(()=>parseRankKeywordPin({...base,keywordIds:[keywordId],pinned:true}));
  }
  for(const flag of [null,undefined,'true','false',0,1,new Boolean(true)]){
    rejected(()=>parseRankKeywordAdd({...base,keywords:['x'],matchCase:flag}));
    rejected(()=>parseRankKeywordPin({...base,keywordIds:[a],pinned:flag}));
  }
  assert.equal(parseRankKeywordAdd({...base,keywords:['X'],matchCase:false}).matchCase,false);
  rejected(()=>parseRankKeywordPin({...base,keywordIds:[a]}));
});

test('mutation objects reject missing, unknown, hidden, symbolic and nonordinary fields',()=>{
  for(const operation of operations){
    for(const key of Object.keys(operation.valid)){
      const missing={...operation.valid} as Record<string,unknown>;delete missing[key];
      rejected(()=>operation.parse(missing));
      rejected(()=>operation.parse({...operation.valid,[key]:undefined}));
      const hidden={...operation.valid};Object.defineProperty(hidden,key,{enumerable:false});
      rejected(()=>operation.parse(hidden));
    }
    for(const raw of [null,undefined,[],1,'text',Object.assign(Object.create(null),operation.valid),Object.assign(Object.create({}),operation.valid),Object.assign(new Date(),operation.valid),{...operation.valid,userId:a},{...operation.valid,[Symbol('scope')]:true},Object.defineProperty({...operation.valid},'hidden',{value:true})])rejected(()=>operation.parse(raw));
  }
  rejected(()=>parseRankKeywordAdd({...base,keywords:['x'],keywordIds:[a]}));
  rejected(()=>parseRankKeywordRemove({...base,keywordIds:[a],pinned:true}));
  rejected(()=>parseRankKeywordPin({...base,keywordIds:[a],pinned:true,matchCase:false}));
});

test('no getters, proxy traps, coercion hooks or serialization hooks run at any input boundary',()=>{
  let touched=0;const hook=()=>{touched++;throw new Error('Untrusted hook must not execute.');};
  const traps={get:hook,getPrototypeOf:hook,ownKeys:hook,getOwnPropertyDescriptor:hook,has:hook};
  const coercion={toJSON:hook,valueOf:hook,toString:hook,[Symbol.toPrimitive]:hook};
  for(const operation of operations){
    for(const key of Object.keys(operation.valid)){
      rejected(()=>operation.parse(Object.defineProperty({...operation.valid},key,{enumerable:true,get:hook})));
    }
    rejected(()=>operation.parse(new Proxy({...operation.valid},traps)));
    const revoked=Proxy.revocable({...operation.valid},{});revoked.revoke();rejected(()=>operation.parse(revoked.proxy));
    for(const raw of [{...operation.valid,toJSON:hook},{...operation.valid,valueOf:hook},{...operation.valid,[Symbol.toPrimitive]:hook},{...operation.valid,revision:coercion},{...operation.valid,requestId:coercion}])rejected(()=>operation.parse(raw));
    const array=[operation.entry];Object.defineProperty(array,'0',{enumerable:true,get:hook});
    rejected(()=>operation.parse({...operation.valid,[operation.field]:array}));
    rejected(()=>operation.parse({...operation.valid,[operation.field]:new Proxy([operation.entry],traps)}));
    const revokedArray=Proxy.revocable([operation.entry],{});revokedArray.revoke();rejected(()=>operation.parse({...operation.valid,[operation.field]:revokedArray.proxy}));
    rejected(()=>operation.parse({...operation.valid,[operation.field]:[coercion]}));
  }
  rejected(()=>normalizeRankKeyword(coercion));
  const revoked=Proxy.revocable({},{});revoked.revoke();rejected(()=>normalizeRankKeyword(revoked.proxy));
  rejected(()=>normalizeRankKeyword('okay',new Proxy({},traps) as unknown as boolean));
  assert.equal(touched,0,'Validation must not invoke user-controlled code, even while rejecting input.');
});

test('arrays require dense enumerable indices and their exact ordinary prototype',()=>{
  for(const operation of operations){
    const hole=Array(2);hole[0]=operation.entry;
    const disguised=Array(2);disguised[0]=operation.entry;Object.assign(disguised,{extra:operation.entry});
    const hiddenIndex=[operation.entry];Object.defineProperty(hiddenIndex,'0',{enumerable:false});
    const nullPrototype=Object.setPrototypeOf([operation.entry],null);
    const customPrototype=Object.setPrototypeOf([operation.entry],Object.create(Array.prototype));
    const inheritedIndex=Object.create(Array.prototype);inheritedIndex[0]=operation.entry;
    const inheritedHole=Object.setPrototypeOf(Array(1),inheritedIndex);
    const extras=[Object.assign([operation.entry],{'01':operation.entry}),Object.assign([operation.entry],{'-1':operation.entry}),Object.assign([operation.entry],{extra:operation.entry}),Object.assign([operation.entry],{[Symbol('extra')]:operation.entry}),Object.defineProperty([operation.entry],'hidden',{value:operation.entry})];
    for(const entries of [hole,disguised,hiddenIndex,nullPrototype,customPrototype,inheritedHole,...extras,operation.entry,{0:operation.entry,length:1},new Set([operation.entry])])rejected(()=>operation.parse({...operation.valid,[operation.field]:entries}));
  }
});

test('success and failure leave input untouched and return fresh ordinary mutable containers',()=>{
  const inputs=[
    {...base,keywords:[' Blue ','blue','C++'],matchCase:false},
    {...base,keywordIds:[a.toUpperCase(),b,a]},
    {...base,keywordIds:[b,a,b],pinned:false},
  ];
  for(const [i,operation]of operations.entries()){
    const raw=inputs[i] as Record<string,unknown>,before=structuredClone(raw),entries=raw[operation.field] as string[];
    Object.freeze(entries);Object.freeze(raw);
    const output=operation.parse(raw),returned=Reflect.get(output,operation.field) as string[];
    assert.deepEqual(raw,before);assert.notEqual(output,raw);assert.notEqual(returned,entries);
    assert.equal(Object.getPrototypeOf(output),Object.prototype);assert.equal(Object.getPrototypeOf(returned),Array.prototype);
    returned.push('output-only');output.revision=2;
    assert.deepEqual(raw,before);assert.notDeepEqual(operation.parse(raw),output,'Repeated parses do not share output containers.');
    const invalid={...before,[operation.field]:[...entries,undefined]},snapshot=structuredClone(invalid);
    rejected(()=>operation.parse(invalid));assert.deepEqual(invalid,snapshot);
  }
});
