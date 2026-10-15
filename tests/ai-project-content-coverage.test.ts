import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {aiQueryFilters} from '../src/lib/ai-search-analysis.ts';
import {aiSearchProfileId} from '../src/lib/ai-search.ts';
import {projectContentCoverageInputSchema,projectContentCoverageReportSchema,readProjectContentCoverageReport,projectContentQueryLimit} from '../src/lib/ai-content-coverage.ts';
import {calculateLiteralCoverage,calculateProjectLiteralCoverage,ContentCoverageCapacityError,type ContentPage} from '../src/server/ai-content-coverage.ts';
import {aggregateAiSearchQueryPopulation,AiQueryCapacityError,type AiQueryInput} from '../src/server/ai-search-analysis.ts';
import {normalizeDfsChatgptSearchEvidence} from '../src/server/ai-search-evidence.ts';

const id=(n:number)=>'10000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),at='2026-10-15T12:00:00.000Z';
const filters=aiQueryFilters(new URLSearchParams({lookback:'all',timeZone:'UTC'})),brand={id:'brand' as const,name:'Acme',aliases:[],domains:['acme.test']};
const input={filters,expectedSelectionRevision:'a'.repeat(64),auditRunId:id(3),pages:{coverage:null,resourceKind:'html' as const,search:'',searchIn:'url' as const,sort:'url' as const,order:'asc' as const,expectedSelectionRevision:'b'.repeat(64)}};
function capture(n:number,queries:unknown,versionId=id(2),model:string|null=null):AiQueryInput{
 return {id:id(n),promptId:id(1),versionId,requestedAt:at,status:'completed',rawState:'retained',capturedPrompt:'Original prompt',result:{profileId:aiSearchProfileId,source:'DataForSEO / ChatGPT consumer interface',capturedPrompt:'Original prompt',locationCode:2840,languageCode:'en',forceWebSearch:true,reportedModel:model,providerObservedAt:null,receivedAt:at,evidence:normalizeDfsChatgptSearchEvidence({markdown:n===10?'Acme answer':'Other answer',fan_out_queries:queries})}};
}
function page(n:number,text:string|null,state:ContentPage['state']=text===null?'not_recorded':text===''?'empty':'available'):ContentPage{
 return {id:id(n),url:'https://acme.test/'+n,observedAt:at,state,extractionVersion:text===null?null:'static-dom-body-v1',bodySha256:text===null?null:createHash('sha256').update(text).digest('hex'),text};
}
// Explicit pure fixture built from the production aggregate and shared matcher.
// This is not a database, authorization, native API or receipt-race acceptance.
function report(rows:AiQueryInput[],pages:ContentPage[],applied=input){
 const aggregate=aggregateAiSearchQueryPopulation(rows,applied.filters,brand,projectContentQueryLimit),{versions,coverageBeforeModel,coverage,totals,captures}=aggregate.report;
 const population=totals.reportedArrays?'reported':coverage.attempted===0?'empty_selection':'unavailable',calculated=calculateProjectLiteralCoverage(population==='unavailable'?null:aggregate.completeQueries,pages);
 return {version:'ai-project-content-literal-v1',role:'viewer',projectId:id(4),snapshotAt:at,asOf:at,applied,queryReceiptHash:'c'.repeat(64),corpusReceiptHash:'d'.repeat(64),querySource:{profileId:aiSearchProfileId,asOf:at,resolvedRange:{from:null,to:'2026-10-15',timeZone:'UTC'},contextRevision:1,profileHash:'e'.repeat(64),selectionRevision:applied.expectedSelectionRevision,versions,label:'Recomputed from retained captures using current brand context',warnings:[],brand,coverageBeforeModel,coverage,totals,captures},audit:{id:applied.auditRunId,origin:'https://acme.test',currentProjectOrigin:'https://acme.test',status:'completed',completedAt:at,retainBodyText:true,mode:'static',startPath:'/',maxPages:1000,coverage:{reasons:[],discoveryComplete:true,linksComplete:true,scopeExclusions:0,rawEvidenceRecorded:true},observationRange:{from:pages.length?at:null,to:pages.length?at:null}},policy:{revision:1,rawProviderEvidenceDays:90,derivedHistoryDays:365},...calculated,queryPopulation:population,rows:calculated.rows?.map(row=>({...row,examples:row.examples.map(ref=>({...ref,auditRunId:applied.auditRunId}))}))??null};
}

