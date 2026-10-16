import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {domainPayload,domainTarget,domainUrlMatches,parseDomainRequest,matchesDomainPayload,type DomainRequest} from '../src/server/domain-research-input.ts';
import {parseDomainOutcome,parseDomainReconciliation} from '../src/server/dataforseo-domains.ts';
import {parseKeywordAccount} from '../src/server/dataforseo-keywords.ts';

const id='00000000-0000-4000-8000-000000000001';
const request:DomainRequest={connectionId:id,target:'example.com',scope:'subdomains',locationCode:2840,languageCode:'en',limit:25};
const item=(url='https://example.com/guide')=>({keyword_data:{keyword:'example',keyword_info:{search_volume:0,cpc:0,last_updated_time:'2026-10-16 00:00:00 +00:00'},keyword_properties:{keyword_difficulty:null}},ranked_serp_element:{serp_item:{type:'organic',domain:new URL(url).hostname,relative_url:new URL(url).pathname+new URL(url).search,url,rank_absolute:1,etv:0}}});
function response(r=request,items:unknown[]|null=[item()],total=items?.length??0){return {httpStatus:200,body:{status_code:20000,cost:0.01212,tasks_count:1,tasks:[{id:'synthetic-task',path:['v3','dataforseo_labs','google','ranked_keywords','live'],data:domainPayload(r,id),status_code:20000,cost:0.01212,result_count:1,result:[{se_type:'google',target:domainTarget(r.target,r.scope).hostname,location_code:r.locationCode,language_code:r.languageCode,total_count:total,items_count:items?.length??0,items}]}]}};}

