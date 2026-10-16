import assert from 'node:assert/strict';
import test from 'node:test';
import {csvCell,explorerQuery,explorerGroupingQuery} from '../src/server/explorer-input.ts';
import {parseSegmentDefinition} from '../src/server/segment-input.ts';
import {parseCohortDefinition} from '../src/server/cohort-input.ts';
import {propertyDecimalScale,comparePropertyDecimals,propertyCalendarDay,propertyDateUnit,propertyDateBucket,validPropertyDateSummary,validPropertyNumberStats} from '../src/lib/property-visuals.ts';

test('property chart coordinates preserve sign, zeros and unknowns without converting decimal amounts to floats',()=>{
  assert.deepEqual(propertyDecimalScale(['-10','2.5','0',null]),[-1,0.25,0,null]);
  const huge='9'.repeat(400);assert.deepEqual(propertyDecimalScale([huge,'-'+huge,null]),[1,-1,null]);
  assert.deepEqual(propertyDecimalScale(['0','-0.000',null]),[0,0,null]);
  assert.equal(comparePropertyDecimals('123.123456789012345675','123.12345678901234567'),1);
  assert.equal(comparePropertyDecimals('-0.00001','-0.0000100'),0);
  for(const bad of ['1e999','NaN','Infinity','1\n',' 1','+'+'1','1'.repeat(1025)])assert.throws(()=>propertyDecimalScale([bad]));
  assert.throws(()=>propertyDecimalScale(Array(733).fill('1')));
});

