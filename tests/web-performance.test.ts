import assert from 'node:assert/strict';
import test from 'node:test';
import {performanceMetrics,performanceObservation,performanceQuery,performanceRating,performanceStats,performanceValue,readPerformanceQuery} from '../src/lib/web-performance.ts';

test('performance query round trips applied dates and literal filters without accepting duplicates or unsupported populations',()=>{
  const initial=readPerformanceQuery(new URLSearchParams(),new Date('2026-10-16T23:59:59Z'));
  assert.equal(initial.from,'2026-10-10');assert.equal(initial.to,'2026-10-16');
  const intent=readPerformanceQuery(new URLSearchParams({from:'2024-02-29',to:'2024-03-01',metric:'cls',percentile:'95',breakdown:'browser',browser:'not-recorded',path:'/a%20b'}));
  assert.deepEqual(readPerformanceQuery(new URLSearchParams(performanceQuery(intent))),intent);
  for(const raw of ['path=%2F%ED%A0%80','path=%2F%GG','path=%2F%FF','path=%2F%'])assert.throws(()=>readPerformanceQuery(raw),raw);
  for(const path of ['/100% done','/\uFFFD'])assert.equal(readPerformanceQuery(new URLSearchParams({path}).toString()).path,path);
  for(const query of ['from=2026-02-30&to=2026-03-01','from=2026-10-17&to=2026-10-16','from=2024-01-01&to=2025-01-01','from=2026-01-01','metric=lcp&metric=inp','percentile=99','breakdown=person','kind=custom','path=%2Fprivate%3Ftoken%3Dsecret','path=%2F%00','browser=unrecognized'])assert.throws(()=>readPerformanceQuery(new URLSearchParams(query)),query);
});

test('missing metrics stay unavailable independently and an observed zero keeps its correct rating',()=>{
  const empty={count:0,p50:null,p75:null,p95:null},zero={count:1,p50:0,p75:0,p95:0};
  assert.deepEqual(performanceStats.parse(empty),empty);assert.deepEqual(performanceStats.parse(zero),zero);
  assert.equal(performanceStats.safeParse({...empty,p75:0}).success,false);assert.equal(performanceStats.safeParse({...zero,p95:null}).success,false);assert.equal(performanceStats.safeParse({count:2,p50:20,p75:10,p95:30}).success,false);
  for(const metric of performanceMetrics){assert.equal(performanceRating(metric,null),'unavailable');assert.equal(performanceValue(metric,null),'Unavailable');assert.equal(performanceRating(metric,0),'good');}
  assert.equal(performanceRating('cls',0.1),'good');assert.equal(performanceRating('cls',0.25),'needs-improvement');assert.equal(performanceRating('cls',0.251),'poor');assert.equal(performanceRating('inp',501),'poor');
});

test('public performance observations accept only finite bounded metrics, anonymous dimensions and one collection proof',()=>{
  const input={type:'performance',siteKey:'10000000-0000-4000-8000-000000000001',navigationId:'20000000-0000-4000-8000-000000000001',metric:'lcp',value:123.5,revision:1,url:'https://example.com/page',collection:{mode:'cookieless',epoch:'30000000-0000-4000-8000-000000000001'}};
  assert.equal(performanceObservation.parse(input).value,123.5);
  for(const value of [NaN,Infinity,-1,3600001,'123'])assert.equal(performanceObservation.safeParse({...input,value}).success,false);
  for(const patch of [{metric:'cls',value:1001},{revision:0},{revision:1.5},{revision:1000001},{url:'file:///page'},{url:'https://example.com/?token=private'},{url:'https://example.com/?'},{url:'https://example.com/#'},{url:'https://user:password@example.com/'},{dimensions:{distinctId:'customer'}},{properties:{email:'private'}},{consent:{analytics:true,epoch:input.collection.epoch}}])assert.equal(performanceObservation.safeParse({...input,...patch}).success,false);
  assert.equal(performanceObservation.safeParse({...input,collection:undefined}).success,false);
});
