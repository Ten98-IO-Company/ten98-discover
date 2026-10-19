import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {domainPayload,domainTarget,domainUrlMatches,parseDomainRequest,matchesDomainPayload,domainEndpointName,type DomainRequest,type DomainReport} from '../src/server/domain-research-input.ts';
import {parseDomainOutcome,parseDomainReconciliation,requestDomainResearch} from '../src/server/dataforseo-domains.ts';
import {dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';
import {parseKeywordAccount} from '../src/server/dataforseo-keywords.ts';
import {domainReportCsv} from '../src/server/domain-research.ts';

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
 const r=parseDomainOutcome(response(request,[item()],101),request,id).result!;assert.equal(r.report,undefined);if(r.report)assert.fail('Legacy report changed');assert.equal(r.returnedCount,1);assert.equal(r.totalCount,101);assert.equal(r.limited,true);assert.equal(r.rows[0].searchVolume,0);assert.equal(r.rows[0].cpcUsd,'0.000000');assert.equal(r.rows[0].keywordDifficulty,null);assert.equal(r.rows[0].estimatedTraffic,0);
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
test('wallet refusals with an explicit zero cost settle $0 with the fixed text; charged or other refusals stay unknown (D3)',async()=>{
 const top=parseDomainOutcome({httpStatus:200,body:{status_code:40210,cost:0,tasks_count:0,tasks:null}},request,id);
 assert.deepEqual(top,{cost:'0.000000',reference:null,result:null,diagnostic:dataforseoRefusalMessage.payment,evidence:{httpStatus:200,statusCode:40210,taskStatus:null,reportedCost:0,taskCost:null}});
 const task=parseDomainOutcome({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{id:'synthetic-task',status_code:40203,cost:0}]}},request,id);
 assert.equal(task.cost,'0.000000');assert.equal(task.reference,null);assert.equal(task.diagnostic,dataforseoRefusalMessage.cost_limit);assert.deepEqual(task.evidence,{httpStatus:200,statusCode:20000,taskStatus:40203,reportedCost:0,taskCost:0});
 for(const body of [{status_code:40210,cost:0.01,tasks:null},{status_code:40210,tasks:null},{status_code:40204,cost:0,tasks:null},{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0},{status_code:20000,cost:0}]}]){const out=parseDomainOutcome({httpStatus:200,body},request,id);assert.equal(out.cost,null,JSON.stringify(body));assert.equal(out.result,null);}
 let calls=0;const reply=(value:unknown,status:number):typeof fetch=>async()=>{calls++;return Response.json(value,{status});};
 const http=await requestDomainResearch({login:'synthetic',password:'synthetic'},request,id,reply({status_code:40200,cost:0,tasks:null},402));assert.equal(http.cost,'0.000000');assert.equal(http.evidence.httpStatus,402);assert.equal(http.diagnostic,dataforseoRefusalMessage.payment);
 assert.equal((await requestDomainResearch({login:'synthetic',password:'synthetic'},request,id,async()=>{calls++;return new Response('Payment Required',{status:402});})).cost,null);assert.equal(calls,2);
});
test('reconciliation requires one complete exact tagged final receipt, including charge zero',()=>{
 const receipt={id:'synthetic-task',url:'v3/dataforseo_labs/google/ranked_keywords/live',metadata:domainPayload(request,id),status:'20000',cost:0};
 const free=(items:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:items}]}});
 assert.equal(parseDomainReconciliation(free([receipt]),request,id).cost,'0.000000');
 for(const rows of [[],[receipt,receipt],Array.from({length:1000},()=>receipt),[{...receipt,status:'20100'}],[{...receipt,metadata:domainPayload(request,randomUUID())}]])assert.throws(()=>parseDomainReconciliation(free(rows),request,id));
});

