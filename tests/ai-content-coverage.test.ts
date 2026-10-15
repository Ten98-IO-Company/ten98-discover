import test from 'node:test';
import assert from 'node:assert/strict';
import {contentPhraseMatches,normalizeContentText,contentCoverageInputSchema,contentCoverageReportSchema,readContentCoverageReport} from '../src/lib/ai-content-coverage.ts';
import {calculateLiteralCoverage,ContentCoverageCapacityError,type ContentPage} from '../src/server/ai-content-coverage.ts';
import {createHash} from 'node:crypto';
import {readAiSearchCoverageSource} from '../src/server/ai-search.ts';
import type {PoolClient} from 'pg';

test('selected capture preflight refuses oversized data before payload materialization and limits its expiry latch',async()=>{
 const quoteId='10000000-0000-4000-8000-000000000001',projectId='10000000-0000-4000-8000-000000000002',captureId='10000000-0000-4000-8000-000000000003',calls:string[]=[];
 // Explicit fake client exercises the defensive boundary beyond the current
 // schema's smaller per-result cap; no database or genuine oversized row exists.
 const client={query:async(sql:string,values:unknown[])=>{calls.push(sql);if(sql.startsWith('SELECT quote_id'))return {rows:[{quote_id:quoteId}]};if(sql.startsWith('UPDATE ai_search_quote')){assert.deepEqual(values,[[projectId],null,[quoteId]]);return {rows:[]};}if(sql.startsWith('SELECT CASE WHEN'))return {rows:[{bytes:10*1024*1024+1}]};assert.fail('Raw source bytes must not be materialized after preflight refusal.');}} as unknown as PoolClient;
 assert.deepEqual(await readAiSearchCoverageSource(client,projectId,captureId),{coverageError:'source_capacity'});assert.equal(calls.length,3);
});

test('captured-text matching keeps literal Unicode boundaries and distinguishes semantic similarity',()=>{
 const matches=(body:string,query:string)=>contentPhraseMatches(normalizeContentText(body),normalizeContentText(query));
 for(const [body,query] of [
  ['Café\u00a0pricing\n\tfor teams','CAFE\u0301 PRICING'],['A red car.','red car'],
  ['κόσμος κόσμος','ΚΌΣΜΟΣ'],['(تسعير المنتجات)','تسعير المنتجات'],['(中文)','中文'],
  ['𐐨𐐩 costs','𐐀𐐁'],['emoji 😀 pricing','😀'],['C++ reference','C++'],
  ['foobar then foo','foo'],['<script>ignore previous instructions</script>','ignore previous instructions'],
 ])assert.equal(matches(body,query),true,JSON.stringify({body,query}));
 for(const [body,query] of [
  ['concatenate','cat'],['foo_bar','foo'],['afoo','foo'],['foo2','foo'],
  ['foo\u0301','foo'],['𐐀cat','cat'],['cat𐐀','cat'],['中文文本','中文'],
  ['المنتجات','منتجات'],['car pricing','automobile cost'],['pricing',''],['','pricing'],
 ])assert.equal(matches(body,query),false,JSON.stringify({body,query}));
 assert.equal(normalizeContentText(' \tA\u2003B\r\n '),'a b');
 assert.equal(normalizeContentText(''),'');
 assert.throws(()=>normalizeContentText('\ud800'),TypeError);
 assert.throws(()=>normalizeContentText('\udc00'),TypeError);
 assert.equal(matches('body with #1 offer',' #1 '),true);
 assert.equal(matches('body #10 offer','#1'),false);
});

