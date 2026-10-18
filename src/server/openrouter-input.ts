import {toUSVString} from 'node:util';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {openRouterModelId,openRouterRouteIdentity,openRouterTextProfile,type OpenRouterRequestProfile} from '../lib/openrouter-models.ts';

export type PromptModel=string;
export type OpenRouterModel=string;
export const executionInput=z.object({connectionId:z.uuid(),promptId:z.uuid(),versionId:z.uuid(),
  systemText:z.string().max(4000).refine(v=>toUSVString(v)===v&&!/[\x00\x0b\x0c]/.test(v)),
  models:z.array(z.string().refine(openRouterModelId)).min(1).max(4).refine(v=>new Set(v).size===v.length),
  maxCompletionTokens:z.number().int().min(16).max(4096),fundedCredits:z.literal(true),reuseCached:z.boolean().optional()}).strict();
export function executionParse<T extends z.ZodType>(schema:T,input:unknown):z.output<T>{const result=schema.safeParse(input);if(!result.success)throw new FoundationError(400,'Check the prompt execution fields and try again.');return result.data;}
export type ExecutionInput=z.infer<typeof executionInput>;
export type RenderedInput={role:'system'|'user';content:string}[];

// Only the user prompt collapses whitespace. System messages and inference policy remain exact.
export function promptCacheKey(workspaceId:string,projectId:string,input:ExecutionInput,messages:RenderedInput,route:RouteSnapshot,canonicalSlug:string,connectionRevision:number,fingerprint:string){
 return createHash('sha256').update(JSON.stringify({version:'prompt-answer-cache-v1',workspaceId,projectId,connectionId:input.connectionId,connectionRevision,fingerprint,
  model:route.model,canonicalSlug,provider:route.tag,providerName:route.providerName,profile:route.profile??'openrouter-api-text-no-search-v1',
  system:messages.find(m=>m.role==='system')?.content??null,prompt:messages[messages.length-1].content.trim().replace(/\s+/g,' '),maxCompletionTokens:input.maxCompletionTokens,
  stream:false,serviceTier:'default',fallback:false,compression:route.profile===openRouterTextProfile?false:null,webSearch:false,country:null})).digest('hex');
}

// Decimal coefficients stay exact until the single conservative microUSD rounding step.
// Limits bound exponentiation and payload parsing, not provider pricing assumptions.
export function decimal(value:string){
  if(typeof value!=='string'||value.length>100)throw new Error('Unsupported decimal.');
  const m=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if(!m)throw new Error('Unsupported decimal.');
  const exponent=Number(m[3]??0),fraction=m[2]??'';
  if(Math.abs(exponent)>36||fraction.length>36)throw new Error('Unsupported decimal precision.');
  const scale=fraction.length-exponent,coefficient=BigInt(m[1]+fraction);
  return scale<0?{coefficient:coefficient*10n**BigInt(-scale),scale:0}:{coefficient,scale};
}
export function decimalSumMicros(terms:{price:string;count:number}[]):bigint{
  if(!terms.length||terms.length>10)throw new Error('Unsupported price terms.');
  const values=terms.map(({price,count})=>{if(!Number.isSafeInteger(count)||count<0||count>2_000_000)throw new Error('Unsupported count.');return {...decimal(price),count:BigInt(count)};});
  const scale=Math.max(6,...values.map(v=>v.scale));
  const amount=values.reduce((sum,v)=>sum+v.coefficient*v.count*10n**BigInt(scale-v.scale),0n),divisor=10n**BigInt(scale-6);
  return (amount+divisor-1n)/divisor;
}
export function decimalText(value:string,multiplyByMillion=false){
  const d=decimal(value),scale=d.scale-(multiplyByMillion?6:0);
  if(scale<=0)return (d.coefficient*10n**BigInt(-scale)).toString();
  const digits=d.coefficient.toString().padStart(scale+1,'0');return `${digits.slice(0,-scale)}.${digits.slice(-scale)}`;
}
export class ExactCost {source:string;constructor(source:string){this.source=source;}}
const moneyFields=new Set(['cost','total_cost','upstream_inference_cost']);
type NativeJson=typeof JSON&{rawJSON:(value:string)=>unknown;parse:(text:string,reviver:(key:string,value:any,context?:{source?:string})=>any)=>any};
export function parseOpenRouterJson(text:string):any{
  return (JSON as NativeJson).parse(text,(key:string,value:any,context?:{source?:string})=>{
    if(moneyFields.has(key)&&typeof value==='number'){
      if(!context?.source)throw new Error('Node 24 exact JSON parsing is required.');
      return new ExactCost(context.source);
    }return value;
  });
}
function exactJsonNumber(value:string){return (JSON as NativeJson).rawJSON(decimalText(value));}
export type RouteSnapshot={model:OpenRouterModel;tag:string;providerName:string;promptCapacity:number;completionCapacity:number;promptPrice:string;completionPrice:string;requestPrice:string;estimateMicros:string;profile?:OpenRouterRequestProfile;contextLength?:number};
export function validateExecutionPayload(messages:RenderedInput,route:RouteSnapshot,maxCompletionTokens:number,structured=false){
 if(!openRouterRouteIdentity(route))throw new FoundationError(409,'The saved model route is unsupported. Prepare a new quote.');
 if(route.profile===undefined)return; // Exact legacy quotes retain their original request policy.
 if(!Array.isArray(messages)||messages.length<1||messages.length>2||messages.some((m,i)=>!m||Object.keys(m).length!==2||m.role!==(i===messages.length-1?'user':'system')||typeof m.content!=='string'||toUSVString(m.content)!==m.content||m.content.includes('\0'))||
  !Number.isInteger(maxCompletionTokens)||maxCompletionTokens<16||maxCompletionTokens>4096||maxCompletionTokens>route.completionCapacity||maxCompletionTokens>=route.contextLength!||
  Buffer.byteLength(JSON.stringify(messages),'utf8')>(structured?131_072:32_768))throw new FoundationError(413,'The text request exceeds this model profile’s payload or output limits. Narrow the input or choose another model.');
}
export function executionBody(messages:RenderedInput,route:RouteSnapshot,maxCompletionTokens:number,runId:string,actor:string,structured=false){
  validateExecutionPayload(messages,route,maxCompletionTokens,structured);
  return {model:route.model,messages,max_completion_tokens:maxCompletionTokens,stream:false,service_tier:'default',
    provider:{only:[route.tag],order:[route.tag],allow_fallbacks:false,require_parameters:true,
      max_price:{prompt:exactJsonNumber(decimalText(route.promptPrice,true)),completion:exactJsonNumber(decimalText(route.completionPrice,true)),request:exactJsonNumber(route.requestPrice)}},
    session_id:runId,user:actor,...(route.profile===openRouterTextProfile?{plugins:[{id:'context-compression',enabled:false}]}:{})};
}
