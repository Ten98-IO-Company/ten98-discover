import {z} from 'zod';
import {auditPageOrder,auditPageSearchIn,auditPageSort,normalizeAuditPageFields} from './site-audit-pages.ts';

export const contentCoverageMethod='literal-phrase-boundary-v1' as const;
export const contentCoverageLimits=Object.freeze({selectedPages:10000,readablePages:1000,rawBytes:8*1024*1024,queries:100,work:100_000_000,responseBytes:2*1024*1024,examples:5});

/** Coordinates belong to this normalized text, never to the original captured body. */
export function normalizeContentText(text:string):string{
 if(/[\p{Cs}\u0000]/u.test(text))throw new TypeError('Invalid captured Unicode text.');
 return text.normalize('NFC').toLowerCase().replace(/\s+/gu,' ').trim();
}
const word=(text:string)=>/[\p{L}\p{N}\p{M}_]/u.test(text);
/** Literal evidence only. Both arguments must use normalizeContentText. */
export function contentPhraseMatches(body:string,phrase:string):boolean{
 if(!phrase)return false;
 const points=Array.from(phrase),left=word(points[0]),right=word(points.at(-1)!);
 for(let index=body.indexOf(phrase);index!==-1;index=body.indexOf(phrase,index+1)){
  const end=index+phrase.length,before=Array.from(body.slice(Math.max(0,index-2),index)).at(-1)??'',after=end<body.length?String.fromCodePoint(body.codePointAt(end)!):'';
  if((!left||!word(before))&&(!right||!word(after)))return true;
 }
 return false;
}

