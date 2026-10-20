import {useId,useState} from 'react';
import {AppField} from '@ten98/ui/app';
import {ApiError,errMsg} from '../lib/api';
import {googleInspectionBatch,googleInspectionInput,type GoogleInspectionBatch} from '../server/google-inspection-input';
import type {GoogleReportOps} from './GoogleReportsPanel';

// Same bounded, fatal UTF-8 response pattern as the model picker; no provider requests from this component.
async function inspect(path:string,body:unknown,signal:AbortSignal):Promise<unknown>{
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(45_000)]);
 const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin',redirect:'error',signal:deadline});
 try{
  if(response.url!==new URL(path,window.location.origin).href||!response.body){await response.body?.cancel();throw Error('The inspection response could not be verified.');}
  const reader=response.body.getReader(),parts:Uint8Array[]=[],limit=response.ok?2_097_152:8192;let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};deadline.addEventListener('abort',abort,{once:true});
  try{for(;;){deadline.throwIfAborted();const next=await reader.read();deadline.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw Error('The complete inspection exceeds its size limit. Inspect fewer URLs.');parts.push(next.value);}}
  finally{deadline.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
  if((!encoding||encoding==='identity')&&length!==null&&(!/^\d+$/.test(length)||Number(length)!==size))throw Error('The inspection response was incomplete.');
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('The inspection response could not be decoded.');}
  if(!response.ok)throw Error(value&&typeof value==='object'&&'error'in value&&typeof value.error==='string'?value.error:'URL inspection is unavailable.');
  if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('The inspection response type could not be verified.');
  return value;
 }catch(error){if(!response.ok)throw Object.assign(new ApiError(error instanceof Error?error.message:'URL inspection failed.'),{status:response.status});throw error;}
}

