import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import {RankScheduleView,type ScheduleForm,type ScheduleInfo,type SchedulePreview,type ScheduleQuote} from './RankScheduleView';

type Props={workspaceId:string;projectId:string;userId:string;trackerId:string;trackerName:string;quoteId?:string;knownQuoteExpiresAt?:string;backLabel?:string;onUnauthorized:()=>void;onBack:()=>void;onPrepareQuote:()=>void};
type Role='owner'|'admin'|'editor'|'viewer';
type Envelope={role:Role;trackerId:string;authoredRevision:number;canManage:boolean;schedule:ScheduleInfo;replayed?:boolean};
type Calendar={interval:'daily'|'weekly'|'monthly';timezone:string;hour:number;minute:number;weekday:number|null};
type Intent={kind:'approve'|'disable';body:Record<string,unknown>;revision:number;calendar?:Calendar};
type Operation={controller:AbortController;write:boolean};
type State={data:Envelope|null;quote:ScheduleQuote|null;preview:SchedulePreview|null;form:ScheduleForm;loading:boolean;working:boolean;pending:boolean;conflict:boolean;dirty:boolean;error:string;notice:string;focus:boolean;now:number};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const integer=(v:unknown,min:number,max:number)=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&v.length<=40&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const role=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const money=(v:unknown):v is string=>typeof v==='string'&&v.length<=14&&/^(?:0|[1-9]\d{0,6})\.\d{6}(?![\s\S])/.test(v)&&BigInt(v.replace('.',''))<=1_000_000_000_000n;
const micros=(v:string)=>BigInt(v.replace('.',''));
function validSchedule(v:unknown,id:string):v is Envelope{
  if(!object(v)||!role(v.role)||v.trackerId!==id||!integer(v.authoredRevision,1,2147483646)||v.canManage!==(v.role==='owner')||!object(v.schedule)||(v.replayed!==undefined&&typeof v.replayed!=='boolean'))return false;
  const s=v.schedule;if(typeof s.enabled!=='boolean'||typeof s.approvalStale!=='boolean'||!['manual','daily','weekly','monthly'].includes(s.interval)||!nullableDate(s.nextDueAt)||!Array.isArray(s.staleReasons)||s.staleReasons.length>10||!s.staleReasons.every((r:unknown)=>text(r,100,1)))return false;
  if(s.interval==='manual'){if(s.timezone!==null||s.hour!==null||s.minute!==null||s.weekday!==null)return false;}
  else if(!text(s.timezone,100,1)||!integer(s.hour,0,23)||!integer(s.minute,0,59)||(s.interval==='weekly'?!integer(s.weekday,0,6):s.weekday!==null))return false;
  if(s.approval!==null){const a=s.approval;if(!object(a)||!uuid(a.id)||!nullableDate(a.approvedAt)||!uuid(a.approvedByUserId)||!uuid(a.connectionId)||(a.connectionName!==undefined&&!text(a.connectionName,120,1)))return false;}
  return !s.enabled||s.approval!==null&&s.nextDueAt!==null;
}
function validPreview(v:unknown,c:Calendar):v is SchedulePreview{
  if(!object(v)||!date(v.capturedAt)||v.timezone!==c.timezone||!Array.isArray(v.occurrences)||v.occurrences.length!==5)return false;
  let previous=Date.parse(v.capturedAt);
  for(const row of v.occurrences){if(!object(row)||!date(row.utc)||!text(row.local,19,19)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(row.local)||!integer(row.offsetSeconds,-86400,86400))return false;const utc=Date.parse(row.utc);if(utc<=previous||Date.parse(row.local+'Z')!==utc+row.offsetSeconds*1000)return false;previous=utc;}
  return true;
}
function quoteDisplay(v:unknown,id:string,trackerId:string,knownExpiry?:string):ScheduleQuote|null{
  if(!object(v)||!role(v.role)||!object(v.run))throw new Error('The quote response could not be verified.');const r=v.run;
  if(r.id!==id||r.trackerId!==trackerId)throw new Error('The quote belongs to another tracker.');
  if(r.status!=='quoted'||r.method!=='queued'||r.trigger!=='manual'||r.isSubset!==false||r.startedAt!==null)return null;
  if(typeof r.canStart!=='boolean'||!date(r.expiresAt)||!money(r.estimateUsd)||!integer(r.taskCount,1,2000)||!object(r.target)||!Array.isArray(r.quotedTasks)||r.quotedTasks.length!==r.taskCount)throw new Error('The quote response could not be verified.');
  const t=r.target;if(!text(t.domain,253,1)||!integer(t.locationCode,1,2147483647)||!text(t.languageCode,16,1)||!integer(t.depth,10,100)||t.depth%10!==0||!integer(t.maxCrawlPages,1,10))throw new Error('The quote target could not be verified.');
  const pairs=new Set<string>(),devices=new Set<string>();let total=0n;
  for(const task of r.quotedTasks){if(!object(task)||!uuid(task.keywordId)||!text(task.keyword,200,1)||!['desktop','mobile'].includes(task.device)||!money(task.maximumUsd))throw new Error('The quote tasks could not be verified.');const pair=task.keywordId.toLowerCase()+':'+task.device;if(pairs.has(pair))throw new Error('The quote contains duplicate checks.');pairs.add(pair);devices.add(task.device);total+=micros(task.maximumUsd);}
  if(total!==micros(r.estimateUsd))throw new Error('The quote maximum could not be verified.');
  const expiresAt=date(knownExpiry)&&Date.parse(knownExpiry)<Date.parse(r.expiresAt)?knownExpiry:r.expiresAt;
  if(!r.canStart&&Date.parse(expiresAt)>Date.now())return null;
  return {id:r.id,targetText:`${t.domain} and subdomains · Location ${t.locationCode} · Language ${t.languageCode} · ${[...devices].sort().join(' + ')} · Up to ${t.depth} results · ${t.maxCrawlPages} maximum billable page(s)`,taskCount:r.taskCount,estimateUsd:r.estimateUsd,expiresAt,expired:!r.canStart||Date.parse(expiresAt)<=Date.now()};
}
const blank=():ScheduleForm=>({interval:'daily',timezone:'UTC',hour:'9',minute:'0',weekday:'1',consent:false});
function calendar(form:ScheduleForm):Calendar|null{
  if(!text(form.timezone,100,1)||form.timezone.trim()!==form.timezone||/[\x00-\x1f\x7f]/.test(form.timezone)||!/^\d{1,2}$/.test(form.hour)||!/^\d{1,2}$/.test(form.minute))return null;
  const hour=Number(form.hour),minute=Number(form.minute),weekday=form.interval==='weekly'?Number(form.weekday):null;
  if(!integer(hour,0,23)||!integer(minute,0,59)||(weekday!==null&&(!/^[0-6]$/.test(form.weekday)||!integer(weekday,0,6))))return null;
  return {interval:form.interval,timezone:form.timezone,hour,minute,weekday};
}
export function RankSchedulePanel(props:Props){return <ScheduleController key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.trackerId}:${props.quoteId??''}`} {...props}/>;}
function ScheduleController(props:Props){
  const prefix=useId()+'-rank-schedule-',base=`/api/projects/${props.projectId}/rank-trackers/${props.trackerId}/schedule`;
  const initial=():State=>({data:null,quote:null,preview:null,form:blank(),loading:false,working:false,pending:false,conflict:false,dirty:false,error:'',notice:'',focus:true,now:Date.now()});
  const [s,setState]=useState(initial),state=useRef(s),operation=useRef<Operation|null>(null),intent=useRef<Intent|null>(null),alive=useRef(true);
  const knownDeadline=useRef<number|null>(null);
  if(date(props.knownQuoteExpiresAt)){const incoming=Date.parse(props.knownQuoteExpiresAt);knownDeadline.current=Math.min(knownDeadline.current??incoming,incoming);}
  const expiry=(quote:ScheduleQuote)=>Math.min(Date.parse(quote.expiresAt),knownDeadline.current??Infinity);
  function patch(value:Partial<State>){if(alive.current){state.current={...state.current,...value};setState(state.current);}}
  function invalidate(){operation.current?.controller.abort();operation.current=null;}
  const locked=()=>operation.current?.write===true||intent.current!==null;
  const current=(op:Operation)=>alive.current&&operation.current===op;
  function leave(){return !locked()&&(!state.current.dirty||window.confirm('Discard the unsaved schedule setup?'));}
  useBlocker({withResolver:false,shouldBlockFn:()=>!leave(),enableBeforeUnload:()=>locked()||state.current.dirty});
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;invalidate();};},[]);
  useEffect(()=>{if(s.focus&&!s.loading){const h=document.getElementById(prefix+'heading');if(h){h.focus();patch({focus:false});}}},[s.focus,s.loading,s.data]);
  useEffect(()=>{if(!s.quote)return;const wait=expiry(s.quote)-Date.now();if(wait<=0)return;const timer=setTimeout(()=>patch({now:Date.now()}),Math.min(wait+20,2147483647));return()=>clearTimeout(timer);},[s.quote?.id,s.quote?.expiresAt,props.knownQuoteExpiresAt]);
  function begin(write=false){if(!alive.current||operation.current?.write||(!write&&intent.current))return null;invalidate();const op={controller:new AbortController(),write};operation.current=op;patch({loading:!write,working:write,error:'',notice:''});return op;}
  function finish(op:Operation){if(current(op)){operation.current=null;patch({loading:false,working:false});}}
  function purge(message:string,unauthorized=false){invalidate();intent.current=null;state.current={...initial(),error:message,focus:false};setState(state.current);if(unauthorized)props.onUnauthorized();}
  function failure(error:unknown,op:Operation){if(!current(op))return;if(error instanceof ApiError&&[401,403,404].includes(error.status)){purge(errMsg(error),error.status===401);return;}if(error instanceof Error&&error.name==='AbortError')return;patch({error:errMsg(error)});}
  function accept(data:Envelope){patch({data,...(!data.canManage?{quote:null,preview:null,form:blank(),dirty:false}:{})});}
  async function load(){const op=begin();if(!op)return;patch({data:null,quote:null,preview:null,form:blank(),dirty:false});
    try{const data=await api<unknown>(base,{signal:op.controller.signal});if(!current(op))return;if(!validSchedule(data,props.trackerId))throw new Error('The schedule response could not be verified.');accept(data);patch({conflict:false});
      if(props.quoteId&&data.canManage){const raw=await api<unknown>(`/api/projects/${props.projectId}/rank-checks/${props.quoteId}`,{signal:op.controller.signal});if(!current(op))return;const quote=quoteDisplay(raw,props.quoteId,props.trackerId,knownDeadline.current===null?undefined:new Date(knownDeadline.current).toISOString());
        // A quote response also reflects current membership; a demotion must not
        // leave an owner form enabled from the earlier schedule read.
        if(object(raw)&&raw.role!=='owner'){purge('Only current workspace owners can approve this schedule.');return;}
        if(quote)knownDeadline.current=expiry(quote);
        const saved=data.schedule;
        patch({quote,form:{...blank(),...(saved.interval!=='manual'?{interval:saved.interval,timezone:saved.timezone!,hour:String(saved.hour),minute:String(saved.minute),weekday:String(saved.weekday??1)}:{})},notice:quote?'':'Prepare your own unstarted full queued quote to approve a schedule.'});}
    }catch(error){failure(error,op);}finally{finish(op);}}
  function change(value:ScheduleForm){if(locked()||state.current.loading||!state.current.data?.canManage)return;const before=state.current.form,calendarChanged=['interval','timezone','hour','minute','weekday'].some(k=>before[k as keyof ScheduleForm]!==value[k as keyof ScheduleForm]);
    patch({form:{...value,consent:calendarChanged?false:value.consent},...(calendarChanged?{preview:null}:{}),dirty:true,error:'',notice:''});}
  async function preview(){const at=state.current,c=calendar(at.form);if(locked()||!at.data?.canManage||at.conflict||!at.quote||at.quote.expired||expiry(at.quote)<=Date.now())return;if(!c){patch({error:'Enter a timezone, hour, minute and weekly day in the supported ranges.'});return;}
    const op=begin();if(!op)return;patch({preview:null,form:{...at.form,consent:false}});try{const data=await api<unknown>(base+'/preview',{method:'POST',body:c,signal:op.controller.signal});if(!current(op))return;if(!validPreview(data,c))throw new Error('The calendar preview could not be verified.');patch({preview:data});}catch(error){failure(error,op);}finally{finish(op);}}
  async function send(saved:Intent){if(operation.current?.write||!alive.current)return;intent.current=saved;const op=begin(true);if(!op)return;patch({pending:false});
    try{const data=await api<unknown>(base+'/'+saved.kind,{method:'POST',body:saved.body,signal:op.controller.signal});if(!current(op))return;if(!validSchedule(data,props.trackerId)||typeof data.replayed!=='boolean')throw new Error('The save response could not be verified.');
      if(!data.replayed){if(saved.kind==='approve'){const c=saved.calendar!,a=data.schedule.approval;if(!data.canManage||!data.schedule.enabled||!a||!date(a.approvedAt)||!date(data.schedule.nextDueAt)||Date.parse(data.schedule.nextDueAt)<=Date.parse(a.approvedAt)||a.approvedByUserId!==props.userId||data.authoredRevision!==saved.revision+1||data.schedule.interval!==c.interval||data.schedule.timezone!==c.timezone||data.schedule.hour!==c.hour||data.schedule.minute!==c.minute||data.schedule.weekday!==c.weekday)throw new Error('The saved approval could not be verified.');}
        else if(data.schedule.enabled||data.schedule.nextDueAt!==null||![saved.revision,Math.min(saved.revision+1,2147483646)].includes(data.authoredRevision))throw new Error('The disabled schedule could not be verified.');}
      intent.current=null;accept(data);patch({pending:false,conflict:false,dirty:false,preview:null,form:{...state.current.form,consent:false},notice:data.replayed?'The original request receipt was recovered. The current schedule is shown.':saved.kind==='approve'?'Recurring spending approved. No check was started by this save.':'Schedule disabled. Work already sent retains its charges.',focus:true});
    }catch(error){if(!current(op))return;if(error instanceof ApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)){intent.current=null;patch({pending:false,conflict:error.status===409});failure(error,op);}
      else patch({pending:true,error:error instanceof ApiError&&error.status===429?'The retry was rate limited. Wait a minute, then retry the same request.':''});
    }finally{finish(op);}}
  function approve(){const at=state.current,c=calendar(at.form);if(locked()||at.loading||!at.data?.canManage||at.conflict||!at.quote||!c||!at.preview||!at.form.consent||at.quote.expired||expiry(at.quote)<=Date.now())return;
    try{void send({kind:'approve',revision:at.data.authoredRevision,calendar:c,body:structuredClone({requestId:crypto.randomUUID(),revision:at.data.authoredRevision,quoteId:at.quote.id,...c})});}catch{patch({error:'This browser could not prepare a safe approval request. Reload before trying again.'});}}
  function disable(){const at=state.current;if(locked()||at.loading||!at.data?.canManage||!at.data.schedule.enabled)return;if(!window.confirm('Disable this schedule? Future scheduled requests, including unsent work, will stop. Requests already sent and their charges remain.'))return;
    try{void send({kind:'disable',revision:at.data.authoredRevision,body:{requestId:crypto.randomUUID(),revision:at.data.authoredRevision}});}catch{patch({error:'This browser could not prepare a safe disable request. Reload before trying again.'});}}
  function navigate(callback:()=>void){if(!leave())return;invalidate();patch({dirty:false});callback();}
  const quote=s.quote?{...s.quote,expiresAt:new Date(expiry(s.quote)).toISOString(),expired:s.quote.expired||expiry(s.quote)<=s.now}:null,c=calendar(s.form),editable=!!s.data?.canManage&&!locked()&&!s.loading&&!s.working&&!s.conflict&&quote!==null&&!quote.expired;
  return <RankScheduleView idPrefix={prefix} backLabel={props.backLabel??'Back to tracker'} trackerName={props.trackerName} schedule={s.data?.schedule??null} quote={quote} preview={s.preview} form={s.form} canManage={!!s.data?.canManage} loading={s.loading} working={s.working} locked={locked()} pending={s.pending} conflict={s.conflict}
    canPreview={editable&&c!==null} canApprove={editable&&c!==null&&s.preview!==null&&s.form.consent} canDisable={!!s.data?.canManage&&s.data.schedule.enabled&&!s.loading&&!s.working&&!locked()}
    error={s.error} notice={s.notice} onChange={change} onPreview={()=>void preview()} onApprove={approve} onDisable={disable} onRetry={()=>{if(intent.current)void send(intent.current);}} onRefresh={()=>{if(!leave())return;void load();}} onBack={()=>navigate(props.onBack)} onPrepareQuote={()=>navigate(props.onPrepareQuote)}/>;
}
