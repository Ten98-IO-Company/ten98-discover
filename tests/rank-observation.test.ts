import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRankObservation} from '../src/server/rank-observation.ts';
import type {RankSerpRequest} from '../src/server/rank-serp-input.ts';

const request:RankSerpRequest={keyword:'C++ %20',domain:'example.com',locationCode:2840,languageCode:'en',device:'desktop',depth:100,maxCrawlPages:3};
const now=new Date('2026-10-13T09:00:00Z');
const item=(group:number,url:string,absolute=group+2)=>({type:'organic',rank_group:group,rank_absolute:absolute,page:1,url,domain:new URL(url).hostname});
function result(items:unknown[]=[item(1,'https://unrelated.com/a'),item(2,'https://www.example.com/a')]){
  return {keyword:request.keyword,type:'organic',location_code:2840,language_code:'en',datetime:'2026-10-13 08:59:00 +00:00',pages_count:1,items_count:items.length,item_types:['organic','paid','people_also_ask'],items};
}

test('organic target matching uses URL hostname boundaries and smallest organic position, with SERP-wide features',()=>{
  const items=[item(7,'https://sub.example.com/second'),item(3,'https://notexample.com/'),item(5,'https://example.com.evil.org/'),item(1,'https://example.com/first',4),{type:'paid',url:'https://example.com/ad',rank_group:1}, {type:'people_also_ask',items:[{url:'https://example.com/answer'}]}];
  const parsed=parseRankObservation(result(items),request,now);
  assert.equal(parsed.position,1);assert.equal(parsed.absolutePosition,4);assert.equal(parsed.rankBasis,'organic');assert.equal(parsed.rankingUrl,'https://example.com/first');
  assert.equal(parsed.checkedDepth,1);assert.deepEqual(parsed.serpFeatures,['paid','people_also_ask']);assert.equal(parsed.returnedItemCount,6);
});
test('unmatched, empty and shortened results never invent requested-depth coverage or rank zero',()=>{
  const absent=parseRankObservation(result([item(3,'https://notexample.com/')]),request,now);
  assert.equal(absent.status,'not_found');assert.equal(absent.position,null);assert.equal(absent.checkedDepth,0);
  const empty=parseRankObservation({...result([]),pages_count:0,item_types:[]},request,now);
  assert.equal(empty.status,'not_found');assert.equal(empty.checkedDepth,0);assert.equal(empty.position,null);
});
test('absolute fallback is explicit and may not be mixed with organic measurements',()=>{
  const fallback={...item(1,'https://example.com/',6),rank_group:null};
  const parsed=parseRankObservation(result([fallback]),request,now);assert.equal(parsed.rankBasis,'absolute');assert.equal(parsed.position,6);assert.equal(parsed.checkedDepth,0);
  assert.throws(()=>parseRankObservation(result([fallback,item(2,'https://other.org/',8)]),request,now));
});
test('organic and absolute order cannot contradict; gaps do not hide a real match or claim coverage',()=>{
  assert.throws(()=>parseRankObservation(result([item(8,'https://example.com/',1)]),request,now));
  assert.throws(()=>parseRankObservation(result([item(1,'https://other.org/',9),item(2,'https://example.com/',4)]),request,now));
  const gap=parseRankObservation(result([item(4,'https://example.com/',7),item(2,'https://other.org/',4),item(1,'https://other.org/',3)]),request,now);
  assert.equal(gap.position,4);assert.equal(gap.checkedDepth,2);assert.equal(gap.status,'ranked');
  const rows=Array.from({length:12},(_,i)=>item(i+1,'https://other.org/',i+2)).reverse();
  assert.equal(parseRankObservation(result(rows),{...request,depth:10},now).checkedDepth,10);
});
test('literal query, location and language must agree; malformed dimensions do not produce observations',()=>{
  for(const patch of [{keyword:'C  %20'},{keyword:'C%2B%2B %2520'},{location_code:2826},{language_code:'fr'},{type:'paid'},{items_count:10},{pages_count:4},{items:null},{item_types:['organic','organic']},{item_types:['organic','<script>']},{item_types:[]}]){
    assert.throws(()=>parseRankObservation({...result(),...patch},request,now));
  }
});
test('duplicate or invalid organic positions and unsafe/mismatched URLs cannot become ranked results',()=>{
  const base=item(1,'https://example.com/');
  for(const patch of [{rank_group:0},{rank_absolute:0},{rank_group:1.5},{page:0},{page:2},{url:'javascript:alert(1)'},{url:'https://name:secret@example.com/'},{url:'https://127.0.0.1/'},{domain:'evil.org'},{url:'not a URL'}]){
    assert.throws(()=>parseRankObservation(result([{...base,...patch}]),request,now));
  }
  assert.throws(()=>parseRankObservation(result([base,{...base,url:'https://example.com/other',rank_absolute:9}]),request,now));
  assert.throws(()=>parseRankObservation(result([base,{...base,rank_group:2}]),request,now));
});
test('timestamps are valid UTC calendar values with bounded future skew, never inferred retrieval dates',()=>{
  const parsed=parseRankObservation(result(),request,now);assert.equal(parsed.observedAt,'2026-10-13T08:59:00.000Z');assert.equal(parsed.retrievedAt,now.toISOString());
  for(const datetime of ['2026-02-30 08:59:00 +00:00','2026-10-13 09:06:00 +00:00','2026-10-13T08:59:00+04:00','not a date'])assert.throws(()=>parseRankObservation({...result(),datetime},request,now));
});