test('four scopes keep host/path boundaries, IDN and explicit query-insensitive identity',()=>{
 assert.deepEqual(domainTarget('https://WWW.Example.com/Guide/?x=y#h','subfolder'),{target:'https://example.com/Guide',hostname:'example.com',path:'/Guide',scope:'subfolder'});
 assert.equal(domainTarget('münich.de','domain').hostname,'xn--mnich-kva.de');
 for(const scope of ['domain','subdomains','exact_url','subfolder'] as const){const t=domainTarget('https://example.com/a',scope);assert.equal(domainUrlMatches('https://www.example.com/a/?x=1',t),true);assert.equal(domainUrlMatches('https://evil-example.com/a',t),false);assert.equal(domainUrlMatches('https://example.com/ab',t),scope==='domain'||scope==='subdomains');assert.equal(domainUrlMatches('https://sub.example.com/a',t),scope==='subdomains');}
 for(const value of ['http://127.0.0.1/a','0x7f000001','https://user:pass@example.com','ftp://example.com','https://example.com:444/a','localhost','https://example.com\\evil','https://example.com/ a','\ud800.com'])assert.throws(()=>domainTarget(value,'domain'));
 assert.throws(()=>domainTarget('example.com','subfolder'));
});
test('strict requests and fixed organic scope filters cannot become a custom provider request',()=>{
 for(const limit of [25,50,100])assert.equal(parseDomainRequest({...request,limit}).limit,limit);
 for(const patch of [{limit:1000},{scope:'all'},{offset:25},{endpoint:'https://evil.example'},{estimateUsd:'0'},{target:'example.com\u0000'}])assert.throws(()=>parseDomainRequest({...request,...patch}));
 const exact={...request,target:'https://example.com/a%25_b',scope:'exact_url' as const},payload=domainPayload(exact,id);
 assert.deepEqual(payload.item_types,['organic']);assert.equal(payload.include_clickstream_data,false);assert.equal(payload.offset,0);assert.equal(payload.load_rank_absolute,true);
 assert.equal(JSON.stringify(payload.filters).includes('\\\\%25\\\\_b'),true);
 assert.equal(matchesDomainPayload(payload,exact,id),true);assert.equal(matchesDomainPayload({...payload,tag:'foreign'},exact,id),false);assert.equal(matchesDomainPayload({...payload,limit:100},exact,id),false);
});
test('ranked-keyword pricing reuses exact account units without changing old modes',()=>{
 const prices=[{cost_type:'per_request',cost:0.012},{cost_type:'per_result',cost:0.00012}],account={login:'synthetic@example.com',price:{dataforseo_labs:{ranked_keywords:{live:{priority_normal:prices}},keyword_overview:{live:{priority_normal:prices}},keyword_ideas:{live:{priority_normal:prices}}}}};
 const free={httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:[account]}]}};
 for(const mode of ['overview','ideas','ranked_keywords'] as const){const p=parseKeywordAccount(free,mode,{key:'synthetic-only',version:2});assert.equal(p.perTask,12000n);assert.equal(p.perItem,120n);assert.equal(p.perTask+100n*p.perItem,24000n);assert.equal(p.fingerprint.length,64);}
 const bad=structuredClone(free);bad.body.tasks[0].result[0].price.dataforseo_labs.ranked_keywords.live.priority_normal.push(prices[0]);assert.throws(()=>parseKeywordAccount(bad,'ranked_keywords',{key:'synthetic-only',version:2}));
});
test('valid rows keep zero, unavailable metrics, scope and explicit partial counts',()=>{
 const r=parseDomainOutcome(response(request,[item()],101),request,id).result!;assert.equal(r.returnedCount,1);assert.equal(r.totalCount,101);assert.equal(r.limited,true);assert.equal(r.rows[0].searchVolume,0);assert.equal(r.rows[0].cpcUsd,'0.000000');assert.equal(r.rows[0].keywordDifficulty,null);assert.equal(r.rows[0].estimatedTraffic,0);
 const empty=parseDomainOutcome(response(request,null,0),request,id);assert.equal(empty.cost,'0.012120');assert.deepEqual(empty.result?.rows,[]);assert.equal(empty.result?.limited,false);
});
test('known charge survives malformed count, out-of-scope URLs, duplicate and invalid row content',()=>{
 const cases=[response(request,[item(),item()]),response({...request,scope:'domain'},[item('https://sub.example.com/a')]),response(request,[item()],0)];
 const count=structuredClone(response());count.body.tasks[0].result[0].items_count=2;cases.push(count);
 const numeric=structuredClone(response());numeric.body.tasks[0].result[0].items![0]=item();(numeric.body.tasks[0].result[0].items![0] as ReturnType<typeof item>).ranked_serp_element.serp_item.etv=-1;cases.push(numeric);
 for(const value of cases){const q=value===cases[1]?{...request,scope:'domain' as const}:request,out=parseDomainOutcome(value,q,id);assert.equal(out.result,null);assert.equal(out.cost,'0.012120');assert.equal(out.reference,'synthetic-task');}
});
test('foreign task identity and inconsistent billing stay unknown rather than free',()=>{
 for(const kind of ['tag','path','cost'] as const){const value=response();if(kind==='tag')value.body.tasks[0].data.tag='foreign';if(kind==='path')value.body.tasks[0].path[3]='keyword_ideas';if(kind==='cost')value.body.tasks[0].cost=0;const out=parseDomainOutcome(value,request,id);assert.equal(out.cost,null);assert.equal(out.result,null);}
});
test('reconciliation requires one complete exact tagged final receipt, including charge zero',()=>{
 const receipt={id:'synthetic-task',url:'v3/dataforseo_labs/google/ranked_keywords/live',metadata:domainPayload(request,id),status:'20000',cost:0};
 const free=(items:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:items}]}});
 assert.equal(parseDomainReconciliation(free([receipt]),request,id).cost,'0.000000');
 for(const rows of [[],[receipt,receipt],Array.from({length:1000},()=>receipt),[{...receipt,status:'20100'}],[{...receipt,metadata:domainPayload(request,randomUUID())}]])assert.throws(()=>parseDomainReconciliation(free(rows),request,id));
});