test('property date units use calendar spans and Monday weeks including year zero and timezone edge years',()=>{
  const after=(days:number)=>new Date(Date.parse('2024-01-01T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  for(const [days,unit]of [[45,'day'],[46,'week'],[180,'week'],[181,'month'],[730,'month'],[731,'year']]as const)assert.equal(propertyDateUnit('2024-01-01',after(days)),unit);
  assert.equal(propertyDateBucket('2026-03-08','week'),'2026-03-02');assert.equal(propertyDateBucket('2026-03-02','week',true),'2026-03-09');
  assert.equal(propertyDateBucket('0000-02-29','day',true),'0000-03-01');assert.equal(propertyDateBucket('-000001-12-31','day',true),'0000-01-01');assert.equal(propertyDateBucket('9999-12-31','day',true),'+010000-01-01');
  for(const valid of ['0000-02-29','-000001-12-31','+010000-01-01'])assert.equal(propertyCalendarDay(valid),true);
  for(const bad of ['2026-02-30','0001-02-29','2026-01-01\n','-000002-01-01'])assert.equal(propertyCalendarDay(bad),false);
});

test('property histogram reader refuses missing zero buckets, contradictory full counts and invented unavailable values',()=>{
  const summary={samples:103,unit:'day',earliest:'2026-03-07',latest:'2026-03-09',topDate:{date:'2026-03-09',count:102},weekdays:[102,0,0,0,0,1,0],histogram:[{date:'2026-03-07',count:1},{date:'2026-03-08',count:0},{date:'2026-03-09',count:102}]};
  assert.equal(validPropertyDateSummary(summary,105),true,'Summary counts are independent of a truncated exact-value table.');
  assert.equal(validPropertyDateSummary({...summary,histogram:summary.histogram.filter(b=>b.count!==0)},105),false);
  assert.equal(validPropertyDateSummary({...summary,samples:102},105),false);assert.equal(validPropertyDateSummary({...summary,unit:'week'},105),false);
  assert.equal(validPropertyDateSummary({...summary,weekdays:[0,0,0,0,0,103,0]},105),false);
  const empty={samples:0,unit:null,earliest:null,latest:null,topDate:null,weekdays:Array(7).fill(0),histogram:[]};assert.equal(validPropertyDateSummary(empty,0),true);assert.equal(validPropertyDateSummary(empty,null),false);
  assert.equal(validPropertyDateSummary({...empty,samples:null,weekdays:null},null),true);
});

test('property numeric summary reader keeps no samples and unavailable distinct and rejects invalid median bounds',()=>{
  const stats={samples:2,sum:'246.24691357802469135',average:'123.12345678901234568',median:'123.123456789012345675',min:'123.12345678901234567',max:'123.12345678901234568'};
  assert.equal(validPropertyNumberStats(stats,2),true);assert.equal(validPropertyNumberStats({...stats,median:'123.12345678901234569'},2),false);
  assert.equal(validPropertyNumberStats({...stats,sum:'1e1000'},2),false);assert.equal(validPropertyNumberStats({...stats,sum:'1'.repeat(1025)},2),false);
  const empty={samples:0,sum:null,average:null,median:null,min:null,max:null};assert.equal(validPropertyNumberStats(empty,0),true);assert.equal(validPropertyNumberStats(empty,null),false);assert.equal(validPropertyNumberStats({...empty,samples:null},null),true);
});

test('property details are report-only, bounded and keep exact typed cursor clocks',()=>{
  const params=new URLSearchParams({from:'2026-03-08',to:'2026-03-09',groupBy:'property',groupProperty:' spaced ',propertyView:'details'}),result=explorerGroupingQuery(params,new Date('2026-03-10'));
  assert.equal(result.scope.groupProperty,' spaced ');assert.ok('propertyReport'in result&&result.propertyReport);assert.equal(result.propertyReport.cursor,null);
  const value={version:1,scope:'a'.repeat(64),policy:'b'.repeat(64),before:'2026-03-10T00:00:00.000001Z',last:{at:'2026-03-08T00:00:00.999999Z',id:'11111111-1111-4111-8111-111111111111'}};
  params.set('propertyCursor',Buffer.from(JSON.stringify(value)).toString('base64url'));const paged=explorerGroupingQuery(params,new Date('2026-03-10'));assert.ok('propertyReport'in paged&&paged.propertyReport);assert.deepEqual(paged.propertyReport.cursor,value);
  for(const extra of [{propertyView:'future'},{groupBy:'event'},{fields:'["path","origin"]'},{propertyCursor:'='},{propertyCursor:Buffer.from(JSON.stringify({...value,last:{...value.last,at:'2026-02-30T00:00:00.000000Z'}})).toString('base64url')}])assert.throws(()=>explorerGroupingQuery(new URLSearchParams(Object.fromEntries([...params,...Object.entries(extra)])),new Date('2026-03-10')),{status:400});
  assert.throws(()=>explorerQuery(params),{status:400});for(const parse of [parseSegmentDefinition,parseCohortDefinition])assert.throws(()=>parse({schemaVersion:1,name:'No report mode in predicates',query:params.toString()}),{status:400});
});

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
  for(const params of ['kind=unknown','groupBy=continent','groupProperty=key','groupBy=property','kind=all&kind=custom','timezone=UTC',
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

test('Explorer keeps legacy predicates required and exposes an optional canonical flat group',()=>{
  assert.equal(Object.hasOwn(explorerQuery(new URLSearchParams()),'predicates'),false);
  const predicates={properties:[{value:'2024-02-29T12:00:00.1234567+04:00',type:'date',operator:'eq',key:'when'}],fields:[{value:'/other',operator:'eq',field:'path'}],match:'any',version:1};
  const params=new URLSearchParams({path:'/required',propertyKey:'required',propertyType:'null',propertyValue:'null',predicates:JSON.stringify(predicates)});
  const parsed=explorerQuery(params);
  assert.deepEqual(parsed.filters,{path:'/required'});assert.deepEqual(parsed.property,{key:'required',type:'null',value:null});
  assert.deepEqual(parsed.predicates,{version:1,match:'any',fields:[{field:'path',operator:'eq',value:'/other'}],properties:[{key:'when',operator:'eq',type:'date',value:'2024-02-29T08:00:00.1234567Z'}]});
  assert.equal(params.get('predicates'),JSON.stringify(predicates));
  for(const value of ['', '{', 'null',JSON.stringify({...predicates,sessionProperty:[]})])assert.throws(()=>explorerQuery(new URLSearchParams({predicates:value})),{status:400});
  params.append('predicates',JSON.stringify(predicates));assert.throws(()=>explorerQuery(params),{status:400});
});

test('Explorer checks the full encoded query again after advanced date normalization grows it',()=>{
  const predicates={version:1,match:'all',fields:[],properties:[{key:'when',operator:'eq',type:'date',value:'2024-01-01T00:00:00Z'}]};
  const params=new URLSearchParams({path:'中'.repeat(2048),eventName:'中'.repeat(120),predicates:JSON.stringify(predicates),language:''});
  const padding=19998-params.toString().length;assert.ok(padding>=0&&padding<=320);
  params.set('language','a'.repeat(padding));assert.equal(params.toString().length,19998);
  assert.throws(()=>explorerQuery(params),{status:400});
});

test('advanced Explorer size includes resolved report defaults without mutating the caller',()=>{
  const predicates={version:1,match:'all',fields:[{field:'path',operator:'eq',value:'/x'}],properties:[]};
  const now=new Date('2026-10-14T12:00:00Z'),params=new URLSearchParams({path:'中'.repeat(2048),eventName:'中'.repeat(120),predicates:JSON.stringify(predicates),language:''});
  const canonical=new URLSearchParams(params);
  for(const [key,value]of Object.entries({from:'2026-10-08',to:'2026-10-14',timeZone:'UTC',kind:'all',groupBy:'event'}))canonical.set(key,value);
  const padding=20000-canonical.toString().length;assert.ok(padding>=0&&padding<320);
  params.set('language','a'.repeat(padding));canonical.set('language','a'.repeat(padding));assert.equal(canonical.toString().length,20000);
  const original=params.toString();assert.doesNotThrow(()=>explorerQuery(params,now));assert.equal(params.toString(),original);assert.equal(params.has('kind'),false);
  params.set('language','a'.repeat(padding+1));assert.ok(params.toString().length<20000);assert.throws(()=>explorerQuery(params,now),{status:400});
});

test('exact referrer filters preserve the accepted2048-character normalizer bound',()=>{assert.equal(explorerQuery(new URLSearchParams({referrer:'a'.repeat(2048)})).filters.referrer.length,2048);assert.throws(()=>explorerQuery(new URLSearchParams({referrer:'a'.repeat(2049)})),{status:400});});

test('compound grouping keeps scalar input and exact scope unchanged without mutating callers',()=>{
  const now=new Date('2026-10-14T12:00:00Z'),scalar=new URLSearchParams({groupBy:'property',groupProperty:' spaced ',campaignName:'',timeZone:'UTC'});
  assert.deepEqual(explorerGroupingQuery(scalar,now),{scope:explorerQuery(scalar,now),fields:null});
  const params=new URLSearchParams({fields:'[ "campaignSource", "campaignMedium", "campaignName" ]',campaignName:'',from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York'}),before=params.toString();
  const result=explorerGroupingQuery(params,now);assert.deepEqual(result.fields,['campaignSource','campaignMedium','campaignName']);assert.equal(result.scope.filters.campaignName,'');assert.equal(result.scope.groupBy,'event');assert.equal(params.toString(),before);
  assert.deepEqual(explorerGroupingQuery(new URLSearchParams({fields:'["screenWidth","city"]'}),now).fields,['screenWidth','city']);
});

test('compound grouping refuses ambiguous, repeated, unsupported and oversized inputs',()=>{
  for(const fields of ['{','null','{}','[]','["path"]','["path","path"]','["path","property"]','["path",1]','["path","future"]','["path","origin","language","device"]'])assert.throws(()=>explorerGroupingQuery(new URLSearchParams({fields})),{status:400},fields);
  for(const extra of Array.of<Record<string,string>>({groupBy:'path'},{groupProperty:'x'},{future:'x'}))assert.throws(()=>explorerGroupingQuery(new URLSearchParams({fields:'["path","origin"]',...extra})),{status:400});
  assert.throws(()=>explorerGroupingQuery(new URLSearchParams('fields=%5B%22path%22%2C%22origin%22%5D&fields=%5B%22path%22%2C%22origin%22%5D')),{status:400});
  const now=new Date('2026-10-14T12:00:00Z'),params=new URLSearchParams({fields:'["path","origin"]',path:'中'.repeat(2048),eventName:'中'.repeat(140),language:''}),normalized=new URLSearchParams(params);
  for(const [key,value]of Object.entries({from:'2026-10-08',to:'2026-10-14',timeZone:'UTC',kind:'all'}))normalized.set(key,value);
  const padding=20000-normalized.toString().length;
  assert.ok(padding>=0&&padding<320);params.set('language','a'.repeat(padding));assert.doesNotThrow(()=>explorerGroupingQuery(params,now));params.set('language','a'.repeat(padding+1));assert.throws(()=>explorerGroupingQuery(params,now),{status:400});
  assert.throws(()=>explorerGroupingQuery(new URLSearchParams({fields:' '.repeat(20001)})),{status:400});
});

test('compound grouping cannot leak into saved predicate or qualification definitions',()=>{
  const query=new URLSearchParams({from:'2026-03-08',to:'2026-03-08',timeZone:'UTC',path:'/entry',fields:'["campaignSource","campaignMedium"]'}).toString();
  for(const parse of [parseSegmentDefinition,parseCohortDefinition])assert.throws(()=>parse({schemaVersion:1,name:'Saved filters',query}),{status:400});
  assert.throws(()=>explorerQuery(new URLSearchParams({fields:'["path","origin"]'})),{status:400},'Other report callers retain the closed scalar parser.');
});
