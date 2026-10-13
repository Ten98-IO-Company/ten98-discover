import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validSpecializedCitationFilters,validSpecializedCitationNavigation,validSpecializedCitationReport} from '../src/lib/citation-specialized-report.ts';
import {validCitationEvidence} from '../src/lib/citation-report.ts';
import type {SpecializedFilters,SpecializedNavigation,SpecializedReport} from '../src/server/prompt-citation-specializations.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(n:number)=>n.toString(16).padStart(64,'0');
const zero=()=>({executions:0,annotations:0,prompts:0});
const count=(executions:number,annotations=executions,prompts=Number(executions>0))=>({executions,annotations,prompts});
const part=(executions:number,annotations=executions,pages=annotations)=>({...count(executions,annotations),groupedPages:pages});
const coverage=(eligible:number)=>({attempted:eligible,eligible,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0});
const filters:SpecializedFilters={from:'2026-10-12',to:'2026-10-12',timeZone:'UTC',model:null,promptId:null,tag:null,urlGrouping:'retained-fragment-v1',query:null,publisherCategory:null,pageType:null,sourceType:null,ownership:null,entityId:null,productAttribution:null};
const nav:SpecializedNavigation={view:'reddit',period:null,groupId:null,gapPromptId:null,evidenceMode:null};
function period(date:string,eligible:number){return {from:date,to:date,open:false,coverage:coverage(eligible),eligibleAnswers:eligible||null,reddit:{all:zero(),community:zero(),ungrouped:zero()},google:{shopping:zero(),labelledShopping:zero(),unlabelledShopping:zero(),matchingProducts:zero(),search:zero(),labelledSearch:zero(),unlabelledSearch:zero(),wrappers:zero()},gaps:{status:'ready' as const,evaluatedPrompts:Number(eligible>0),promptsWithCompetitor:0,observedCandidates:0,confirmedCandidates:0,matchingCandidates:0}};}
function sample():SpecializedReport{return {role:'viewer',filters:{...filters},navigation:{...nav},asOf:'2026-10-13T12:00:00.000001Z',contextRevision:1,profileHash:hash(1),selectionRevision:hash(2),eligibilityVersion:'retained-nonempty-stop-v1',classifierVersion:'elmo-3c673d0-native-axes-v1',ownershipVersion:'citation-host-suffix-v1',googleDomainsVersion:'google-supported-2026-10-13-sha256-'+hash(3),methods:{reddit:'reddit-path-community-v1',googleLabels:'google-retained-link-labels-elmo-v1',productAttribution:'google-product-name-elmo-v1',gaps:'prompt-period-domain-gap-v1'},label:'Specialized retained citation observations using current project context',warnings:[],entities:[{id:'brand',label:'Current brand'},{id:id(10),label:'Competitor'},{id:id(11),label:'Same name'}],googleConsumerModule:{status:'not_recorded',reason:'consumer_surface_not_captured'},unresolvedEvidence:{redditCommunityId:hash(90),shoppingLabelId:hash(91),searchQueryId:hash(92),googleWrapperId:hash(93)},current:period(filters.from,2),previous:period('2026-10-11',1),evidenceStates:[{id:id(1),period:'current',eligibility:'eligible'},{id:id(2),period:'current',eligibility:'eligible'},{id:id(3),period:'previous',eligibility:'eligible'}],page:{kind:'reddit',rows:[]},totalRows:0,nextCursor:null};}
const valid=(r:unknown,f=filters,n=nav,page=0)=>validSpecializedCitationReport(r,f,n,page);
const accepts=(r:SpecializedReport)=>assert.ok(valid(r,r.filters,r.navigation));
function rejects(make:()=>SpecializedReport,changes:((r:any)=>void)[]){for(const change of changes){const r=make();change(r);assert.equal(valid(r,r.filters,r.navigation),false,change.toString());}}
const rep=(previous=false)=>({executionId:id(previous?3:1),comparisonId:id(20),retainedCitationIndex:0,retainedUrl:'https://www.reddit.com/r/skin/comments/1',retainedTitle:null,requestedAt:`2026-10-${previous?'11':'12'}T12:00:00.000001Z`});
function reddit(){const r=sample();r.current.reddit={all:count(2,4),community:count(2,3),ungrouped:count(1)};r.previous.reddit={all:count(1),community:count(1),ungrouped:zero()};r.page={kind:'reddit',rows:[{id:hash(4),label:'r/skin',kind:'reddit',communityKey:'r/skin',current:part(2,3,2),previous:part(1),currentNewPages:1,previousNotObservedPages:0,changeStatus:'ready'}]};r.totalRows=1;return r;}
function shopping(){const r=sample();r.navigation={...nav,view:'shopping'};r.current.google.shopping=count(2,3);r.current.google.labelledShopping=count(1,2);r.current.google.unlabelledShopping=count(1);r.current.google.matchingProducts=count(1,2);r.page={kind:'shopping',rows:[{kind:'product',id:hash(5),label:'保留 <img src=x onerror=alert(1)>\nProduct 900719925474099312345',labelBasis:'mixed',attribution:{kind:'competitor',competitorId:id(10)},current:part(1,2,2),previous:part(0),currentRepresentative:{...rep(),retainedUrl:'https://www.google.com/search?ibp=oshop&prds=productid:900719925474099312345',retainedTitle:''},previousRepresentative:null}]};r.totalRows=1;return r;}
function search(){const r=sample();r.navigation={...nav,view:'search'};r.current.google.search=count(2);r.current.google.labelledSearch=count(2);r.page={kind:'search',rows:[{kind:'query',id:hash(6),label:'保留 café %_ + question',labelBasis:'retained_url_q',current:part(2),previous:part(0)}]};r.totalRows=1;return r;}
function gap(){const r=sample();r.filters.query='competitor';r.navigation={...nav,view:'gaps',period:'current'};r.current.gaps={status:'ready',evaluatedPrompts:1,promptsWithCompetitor:1,observedCandidates:1,confirmedCandidates:1,matchingCandidates:1};r.page={kind:'gaps',rows:[{promptId:id(30),representativeVersionId:id(31),promptPreview:'Authored prompt, not copied execution input',versionCount:2,period:'current',coverage:coverage(2),status:'confirmed_observed_gap',brandAnnotations:0,competitorCount:count(2,3),competitorIds:[id(10),id(11)],matchingCompetitorCount:count(1)}]};r.totalRows=1;return r;}
function evidence(gapAll=false){const r=sample();r.navigation={view:'evidence',period:'current',groupId:gapAll?null:hash(4),gapPromptId:gapAll?id(30):null,evidenceMode:gapAll?'gap_all':'matching'};r.page={kind:'evidence',basis:gapAll?'gap_all':'matching',rows:[{...rep(),id:hash(7),promptId:id(30),versionId:id(31),period:'current',date:filters.from,model:'openai/gpt-4o-mini',urlId:hash(8),groupedUrl:'https://www.reddit.com/r/skin/comments/1',hostname:'www.reddit.com',trackable:true,classification:{ownership:{brand:false,competitorIds:[id(10)],ambiguous:false},publisherCategory:'social',automaticPublisherCategory:'social',publisherBasis:'elmo-automatic',pageType:'forum',pageTypeBasis:'elmo-url-title-heuristic-v1',sourceType:'publisher'}}]};r.totalRows=1;return r;}

