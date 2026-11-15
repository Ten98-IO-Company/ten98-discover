import {readResponseText} from '@ten98/runtime/browser';
import {Alert,Button,Disclosure,Heading,Inline,Link,Stack,StatusLine,Text} from '@ten98/ui';
import {useId,useState} from 'react';
import {AppField} from '@ten98/ui/app';
import {ApiError,errMsg} from '../lib/api';
import {googleInspectionBatch,googleInspectionInput,type GoogleInspectionBatch} from '../server/google-inspection-input';
import type {GoogleReportOps} from './GoogleReportsPanel';

// Bounded, fatal UTF-8 response read through the shared runtime reader; no provider requests from this component.
async function inspect(path:string,body:unknown,signal:AbortSignal):Promise<unknown>{
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(45_000)]);
 const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin',redirect:'error',signal:deadline});
 try{
  if(response.url!==new URL(path,window.location.origin).href||!response.body){await response.body?.cancel();throw Error('The inspection response could not be verified.');}
  let value:unknown;
  try{value=JSON.parse(await readResponseText(response,{maxBytes:response.ok?2_097_152:8192,contentLength:'exact',signal:deadline}));}
  catch(error){
   const code=(error as {code?:unknown}).code;
   if(error instanceof RangeError)throw Error('The complete inspection exceeds its size limit. Inspect fewer URLs.');
   if(code==='CONTENT_LENGTH_INVALID'||code==='RESPONSE_INCOMPLETE')throw Error('The inspection response was incomplete.');
   if(error instanceof SyntaxError||code==='RESPONSE_DECODE_INVALID')throw Error('The inspection response could not be decoded.');
   throw error;
  }
  if(!response.ok)throw Error(value&&typeof value==='object'&&'error'in value&&typeof value.error==='string'?value.error:'URL inspection is unavailable.');
  if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('The inspection response type could not be verified.');
  return value;
 }catch(error){if(!response.ok)throw Object.assign(new ApiError(error instanceof Error?error.message:'URL inspection failed.'),{status:response.status});throw error;}
}

const labels:Record<string,string>={verdict:'Google verdict',coverageState:'Coverage',robotsTxtState:'robots.txt',indexingState:'Indexing state',lastCrawlTime:'Last crawl',pageFetchState:'Page fetch',googleCanonical:'Google canonical',userCanonical:'Declared canonical',crawledAs:'Crawler',sitemap:'Known sitemaps',referringUrls:'Referring URLs',ampUrl:'AMP URL',ampIndexStatusVerdict:'AMP index verdict',issues:'Issues',issueMessage:'Issue',severity:'Severity',issueType:'Issue type',message:'Message',detectedItems:'Detected types',richResultType:'Type',items:'Items',name:'Name'};
function Fields({value}:{value:unknown}){
 if(Array.isArray(value))return value.length?<Stack as="ul">{value.map((item,i)=><Stack as="li" key={i}><Fields value={item}/></Stack>)}</Stack>:<Text as="span">None reported</Text>;
 if(value&&typeof value==='object')return Object.keys(value).length?<Stack as="dl">{Object.entries(value).map(([key,item])=><Stack gap={1} key={key}><Text as="dt">{labels[key]??key}</Text><Text as="dd"><Fields value={item}/></Text></Stack>)}</Stack>:<Text as="span">Details unavailable</Text>;
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
 return <Stack><Disclosure summary="Inspect indexed URLs" variant="plain"><Stack>
  <Text as="p" tone="muted">Read Google’s indexed version for this saved property. This does not fetch the live page or request indexing. Only workspace owners can make this external request.</Text>
  <AppField label="URLs — one per line, up to 10" multiline id={`${uid}-urls`} dir="ltr" rows={4} maxLength={40970} disabled={ops.busy} value={urls} onChange={e=>setUrls(e.target.value)} />
  <Stack><AppField label="Result language (optional)" id={`${uid}-language`} dir="ltr" maxLength={80} placeholder="en-US" disabled={ops.busy} value={language} onChange={e=>setLanguage(e.target.value)} aria-describedby={`${uid}-language-help`}/><Text as="p" tone="muted" id={`${uid}-language-help`}>Use a language tag such as ar or en-GB. The default is en-US.</Text></Stack>
  <Inline><Button type="button" variant="primary" disabled={ops.busy||!urls.trim()} onClick={()=>void submit()}>Inspect URLs</Button></Inline>
  {ops.busy&&<StatusLine busy>A Google action is in progress…</StatusLine>}{error&&<Alert tone="danger" role="alert">{error}</Alert>}
  {result&&<Stack as="section" aria-label="Last URL inspection">
   <Heading level={3}>Last requested indexed versions</Heading><Text as="p" tone="muted">Property: <bdi dir="ltr">{result.propertyId}</bdi> · Checked <bdi dir="ltr">{result.checkedAt}</bdi> · Language: <bdi>{result.languageCode}</bdi>. Results below belong to those submitted URLs; editing the form does not update them.</Text>
   {result.results.map(row=><Stack as="article" key={row.url}><Heading level={4}><bdi dir="ltr">{row.url}</bdi></Heading>{row.result===null?<Alert tone="danger" role="status">{row.attempted?'Attempted — ':'Not attempted — '}{row.error}</Alert>:<>
    <Text as="p">Google verdict: {row.result.indexStatusResult?.verdict??'Unavailable'} · Coverage: {row.result.indexStatusResult?.coverageState??'Unavailable'}</Text>
    <Text as="p">Google canonical: <bdi dir="ltr">{row.result.indexStatusResult?.googleCanonical??'Unavailable'}</bdi></Text><Text as="p">Last crawl: <bdi dir="ltr">{row.result.indexStatusResult?.lastCrawlTime??'Unavailable'}</bdi></Text>
    {row.result.inspectionResultLink&&<Link href={row.result.inspectionResultLink} target="_blank" rel="noopener noreferrer" variant="standalone">Open this inspection in Search Console</Link>}
    <Disclosure summary="Full Google inspection details" variant="plain"><Stack>{([['Index and crawl','indexStatusResult'],['AMP','ampResult'],['Mobile usability (deprecated by Google)','mobileUsabilityResult'],['Rich results','richResultsResult']] as const).map(([label,key])=><Stack as="section" key={key}><Heading level={5}>{label}</Heading>{row.result?.[key]?<Fields value={row.result[key]}/>:<Text as="p">Not provided by Google. This does not establish a pass or failure.</Text>}</Stack>)}</Stack></Disclosure>
   </>}</Stack>)}
  </Stack>}
 </Stack></Disclosure></Stack>;
}
