import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {aiQueryFilters} from '../src/lib/ai-search-analysis.ts';
import {aiSearchPriceEvidence,aiSearchProfileId,aiSearchSnapshotSchema} from '../src/lib/ai-search.ts';
import {aggregateAiSearchQueries,aggregateAiSearchQueryPopulation,AiQueryCapacityError,type AiQueryInput} from '../src/server/ai-search-analysis.ts';
import {readAiSearchAnalysisPopulation} from '../src/server/ai-search.ts';
import {normalizeDfsChatgptSearchEvidence} from '../src/server/ai-search-evidence.ts';
import {canonicalHash} from '../src/server/context-input.ts';

const id=(n:number)=>'10000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const at='2026-10-15T12:00:00.000Z',brand={id:'brand' as const,name:'Acme',aliases:[],domains:['acme.test']};
const filters=aiQueryFilters(new URLSearchParams({lookback:'all',timeZone:'UTC'}));
function capture(n:number,queries:unknown,model:string|null=null,versionId=id(2)):AiQueryInput{
 return {id:id(n),promptId:id(1),versionId,requestedAt:at,status:'completed',rawState:'retained',capturedPrompt:'Original prompt',result:{profileId:aiSearchProfileId,source:'DataForSEO / ChatGPT consumer interface',capturedPrompt:'Original prompt',locationCode:2840,languageCode:'en',forceWebSearch:true,reportedModel:model,providerObservedAt:null,receivedAt:at,evidence:normalizeDfsChatgptSearchEvidence({markdown:n===10?'Acme answer':'Other answer',fan_out_queries:queries})}};
}

test('complete query rows retain outside-top25 keys and real multi-version contributors without changing the public report',()=>{
 const rows=[capture(10,Array.from({length:30},(_,i)=>'query '+String(i).padStart(2,'0')),'not_recorded'),capture(11,['QUERY 29','query 29','query 00'],null,id(3))],before=structuredClone(rows);
 const {report,completeQueries}=aggregateAiSearchQueryPopulation(rows,filters,brand);
 assert.deepEqual(report,aggregateAiSearchQueries(rows,filters,brand));assert.equal(Object.hasOwn(report,'completeQueries'),false);assert.equal(completeQueries.length,30);assert.equal(report.topQueries.length,25);assert.equal(report.topByRuns.length,20);assert.ok(!report.topQueries.some(q=>q.key==='query 28'));
 assert.equal(completeQueries.find(q=>q.key==='query 28')!.observations,1);const repeated=completeQueries.find(q=>q.key==='query 29')!;
 assert.deepEqual(repeated.runIds,[id(10),id(11)]);assert.equal(repeated.observations,2);assert.equal(repeated.versionCount,2);assert.equal(repeated.distinctPromptCount,1);assert.deepEqual(repeated.promptRefs,[{promptId:id(1),versionId:id(2),observations:1},{promptId:id(1),versionId:id(3),observations:1}]);assert.deepEqual(repeated.rate,{numerator:1,denominator:2,value:0.5});
 assert.equal(report.totals.queryInstances,32);assert.equal(report.totals.uniqueQueries,30);assert.deepEqual(rows,before);
});

test('complete population keeps typed model filtering and unknown/empty source axes separate, after pre-model capacity',()=>{
 const rows=[capture(10,['a'],'not_recorded'),capture(11,['b']),capture(12,[]),{...capture(13,[]),rawState:'expired' as const,result:null,capturedPrompt:null}];
 const reported=aggregateAiSearchQueryPopulation(rows,{...filters,reportedModel:{state:'reported',value:'not_recorded'}},brand);
 assert.equal(reported.report.coverageBeforeModel.attempted,4);assert.equal(reported.report.coverage.attempted,1);assert.deepEqual(reported.completeQueries.map(q=>q.key),['a']);
 const unknown=aggregateAiSearchQueryPopulation(rows,{...filters,reportedModel:{state:'not_recorded'}},brand);
 assert.equal(unknown.report.coverage.attempted,3);assert.equal(unknown.report.coverage.queries.reported_empty,1);assert.equal(unknown.report.coverage.queries.raw_unavailable,1);assert.deepEqual(unknown.completeQueries.map(q=>q.key),['b']);assert.equal(unknown.report.captures.find(c=>c.runId===id(13))!.brandMention,null);
 assert.throws(()=>aggregateAiSearchQueryPopulation(Array.from({length:1001},(_,i)=>({...rows[0],id:id(100+i)})),{...filters,reportedModel:{state:'reported',value:'excluded'}},brand),AiQueryCapacityError);
});