test('specialized summaries preserve observed zeros, missing identity and literal unavailable module',()=>{
 accepts(sample());accepts(reddit());accepts(shopping());accepts(search());
 const noIdentity=sample();for(const p of [noIdentity.current,noIdentity.previous])p.gaps={status:'brand_identity_unavailable',evaluatedPrompts:null,promptsWithCompetitor:null,observedCandidates:null,confirmedCandidates:null,matchingCandidates:null};noIdentity.navigation={...nav,view:'gaps',period:'current'};noIdentity.page={kind:'gaps',rows:[]};accepts(noIdentity);
 const empty=sample();empty.current=period(filters.from,0);empty.previous=period('2026-10-11',0);empty.evidenceStates=[];accepts(empty);
 rejects(sample,[(r)=>r.googleConsumerModule.status='available',(r)=>r.googleConsumerModule.reason='supported_empty',(r)=>r.current.eligibleAnswers=0,(r)=>r.current.gaps.status='brand_identity_unavailable',(r)=>r.current.google.shopping=count(1)]);
});

test('exact request filters/navigation bind responses; opaque group references are not guessed authority',()=>{
 assert.ok(validSpecializedCitationFilters(filters));assert.ok(validSpecializedCitationNavigation(nav));
 for(const change of [{query:'\u0000'},{to:'2026-12-01'},{timeZone:'Not/AZone'},{productAttribution:'publisher'},{extra:1}])assert.equal(validSpecializedCitationFilters({...filters,...change}),false);
 for(const change of [{view:'reddit_pages'},{period:'current'},{groupId:hash(1)},{evidenceMode:'matching'},{extra:null}])assert.equal(validSpecializedCitationNavigation({...nav,...change}),false);
 const r=evidence();accepts(r);assert.equal(valid(r,r.filters,{...r.navigation,groupId:hash(50)}),false);assert.equal(valid(r,{...r.filters,query:'different'},r.navigation),false);
 // The server resolves this opaque reference; the client validates exact request
 // equality, not invented equality with a record URL hash or evidence ID.
 r.navigation.groupId=hash(50);accepts(r);
 rejects(sample,[(r)=>r.role='public',(r)=>r.filters.extra='unrequested',(r)=>r.navigation.extra=null,(r)=>r.methods.gaps='invented-gap-v2',(r)=>r.asOf='2026-02-30T00:00:00Z',(r)=>r.contextRevision=0]);
});

