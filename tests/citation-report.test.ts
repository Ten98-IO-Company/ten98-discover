import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validCitationReport,validCitationFilters,citationSafeHref,citationPublishers,citationPageTypes,citationSources,citationOwners} from '../src/lib/citation-report.ts';
import type {CitationFilters,CitationNavigation,CitationReport} from '../src/server/prompt-citations.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(n:number)=>String(n).repeat(64);
const filters:CitationFilters={from:'2026-10-12',to:'2026-10-12',timeZone:'UTC',model:null,promptId:null,tag:null,urlGrouping:'retained-fragment-v1',query:null,publisherCategory:null,pageType:null,sourceType:null,ownership:null,entityId:null};
const navigation:CitationNavigation={view:'urls',period:null,urlId:null,domainId:null,changeKind:null};
const count=(n:number)=>({executions:n,annotations:n,prompts:n});
const coverage={attempted:1,eligible:1,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0};
const axes=(n:number)=>({ownership:citationOwners.map(key=>({key,count:count(key==='untracked'?n:0)})),publisher:citationPublishers.map(key=>({key,count:count(key==='other'?n:0)})),pageType:citationPageTypes.map(key=>({key,count:count(key==='other'?n:0)})),sourceType:citationSources.map(key=>({key,count:count(key==='publisher'?n:0)}))});
const summary=(date:string,n:number)=>({from:date,to:date,coverage:{...coverage},eligibleAnswers:1,citedExecutions:n,annotations:n,uniqueUrls:n,uniqueDomains:n,unclassifiedHostAnnotations:0});
const representative=(previous=false)=>({executionId:id(previous?2:1),comparisonId:id(3),retainedCitationIndex:0,retainedUrl:'https://source.example.com/retained',retainedTitle:null,requestedAt:`2026-10-${previous?'11':'12'}T12:00:00.000000Z`});
function sample(n=1):CitationReport {
  return {role:'viewer',filters:{...filters},navigation:{...navigation},asOf:'2026-10-13T12:00:00.000000Z',contextRevision:1,profileHash:hash(1),selectionRevision:hash(2),eligibilityVersion:'retained-nonempty-stop-v1',classifierVersion:'elmo-3c673d0-native-axes-v1',ownershipVersion:'citation-host-suffix-v1',googleDomainsVersion:'google-supported-2026-10-13-sha256-'+hash(3),label:'Retained citation observations classified using current project context',warnings:[],entities:[{id:'brand',label:'Example brand'}],current:summary(filters.from,n),previous:summary('2026-10-11',n),periodOpen:false,axes:{current:axes(n),previous:axes(n)},daily:[{date:'2026-10-11',period:'previous',summary:summary('2026-10-11',n),axes:axes(n)},{date:filters.from,period:'current',summary:summary(filters.from,n),axes:axes(n)}],evidenceStates:[{id:id(1),period:'current',eligibility:'eligible'},{id:id(2),period:'previous',eligibility:'eligible'}],changes:{status:'ready',countBasis:'annotation_occurrences',counts:{newly_observed:0,fewer_citations:0,not_observed_now:0,annotation_title_changed:0}},page:{kind:'urls',rows:n?[{id:hash(4),url:'https://source.example.com/retained',current:{count:count(1),axes:axes(1)},previous:{count:count(1),axes:axes(1)},currentRepresentative:representative(),previousRepresentative:representative(true)}]:[]},totalRows:n,nextCursor:null};
}
const valid=(r:unknown,n=navigation)=>validCitationReport(r,filters,n,0);

test('citation report accepts observed zeros, exact counts and all-nine category page',()=>{
  assert.ok(valid(sample()));assert.ok(valid(sample(0)));
  const r=sample(0);r.navigation.view='categories';r.page={kind:'categories',rows:citationPublishers.map(id=>({id,current:{count:count(0),axes:axes(0)},previous:{count:count(0),axes:axes(0)}}))};r.totalRows=9;
  assert.ok(valid(r,r.navigation));
  r.page.rows.pop();assert.equal(valid(r,r.navigation),false);
});

