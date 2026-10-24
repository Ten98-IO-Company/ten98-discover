import {readResponseText} from '@ten98/runtime';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,DangerZoneFlow,StatusLine,Text} from '@ten98/ui';
import {analyticsResetInput,analyticsResetState,analyticsResetResult,type AnalyticsResetInput,type AnalyticsResetState,type AnalyticsResetResult} from '../lib/analytics-reset';

export class ResetError extends Error {readonly status:number;constructor(status:number){super('Reset request unavailable.');this.status=status;}}
export async function request(url:string,signal:AbortSignal,body?:unknown):Promise<unknown>{
 const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},signal,...body?{body:JSON.stringify(body)}:{}});
 if(!response.ok){await response.body?.cancel();throw new ResetError(response.status);}
 if(!response.headers.get('content-type')?.startsWith('application/json')){await response.body?.cancel();throw Error('Invalid reset reply.');}
 if(!response.body)throw Error('Missing reset reply.');
 try{return JSON.parse(await readResponseText(response,{maxBytes:4096,signal}));}catch(error){throw error instanceof RangeError?Error('Oversized reset reply.'):error;}
}
type Props={projectId:string;userId:string;disabled?:boolean;authorityOwner?:string;isCurrent?:()=>boolean;pendingRequest?:{current:AnalyticsResetInput|null};onUnauthorized:()=>void;onReset:()=>void;onBusy?:(busy:boolean)=>void};
export function AnalyticsResetPanel(props:Props){return <ResetInner key={props.projectId+':'+props.userId} {...props}/>;}
function ResetInner({projectId,disabled=false,authorityOwner='',isCurrent,pendingRequest,onUnauthorized,onReset,onBusy}:Props){
 const ownedPending=useRef<AnalyticsResetInput|null>(null),pending=pendingRequest??ownedPending;
 const [open,setOpen]=useState(false),[state,setState]=useState<AnalyticsResetState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState<AnalyticsResetInput|null>(pending.current),[result,setResult]=useState<AnalyticsResetResult|null>(null);
 const mounted=useRef(true),generation=useRef(0),operation=useRef<AbortController|null>(null),unauthorized=useRef(false),callbacks=useRef({onUnauthorized,onReset,onBusy});callbacks.current={onUnauthorized,onReset,onBusy};
 const live=useRef({authorityOwner,isCurrent}),verifiedOwner=useRef(authorityOwner);live.current={authorityOwner,isCurrent};
 const allowed=()=>isCurrent?.()??true,verified=state&&verifiedOwner.current===authorityOwner&&allowed()?state:null;
 const url='/api/projects/'+encodeURIComponent(projectId)+'/analytics-reset';
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;operation.current?.abort();callbacks.current.onBusy?.(false);};},[]);
 const failure=(value:unknown)=>{setState(null);if(value instanceof ResetError&&value.status===401){setResult(null);if(!unauthorized.current){unauthorized.current=true;callbacks.current.onUnauthorized();}return;}
  if(value instanceof ResetError&&(value.status===403||value.status===404)){setState(null);setResult(null);setError('Reset is unavailable for your current access. Reload access before continuing.');return;}
  setError(value instanceof ResetError&&value.status===409?'The project revision changed. Reload access. An unknown reset keeps its original request for exact retry.':value instanceof ResetError&&value.status===429?'Too many requests. Wait a minute, then retry the same request.':'The reply could not be verified. A submitted reset may already have committed. Reload access, then retry the same request.');};
 const run=async(write:boolean)=>{
  if(operation.current||!allowed()||write&&(disabled||!verified))return;
  const input=write?pending.current??analyticsResetInput.parse({requestId:crypto.randomUUID(),revision:verified!.revision,confirmation:'RESET'}):undefined;
  if(input){pending.current=input;setAttempt(input);}const ctrl=new AbortController(),gen=++generation.current;operation.current=ctrl;setBusy(true);callbacks.current.onBusy?.(true);setError('');
  const owner=authorityOwner,timer=setTimeout(()=>ctrl.abort(),15000),sameOwner=()=>mounted.current&&generation.current===gen&&operation.current===ctrl&&live.current.authorityOwner===owner&&allowed(),current=()=>sameOwner()&&!ctrl.signal.aborted;
  try{const value=await request(url,ctrl.signal,input);if(!current())return;
   if(input){const data=analyticsResetResult.parse(value);if(data.state.projectId!==projectId||data.ack.projectId!==projectId||data.ack.requestId!==input.requestId||data.ack.appliedRevision!==input.revision+1)throw Error('Mismatched reset acknowledgment.');
    if(!current())return;verifiedOwner.current=owner;setState(data.state);setResult(data);pending.current=null;setAttempt(null);callbacks.current.onReset();
   }else{const data=analyticsResetState.parse(value);if(data.projectId!==projectId)throw Error('Mismatched reset project.');if(!current())return;verifiedOwner.current=owner;setState(data);}
  }catch(value){if(sameOwner()){if(ctrl.signal.aborted){setState(null);setError(input?'The request timed out. Reset may already have committed. Reload access, then retry the same reset.':'Reset access took too long. Reload access to continue.');}else failure(value);}}
  finally{clearTimeout(timer);if(mounted.current&&gen===generation.current&&operation.current===ctrl){operation.current=null;setBusy(false);if(live.current.authorityOwner===owner&&allowed())callbacks.current.onBusy?.(false);}}
 };
 // The closed state reads nothing; opening it reads the current reset access before any action is offered.
 if(!open)return <Button variant="ghost" type="button" disabled={disabled||!allowed()} onClick={()=>{if(allowed()){setOpen(true);void run(false);}}}>Reset analytics</Button>;
 return <section className="stack" aria-label="Reset project analytics" aria-busy={busy} style={{minWidth:0,overflowWrap:'anywhere'}}>
  {verified&&<Text>Website: <strong>{verified.name}</strong></Text>}
  {result&&verified&&<StatusLine tone="success">Reset accepted. Earlier analytics is unavailable. {verified.cleanup==='pending'?'Stored-data cleanup continues in bounded background batches.':'Stored native data cleanup is complete; bounded retry tombstones may remain.'}</StatusLine>}
  {!result&&<DangerZoneFlow description="The website, tracking key, collection settings and saved configurations stay. Provider reports, Google imports, tracked links/pixels, provider spending records and other websites stay separate. Collection can resume under the current policy; previous grants and recording capabilities expire." busy={busy} error={error||undefined}
   disabled={disabled||!verified} messages={{retry:'Retry the same reset'}}
   unconfirmed={attempt?'A reset was submitted. Retry uses the same confirmation, project revision and request ID. Reloading access does not acknowledge or repeat it.':undefined}
   actions={[{id:'reset-analytics',title:'Reset analytics',description:'This permanently removes earlier native analytics for this website: events, visitor activity, session properties, identity links, performance, recordings and heatmaps. It cannot be undone.',confirmLabel:'Permanently reset analytics',confirmationText:'RESET',retryOnly:true}]}
   onConfirm={()=>run(true)}/>}
  {result&&error&&<Alert tone="danger" variant="inline">{error}</Alert>}
  <div className="row" style={{flexWrap:'wrap'}}><Button variant="secondary" type="button" disabled={busy||!allowed()} onClick={()=>void run(false)}>Reload reset access</Button><Button variant="ghost" type="button" disabled={busy} onClick={()=>setOpen(false)}>Close reset</Button></div>
 </section>;
}
