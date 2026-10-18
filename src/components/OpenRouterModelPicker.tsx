import {useId,useState} from 'react';
import {ApiError} from '../lib/api';
import {openRouterModelId,openRouterProviderName,openRouterProviderTag,openRouterTextProfile,legacyOpenRouterModels,openRouterMetadataBytes,type OpenRouterCatalog} from '../lib/openrouter-models';

const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(v);
const stamp=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const capacity=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_000_000;
const decimal=(v:unknown):v is string=>typeof v==='string'&&v.length<=140&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
export function modelUsdMicros(v:unknown,maximum=1_000_000_000_000n):bigint|null{if(typeof v!=='string'||!/^(?:0|[1-9]\d{0,6})\.\d{6}$/.test(v))return null;const n=BigInt(v.replace('.',''));return n<=maximum?n:null;}
export function readModelCatalog(v:unknown):OpenRouterCatalog{
 if(!object(v)||!keys(v,['version','status','fetchedAt','revision','complete','models'])||v.version!=='openrouter-text-catalog-v1'||!['fresh','stale','unavailable'].includes(v.status)||typeof v.complete!=='boolean'||!Array.isArray(v.models)||v.models.length>2000)throw Error('The model catalog could not be verified.');
 if(v.status==='unavailable'?(v.fetchedAt!==null||v.revision!==null||v.complete||v.models.length!==0):(!stamp(v.fetchedAt)||typeof v.revision!=='string'||!/^[a-f0-9]{64}$/.test(v.revision)||!v.complete))throw Error('The model catalog state is inconsistent.');
 const ids=new Set<string>();for(const m of v.models){
  if(!object(m)||!keys(m,['id','canonicalSlug','name','contextLength','maxCompletionTokens','promptPrice','completionPrice','requestPrice','structuredOutput','expirationDate','admission','reason'])||!openRouterModelId(m.id)||ids.has(m.id)||!openRouterModelId(m.canonicalSlug)||!text(m.name,256)||![m.contextLength,m.maxCompletionTokens].every(x=>x===null||capacity(x))||![m.promptPrice,m.completionPrice,m.requestPrice].every(x=>x===null||decimal(x))||typeof m.structuredOutput!=='boolean'||!(m.expirationDate===null||typeof m.expirationDate==='string'&&/^\d{4}-\d\d-\d\d$/.test(m.expirationDate)&&Number.isFinite(Date.parse(m.expirationDate))&&new Date(m.expirationDate).toISOString().slice(0,10)===m.expirationDate)||!['candidate','unsupported'].includes(m.admission)||(m.admission==='candidate'?(m.reason!==null||!capacity(m.contextLength)||!capacity(m.maxCompletionTokens)||![m.promptPrice,m.completionPrice,m.requestPrice].every(decimal)||[m.promptPrice,m.completionPrice,m.requestPrice].every(p=>!/[1-9]/.test(p))):!text(m.reason,512)))throw Error('A model catalog row could not be verified.');ids.add(m.id);
 }return v as OpenRouterCatalog;
}
export function validObservedModels(v:unknown):v is {values:string[];complete:boolean}{return object(v)&&keys(v,['values','complete'])&&typeof v.complete==='boolean'&&Array.isArray(v.values)&&v.values.length<=1000&&v.values.every(openRouterModelId)&&new Set(v.values).size===v.values.length;}
export function modelUnavailableReason(m:OpenRouterCatalog['models'][number],structured=false){return m.admission==='unsupported'?m.reason:m.expirationDate!==null&&m.expirationDate<=new Date().toISOString().slice(0,10)?'This model is retired or scheduled to retire today.':structured&&!m.structuredOutput?'Structured output is not supported by this catalog entry.':null;}
export type ModelQuoteRoute={model:string;tag:string;providerName:string;profile?:typeof openRouterTextProfile;contextLength?:number;promptCapacity:number;completionCapacity:number;promptPrice:string;completionPrice:string;requestPrice:string;estimateUsd:string};
export function validModelQuoteRoute(v:unknown):v is ModelQuoteRoute{
 if(!object(v)||!keys(v,['model','tag','providerName','promptCapacity','completionCapacity','promptPrice','completionPrice','requestPrice','estimateUsd',...(v.profile===undefined?[]:['profile','contextLength'])])||!openRouterModelId(v.model)||!openRouterProviderTag(v.tag)||!openRouterProviderName(v.providerName)||!capacity(v.promptCapacity)||!capacity(v.completionCapacity)||![v.promptPrice,v.completionPrice,v.requestPrice].every(decimal)||(modelUsdMicros(v.estimateUsd)??0n)<=0n)return false;
 return v.profile===undefined?(v.contextLength===undefined&&(legacyOpenRouterModels as readonly string[]).includes(v.model)&&v.tag==='openai'&&v.providerName==='OpenAI'):(v.profile===openRouterTextProfile&&capacity(v.contextLength)&&v.promptCapacity<=v.contextLength);
}
export function validModelReservation(routes:unknown,total:unknown,models:string[],output:number,maximum:1|2|4=2):routes is ModelQuoteRoute[]{
 const totalLimit=BigInt(maximum)*1_000_000_000_000n;
 if(!Array.isArray(routes)||routes.length!==models.length||models.length<1||models.length>maximum||new Set(models).size!==models.length||!Number.isInteger(output)||output<16||output>4096||modelUsdMicros(total,totalLimit)===null)return false;
 let sum=0n;for(const [i,r]of routes.entries()){
  if(!validModelQuoteRoute(r)||r.model!==models[i]||output>r.completionCapacity||r.profile!==undefined&&output>=r.contextLength!)return false;
  const terms=[[r.promptPrice,r.promptCapacity],[r.completionPrice,output],[r.requestPrice,1]] as const;
  const parts=terms.map(([price,count])=>({coefficient:BigInt(price.replace('.','')),scale:price.split('.')[1]?.length??0,count:BigInt(count)})),scale=Math.max(6,...parts.map(p=>p.scale)),divisor=10n**BigInt(scale-6);
  const amount=(parts.reduce((n,p)=>n+p.coefficient*p.count*10n**BigInt(scale-p.scale),0n)+divisor-1n)/divisor;if(amount!==modelUsdMicros(r.estimateUsd))return false;sum+=amount;
 }return sum===modelUsdMicros(total,totalLimit);
}

