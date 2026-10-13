import {validText} from './keyword-research-input.ts';

export type DataforseoResponse={httpStatus:number;body:unknown};
const origin='https://api.dataforseo.com/v3/';
const getPaths=new Set(['appendix/user_data','dataforseo_labs/locations_and_languages','serp/google/locations','serp/google/languages']);
const postPaths=new Set(['dataforseo_labs/google/keyword_overview/live','dataforseo_labs/google/keyword_ideas/live','dataforseo_labs/id_list','serp/google/organic/live/advanced','serp/google/organic/task_post','serp/id_list']);
const taskPath=/^serp\/google\/organic\/task_get\/advanced\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/;
function invalid():never{throw new Error('DataForSEO request or response is unavailable.');}
function authorization(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const {login,password}=value as Record<string,unknown>;
  if(!validText(login,254)||login.includes(':')||!validText(password,4096))invalid();
  return 'Basic '+Buffer.from(login+':'+password,'utf8').toString('base64');
}
async function boundedJson(response:Response,maximum:number){
  if(!response.body)invalid();
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$(?![\s\S])/.test(declared)||Number(declared)>maximum))invalid();
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum||parts.length>=65_536)invalid();parts.push(value);}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// One attempt only. Callers must authorize/reserve paid work before entering here.
// Fixed routes also protect direct callers; no custom host, redirect or query URL.
export async function dataforseoJson(url:string,credentials:unknown,method:'GET'|'POST',body:unknown,send:typeof fetch=fetch):Promise<DataforseoResponse>{
  try{
    if(typeof url!=='string'||!url.startsWith(origin))invalid();
    const path=url.slice(origin.length),location=path==='serp/google/locations'||/^serp\/google\/locations\/[a-z]{2}$(?![\s\S])/.test(path);
    if(method==='GET'){if(body!==undefined||!(getPaths.has(path)||location||taskPath.test(path)))invalid();}
    else if(method==='POST'){if(body===undefined||!postPaths.has(path))invalid();}
    else invalid();
    const serialized=body===undefined?undefined:JSON.stringify(body);
    if(method==='POST'&&(typeof serialized!=='string'||Buffer.byteLength(serialized,'utf8')>131_072))invalid();
    const live=path==='serp/google/organic/live/advanced',serpResult=live||taskPath.test(path);
    const response=await send(url,{method,headers:{authorization:authorization(credentials),accept:'application/json',...(method==='POST'?{'content-type':'application/json'}:{})},...(serialized===undefined?{}:{body:serialized}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(live?150_000:30_000)});
    if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});invalid();}
    // ponytail: load the bounded complete provider catalog once on the server.
    // A catalog above64MiB needs a streaming parser before raising this ceiling.
    return {httpStatus:response.status,body:await boundedJson(response,location?67_108_864:serpResult?33_554_432:4_194_304)};
  }catch{return invalid();}
}
