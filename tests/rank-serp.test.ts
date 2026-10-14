import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRankSerpRequest,rankSerpPayload,rankEstimateMicros,parseRankBasePrices,type RankSerpRequest} from '../src/server/rank-serp-input.ts';
import {compileRankPlan,readRankPlan,rankGroupPayload} from '../src/server/rank-execution-plan.ts';
import {rankApprovalRequestHash} from '../src/server/rank-scheduling.ts';
import {parseRankObservation} from '../src/server/rank-observation.ts';
import {canonicalHash} from '../src/server/context-input.ts';
const request:RankSerpRequest={keyword:'C++ %20',domain:'EXAMPLE.COM',locationCode:2840,languageCode:'en',device:'desktop',depth:100,maxCrawlPages:3};
test('provider numeric regions and scripts survive catalogue-selected paid scope and observation reconstruction',()=>{
  for(const languageCode of ['en','zh-TW','es-419','sr-Latn'])for(const method of ['live','queued'] as const){
    const value={...request,languageCode,domain:'example.com'}, {keyword,device,...target}=value;
    assert.equal(parseRankSerpRequest(value).languageCode,languageCode);assert.equal(rankEstimateMicros(2000n,value).maximumMicros,6000n);
    const plan=compileRankPlan({method,target,devices:device,keywords:[{id:'09e9a1d9-c77e-4e33-a610-5927b2c3f24a',keyword,matchCase:true}],baseMicros:2000n});
    assert.equal(readRankPlan(plan,canonicalHash(plan)).target.languageCode,languageCode);assert.equal(rankGroupPayload(plan,plan.groups[0])[0].language_code,languageCode);assert.match(rankApprovalRequestHash(plan),/^[a-f0-9]{64}$/);
    assert.equal(parseRankObservation({type:'organic',keyword,location_code:2840,language_code:languageCode,items:[],items_count:0,pages_count:0,item_types:[],datetime:'2026-01-01 00:00:00 +00:00'},value,new Date('2026-01-02T00:00:00Z')).status,'not_found');
  }
  for(const languageCode of ['es-419\n','sr-latn','sr-LATN','en-US-x','en-12','en-1234','EN','en\0'])assert.throws(()=>parseRankSerpRequest({...request,languageCode}));
});
test('rank request captures independent result depth/page ceiling and literal query semantics',()=>{
  const parsed=parseRankSerpRequest(request);assert.equal(parsed.domain,'example.com');assert.equal(parsed.maxCrawlPages,3);assert.equal(parsed.depth,100);assert.equal(request.domain,'EXAMPLE.COM');
  const payload=rankSerpPayload(request,'09e9a1d9-c77e-4e33-a610-5927b2c3f24a','queued');assert.equal(payload.keyword,'C%2B%2B %2520');assert.equal(decodeURIComponent(payload.keyword.replace(/\+/g,' ')),request.keyword);assert.deepEqual(payload.find_targets_in,['organic']);assert.deepEqual(payload.stop_crawl_on_match,[{match_value:'example.com',match_type:'with_subdomains'}]);assert.equal(payload.priority,1);assert.equal(payload.os,'windows');
  const mobile=rankSerpPayload({...request,device:'mobile'},'09e9a1d9-c77e-4e33-a610-5927b2c3f24a','live');assert.equal(mobile.os,'android');assert.ok(!('priority'in mobile));assert.equal(mobile.calculate_rectangles,false);assert.equal(mobile.load_async_ai_overview,false);
  for(const raw of [{...request,keyword:' '},{...request,keyword:'x\n'},{...request,keyword:'\ud800'},{...request,domain:'https://example.com/path'},{...request,languageCode:'en\n'},{...request,depth:11},{...request,maxCrawlPages:0},{...request,search_param:'extra'}])assert.throws(()=>parseRankSerpRequest(raw));
});
test('rank ceilings use full page price and explicit conservative operator multiplicity',()=>{
  assert.deepEqual(rankEstimateMicros(2000n,request),{maximumMicros:6000n,maximumUsd:'0.006000',operatorCount:0,multiplier:'1'});
  assert.equal(rankEstimateMicros(600n,{...request,keyword:'site:example.com'}).maximumMicros,9000n);
  const multiple=rankEstimateMicros(2000n,{...request,keyword:'SITE:example.com filetype:pdf'});assert.equal(multiple.operatorCount,2);assert.equal(multiple.maximumMicros,150000n);
  assert.throws(()=>rankEstimateMicros(0n,request));assert.throws(()=>rankEstimateMicros(2000n,{...request,keyword:'site:'.repeat(35)}));
});
test('account prices require unambiguous supported units and free queued retrieval',()=>{
  const cost=(n:number)=>[{cost_type:'per_request',cost:n}],account={price:{serp:{live:{advanced:{priority_normal:cost(.002)}},task_post:{priority_normal:cost(.0006)},task_get:{advanced:{priority_normal:cost(0)}}}}};
  assert.deepEqual(parseRankBasePrices(account),{liveMicros:2000n,queuedMicros:600n});
  const bad=structuredClone(account);bad.price.serp.task_get.advanced.priority_normal[0].cost=.001;assert.throws(()=>parseRankBasePrices(bad));
  const duplicate=structuredClone(account);duplicate.price.serp.task_post.priority_normal.push({cost_type:'per_request',cost:.0006});assert.throws(()=>parseRankBasePrices(duplicate));
  assert.throws(()=>parseRankBasePrices({price:{serp:{}}}));
});

test('rank target hosts use DNS hostname limits without inheriting proof-record capacity',()=>{
  // Rank targets do not create _ten98-challenge records or grant collector access.
  const domain=['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(57),'com'].join('.');
  assert.equal(domain.length,253);
  assert.equal(parseRankSerpRequest({...request,domain}).domain,domain);
  assert.equal(parseRankSerpRequest({...request,domain:'BÜCHER.de.'}).domain,'xn--bcher-kva.de');
  for(const invalid of ['x'+domain,'a'.repeat(64)+'.com','*.example.com','example.com:443','user@example.com','example.com/path','example.com?x','example.com\\path','127.0.0.1','0x7f000001','example.localhost','example.com\n']){
    assert.throws(()=>parseRankSerpRequest({...request,domain:invalid}));
  }
});