// Same complete-response boundary as AIQueryAnalysisPanel; kept in this shared
// picker module so both model setup controllers reuse it without a new service.
export class ModelResponseError extends Error { constructor(message:string,readonly readOnly:boolean){super(message);} }
export async function modelApi<T=unknown>(path:string,opts:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T>{
 if(!/^\/api\/(?:projects|workspaces)\/[a-f0-9-]{36}\//i.test(path)||!['GET','POST'].includes(opts.method??'GET'))throw Error('Unsupported model request.');
 const signal=AbortSignal.any([...(opts.signal?[opts.signal]:[]),AbortSignal.timeout(45000)]);let response:Response;
 try{response=await fetch(path,{method:opts.method??'GET',body:opts.body===undefined?undefined:JSON.stringify(opts.body),headers:opts.body===undefined?undefined:{'content-type':'application/json'},credentials:'same-origin',redirect:'error',signal});}catch(error){if(signal.aborted)throw error;throw new ApiError('Network error. Inspect saved requests before retrying an unconfirmed action.');}
 try{
  if(response.url!==new URL(path,window.location.origin).href||!response.body){await response.body?.cancel();throw Error('The model response could not be verified.');}
  const reader=response.body.getReader(),parts:Uint8Array[]=[],limit=response.ok?openRouterMetadataBytes:8192;let size=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{for(;;){signal.throwIfAborted();const p=await reader.read();signal.throwIfAborted();if(p.done)break;size+=p.value.byteLength;if(size>limit)throw Error('The complete model response exceeds its size limit.');parts.push(p.value);}}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');if((!encoding||encoding==='identity')&&length!==null&&(!/^\d+$/.test(length)||Number(length)!==size))throw Error('The model response was incomplete.');
  const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!response.ok)throw Error(object(value)&&typeof value.error==='string'?value.error:'The model request is unavailable.');
  if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('The model response type could not be verified.');return value as T;
 }catch(error){if(!response.ok)throw Object.assign(new ApiError(error instanceof Error?error.message:'The model request failed.'),{status:response.status});if(signal.aborted)throw error;throw new ModelResponseError(error instanceof Error?error.message:'The model response could not be verified.',(opts.method??'GET')==='GET');}
}

type Props={catalog:OpenRouterCatalog|null;selected:string[];maximum:1|2|4;structured?:boolean;disabled:boolean;refreshing:boolean;canRefresh:boolean;onChange:(models:string[])=>void;onRefresh:()=>void};
export function OpenRouterModelPicker({catalog,selected,maximum,structured=false,disabled,refreshing,canRefresh,onChange,onRefresh}:Props){
 const uid=useId(),[search,setSearch]=useState(''),[sort,setSort]=useState('asc'),[unsupported,setUnsupported]=useState(false);
 const reason=(m:OpenRouterCatalog['models'][number])=>modelUnavailableReason(m,structured);
 const selectedRows=selected.map(id=>({id,row:catalog?.models.find(m=>m.id===id)}));
 const rows=(catalog?.models??[]).filter(m=>(unsupported||!reason(m))&&(m.name+' '+m.id).toLowerCase().includes(search.toLowerCase())).sort((a,b)=>(a.name.localeCompare(b.name)||a.id.localeCompare(b.id))*(sort==='asc'?1:-1));
 const money=(v:string|null)=>v===null?'Unknown':'USD '+v;
 return <fieldset disabled={disabled} className="stack" onKeyDown={e=>{if(e.key==='Enter'&&e.target instanceof HTMLInputElement)e.preventDefault();}} style={{minWidth:0,border:0,padding:0,margin:0}}><legend>Models — choose {maximum===1?'one':maximum===2?'up to two':'up to four'}</legend>
  <p className="hint">Listed prices are not a quote. Exact serving routes and maximum reservations are checked when you get a quote.</p>
  <div className="row"><span role="status">{catalog?.status==='fresh'?'Catalog checked':catalog?.status==='stale'?'Saved catalog — stale':'Catalog unavailable'}{catalog?.fetchedAt&&<> · <time dateTime={catalog.fetchedAt}>{new Date(catalog.fetchedAt).toLocaleString()}</time></>}</span><button type="button" className="btn" style={{minHeight:44}} disabled={disabled||refreshing||!canRefresh} onClick={onRefresh}>{refreshing?'Refreshing models…':'Refresh models (free metadata)'}</button></div>
  <p>{selected.length} of {maximum} selected. {maximum===1?'Evaluation only; model quality has not been benchmarked here.':`${selected.length} selected models create ${selected.length} separately charged requests after you explicitly start.`}</p>
  {selectedRows.map(({id,row})=><div key={id}><bdi dir="ltr" style={{overflowWrap:'anywhere'}}>{id}</bdi> <button type="button" className="btn ghost" style={{minHeight:44,maxWidth:'100%',whiteSpace:'normal',overflowWrap:'anywhere'}} onClick={()=>onChange(selected.filter(x=>x!==id))}>Remove <bdi dir="ltr">{id}</bdi></button>{(!row||reason(row))&&<p role="status">{row?reason(row):'Selected model is not in the saved catalog.'} Choose another model before requesting a new quote.</p>}</div>)}
  <label htmlFor={uid+'search'}>Search model names or IDs</label><input id={uid+'search'} type="search" value={search} maxLength={256} onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>setSearch(e.target.value)} style={{minHeight:44,width:'100%'}}/>
  <label htmlFor={uid+'sort'}>Sort models</label><select id={uid+'sort'} value={sort} onChange={e=>setSort(e.target.value)} style={{minHeight:44}}><option value="asc">Name A–Z</option><option value="desc">Name Z–A</option></select>
  <label style={{minHeight:44,display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={unsupported} onChange={e=>setUnsupported(e.target.checked)}/>Show unsupported models</label>
  <p role="status">{rows.length} matching catalog entries. Search and sorting do not make provider requests.</p>
  <div role="region" aria-label="Model catalog choices" tabIndex={0} style={{maxHeight:400,overflow:'auto',minWidth:0}}>{rows.map(m=><div key={m.id} style={{paddingBlock:8,overflowWrap:'anywhere'}}><label style={{minHeight:44,display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={selected.includes(m.id)} disabled={disabled||!!reason(m)||!selected.includes(m.id)&&selected.length>=maximum} onChange={e=>onChange(e.target.checked?[...selected,m.id]:selected.filter(id=>id!==m.id))}/><span>{m.name} · <bdi dir="ltr">{m.id}</bdi></span></label><p className="hint">Input <bdi dir="ltr">{money(m.promptPrice)}</bdi> / token · Output <bdi dir="ltr">{money(m.completionPrice)}</bdi> / token · Request <bdi dir="ltr">{money(m.requestPrice)}</bdi> / request<br/>Context {m.contextLength??'Unknown'} · Output capacity {m.maxCompletionTokens??'Unknown'} · {reason(m)??'Endpoint verification required'}</p>{[m.promptPrice,m.completionPrice,m.requestPrice].every(p=>p!==null&&!/[1-9]/.test(p))&&<p>Free route — execution support pending; no paid substitute will be selected.</p>}</div>)}</div>
 </fieldset>;
}
