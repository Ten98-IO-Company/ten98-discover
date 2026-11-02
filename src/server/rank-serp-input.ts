import {z} from 'zod';
import {normalizePublicHostname} from './domains.ts';
import {InputError} from './validation.ts';
import {validText} from './keyword-research-input.ts';

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
export const rankLanguagePattern=/^[a-z]{2,3}(?:-(?:[A-Z]{2}|[0-9]{3}|[A-Z][a-z]{3}))?$(?![\s\S])/;
const requestInput=z.object({keyword:z.string().refine(value=>validText(value,200)&&value.trim()===value),domain:z.string(),locationCode:z.number().int().min(1).max(2147483647),languageCode:z.string().regex(rankLanguagePattern),device:z.enum(['desktop','mobile']),depth:z.number().int().min(10).max(100).multipleOf(10),maxCrawlPages:z.number().int().min(1).max(10)}).strict();
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


export {providerRequestDiagnostic as rankRequestDiagnostic} from './providers.ts';
