import {aiSearchEndpoints,aiSearchPayload,aiSearchRequestSchema,aiSearchProfileId,aiSearchSource,type AiSearchRequest,type AiSearchCountry,type AiSearchLanguage} from '../lib/ai-search.ts';
import {dataforseoJson,dataforseoRefusal,dataforseoRefusalEvidence,dataforseoRefusalMessage,type DataforseoResponse} from './dataforseo-transport.ts';
import {providerMicros,microUsd,validText} from './keyword-research-input.ts';
import {parseKeywordAccount} from './dataforseo-keywords.ts';
import {normalizeDfsChatgptSearchEvidence,type SearchEvidence} from './ai-search-evidence.ts';
import {canonicalHash} from './context-input.ts';

const own=(o:Record<string,unknown>,key:string)=>Object.hasOwn(o,key);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function dense(v:unknown):v is unknown[]{if(!Array.isArray(v))return false;for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))return false;return true;}
function invalid():never{throw new Error('DataForSEO search evidence is unavailable.');}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/.test(v);
const pathFor=(url:string)=>new URL(url).pathname.slice(1).split('/');
function pathMatches(value:unknown,url:string){const expected=pathFor(url);return dense(value)&&value.length===expected.length&&value.every((v,i)=>v===expected[i]);}
function envelope(response:DataforseoResponse,url:string){
 const b=response.body;if(!object(b)||!own(b,'tasks')||!dense(b.tasks)||b.tasks.length!==1||!own(b,'tasks_count')||b.tasks_count!==1||!own(b,'tasks_error')||!Number.isInteger(b.tasks_error)||!own(b,'status_code')||!Number.isInteger(b.status_code))invalid();
 const task=b.tasks[0];if(!object(task)||!own(task,'path')||!pathMatches(task.path,url))invalid();return {body:b,task};
}
function resultRows(response:DataforseoResponse,url:string,maximum:number){
 const {body,task}=envelope(response,url);
 if(response.httpStatus!==200||body.status_code!==20000||body.tasks_error!==0||!own(body,'cost')||providerMicros(body.cost)!==0n||!own(task,'cost')||providerMicros(task.cost)!==0n||!own(task,'status_code')||task.status_code!==20000||!own(task,'result')||!dense(task.result)||task.result.length>maximum||!own(task,'result_count')||task.result_count!==task.result.length)invalid();
 return task.result;
}
export function parseAiSearchCountries(response:DataforseoResponse):AiSearchCountry[]{
 const rows=resultRows(response,aiSearchEndpoints.locations,250_000),countries:AiSearchCountry[]=[],ids=new Set<number>(),codes=new Set<string>();
 for(const row of rows){
  if(!object(row)||!own(row,'location_type')||!validText(row.location_type,80)||!own(row,'location_code')||!Number.isSafeInteger(row.location_code)||Number(row.location_code)<1||Number(row.location_code)>2_147_483_647||!own(row,'location_name')||!validText(row.location_name,200))invalid();
  if(ids.has(row.location_code as number))invalid();ids.add(row.location_code as number);
  if(row.location_type!=='Country')continue;
  if(!own(row,'country_iso_code')||typeof row.country_iso_code!=='string'||!/^[A-Z]{2}$(?![\s\S])/.test(row.country_iso_code)||codes.has(row.country_iso_code))invalid();
  codes.add(row.country_iso_code);countries.push({code:row.location_code as number,name:row.location_name,countryCode:row.country_iso_code});
 }
 if(countries.length===0||countries.length>300)invalid();return countries.sort((a,b)=>a.code-b.code);
}
export function parseAiSearchLanguages(response:DataforseoResponse):AiSearchLanguage[]{
 const rows=resultRows(response,aiSearchEndpoints.languages,1000),seen=new Set<string>(),languages:AiSearchLanguage[]=[];
 for(const row of rows){if(!object(row)||!own(row,'language_code')||typeof row.language_code!=='string'||!/^[a-z]{2,3}(?:-[A-Z]{2})?$(?![\s\S])/.test(row.language_code)||!own(row,'language_name')||!validText(row.language_name,80)||seen.has(row.language_code))invalid();seen.add(row.language_code);languages.push({code:row.language_code,name:row.language_name});}
 if(languages.length===0)invalid();return languages.sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0);
}
export function assertAiSearchMarket(raw:unknown,countries:AiSearchCountry[],languages:AiSearchLanguage[]):AiSearchRequest{
 const request=aiSearchRequestSchema.parse(raw);if(!countries.some(c=>c.code===request.locationCode)||!languages.some(l=>l.code===request.languageCode))invalid();return request;
}
export function parseAiSearchAccount(response:DataforseoResponse,binding:{key:string;version:2}){
 const rows=resultRows(response,'https://api.dataforseo.com/v3/appendix/user_data',1);
 if(rows.length!==1||!object(rows[0])||!own(rows[0],'login'))invalid();
 if(!binding||binding.version!==2||typeof binding.key!=='string'||binding.key.length<32)invalid();
 // Shared v2 keyed account identity only; never interpret an invented AI price subtree.
 return {fingerprint:parseKeywordAccount(response,undefined,binding).fingerprint};
}
function matchesPayload(value:unknown,request:AiSearchRequest,id:string){
 if(!object(value))return false;const expected=aiSearchPayload(request,id);
 // Do not bind another task with added model/paid options to this fixed quote.
 const defaults:Record<string,string>={api:'ai_optimization',function:'llm_scraper',se:'chat_gpt',device:'desktop',os:'windows'};
 return Object.entries(expected).every(([key,v])=>own(value,key)&&value[key]===v)
  &&Object.keys(value).every(key=>Object.hasOwn(expected,key)||Object.hasOwn(defaults,key)&&value[key]===defaults[key]);
}
function observedAt(value:unknown):string|null{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+00:00$(?![\s\S])/.test(value))return null;
 const normalized=value.slice(0,10)+'T'+value.slice(11,19)+'.000Z',date=new Date(normalized);
 return Number.isFinite(date.getTime())&&date.toISOString()===normalized?normalized:null;
}
// Same final-status admission used by native DataForSEO keyword outcomes. Unknown/queued/server errors never prove a charge.
const finalTaskStatuses=new Set([20000,40102,40103,40106,40501,40502,40503,40504,40505,40506]);
export type AiSearchCapturedResult={profileId:typeof aiSearchProfileId;source:typeof aiSearchSource;capturedPrompt:string;locationCode:number;languageCode:string;forceWebSearch:true;reportedModel:string|null;providerObservedAt:string|null;receivedAt:string;evidence:SearchEvidence};
export type AiSearchOutcome={charge:{state:'known';costUsd:string;providerTaskId:string|null}|{state:'unknown';providerTaskId:string|null};
 content:{state:'available';value:AiSearchCapturedResult}|{state:'unavailable';reason:'response_unverified'|'provider_error'|'content_invalid'|'transport_unverified'};
 evidence:{httpStatus:number|null;statusCode:number|null;taskStatus:number|null;totalCostUsd:string|null;taskCostUsd:string|null};diagnostic?:string};
