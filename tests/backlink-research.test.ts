import test from 'node:test';
import assert from 'node:assert/strict';
import {backlinkTarget,backlinkPayload,backlinkUrlMatches,backlinkEndpoint,backlinkEndpointName,backlinkReconcileEndpoint,parseBacklinkRequest,parseDomainResearchRequest,matchesBacklinkPayload,type BacklinkRequest} from '../src/server/backlink-research-input.ts';
import {parseBacklinkOutcome,parseBacklinkReconciliation,requestBacklinkResearch,reconcileBacklinkCharge} from '../src/server/dataforseo-backlinks.ts';
import {parseKeywordAccount} from '../src/server/dataforseo-keywords.ts';
import {domainReportCsv} from '../src/server/domain-research.ts';
import {dataforseoJson,dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';
const id='00000000-0000-4000-8000-000000000001';
const profile:Extract<BacklinkRequest,{report:'backlinks_profile_v1'}>={report:'backlinks_profile_v1',connectionId:id,target:'example.com',scope:'subdomains',status:'live',limit:25,offset:0,follow:'all',order:'rank_desc'};
const overview:BacklinkRequest={report:'backlinks_overview_v1',connectionId:id,target:'example.com',scope:'domain',status:'all',limit:1};
const item=(target='https://example.com/guide')=>({type:'backlink',domain_from:'source.example.org',url_from:'https://source.example.org/article',domain_to:new URL(target).hostname,url_to:target,rank:0,page_from_rank:null,domain_from_rank:12,backlink_spam_score:0,dofollow:true,is_lost:false,is_broken:false,anchor:' =SUM(1,2)',first_seen:'2026-10-16 00:00:00 +00:00',last_seen:null,links_count:2});
const summary=()=>({backlinks:0,referring_domains:0,referring_main_domains:null,referring_pages:0,referring_ips:null,referring_subnets:null,broken_backlinks:0,backlinks_spam_score:0,rank:0,first_seen:null,lost_date:null});
function response(r:BacklinkRequest=profile,rows:unknown[]|null=[item()],total=rows?.length??0){return {httpStatus:200,body:{status_code:20000,cost:0.024036,tasks_count:1,tasks:[{id:'synthetic-backlink-task',status_code:20000,cost:0.024036,path:['v3','backlinks',backlinkEndpointName(r),'live'],data:backlinkPayload(r,id),result_count:1,result:[r.report==='backlinks_overview_v1'?{target:backlinkPayload(r,id).target,...summary()}:{target:backlinkPayload(r,id).target,mode:'as_is',custom_mode:null,total_count:total,items_count:rows?.length??0,items:rows}]}]}};}
test('closed backlink requests cannot borrow Google fields, arbitrary filters or automatic pagination',()=>{
 assert.deepEqual(parseDomainResearchRequest(profile),profile);assert.deepEqual(parseDomainResearchRequest(overview),overview);
 for(const patch of [{locationCode:2840},{languageCode:'en'},{limit:1},{offset:1},{offset:20025},{offset:-25},{sourceHost:'WWW.example.org'},{filters:[]},{mode:'one_per_domain'},{report:'backlinks_v2'},{status:'fresh'},{order:'price'},{searchAfterToken:'next'}])assert.throws(()=>parseDomainResearchRequest({...profile,...patch}));
 assert.throws(()=>parseBacklinkRequest({...overview,offset:0}));assert.throws(()=>parseBacklinkRequest({...overview,limit:25}));
 assert.equal(parseBacklinkRequest({...profile,offset:20000,limit:100}).target,'example.com');
 const organic={connectionId:id,target:'example.com',scope:'domain',locationCode:2840,languageCode:'en',limit:25};assert.deepEqual(parseDomainResearchRequest(organic),organic);
});
test('backlink scope preserves exact scheme/www/slash and never silently drops query, host paths or private targets',()=>{
 assert.equal(backlinkTarget('http://WWW.Example.com/','domain').target,'example.com');assert.equal(backlinkTarget('münich.de','domain').target,'xn--mnich-kva.de');
 const exact={...profile,target:'http://www.example.com/Guide/',scope:'exact_url' as const};assert.equal(parseBacklinkRequest(exact).target,exact.target);
 assert.equal(backlinkTarget('HTTP://WWW.Example.com/Guide/','exact_url').target,exact.target);
 for(const target of ['https://www.example.com/Guide/','http://example.com/Guide/','http://www.example.com/Guide','http://www.example.com/Guide/?x=1'])assert.equal(backlinkUrlMatches(target,exact),false);
 assert.equal(backlinkUrlMatches(exact.target,exact),true);assert.equal(backlinkUrlMatches('https://evil-example.com/a',profile),false);assert.equal(backlinkUrlMatches('https://child.example.com/a',profile),true);assert.equal(backlinkUrlMatches('https://www.example.com/a',{...profile,scope:'domain'}),false);
 for(const target of ['https://example.com/?','https://example.com/#','https://example.com/?q=1','https://example.com/#x','https://example.com/path','localhost','http://127.0.0.1','https://user:pass@example.com','https://example.com:444','https://example.com\\evil','https://example.com/%GG','https://example.com/%ED%A0%80'])assert.throws(()=>backlinkTarget(target,'domain'));
 for(const target of ['example.com/a','https://example.com/'])assert.throws(()=>backlinkTarget(target,'subfolder'));
});
test('folder predicates escape LIKE and retain exact boundary, with at most five filter conditions',()=>{
 const r={...profile,target:'http://www.example.com/a%25_b/',scope:'subfolder' as const,follow:'nofollow' as const,sourceHost:'source.example.org'};const p=backlinkPayload(r,id);
 assert.equal(p.target,'example.com');assert.equal(p.include_subdomains,true);assert.equal(p.exclude_internal_backlinks,true);assert.equal(p.rank_scale,'one_hundred');assert.deepEqual(p.filters,[[['url_to','=','http://www.example.com/a%25_b'],'or',['url_to','like','http://www.example.com/a\\%25\\_b/%'],'or',['url_to','like','http://www.example.com/a\\%25\\_b?%']],'and',['dofollow','=',false],'and',['domain_from','=','source.example.org']]);
 assert.equal(backlinkUrlMatches('http://www.example.com/a%25_b?q=1',r),true);assert.equal(backlinkUrlMatches('http://www.example.com/a%25_b/child',r),true);
 for(const target of ['http://www.example.com/a%25_bad','https://www.example.com/a%25_b','http://example.com/a%25_b'])assert.equal(backlinkUrlMatches(target,r),false);
 const s=backlinkPayload({...overview,target:r.target,scope:'subfolder'},id);assert.equal(s.include_indirect_links,false);assert.ok(s.backlinks_filters);assert.equal(Object.hasOwn(s,'limit'),false);
 const root={...profile,scope:'exact_url' as const,target:'https://example.com/'};assert.deepEqual(backlinkPayload(root,id).filters,[['url_to','in',['https://example.com/','https://example.com']]]);assert.equal(backlinkUrlMatches('https://example.com',root),true);assert.equal(backlinkUrlMatches('https://example.com/?x=1',root),false);
 assert.deepEqual(backlinkPayload({...profile,scope:'domain'},id).filters,[['domain_to','=','example.com']]);
 assert.equal(matchesBacklinkPayload(p,r,id),true);for(const patch of [{tag:'foreign'},{offset:25},{rank_scale:'one_thousand'},{filters:[]},{search_after_token:'next'}])assert.equal(matchesBacklinkPayload({...p,...patch},r,id),false);
});
test('account pricing reads exact Backlinks units without accepting Labs lookalikes or guessed entitlement',()=>{
 const units=[{cost_type:'per_request',cost:0.024},{cost_type:'per_result',cost:0.000036}],row={login:'synthetic@example.org',price:{backlinks:{summary:{live:{priority_normal:units}},backlinks:{live:{priority_normal:units}}},dataforseo_labs:{summary:{live:{priority_normal:units}}}}};
 const free={httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:[row]}]}};
 for(const mode of ['backlinks_summary','backlinks_profile'] as const){const price=parseKeywordAccount(free,mode,{key:'synthetic',version:2});assert.equal(price.perTask,24000n);assert.equal(price.perItem,36n);assert.equal(price.perTask+100n*price.perItem,27600n);assert.equal(price.fingerprint,parseKeywordAccount(free,undefined,{key:'synthetic',version:2}).fingerprint);}
 for(const prices of [[],[{cost_type:'per_request',cost:0.024}],units.concat(units),[{cost_type:'per_request',cost:0},{cost_type:'per_result',cost:0}]]){const bad=structuredClone(free);bad.body.tasks[0].result[0].price.backlinks.summary.live.priority_normal=prices;assert.throws(()=>parseKeywordAccount(bad,'backlinks_summary',{key:'synthetic',version:2}));}
 const absent=structuredClone(free);delete (absent.body.tasks[0].result[0].price as {backlinks?:unknown}).backlinks;assert.throws(()=>parseKeywordAccount(absent,'backlinks_summary',{key:'synthetic',version:2}));
});
test('overview retains measured zero and missing values, and never invents a folder or Ahrefs rank',()=>{
 const out=parseBacklinkOutcome(response(overview),overview,id);assert.equal(out.cost,'0.024036');assert.equal(out.result?.report,'backlinks_overview_v1');if(out.result?.report!=='backlinks_overview_v1')assert.fail();assert.equal(out.result.rows[0].rank,0);assert.equal(out.result.rows[0].referringMainDomains,null);assert.equal(out.result.returnedCount,1);assert.equal(out.result.rows[0].backlinks,0);
 const folder={...overview,target:'https://example.com/guide',scope:'subfolder' as const},r=parseBacklinkOutcome(response(folder),folder,id).result;if(r?.report!=='backlinks_overview_v1')assert.fail();assert.equal(r.rows[0].rank,null);assert.equal(r.rows[0].backlinks,0);
});
test('profile retains link identity, first/last observation and explicit partial page counts',()=>{
 const r={...profile,offset:25},out=parseBacklinkOutcome(response(r,[item()],26),r,id).result;if(out?.report!=='backlinks_profile_v1')assert.fail();assert.equal(out.limited,true);assert.equal(out.offset,25);assert.equal(out.rows[0].linksCount,2);assert.equal(out.rows[0].rank,0);assert.equal(out.rows[0].pageRank,null);assert.equal(out.rows[0].firstSeen,'2026-10-16T00:00:00.000Z');assert.equal(out.rows[0].lastSeen,null);assert.equal(out.rows[0].sourceUrl,item().url_from);
 const empty=parseBacklinkOutcome(response(r,null,0),r,id).result;assert.deepEqual(empty?.rows,[]);assert.equal(empty?.limited,true);
 assert.equal(parseBacklinkOutcome(response(profile,null,0),profile,id).result?.limited,false);
});
test('out-of-scope/filter/invalid/duplicate rows retain verified charge but expose no misleading dataset',()=>{
 const cases=[response(profile,[item('https://evil.example.org')]),response(profile,[item(),item()]),response(profile,[item(),item('https://example.com/other')]),response(profile,[{...item(),rank:101}]),response(profile,[{...item(),domain_to:'other.example.org'}]),response(profile,[{...item(),is_lost:true}]),response(profile,[{...item(),anchor:'x'.repeat(4097)}]),response(profile,[{...item(),first_seen:'2026-02-30 00:00:00 +00:00'}]),response(profile,[item()],0)];
 for(const r of cases){const out=parseBacklinkOutcome(r,profile,id);assert.equal(out.result,null);assert.equal(out.cost,'0.024036');assert.equal(out.reference,'synthetic-backlink-task');}
 for(const patch of [{follow:'nofollow' as const},{sourceHost:'other.example.org'}]){const r={...profile,...patch};assert.equal(parseBacklinkOutcome(response(r),r,id).result,null);}
 const missing=response(profile);(missing.body.tasks[0].result[0] as Record<string,unknown>).items_count=2;assert.equal(parseBacklinkOutcome(missing,profile,id).result,null);
});
test('wrong envelope identity/path/accounting never becomes a zero-priced success',()=>{
 for(const change of ['path','tag','cost','scale','offset'] as const){const r=response(profile);if(change==='path')r.body.tasks[0].path=['v3','dataforseo_labs','google','ranked_keywords','live'];if(change==='tag')r.body.tasks[0].data.tag='wrong';if(change==='cost')r.body.cost=0;if(change==='scale')r.body.tasks[0].data.rank_scale='one_thousand';if(change==='offset')r.body.tasks[0].data.offset=25;const out=parseBacklinkOutcome(r,profile,id);assert.equal(out.result,null);assert.equal(out.cost,null);assert.equal(out.reference,null);}
});
test('wallet refusals with an explicit zero cost settle $0 with the fixed text; charged or other refusals stay unknown (D3)',async()=>{
 for(const r of [profile,overview]){
  const top=parseBacklinkOutcome({httpStatus:200,body:{status_code:40203,cost:0,tasks_count:0,tasks:null}},r,id);
  assert.deepEqual(top,{cost:'0.000000',reference:null,result:null,diagnostic:dataforseoRefusalMessage.cost_limit,evidence:{httpStatus:200,statusCode:40203,taskStatus:null,reportedCost:0,taskCost:null}});
  const task=parseBacklinkOutcome({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{id:'synthetic-backlink-task',status_code:40210,cost:0}]}},r,id);
  assert.equal(task.cost,'0.000000');assert.equal(task.reference,null);assert.equal(task.diagnostic,dataforseoRefusalMessage.payment);assert.deepEqual(task.evidence,{httpStatus:200,statusCode:20000,taskStatus:40210,reportedCost:0,taskCost:0});
  for(const body of [{status_code:40210,cost:0.024036,tasks:null},{status_code:40210,tasks:null},{status_code:40209,cost:0,tasks:null},{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0},{status_code:40203,cost:0}]}]){const out=parseBacklinkOutcome({httpStatus:200,body},r,id);assert.equal(out.cost,null,JSON.stringify(body));assert.equal(out.result,null);}
 }
 let calls=0;const reply=(value:unknown,status:number):typeof fetch=>async()=>{calls++;return Response.json(value,{status});};
 const http=await requestBacklinkResearch({login:'synthetic',password:'synthetic'},profile,id,reply({cost:0,tasks:null},402));assert.equal(http.cost,'0.000000');assert.equal(http.evidence.httpStatus,402);assert.equal(http.evidence.statusCode,null);assert.equal(http.diagnostic,dataforseoRefusalMessage.payment);
 assert.equal((await requestBacklinkResearch({login:'synthetic',password:'synthetic'},profile,id,reply({status_code:40201,cost:0,tasks:null},402))).cost,null);assert.equal(calls,2);
});
test('reconciliation binds exact Backlinks path/profile/page/tag and rejects ambiguous or truncated evidence',()=>{
 const receipt={id:'synthetic-backlink-task',url:'v3/backlinks/backlinks/live',metadata:backlinkPayload(profile,id),status:'20000',cost:0.024036};const free=(rows:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:rows}]}});
 assert.deepEqual(parseBacklinkReconciliation(free([receipt]),profile,id),{reference:receipt.id,cost:'0.024036',statusCode:20000});
 for(const rows of [[],[receipt,receipt],[{...receipt,url:'v3/dataforseo_labs/google/ranked_keywords/live'}],[{...receipt,status:'50000'}],[{...receipt,metadata:{...receipt.metadata,offset:25}}],Array.from({length:1000},()=>({}))])assert.throws(()=>parseBacklinkReconciliation(free(rows),profile,id));
});
test('bounded retained CSV preserves target/filter/page/metric meaning, formula safety and null versus zero',()=>{
 const out=parseBacklinkOutcome(response(profile),profile,id).result!;const csv=domainReportCsv(out);assert.ok(csv.includes('"\' =SUM(1,2)"'));assert.ok(csv.includes('"Unavailable"'));assert.ok(csv.includes('"0"'));assert.ok(csv.includes('"Offset","0"'));assert.ok(csv.includes('Highest-ranked backlink'));assert.ok(!csv.includes('Location code'));assert.ok(csv.includes('not Ahrefs Domain Rating'));assert.ok(csv.includes(item().url_from));
 const multiline=parseBacklinkOutcome(response(profile,[{...item(),anchor:'First\nSecond\tline'}]),profile,id).result!;assert.ok(domainReportCsv(multiline).includes('"First\nSecond\tline"'));
 const wide={...profile,limit:100 as const},text='😀'.repeat(1900),large=parseBacklinkOutcome(response(wide,Array.from({length:100},(_,i)=>({...item('https://example.com/'+text+i),url_from:'https://source.example.org/'+text+i,anchor:text})),100),wide,id);assert.equal(large.result,null);assert.equal(large.cost,'0.024036');
});
test('transport admits fixed Backlinks routes with one attempt and no paid follow-up',async()=>{
 let calls=0;const send:typeof fetch=async(url,init)=>{calls++;assert.equal(url,backlinkEndpoint(profile));assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);assert.deepEqual(JSON.parse(String(init?.body)),[backlinkPayload(profile,id)]);return Response.json(response(profile).body);};
 assert.equal((await requestBacklinkResearch({login:'synthetic',password:'synthetic'},profile,id,send)).result?.source,'DataForSEO Backlinks');assert.equal(calls,1);
 const unknown=await requestBacklinkResearch({login:'synthetic',password:'synthetic'},profile,id,async()=>{calls++;throw new Error('Synthetic lost response');});assert.equal(unknown.cost,null);assert.equal(calls,2);
 for(const endpoint of ['https://api.dataforseo.com/v3/backlinks/history/live',backlinkEndpoint(profile)+'?offset=25','https://evil.example.org/v3/backlinks/backlinks/live'])await assert.rejects(dataforseoJson(endpoint,{login:'synthetic',password:'synthetic'},'POST',[],send));assert.equal(calls,2);
 await assert.rejects(reconcileBacklinkCharge({},profile,id,new Date(Date.now()-29*86400000),send));assert.equal(calls,2);assert.equal(backlinkReconcileEndpoint,'https://api.dataforseo.com/v3/backlinks/id_list');
});

