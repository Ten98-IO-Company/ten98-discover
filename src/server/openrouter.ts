import {toUSVString} from 'node:util';
import {createHmac,createHash} from 'node:crypto';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {usd} from './providers.ts';
import {decimal,decimalSumMicros,decimalText,ExactCost,parseOpenRouterJson,executionBody,type PromptModel,type OpenRouterModel,type RouteSnapshot,type RenderedInput} from './openrouter-input.ts';
import {suggestionSchema,suggestionOutputTokens} from './ai-suggestion-input.ts';
import {contentSupportPurpose,contentSupportSchema,contentSupportLimits} from './ai-content-support-input.ts';
import {legacyOpenRouterModels,openRouterModelId,openRouterProviderName,openRouterProviderTag,openRouterTextProfile,type OpenRouterRequestProfile} from '../lib/openrouter-models.ts';
import {requireCatalogModels} from './openrouter-models.ts';
import {validateExecutionPayload} from './openrouter-input.ts';

const openRouterBase='https://openrouter.ai/api/v1';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw new Error('Unsupported OpenRouter evidence.');}
const positiveInteger=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2_000_000;
export function generationId(value:unknown):value is string{return typeof value==='string'&&/^gen-[0-9A-Za-z-]{1,124}$/.test(value);}
function apiKey(credentials:unknown){if(!object(credentials)||typeof credentials.apiKey!=='string'||!/^[^\s]{1,4096}$/.test(credentials.apiKey))invalid();return credentials.apiKey;}
export function keyFingerprint(credentials:unknown){return createHash('sha256').update('ten98.openrouter.key.v1:'+apiKey(credentials)).digest('hex');}
export function executionActor(userId:string){return createHmac('sha256',getConfig().authSecret).update('ten98.openrouter.actor.v1:'+userId).digest('hex');}
async function responseJson(response:Response){
  if(!response.body)invalid();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_097_152)invalid();parts.push(value);}return parseOpenRouterJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function headers(credentials:unknown){return {authorization:`Bearer ${apiKey(credentials)}`,accept:'application/json'};}