test('complete project rows cover keys outside top25 and all selected pages with real multi-version contributors',()=>{
 const rows=[capture(10,Array.from({length:30},(_,i)=>'query '+String(i).padStart(2,'0'))),capture(11,['QUERY 29','query 29'],id(20))],pages=Array.from({length:65},(_,i)=>page(100+i,i===64?'query 28 and query 29':'unrelated body')),before=structuredClone({rows,pages});
 const value=report(rows,pages),parsed=readProjectContentCoverageReport(value,id(4),input);
 assert.equal(parsed.rows!.length,30);assert.equal(parsed.pageCoverage.selected,65);assert.equal(parsed.rows!.find(row=>row.query.key==='query 28')!.examples[0].id,id(164));
 const repeated=parsed.rows!.find(row=>row.query.key==='query 29')!;assert.deepEqual(repeated.query.runIds,[id(10),id(11)]);assert.deepEqual(repeated.query.promptRefs,[{promptId:id(1),versionId:id(2),observations:1},{promptId:id(1),versionId:id(20),observations:1}]);
 assert.equal(Object.hasOwn(repeated,'firstIndex'),false);assert.equal(Object.hasOwn(repeated,'indexes'),false);assert.deepEqual(repeated.query.rate,{numerator:1,denominator:2,value:0.5});assert.deepEqual(parsed.rate,{numerator:2,denominator:30,value:2/30});
 assert.deepEqual(parsed.querySource.totals.answerMentions,{numerator:1,denominator:2,value:0.5});assert.equal(JSON.stringify(parsed).includes('unrelated body'),false);assert.equal(JSON.stringify(parsed).includes('Acme answer'),false);assert.deepEqual({rows,pages},before);
 const single=calculateLiteralCoverage([{key:'query 28',firstIndex:0,indexes:[0]}],pages),project=calculateProjectLiteralCoverage([repeated.query],pages);
 assert.deepEqual(single.pageCoverage,project.pageCoverage);assert.equal(single.rows![0].matchedPageCount,project.rows![0].matchedPageCount);assert.equal(single.work,project.work);
});

test('strict applied filters preserve typed model identity, canonical scope and independent empty/unknown axes',()=>{
 const canonical=projectContentCoverageInputSchema.parse({...input,filters:{...filters,timeZone:'US/Pacific',reportedModel:{state:'reported',value:'not_recorded'}}});assert.equal(canonical.filters.timeZone,'America/Los_Angeles');assert.deepEqual(canonical.filters.reportedModel,{state:'reported',value:'not_recorded'});
 for(const value of [{...input,filters:{...filters,extra:true}},{...input,filters:{...filters,versionId:id(2)}},{...input,filters:{...filters,timeZone:'bad'}},{...input,filters:{...filters,reportedModel:'not_recorded'}},{...input,pages:{...input.pages,resourceKind:'image'}},{...input,expectedSelectionRevision:'bad'}])assert.equal(projectContentCoverageInputSchema.safeParse(value).success,false);
 const unavailable={...capture(10,[]),rawState:'expired' as const,result:null,capturedPrompt:null};
 const cases=[{rows:[],population:'empty_selection',rate:{numerator:0,denominator:0,value:null}},{rows:[capture(10,[])],population:'reported',rate:{numerator:0,denominator:0,value:null}},{rows:[unavailable],population:'unavailable',rate:{numerator:null,denominator:null,value:null}},{rows:[capture(10,['cost'])],population:'reported',rate:{numerator:0,denominator:1,value:0}}];
 for(const c of cases){const value=projectContentCoverageReportSchema.parse(report(c.rows,[page(100,'')]));assert.equal(value.queryPopulation,c.population);assert.deepEqual(value.rate,c.rate);assert.equal(value.rows===null,c.population==='unavailable');}
 const unreadable=projectContentCoverageReportSchema.parse(report([capture(10,['cost'])],[page(100,null)]));assert.equal(unreadable.rows![0].state,'not_assessed');assert.deepEqual(unreadable.rate,{numerator:0,denominator:0,value:null});
 const mixed=projectContentCoverageReportSchema.parse(report([capture(10,['cost']),{...unavailable,id:id(11)}],[page(100,'cost')]));assert.equal(mixed.querySource.coverage.raw.expired,1);assert.deepEqual(mixed.rate,{numerator:1,denominator:1,value:1});
});

