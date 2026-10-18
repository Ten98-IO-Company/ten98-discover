import {toUSVString} from 'node:util';
import {z} from 'zod';
import {FoundationError} from './auth.ts';

const keywordModes = ['overview','ideas'] as const;
export type KeywordMode = typeof keywordModes[number];
export type KeywordRequest = {connectionId:string;mode:KeywordMode;keywords:string[];locationCode:number;languageCode:string;limit:25|50|100};
export type KeywordMarket = {locationCode:number;locationName:string;languageCode:string;languageName:string};
export type KeywordRow = {keyword:string;searchVolume:number|null;cpcUsd:string|null;competition:number|null;competitionLevel:'LOW'|'MEDIUM'|'HIGH'|null;keywordDifficulty:number|null;intent:string|null;monthlySearches:{year:number;month:number;searchVolume:number|null}[];metricsUpdatedAt:string|null;intentUpdatedAt:string|null};
export type KeywordResult = {retrievedAt:string;source:'DataForSEO Labs / Google';rows:KeywordRow[];missingKeywords:string[];totalCount:number|null;limited:boolean};
export const keywordEndpoints = {overview:'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live',ideas:'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live'} as const;
export const keywordCatalogEndpoint = 'https://api.dataforseo.com/v3/dataforseo_labs/locations_and_languages';
export const keywordAccountEndpoint = 'https://api.dataforseo.com/v3/appendix/user_data';
export const keywordReconcileEndpoint = 'https://api.dataforseo.com/v3/dataforseo_labs/id_list';

function keywordBad(message='Check the keyword research fields and try again.'):never {throw new FoundationError(400,message);}
export function validText(value:unknown,max:number):value is string {return typeof value==='string'&&value.length>0&&value.length<=max&&toUSVString(value)===value&&!/[\x00-\x1f\x7f]/.test(value);}
export function normalizeKeyword(value:string) {
  if(toUSVString(value)!==value||/[\x00-\x1f\x7f]/.test(value))keywordBad();
  const normalized=value.trim().replace(/\s+/gu,' ').toLowerCase();
  if(!normalized||Array.from(normalized).length>80||normalized.split(' ').length>10)keywordBad('Use keywords of 1–80 characters and at most 10 words.');
  return normalized;
}
export function parseKeywordRequest(raw:unknown):KeywordRequest {
  const input=z.object({connectionId:z.uuid(),mode:z.enum(keywordModes),keywords:z.array(z.string().max(500)).min(1).max(100),locationCode:z.number().int().positive().max(2_147_483_647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),limit:z.union([z.literal(25),z.literal(50),z.literal(100)])}).strict().safeParse(raw);
  if(!input.success)keywordBad();
  const data={...input.data,keywords:[...new Set(input.data.keywords.map(normalizeKeyword))]};
  if(data.mode==='ideas'&&data.keywords.length!==1)keywordBad('Keyword ideas requires exactly one seed keyword.');
  if(data.mode==='overview'&&data.limit!==100)keywordBad('Keyword overview accepts up to 100 explicit keywords.');
  return data;
}

// Parse JSON's canonical decimal/exponent spelling without multiplying binary floats.
// Reject finer-than-micro costs rather than quietly changing financial evidence.
export function providerMicros(value:unknown):bigint {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1_000_000)throw new Error('Unsupported provider cost.');
  const match=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if(!match)throw new Error('Unsupported provider cost.');
  const fraction=match[2]??'',digits=BigInt(match[1]+fraction),scale=fraction.length-Number(match[3]??0);
  if(scale<=6)return digits*10n**BigInt(6-scale);
  const divisor=10n**BigInt(scale-6);
  if(digits%divisor!==0n)throw new Error('Unsupported provider cost precision.');
  return digits/divisor;
}
export function microUsd(value:bigint):string {return `${value/1_000_000n}.${String(value%1_000_000n).padStart(6,'0')}`;}
function keywordTag(id:string){return `ten98:keyword:${id}`;}
export function keywordPayload(request:KeywordRequest,id:string){return {keywords:request.keywords,location_code:request.locationCode,language_code:request.languageCode,include_clickstream_data:false,include_serp_info:false,...(request.mode==='ideas'?{ignore_synonyms:true,closely_variants:false,limit:request.limit,offset:0}:{}),tag:keywordTag(id)};}
export function matchesKeywordPayload(data:unknown,request:KeywordRequest,id:string) {
  if(!data||typeof data!=='object'||Array.isArray(data))return false;
  const object=data as Record<string,unknown>;
  return Object.entries(keywordPayload(request,id)).every(([key,value])=>JSON.stringify(object[key])===JSON.stringify(value));
}
