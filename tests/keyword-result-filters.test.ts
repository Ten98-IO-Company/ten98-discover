import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyKeywordResultFilters,filterKeywordResults,type KeywordResultFilters} from '../src/lib/keyword-result-filters.ts';

const rows=[
  {sourceIndex:0,keyword:'Blue Shoes',intent:'commercial',searchVolume:0,cpcUsd:'0.000000',keywordDifficulty:0},
  {sourceIndex:1,keyword:'BLUE running Shoes',intent:'informational',searchVolume:900,cpcUsd:'1.250001',keywordDifficulty:75.5},
  {sourceIndex:2,keyword:'Unknown shoes',intent:null,searchVolume:null,cpcUsd:null,keywordDifficulty:null},
  {sourceIndex:3,keyword:'Red boots',intent:'commercial',searchVolume:100,cpcUsd:'1.250000',keywordDifficulty:100},
];
const filter=(draft:Partial<KeywordResultFilters>={})=>filterKeywordResults(rows,{...emptyKeywordResultFilters(),...draft});
const indexes=(draft:Partial<KeywordResultFilters>)=>filter(draft).rows.map(row=>row.sourceIndex);

test('retained keyword text filters are trimmed case-insensitive substrings and retain source identity',()=>{
  assert.deepEqual(indexes({include:' BLUE ',exclude:'RUNNING'}),[0]);
  assert.deepEqual(indexes({include:'shoes',intent:'informational'}),[1]);
  assert.deepEqual(indexes({exclude:'sHoEs'}),[3]);
  assert.equal(filter({include:'running'}).rows[0],rows[1]);
  assert.deepEqual(filter().rows,rows);
});
test('active volume ranges include zero and exclude unavailable values',()=>{
  assert.deepEqual(indexes({minVolume:'0'}),[0,1,3]);
  assert.deepEqual(indexes({minVolume:'0',maxVolume:'0'}),[0]);
  assert.deepEqual(indexes({minVolume:'100',maxVolume:'900'}),[1,3]);
});
test('CPC bounds use exact micro-units without converting unavailable data to zero',()=>{
  assert.deepEqual(indexes({maxCpc:'0'}),[0]);
  assert.deepEqual(indexes({minCpc:'1.250001',maxCpc:'1.250001'}),[1]);
  assert.deepEqual(indexes({minCpc:'1.25',maxCpc:'1.25'}),[3]);
  const large=[{...rows[0],cpcUsd:'9007199254740992.000001'},{...rows[1],cpcUsd:'9007199254740992.000002'}];
  assert.deepEqual(filterKeywordResults(large,{...emptyKeywordResultFilters(),maxCpc:'9007199254740992.000001'}).rows,[large[0]]);
});
test('organic difficulty accepts retained fractional values and inclusive zero/100 bounds',()=>{
  assert.deepEqual(indexes({minDifficulty:'0',maxDifficulty:'0'}),[0]);
  assert.deepEqual(indexes({minDifficulty:'75.5',maxDifficulty:'100'}),[1,3]);
});
test('invalid bounds and reversed ranges are errors with no silently unfiltered result',()=>{
  for(const [key,value]of [['minVolume','no'],['maxVolume','1.5'],['minVolume','-1'],['maxVolume','9007199254740992'],['minCpc','1e2'],['maxCpc','0.0000001'],['minDifficulty','-1'],['maxDifficulty','100.1']] as const){
    const draft={...emptyKeywordResultFilters(),[key]:value},before={...draft},result=filterKeywordResults(rows,draft);
    assert.ok(result.errors[key],key);assert.deepEqual(result.rows,[]);assert.deepEqual(draft,before);
  }
  for(const [minimum,maximum]of [['minVolume','maxVolume'],['minCpc','maxCpc'],['minDifficulty','maxDifficulty']] as const){
    const result=filter({[minimum]:'2',[maximum]:'1'});assert.equal(result.errors[maximum],'Maximum must be at least the minimum.');assert.deepEqual(result.rows,[]);
  }
});
test('zero matches and reset keep original rows and indexes without mutating retained data',()=>{
  const before=structuredClone(rows);assert.deepEqual(indexes({include:'no match'}),[]);assert.deepEqual(indexes({}),[0,1,2,3]);assert.deepEqual(rows,before);
});