const text=(max:number)=>z.string().max(max).refine(v=>!/[\p{Cs}\u0000]/u.test(v));
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),stamp=z.iso.datetime(),count=z.number().int().nonnegative();
const pageQuery=z.object({coverage:z.enum(['unavailable','blocked','rate_limited','robots_disallowed','not_fetched','http_error','redirect','non_html','partial','shell','analyzed']).nullable(),resourceKind:z.literal('html'),search:text(800),searchIn:z.enum(auditPageSearchIn),sort:z.enum(auditPageSort),order:z.enum(auditPageOrder),expectedSelectionRevision:hash}).strict().refine(v=>normalizeAuditPageFields({search:v.search,searchIn:v.searchIn,sort:v.sort,order:v.order})!==null).transform(v=>({...v,...normalizeAuditPageFields({search:v.search,searchIn:v.searchIn,sort:v.sort,order:v.order})!}));
export const contentCoverageInputSchema=z.object({captureId:z.uuid().transform(v=>v.toLowerCase()),auditRunId:z.uuid().transform(v=>v.toLowerCase()),pages:pageQuery}).strict();
export const contentCoverageExportInputSchema=contentCoverageInputSchema.extend({expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash}).strict();
export type ContentCoverageInput=z.infer<typeof contentCoverageInputSchema>;
export const contentPageStates=['available','empty','not_recorded','unavailable','over_limit','invalid','expired'] as const;
const reference=z.object({id:z.uuid(),url:text(2048).refine(v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}),observedAt:stamp,extractionVersion:z.literal('static-dom-body-v1'),bodySha256:hash,auditRunId:z.uuid()}).strict();
const queryRow=z.object({key:text(4000).min(1),firstIndex:count.max(99),indexes:z.array(count.max(99)).min(1).max(100),state:z.enum(['found','not_found_in_readable_pages','not_assessed']),matchedPageCount:count.max(1000),assessedPageCount:count.max(1000),unassessableSelectedPageCount:count.max(10000),examples:z.array(reference).max(5),returnedExamples:count.max(5),exampleLimit:z.literal(5)}).strict();
const crawlCoverage=z.object({reasons:z.array(text(200)).max(100),discoveryComplete:z.boolean(),linksComplete:z.boolean(),scopeExclusions:count,rawEvidenceRecorded:z.boolean(),queryExclusions:count.optional(),externalExclusions:count.optional(),frontierOmissions:count.optional(),edgeOmissions:count.optional(),sitemapUnavailable:count.optional(),unavailablePages:count.optional(),unfetchedPages:count.optional()}).strict();
export const contentCoverageReportSchema=z.object({version:z.literal('ai-content-literal-v1'),role:z.enum(['owner','admin','editor','viewer']),projectId:z.uuid(),snapshotAt:stamp,asOf:stamp,applied:contentCoverageInputSchema,
 queryReceiptHash:hash,corpusReceiptHash:hash,querySource:z.object({captureId:z.uuid(),quoteId:z.uuid(),promptId:z.uuid(),versionId:z.uuid(),requestedAt:stamp,quoteCreatedAt:stamp,receivedAt:stamp.nullable(),providerObservedAt:stamp.nullable(),rawState:z.enum(['retained','not_recorded','invalid','expired']),queryState:z.enum(['reported','reported_empty','not_recorded','invalid','raw_unavailable']),rawQueryCount:count.max(100).nullable(),blankQueries:count.max(100).nullable(),echoQueries:count.max(100).nullable()}).strict(),
 audit:z.object({id:z.uuid(),origin:text(2048),currentProjectOrigin:text(2048),status:z.enum(['completed','partial','failed','cancelled']),completedAt:stamp,retainBodyText:z.boolean(),mode:z.literal('static'),startPath:text(2048),maxPages:count.max(1000),coverage:crawlCoverage,observationRange:z.object({from:stamp.nullable(),to:stamp.nullable()}).strict()}).strict(),
 policy:z.object({revision:count.min(1),rawProviderEvidenceDays:count.min(1),derivedHistoryDays:count.min(1)}).strict(),
 method:z.literal(contentCoverageMethod),queryPopulation:z.enum(['reported','unavailable']),pageCoverage:z.object({selected:count.max(10000),readable:count.max(1000),unassessable:count.max(10000),states:z.object(Object.fromEntries(contentPageStates.map(s=>[s,count.max(10000)])) as Record<typeof contentPageStates[number],typeof count>).strict()}).strict(),
 rows:z.array(queryRow).max(100).nullable(),rate:z.object({numerator:count.max(100).nullable(),denominator:count.max(100).nullable(),value:z.number().min(0).max(1).nullable()}).strict(),work:count.max(contentCoverageLimits.work),
}).strict().superRefine((r,ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Inconsistent captured-text coverage receipt.'}),p=r.pageCoverage,q=r.querySource;
 if(q.captureId!==r.applied.captureId||r.audit.id!==r.applied.auditRunId||Date.parse(r.snapshotAt)>Date.parse(r.asOf)||Object.values(p.states).reduce((s,v)=>s+v,0)!==p.selected||p.readable!==p.states.available+p.states.empty||p.unassessable!==p.selected-p.readable||(r.audit.observationRange.from===null)!==(r.audit.observationRange.to===null)||r.audit.observationRange.from!==null&&Date.parse(r.audit.observationRange.from)>Date.parse(r.audit.observationRange.to!))fail();
 const reported=q.queryState==='reported'||q.queryState==='reported_empty';
 if((r.rows!==null)!==(r.queryPopulation==='reported')||reported!==(r.rows!==null)||q.rawState!=='retained'&&q.queryState!=='raw_unavailable'||q.rawState==='retained'&&q.receivedAt===null||q.rawState!=='retained'&&(q.receivedAt!==null||q.providerObservedAt!==null))fail();
 if(r.rows===null){if(Object.values(r.rate).some(v=>v!==null)||q.rawQueryCount!==null||q.blankQueries!==null||q.echoQueries!==null)fail();return;}
 if(q.rawQueryCount===null||q.blankQueries===null||q.echoQueries===null||q.queryState==='reported_empty'&&q.rawQueryCount!==0||q.queryState==='reported'&&q.rawQueryCount===0)fail();
 const keys=new Set<string>(),indexes=new Set<number>();let votes=0;
 for(const row of r.rows){if(keys.has(row.key)||row.firstIndex!==row.indexes[0]||row.indexes.some((v,i)=>v>=(q.rawQueryCount??0)||indexes.has(v)||i>0&&v<=row.indexes[i-1])||row.assessedPageCount!==p.readable||row.unassessableSelectedPageCount!==p.unassessable||row.matchedPageCount>p.readable||row.state!==(row.matchedPageCount?'found':p.readable?'not_found_in_readable_pages':'not_assessed')||row.returnedExamples!==row.examples.length||row.returnedExamples!==Math.min(5,row.matchedPageCount)||new Set(row.examples.map(e=>e.id)).size!==row.examples.length||row.examples.some(e=>e.auditRunId!==r.audit.id))fail();keys.add(row.key);row.indexes.forEach(v=>indexes.add(v));votes+=row.indexes.length;}
 const numerator=r.rows.filter(row=>row.matchedPageCount>0).length,denominator=p.readable?r.rows.length:0;
 if(votes+(q.blankQueries??0)+(q.echoQueries??0)!==q.rawQueryCount||r.rate.numerator!==numerator||r.rate.denominator!==denominator||r.rate.value!==(denominator?numerator/denominator:null))fail();
});
export type ContentCoverageReport=z.infer<typeof contentCoverageReportSchema>;
/** Browser callers bind the verified envelope to their exact applied selection. */
export function readContentCoverageReport(value:unknown,projectId:string,expected:ContentCoverageInput):ContentCoverageReport{
 const r=contentCoverageReportSchema.parse(value),input=contentCoverageInputSchema.parse(expected);
 if(r.projectId!==projectId||JSON.stringify(r.applied)!==JSON.stringify(input)||new TextEncoder().encode(JSON.stringify(r)).length>contentCoverageLimits.responseBytes)throw Error('Website-text comparison does not match this selection.');return r;
}
