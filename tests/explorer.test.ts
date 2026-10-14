import assert from 'node:assert/strict';
import test from 'node:test';
import {csvCell,explorerQuery} from '../src/server/explorer-input.ts';

test('explorer defaults follow the named calendar; properties retain exact type and escaped key',()=>{
  const q = explorerQuery(new URLSearchParams('timeZone=America/New_York'),new Date('2026-03-09T01:00:00Z'));
  assert.equal(q.from,'2026-03-02');assert.equal(q.to,'2026-03-08');assert.equal(q.timeZone,'America/New_York');
  const property = (type:string,value?:unknown) => explorerQuery(new URLSearchParams({propertyKey:'a\\.b',propertyType:type,...(value===undefined?{}:{propertyValue:JSON.stringify(value)})})).property;
  assert.deepEqual(property('string','42'),{key:'a\\.b',type:'string',value:'42'});
  assert.deepEqual(property('number',42),{key:'a\\.b',type:'number',value:42});
  assert.deepEqual(property('missing'),{key:'a\\.b',type:'missing',value:null});
  assert.deepEqual(property('date','2024-02-29T12:00:00+04:00'),{key:'a\\.b',type:'date',value:'2024-02-29T08:00:00.000Z'});
  assert.deepEqual(property('array',['42',42,null]),{key:'a\\.b',type:'array',value:['42',42,null]});
  assert.equal(explorerQuery(new URLSearchParams('campaignSource=')).filters.campaignSource,'');
});

test('explorer rejects ambiguous, oversized, invalid and unbounded queries',()=>{
  for(const params of ['kind=unknown','groupBy=country','groupProperty=key','groupBy=property','kind=all&kind=custom','timezone=UTC',
    'timeZone=GMT+4','timeZone=No/Such_Zone','from=2024-02-30&to=2024-03-01','from=2024-01-01&to=2025-01-01',
    'propertyType=string','propertyKey=a&propertyType=missing&propertyValue=null','propertyKey=a&propertyType=number&propertyValue=%2242%22',
    'propertyKey=a&propertyType=date&propertyValue=%222024-02-30T00%3A00%3A00Z%22',
    'propertyKey=a&propertyType=array&propertyValue=%7B%7D','propertyKey=a&propertyType=boolean&propertyValue=1','path=%00','path='+ 'x'.repeat(2049)]) {
    assert.throws(()=>explorerQuery(new URLSearchParams(params)),{status:400},params.slice(0,60));
  }
});

test('CSV quotes text and neutralizes formulas including whitespace, while preserving typed null and decimal text',()=>{
  assert.equal(csvCell('a,"b"\nline'),'"a,""b""\nline"');
  for(const cell of ['=1+1',' +cmd','\t@calc','\rtext','\ntext','\uFEFF-1']) assert.ok(csvCell(cell).startsWith('"\''));
  assert.equal(csvCell(null),'"Unavailable"');
  assert.equal(csvCell('1000000000000000.123456'),'"1000000000000000.123456"');
  assert.equal(csvCell(['1',1]),'"[""1"",1]"');
});

test('Explorer cohort selection requires one valid paired ID and current bounded revision',()=>{
  const id='4455af22-3e1b-4aa8-a837-20189d42a615';
  assert.equal(Object.hasOwn(explorerQuery(new URLSearchParams()),'cohort'),false);
  assert.deepEqual(explorerQuery(new URLSearchParams({cohortId:id,cohortRevision:'2147483647'})).cohort,{id,revision:2147483647});
  for(const query of [`cohortId=${id}`,'cohortRevision=1','cohortId=no&cohortRevision=1',...['0','-1','01','1.0','1e1','2147483648','1\n',''].map(revision=>new URLSearchParams({cohortId:id,cohortRevision:revision}).toString()),
    `cohortId=${id}&cohortId=${id}&cohortRevision=1`,`cohortId=${id}&cohortRevision=1&cohortRevision=1`])assert.throws(()=>explorerQuery(new URLSearchParams(query)),{status:400});
});