const input=aiSearchSnapshotSchema.parse({version:1,request:{profileId:aiSearchProfileId,capturedPrompt:'Original prompt',locationCode:2840,languageCode:'en'},promptId:id(1),versionId:id(2),maxSpendUsd:'0.004000',country:{code:2840,name:'United States',countryCode:'US'},language:{code:'en',name:'English'},catalogRevision:'a'.repeat(64),countriesHash:'b'.repeat(64),languagesHash:'c'.repeat(64),preparedAt:at,price:aiSearchPriceEvidence()});
const stored={id:id(10),quote_id:id(20),prompt_id:id(1),version_id:id(2),status:'completed',requested_at:at,user_tags:['current'],input_hash:canonicalHash(input),expired:false,quote_created_at:at,raw_expired_at:null,input_purged_at:null,result_purged_at:null,input,result:capture(10,['query']).result,input_fingerprint:'d'.repeat(64),result_hash:'e'.repeat(64)};
const project={id:id(30),workspace_id:id(31),role:'viewer' as const};
// Offline query-boundary double only: actual SQL, locking and authorization need
// the separately approved fresh-PostgreSQL gate; this never opens a database.
function client(bounds={n:1,bytes:'1024'}){
 const calls:{sql:string;values:unknown[]}[]=[];
 const query=async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});assert.match(sql,/^SELECT /);assert.equal(values.length,Math.max(0,...Array.from(sql.matchAll(/\$(\d+)/g),m=>Number(m[1]))));
  if(sql.startsWith('SELECT 1 FROM pg_timezone_names')||sql.startsWith('SELECT 1 FROM project_prompt'))return {rows:[{}],rowCount:1};
  if(sql==='SELECT name,origin FROM project WHERE id=$1')return {rows:[{name:'Acme',origin:'https://acme.test'}]};
  if(sql.includes('FROM project_context WHERE project_id=$1'))return {rows:[{revision:7,...brand,citationDomains:[],citationCategoryOverrides:[]}]};
  if(sql==='SELECT clock_timestamp() AS at')return {rows:[{at:new Date(at)}]};
  if(sql.startsWith('SELECT count(*)::int AS n'))return {rows:[bounds]};
  if(sql.startsWith('SELECT r.id,q.id AS quote_id'))return {rows:[{...structuredClone(stored),...values[8]===false?{input:null,result:null}:{}}]};
  assert.fail('Unexpected population read');
 };
 return {db:{query} as unknown as PoolClient,calls};
}

test('same-client population binds current filters and preserves metadata-only selection/receipts without materializing raw text',async()=>{
 const scoped=aiQueryFilters(new URLSearchParams({lookback:'1w',timeZone:'America/Los_Angeles',promptId:id(1),versionId:id(2),tag:'current',reportedModel:JSON.stringify({state:'reported',value:'not_recorded'})})),fullClient=client(),metaClient=client();
 const full=await readAiSearchAnalysisPopulation(fullClient.db,project,scoped),metadata=await readAiSearchAnalysisPopulation(metaClient.db,project,scoped,false);
 assert.equal(full.rows![0].rawState,'retained');assert.equal(full.rows![0].result!.capturedPrompt,'Original prompt');assert.equal(metadata.rows,null);assert.deepEqual(metadata.receipts,full.receipts);assert.equal(metadata.selectionRevision,full.selectionRevision);assert.deepEqual(full.resolvedRange,{from:'2026-10-09',to:'2026-10-15',timeZone:'America/Los_Angeles'});assert.equal(full.contextRevision,7);assert.deepEqual(full.filters,scoped);assert.equal(full.receipts[0].quote_id,id(20));assert.equal(Object.hasOwn(full.receipts[0],'input'),false);assert.equal(Object.hasOwn(full.receipts[0],'result'),false);
 for(const fixture of [fullClient,metaClient]){const bound=fixture.calls.find(c=>c.sql.startsWith('SELECT count(*)::int AS n'))!,load=fixture.calls.at(-1)!;assert.deepEqual(bound.values,[project.id,'2026-10-09','2026-10-15','America/Los_Angeles',id(1),id(2),'current',at]);assert.match(bound.sql,/LIMIT 1001/);assert.match(bound.sql,/p\.user_tags\?\$7/);assert.equal(bound.sql.includes('reportedModel'),false);assert.match(load.sql,/OR NOT \$9::boolean/);assert.match(load.sql,/ORDER BY r\.created_at DESC,r\.id DESC$/);assert.equal(load.values.length,9);}
 assert.equal(fullClient.calls.at(-1)!.values[8],true);assert.equal(metaClient.calls.at(-1)!.values[8],false);
});

test('pre-model attempt/retained-byte bounds refuse before payload selection, never a sampled population',async()=>{
 for(const bounds of [{n:1001,bytes:'0'},{n:1,bytes:String(10*1024*1024+1)}]){
  const fixture=client(bounds);await assert.rejects(readAiSearchAnalysisPopulation(fixture.db,project,{...filters,reportedModel:{state:'reported',value:'excluded'}}),{status:413});assert.equal(fixture.calls.some(c=>c.sql.startsWith('SELECT r.id,')),false);
 }
});