test('whole-selection coverage and unique manifest reject omissions, duplicates and forged eligibility',()=>{
 rejects(reddit,[(r)=>r.evidenceStates.pop(),(r)=>r.evidenceStates[2].id=r.evidenceStates[0].id,(r)=>r.evidenceStates[0].eligibility='expired',(r)=>r.evidenceStates[0].period='previous',(r)=>r.current.coverage.attempted=3,(r)=>r.current.from='2026-10-11',(r)=>r.current.open=true,(r)=>r.previous.to='2026-10-12',(r)=>r.evidenceStates=new Array(3)]);
 const r=shopping();r.evidenceStates[0].eligibility='expired';r.current.coverage.eligible--;r.current.coverage.expired++;r.current.eligibleAnswers=1;assert.equal(valid(r,r.filters,r.navigation),false,'A retained representative cannot reference an expired answer');
 const inherited=sample();inherited.entities[1]=Object.create({id:id(10),label:'Inherited'});assert.equal(valid(inherited),false);
});

test('annotation partitions allow overlapping answer counts but reject impossible totals and attribution',()=>{
 accepts(reddit());accepts(shopping());
 rejects(reddit,[(r)=>r.current.reddit.community.annotations=5,(r)=>r.current.reddit.all.executions=1,(r)=>r.page.rows[0].current.groupedPages=4,(r)=>r.page.rows[0].currentNewPages=3,(r)=>r.page.rows[0].communityKey='r/Skin',(r)=>r.page.rows[0].current.annotations=2]);
 rejects(shopping,[(r)=>r.current.google.matchingProducts.annotations=3,(r)=>r.page.rows[0].attribution.competitorId=id(99),(r)=>r.page.rows[0].attribution={kind:'brand',competitorId:id(10)},(r)=>r.page.rows[0].previousRepresentative=rep(true),(r)=>r.page.rows[0].currentRepresentative.retainedUrl='https://user:pass@www.google.com/search',(r)=>r.entities.push({id:id(10),label:'Duplicate'})]);
 const filtered=shopping();filtered.filters.productAttribution='competitor';accepts(filtered);filtered.filters.productAttribution='brand';assert.equal(valid(filtered,filtered.filters,filtered.navigation),false);
});

