import {validText} from './keyword-research-input.ts';

export type DataforseoResponse={httpStatus:number;body:unknown};
const origin='https://api.dataforseo.com/v3/';
const getPaths=new Set(['appendix/user_data','dataforseo_labs/locations_and_languages','serp/google/locations','serp/google/languages','ai_optimization/chat_gpt/llm_scraper/locations','ai_optimization/chat_gpt/llm_scraper/languages']);
const postPaths=new Set(['dataforseo_labs/google/keyword_overview/live','dataforseo_labs/google/keyword_ideas/live','dataforseo_labs/google/ranked_keywords/live','dataforseo_labs/google/domain_rank_overview/live','dataforseo_labs/google/relevant_pages/live','dataforseo_labs/google/competitors_domain/live','dataforseo_labs/id_list','backlinks/summary/live','backlinks/backlinks/live','backlinks/referring_domains/live','backlinks/anchors/live','backlinks/id_list','serp/google/organic/live/advanced','serp/google/organic/task_post','serp/id_list','ai_optimization/chat_gpt/llm_scraper/live/advanced','ai_optimization/id_list']);
const taskPath=/^serp\/google\/organic\/task_get\/advanced\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function invalid():never{throw new Error('DataForSEO request or response is unavailable.');}
function authorization(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const {login,password}=value as Record<string,unknown>;
  if(!validText(login,254)||login.includes(':')||!validText(password,4096))invalid();
  return 'Basic '+Buffer.from(login+':'+password,'utf8').toString('base64');
}
// ponytail: kept instead of @ten98/runtime readResponseText. Its contentLength mode (0.2.0) always pairs the
// declared-size precheck with an exact identity byte count, which non-AI routes do not require, and it has
// no chunk-count ceiling, so a stream of tiny chunks would cost seconds to reach the byte limit.
async function boundedJson(response:Response,maximum:number,identity=false){
  if(!response.body)invalid();
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{
    const declared=response.headers.get('content-length');
    if(identity&&response.headers.get('content-encoding')!==null&&response.headers.get('content-encoding')!.toLowerCase()!=='identity')invalid();
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))invalid();
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum||parts.length>=65_536)invalid();parts.push(value);}
    if(identity&&declared!==null&&Number(declared)!==size)invalid();
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Owner decision D3: wallet refusals from DataForSEO appendix/errors (checked 2026-10-18). 40201 (paused),
// 40202/40209 (rate limits) and 40204 (subscription) are not wallet refusals and stay uncertain.
export const dataforseoWalletCodes=new Map<number,'payment'|'cost_limit'>([[40200,'payment'],[40210,'payment'],[40203,'cost_limit']]);
export const dataforseoRefusalMessage={
  payment:'DataForSEO refused this request because the account balance is too low (payment required or insufficient funds). No charge was recorded. Add funds in DataForSEO, then prepare a new quote.',
  cost_limit:'DataForSEO refused this request because the daily cost limit set in your DataForSEO account was reached. No charge was recorded. Raise the limit in DataForSEO or wait for it to reset, then prepare a new quote.'
} as const;
// A known $0 refusal needs an explicit numeric zero cost on the response and on every task;
// a missing cost is never zero. Mixed, partial or other codes return null (uncertain).
export function dataforseoRefusal(r:DataforseoResponse):'payment'|'cost_limit'|null{
  const b=r.body;
  if(r.httpStatus!==200&&r.httpStatus!==402||!b||typeof b!=='object'||Array.isArray(b))return null;
  const {status_code:code,cost,tasks}=b as Record<string,unknown>;
  if(cost!==0||tasks!=null&&!Array.isArray(tasks))return null;
  const list=(tasks??[]) as unknown[],kinds=new Set<string|undefined>();
  for(const task of list){if(!task||typeof task!=='object'||Array.isArray(task)||(task as Record<string,unknown>).cost!==0)return null;kinds.add(dataforseoWalletCodes.get((task as Record<string,unknown>).status_code as number));}
  const kind=dataforseoWalletCodes.get(code as number),taskKind=kinds.size===1?[...kinds][0] as 'payment'|'cost_limit'|undefined:undefined;
  if(kind)return list.length===0||taskKind===kind?kind:null;
  if(code===20000)return list.length?taskKind??null:null;
  return r.httpStatus===402&&list.length===0&&(code==null||code===402)?'payment':null;
}
// Ledger evidence for a recognised refusal: the provider's own codes and its explicit zero costs.
export function dataforseoRefusalEvidence(r:DataforseoResponse){
  const b=r.body as Record<string,any>,task=Array.isArray(b.tasks)?b.tasks[0]:undefined;
  return {httpStatus:r.httpStatus,statusCode:Number.isInteger(b.status_code)?b.status_code as number:null,taskStatus:Number.isInteger(task?.status_code)?task.status_code as number:null,reportedCost:0,taskCost:task?0:null};
}

// One attempt only. Callers must authorize/reserve paid work before entering here.
// Fixed routes also protect direct callers; no custom host, redirect or query URL.
export async function dataforseoJson(url:string,credentials:unknown,method:'GET'|'POST',body:unknown,send:typeof fetch=fetch):Promise<DataforseoResponse>{
  try{
    if(typeof url!=='string'||!url.startsWith(origin))invalid();
    const path=url.slice(origin.length),location=path==='serp/google/locations'||/^serp\/google\/locations\/[a-z]{2}$/.test(path);
    if(method==='GET'){if(body!==undefined||!(getPaths.has(path)||location||taskPath.test(path)))invalid();}
    else if(method==='POST'){if(body===undefined||!postPaths.has(path))invalid();}
    else invalid();
    const ai=path.startsWith('ai_optimization/'),aiLive=path==='ai_optimization/chat_gpt/llm_scraper/live/advanced',aiLocations=path==='ai_optimization/chat_gpt/llm_scraper/locations';
    const serialized=body===undefined?undefined:JSON.stringify(body);
    if(method==='POST'&&(typeof serialized!=='string'||Buffer.byteLength(serialized,'utf8')>(ai?32_768:131_072)))invalid();
    const live=path==='serp/google/organic/live/advanced',serpResult=live||taskPath.test(path);
    const response=await send(url,{method,headers:{authorization:authorization(credentials),accept:'application/json',...(ai?{'accept-encoding':'identity'}:{}),...(method==='POST'?{'content-type':'application/json'}:{})},...(serialized===undefined?{}:{body:serialized}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(live||aiLive?150_000:30_000)});
    if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});invalid();}
    // ponytail: load the bounded complete provider catalog once on the server.
    // A catalog above64MiB needs a streaming parser before raising this ceiling.
    return {httpStatus:response.status,body:await boundedJson(response,location||aiLocations?67_108_864:serpResult?33_554_432:4_194_304,ai)};
  }catch{return invalid();}
}
