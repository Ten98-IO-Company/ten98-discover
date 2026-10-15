import {createHash} from 'node:crypto';
import {z} from 'zod';
import {openRouterModelId,openRouterMetadataBytes,type OpenRouterCatalog,type OpenRouterCatalogModel} from '../lib/openrouter-models.ts';
import {decimal,decimalText} from './openrouter-input.ts';
import {FoundationError} from './auth.ts';
import {withContentProject} from './project-context.ts';

export const openRouterCatalogLimits={ttlMs:3_600_000,pageSize:500,pages:4,pageBytes:2_097_152,totalBytes:8_388_608,timeoutMs:10_000} as const;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(v);
const capacity=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_000_000?Number(v):null;
const invalid=()=>new Error('Unsupported model catalog.');
export function boundedOpenRouterMetadata<T>(value:T):T{
 if(Buffer.byteLength(JSON.stringify(value))>openRouterMetadataBytes)throw new FoundationError(413,'The model metadata exceeds the complete response limit.');return value;
}
function price(v:unknown):string|null{try{return typeof v==='string'?decimalText(v):null;}catch{return null;}}
export function modelCatalogRow(raw:unknown,today=new Date().toISOString().slice(0,10)):OpenRouterCatalogModel{
 if(!object(raw)||!openRouterModelId(raw.id)||!openRouterModelId(raw.canonical_slug)||!bounded(raw.name,256))throw invalid();
 const pricing=object(raw.pricing)?raw.pricing:{},parameters=Array.isArray(raw.supported_parameters)&&raw.supported_parameters.length<=100&&raw.supported_parameters.every((p:unknown)=>bounded(p,80))?raw.supported_parameters:null;
 const promptPrice=price(pricing.prompt),completionPrice=price(pricing.completion),requestPrice=price(pricing.request===undefined?'0':pricing.request);
 let reason:string|null=null;
 const architecture=raw.architecture,contextLength=capacity(raw.context_length),maxCompletionTokens=capacity(raw.top_provider?.max_completion_tokens);
 const expirationDate=raw.expiration_date===undefined||raw.expiration_date===null?null:typeof raw.expiration_date==='string'&&/^\d{4}-\d\d-\d\d$/.test(raw.expiration_date)&&Number.isFinite(Date.parse(raw.expiration_date))&&new Date(raw.expiration_date).toISOString().slice(0,10)===raw.expiration_date?raw.expiration_date:null;
 if(raw.expiration_date!=null&&expirationDate===null)reason='The retirement date could not be verified.';
 if(!object(architecture)||!Array.isArray(architecture.input_modalities)||!architecture.input_modalities.includes('text')||!Array.isArray(architecture.output_modalities)||architecture.output_modalities.length!==1||architecture.output_modalities[0]!=='text')reason='Only text-input, text-output profiles are supported.';
 if(!contextLength||!maxCompletionTokens||!parameters||!parameters.some((p:string)=>p==='max_tokens'||p==='max_completion_tokens'))reason='Finite context and output limits could not be verified.';
 if((raw.reasoning!=null&&(!object(raw.reasoning)||raw.reasoning.mandatory!==false||raw.reasoning.default_enabled!==false))||parameters?.includes('reasoning')&&(!object(raw.reasoning)||raw.reasoning.mandatory!==false||raw.reasoning.default_enabled!==false))reason='Reasoning billing is not supported by this profile.';
 if(promptPrice===null||completionPrice===null||requestPrice===null)reason='Published token or request prices could not be verified.';
 const allowed=['prompt','completion','request','image','input_cache_read','input_cache_write','web_search','internal_reasoning'];
 for(const [key,value]of Object.entries(pricing)){
  if(key==='discount'){if(value!==0)reason='Discount-dependent billing is not supported.';continue;}
  if(!allowed.includes(key)||price(value)===null){reason='Conditional or unknown pricing is not supported.';continue;}
  if(['input_cache_write','web_search','internal_reasoning'].includes(key)&&decimal(value as string).coefficient!==0n)reason='This profile cannot safely bound the additional charge.';
 }
 if(promptPrice!==null&&pricing.input_cache_read!==undefined){const a=decimal(promptPrice),b=price(pricing.input_cache_read);if(b!==null){const d=decimal(b),s=Math.max(a.scale,d.scale);if(d.coefficient*10n**BigInt(s-d.scale)>a.coefficient*10n**BigInt(s-a.scale))reason='Cache-read pricing exceeds the uncached input price.';}}
 if(promptPrice!==null&&completionPrice!==null&&requestPrice!==null&&[promptPrice,completionPrice,requestPrice].every(p=>decimal(p).coefficient===0n))reason='Free routes need a separate zero-reservation accounting profile.';
 if(raw.id.startsWith('openrouter/')||/:(?:online|nitro|floor)$/.test(raw.id))reason='Automatic model or routing aliases are not supported.';
 if(expirationDate!==null&&expirationDate<=today)reason='This model is retired or scheduled to retire today.';
 return {id:raw.id,canonicalSlug:raw.canonical_slug,name:raw.name,contextLength,maxCompletionTokens,promptPrice,completionPrice,requestPrice,
  structuredOutput:!!parameters&&['structured_outputs','response_format'].every(p=>parameters.includes(p)),expirationDate,admission:reason?'unsupported':'candidate',reason};
}
// ponytail: one bounded public snapshot per process; replicas may differ until refresh.
// Quotes verify live endpoint prices independently; use shared caching only if measured load needs it.
let cached:{models:OpenRouterCatalogModel[];fetchedAt:string;revision:string}|null=null,failed=false,inFlight:Promise<void>|null=null;
export function cachedOpenRouterModels(now=Date.now()):OpenRouterCatalog{
 return {version:'openrouter-text-catalog-v1',status:cached?(failed||now-Date.parse(cached.fetchedAt)>=openRouterCatalogLimits.ttlMs?'stale':'fresh'):'unavailable',
  fetchedAt:cached?.fetchedAt??null,revision:cached?.revision??null,complete:cached!==null,models:cached?structuredClone(cached.models):[]};
}
export async function refreshOpenRouterCatalog(send:typeof fetch=fetch):Promise<OpenRouterCatalog>{
 if(!inFlight)inFlight=Promise.resolve().then(async()=>{try{
  const signal=AbortSignal.timeout(openRouterCatalogLimits.timeoutMs),models:OpenRouterCatalogModel[]=[],ids=new Set<string>();let total:number|undefined,bytes=0;
  for(let page=0;page<openRouterCatalogLimits.pages;page++){
   signal.throwIfAborted();const response=await send(`https://openrouter.ai/api/v1/models?output_modalities=text&offset=${page*openRouterCatalogLimits.pageSize}&limit=${openRouterCatalogLimits.pageSize}`,{headers:{accept:'application/json'},redirect:'error',credentials:'omit',signal});
   if(!response.ok||response.redirected||!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||!response.body){await response.body?.cancel();throw invalid();}
   const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
   let body:unknown;try{for(;;){signal.throwIfAborted();const item=await reader.read();signal.throwIfAborted();if(item.done)break;size+=item.value.byteLength;bytes+=item.value.byteLength;if(size>openRouterCatalogLimits.pageBytes||bytes>openRouterCatalogLimits.totalBytes)throw invalid();parts.push(item.value);}body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
   finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
   if(!object(body)||!Array.isArray(body.data)||body.data.length>openRouterCatalogLimits.pageSize||!Number.isSafeInteger(body.total_count)||body.total_count<0||body.total_count>2000||!object(body.links)||!('next'in body.links))throw invalid();
   if(total!==undefined&&total!==body.total_count)throw invalid();total=body.total_count;
   for(const raw of body.data){const row=modelCatalogRow(raw);if(ids.has(row.id))throw invalid();ids.add(row.id);models.push(row);}
   if(total===undefined||models.length>total)throw invalid();const complete=models.length===total;
   const next=complete?null:`/api/v1/models?output_modalities=text&offset=${(page+1)*openRouterCatalogLimits.pageSize}&limit=${openRouterCatalogLimits.pageSize}`;
   if(complete){if(body.links.next!==null)throw invalid();models.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);const serialized=JSON.stringify(models),next={models,fetchedAt:new Date().toISOString(),revision:createHash('sha256').update(serialized).digest('hex')};
    // Both metadata routes need the envelope; execution setup also repeats candidate IDs.
    boundedOpenRouterMetadata({role:'editor',catalog:{version:'openrouter-text-catalog-v1',status:'fresh',...next,complete:true},models:models.filter(m=>m.admission==='candidate').map(m=>m.id)});
    cached=next;failed=false;return;}
   if(body.data.length!==openRouterCatalogLimits.pageSize||typeof body.links.next!=='string')throw invalid();
   // Never follow links. Check only the fixed same-origin next-page semantics.
   const link=new URL(body.links.next,'https://openrouter.ai');const expected=new URL(next!,'https://openrouter.ai');
   if(link.origin!==expected.origin||link.pathname!==expected.pathname||link.hash||link.username||link.password||[...link.searchParams.keys()].some(k=>!['offset','limit','output_modalities'].includes(k)||link.searchParams.getAll(k).length!==1)||link.searchParams.get('offset')!==expected.searchParams.get('offset')||link.searchParams.get('limit')!==expected.searchParams.get('limit')||link.searchParams.has('output_modalities')&&link.searchParams.get('output_modalities')!=='text')throw invalid();
  }throw invalid();
 }catch{failed=true;throw new FoundationError(502,'Could not refresh the model catalog. Saved runs remain available. Try again.');}finally{inFlight=null;}});
 await inFlight;return cachedOpenRouterModels();
}
export async function requireCatalogModels(models:string[],send:typeof fetch=fetch,structured=false){
 let catalog=cachedOpenRouterModels();if(catalog.status!=='fresh')catalog=await refreshOpenRouterCatalog(send);
 for(const id of models){const row=catalog.models.find(m=>m.id===id);if(!row||row.admission!=='candidate'||row.expirationDate!==null&&row.expirationDate<=new Date().toISOString().slice(0,10)||structured&&!row.structuredOutput)throw new FoundationError(409,row?.reason??'This model is not a supported candidate. Refresh models or choose another model.');}
}
export function getOpenRouterModels(projectId:string,userId:string){return withContentProject(projectId,userId,false,async(_client,p)=>boundedOpenRouterMetadata({role:p.role,catalog:cachedOpenRouterModels()}));}
export async function refreshOpenRouterModels(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
 if(!z.object({}).strict().safeParse(raw).success)throw new FoundationError(400,'Model refresh does not accept options.');
 await withContentProject(projectId,userId,true,async()=>{});await refreshOpenRouterCatalog(send);
 return withContentProject(projectId,userId,true,async(_client,p)=>boundedOpenRouterMetadata({role:p.role,catalog:cachedOpenRouterModels()}));
}