test('gap confirmation uses full prompt-period coverage, not matching competitor counts',()=>{
 const r=gap();accepts(r);assert.equal(r.page.kind==='gaps'&&r.page.rows[0].matchingCompetitorCount.annotations,1);
 rejects(gap,[(r)=>r.page.rows[0].brandAnnotations=1,(r)=>r.page.rows[0].matchingCompetitorCount.annotations=4,(r)=>r.page.rows[0].competitorIds=[id(99)],(r)=>r.page.rows[0].coverage.attempted=3,(r)=>r.current.gaps.matchingCandidates=0,(r)=>r.current.gaps.confirmedCandidates=2,(r)=>r.page.rows[0].versionCount=3]);
 const incomplete=gap();incomplete.current.coverage.eligible=1;incomplete.current.coverage.expired=1;incomplete.current.eligibleAnswers=1;incomplete.current.gaps.confirmedCandidates=0;incomplete.evidenceStates[1].eligibility='expired';if(incomplete.page.kind==='gaps'){const g=incomplete.page.rows[0];g.coverage={...incomplete.current.coverage};g.competitorCount=count(1,2);g.status='incomplete_evidence';}accepts(incomplete);if(incomplete.page.kind==='gaps')incomplete.page.rows[0].status='confirmed_observed_gap';assert.equal(valid(incomplete,incomplete.filters,incomplete.navigation),false);
 const open=gap();open.asOf='2026-10-12T12:00:00Z';open.current.open=true;open.current.gaps.confirmedCandidates=0;if(open.page.kind==='gaps')open.page.rows[0].status='in_progress';accepts(open);
 const unfiltered=gap();unfiltered.filters.query=null;assert.equal(valid(unfiltered,unfiltered.filters,unfiltered.navigation),false);if(unfiltered.page.kind==='gaps')unfiltered.page.rows[0].matchingCompetitorCount={...unfiltered.page.rows[0].competitorCount};accepts(unfiltered);
});

test('matching evidence and all-base gap proof share strict record checks without conflating filters',()=>{
 const r=evidence();accepts(r);r.filters.query='does-not-match-retained-url';assert.equal(valid(r,r.filters,r.navigation),false);
 const all=evidence(true);all.filters.query='does-not-match-retained-url';accepts(all);
 rejects(()=>evidence(true),[(r)=>r.page.basis='matching',(r)=>r.page.rows[0].promptId=id(99),(r)=>r.page.rows[0].classification.ownership.brand=true,(r)=>r.page.rows[0].classification.ownership.competitorIds=[id(99)],(r)=>r.page.rows[0].executionId=id(99),(r)=>r.page.rows[0].model='fabricated-model',(r)=>r.page.rows[0].date='2026-10-11',(r)=>r.page.rows[0].retainedUrl='javascript:alert(1)']);
 const duplicate=evidence();if(duplicate.page.kind==='evidence'){duplicate.page.rows.push({...duplicate.page.rows[0],id:hash(99)});duplicate.totalRows=2;}assert.equal(valid(duplicate,duplicate.filters,duplicate.navigation),false,'Same retained annotation cannot be presented twice under different derived IDs');
 const two=evidence();if(two.page.kind==='evidence'){two.page.rows.push({...two.page.rows[0],id:hash(99),retainedCitationIndex:1,retainedTitle:''});two.totalRows=2;}accepts(two);
 const {productAttribution:_,...base}=filters,row=evidence().page.rows[0];assert.equal(validCitationEvidence(row,base,{period:'current',from:filters.from,to:filters.to,eligible:()=>true,competitorIds:[],applySourceFilters:false}),false,'Skipping source predicates never skips roster authority');
});