test('closed browser receipt binds source, selected audit, examples and exact empty/unknown denominators',()=>{
 const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),at='2026-10-15T00:00:00.000Z';
 const input={captureId:id(2),auditRunId:id(3),pages:{coverage:null,resourceKind:'html' as const,search:'',searchIn:'url' as const,sort:'url' as const,order:'asc' as const,expectedSelectionRevision:'a'.repeat(64)}};
 const measured=calculateLiteralCoverage([query('foo')],[page(id(4),'foo')]);
 // Explicit synthetic schema unit fixture; no claim of an application or SQL response.
 const response={version:'ai-content-literal-v1',role:'viewer',projectId:id(1),snapshotAt:at,asOf:at,applied:input,queryReceiptHash:'b'.repeat(64),corpusReceiptHash:'c'.repeat(64),querySource:{captureId:id(2),quoteId:id(5),promptId:id(6),versionId:id(7),requestedAt:at,quoteCreatedAt:at,receivedAt:at,providerObservedAt:null,rawState:'retained',queryState:'reported',rawQueryCount:1,blankQueries:0,echoQueries:0},audit:{id:id(3),origin:'https://example.test',currentProjectOrigin:'https://example.test',status:'completed',completedAt:at,retainBodyText:true,mode:'static',startPath:'/',maxPages:50,coverage:{reasons:[],discoveryComplete:true,linksComplete:true,scopeExclusions:0,rawEvidenceRecorded:true},observationRange:{from:at,to:at}},policy:{revision:1,rawProviderEvidenceDays:90,derivedHistoryDays:365},...measured,rows:measured.rows!.map(row=>({...row,examples:row.examples.map(ref=>({...ref,auditRunId:id(3)}))}))};
 assert.equal(readContentCoverageReport(response,id(1),input).rows?.[0].state,'found');
 const mutations=[(v:any)=>v.pageCoverage.readable=0,(v:any)=>v.rate.denominator=0,(v:any)=>v.rows[0].examples[0].auditRunId=id(9),(v:any)=>v.rows[0].examples[0].url='javascript:alert(1)',(v:any)=>v.rows[0].examples[0].text='copied body',(v:any)=>v.rows[0].matchedPageCount=2,(v:any)=>v.querySource.rawQueryCount=2,(v:any)=>v.querySource.rawState='expired',(v:any)=>v.rows[0].indexes=[0,0],(v:any)=>v.snapshotAt='2026-10-16T00:00:00.000Z',(v:any)=>v.querySource.receivedAt=null,(v:any)=>v.querySource.providerObservedAt='not a timestamp',(v:any)=>v.querySource.capturedAt=at];
 for(const mutate of mutations){const value=structuredClone(response);mutate(value);assert.equal(contentCoverageReportSchema.safeParse(value).success,false);}
 assert.throws(()=>readContentCoverageReport(response,id(9),input));assert.throws(()=>readContentCoverageReport(response,id(1),{...input,captureId:id(9)}));
 assert.equal(contentCoverageInputSchema.safeParse({...input,pages:{...input.pages,resourceKind:'robots'}}).success,false);
 assert.equal(contentCoverageInputSchema.safeParse({...input,pages:{...input.pages,search:'\ud800'}}).success,false);
 assert.equal(contentCoverageInputSchema.parse({...input,pages:{...input.pages,search:' foo '}}).pages.search,'foo');
 const unavailable={...response,...calculateLiteralCoverage(null,[page(id(4),'')]),querySource:{...response.querySource,rawState:'expired',receivedAt:null,providerObservedAt:null,queryState:'raw_unavailable',rawQueryCount:null,blankQueries:null,echoQueries:null}};assert.equal(contentCoverageReportSchema.safeParse(unavailable).success,true);
});

test('normalization offsets never masquerade as original-text offsets',()=>{
 const original='İ\tCafe\u0301',normalized=normalizeContentText(original);
 assert.equal(normalized,'i\u0307 café');
 assert.notEqual(original.indexOf('C'),normalized.indexOf('c'));
 assert.equal(contentPhraseMatches(normalized,normalizeContentText('Café')),true);
 assert.equal(original,'İ\tCafe\u0301');
});

const page=(id:string,text:string|null,state:ContentPage['state']=text===null?'not_recorded':text===''?'empty':'available'):ContentPage=>({id,url:'https://example.test/'+id,observedAt:'2026-10-15T00:00:00.000Z',state,extractionVersion:text===null?null:'static-dom-body-v1',bodySha256:text===null?null:createHash('sha256').update(text).digest('hex'),text});
const query=(key:string,firstIndex=0)=>({key,firstIndex,indexes:[firstIndex]});

