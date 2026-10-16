import {useEffect,useRef,useState} from 'react';
import {projectDeleteInput,projectDeleteState,projectDeleteResult,type ProjectDeleteInput,type ProjectDeleteState} from '../lib/project-delete';
import {request as boundedRequest,ResetError as MutationError} from './AnalyticsResetPanel';

type Props={workspaceId:string;projectId:string;userId:string;disabled?:boolean;authorityOwner:string;isCurrent:()=>boolean;pendingRequest:{current:ProjectDeleteInput|null};onUnauthorized:()=>void;onDeleted:()=>void;onBusy?:(busy:boolean)=>void};
export function ProjectDeletePanel(props:Props){return <DeleteInner key={JSON.stringify([props.workspaceId,props.projectId,props.userId])} {...props}/>;}
function DeleteInner({workspaceId,projectId,disabled=false,authorityOwner,isCurrent,pendingRequest,onUnauthorized,onDeleted,onBusy}:Props){
 const[open,setOpen]=useState(false),[state,setState]=useState<ProjectDeleteState|null>(null),[typed,setTyped]=useState(''),[attempt,setAttempt]=useState(pendingRequest.current),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(true),generation=useRef(0),operation=useRef<AbortController|null>(null),denied=useRef(false),live=useRef({authorityOwner,isCurrent}),verifiedOwner=useRef(''),callbacks=useRef({onUnauthorized,onDeleted,onBusy});live.current={authorityOwner,isCurrent};callbacks.current={onUnauthorized,onDeleted,onBusy};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;operation.current?.abort();callbacks.current.onBusy?.(false);};},[]);
 const currentAccess=()=>isCurrent()&&live.current.authorityOwner===authorityOwner,verified=currentAccess()&&verifiedOwner.current===authorityOwner?state:null;
 const url='/api/workspaces/'+encodeURIComponent(workspaceId)+'/projects/'+encodeURIComponent(projectId)+'/delete';
 const run=async(write:boolean)=>{
  if(operation.current||!currentAccess()||write&&(disabled||!verified||!pendingRequest.current&&(!verified.item||typed!=='DELETE')))return;
  const input=write?pendingRequest.current??projectDeleteInput.parse({requestId:crypto.randomUUID(),revision:verified!.item!.revision,confirmation:typed}):undefined;
  if(input){pendingRequest.current=input;setAttempt(input);}const ctrl=new AbortController(),gen=++generation.current,owner=authorityOwner;operation.current=ctrl;setBusy(true);setError('');callbacks.current.onBusy?.(true);
  const same=()=>mounted.current&&generation.current===gen&&operation.current===ctrl&&live.current.authorityOwner===owner&&isCurrent(),current=()=>same()&&!ctrl.signal.aborted,timer=setTimeout(()=>ctrl.abort(),15000);
  try{const value=await boundedRequest(url,ctrl.signal,input);if(!current())return;
   if(input){const data=projectDeleteResult.parse(value);if(data.workspaceId!==workspaceId||data.ack.workspaceId!==workspaceId||data.ack.projectId!==projectId||data.ack.requestId!==input.requestId||data.ack.appliedRevision!==input.revision)throw Error('Mismatched deletion acknowledgment.');if(!current())return;pendingRequest.current=null;setAttempt(null);setTyped('');callbacks.current.onDeleted();}
   else{const data=projectDeleteState.parse(value);if(data.workspaceId!==workspaceId||data.projectId!==projectId)throw Error('Mismatched deletion access.');if(!current())return;verifiedOwner.current=owner;setState(data);}
  }catch(value){if(same()){setState(null);if(ctrl.signal.aborted)setError(input?'The request timed out. Deletion may already have committed. Reload deletion access and retry the same request.':'Deletion access took too long. Reload access.');
   else if(value instanceof MutationError&&value.status===401){if(!denied.current){denied.current=true;callbacks.current.onUnauthorized();}}
   else setError(value instanceof MutationError&&(value.status===403||value.status===404)?'Deletion is unavailable for your current access. Reload deletion access.':value instanceof MutationError&&value.status===409?'The website revision or provider work changed. Finish pending work or reload access. A submitted request keeps its original confirmation and request ID.':value instanceof MutationError&&value.status===429?'Too many requests. Wait a minute, then retry the same request.':'The reply could not be verified. Deletion may already have committed. Reload deletion access and retry only the same request.');}}
  finally{clearTimeout(timer);if(mounted.current&&generation.current===gen&&operation.current===ctrl){operation.current=null;setBusy(false);if(live.current.authorityOwner===owner&&isCurrent())callbacks.current.onBusy?.(false);}}
 };
 const style={minHeight:44,minWidth:0,maxWidth:'100%',whiteSpace:'normal' as const,overflowWrap:'anywhere' as const};
 if(!open)return <button className="btn danger" style={style} type="button" disabled={disabled||!currentAccess()} onClick={()=>{if(currentAccess()){setOpen(true);void run(false);}}}>{attempt?'Resolve submitted deletion':'Delete website'}</button>;
 return <section className="stack" aria-label="Delete website" aria-busy={busy} style={{minWidth:0,overflowWrap:'anywhere'}}>
  <h3>Delete website</h3><p>This permanently deletes this website, its tracking key, native analytics, recordings, heatmaps, website settings and website-specific saved reports and configurations. It cannot be undone.</p><p className="hint">Other websites, workspaces, tracked links/pixels and provider spending records stay. Finish or cancel reserved provider work and reconcile uncertain charges first. Existing board references to this website become unavailable.</p>
  {verified?.item&&<p>Website: <strong>{verified.item.name}</strong></p>}{verified&&!verified.item&&<p>This website is unavailable. A submitted request can still be retried to verify its original acknowledgment.</p>}
  {error&&<p className="alert" role="alert">{error}</p>}
  {attempt?<p className="hint">An outcome is unverified. Retry sends exactly the same website, revision, DELETE confirmation and request ID. Reloading access does not acknowledge the deletion.</p>:<label className="field">Type DELETE to confirm<input className="input" style={style} disabled={busy||disabled||!verified?.item} autoComplete="off" spellCheck={false} value={typed} onChange={event=>setTyped(event.target.value)}/></label>}
  <div className="row" style={{flexWrap:'wrap'}}><button className="btn danger" style={style} type="button" disabled={busy||disabled||!verified||!attempt&&(!verified.item||typed!=='DELETE')} onClick={()=>void run(true)}>{attempt?'Retry the same deletion':'Permanently delete website'}</button><button className="btn ghost" style={style} type="button" disabled={busy||!currentAccess()} onClick={()=>void run(false)}>Reload deletion access</button><button className="btn ghost" style={style} type="button" disabled={busy} onClick={()=>{setOpen(false);setTyped('');}}>Close deletion</button></div>
 </section>;
}