function unknown(httpStatus:number|null,reason:'response_unverified'|'transport_unverified'='response_unverified'):AiSearchOutcome{return {charge:{state:'unknown',providerTaskId:null},content:{state:'unavailable',reason},evidence:{httpStatus,statusCode:null,taskStatus:null,totalCostUsd:null,taskCostUsd:null}};}
export function parseAiSearchOutcome(response:DataforseoResponse,raw:unknown,id:string,now=new Date()):AiSearchOutcome{
 const request=aiSearchRequestSchema.parse(raw);aiSearchPayload(request,id);if(!Number.isFinite(now.getTime()))invalid();
 const outcome=unknown(response.httpStatus),refused=dataforseoRefusal(response);
 if(refused){const {statusCode,taskStatus,taskCost}=dataforseoRefusalEvidence(response);
  return {charge:{state:'known',costUsd:'0.000000',providerTaskId:null},content:{state:'unavailable',reason:'provider_error'},diagnostic:dataforseoRefusalMessage[refused],
   evidence:{httpStatus:response.httpStatus,statusCode,taskStatus,totalCostUsd:'0.000000',taskCostUsd:taskCost===null?null:'0.000000'}};}
 try{
  const {body,task}=envelope(response,aiSearchEndpoints.live);
  if(!own(task,'id')||!uuid(task.id)||!own(task,'data')||!matchesPayload(task.data,request,id)||!own(task,'status_code')||!Number.isInteger(task.status_code))return outcome;
  outcome.charge={state:'unknown',providerTaskId:task.id};outcome.evidence.statusCode=body.status_code as number;outcome.evidence.taskStatus=task.status_code as number;
  if(response.httpStatus!==200||body.status_code!==20000||!finalTaskStatuses.has(task.status_code as number)||body.tasks_error!==(task.status_code===20000?0:1)||!own(body,'cost')||!own(task,'cost'))return outcome;
  const total=providerMicros(body.cost),cost=providerMicros(task.cost);outcome.evidence.totalCostUsd=microUsd(total);outcome.evidence.taskCostUsd=microUsd(cost);if(total!==cost)return outcome;
  outcome.charge={state:'known',providerTaskId:task.id,costUsd:microUsd(cost)};
  if(task.status_code!==20000){outcome.content={state:'unavailable',reason:'provider_error'};return outcome;}
  outcome.content={state:'unavailable',reason:'content_invalid'};
  if(!own(task,'result')||!dense(task.result)||task.result.length!==1||!own(task,'result_count')||task.result_count!==1||!object(task.result[0]))return outcome;
  const result=task.result[0];
  if(!own(result,'keyword')||result.keyword!==request.capturedPrompt||!own(result,'location_code')||result.location_code!==request.locationCode||!own(result,'language_code')||result.language_code!==request.languageCode)return outcome;
  const model=own(result,'model')&&validText(result.model,160)?result.model:null;
  outcome.content={state:'available',value:{profileId:aiSearchProfileId,source:aiSearchSource,capturedPrompt:request.capturedPrompt,locationCode:request.locationCode,languageCode:request.languageCode,forceWebSearch:true,
   reportedModel:model,providerObservedAt:own(result,'datetime')?observedAt(result.datetime):null,receivedAt:now.toISOString(),evidence:normalizeDfsChatgptSearchEvidence(result)}};
 }catch{/* A known charge survives malformed content. A2 owns settlement; this adapter never retries. */}
 return outcome;
}
// Explicit send is mandatory. This adapter grants no authority to spend; A2 must reserve/dispatch first.
export async function requestAiSearch(credentials:unknown,raw:unknown,id:string,send:typeof fetch):Promise<AiSearchOutcome>{
 const request=aiSearchRequestSchema.parse(raw),payload=aiSearchPayload(request,id);if(typeof send!=='function')invalid();
 try{return parseAiSearchOutcome(await dataforseoJson(aiSearchEndpoints.live,credentials,'POST',[payload],send),request,id);}
 catch{return unknown(null,'transport_unverified');}
}
export type AiSearchReceiptBinding={profileId:typeof aiSearchProfileId;runId:string;payloadHash:string;dispatchedAt:string;asOf:string;providerTaskId?:string|null};
const stamp=(time:number)=>new Date(time).toISOString().slice(0,19).replace('T',' ')+' +00:00';
function receiptBinding(raw:unknown):AiSearchReceiptBinding{
 if(!object(raw)||Object.keys(raw).some(k=>!['profileId','runId','payloadHash','dispatchedAt','asOf','providerTaskId'].includes(k))||
  !['profileId','runId','payloadHash','dispatchedAt','asOf'].every(k=>own(raw,k))||raw.profileId!==aiSearchProfileId||!uuid(raw.runId)||
  typeof raw.payloadHash!=='string'||!/^[a-f0-9]{64}$(?![\s\S])/.test(raw.payloadHash)||typeof raw.dispatchedAt!=='string'||typeof raw.asOf!=='string'||
  ![raw.dispatchedAt,raw.asOf].every(s=>{const n=new Date(s);return Number.isFinite(n.getTime())&&n.toISOString()===s;})||
  own(raw,'providerTaskId')&&raw.providerTaskId!==null&&!uuid(raw.providerTaskId))invalid();
 const age=new Date(raw.asOf).getTime()-new Date(raw.dispatchedAt).getTime();
 // An early clipped page cannot rule out a later duplicate within the dispatch
 // window. Wait for the whole150s paid transport window before proving a charge.
 if(age<150_000||age>28*86400000)invalid();return raw as AiSearchReceiptBinding;
}
function receiptPayload(metadata:unknown,id:string){
 if(!object(metadata)||!own(metadata,'keyword')||typeof metadata.keyword!=='string')invalid();
 // Reverse only this profile's escapes, not URI decoding: literal%20 must stay
 // literal%20. Canonical forward round-trip rejects alternate/added wire fields.
 const request=aiSearchRequestSchema.parse({profileId:aiSearchProfileId,capturedPrompt:metadata.keyword.replaceAll('%2B','+').replaceAll('%25','%'),locationCode:metadata.location_code,languageCode:metadata.language_code});
 if(!matchesPayload(metadata,request,id))invalid();return aiSearchPayload(request,id);
}
function chargeRow(row:unknown){
 if(!object(row)||!own(row,'id')||!uuid(row.id)||!own(row,'status')||typeof row.status!=='string'||!/^\d{5}$(?![\s\S])/.test(row.status)||!finalTaskStatuses.has(Number(row.status))||!own(row,'cost'))invalid();
 return {providerTaskId:row.id,costUsd:microUsd(providerMicros(row.cost)),statusCode:Number(row.status)};
}
export function parseAiSearchReconciliation(response:DataforseoResponse,raw:unknown,id?:string){
 if(id===undefined){
  const binding=receiptBinding(raw),at=new Date(binding.dispatchedAt).getTime(),rows=resultRows(response,aiSearchEndpoints.reconciliation,1000);
  if(rows.length===1000)invalid();const {task}=envelope(response,aiSearchEndpoints.reconciliation),data=task.data;
  if(!object(data)||Object.keys(data).some(k=>!['api','function','datetime_from','datetime_to','limit','offset','sort','include_metadata'].includes(k))||
   !['datetime_from','datetime_to','limit','offset','sort','include_metadata'].every(k=>own(data,k))||
   own(data,'api')&&data.api!=='ai_optimization'||own(data,'function')&&data.function!=='id_list'||
   data.datetime_from!==stamp(at-60_000)||data.datetime_to!==stamp(at+150_000)||data.limit!==1000||data.offset!==0||data.sort!=='asc'||data.include_metadata!==true)invalid();
  const tag='ten98:ai-search:'+binding.runId;
  // Count every same-tag row, including contradictory metadata, before matching.
  const matches=rows.filter(row=>object(row)&&own(row,'metadata')&&object(row.metadata)&&own(row.metadata,'tag')&&row.metadata.tag===tag);
  if(matches.length!==1)invalid();const row=matches[0];if(!object(row)||!own(row,'url')||row.url!==pathFor(aiSearchEndpoints.live).join('/')||!own(row,'datetime_posted'))invalid();
  const posted=observedAt(row.datetime_posted);if(posted===null||new Date(posted).getTime()<at-60_000||new Date(posted).getTime()>at+150_000||canonicalHash(receiptPayload(row.metadata,binding.runId))!==binding.payloadHash)invalid();
  const charge=chargeRow(row);if(binding.providerTaskId!=null&&charge.providerTaskId!==binding.providerTaskId)invalid();return charge;
 }
 const request=aiSearchRequestSchema.parse(raw);aiSearchPayload(request,id);const rows=resultRows(response,aiSearchEndpoints.reconciliation,1000);if(rows.length===1000)invalid();
 const matches=rows.filter(row=>object(row)&&own(row,'url')&&row.url===pathFor(aiSearchEndpoints.live).join('/')&&own(row,'metadata')&&matchesPayload(row.metadata,request,id));
 if(matches.length!==1)invalid();return chargeRow(matches[0]);
}
