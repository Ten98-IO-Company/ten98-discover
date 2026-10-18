import {z} from 'zod';
import {contentSupportContract,contentSupportQuoteInputSchema,contentSupportQuoteDtoSchema,contentSupportRunDtoSchema,type ContentSupportQuoteInput,type ContentSupportQuoteDto,type ContentSupportRunDto} from '../lib/ai-content-support.ts';
import {contentCoverageReportSchema,projectContentCoverageReportSchema,type ContentCoverageReport,type ProjectContentCoverageReport} from '../lib/ai-content-coverage.ts';

export type SupportRole=ContentSupportRunDto['role'];
export type SupportSourceReport=ContentCoverageReport|ProjectContentCoverageReport;
const uuid=z.uuid(),role=z.enum(['owner','admin','editor','viewer']),cursor=z.string().min(1).max(4096).nullable();
const connection=z.object({id:uuid,name:z.string().min(1).max(120),revision:z.number().int().positive(),checkStatus:z.enum(['untested','ok','error'])}).strict();
const list=z.object({version:z.literal('ai-content-support-list-v1'),role,projectId:uuid,canQuote:z.boolean(),admission:z.literal('owner-evaluation'),semanticConclusions:z.literal('unverified'),connections:z.array(connection),runs:z.array(contentSupportRunDtoSchema.shape.run).max(20),nextCursor:cursor}).strict();
export type SupportList=z.infer<typeof list>;
export function readSupportList(value:unknown,projectId:string){
 const data=list.parse(value);if(data.projectId!==projectId||data.canQuote!==(data.role==='owner')||new Set(data.connections.map(c=>c.id)).size!==data.connections.length||new Set(data.runs.map(r=>r.id)).size!==data.runs.length)throw Error('The assessment history does not match this project or current access.');
 for(const run of data.runs)contentSupportRunDtoSchema.parse({version:'ai-content-support-run-v1',role:data.role,projectId:data.projectId,run});return data;
}
function action(value:unknown){const parsed=z.object({replayed:z.boolean()}).passthrough().parse(value),{replayed,...body}=parsed;return {replayed,body};}
export function readSupportQuote(value:unknown,projectId:string,input:ContentSupportQuoteInput,queryKeys:string[]){
 const {replayed,body}=action(value),data=contentSupportQuoteDtoSchema.parse(body),q=data.quote;
 if(data.projectId!==projectId||data.role!=='owner'||q.requestId!==input.requestId||q.inputExpired||!q.input||!q.selection||JSON.stringify(q.input)!==JSON.stringify(contentSupportQuoteInputSchema.parse(input))||JSON.stringify(q.selection.queries.map(q=>q.key))!==JSON.stringify(queryKeys))throw Error('The saved quote does not match these exact queries, pages and model.');return {...data,replayed};
}
export function readSupportRun(value:unknown,projectId:string,id?:string,quoted?:ContentSupportQuoteDto['quote'],mutation=false){
 const envelope=mutation?action(value):{body:value,replayed:false},data=contentSupportRunDtoSchema.parse(envelope.body),r=data.run;
 if(data.projectId!==projectId||id!==undefined&&r.id!==id||quoted&&(r.quoteId!==quoted.id||r.inputHash!==quoted.inputHash||r.payloadHash!==quoted.payloadHash||r.queryReceiptHash!==quoted.queryReceiptHash||r.corpusReceiptHash!==quoted.corpusReceiptHash||JSON.stringify(r.route)!==JSON.stringify(quoted.route)))throw Error('The assessment response does not match the requested run and quote.');return {...data,replayed:envelope.replayed};
}
export function supportReceipt(run:ContentSupportRunDto['run']){return {expectedPayloadHash:run.payloadHash,expectedResultHash:run.resultHash,expectedQueryReceiptHash:run.queryReceiptHash,expectedCorpusReceiptHash:run.corpusReceiptHash};}
export function sameSupportReceipt(a:ContentSupportRunDto['run'],b:ContentSupportRunDto['run']){return a.id===b.id&&a.quoteId===b.quoteId&&JSON.stringify(supportReceipt(a))===JSON.stringify(supportReceipt(b))&&JSON.stringify(a.route)===JSON.stringify(b.route);}
export function supportSource(report:SupportSourceReport){
 const data=report.version==='ai-content-literal-v1'?contentCoverageReportSchema.parse(report):projectContentCoverageReportSchema.parse(report);
 const source:ContentSupportQuoteInput['source']=data.version==='ai-content-literal-v1'?{kind:'capture',selection:data.applied}:{kind:'project',selection:data.applied};
 return {source,queryKeys:data.rows?.map(row=>'query'in row?row.query.key:row.key)??[],queryReceiptHash:data.queryReceiptHash,corpusReceiptHash:data.corpusReceiptHash};
}
export function supportSourceKey(report:SupportSourceReport){return JSON.stringify({projectId:report.projectId,role:report.role,version:report.version,applied:report.applied,query:report.queryReceiptHash,corpus:report.corpusReceiptHash,policy:report.policy,asOf:report.asOf});}
/** Same sorted two-field JSON as the server's canonicalHash; no raw body is submitted. */
export async function supportQueryId(key:string){
 if(!key||key.length>4000||key!==key.trim().toLowerCase()||/[\p{Cs}\u0000]/u.test(key))throw Error('The selected query key is invalid.');
 const bytes=new TextEncoder().encode(JSON.stringify({derivationVersion:contentSupportContract.derivationVersion,key})),digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
export function quoteCurrent(quote:ContentSupportQuoteDto['quote'],now=new Date()){
 return !quote.inputExpired&&quote.input!==null&&quote.selection!==null&&quote.expiresAt>now.toISOString().replace('Z','000Z');
}