const grouped=(report:'backlinks_referring_domains_v1'|'backlinks_anchors_v1'):Extract<BacklinkRequest,{report:'backlinks_referring_domains_v1'|'backlinks_anchors_v1'}>=>({...profile,report,order:'backlinks_desc'});
const groupItem=(report:ReturnType<typeof grouped>['report'],identity=report==='backlinks_referring_domains_v1'?'publisher.example.org':' =SUM(1,2)')=>({type:report==='backlinks_referring_domains_v1'?'backlinks_referring_domain':'backlinks_anchor',...report==='backlinks_referring_domains_v1'?{domain:identity}:{anchor:identity},backlinks:0,rank:0,backlinks_spam_score:null,referring_domains:2,referring_main_domains:1,referring_pages:3,referring_pages_nofollow:0,referring_ips:null,referring_subnets:1,broken_backlinks:0,broken_pages:null,first_seen:'2026-10-16 00:00:00 +00:00',lost_date:null});
function groupResponse(r:ReturnType<typeof grouped>,rows:unknown[]|null=[groupItem(r.report)],total=51){return {httpStatus:200,body:{status_code:20000,cost:0.024036,tasks_count:1,tasks:[{id:'synthetic-group-task',status_code:20000,cost:0.024036,path:['v3','backlinks',backlinkEndpointName(r),'live'],data:backlinkPayload(r,id),result_count:1,result:[{target:backlinkPayload(r,id).target,total_count:total,items_count:rows?.length??0,items:rows}]}]}};}
test('native domain and anchor groups use initial backlink filters before one bounded paid page',()=>{
 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'] as const)for(const scope of ['domain','subdomains','subfolder','exact_url'] as const){
  const r={...grouped(report),scope,target:scope==='subfolder'?'http://www.example.com/guide':scope==='exact_url'?'http://www.example.com/guide/':'example.com',offset:25,status:'lost' as const,follow:'nofollow' as const,sourceHost:'publisher.example.org'},p=backlinkPayload(r,id);
  assert.deepEqual(parseDomainResearchRequest(r),r);assert.equal(p.limit,25);assert.equal(p.offset,25);assert.equal(p.include_indirect_links,false);assert.equal(p.internal_list_limit,1);assert.equal(p.exclude_internal_backlinks,true);assert.equal(p.backlinks_status_type,'lost');assert.equal(p.rank_scale,'one_hundred');assert.equal(Object.hasOwn(p,'filters'),false);assert.equal(Object.hasOwn(p,'mode'),false);assert.deepEqual((p.backlinks_filters as unknown[]).slice(-4),['and',['dofollow','=',false],'and',['domain_from','=','publisher.example.org']]);assert.deepEqual(p.order_by,['backlinks,desc',(report==='backlinks_referring_domains_v1'?'domain':'anchor')+',asc']);assert.equal(backlinkEndpoint(r),'https://api.dataforseo.com/v3/backlinks/'+(report==='backlinks_referring_domains_v1'?'referring_domains':'anchors')+'/live');
  for(const patch of [{order:'last_seen_desc'},{offset:1},{limit:1000},{sourceHost:'https://publisher.example.org'},{filters:[]},{backlinks_filters:[]},{locationCode:2840},{languageCode:'en'}])assert.throws(()=>parseDomainResearchRequest({...r,...patch}));
  assert.equal(matchesBacklinkPayload({...p,filters:['backlinks','>',10]},r,id),false);assert.equal(matchesBacklinkPayload({...p,backlinks_filters:[]},r,id),false);
 }
});
test('group rows retain provider identity and nullable native metrics without unique-link or rating inventions',()=>{
 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'] as const){const r=grouped(report),out=parseBacklinkOutcome(groupResponse(r),r,id).result;if(!out||out.report!==report)assert.fail();assert.equal(out.totalCount,51);assert.equal(out.returnedCount,1);assert.equal(out.limited,true);assert.equal(out.rows[0].backlinks,0);assert.equal(out.rows[0].spamScore,null);assert.equal(out.rows[0].referringPages,3);assert.equal(out.rows[0].referringMainDomains,1);assert.equal(out.rows[0].rank,0);assert.equal(out.rows[0].firstSeen,'2026-10-16T00:00:00.000Z');assert.equal(out.rows[0].lostAt,null);const csv=domainReportCsv(out);assert.ok(csv.includes('native grouped observations'));assert.ok(csv.includes('not alias-deduplicated unique links'));assert.ok(csv.includes('Initial backlink source host filter'));assert.ok(csv.includes('"Unavailable"'));assert.ok(csv.includes('"0"'));if(report==='backlinks_anchors_v1')assert.ok(csv.includes('"\' =SUM(1,2)"'));
  const zero=parseBacklinkOutcome(groupResponse(r,null,0),r,id).result;assert.deepEqual(zero?.rows,[]);assert.equal(zero?.totalCount,0);assert.equal(zero?.limited,false);
  const empty=parseBacklinkOutcome(groupResponse({...r,offset:75},null,51),{...r,offset:75},id).result;assert.equal(empty?.limited,true);assert.equal(empty?.totalCount,51);
 }
 const r=grouped('backlinks_anchors_v1'),out=parseBacklinkOutcome(groupResponse(r,[groupItem(r.report,''),groupItem(r.report,'First\nSecond\tline')],2),r,id).result;assert.equal(out?.report,'backlinks_anchors_v1');if(out?.report!=='backlinks_anchors_v1')assert.fail();assert.equal(out.rows[0].anchor,'');assert.equal(out.rows[1].anchor,'First\nSecond\tline');
});
test('malformed grouped content preserves known cost while copied endpoints or population filters stay uncertain',()=>{
 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'] as const){const r=grouped(report),valid=groupItem(report);
  for(const rows of [[valid,valid],[{...valid,type:'backlink'}],[{...valid,rank:101}],[{...valid,backlinks:-1}],[{...valid,first_seen:'2026-02-30 00:00:00 +00:00'}],[groupItem(report,report==='backlinks_referring_domains_v1'?'127.0.0.1':'bad\u0000anchor')],[groupItem(report,'x'.repeat(4097))]]){const out=parseBacklinkOutcome(groupResponse(r,rows),r,id);assert.equal(out.result,null);assert.equal(out.cost,'0.024036');assert.equal(out.reference,'synthetic-group-task');}
  for(const mutate of [(v:ReturnType<typeof groupResponse>)=>{v.body.tasks[0].data.backlinks_filters=[];},(v:ReturnType<typeof groupResponse>)=>{v.body.tasks[0].path=['v3','backlinks','backlinks','live'];},(v:ReturnType<typeof groupResponse>)=>{v.body.tasks[0].data.filters=['backlinks','>',10];},(v:ReturnType<typeof groupResponse>)=>{v.body.tasks[0].data.mode='one_per_domain';}]){const response=groupResponse(r);mutate(response);const out=parseBacklinkOutcome(response,r,id);assert.equal(out.result,null);assert.equal(out.cost,null);}
 }
});
test('group prices and reconciliation bind their exact native endpoint without paid fallback or continuation',async()=>{
 const units=[{cost_type:'per_request',cost:0.024},{cost_type:'per_result',cost:0.000036}],free={httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:[{login:'synthetic@example.org',price:{backlinks:{referring_domains:{live:{priority_normal:units}},anchors:{live:{priority_normal:units}}}}}]}]}};let calls=0;
 for(const report of ['backlinks_referring_domains_v1','backlinks_anchors_v1'] as const){const r=grouped(report),mode=report==='backlinks_referring_domains_v1'?'backlinks_referring_domains':'backlinks_anchors',price=parseKeywordAccount(free,mode,{key:'synthetic',version:2});assert.equal(price.perTask+25n*price.perItem,24900n);const absent=structuredClone(free);absent.body.tasks[0].result[0].price.backlinks[report==='backlinks_referring_domains_v1'?'referring_domains':'anchors'].live.priority_normal=[];assert.throws(()=>parseKeywordAccount(absent,mode,{key:'synthetic',version:2}));
  const send:typeof fetch=async(url,init)=>{calls++;assert.equal(url,backlinkEndpoint(r));assert.deepEqual(JSON.parse(String(init?.body)),[backlinkPayload(r,id)]);return Response.json(groupResponse(r).body);};assert.equal((await requestBacklinkResearch({login:'synthetic',password:'synthetic'},r,id,send)).result?.report,report);
  const receipt={id:'synthetic-group-task',url:'v3/backlinks/'+backlinkEndpointName(r)+'/live',metadata:backlinkPayload(r,id),status:'20000',cost:0.024036},response={httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result:[receipt]}]}};assert.equal(parseBacklinkReconciliation(response,r,id).cost,'0.024036');assert.throws(()=>parseBacklinkReconciliation({...response,body:{...response.body,tasks:[{...response.body.tasks[0],result:[{...receipt,url:'v3/backlinks/backlinks/live'}]}]}},r,id));
 }
 assert.equal(calls,2);
});