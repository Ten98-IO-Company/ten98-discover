import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {aiQueryFilters,aiQueryRange,aiQueryReportSchema} from '../src/lib/ai-search-analysis.ts';
import {aiSearchProfileId} from '../src/lib/ai-search.ts';
import {aggregateAiSearchQueries,AiQueryCapacityError,AiQueryDataError,type AiQueryInput} from '../src/server/ai-search-analysis.ts';
import {normalizeDfsChatgptSearchEvidence} from '../src/server/ai-search-evidence.ts';

const filters=aiQueryFilters(new URLSearchParams()),brand={id:'brand' as const,name:'Acme',aliases:[],domains:[]},promptId=randomUUID(),versionId=randomUUID();
function row(raw:unknown,prompt='Original prompt'):AiQueryInput{return {id:randomUUID(),promptId,versionId,requestedAt:'2026-10-15T12:00:00.123456Z',status:'completed',rawState:'retained',capturedPrompt:prompt,result:{profileId:aiSearchProfileId,source:'DataForSEO / ChatGPT consumer interface',capturedPrompt:prompt,locationCode:2840,languageCode:'en',forceWebSearch:true,reportedModel:null,providerObservedAt:null,receivedAt:'2026-10-15T12:00:00Z',evidence:normalizeDfsChatgptSearchEvidence(raw)}};}
const aggregate=(rows:AiQueryInput[],extra:Partial<typeof filters>={})=>aggregateAiSearchQueries(rows,{...filters,...extra},brand);
test('distinct query votes and independent associated-answer denominators retain the golden A/B/C/D case',()=>{
 const rows=[row({markdown:'Acme answer',fan_out_queries:['q1','q1','q2']}),row({markdown:'Another answer',fan_out_queries:['q1']}),row({fan_out_queries:['q1']})],report=aggregate(rows);
 const q1=report.topQueries.find(q=>q.key==='q1')!,q2=report.topQueries.find(q=>q.key==='q2')!;
 assert.deepEqual([q1.observations,q1.eligibleAnswers,q1.mentions,q2.observations,q2.eligibleAnswers,q2.mentions],[3,2,1,1,1,1]);
 assert.deepEqual(report.totals.queryWeightedMentions,{numerator:2,denominator:3,value:2/3});assert.deepEqual(report.totals.answerMentions,{numerator:1,denominator:2,value:1/2});assert.deepEqual(report.totals.averageFanout,{numerator:4,denominator:3,value:4/3});
 const fourth=aggregate([...rows,row({markdown:'Acme without queries'})]);assert.deepEqual(fourth.totals.queryWeightedMentions,report.totals.queryWeightedMentions);assert.deepEqual(fourth.totals.answerMentions,{numerator:2,denominator:3,value:2/3});assert.equal(fourth.coverage.queries.not_recorded,1);
 assert.equal(fourth.captures[2].brandMention,null);assert.equal(fourth.captures[1].brandMention,false);assert.equal(new Set(q1.runIds).size,3);
 const full={role:'viewer',projectId:randomUUID(),profileId:aiSearchProfileId,asOf:'2026-10-15T12:00:00Z',resolvedRange:aiQueryRange(filters,new Date('2026-10-15T12:00:00Z')),filters,contextRevision:1,profileHash:'a'.repeat(64),selectionRevision:'b'.repeat(64),label:'Recomputed from retained captures using current brand context',warnings:[],brand,...report};assert.ok(aiQueryReportSchema.safeParse(full).success);
 for(const corrupt of [(r:typeof full)=>{r.coverage.raw.expired++;},(r:typeof full)=>{r.topQueries[0].runIds.push(randomUUID());},(r:typeof full)=>{r.topQueries[0].rate.denominator++;},(r:typeof full)=>{r.captures[2].brandMention=false;}]){const changed=structuredClone(full);corrupt(changed);assert.equal(aiQueryReportSchema.safeParse(changed).success,false);}
});
test('prompt variations cannot borrow another immutable prompt version’s valid query rows',()=>{
 const first=row({markdown:'Acme answer',fan_out_queries:['first query']}),second=row({markdown:'Other answer',fan_out_queries:['second query']});second.promptId=randomUUID();second.versionId=randomUUID();
 const report={role:'viewer',projectId:randomUUID(),profileId:aiSearchProfileId,asOf:'2026-10-15T12:00:00Z',resolvedRange:aiQueryRange(filters,new Date('2026-10-15T12:00:00Z')),filters,contextRevision:1,profileHash:'a'.repeat(64),selectionRevision:'b'.repeat(64),label:'Recomputed from retained captures using current brand context',warnings:[],brand,...aggregate([first,second])};
 assert.ok(aiQueryReportSchema.safeParse(report).success);
 [report.byPromptVersion[0].variations,report.byPromptVersion[1].variations]=[report.byPromptVersion[1].variations,report.byPromptVersion[0].variations];
 assert.equal(aiQueryReportSchema.safeParse(report).success,false);
});
test('coverage axes reconcile expired, invalid envelopes, missing/empty fields and echo-only reports without false zero rates',()=>{
 const rows=[row({fan_out_queries:[]}),row({markdown:'',fan_out_queries:[' Original prompt ',' ']}),row({markdown:'Acme',fan_out_queries:42}),row({})];
 rows.push({...row({}),rawState:'expired',capturedPrompt:null,result:null},{...row({}),rawState:'invalid',capturedPrompt:null,result:null},{...row({}),status:'queued',rawState:'not_recorded',capturedPrompt:'Original prompt',result:null});
 const r=aggregate(rows);for(const axis of ['lifecycle','raw','queries','answers'] as const)assert.equal(Object.values(r.coverage[axis]).reduce((a,b)=>a+b,0),7);
 assert.equal(r.coverage.queries.raw_unavailable,3);assert.equal(r.coverage.queries.reported_empty,1);assert.equal(r.coverage.queries.invalid,1);assert.equal(r.totals.reportedArrays,2);assert.equal(r.totals.reportedWithoutFanout,2);assert.equal(r.totals.blankEntries,1);assert.equal(r.totals.echoEntries,1);assert.equal(r.totals.averageFanout.value,null);assert.equal(r.totals.queryWeightedMentions.value,null);assert.equal(r.totals.answerMentions.value,1);
 assert.deepEqual(r.websiteContentCoverage,{state:'unavailable',reason:'body_corpus_not_recorded'});
});
test('immutable prompt versions, literal queries and exact word votes reuse the leaf rather than current wording',()=>{
 const a=row({markdown:'Other answer',fan_out_queries:['red red boots','red red boots','best shoes reviews']},'best red red shoes'),r=aggregate([a]);
 assert.equal(r.words.cloud.rows.find(w=>w.word==='red')!.count,2);assert.equal(r.words.preserved.rows.find(w=>w.word==='red')!.count,1);assert.equal(r.words.dropped.rows.find(w=>w.word==='red')!.count,1);assert.equal(r.words.denominator,2);
 const b=row({fan_out_queries:['unavailable','C++ %20 +','c++ %20 +','C++  %20 +','鞋子']});b.versionId=randomUUID();const mixed=aggregate([a,b]);assert.equal(mixed.byPromptVersion.length,2);assert.equal(mixed.totals.queryInstances,6);assert.equal(mixed.topQueries.find(q=>q.key==='鞋子')!.observations,1);assert.ok(mixed.topQueries.some(q=>q.key==='unavailable'));
 assert.throws(()=>aggregate([a,{...a,id:randomUUID(),capturedPrompt:'Contradiction',result:{...a.result!,capturedPrompt:'Contradiction'}}]),AiQueryDataError);
});
test('repeated independent captures preserve exact word votes and leave retained evidence unchanged',()=>{
 const rows=Array.from({length:3},()=>row({markdown:'Other answer',fan_out_queries:['red red boots','red red boots','best shoes reviews']},'best red red shoes')),before=structuredClone(rows),report=aggregate(rows);
 assert.equal(report.words.cloud.rows.find(w=>w.word==='red')!.count,6);assert.equal(report.words.preserved.rows.find(w=>w.word==='red')!.count,3);assert.equal(report.words.dropped.rows.find(w=>w.word==='red')!.count,3);assert.equal(report.words.denominator,6);
 assert.equal(report.totals.queryInstances,6);assert.equal(report.totals.uniqueQueries,2);assert.deepEqual(report.totals.averageFanout,{numerator:6,denominator:3,value:2});assert.equal(report.topQueries.find(q=>q.key==='red red boots')!.observations,3);
 assert.deepEqual(rows,before);assert.deepEqual(aggregate(rows),report);assert.deepEqual(rows,before);
});
test('full population counts precede all ranking caps and typed model filters expose excluded coverage',()=>{
 const a=row({markdown:'Acme',fan_out_queries:Array.from({length:30},(_,i)=>'query '+String(i).padStart(2,'0'))}),b=row({markdown:'Other',fan_out_queries:['query 00']});a.result!.reportedModel='not_recorded';
 const r=aggregate([a,b]);assert.equal(r.topQueries.length,25);assert.equal(r.topByRuns.length,20);assert.equal(r.byPromptVersion[0].returned,10);assert.equal(r.totals.uniqueQueries,30);assert.equal(r.totals.queryInstances,31);
 const only=aggregate([a,b],{reportedModel:{state:'reported',value:'not_recorded'}});assert.equal(only.coverageBeforeModel.attempted,2);assert.equal(only.coverage.attempted,1);assert.equal(only.totals.queryInstances,30);
 const unknown=aggregate([a,b],{reportedModel:{state:'not_recorded'}});assert.equal(unknown.totals.queryInstances,1);assert.equal(unknown.totals.answerMentions.value,0);assert.equal(unknown.byModel[0].reportedModel,null);
 assert.equal(aggregate([a],{promptId}).byPromptVersion[0].returned,30);
});
test('strict unique filters, canonical nullable model identity and calendar lookbacks include leap boundaries and truthful All',()=>{
 for(const q of ['lookback=1m&lookback=1y','other=x','versionId='+versionId,'tag=%20x','reportedModel=null','reportedModel=%7B%22state%22%3A%20%22not_recorded%22%7D','timeZone=UTC%0A','model=x'])assert.throws(()=>aiQueryFilters(new URLSearchParams(q)),q);
 const f=aiQueryFilters(new URLSearchParams({reportedModel:JSON.stringify({state:'reported',value:'not_recorded'}),promptId,versionId}));assert.deepEqual(f.reportedModel,{state:'reported',value:'not_recorded'});
 assert.deepEqual(aiQueryRange({...filters,lookback:'1y'},new Date('2024-03-01T12:00:00Z')),{from:'2023-03-01',to:'2024-03-01',timeZone:'UTC'});
 assert.equal((Date.parse('2024-03-01')-Date.parse('2023-03-01'))/86400000+1,367);
 assert.equal(aiQueryRange({...filters,lookback:'1m'},new Date('2024-03-31T12:00:00Z')).from,'2024-02-29');assert.equal(aiQueryRange({...filters,lookback:'all'},new Date('2024-03-31T12:00:00Z')).from,null);
 assert.equal(aiQueryRange({...filters,timeZone:'America/Los_Angeles',lookback:'1w'},new Date('2024-03-10T07:30:00Z')).to,'2024-03-09');
});
test('capacity refusal and unavailable results never become a sampled successful report',()=>{
 const base=row({markdown:'x'.repeat(250000),fan_out_queries:['query']});assert.throws(()=>aggregate(Array.from({length:1001},()=>({...base,id:randomUUID()}))),AiQueryCapacityError);
 assert.throws(()=>aggregate(Array.from({length:401},()=>({...base,id:randomUUID()}))),AiQueryCapacityError);
 const manyWords=row({fan_out_queries:Array.from({length:100},(_,i)=>Array.from({length:200},(_,j)=>'w'+String(i*200+j).padStart(5,'0')).join(' '))});assert.throws(()=>aggregate([manyWords]),AiQueryCapacityError);
 assert.throws(()=>aggregate([base,base]),AiQueryDataError);assert.throws(()=>aggregate([{...base,rawState:'expired'}]),AiQueryDataError);
 const empty=aggregate([]);assert.equal(empty.coverage.attempted,0);assert.equal(empty.totals.answerMentions.value,null);assert.equal(empty.totals.averageFanout.value,null);assert.deepEqual(empty.words.cloud.rows,[]);
});
