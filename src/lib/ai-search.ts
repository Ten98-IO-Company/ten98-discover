import {z} from 'zod';

export const aiSearchProfileId='dfs-chatgpt-live-advanced-v1' as const;
export const aiSearchPriceVersion='dfs-chatgpt-live-published-2026-10-15-v1' as const;
export const aiSearchSource='DataForSEO / ChatGPT consumer interface' as const;
export const aiSearchEndpoints={
 live:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
 locations:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/locations',
 languages:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/languages',
 reconciliation:'https://api.dataforseo.com/v3/ai_optimization/id_list',
} as const;

const clean=(s:string)=>Array.from(s).every(c=>{const n=c.codePointAt(0)!;return n<0xd800||n>0xdfff;})&&!/[\u0000-\u001f\u007f-\u009f]/.test(s);
export const aiSearchRequestSchema=z.object({profileId:z.literal(aiSearchProfileId),
 capturedPrompt:z.string().min(1).max(2000).refine(v=>v.trim().length>0&&clean(v)&&v.replaceAll('%','%25').replaceAll('+','%2B').length<=2000),
 locationCode:z.number().int().min(1).max(2_147_483_647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$(?![\s\S])/),
}).strict();
export type AiSearchRequest=z.infer<typeof aiSearchRequestSchema>;
export type AiSearchCountry={code:number;name:string;countryCode:string};
export type AiSearchLanguage={code:string;name:string};

// Published tariff, not an authenticated account quote or remotely enforced maximum.
// A2 must show/revalidate this basis, reserve before dispatch and settle/pause overruns.
export function aiSearchPriceEvidence(){return {version:aiSearchPriceVersion,profileId:aiSearchProfileId,mode:'published-tariff' as const,
 sourceUrl:'https://dataforseo.com/pricing/ai-optimization/llm-scraper',checkedOn:'2026-10-15',
 billingUnit:'result' as const,maximumResults:1 as const,unitMicros:'4000',estimateMicros:'4000',estimateUsd:'0.004000',
 limitation:'Published-price estimate; not an account-enforced maximum.'};}

export function aiSearchPayload(raw:unknown,runId:string){
 const request=aiSearchRequestSchema.parse(raw);
 if(typeof runId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/.test(runId))throw new Error('Invalid search capture request.');
 return {keyword:request.capturedPrompt.replaceAll('%','%25').replaceAll('+','%2B'),location_code:request.locationCode,
  language_code:request.languageCode,force_web_search:true as const,tag:'ten98:ai-search:'+runId};
}