const labels:Record<string,string>={verdict:'Google verdict',coverageState:'Coverage',robotsTxtState:'robots.txt',indexingState:'Indexing state',lastCrawlTime:'Last crawl',pageFetchState:'Page fetch',googleCanonical:'Google canonical',userCanonical:'Declared canonical',crawledAs:'Crawler',sitemap:'Known sitemaps',referringUrls:'Referring URLs',ampUrl:'AMP URL',ampIndexStatusVerdict:'AMP index verdict',issues:'Issues',issueMessage:'Issue',severity:'Severity',issueType:'Issue type',message:'Message',detectedItems:'Detected types',richResultType:'Type',items:'Items',name:'Name'};
function Fields({value}:{value:unknown}){
 if(Array.isArray(value))return value.length?<ul>{value.map((item,i)=><li key={i}><Fields value={item}/></li>)}</ul>:<span>None reported</span>;
 if(value&&typeof value==='object')return Object.keys(value).length?<dl>{Object.entries(value).map(([key,item])=><div key={key}><dt>{labels[key]??key}</dt><dd style={{marginInlineStart:0,overflowWrap:'anywhere'}}><Fields value={item}/></dd></div>)}</dl>:<span>Details unavailable</span>;
 return <bdi>{String(value)}</bdi>;
}
export function GoogleInspectionPanel({projectId,connection,ops}:{projectId:string;connection:{id:string;revision:number;propertyId:string};ops:GoogleReportOps}){
 const uid=useId(),[urls,setUrls]=useState(''),[language,setLanguage]=useState(''),[result,setResult]=useState<GoogleInspectionBatch|null>(null),[error,setError]=useState('');
 const submit=async()=>{
  const parsed=googleInspectionInput.safeParse({urls:urls.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),...(language?{languageCode:language}: {})});
  if(!parsed.success){setError('Enter 1–10 different HTTP or HTTPS URLs, one per line, and a valid language tag if supplied. URLs cannot contain credentials or fragments.');return;}
  const op=ops.begin();if(!op)return;setError('');setResult(null);
  try{
   const raw=await inspect(`/api/projects/${projectId}/google/connections/${connection.id}/inspect`,parsed.data,op.controller.signal);
   if(!ops.alive(op.serial,op.controller))return;
   const response=googleInspectionBatch.safeParse(raw);
   if(!response.success||response.data.projectId!==projectId||response.data.connectionId!==connection.id||response.data.revision!==connection.revision||response.data.propertyId!==connection.propertyId||response.data.languageCode!==parsed.data.languageCode||JSON.stringify(response.data.results.map(r=>r.url))!==JSON.stringify(parsed.data.urls))throw Error('The inspection response could not be verified. Refresh status before trying again.');
   setResult(response.data);
  }catch(e){
   if(ops.terminal(op.serial,op.controller,e))return;
   if(e instanceof ApiError&&e.status===409){setUrls('');setLanguage('');try{await ops.refresh(op.serial,op.controller);}catch{/* Parent handles lost access. */}}
   if(ops.alive(op.serial,op.controller))setError(errMsg(e));
  }finally{ops.end(op.serial);}
 };
 return <details className="stack" style={{minWidth:0}}><summary style={{minHeight:44,cursor:'pointer'}}>Inspect indexed URLs</summary><div className="stack">
  <p className="hint">Read Google’s indexed version for this saved property. This does not fetch the live page or request indexing. Only workspace owners can make this external request.</p>
  <AppField label="URLs — one per line, up to 10" multiline id={`${uid}-urls`} dir="ltr" rows={4} maxLength={40970} disabled={ops.busy} value={urls} onChange={e=>setUrls(e.target.value)} />
  <div><AppField label="Result language (optional)" id={`${uid}-language`} dir="ltr" maxLength={80} placeholder="en-US" disabled={ops.busy} value={language} onChange={e=>setLanguage(e.target.value)} aria-describedby={`${uid}-language-help`}/><p id={`${uid}-language-help`} className="hint">Use a language tag such as ar or en-GB. The default is en-US.</p></div>
  <button type="button" className="btn primary" style={{minHeight:44}} disabled={ops.busy||!urls.trim()} onClick={()=>void submit()}>Inspect URLs</button>
  {ops.busy&&<p role="status">A Google action is in progress…</p>}{error&&<p role="alert" className="alert">{error}</p>}
  {result&&<section aria-label="Last URL inspection" className="stack" style={{overflowWrap:'anywhere'}}>
   <h3>Last requested indexed versions</h3><p className="dim">Property: <bdi dir="ltr">{result.propertyId}</bdi> · Checked <bdi dir="ltr">{result.checkedAt}</bdi> · Language: <bdi>{result.languageCode}</bdi>. Results below belong to those submitted URLs; editing the form does not update them.</p>
   {result.results.map(row=><article key={row.url} className="stack"><h4 style={{overflowWrap:'anywhere'}}><bdi dir="ltr">{row.url}</bdi></h4>{row.result===null?<p role="status" className="alert">{row.attempted?'Attempted — ':'Not attempted — '}{row.error}</p>:<>
    <p>Google verdict: {row.result.indexStatusResult?.verdict??'Unavailable'} · Coverage: {row.result.indexStatusResult?.coverageState??'Unavailable'}</p>
    <p>Google canonical: <bdi dir="ltr">{row.result.indexStatusResult?.googleCanonical??'Unavailable'}</bdi></p><p>Last crawl: <bdi dir="ltr">{row.result.indexStatusResult?.lastCrawlTime??'Unavailable'}</bdi></p>
    {row.result.inspectionResultLink&&<a href={row.result.inspectionResultLink} target="_blank" rel="noopener noreferrer" style={{display:'inline-flex',alignItems:'center',minHeight:44}}>Open this inspection in Search Console</a>}
    <details><summary style={{minHeight:44,cursor:'pointer'}}>Full Google inspection details</summary>{([['Index and crawl','indexStatusResult'],['AMP','ampResult'],['Mobile usability (deprecated by Google)','mobileUsabilityResult'],['Rich results','richResultsResult']] as const).map(([label,key])=><section key={key}><h5>{label}</h5>{row.result?.[key]?<Fields value={row.result[key]}/>:<p>Not provided by Google. This does not establish a pass or failure.</p>}</section>)}</details>
   </>}</article>)}
  </section>}
 </div></details>;
}
