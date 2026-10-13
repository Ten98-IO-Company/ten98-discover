import {z} from 'zod';
import {normalizePublicHostname} from './domains.ts';
import {InputError} from './validation.ts';
import {validText,microUsd,providerMicros} from './keyword-research-input.ts';

export const rankSerpEndpoints={
  live:'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
  queued:'https://api.dataforseo.com/v3/serp/google/organic/task_post',
  task:'https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/',
  locations:'https://api.dataforseo.com/v3/serp/google/locations',
  languages:'https://api.dataforseo.com/v3/serp/google/languages',
  reconcile:'https://api.dataforseo.com/v3/serp/id_list',
} as const;
export type RankMethod='live'|'queued';
export type RankDevice='desktop'|'mobile';
export type RankSerpRequest={keyword:string;domain:string;locationCode:number;languageCode:string;device:RankDevice;depth:number;maxCrawlPages:number};
const requestInput=z.object({keyword:z.string().refine(value=>validText(value,200)&&value.trim()===value),domain:z.string(),locationCode:z.number().int().min(1).max(2147483647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?(?![\s\S])/),device:z.enum(['desktop','mobile']),depth:z.number().int().min(10).max(100).multipleOf(10),maxCrawlPages:z.number().int().min(1).max(10)}).strict();
function bad():never{throw new InputError(400,'Check the rank request and coverage settings.');}
export function parseRankSerpRequest(raw:unknown):RankSerpRequest {
  const parsed=requestInput.safeParse(raw);if(!parsed.success)bad();
  let domain:string;try{domain=normalizePublicHostname(parsed.data.domain);}catch{bad();}
  return {...parsed.data,domain};
}
export function rankTaskTag(id:string){if(typeof id!=='string'||id.length!==36||!z.uuid().safeParse(id).success)bad();return 'ten98:rank:'+id.toLowerCase();}
export function rankSerpPayload(raw:RankSerpRequest,id:string,method:RankMethod){
  const request=parseRankSerpRequest(raw);if(method!=='live'&&method!=='queued')bad();
  // DataForSEO decodes percent escapes and '+' once. Escape only these characters
  // to preserve the authored query, including literal C++ and %20, without inflation.
  return {keyword:request.keyword.replace(/%/g,'%25').replace(/\+/g,'%2B'),location_code:request.locationCode,language_code:request.languageCode,device:request.device,os:request.device==='desktop'?'windows':'android',depth:request.depth,max_crawl_pages:request.maxCrawlPages,
    stop_crawl_on_match:[{match_value:request.domain,match_type:'with_subdomains'}],find_targets_in:['organic'],tag:rankTaskTag(id),...(method==='queued'?{priority:1}:{}),load_async_ai_overview:false,calculate_rectangles:false};
}

const operators=/(?:allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/gi;
export function rankEstimateMicros(baseMicros:bigint,raw:RankSerpRequest){
  const request=parseRankSerpRequest(raw);
  if(typeof baseMicros!=='bigint'||baseMicros<=0n||baseMicros>1000000000000n)throw new Error('Unsupported SERP price.');
  const operatorCount=[...request.keyword.matchAll(operators)].length;
  // Current pricing says "per operator", while its FAQ describes a single x5.
  // x5 per occurrence conservatively covers both readings; never copy old 75% pages.
  const multiplier=5n**BigInt(operatorCount),maximum=baseMicros*BigInt(request.maxCrawlPages)*multiplier;
  if(maximum>1000000000000n)throw new InputError(400,'This conservative rank quote exceeds the supported charge limit. Narrow the query or page limit.');
  return {maximumMicros:maximum,maximumUsd:microUsd(maximum),operatorCount,multiplier:multiplier.toString()};
}
type RecordValue=Record<string,any>;
const object=(value:unknown):value is RecordValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function parseRankBasePrices(account:unknown){
  if(!object(account))throw new Error('Unsupported SERP price.');
  function price(value:unknown,free=false){
    if(!Array.isArray(value)||value.length!==1||!object(value[0])||value[0].cost_type!=='per_request')throw new Error('Unsupported SERP price.');
    const amount=providerMicros(value[0].cost);
    if(free?amount!==0n:amount<=0n)throw new Error('Unsupported SERP price.');return amount;
  }
  const serp=account.price?.serp;
  // Verify retrieval stays free before approving queued work. Account endpoint is
  // shared across engines; these are its documented SERP basic-price fields.
  price(serp?.task_get?.advanced?.priority_normal,true);
  return {liveMicros:price(serp?.live?.advanced?.priority_normal),queuedMicros:price(serp?.task_post?.priority_normal)};
}
