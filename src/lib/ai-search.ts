import {z} from 'zod';

export const aiSearchProfileId='dfs-chatgpt-live-advanced-v1' as const;
export const aiSearchSource='DataForSEO / ChatGPT consumer interface' as const;
export const aiSearchEndpoints={
 live:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
 locations:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/locations',
 languages:'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/languages',
 reconciliation:'https://api.dataforseo.com/v3/ai_optimization/id_list',
} as const;
const clean=(s:string)=>!/[\uD800-\uDFFF]/u.test(s)&&!/[\u0000-\u001f\u007f-\u009f]/.test(s);
export const aiSearchRequestSchema=z.object({profileId:z.literal(aiSearchProfileId),
 capturedPrompt:z.string().min(1).max(2000).refine(v=>v.trim().length>0&&clean(v)&&v.replaceAll('%','%25').replaceAll('+','%2B').length<=2000),
 locationCode:z.number().int().min(1).max(2_147_483_647),languageCode:z.string().regex(/^[a-z]{2,3}(?:-(?:[A-Z]{2}|[0-9]{3}|[A-Z][a-z]{3}))?$(?![\s\S])/),
}).strict();
export type AiSearchRequest=z.infer<typeof aiSearchRequestSchema>;
export type AiSearchCountry={code:number;name:string;countryCode:string};
export type AiSearchLanguage={code:string;name:string};
export function aiSearchPayload(raw:unknown,runId:string){
 const request=aiSearchRequestSchema.parse(raw);
 if(typeof runId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId))throw new Error('Invalid search capture request.');
 return {keyword:request.capturedPrompt.replaceAll('%','%25').replaceAll('+','%2B'),location_code:request.locationCode,language_code:request.languageCode,force_web_search:true as const,tag:'ten98:ai-search:'+runId};
}
const requestId=z.object({requestId:z.uuid()}).strict(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const aiSearchRefreshInput=z.object({connectionId:z.uuid()}).strict();
export const aiSearchPreparationInput=requestId.extend({connectionId:z.uuid(),promptId:z.uuid(),versionId:z.uuid(),locationCode:aiSearchRequestSchema.shape.locationCode,languageCode:aiSearchRequestSchema.shape.languageCode,expectedCatalogRevision:hash}).strict();
export const aiSearchStartInput=requestId.extend({preparationId:z.uuid()}).strict();
export const aiSearchActionInput=requestId;
export const aiSearchRecoveryInput=requestId.extend({connectionId:z.uuid()}).strict();
export const aiSearchSnapshotSchema=z.object({version:z.literal(2),request:aiSearchRequestSchema,promptId:z.uuid(),versionId:z.uuid(),
 country:z.object({code:z.number().int().positive(),name:z.string().min(1).max(200),countryCode:z.string().regex(/^[A-Z]{2}$/)}).strict(),
 language:z.object({code:aiSearchRequestSchema.shape.languageCode,name:z.string().min(1).max(80)}).strict(),catalogRevision:hash,countriesHash:hash,languagesHash:hash,preparedAt:z.iso.datetime(),
}).strict();
export type AiSearchSnapshot=z.infer<typeof aiSearchSnapshotSchema>;
export type AiSearchRawState='not_recorded'|'retained'|'invalid'|'expired';
export type AiSearchRunStatus='queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled'|'reconciled';
export type AiSearchPreparationDto={id:string;requestId:string;projectId:string;promptId:string;versionId:string;connectionId:string;connectionRevision:number;createdAt:string;expiresAt:string;inputHash:string;rawState:AiSearchRawState;input:AiSearchSnapshot|null};
export type AiSearchRunDto={id:string;preparationId:string;projectId:string;promptId:string;versionId:string;profileId:typeof aiSearchProfileId;status:AiSearchRunStatus;requestStatus:'reserved'|'dispatched'|'uncertain'|'settled'|'cancelled';createdAt:string;dispatchedAt:string|null;completedAt:string|null;settledAt:string|null;reportedModel:string|null;rawState:AiSearchRawState;diagnostic:string|null;canCancel:boolean;canRecover:boolean;result?:import('../server/dataforseo-ai-search.ts').AiSearchCapturedResult|null};