test('citation report rejects wrong scope, date coverage, missing manifest and resurrected page evidence',()=>{
  for(const mutate of [
    (r:any)=>{r.role='stranger';},(r:any)=>{r.filters.query='different';},(r:any)=>{r.current.eligibleAnswers=0;},
    (r:any)=>{r.daily[0].period='current';},(r:any)=>{r.daily[1].summary.coverage.attempted=2;},
    (r:any)=>{r.evidenceStates.pop();},(r:any)=>{r.evidenceStates[1].id=r.evidenceStates[0].id;},
    (r:any)=>{r.evidenceStates[0].eligibility='expired';},(r:any)=>{r.page.rows[0].currentRepresentative.executionId=id(99);},
    (r:any)=>{r.page.rows[0].currentRepresentative.requestedAt='2026-10-11T12:00:00.000000Z';},
    (r:any)=>{r.nextCursor='unexpected-page';},(r:any)=>{r.page.rows[0].current.count.prompts=2;},
  ]){const r=sample();mutate(r);assert.equal(valid(r),false);}
});

test('facet annotation partitions and per-day execution counts cannot contradict report totals',()=>{
  for(const mutate of [
    (r:any)=>{r.axes.current.publisher[0].count=count(1);},
    (r:any)=>{r.daily[1].axes.sourceType[0].count=count(0);},
    (r:any)=>{r.page.rows[0].previous.axes.ownership[0].count=count(0);},
    (r:any)=>{r.axes.current.publisher.reverse();},
  ]){const r=sample();mutate(r);assert.equal(valid(r),false);}
});

test('citation evidence requires eligible provenance and preserves hostile display text safely',()=>{
  const r=sample();r.navigation={view:'evidence',period:'current',urlId:hash(4),domainId:null,changeKind:null};
  const row={...representative(),id:hash(5),promptId:id(4),versionId:id(5),period:'current' as const,date:filters.from,model:'openai/gpt-4o-mini',retainedTitle:'<img src=x onerror=alert(1)> 🎉',urlId:hash(4),groupedUrl:'https://source.example.com/retained',hostname:'source.example.com',trackable:true,classification:{ownership:{brand:false,competitorIds:[],ambiguous:false},publisherCategory:'other' as const,publisherBasis:'elmo-automatic' as const,automaticPublisherCategory:'other' as const,pageType:'other' as const,pageTypeBasis:'elmo-url-title-heuristic-v1' as const,sourceType:'publisher' as const}};
  r.page={kind:'evidence',rows:[row]};assert.ok(valid(r,r.navigation));
  for(const mutate of [
    (e:any)=>{e.executionId=id(99);},(e:any)=>{e.retainedCitationIndex=100;},
    (e:any)=>{e.hostname='different.example.com';},(e:any)=>{e.classification.ownership.ambiguous=true;},
    (e:any)=>{e.classification.ownership.competitorIds=[id(99)];},
    (e:any)=>{e.retainedUrl='https://user:pass@source.example.com/retained';},
    (e:any)=>{e.trackable=false;},(e:any)=>{e.urlId=hash(6);},
  ]){const copy=structuredClone(r);mutate(copy.page.rows[0]);assert.equal(valid(copy,copy.navigation),false);}
});

test('change availability and descriptive thresholds reject invented disappearance',()=>{
  const r=sample();r.navigation={...navigation,view:'changes'};
  r.changes.counts.annotation_title_changed=1;
  r.page={kind:'changes',rows:[{id:hash(6),kind:'annotation_title_changed',target:'url',targetId:hash(4),label:'Retained URL',current:count(1),previous:count(1),before:{...representative(true),retainedTitle:'Earlier'},after:{...representative(),retainedTitle:'Later'}}]};
  assert.ok(valid(r,r.navigation));
  const same=structuredClone(r);if(same.page.kind==='changes')same.page.rows[0].after!.retainedTitle='Earlier';assert.equal(valid(same,same.navigation),false);
  const open=structuredClone(r);open.asOf='2026-10-12T12:00:00.000000Z';open.periodOpen=true;assert.equal(valid(open,open.navigation),false);
  const missing=structuredClone(r);missing.previous.coverage.eligible=0;missing.previous.coverage.expired=1;missing.previous.eligibleAnswers=null;assert.equal(valid(missing,missing.navigation),false);
});

test('citation client boundaries reject malformed filters and unsafe URL schemes',()=>{
  assert.ok(validCitationFilters(filters));
  for(const change of [{to:'2026-12-01'},{timeZone:'Not/AZone'},{query:'   '},{query:'x\0'},{tag:''},{ownership:'company'},{entityId:'foreign-id'},{extra:'unknown'}])assert.equal(validCitationFilters({...filters,...change}),false);
  for(const url of ['javascript:alert(1)','data:text/html,x','http://source.example.com','https://user@source.example.com','https://source.example.com/\ud800'])assert.equal(citationSafeHref(url),null);
  assert.equal(citationSafeHref('https://source.example.com/a?x=1#part'),'https://source.example.com/a?x=1#part');
});
