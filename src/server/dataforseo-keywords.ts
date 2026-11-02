import {createHmac} from 'node:crypto';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {getProviderAccountIdentityKey} from './provider-account-identity.ts';
import {dataforseoJson,dataforseoRefusal,dataforseoRefusalEvidence,dataforseoRefusalMessage} from './dataforseo-transport.ts';
import {keywordAccountEndpoint,keywordCatalogEndpoint,keywordEndpoints,keywordPayload,keywordReconcileEndpoint,matchesKeywordPayload,microUsd,providerMicros,validText,type KeywordMarket,type KeywordMode,type KeywordRequest,type KeywordResult,type KeywordRow} from './keyword-research-input.ts';

type ObjectValue=Record<string,any>;
const object=(v:unknown):v is ObjectValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never {throw new Error('Unsupported provider response.');}
// Explicit final outcomes from DataForSEO appendix/errors. Queued, unknown and server-error
// statuses do not establish a final request outcome.
const finalTaskStatuses=new Set([20000,40102,40103,40106,40501,40502,40503,40504,40505,40506]);
function finalTaskStatus(value:unknown):value is number {return typeof value==='number'&&finalTaskStatuses.has(value);}
export async function keywordProviderJson(url:string,credentials:unknown,body:unknown,send:typeof fetch=fetch) {
  if(![keywordAccountEndpoint,keywordCatalogEndpoint,keywordReconcileEndpoint,...Object.values(keywordEndpoints)].includes(url))invalid();
  return dataforseoJson(url,credentials,body===undefined?'GET':'POST',body,send);
}
function taskEnvelope(body:unknown) {
  if(!object(body)||!Number.isInteger(body.status_code)||!Array.isArray(body.tasks)||body.tasks.length!==1||body.tasks_count!==1||!object(body.tasks[0]))invalid();
  return {body,task:body.tasks[0] as ObjectValue};
}
function successfulFree(response:{httpStatus:number;body:unknown}) {
  const {body,task}=taskEnvelope(response.body);
  if(response.httpStatus!==200||body.status_code!==20000||task.status_code!==20000||!Array.isArray(task.result))invalid();
  return task.result as unknown[];
}
export function parseKeywordMarkets(response:{httpStatus:number;body:unknown}):KeywordMarket[] {
  const rows=successfulFree(response);if(rows.length>500)invalid();
  const markets:KeywordMarket[]=[];const ids=new Set<string>();
  for(const row of rows){if(!object(row)||!['Country','Region'].includes(row.location_type)||!Number.isSafeInteger(row.location_code)||row.location_code<=0||!validText(row.location_name,200)||!Array.isArray(row.available_languages)||row.available_languages.length>100)invalid();
    for(const language of row.available_languages){if(!object(language)||!Array.isArray(language.available_sources))invalid();if(!language.available_sources.includes('google'))continue;
      if(!validText(language.language_name,80)||typeof language.language_code!=='string'||!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language.language_code))invalid();
      const key=`${row.location_code}:${language.language_code}`;if(ids.has(key))invalid();ids.add(key);
      markets.push({locationCode:row.location_code,locationName:row.location_name,languageCode:language.language_code,languageName:language.language_name});
    }
  }
  if(!markets.length||markets.length>5000)invalid();
  return markets.sort((a,b)=>a.locationName.localeCompare(b.locationName)||a.languageName.localeCompare(b.languageName));
}
type LabsOperation=KeywordMode|'ranked_keywords'|'domain_rank_overview'|'relevant_pages'|'competitors_domain'|'backlinks_summary'|'backlinks_profile'|'backlinks_referring_domains'|'backlinks_anchors';
export function parseKeywordAccount(response:{httpStatus:number;body:unknown},_mode?:LabsOperation,binding={key:getConfig().authSecret,version:1 as 1|2}) {
  const result=successfulFree(response);if(result.length!==1||!object(result[0])||!validText(result[0].login,254))invalid();
  const row=result[0];
  const fingerprint=createHmac('sha256',binding.key).update(`ten98.dataforseo.account.v${binding.version}:`+row.login.trim().toLowerCase()).digest('hex');
  return {fingerprint};
}
export async function readKeywordMarkets(credentials:unknown,send:typeof fetch=fetch){try{return parseKeywordMarkets(await keywordProviderJson(keywordCatalogEndpoint,credentials,undefined,send));}catch{throw new FoundationError(502,'Could not load supported DataForSEO markets. Check the connection and try again.');}}
export async function readKeywordAccount(credentials:unknown,mode?:LabsOperation,send:typeof fetch=fetch,version:1|2=2){const key=await getProviderAccountIdentityKey(version);try{return parseKeywordAccount(await keywordProviderJson(keywordAccountEndpoint,credentials,undefined,send),mode,{key,version});}catch{throw new FoundationError(502,'Could not verify the DataForSEO account identity. Check the connection and try again.');}}
function metric(value:unknown,maximum=Number.MAX_SAFE_INTEGER,integer=false):number|null {if(value==null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>maximum||(integer&&!Number.isSafeInteger(value)))invalid();return value;}
function timestamp(value:unknown):string|null {if(value==null)return null;if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})? ?(?:Z|\+00:00)$/.test(value))invalid();const date=new Date(value.replace(' ','T').replace(' +00:00','+00:00'));if(!Number.isFinite(date.getTime()))invalid();return date.toISOString();}
function parseRow(raw:unknown):KeywordRow {
  if(!object(raw)||!validText(raw.keyword,500))invalid();
  const info=raw.keyword_info??{},properties=raw.keyword_properties??{},intent=raw.search_intent_info??{};
  if(!object(info)||!object(properties)||!object(intent))invalid();
  const level=info.competition_level??null;if(level!==null&&!['LOW','MEDIUM','HIGH'].includes(level))invalid();
  const main=intent.main_intent??null;if(main!==null&&!['informational','commercial','transactional','navigational'].includes(main))invalid();
  const monthly=info.monthly_searches??[];if(!Array.isArray(monthly)||monthly.length>120)invalid();
  const seen=new Set<string>();
  const monthlySearches=monthly.map(value=>{if(!object(value)||!Number.isInteger(value.year)||value.year<1970||value.year>9999||!Number.isInteger(value.month)||value.month<1||value.month>12)invalid();const key=`${value.year}-${value.month}`;if(seen.has(key))invalid();seen.add(key);return {year:value.year,month:value.month,searchVolume:metric(value.search_volume,Number.MAX_SAFE_INTEGER,true)};}).sort((a,b)=>a.year-b.year||a.month-b.month);
  return {keyword:raw.keyword,searchVolume:metric(info.search_volume,Number.MAX_SAFE_INTEGER,true),cpcUsd:info.cpc==null?null:microUsd(providerMicros(info.cpc)),competition:metric(info.competition,1),competitionLevel:level,keywordDifficulty:metric(properties.keyword_difficulty,100),intent:main,monthlySearches,metricsUpdatedAt:timestamp(info.last_updated_time),intentUpdatedAt:timestamp(intent.last_updated_time)};
}
function outputKeyword(key:string){try{return decodeURIComponent(key.replaceAll('+',' ')).trim().replace(/\s+/gu,' ').toLowerCase();}catch{return key;}}
export type KeywordOutcome={known:boolean;reference:string|null;result:KeywordResult|null;diagnostic:string|null;evidence:{httpStatus:number|null;statusCode:number|null;taskStatus:number|null}};
export function parseKeywordOutcome(response:{httpStatus:number;body:unknown},request:KeywordRequest,id:string,now=new Date()):KeywordOutcome {
  const outcome:KeywordOutcome={known:false,reference:null,result:null,diagnostic:'The provider response could not be verified. Recover the original request before requesting again.',evidence:{httpStatus:response.httpStatus,statusCode:null,taskStatus:null}};
  try{
    const refused=dataforseoRefusal(response);if(refused)return {...outcome,known:true,diagnostic:dataforseoRefusalMessage[refused],evidence:dataforseoRefusalEvidence(response)};
    const {body,task}=taskEnvelope(response.body);
    if(!validText(task.id,128)||!matchesKeywordPayload(task.data,request,id)||!Array.isArray(task.path)||JSON.stringify(task.path)!==JSON.stringify(new URL(keywordEndpoints[request.mode]).pathname.slice(1).split('/')))return outcome;
    outcome.reference=task.id;outcome.evidence={httpStatus:response.httpStatus,statusCode:body.status_code,taskStatus:Number.isInteger(task.status_code)?task.status_code:null};
    if(response.httpStatus!==200||body.status_code!==20000||!finalTaskStatus(task.status_code))return outcome;
    outcome.known=true;
    if(response.httpStatus!==200||body.status_code!==20000||task.status_code!==20000){outcome.diagnostic='The provider did not complete this research.';return outcome;}
    if(!Array.isArray(task.result)||task.result.length!==1||!object(task.result[0]))invalid();const result=task.result[0];
    if(result.location_code!==request.locationCode||result.language_code!==request.languageCode||result.se_type!=='google'||!Array.isArray(result.items)||result.items.length>(request.mode==='overview'?request.keywords.length:request.limit)||result.items_count!==result.items.length)invalid();
    const rows=result.items.map(parseRow),unique=new Set<string>();for(const row of rows){if(unique.has(row.keyword))invalid();unique.add(row.keyword);}
    const returned=new Set(rows.map(row=>outputKeyword(row.keyword)));
    const totalCount=result.total_count==null?null:metric(result.total_count,Number.MAX_SAFE_INTEGER,true);if(totalCount!==null&&totalCount<rows.length)invalid();
    outcome.result={retrievedAt:now.toISOString(),source:'DataForSEO Labs / Google',rows,missingKeywords:request.mode==='overview'?request.keywords.filter(key=>!returned.has(outputKeyword(key))):[],totalCount,limited:request.mode==='ideas'&&(totalCount===null?rows.length===request.limit:totalCount>rows.length)};
    outcome.diagnostic=null;
  }catch{if(outcome.known)outcome.diagnostic='The provider completed the request, but the result format could not be read.';}
  return outcome;
}
export async function requestKeywordResearch(credentials:unknown,request:KeywordRequest,id:string,send:typeof fetch=fetch):Promise<KeywordOutcome> {
  try{return parseKeywordOutcome(await keywordProviderJson(keywordEndpoints[request.mode],credentials,[keywordPayload(request,id)],send),request,id);}
  catch{return {known:false,reference:null,result:null,diagnostic:'The request may have reached the provider. Its outcome is unknown; reconcile it before requesting again.',evidence:{httpStatus:null,statusCode:null,taskStatus:null}};}
}
export function parseKeywordReconciliation(response:{httpStatus:number;body:unknown},request:KeywordRequest,id:string) {
  const items=successfulFree(response);if(items.length>=1000)invalid();
  const matches=items.filter(item=>object(item)&&item.url===new URL(keywordEndpoints[request.mode]).pathname.slice(1)&&matchesKeywordPayload(item.metadata,request,id));
  if(matches.length!==1||!object(matches[0])||!validText(matches[0].id,128)||!['string','number'].includes(typeof matches[0].status)||!/^\d{5}$(?![\s\S])/.test(String(matches[0].status))||!finalTaskStatus(Number(matches[0].status)))invalid();
  return {reference:matches[0].id,statusCode:Number(matches[0].status)};
}
export async function recoverKeywordRequest(credentials:unknown,request:KeywordRequest,id:string,dispatchedAt:Date,send:typeof fetch=fetch) {
  if(Date.now()-dispatchedAt.getTime()>28*86400000)throw new FoundationError(409,'This request is beyond the provider metadata window; its outcome remains unresolved.');
  const stamp=(date:Date)=>date.toISOString().replace('T',' ').slice(0,19)+' +00:00';
  try{return parseKeywordReconciliation(await keywordProviderJson(keywordReconcileEndpoint,credentials,[{datetime_from:stamp(new Date(dispatchedAt.getTime()-60_000)),datetime_to:stamp(new Date(Math.min(Date.now(),dispatchedAt.getTime()+120_000))),limit:1000,offset:0,sort:'asc',include_metadata:true}],send),request,id);}
  catch{throw new FoundationError(409,'The provider metadata did not prove a unique request. This request still needs recovery; check again later or contact the provider.');}
}
