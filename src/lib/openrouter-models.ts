export const openRouterTextProfile='openrouter-api-text-no-search-v2' as const;
export const openRouterMetadataBytes=2*1024*1024;
export const legacyOpenRouterModels=['openai/gpt-4o-mini','openai/gpt-4o','openai/gpt-4.1-nano','openai/gpt-4.1-mini'] as const;
export type OpenRouterRequestProfile=typeof openRouterTextProfile;
export const openRouterModelId=(v:unknown):v is string=>typeof v==='string'&&v.length<=256&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,191}$/.test(v);
export const openRouterProviderTag=(v:unknown):v is string=>typeof v==='string'&&v.length<=160&&/^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..');
export const openRouterProviderName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160&&v.trim()===v&&!/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(v);
export function openRouterRouteIdentity(v:unknown):v is {model:string;tag:string;providerName:string;profile?:OpenRouterRequestProfile;contextLength?:number}{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as Record<string,unknown>;
 if(!openRouterModelId(r.model)||!openRouterProviderTag(r.tag)||!openRouterProviderName(r.providerName))return false;
 if(r.profile===undefined)return (legacyOpenRouterModels as readonly string[]).includes(r.model)&&r.tag==='openai'&&r.providerName==='OpenAI';
 const capacity=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_000_000;
 const price=(v:unknown)=>typeof v==='string'&&v.length<=140&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
 return r.profile===openRouterTextProfile&&capacity(r.contextLength)&&capacity(r.promptCapacity)&&Number(r.promptCapacity)<=Number(r.contextLength)&&capacity(r.completionCapacity)&&
  price(r.promptPrice)&&price(r.completionPrice)&&price(r.requestPrice)&&typeof r.estimateMicros==='string'&&/^[1-9]\d{0,12}$/.test(r.estimateMicros)&&BigInt(r.estimateMicros)<=1_000_000_000_000n;
}
/** Old insight/citation observations allowed the two fixed OpenAI models without
 * a captured route. Preserve that answer contract, never infer a new model's provider. */
export function openRouterSavedProvider(v:unknown):string|null{
 if(openRouterRouteIdentity(v))return v.providerName;
 if(!v||typeof v!=='object'||Array.isArray(v))return null;const r=v as Record<string,unknown>;
 return r.profile===undefined&&r.tag===undefined&&r.providerName===undefined&&(legacyOpenRouterModels.slice(0,2) as readonly unknown[]).includes(r.model)?'OpenAI':null;
}
export type OpenRouterCatalogModel={id:string;canonicalSlug:string;name:string;contextLength:number|null;maxCompletionTokens:number|null;
 promptPrice:string|null;completionPrice:string|null;requestPrice:string|null;structuredOutput:boolean;expirationDate:string|null;
 admission:'candidate'|'unsupported';reason:string|null};
export type OpenRouterCatalog={version:'openrouter-text-catalog-v1';status:'fresh'|'stale'|'unavailable';fetchedAt:string|null;revision:string|null;complete:boolean;models:OpenRouterCatalogModel[]};
