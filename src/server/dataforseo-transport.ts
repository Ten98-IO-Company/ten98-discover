import {readResponseText} from '@ten98/runtime';
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
// Identity routes (AI, which request accept-encoding: identity) also require the exact declared byte count.
// The runtime's exact mode skips that count for an encoded body, so an encoded identity response is refused here.
// Every runtime refusal, decode or JSON error becomes the caller's single invalid() outcome.
async function boundedJson(response:Response,maximum:number,identity=false){
  const encoding=response.headers.get('content-encoding');
  if(identity&&encoding!==null&&encoding.toLowerCase()!=='identity'){await response.body?.cancel().catch(()=>{});invalid();}
  return JSON.parse(await readResponseText(response,{maxBytes:maximum,contentLength:identity?'exact':'limit',maxChunks:65_536}));
}

export const dataforseoFailureCodes=new Set([40200,40210,40203]);
export const dataforseoRefusalMessage={
  provider:'DataForSEO refused this request. Check the provider account or request settings before starting a new request.'
} as const;
// Mixed or partial task responses need their exact task identity checked by the adapter.
export function dataforseoRefusal(r:DataforseoResponse):'provider'|null{
  const b=r.body;
  if(r.httpStatus!==200&&r.httpStatus!==402||!b||typeof b!=='object'||Array.isArray(b))return null;
  const {status_code:code,tasks}=b as Record<string,unknown>;
  if(tasks!=null&&!Array.isArray(tasks))return null;
  const list=(tasks??[]) as unknown[];
  for(let index=0;index<list.length;index++)if(!Object.hasOwn(list,index))return null;
  if(list.some(task=>!task||typeof task!=='object'||Array.isArray(task)||!Object.hasOwn(task,'status_code')||!dataforseoFailureCodes.has((task as Record<string,unknown>).status_code as number)))return null;
  if(dataforseoFailureCodes.has(code as number)||code===20000&&list.length>0)return 'provider';
  return r.httpStatus===402&&list.length===0&&(code==null||code===402)?'provider':null;
}
export function dataforseoRefusalEvidence(r:DataforseoResponse){
  const b=r.body as Record<string,any>,task=Array.isArray(b.tasks)?b.tasks[0]:undefined;
  return {httpStatus:r.httpStatus,statusCode:Number.isInteger(b.status_code)?b.status_code as number:null,taskStatus:Number.isInteger(task?.status_code)?task.status_code as number:null};
}

// One attempt only. Callers must authorize and record the request before entering here.
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