function reportRequest(report:DomainReport):DomainRequest{return {...request,report,limit:report==='overview_v1'?1:25};}
function reportResponse(r:DomainRequest,items:unknown[]|null,total=items?.length??0){const value=response(r,items,total);value.body.tasks[0].path[3]=domainEndpointName(r);return value;}
const organicFixture={count:0,etv:0,estimated_paid_traffic_cost:0,pos_1:0,pos_2_3:null,pos_4_10:0};
const overviewItem={se_type:'google',location_code:2840,language_code:'en',metrics:{organic:organicFixture}};
test('authentic empty Labs overview preserves unknown provider total and completeness without losing its charge',()=>{
 const r=reportRequest('overview_v1');
 // Observed live 2026-10-19; synthetic identities, literal wire fields rather than a generated result fixture.
 const captured={httpStatus:200,body:{status_code:20000,cost:0.012,tasks_count:1,tasks:[{id:'provider-empty-task',status_code:20000,cost:0.012,path:['v3','dataforseo_labs','google','domain_rank_overview','live'],data:{api:'dataforseo_labs',function:'domain_rank_overview',se_type:'google',target:'example.com',location_code:2840,language_code:'en',limit:1,offset:0,tag:'ten98:domain:overview_v1:00000000-0000-4000-8000-000000000001',ignore_synonyms:false},result_count:1,result:[{se_type:'google',target:'example.com',location_code:2840,language_code:'en',total_count:null,items_count:0,items:null}] }]}};
 const out=parseDomainOutcome(captured,r,id);assert.equal(out.cost,'0.012000');assert.equal(out.reference,'provider-empty-task');assert.equal(out.diagnostic,null);assert.ok(out.result);assert.deepEqual(out.result.rows,[]);assert.equal(out.result.returnedCount,0);assert.equal(out.result.totalCount,null);assert.equal(out.result.limited,null);
 const csv=domainReportCsv(out.result);assert.ok(csv.includes('"Returned","0"\r\n'));assert.ok(csv.includes('"Provider total","Unavailable"\r\n'));assert.ok(csv.includes('"Partial","Unavailable"\r\n'));
 for(const patch of [{total_count:undefined},{items:[]},{items:[overviewItem]},{items_count:1},{location_code:2826},{language_code:'fr'},{target:'other.example.org'}]){const broken=structuredClone(captured);Object.assign(broken.body.tasks[0].result[0],patch);const result=parseDomainOutcome(broken,r,id);assert.equal(result.result,null);assert.equal(result.cost,'0.012000');}
 for(const mutate of [(v:any)=>v.body.tasks[0].data.tag='foreign',(v:any)=>v.body.tasks[0].path[3]='relevant_pages',(v:any)=>v.body.cost=0]){const broken=structuredClone(captured);mutate(broken);assert.equal(parseDomainOutcome(broken,r,id).cost,null);}
 for(const report of [undefined,'pages_v1'] as const){const sibling={...request,...report?{report}:{}},value=response(sibling,null);value.body.tasks[0].path[3]=domainEndpointName(sibling);Object.assign(value.body.tasks[0].result[0],{total_count:null});const result=parseDomainOutcome(value,sibling,id);assert.deepEqual(result.result?.rows,[]);assert.equal(result.result?.totalCount,null);assert.equal(result.result?.limited,null);assert.equal(result.cost,'0.012120');}
 for(const report of [undefined,'pages_v1'] as const){const sibling={...request,...report?{report}:{}},value=response(sibling,null);value.body.tasks[0].path[3]=domainEndpointName(sibling);Object.assign(value.body.tasks[0].result[0],{location_code:null,language_code:null});assert.deepEqual(parseDomainOutcome(value,sibling,id).result?.rows,[]);}
});
test('authentic empty competitor response retains unknown totals only under its exact task and market identity',()=>{
 const r=reportRequest('competitors_v1');
 const captured={httpStatus:200,body:{status_code:20000,cost:0.012,tasks_count:1,tasks:[{id:'provider-empty-competitor-task',status_code:20000,cost:0.012,result_count:1,path:['v3','dataforseo_labs','google','competitors_domain','live'],data:{api:'dataforseo_labs',function:'competitors_domain',se_type:'google',target:'example.com',location_code:2840,language_code:'en',limit:25,offset:0,tag:'ten98:domain:competitors_v1:00000000-0000-4000-8000-000000000001',item_types:['organic'],include_clickstream_data:false,ignore_synonyms:false,max_rank_group:100,exclude_top_domains:false,exclude_domains:['example.com','www.example.com'],order_by:['intersections,desc','domain,asc']},result:[{se_type:'google',target:'example.com',location_code:2840,language_code:'en',total_count:null,items_count:0,items:null}]}]}};
 const out=parseDomainOutcome(captured,r,id);assert.equal(out.cost,'0.012000');assert.equal(out.diagnostic,null);assert.equal(out.result?.report,'competitors_v1');assert.deepEqual(out.result?.rows,[]);assert.equal(out.result?.totalCount,null);assert.equal(out.result?.limited,null);
 for(const patch of [{total_count:undefined},{items:[]},{items_count:1},{location_code:null,language_code:null},{location_code:2826},{language_code:'fr'},{target:'other.example.org'}]){const broken=structuredClone(captured);Object.assign(broken.body.tasks[0].result[0],patch);const result=parseDomainOutcome(broken,r,id);assert.equal(result.result,null);assert.equal(result.cost,'0.012000');}
 const foreign=structuredClone(captured);foreign.body.tasks[0].data.tag='foreign';assert.equal(parseDomainOutcome(foreign,r,id).cost,null);
});
test('fixed report profiles cannot broaden scope, add paid options or change old request identity',()=>{
 assert.deepEqual(parseDomainRequest(request),request);
 for(const report of ['overview_v1','pages_v1','competitors_v1'] as const){const r=reportRequest(report);assert.deepEqual(parseDomainRequest(r),r);assert.equal(matchesDomainPayload(domainPayload(r,id),r,id),true);assert.equal(matchesDomainPayload(domainPayload(r,id),request,id),false);}
 for(const report of ['overview_v1','competitors_v1'] as const)for(const scope of ['domain','subfolder','exact_url'] as const)assert.throws(()=>parseDomainRequest({...reportRequest(report),target:'example.com/path',scope}));
 for(const patch of [{report:'overview'},{report:'pages_v2'},{limit:1},{report:'overview_v1',limit:25},{report:'pages_v1',include_clickstream_data:true},{report:'competitors_v1',max_rank_group:10}])assert.throws(()=>parseDomainRequest({...request,...patch}));
 const p=domainPayload(reportRequest('competitors_v1'),id);assert.deepEqual(p.exclude_domains,['example.com','www.example.com']);assert.equal(p.max_rank_group,100);assert.deepEqual(p.order_by,['intersections,desc','domain,asc']);
});
test('top page scope LIKE filters cover query/trailing slash without sibling paths or injected operators',()=>{
 function like(pattern:string,value:string){let source='^';for(let i=0;i<pattern.length;i++){const c=pattern[i];if(c==='\\'){const literal=pattern[++i];source+=literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}else source+=c==='%'?'.*':c==='_'?'.':c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}return new RegExp(source+'$').test(value);}
 for(const scope of ['domain','subfolder','exact_url'] as const){const r={...reportRequest('pages_v1'),target:'https://example.com/a%25_b',scope},payload=domainPayload(r,id),filters=payload.filters as unknown[][];const patterns=filters.filter(Array.isArray).map(f=>String(f[2]));assert.ok(patterns.length<=8);for(const url of ['https://example.com/a%25_b','http://www.example.com/a%25_b/','https://example.com/a%25_b?q=x','https://www.example.com/a%25_b/?q=x','https://example.com/a%25_b/child','https://example.com/a%25_blah','https://sub.example.com/a%25_b','https://evil-example.com/a%25_b','https://example.com/ax25xb'])assert.equal(patterns.some(p=>like(p,url)),domainUrlMatches(url,domainTarget(r.target,r.scope)),url+' '+scope);}
 for(const scope of ['subdomains','domain','subfolder','exact_url'] as const){
  const r={...reportRequest('pages_v1'),target:scope==='subfolder'?'https://example.com/guide':'https://example.com/',scope},payload=domainPayload(r,id),target=domainTarget(r.target,r.scope);
  if(scope==='subdomains'){assert.equal(payload.filters,undefined);assert.equal(domainUrlMatches('https://sub.example.com/',target),true);assert.equal(domainUrlMatches('https://evil-example.com/',target),false);continue;}
  const patterns=(payload.filters as unknown[][]).filter(Array.isArray).map(f=>String(f[2]));assert.equal(patterns.length,scope==='exact_url'?8:6);assert.equal(new Set(patterns).size,patterns.length,'Root variants must not duplicate patterns within the eight-condition ceiling.');
  for(const url of ['https://example.com','http://www.example.com','https://example.com?x=1','http://www.example.com?x=1','https://example.com/','https://www.example.com/?x=1','https://example.com/guide','https://example.com/guide/','https://example.com/guide?q=x','https://example.com/guide/child','https://example.com/guidebook','https://sub.example.com/','https://evil-example.com/'])assert.equal(patterns.some(p=>like(p,url)),domainUrlMatches(url,target),url+' '+scope+' root/prefix contract');
 }
});
test('new datasets preserve null/zero, overview market identity and separate competitor populations',()=>{
 const overview=reportRequest('overview_v1'),out=parseDomainOutcome(reportResponse(overview,[overviewItem]),overview,id);assert.equal(out.result?.report,'overview_v1');if(out.result?.report!=='overview_v1')assert.fail();assert.equal(out.result.rows[0].rankedKeywords,0);assert.equal(out.result.rows[0].estimatedAdsValueUsd,0);assert.equal(out.result.rows[0].rankDistribution[1],null);assert.equal(out.result.rows[0].rankDistribution[11],null);
 const missing=parseDomainOutcome(reportResponse(overview,[{...overviewItem,metrics:null}]),overview,id).result;if(missing?.report!=='overview_v1')assert.fail();assert.equal(missing.rows[0].estimatedTraffic,null);
 for(const adsValue of [100000000,0.0000001]){const estimated=parseDomainOutcome(reportResponse(overview,[{...overviewItem,metrics:{organic:{estimated_paid_traffic_cost:adsValue}}}]),overview,id).result;if(estimated?.report!=='overview_v1')assert.fail();assert.equal(estimated.rows[0].estimatedAdsValueUsd,adsValue,'Estimates do not inherit financial charge ceilings or precision.');}
 const pages=reportRequest('pages_v1'),page={se_type:'google',page_address:'https://sub.example.com/a',metrics:{organic:organicFixture}},pageOut=parseDomainOutcome(reportResponse(pages,[page],101),pages,id);assert.equal(pageOut.result?.limited,true);assert.equal(pageOut.result?.report,'pages_v1');
 const competitors=reportRequest('competitors_v1'),competitor={se_type:'google',domain:'other.example.org',intersections:2,avg_position:3.5,full_domain_metrics:{organic:{count:20,etv:200}},metrics:{organic:{count:2,etv:5}}},c=parseDomainOutcome(reportResponse(competitors,[competitor]),competitors,id).result;if(c?.report!=='competitors_v1')assert.fail();assert.equal(c.rows[0].fullDomain.estimatedTraffic,200);assert.equal(c.rows[0].targetOverlap.estimatedTraffic,5);assert.equal(c.rows[0].sharedKeywords,2);
 const empty=reportResponse(pages,null);Object.assign(empty.body.tasks[0].result[0],{location_code:null,language_code:null});assert.deepEqual(parseDomainOutcome(empty,pages,id).result?.rows,[]);
 for(const [r,items] of [[overview,[{...overviewItem,location_code:2826}]],[overview,[overviewItem,overviewItem]],[pages,[page,page]],[{...pages,scope:'domain'},[page]],[competitors,[{...competitor,domain:'127.0.0.1'}]],[competitors,[{...competitor,domain:'example.com'}]],[competitors,[{...competitor,avg_position:0}]],[competitors,[{...competitor,full_domain_metrics:{organic:{count:-1}}}]]] as const){const broken=parseDomainOutcome(reportResponse(r as DomainRequest,[...items]),r as DomainRequest,id);assert.equal(broken.cost,'0.012120');assert.equal(broken.result,null);}
});
test('CSV exports the retained dataset with provenance, nulls and spreadsheet-safe cells',()=>{
 const report=parseDomainOutcome(response(),request,id).result!;if(report.report)assert.fail();report.rows[0].keyword=' =SUM(1,2)';const csv=domainReportCsv(report);assert.ok(csv.includes('"\' =SUM(1,2)"'));assert.ok(csv.includes('"Unavailable"'));assert.ok(csv.includes('"0"'));assert.ok(csv.includes('"Target","example.com"\r\n'));assert.ok(csv.endsWith('\r\n'));
 const r=reportRequest('overview_v1'),overview=parseDomainOutcome(reportResponse(r,[overviewItem]),r,id).result!;assert.ok(domainReportCsv(overview).includes('"Positions 91–100"'));
});
test('each profile selects its exact account price and original reconciliation endpoint',()=>{
 for(const report of ['overview_v1','pages_v1','competitors_v1'] as const){const r=reportRequest(report),endpoint=domainEndpointName(r),account={login:'synthetic@example.com',price:{dataforseo_labs:{[endpoint]:{live:{priority_normal:[{cost_type:'per_request',cost:0.02},{cost_type:'per_result',cost:0.0002}]}}}}},free={httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:[account]}]}};assert.equal(parseKeywordAccount(free,endpoint,{key:'synthetic',version:2}).perTask,20000n);assert.throws(()=>parseKeywordAccount(free,'ranked_keywords',{key:'synthetic',version:2}));
  const receipt={id:'synthetic',url:'v3/dataforseo_labs/google/'+endpoint+'/live',metadata:domainPayload(r,id),status:'20000',cost:0},envelope=(rows:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:rows}]}});assert.equal(parseDomainReconciliation(envelope([receipt]),r,id).cost,'0.000000');assert.throws(()=>parseDomainReconciliation(envelope([{...receipt,url:'v3/dataforseo_labs/google/ranked_keywords/live'}]),r,id));assert.throws(()=>parseDomainReconciliation(envelope([{...receipt,metadata:domainPayload(request,id)}]),r,id));
 }
});
