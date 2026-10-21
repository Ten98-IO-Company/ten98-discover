import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ApiError,errMsg} from '../lib/api';
import {promptCalendar,promptTrackersResponse,promptTrackerResponse,promptTrackerMutationResponse,type PromptTracker} from '../lib/prompt-recurring';
import {modelApi,ModelResponseError} from './OpenRouterModelPicker';
import type {WorkspaceRole} from '@ten98/runtime';

type Role=WorkspaceRole;
type Quote={id:string;expiresAt:string;estimateUsd:string;input:{promptId:string;versionId:string;models:string[];systemText:string;maxCompletionTokens:number;reuseCached?:boolean}};
type Attempt={path:string;body:Record<string,unknown>};
function nextDue(value:string|null,zone:string){if(!value)return 'Not scheduled';try{return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value))+' · '+zone;}catch{return value+' · UTC instant; local zone preview unavailable';}}
export function PromptRecurringPanel({projectId,userId,role,quote,onUnauthorized,onRole,onOpenComparison}:{projectId:string;userId:string;role:Role|null;quote:Quote|null;onUnauthorized:()=>void;onRole:(role:Role)=>void;onOpenComparison:(id:string)=>void}){
 const base='/api/projects/'+projectId+'/prompt-trackers',identity=projectId+':'+userId,live=useRef(identity),generation=useRef(0),controller=useRef<AbortController|null>(null),mounted=useRef(false);
 const authority=useRef({role,revision:0}),dataAuthority=useRef(-1),pointAuthority=useRef(-1),verifiedRole=useRef<{identity:string;revision:number;role:Role}|null>(null);if(authority.current.role!==role)authority.current={role,revision:authority.current.revision+1};
 live.current=identity;
 const[data,setData]=useState<ReturnType<typeof promptTrackersResponse.parse>|null>(null),[point,setPoint]=useState<ReturnType<typeof promptTrackerResponse.parse>|null>(null),[status,setStatus]=useState<'active'|'archived'|'all'>('active'),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState<Attempt|null>(null);
 const[name,setName]=useState(''),[interval,setInterval]=useState<'daily'|'weekly'|'monthly'>('daily'),[timezone,setZone]=useState('UTC'),[hour,setHour]=useState('9'),[minute,setMinute]=useState('0'),[weekday,setWeekday]=useState('1'),[consent,setConsent]=useState(false);
 const attemptRef=useRef<Attempt|null>(null);attemptRef.current=attempt;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;controller.current?.abort();};},[identity]);
 useEffect(()=>{if(!attemptRef.current)setConsent(false);},[quote?.id]);
 const shown=dataAuthority.current===authority.current.revision&&data?.projectId===projectId?data:null,shownPoint=pointAuthority.current===authority.current.revision&&point?.projectId===projectId?point:null,owner=role==='owner'&&verifiedRole.current?.identity===identity&&verifiedRole.current.revision===authority.current.revision&&verifiedRole.current.role==='owner'&&(shown?.role==='owner'||shownPoint?.role==='owner'||attempt!==null),fresh=!!quote&&quote.input.reuseCached===false&&Date.parse(quote.expiresAt)>Date.now();
 function purge(message:string){generation.current++;controller.current?.abort();controller.current=null;verifiedRole.current=null;setData(null);setPoint(null);setConsent(false);setBusy(false);setError(message);}
 function pageUrl(filter=status,after:string|null=cursor){const params=new URLSearchParams();if(filter!=='active')params.set('status',filter);if(after)params.set('cursor',after);const query=params.toString();return base+(query?'?'+query:'');}
 async function request(path=pageUrl(),body?:Record<string,unknown>){
  if(controller.current)return;const abort=new AbortController(),token=++generation.current,scope=identity,roleRevision=authority.current.revision;controller.current=abort;setBusy(true);setError('');
  if(body)setAttempt({path,body});
  try{
   const raw=await modelApi<unknown>(path,{method:body?'POST':'GET',...(body?{body}:{}),signal:abort.signal});if(!mounted.current||live.current!==scope||token!==generation.current||roleRevision!==authority.current.revision)return;
   let currentRole:Role,item:PromptTracker|undefined,page:ReturnType<typeof promptTrackersResponse.parse>|undefined;
   if(body){
    const parsed=promptTrackerMutationResponse.safeParse(raw);if(!parsed.success||parsed.data.projectId!==projectId)throw new Error('The complete recurring acknowledgement could not be verified. Inspect saved status.');
    const parts=path.slice(base.length).split('/').filter(Boolean),{ack}=parsed.data;
    if(parsed.data.role!=='owner'||ack.requestId!==body.requestId||ack.action!==(parts[1]??'create')||parts[0]&&ack.trackerId!==parts[0]||ack.quoteId!==(body.quoteId??null)||parsed.data.item.id!==ack.trackerId||ack.action==='create'&&parsed.data.item.createdRequestId!==body.requestId||ack.action==='run'&&ack.occurrenceId===null)throw new Error('The saved acknowledgement did not match this exact recurring request. Inspect status before retrying.');
    currentRole=parsed.data.role;item=parsed.data.item;
   }else if(path===base||path.startsWith(base+'?')){
    const parsed=promptTrackersResponse.safeParse(raw),filter=new URLSearchParams(path.split('?')[1]??'').get('status')??'active';
    if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.status!==filter||new Set(parsed.data.items.map(row=>row.id)).size!==parsed.data.items.length||parsed.data.items.some(row=>filter==='active'&&row.archivedAt!==null||filter==='archived'&&row.archivedAt===null))throw new Error('The complete tracker page could not be verified. Reload saved status.');
    currentRole=parsed.data.role;page=parsed.data;
   }else{
    const parsed=promptTrackerResponse.safeParse(raw);if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.item.id!==path.slice(base.length+1))throw new Error('The selected tracker could not be verified. Reload saved status.');currentRole=parsed.data.role;item=parsed.data.item;
   }
   verifiedRole.current={identity:scope,revision:roleRevision,role:currentRole};
   if(page){dataAuthority.current=roleRevision;setData(page);setPoint(null);}
   if(item){const saved=item;pointAuthority.current=roleRevision;setPoint({projectId,role:currentRole,item:saved});setData(previous=>previous&&dataAuthority.current===roleRevision?{...previous,role:currentRole,items:previous.items.flatMap(row=>row.id!==saved.id?[row]:previous.status==='active'&&saved.archivedAt!==null||previous.status==='archived'&&saved.archivedAt===null?[]:[saved])}:null);}
   onRole(currentRole);if(body){setAttempt(null);setConsent(false);}
  }catch(cause){if(!mounted.current||live.current!==scope||token!==generation.current||roleRevision!==authority.current.revision)return;if(cause instanceof ApiError&&[401,403,404].includes(cause.status)){purge('Recurring tracking access is unavailable. Reload access.');if(cause.status===401)onUnauthorized();return;}setData(null);setPoint(null);if(cause instanceof ModelResponseError&&cause.readOnly)setConsent(false);setError((body?'This change may already have been accepted. Inspect saved status or retry the identical request. ':'')+errMsg(cause));}
  finally{if(mounted.current&&live.current===scope&&token===generation.current){controller.current=null;setBusy(false);}}
 }
 function calendar(){const result=promptCalendar.safeParse({interval,timezone,hour:Number(hour),minute:Number(minute),weekday:interval==='weekly'?Number(weekday):null});if(!result.success)throw new Error('Choose a daily, weekly or month-end time and supported named zone.');return result.data;}
 function create(event:FormEvent){event.preventDefault();if(!owner||!fresh||attempt)return;try{if(!name.trim())throw new Error('Give this tracker a name.');void request(base,{requestId:crypto.randomUUID(),quoteId:quote!.id,name:name.trim(),calendar:calendar(),approve:consent});}catch(cause){setError(errMsg(cause));}}
 function approve(item:PromptTracker){if(!owner||!fresh||!consent||attempt)return;try{void request(base+'/'+item.id+'/approve',{requestId:crypto.randomUUID(),revision:item.revision,quoteId:quote!.id,calendar:calendar()});}catch(cause){setError(errMsg(cause));}}
 const items=shown?.items??[],visible=shownPoint&&!items.some(item=>item.id===shownPoint.item.id)?[shownPoint.item,...items]:items;
 const same=(item:PromptTracker)=>!!quote&&item.definition.promptId===quote.input.promptId&&item.definition.versionId===quote.input.versionId&&item.definition.systemText===quote.input.systemText&&item.definition.maxCompletionTokens===quote.input.maxCompletionTokens&&JSON.stringify(item.definition.models)===JSON.stringify(quote.input.models);
 return <details className="card stack prompt-recurring" onToggle={event=>{if(event.currentTarget.open)void request();}}>
  <summary>Recurring prompt tracking</summary>
  <p>Each scheduled run requests fresh model answers using the saved prompt version, models, system message and output limit. These API answers do not measure consumer web search.</p>
  <p className="hint">Trackers start paused. Only an owner can approve future spending. Monthly runs use the last calendar day. When clocks change, skipped local times move forward and repeated times use the later occurrence. Missed runs are not backfilled.</p>
    <div className="row"><label>Tracker collection<select value={status} disabled={busy} onChange={event=>{const filter=event.target.value as typeof status;setStatus(filter);setCursor(null);setData(null);setPoint(null);void request(pageUrl(filter,null));}}><option value="active">Active and paused</option><option value="archived">Archived</option><option value="all">All trackers</option></select></label><button className="btn" type="button" disabled={busy} onClick={()=>void request()}>Refresh recurring status</button></div>
  <p className="hint">Showing up to 20 trackers per page. Archiving keeps earlier runs and charge records.</p>
  {busy&&<p role="status">Reading or saving recurring status…</p>}{error&&<p role="alert" className="alert">{error}</p>}
  {attempt&&<div className="banner"><p>Keep this exact request until its result is known. Refreshing status does not start new work.</p><button type="button" className="btn" disabled={busy} onClick={()=>void request(attempt.path===base?pageUrl():attempt.path.replace(/\/(approve|pause|run|archive|restore)$/,''))}>Inspect saved tracker</button><button type="button" className="btn" disabled={busy||!owner} onClick={()=>void request(attempt.path,attempt.body)}>Retry same recurring request</button></div>}
  {owner&&<form className="stack" onSubmit={create}>
   <fieldset disabled={busy||!!attempt} style={{border:0,padding:0,minWidth:0}}><legend>Recurring setup</legend>
    {!fresh&&<p>Choose “Request fresh answers” and explicitly get a new quote above before saving or approving a tracker.</p>}
    <label>Tracker name<input value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></label>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,140px),1fr))',gap:12,minWidth:0}}>
     <label>Cadence<select value={interval} onChange={e=>setInterval(e.target.value as typeof interval)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly, month end</option></select></label>
     <label>Recurring time zone<input value={timezone} maxLength={100} onChange={e=>setZone(e.target.value)}/></label>
     <label>Local hour<input type="number" min={0} max={23} value={hour} onChange={e=>setHour(e.target.value)}/></label><label>Local minute<input type="number" min={0} max={59} value={minute} onChange={e=>setMinute(e.target.value)}/></label>
     {interval==='weekly'&&<label>Weekday<select value={weekday} onChange={e=>setWeekday(e.target.value)}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,i)=><option key={day} value={i}>{day}</option>)}</select></label>}
    </div>
    <label className="row"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I authorize future fresh requests for this definition at each occurrence's current price until paused or approval changes.</label>
    <p className="hint">The master pause, current owner/key/model approval and uncertain-charge checks still apply. There is no app spending limit; your provider account limits apply.</p>
    <button className="btn primary" disabled={!fresh} type="submit">{consent?'Approve and schedule new tracker':'Save paused tracker'}</button>
   </fieldset>
  </form>}
  {(shown||shownPoint)&&<div className="stack"><h3>{shown?.items.length??0} trackers on this page</h3>{shownPoint&&!items.some(item=>item.id===shownPoint.item.id)&&<p>Selected tracker outside this page</p>}{visible.map(item=><article className="card stack" key={item.id}>
   <h4 style={{overflowWrap:'anywhere'}}>{item.name}</h4><p>{item.archivedAt?'Archived':item.enabled?'Enabled':'Paused'} · {item.calendar.interval==='monthly'?'month end':item.calendar.interval} · Next {nextDue(item.nextDueAt,item.calendar.timezone)}</p>
   <p>{item.definition.models.join(' + ')} · Prompt version <bdi>{item.definition.versionId}</bdi></p>{item.lastStatus&&<p role="status">{item.lastStatus}</p>}
   {owner&&!item.archivedAt&&<div className="row"><button type="button" className="btn" disabled={busy||!!attempt||!item.enabled} onClick={()=>void request(base+'/'+item.id+'/pause',{requestId:crypto.randomUUID(),revision:item.revision})}>Pause {item.name}</button><button type="button" className="btn" disabled={busy||!!attempt||!fresh||!same(item)||!consent} onClick={()=>approve(item)}>Approve and resume {item.name}</button><button type="button" className="btn" disabled={busy||!!attempt||!item.enabled} onClick={()=>void request(base+'/'+item.id+'/run',{requestId:crypto.randomUUID(),revision:item.revision})}>Run now {item.name}</button></div>}
   {owner&&<button type="button" className="btn" disabled={busy||!!attempt} onClick={()=>void request(base+'/'+item.id+'/'+(item.archivedAt?'restore':'archive'),{requestId:crypto.randomUUID(),revision:item.revision})}>{item.archivedAt?'Restore paused':'Archive'} {item.name}</button>}
   <p className="hint">Pausing stops requests that have not been sent. Requests already sent may still be charged; open the original run to cancel remaining requests or check an unconfirmed charge. Restored trackers need approval before running again.</p>
   <ul>{item.occurrences.map(o=><li key={o.id}>{o.scheduledFor} · {o.status}{o.reason?' · '+o.reason:''}{o.comparisonId&&<button type="button" className="btn ghost" disabled={busy} onClick={()=>onOpenComparison(o.comparisonId!)}>Open occurrence comparison</button>}</li>)}</ul>
   <p className="hint">Latest 10 scheduled runs within the saved history period. Charge records are kept separately from answers, which may expire.</p>
  </article>)}{shown&&<div className="row">{cursor&&<button type="button" className="btn" disabled={busy} onClick={()=>{setCursor(null);setPoint(null);void request(pageUrl(status,null));}}>First tracker page</button>}{shown.nextCursor&&<button type="button" className="btn" disabled={busy} onClick={()=>{const next=shown.nextCursor;setCursor(next);setPoint(null);void request(pageUrl(status,next));}}>Next tracker page</button>}</div>}</div>}
 </details>;
}