test('Reddit pages and prompt groups retain scoped representatives without inferring group identity',()=>{
 const pages=reddit();pages.navigation={view:'reddit_pages',period:'current',groupId:hash(4),gapPromptId:null,evidenceMode:null};pages.page={kind:'reddit_pages',rows:[{id:hash(8),urlId:hash(8),groupedUrl:'https://www.reddit.com/r/skin/comments/1',count:count(2,3),representative:rep(),newlyObserved:true}]};accepts(pages);
 const prompts=reddit();prompts.navigation={...pages.navigation,view:'prompts'};prompts.page={kind:'prompts',rows:[{promptId:id(30),representativeVersionId:id(31),promptPreview:'保留 🎉'.repeat(20),versionCount:2,count:count(2,3)}]};accepts(prompts);
 const unavailable=structuredClone(pages);unavailable.current.open=true;unavailable.asOf='2026-10-12T12:00:00Z';assert.equal(valid(unavailable,unavailable.filters,unavailable.navigation),false);if(unavailable.page.kind==='reddit_pages')unavailable.page.rows[0].newlyObserved=null;accepts(unavailable);
 prompts.navigation.groupId=prompts.unresolvedEvidence.redditCommunityId;assert.equal(valid(prompts,prompts.filters,prompts.navigation),false);
});

test('bounded pages, opaque cursors, malicious text, immutability and decoded payload cap',()=>{
 const r=shopping(),before=JSON.stringify(r);accepts(r);assert.equal(JSON.stringify(r),before);
 rejects(shopping,[(r)=>r.totalRows=2,(r)=>r.nextCursor='unexpected',(r)=>r.page.rows=new Array(1),(r)=>r.page.rows[0].label='\ud800',(r)=>r.page.rows[0].label='x'.repeat(2*1024*1024),(r)=>r.page.rows[0].currentRepresentative.retainedTitle='x'.repeat(2*1024*1024),(r)=>r.extra={private:'unrequested'}]);
 const paged=search();paged.current.google.search=count(2,51);paged.current.google.labelledSearch=count(2,51);paged.totalRows=51;paged.nextCursor='opaque_next';if(paged.page.kind==='search'){const first=paged.page.rows[0];paged.page.rows=Array.from({length:50},(_,i)=>({...first,id:hash(i+100),label:'query '+i,current:part(1),previous:part(0)}));}accepts(paged);
 if(paged.page.kind==='search')paged.page.rows=[{...paged.page.rows[0],id:hash(999)}];paged.nextCursor=null;assert.ok(valid(paged,paged.filters,paged.navigation,1));assert.equal(valid(paged,paged.filters,paged.navigation,0),false);
 assert.equal(valid(null),false);assert.equal(valid(Object.create(sample())),false);
});

test('known unresolved buckets retain exact counts and classify only their recorded source family',()=>{
 const r=evidence();r.navigation.groupId=r.unresolvedEvidence.googleWrapperId;r.current.google.wrappers=count(1);if(r.page.kind==='evidence'){const row=r.page.rows[0];row.retainedUrl='https://www.google.com/url?url=https%3A%2F%2Fpublisher.example.com';row.groupedUrl=row.retainedUrl;row.hostname='www.google.com';row.classification.sourceType='google_wrapper';}accepts(r);
 const wrongCount=structuredClone(r);wrongCount.current.google.wrappers=count(1,2);assert.equal(valid(wrongCount,wrongCount.filters,wrongCount.navigation),false);
 const wrongFamily=structuredClone(r);if(wrongFamily.page.kind==='evidence')wrongFamily.page.rows[0].classification.sourceType='google_search';assert.equal(valid(wrongFamily,wrongFamily.filters,wrongFamily.navigation),false);
 const inherited=structuredClone(r);if(inherited.page.kind==='evidence')inherited.page.rows[0].classification.ownership=Object.create(inherited.page.rows[0].classification.ownership);assert.equal(valid(inherited,inherited.filters,inherited.navigation),false);
 const over=sample();over.current.coverage={...coverage(1000),attempted:1001,expired:1};over.current.eligibleAnswers=1000;over.evidenceStates=Array.from({length:1001},(_,i)=>({id:id(i+100),period:'current',eligibility:i<1000?'eligible':'expired'}));assert.equal(valid(over),false);
});