async function read(path:string,credentials:unknown,send:typeof fetch){
  const response=await send(openRouterBase+path,{headers:headers(credentials),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10_000)});
  if(!response.ok){await response.body?.cancel();invalid();}return responseJson(response);
}
function endpointRoute(model:string,e:Record<string,any>,maxCompletionTokens:number,profile?:OpenRouterRequestProfile):RouteSnapshot{
  if(!openRouterProviderTag(e.tag)||!openRouterProviderName(e.provider_name)||e.model_id!==model||e.status!==0||!positiveInteger(e.context_length)||!positiveInteger(e.max_completion_tokens)||e.max_completion_tokens<maxCompletionTokens||!Array.isArray(e.supported_parameters)||e.supported_parameters.length>100||!e.supported_parameters.some((p:unknown)=>p==='max_tokens'||p==='max_completion_tokens'))invalid();
  if(profile&&(!Number.isInteger(maxCompletionTokens)||maxCompletionTokens<16||maxCompletionTokens>4096||maxCompletionTokens>=e.context_length))invalid();
  const input=e.max_prompt_tokens===null||e.max_prompt_tokens===undefined?e.context_length:e.max_prompt_tokens;
  if(!positiveInteger(input)||input>e.context_length||!object(e.pricing))invalid();
  const allowed=['prompt','completion','request','image','input_cache_read','input_cache_write','web_search','internal_reasoning'];
  for(const [field,value] of Object.entries(e.pricing)){
    if(field==='discount'){if(value!==0)invalid();continue;}
    if(!allowed.includes(field)||typeof value!=='string')invalid();const d=decimal(value);
    if(['input_cache_write','web_search','internal_reasoning'].includes(field)&&d.coefficient!==0n)invalid();
  }
  for(const field of ['prompt','completion'])if(typeof e.pricing[field]!=='string')invalid();
  const promptPrice=decimalText(e.pricing.prompt),completionPrice=decimalText(e.pricing.completion),requestPrice=decimalText(e.pricing.request===undefined?'0':e.pricing.request);
  if(e.pricing.input_cache_read!==undefined){const p=decimal(promptPrice),r=decimal(e.pricing.input_cache_read),s=Math.max(p.scale,r.scale);if(r.coefficient*10n**BigInt(s-r.scale)>p.coefficient*10n**BigInt(s-p.scale))invalid();}
  const estimate=decimalSumMicros([{price:promptPrice,count:input},{price:completionPrice,count:maxCompletionTokens},{price:requestPrice,count:1}]);
  if(estimate<1n||estimate>1_000_000_000_000n)invalid();
  return {model,tag:e.tag,providerName:e.provider_name,promptCapacity:input,completionCapacity:e.max_completion_tokens,promptPrice,completionPrice,requestPrice,estimateMicros:estimate.toString(),...(profile?{profile,contextLength:e.context_length}:{})};
}
export function parseRoute(model:OpenRouterModel,body:unknown,maxCompletionTokens:number,profile?:OpenRouterRequestProfile,structured=false,pinnedTag?:string):RouteSnapshot{
  if(!openRouterModelId(model)||!object(body)||!object(body.data)||body.data.id!==model||!Array.isArray(body.data.endpoints)||body.data.endpoints.length>100)invalid();
  const endpoints=body.data.endpoints;
  if(profile===undefined){
    if(!(legacyOpenRouterModels as readonly string[]).includes(model))invalid();
    if(endpoints.some((e:unknown)=>object(e)&&typeof e.tag==='string'&&e.tag.startsWith('openai/')))invalid();
    const matches=endpoints.filter((e:unknown)=>object(e)&&e.tag==='openai');if(matches.length!==1||matches[0].provider_name!=='OpenAI')invalid();
    if(structured&&!['structured_outputs','response_format'].every(p=>matches[0].supported_parameters?.includes(p)))invalid();
    return endpointRoute(model,matches[0],maxCompletionTokens);
  }
  if(profile!==openRouterTextProfile)invalid();
  const architecture=body.data.architecture;
  if(!object(architecture)||!Array.isArray(architecture.input_modalities)||!architecture.input_modalities.includes('text')||!Array.isArray(architecture.output_modalities)||architecture.output_modalities.length!==1||architecture.output_modalities[0]!=='text')invalid();
  const reasoning=body.data.reasoning;
  if((reasoning!=null&&(!object(reasoning)||reasoning.mandatory!==false||reasoning.default_enabled!==false))||((body.data.supported_parameters?.includes('reasoning')||endpoints.some((e:unknown)=>object(e)&&Array.isArray(e.supported_parameters)&&e.supported_parameters.includes('reasoning')))&&(!object(reasoning)||reasoning.mandatory!==false||reasoning.default_enabled!==false)))invalid();
  const routes:RouteSnapshot[]=[];
  for(const e of endpoints){
    if(!object(e)||!openRouterProviderTag(e.tag)||pinnedTag!==undefined&&e.tag!==pinnedTag||endpoints.filter((x:unknown)=>object(x)&&x.tag===e.tag).length!==1||endpoints.some((x:unknown)=>object(x)&&typeof x.tag==='string'&&x.tag.startsWith(e.tag+'/')))continue;
    if(structured&&!['structured_outputs','response_format'].every(p=>Array.isArray(e.supported_parameters)&&e.supported_parameters.includes(p)))continue;
    try{routes.push(endpointRoute(model,e,maxCompletionTokens,profile));}catch{/* Unsupported routes cannot authorize spending. */}
  }
  routes.sort((a,b)=>BigInt(a.estimateMicros)<BigInt(b.estimateMicros)?-1:BigInt(a.estimateMicros)>BigInt(b.estimateMicros)?1:a.tag<b.tag?-1:a.tag>b.tag?1:0);
  if(!routes.length)invalid();return routes[0];
}
async function readRoutes(credentials:unknown,models:OpenRouterModel[],maxCompletionTokens:number,send:typeof fetch,structured=false,profile?:OpenRouterRequestProfile,pinnedTags?:string[]){
  try{
    if(!Array.isArray(models)||models.length<1||models.length>4||new Set(models).size!==models.length)invalid();
    if(profile){if(profile!==openRouterTextProfile)invalid();await requireCatalogModels(models,send,structured);}
    const key=await read('/key',credentials,send);
    if(!object(key?.data)||key.data.is_free_tier!==false||key.data.is_management_key!==false||key.data.is_provisioning_key===true)invalid();
    const routes:RouteSnapshot[]=[];
    // ponytail: at most two free endpoint reads at once; retain selection order and
    // the existing 10s per-read/2MiB limits rather than parallelizing paid sends.
    for(let index=0;index<models.length;index+=2){
      const settled=await Promise.allSettled(models.slice(index,index+2).map(async(model,offset)=>{
        if(!openRouterModelId(model))invalid();const [author,slug]=model.split('/');
        const body=await read('/models/'+encodeURIComponent(author)+'/'+encodeURIComponent(slug)+'/endpoints',credentials,send);
        return parseRoute(model,body,maxCompletionTokens,profile,structured,pinnedTags?.[index+offset]);
      }));
      for(const route of settled){if(route.status==='rejected')throw route.reason;routes.push(route.value);}
    }
    return routes;
  }catch{throw new FoundationError(502,'Could not verify the ordinary funded OpenRouter key and supported endpoint prices. No model request was sent.');}
}
export async function readOpenRouterRoutes(credentials:unknown,models:PromptModel[],maxCompletionTokens:number,send:typeof fetch=fetch,profile?:OpenRouterRequestProfile,pinnedTags?:string[]){return readRoutes(credentials,models,maxCompletionTokens,send,false,profile,pinnedTags);}
export async function readSuggestionRoute(credentials:unknown,model:OpenRouterModel,send:typeof fetch=fetch,profile?:OpenRouterRequestProfile,pinnedTag?:string){return (await readRoutes(credentials,[model],suggestionOutputTokens,send,true,profile,pinnedTag?[pinnedTag]:undefined))[0];}
export async function readContentSupportRoute(credentials:unknown,model:OpenRouterModel,send:typeof fetch=fetch,pinnedTag?:string){return (await readRoutes(credentials,[model],contentSupportLimits.outputTokens,send,true,openRouterTextProfile,pinnedTag?[pinnedTag]:undefined))[0];}
export type ExecutionResult={text:string;resolvedModel:string;provider:string;finishReason:string;citations:{url:string;title:string|null}[];promptTokens:number|null;completionTokens:number|null;receivedAt:string};
// Owner decision D3: an outcome never pauses spending; an unknown cost settles uncertain and that ledger row blocks new work.
export type ExecutionOutcome={cost:string|null;reference:string|null;result:ExecutionResult|null;diagnostic:string|null;evidence:Record<string,unknown>};
export function unknownExecution(reference:string|null=null,diagnostic='The provider charge is unresolved. Reconcile this request before spending again.'):ExecutionOutcome{
  return {cost:null,reference,result:null,diagnostic,evidence:{source:'response',generationId:reference,reportedCost:null}};
}
function costValue(value:unknown){if(!(value instanceof ExactCost))invalid();const micros=decimalSumMicros([{price:value.source,count:1}]);return {reported:value.source,cost:micros>1_000_000_000_000n?null:usd(micros)};}
const finalReasons=new Set(['stop','length','content_filter','tool_calls','error']);
function finalReason(value:unknown):value is string{return typeof value==='string'&&finalReasons.has(value);}
function tokenCount(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2_000_000?value:null;}
function safeText(value:string){return !value.includes('\0')&&toUSVString(value)===value;}
function citations(value:unknown){
  if(value===undefined)return [];if(!Array.isArray(value)||value.length>100)invalid();
  return value.flatMap(entry=>{
    if(!object(entry)||entry.type!=='url_citation')return [];const citation=entry.url_citation;
    if(!object(citation)||typeof citation.url!=='string'||citation.url.length>2048)return [];
    if(!safeText(citation.url)||typeof citation.title==='string'&&!safeText(citation.title))invalid();
    try{const url=new URL(citation.url);if(url.protocol!=='https:'||url.username||url.password)return [];return [{url:url.href,title:typeof citation.title==='string'?Array.from(citation.title).slice(0,300).join(''):null}];}catch{return [];}
  });
}
const budgetLimitSources=new Set(['openrouter_key_limit','openrouter_guardrail_budget','openrouter_workspace_budget']);
// Owner decision D3: OpenRouter documents 402 (no credit or in-flight limit) and 403 with a budget
// limit_source as refused before reaching a provider (openrouter.ai/docs/api-reference/errors, checked
// 2026-10-18). Only that exact error shape with no generation evidence is a known $0 outcome.
export function openRouterRefusal(body:unknown,httpStatus:number,headerId:string|null):ExecutionOutcome|null{
  if(headerId!==null||!object(body)||['id','usage','choices'].some(key=>Object.hasOwn(body,key))||!object(body.error)||typeof body.error.code!=='number'||body.error.code!==httpStatus)return null;
  const metadata=object(body.error.metadata)?body.error.metadata:undefined,source=metadata?.limit_source;
  // An error raised by the upstream model provider (provider_name/raw metadata) means the request reached a provider: keep it uncertain.
  if(metadata&&(Object.hasOwn(metadata,'provider_name')||Object.hasOwn(metadata,'raw')))return null;
  if(httpStatus!==402&&!(httpStatus===403&&budgetLimitSources.has(source)))return null;
  return {cost:'0.000000',reference:null,result:null,
    diagnostic:httpStatus===402?'OpenRouter refused this request before running it: the account or API key has no credit left, or its in-flight spending limit was reached. No charge was recorded. Add credits or raise the key limit at OpenRouter, then prepare a new quote.'
      :'OpenRouter refused this request before running it: a key, guardrail or workspace budget set at OpenRouter is spent. No charge was recorded. Raise or reset that budget at OpenRouter, then prepare a new quote.',
    evidence:{source:'refusal',httpStatus,limitSource:typeof source==='string'&&/^[a-z0-9_]{1,64}$/.test(source)?source:null,generationId:null,reportedCost:null}};
}
export function parseExecutionOutcome(body:unknown,httpStatus:number,headerId:string|null,route:RouteSnapshot,dispatchedAt:Date):ExecutionOutcome{
  const refused=openRouterRefusal(body,httpStatus,headerId);if(refused)return refused;
  const outcome=unknownExecution(headerId);
  try{
    if(!object(body)||!generationId(body.id)||(headerId!==null&&body.id!==headerId)||body.model!==route.model||body.provider!==route.providerName||!object(body.usage)||typeof body.usage.is_byok!=='boolean')invalid();
    outcome.reference=body.id;
    if(typeof body.created!=='number'||!Number.isSafeInteger(body.created)||Math.abs(body.created*1000-dispatchedAt.getTime())>60_000)invalid();
    const usage=body.usage,charge=costValue(usage.cost);
    outcome.evidence={source:'response',generationId:body.id,model:body.model,provider:body.provider,created:body.created,httpStatus,reportedCost:charge.reported,isByok:usage.is_byok,
      upstreamReportedCost:usage.cost_details?.upstream_inference_cost instanceof ExactCost?usage.cost_details.upstream_inference_cost.source:null};
    if(!Array.isArray(body.choices)||body.choices.length!==1||!object(body.choices[0])||!finalReason(body.choices[0].finish_reason))invalid();
    outcome.cost=charge.cost;
    outcome.diagnostic=usage.is_byok?'Upstream BYOK was used unexpectedly. The recorded credit charge excludes the provider invoice.':charge.cost===null?'The reported charge exceeds supported accounting limits.':null;
    const choice=body.choices[0],message=choice.message;
    if(httpStatus!==200||!object(message)||typeof message.content!=='string'||message.content.length>250_000||!safeText(message.content)||message.tool_calls?.length||!['stop','length','content_filter'].includes(choice.finish_reason)){
      outcome.diagnostic??='The provider charged this request but did not return a supported text answer.';return outcome;
    }
    outcome.result={text:message.content,resolvedModel:body.model,provider:body.provider,finishReason:choice.finish_reason,citations:citations(message.annotations),promptTokens:tokenCount(usage.prompt_tokens),completionTokens:tokenCount(usage.completion_tokens),receivedAt:new Date().toISOString()};return outcome;
  }catch{if(outcome.cost!==null)outcome.diagnostic??='The charge was recorded, but the answer metadata was unsupported.';return outcome;}
}
type StructuredPurpose=boolean|typeof contentSupportPurpose;
export function executionRequestBody(messages:RenderedInput,route:RouteSnapshot,maxTokens:number,runId:string,actor:string,structured:StructuredPurpose=false){
  if(structured===contentSupportPurpose&&(route.profile!==openRouterTextProfile||maxTokens!==contentSupportLimits.outputTokens))throw new FoundationError(409,'Prepare a current website-content-support route with its fixed output limit.');
  validateExecutionPayload(messages,route,maxTokens,!!structured);
  const schema=structured===contentSupportPurpose?contentSupportSchema:suggestionSchema,name=structured===contentSupportPurpose?'website_content_support_v1':'suggestion_proposal_v1';
  const body={...executionBody(messages,route,maxTokens,runId,actor,!!structured),...(structured?{response_format:{type:'json_schema',json_schema:{name,strict:true,schema}}}:{})};
  if(route.profile&&(structured&&Buffer.byteLength(JSON.stringify({messages,schema}),'utf8')>131_072||Buffer.byteLength(JSON.stringify(body),'utf8')>163_840))throw new FoundationError(413,'The text request exceeds this model profile’s payload limit. Narrow the input.');
  return body;
}
async function requestExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,maxTokens:number,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch,structured:StructuredPurpose=false){
  let reference:string|null=null;
  try{
    const body=executionRequestBody(messages,route,maxTokens,runId,actor,structured);
    const response=await send(openRouterBase+'/chat/completions',{method:'POST',headers:{...headers(credentials),'content-type':'application/json','x-openrouter-metadata':'enabled'},body:JSON.stringify(body),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60_000)});
    const header=response.headers.get('x-generation-id');if(header!==null&&!generationId(header)){await response.body?.cancel();return unknownExecution();}
    if(header!==null){reference=header;try{await capture(header);}catch{await response.body?.cancel();throw new Error('Generation receipt was not persisted.');}}
    return parseExecutionOutcome(await responseJson(response),response.status,reference,route,dispatchedAt);
  }catch{return unknownExecution(reference);}
}
export async function requestPromptExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,maxTokens:number,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch=fetch){return requestExecution(credentials,messages,route,maxTokens,runId,actor,dispatchedAt,capture,send);}
export async function requestSuggestionExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch=fetch){return requestExecution(credentials,messages,route,suggestionOutputTokens,runId,actor,dispatchedAt,capture,send,true);}
export async function requestContentSupportExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch=fetch){return requestExecution(credentials,messages,route,contentSupportLimits.outputTokens,runId,actor,dispatchedAt,capture,send,contentSupportPurpose);}
export async function reconcileOpenRouter(credentials:unknown,id:string,route:RouteSnapshot,dispatchedAt:Date,runId:string,actor:string,send:typeof fetch=fetch):Promise<ExecutionOutcome>{
  if(!generationId(id))throw new FoundationError(409,'No provider generation receipt is available. The charge cannot be inferred.');
  try{
    const {data}=await read('/generation?id='+encodeURIComponent(id),credentials,send);
    if(!object(data)||data.id!==id||data.model!==route.model||data.provider_name!==route.providerName||data.session_id!==runId||data.external_user!==actor||typeof data.created_at!=='string'||!Number.isFinite(Date.parse(data.created_at))||Math.abs(Date.parse(data.created_at)-dispatchedAt.getTime())>60_000||!finalReason(data.finish_reason)||typeof data.is_byok!=='boolean')invalid();
    const charge=costValue(data.total_cost);
    return {cost:charge.cost,reference:id,result:null,diagnostic:data.is_byok?'The recovered credit charge used unsupported upstream BYOK. External provider billing is separate.':null,
      evidence:{source:'generation',generationId:id,reportedCost:charge.reported,model:data.model,provider:data.provider_name,createdAt:data.created_at,finishReason:data.finish_reason,isByok:data.is_byok,upstreamReportedCost:data.upstream_inference_cost instanceof ExactCost?data.upstream_inference_cost.source:null,checkedAt:new Date().toISOString()}};
  }catch{throw new FoundationError(409,'Provider evidence is unavailable, unfinished or does not match this request. Its charge remains unresolved.');}
}