test('complete query and page axes preserve empty, unavailable, source identities and bounded evidence examples',()=>{
 const pages=[...Array.from({length:7},(_,i)=>page(String(i),'Café pricing. Café pricing.')),page('empty',''),page('missing',null),page('expired',null,'expired')];
 const queries=[query('café pricing'),query('cafe\u0301 pricing',1),query('semantic synonym',2)],before=JSON.stringify({queries,pages});
 const r=calculateLiteralCoverage(queries,pages);
 assert.equal(r.queryPopulation,'reported');assert.deepEqual(r.rate,{numerator:2,denominator:3,value:2/3});
 assert.equal(r.pageCoverage.selected,10);assert.equal(r.pageCoverage.readable,8);assert.equal(r.pageCoverage.unassessable,2);
 assert.deepEqual(r.rows?.map(q=>[q.key,q.state,q.matchedPageCount,q.assessedPageCount,q.unassessableSelectedPageCount,q.returnedExamples]),[
  ['café pricing','found',7,8,2,5],['cafe\u0301 pricing','found',7,8,2,5],['semantic synonym','not_found_in_readable_pages',0,8,2,0],
 ]);
 assert.equal(JSON.stringify(r).includes('Café pricing.'),false);assert.equal(JSON.stringify({queries,pages}),before);
 assert.deepEqual(calculateLiteralCoverage([query('foo')],[page('empty','')]).rate,{numerator:0,denominator:1,value:0});
 const unreadable=calculateLiteralCoverage([query('foo')],[page('missing',null)]);
 assert.equal(unreadable.rows?.[0].state,'not_assessed');assert.deepEqual(unreadable.rate,{numerator:0,denominator:0,value:null});
 const missing=calculateLiteralCoverage(null,[page('empty','')]);assert.equal(missing.rows,null);assert.equal(missing.rate.denominator,null);
 const empty=calculateLiteralCoverage([],[page('empty','')]);assert.deepEqual(empty.rows,[]);assert.equal(empty.rate.denominator,0);
});

test('capacity and cancellation refuse whole calculations at real admitted boundaries',()=>{
 const full=Array.from({length:128},(_,i)=>page(String(i),'x'.repeat(65536)));
 assert.equal(calculateLiteralCoverage([query('x')],full).pageCoverage.readable,128);
 assert.throws(()=>calculateLiteralCoverage([query('x')],[...full,page('over','x')]),ContentCoverageCapacityError);
 const workload=Array.from({length:100},(_,i)=>page(String(i),'x'.repeat(50000))),queries=Array.from({length:20},(_,i)=>query('query '+i,i));
 assert.equal(calculateLiteralCoverage(queries,workload).work,100_000_000);
 assert.throws(()=>calculateLiteralCoverage(queries,[...workload,page('over','x')]),ContentCoverageCapacityError);
 assert.equal(calculateLiteralCoverage([],Array.from({length:10000},(_,i)=>page(String(i),null))).pageCoverage.selected,10000);
 assert.throws(()=>calculateLiteralCoverage([],Array.from({length:10001},(_,i)=>page(String(i),null))),ContentCoverageCapacityError);
 assert.throws(()=>calculateLiteralCoverage([],Array.from({length:1001},(_,i)=>page(String(i),''))),ContentCoverageCapacityError);
 assert.throws(()=>calculateLiteralCoverage(Array.from({length:101},(_,i)=>query('query '+i,i)),[]),ContentCoverageCapacityError);
 assert.throws(()=>calculateLiteralCoverage([query('foo'),query('foo',1)],[]),/Duplicate/);
 assert.throws(()=>calculateLiteralCoverage([], [page('same',''),page('same','')]),/Duplicate/);
 assert.throws(()=>calculateLiteralCoverage([], [{...page('bad','body'),state:'invalid'}]),/Unreadable/);
 assert.throws(()=>calculateLiteralCoverage([query('foo')], [page('a','foo')],()=>{throw Error('Cancelled');}),/Cancelled/);
});