test('project reader rejects foreign contributors, stale selections, invented counts and body-bearing examples',()=>{
 const response=report([capture(10,['cost']),capture(11,['cost'],id(20))],[page(100,'cost')]);assert.equal(projectContentCoverageReportSchema.safeParse(response).success,true);
 const changes=[(r:any)=>r.querySource.selectionRevision='f'.repeat(64),(r:any)=>r.rows[0].query.runIds=[id(900)],(r:any)=>r.rows[0].query.promptRefs[0].versionId=id(901),(r:any)=>r.rows[0].query.runIds.push(id(10)),(r:any)=>r.rows[0].query.rate.value=1,(r:any)=>r.rows[0].examples[0].auditRunId=id(902),(r:any)=>r.rows[0].examples[0].text='cost',(r:any)=>r.rows[0].matchedPageCount=2,(r:any)=>r.pageCoverage.readable=0,(r:any)=>r.rate.denominator=2,(r:any)=>r.querySource.coverage.raw.retained=1,(r:any)=>r.querySource.totals.uniqueQueries=2,(r:any)=>r.rows.push(structuredClone(r.rows[0])),(r:any)=>r.querySource.asOf='2026-10-16T12:00:00.000Z',(r:any)=>r.queryPopulation='unavailable'];
 for(const change of changes){const value=structuredClone(response);change(value);assert.equal(projectContentCoverageReportSchema.safeParse(value).success,false);}
 assert.throws(()=>readProjectContentCoverageReport(response,id(999),input));assert.throws(()=>readProjectContentCoverageReport(response,id(4),{...input,filters:{...filters,lookback:'1w'}}));
});

test('2000-key project ceiling and 100-million-work ceiling refuse whole results and retain C1 limits',()=>{
 const rows=Array.from({length:20},(_,n)=>capture(10+n,Array.from({length:100},(_,i)=>'query '+String(100*n+i).padStart(4,'0')))),aggregate=aggregateAiSearchQueryPopulation(rows,filters,brand,2000);
 assert.equal(aggregate.completeQueries.length,2000);const complete=readProjectContentCoverageReport(report(rows,[page(100,'')]),id(4),input);assert.equal(complete.rows!.length,2000);assert.equal(complete.rate.denominator,2000);
 const over=[...rows,capture(40,['one extra key'])];assert.throws(()=>aggregateAiSearchQueryPopulation(over,filters,brand,2000),AiQueryCapacityError);assert.equal(aggregateAiSearchQueryPopulation(over,filters,brand).completeQueries.length,2001);
 assert.throws(()=>calculateProjectLiteralCoverage([...aggregate.completeQueries,aggregateAiSearchQueryPopulation([capture(40,['extra'])],filters,brand).completeQueries[0]],[]),ContentCoverageCapacityError);
 assert.equal(calculateProjectLiteralCoverage(aggregate.completeQueries,[page(100,'x'.repeat(50000))]).work,100_000_000);assert.throws(()=>calculateProjectLiteralCoverage(aggregate.completeQueries,[page(100,'x'.repeat(50001))]),ContentCoverageCapacityError);
 assert.throws(()=>calculateLiteralCoverage(Array.from({length:101},(_,i)=>({key:'query '+i,firstIndex:i,indexes:[i]})),[]),ContentCoverageCapacityError);
 assert.throws(()=>calculateProjectLiteralCoverage(aggregate.completeQueries,[page(100,'x')],()=>{throw Error('cancelled');}),/cancelled/);
 const longRows=Array.from({length:10},(_,n)=>capture(10+n,Array.from({length:100},(_,i)=>String(n*100+i).padStart(6,'0')+'x'.repeat(1994)))),tooLarge=report(longRows,[page(100,'')]);assert.ok(Buffer.byteLength(JSON.stringify(tooLarge))>2*1024*1024);assert.throws(()=>readProjectContentCoverageReport(tooLarge,id(4),input),/does not match/);
 assert.equal(readProjectContentCoverageReport(report([capture(10,['cost'])],[page(100,'cost')]),id(4),input).rows!.length,1);
});
