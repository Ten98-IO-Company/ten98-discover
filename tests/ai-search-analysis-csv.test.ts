import test from 'node:test';
import assert from 'node:assert/strict';
import {aiQueryFilters,aiQueryRange,aiQueryReportSchema,type AiQueryReport} from '../src/lib/ai-search-analysis.ts';
import {aiSearchProfileId} from '../src/lib/ai-search.ts';
import {aggregateAiSearchQueries,type AiQueryInput} from '../src/server/ai-search-analysis.ts';
import {normalizeDfsChatgptSearchEvidence} from '../src/server/ai-search-evidence.ts';
import {aiSearchAnalysisCsv} from '../src/lib/ai-search-analysis-csv.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function report():AiQueryReport{
 const filters=aiQueryFilters(new URLSearchParams()),brand={id:'brand' as const,name:'Acme',aliases:[],domains:[]},prompt='Original prompt';
 const rows:AiQueryInput[]=[{id:id(4),promptId:id(2),versionId:id(3),requestedAt:'2026-10-15T12:00:00Z',status:'completed',rawState:'retained',capturedPrompt:prompt,result:{profileId:aiSearchProfileId,source:'DataForSEO / ChatGPT consumer interface',capturedPrompt:prompt,locationCode:2840,languageCode:'en',forceWebSearch:true,reportedModel:null,providerObservedAt:null,receivedAt:'2026-10-15T12:00:00Z',evidence:normalizeDfsChatgptSearchEvidence({fan_out_queries:Array.from({length:30},(_,i)=>'query '+i)})}}];
 return aiQueryReportSchema.parse({role:'viewer',projectId:id(1),profileId:aiSearchProfileId,asOf:'2026-10-15T12:00:00Z',resolvedRange:aiQueryRange(filters,new Date('2026-10-15T12:00:00Z')),filters,contextRevision:1,profileHash:'a'.repeat(64),selectionRevision:'b'.repeat(64),label:'Recomputed from retained captures using current brand context',warnings:['Retained evidence only'],brand,...aggregateAiSearchQueries(rows,filters,brand)});
}
test('complete strict report exports safe CSV, unavailable versus zero, associations and full-population caps',()=>{
 const value=report();value.brand.aliases=['  =SUM(1,2)','\ttext','"quoted",\r\n鞋子','+cmd','-cmd','@cmd'];const csv=aiSearchAnalysisCsv(value);assert.ok(csv.startsWith('section,field,type,value\r\n'));assert.ok(csv.includes('brand,aliases[0],string,"\'  =SUM(1,2)"\r\n'));assert.ok(csv.includes("brand,aliases[1],string,'\ttext\r\n"));assert.ok(csv.includes('brand,aliases[2],string,"""quoted"",\r\n鞋子"\r\n'));for(const item of ['+cmd','-cmd','@cmd'])assert.ok(csv.includes("string,'"+item+'\r\n'));assert.ok(csv.includes('answerMentions.numerator,number,0'));assert.ok(csv.includes('answerMentions.value,unavailable,Unavailable'));assert.ok(csv.includes('List limits,topQueries,30,25,25\r\n'));assert.ok(csv.includes('Capture states,'+id(4)));assert.ok(csv.includes('websiteContentCoverage,reason,string,body_corpus_not_recorded'));assert.ok(csv.includes('selectionRevision,,string,'+'b'.repeat(64)));assert.ok(csv.includes('Returned queries,topQueries'));assert.ok(csv.includes('Word limits,cloud,'));assert.ok(csv.includes('Reported model'));assert.throws(()=>aiSearchAnalysisCsv({...value,rawAnswer:'private'}));
});
test('8 MiB UTF-8 output ceiling refuses a whole valid report rather than truncating',()=>{
 const value=report(),query=value.topQueries[0],rows=Array.from({length:2000},(_,i)=>({...query,key:String(i)+'鞋'.repeat(1300)}));value.topQueries=rows;value.totals.uniqueQueries=2000;value.totals.queryInstances=2000;value.totals.averageFanout={numerator:2000,denominator:1,value:2000};value.words.denominator=2000;value.byPromptVersion[0].totals=structuredClone(value.totals);value.byPromptVersion[0].variations=rows;value.byPromptVersion[0].returned=2000;value.byModel[0].totals=structuredClone(value.totals);assert.ok(aiQueryReportSchema.safeParse(value).success);assert.throws(()=>aiSearchAnalysisCsv(value),/complete analysis CSV exceeds 8 MiB/);
});
