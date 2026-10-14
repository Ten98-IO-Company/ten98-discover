import {toUSVString} from 'node:util';
import {createHmac,createHash} from 'node:crypto';
import {getConfig} from './config.ts';
import {FoundationError} from './auth.ts';
import {usd} from './providers.ts';
import {decimal,decimalSumMicros,decimalText,ExactCost,parseOpenRouterJson,executionBody,type PromptModel,type RouteSnapshot,type RenderedInput} from './openrouter-input.ts';
import {suggestionSchema,suggestionOutputTokens} from './ai-suggestion-input.ts';

export const openRouterBase='https://openrouter.ai/api/v1';
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw new Error('Unsupported OpenRouter evidence.');}
const positiveInteger=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2_000_000;
export function generationId(value:unknown):value is string{return typeof value==='string'&&/^gen-[0-9A-Za-z-]{1,124}$(?![\s\S])/.test(value);}
function apiKey(credentials:unknown){if(!object(credentials)||typeof credentials.apiKey!=='string'||!/^[^\s]{1,4096}$(?![\s\S])/.test(credentials.apiKey))invalid();return credentials.apiKey;}
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
export function parseRoute(model:PromptModel,body:unknown,maxCompletionTokens:number):RouteSnapshot{
  if(!object(body)||!object(body.data)||body.data.id!==model||!Array.isArray(body.data.endpoints)||body.data.endpoints.length>100)invalid();
  if(body.data.endpoints.some((e:unknown)=>object(e)&&typeof e.tag==='string'&&e.tag.startsWith('openai/')))invalid();
  const matches=body.data.endpoints.filter((e:unknown)=>object(e)&&e.tag==='openai');if(matches.length!==1)invalid();const e=matches[0];
  if(e.provider_name!=='OpenAI'||e.model_id!==model||e.status!==0||!positiveInteger(e.context_length)||!positiveInteger(e.max_completion_tokens)||e.max_completion_tokens<maxCompletionTokens||!Array.isArray(e.supported_parameters)||!e.supported_parameters.some((p:unknown)=>p==='max_tokens'||p==='max_completion_tokens'))invalid();
  const input=e.max_prompt_tokens===null||e.max_prompt_tokens===undefined?e.context_length:e.max_prompt_tokens;
  if(!positiveInteger(input)||input>e.context_length||!object(e.pricing))invalid();
  // The public endpoint catalog omits optional request fees and reports discount as metadata.
  // Only the standard undiscounted route is supported by this first accounting adapter.
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
  return {model,tag:'openai',providerName:'OpenAI',promptCapacity:input,completionCapacity:e.max_completion_tokens,promptPrice,completionPrice,requestPrice,estimateMicros:estimate.toString()};
}
async function readRoutes(credentials:unknown,models:PromptModel[],maxCompletionTokens:number,send:typeof fetch,structured=false){
  try{
    const key=await read('/key',credentials,send);
    if(!object(key?.data)||key.data.is_free_tier!==false||key.data.is_management_key!==false||key.data.is_provisioning_key===true)invalid();
    const routes:RouteSnapshot[]=[];
    for(const model of models){
      const body=await read(`/models/${model}/endpoints`,credentials,send),route=parseRoute(model,body,maxCompletionTokens);
      if(structured){const endpoint=body.data.endpoints.find((e:any)=>e.tag===route.tag);if(!['structured_outputs','response_format'].every(p=>endpoint.supported_parameters.includes(p)))invalid();}
      routes.push(route);
    }
    return routes;
  }catch{throw new FoundationError(502,'Could not verify the ordinary funded OpenRouter key and supported endpoint prices. No model request was sent.');}
}
export async function readOpenRouterRoutes(credentials:unknown,models:PromptModel[],maxCompletionTokens:number,send:typeof fetch=fetch){return readRoutes(credentials,models,maxCompletionTokens,send);}
export async function readSuggestionRoute(credentials:unknown,model:PromptModel,send:typeof fetch=fetch){return (await readRoutes(credentials,[model],suggestionOutputTokens,send,true))[0];}
export type ExecutionResult={text:string;resolvedModel:string;provider:string;finishReason:string;citations:{url:string;title:string|null}[];promptTokens:number|null;completionTokens:number|null;receivedAt:string};
export type ExecutionOutcome={cost:string|null;reference:string|null;result:ExecutionResult|null;diagnostic:string|null;pause:boolean;evidence:Record<string,unknown>};
export function unknownExecution(reference:string|null=null,diagnostic='The provider charge is unresolved. Reconcile this request before spending again.'):ExecutionOutcome{
  return {cost:null,reference,result:null,diagnostic,pause:true,evidence:{source:'response',generationId:reference,reportedCost:null}};
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
export function parseExecutionOutcome(body:unknown,httpStatus:number,headerId:string|null,route:RouteSnapshot,dispatchedAt:Date):ExecutionOutcome{
  const outcome=unknownExecution(headerId);
  try{
    if(!object(body)||!generationId(body.id)||(headerId!==null&&body.id!==headerId)||body.model!==route.model||body.provider!==route.providerName||!object(body.usage)||typeof body.usage.is_byok!=='boolean')invalid();
    outcome.reference=body.id;
    if(typeof body.created!=='number'||!Number.isSafeInteger(body.created)||Math.abs(body.created*1000-dispatchedAt.getTime())>60_000)invalid();
    const usage=body.usage,charge=costValue(usage.cost);
    outcome.evidence={source:'response',generationId:body.id,model:body.model,provider:body.provider,created:body.created,httpStatus,reportedCost:charge.reported,isByok:usage.is_byok,
      upstreamReportedCost:usage.cost_details?.upstream_inference_cost instanceof ExactCost?usage.cost_details.upstream_inference_cost.source:null};
    if(!Array.isArray(body.choices)||body.choices.length!==1||!object(body.choices[0])||!finalReason(body.choices[0].finish_reason))invalid();
    outcome.cost=charge.cost;outcome.pause=usage.is_byok||charge.cost===null;
    outcome.diagnostic=usage.is_byok?'Upstream BYOK was used unexpectedly. The recorded credit charge excludes the provider invoice; spending is paused.':charge.cost===null?'The reported charge exceeds supported accounting limits.':null;
    const choice=body.choices[0],message=choice.message;
    if(httpStatus!==200||!object(message)||typeof message.content!=='string'||message.content.length>250_000||!safeText(message.content)||message.tool_calls?.length||!['stop','length','content_filter'].includes(choice.finish_reason)){
      outcome.diagnostic??='The provider charged this request but did not return a supported text answer.';return outcome;
    }
    outcome.result={text:message.content,resolvedModel:body.model,provider:body.provider,finishReason:choice.finish_reason,citations:citations(message.annotations),promptTokens:tokenCount(usage.prompt_tokens),completionTokens:tokenCount(usage.completion_tokens),receivedAt:new Date().toISOString()};return outcome;
  }catch{if(outcome.cost!==null)outcome.diagnostic??='The charge was recorded, but the answer metadata was unsupported.';return outcome;}
}
async function requestExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,maxTokens:number,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch,structured=false){
  let reference:string|null=null;
  try{
    const body={...executionBody(messages,route,maxTokens,runId,actor),...(structured?{response_format:{type:'json_schema',json_schema:{name:'suggestion_proposal_v1',strict:true,schema:suggestionSchema}}}:{})};
    const response=await send(openRouterBase+'/chat/completions',{method:'POST',headers:{...headers(credentials),'content-type':'application/json','x-openrouter-metadata':'enabled'},body:JSON.stringify(body),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60_000)});
    const header=response.headers.get('x-generation-id');if(header!==null&&!generationId(header)){await response.body?.cancel();return unknownExecution();}
    if(header!==null){reference=header;try{await capture(header);}catch{await response.body?.cancel();throw new Error('Generation receipt was not persisted.');}}
    return parseExecutionOutcome(await responseJson(response),response.status,reference,route,dispatchedAt);
  }catch{return unknownExecution(reference);}
}
export async function requestPromptExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,maxTokens:number,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch=fetch){return requestExecution(credentials,messages,route,maxTokens,runId,actor,dispatchedAt,capture,send);}
export async function requestSuggestionExecution(credentials:unknown,messages:RenderedInput,route:RouteSnapshot,runId:string,actor:string,dispatchedAt:Date,capture:(id:string)=>Promise<void>,send:typeof fetch=fetch){return requestExecution(credentials,messages,route,suggestionOutputTokens,runId,actor,dispatchedAt,capture,send,true);}
export async function reconcileOpenRouter(credentials:unknown,id:string,route:RouteSnapshot,dispatchedAt:Date,runId:string,actor:string,send:typeof fetch=fetch):Promise<ExecutionOutcome>{
  if(!generationId(id))throw new FoundationError(409,'No provider generation receipt is available. The charge cannot be inferred.');
  try{
    const {data}=await read('/generation?id='+encodeURIComponent(id),credentials,send);
    if(!object(data)||data.id!==id||data.model!==route.model||data.provider_name!==route.providerName||data.session_id!==runId||data.external_user!==actor||typeof data.created_at!=='string'||!Number.isFinite(Date.parse(data.created_at))||Math.abs(Date.parse(data.created_at)-dispatchedAt.getTime())>60_000||!finalReason(data.finish_reason)||typeof data.is_byok!=='boolean')invalid();
    const charge=costValue(data.total_cost);
    return {cost:charge.cost,reference:id,result:null,pause:data.is_byok||charge.cost===null,diagnostic:data.is_byok?'The recovered credit charge used unsupported upstream BYOK. External provider billing is separate.':null,
      evidence:{source:'generation',generationId:id,reportedCost:charge.reported,model:data.model,provider:data.provider_name,createdAt:data.created_at,finishReason:data.finish_reason,isByok:data.is_byok,upstreamReportedCost:data.upstream_inference_cost instanceof ExactCost?data.upstream_inference_cost.source:null,checkedAt:new Date().toISOString()}};
  }catch{throw new FoundationError(409,'Provider evidence is unavailable, unfinished or does not match this request. Its charge remains unresolved.');}
}
