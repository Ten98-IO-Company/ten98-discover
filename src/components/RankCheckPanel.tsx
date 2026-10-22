import {useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import type {RankRole,RankTracker,RankConnection} from './RankTrackingView';
import {RankCheckView,type RankQuoteDisplay} from './RankCheckView';
import {RankCheckResults,type RankResultDisplay,type RankHistoryDisplay} from './RankCheckResults';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime';
import {useConfirmDialog} from './useConfirmDialog';

type Status='quoted'|'queued'|'running'|'waiting'|'completed'|'partial'|'failed'|'cancelled'|'skipped';
type Cost='not_started'|'pending'|'uncertain'|'final';
type Target={domain:string;locationCode:number;languageCode:string;depth:number;maxCrawlPages:number};
type Summary={id:string;status:Status;trigger:'manual'|'scheduled';scheduledFor:string|null;method:'queued'|'live';isSubset:boolean;taskCount:number;createdAt:string;startedAt:string|null;completedAt:string|null;quoteExpired:boolean;rawExpiredAt:string|null;dataExpiredAt:string|null;costStatus:Cost;estimateUsd:string;knownChargeUsd:string;diagnostic:string|null};
type Dispatch={id:string;ordinal:number;phase:'reserved'|'dispatched'|'collecting'|'finished'|'uncertain'|'cancelled';taskCount:number;dispatchedAt:string|null;completedAt:string|null;diagnostic:string|null;costStatus:'reserved'|'dispatched'|'settled'|'uncertain'|'cancelled';estimateUsd:string;actualUsd:string|null;canReconcile:boolean};
type Task={id:string;keywordId:string;keyword:string;matchCase:boolean;device:'desktop'|'mobile';status:'pending'|'ranked'|'not_found'|'failed'|'uncertain'|'cancelled'|'unavailable';position:number|null;rankBasis:'organic'|'absolute'|null;absolutePosition:number|null;rankingUrl:string|null;serpFeatures:string[]|null;checkedDepth:number|null;returnedItemCount:number|null;observedAt:string|null;retrievedAt:string|null;diagnostic:string|null;rawExpiredAt:string|null;dataExpiredAt:string|null};
type Run=Summary&{trackerId:string;target:Target;connectionName:string;dispatchCount:number;priceAsOf:string|null;expiresAt:string|null;canStart:boolean;canCancel:boolean;quotedTasks:Array<{keywordId:string;keyword:string;device:'desktop'|'mobile';maximumUsd:string}>;dispatches:Dispatch[];tasks:Task[]};
export type RankCheckEntry={mode:'history'|'setup'|'run';keywordIds?:readonly string[];runId?:string;purpose?:'schedule';knownExpiresAt?:string};
type Props={workspaceId:string;projectId:string;userId:string;tracker:RankTracker;connections:readonly RankConnection[];vaultConfigured:boolean;entry:RankCheckEntry;backLabel?:string;onUnauthorized:()=>void;onBack:()=>void;onOpenProviders:()=>void;onConfigureSchedule:(quoteId:string,expiresAt:string)=>void};
type Intent={kind:'quote'|'start'|'cancel'|'reconcile';path:string;body:Record<string,unknown>;runId?:string;target?:Target;method?:'queued'|'live';subset?:boolean;pairs?:string[];taskCount?:number;devices?:string[]};
type Operation={controller:AbortController;write:boolean};
type State={role:RankRole|null;phase:'history'|'setup'|'run';tracker:RankTracker;history:Summary[];nextCursor:string|null;loaded:boolean;run:Run|null;connectionId:string;recoveryConnectionId:string;method:'queued'|'live';reading:boolean;writing:boolean;pending:boolean;conflict:boolean;dirty:boolean;error:string;notice:string;focus:boolean;now:number};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const integer=(v:unknown,min=0,max=2147483647)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const money=(v:unknown):v is string=>typeof v==='string'&&v.length<=24&&/^(?:0|[1-9][0-9]*)\.[0-9]{6}$/.test(v);
const role=(v:unknown):v is RankRole=>workspaceRoles.includes(v as WorkspaceRole);
const writer=(v:RankRole|null)=>v!==null&&v!=='viewer';
const distinct=(rows:Array<{id:string}>)=>new Set(rows.map(r=>r.id.toLowerCase())).size===rows.length;
function summary(v:unknown):v is Summary{return object(v)&&uuid(v.id)&&['quoted','queued','running','waiting','completed','partial','failed','cancelled','skipped'].includes(v.status)&&['manual','scheduled'].includes(v.trigger)&&nullableDate(v.scheduledFor)&&(v.trigger==='scheduled'?(v.scheduledFor!==null):v.scheduledFor===null)&&['queued','live'].includes(v.method)&&typeof v.isSubset==='boolean'&&integer(v.taskCount,0,2000)&&date(v.createdAt)&&nullableDate(v.startedAt)&&nullableDate(v.completedAt)&&typeof v.quoteExpired==='boolean'&&nullableDate(v.rawExpiredAt)&&nullableDate(v.dataExpiredAt)&&['not_started','pending','uncertain','final'].includes(v.costStatus)&&money(v.estimateUsd)&&money(v.knownChargeUsd)&&(v.diagnostic===null||text(v.diagnostic));}
function target(v:unknown):v is Target{return object(v)&&text(v.domain,253,1)&&integer(v.locationCode,1)&&text(v.languageCode,16,1)&&integer(v.depth,10,100)&&v.depth%10===0&&integer(v.maxCrawlPages,1,10);}
function dispatch(v:unknown):v is Dispatch{return object(v)&&uuid(v.id)&&integer(v.ordinal,0,1999)&&['reserved','dispatched','collecting','finished','uncertain','cancelled'].includes(v.phase)&&integer(v.taskCount,1,100)&&nullableDate(v.dispatchedAt)&&nullableDate(v.completedAt)&&(v.diagnostic===null||text(v.diagnostic))&&['reserved','dispatched','settled','uncertain','cancelled'].includes(v.costStatus)&&money(v.estimateUsd)&&(v.actualUsd===null||money(v.actualUsd))&&typeof v.canReconcile==='boolean';}
function task(v:unknown):v is Task{
  if(!object(v)||!uuid(v.id)||!uuid(v.keywordId)||!text(v.keyword,200,1)||typeof v.matchCase!=='boolean'||!['desktop','mobile'].includes(v.device)||!['pending','ranked','not_found','failed','uncertain','cancelled','unavailable'].includes(v.status))return false;
  if(!(v.position===null||integer(v.position,1))||!(v.rankBasis===null||['organic','absolute'].includes(v.rankBasis))||!(v.absolutePosition===null||integer(v.absolutePosition,1))||!(v.rankingUrl===null||text(v.rankingUrl,4096,1))||!(v.serpFeatures===null||Array.isArray(v.serpFeatures)&&v.serpFeatures.length<=100&&v.serpFeatures.every((s:unknown)=>text(s,80,1)))||!(v.checkedDepth===null||integer(v.checkedDepth))||!(v.returnedItemCount===null||integer(v.returnedItemCount))||!nullableDate(v.observedAt)||!nullableDate(v.retrievedAt)||!nullableDate(v.rawExpiredAt)||!nullableDate(v.dataExpiredAt)||(v.diagnostic!==null&&!text(v.diagnostic)))return false;
  if(v.dataExpiredAt!==null)return v.position===null&&v.rankBasis===null&&v.absolutePosition===null&&v.rankingUrl===null&&v.serpFeatures===null&&v.checkedDepth===null&&v.returnedItemCount===null;
  if(v.status==='ranked')return v.position!==null&&v.rankBasis!==null&&v.rankingUrl!==null&&v.observedAt!==null&&v.checkedDepth!==null;
  return v.position===null&&v.rankBasis===null&&v.absolutePosition===null&&v.rankingUrl===null;
}
function run(raw:unknown,trackerId:string,id?:string):raw is Run{
  if(!object(raw)||!summary(raw))return false;const v:Record<string,any>=raw;
  if(!uuid(v.trackerId)||v.trackerId!==trackerId||(id&&v.id!==id)||!target(v.target)||!text(v.connectionName,120,1)||!integer(v.dispatchCount,0,2000)||!(v.status==='skipped'?v.priceAsOf===null:date(v.priceAsOf))||!nullableDate(v.expiresAt)||typeof v.canStart!=='boolean'||typeof v.canCancel!=='boolean')return false;
  if(!Array.isArray(v.quotedTasks)||v.quotedTasks.length>2000||!v.quotedTasks.every((t:unknown)=>object(t)&&uuid(t.keywordId)&&text(t.keyword,200,1)&&['desktop','mobile'].includes(t.device)&&money(t.maximumUsd))||!Array.isArray(v.dispatches)||v.dispatches.length>2000||!v.dispatches.every(dispatch)||!distinct(v.dispatches)||!Array.isArray(v.tasks)||v.tasks.length>2000||!v.tasks.every(task)||!distinct(v.tasks))return false;
  if(v.status==='quoted')return v.expiresAt!==null&&v.quotedTasks.length===v.taskCount&&new Set(v.quotedTasks.map((t:{keywordId:string;device:string})=>t.keywordId.toLowerCase()+':'+t.device)).size===v.taskCount&&v.quotedTasks.reduce((sum:bigint,t:{maximumUsd:string})=>sum+BigInt(t.maximumUsd.replace('.','')),0n)===BigInt(v.estimateUsd.replace('.',''))&&v.dispatches.length===0&&v.tasks.length===0;
  return v.quotedTasks.length===0&&v.tasks.length===v.taskCount&&new Set(v.tasks.map((t:Task)=>t.keywordId.toLowerCase()+':'+t.device)).size===v.taskCount&&v.dispatches.length===v.dispatchCount&&v.dispatches.reduce((n:number,d:Dispatch)=>n+d.taskCount,0)===v.taskCount;
}
function envelope(v:unknown,trackerId:string,id?:string):v is {role:RankRole;run:Run;replayed?:boolean;reconciliation?:{status:'matched'|'inconclusive';message:string;replayed:boolean}}{return object(v)&&role(v.role)&&run(v.run,trackerId,id);}
const sameTarget=(a:Target,b:Target|undefined)=>!!b&&a.domain===b.domain&&a.locationCode===b.locationCode&&a.languageCode===b.languageCode&&a.depth===b.depth&&a.maxCrawlPages===b.maxCrawlPages;
const mismatch=()=>new Error('The server response could not be verified.');
const dateText=(v:string|null)=>v===null?'Unavailable':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
const targetText=(v:Target)=>`${v.domain} and subdomains · Location ${v.locationCode} · ${v.languageCode} · Up to ${v.depth} results · ${v.maxCrawlPages} maximum billable page(s)`;
const selectionText=(r:Pick<Summary,'isSubset'|'taskCount'|'trigger'|'scheduledFor'>)=>`${r.trigger==='scheduled'?`Scheduled for ${dateText(r.scheduledFor)}`:'Manual check'} · ${r.isSubset?'Selected keywords':'All captured keywords'} · ${r.taskCount} keyword/device checks`;
const isActive=(r:Run|null)=>r!==null&&['queued','running','waiting'].includes(r.status);

export function RankCheckPanel(props:Props){return <CheckController key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.tracker.id}`} {...props}/>;}
function CheckController(props:Props){
  const prefix=useId()+'-rank-check-',base=`/api/projects/${props.projectId}`,trackerPath=`${base}/rank-trackers/${props.tracker.id}`;
  const initial=():State=>({role:null,phase:props.entry.mode,tracker:props.tracker,history:[],nextCursor:null,loaded:false,run:null,connectionId:'',recoveryConnectionId:'',method:'queued',reading:false,writing:false,pending:false,conflict:false,dirty:false,error:'',notice:'',focus:false,now:Date.now()});
  const [s,setState]=useState(initial),state=useRef(s),op=useRef<Operation|null>(null),intent=useRef<Intent|null>(null),alive=useRef(true),pollCount=useRef(0);
  function patch(value:Partial<State>){if(alive.current){state.current={...state.current,...value};setState(state.current);}}
  function invalidate(){op.current?.controller.abort();op.current=null;}
  function locked(){return op.current?.write===true||intent.current!==null;}
  const [confirm,confirmDialog]=useConfirmDialog();
  function leave(){return !locked()&&(!state.current.dirty||window.confirm('Discard the unsaved rank check setup?'));}
  useBlocker({withResolver:false,shouldBlockFn:()=>!leave(),enableBeforeUnload:()=>locked()||state.current.dirty});
  useEffect(()=>{alive.current=true;if(props.entry.mode==='run'&&uuid(props.entry.runId))void readRun(props.entry.runId,true);else void loadHistory(undefined,true);return()=>{alive.current=false;invalidate();};},[]);
  useEffect(()=>{if(!s.focus)return;const suffix=s.phase==='setup'||s.run?.status==='quoted'&&s.phase==='run'?'quote-heading':'results-heading';const h=document.getElementById(prefix+suffix);if(h){h.focus();patch({focus:false});}},[s.focus,s.phase,s.run,s.loaded]);
  useEffect(()=>{
    if(s.phase!=='run'||!isActive(s.run)||s.pending||s.writing)return;
    const id=s.run!.id,timer=setInterval(()=>{if(document.visibilityState==='visible'&&!op.current&&!intent.current&&pollCount.current<24){pollCount.current++;void readRun(id,false);}if(pollCount.current>=24)clearInterval(timer);},5000);
    return()=>clearInterval(timer);
  },[s.phase,s.run?.id,s.run?.status,s.pending,s.writing]);
  useEffect(()=>{if(s.run?.status!=='quoted'||!s.run.expiresAt)return;const delay=Date.parse(s.run.expiresAt)-Date.now();if(delay<=0)return;const timer=setTimeout(()=>patch({now:Date.now()}),Math.min(delay+20,2147483647));return()=>clearTimeout(timer);},[s.run?.id,s.run?.expiresAt,s.run?.status]);
  function begin(write=false){if(!alive.current||op.current?.write||(!write&&intent.current))return null;invalidate();const next={controller:new AbortController(),write};op.current=next;patch({reading:!write,writing:write,error:'',notice:'',...(write?{pending:false}:{})});return next;}
  const current=(value:Operation)=>alive.current&&op.current===value;
  function finish(value:Operation){if(current(value)){op.current=null;patch({reading:false,writing:false});}}
  function purge(error:string,unauthorized=false){invalidate();intent.current=null;state.current={...initial(),error};setState(state.current);if(unauthorized)props.onUnauthorized();}
  function fail(error:unknown,value:Operation){if(!current(value))return;if(error instanceof ApiError&&[401,403,404].includes(error.status)){purge(errMsg(error),error.status===401);return;}if(error instanceof Error&&error.name==='AbortError')return;patch({error:errMsg(error)});}
  function acceptRole(next:RankRole){patch({role:next,...(!writer(next)?{connectionId:'',recoveryConnectionId:'',dirty:false}:{})});}
  function acceptRun(data:{role:RankRole;run:Run},focus=false){
    // Expiry is irreversible. A later financial recovery must not reveal old payloads.
    const old=state.current.run?.id===data.run.id?state.current.run:null;
    const oldTasks=new Map(old?.tasks.map(t=>[t.id,t])??[]);
    const next={...data.run,rawExpiredAt:data.run.rawExpiredAt??old?.rawExpiredAt??null,dataExpiredAt:data.run.dataExpiredAt??old?.dataExpiredAt??null,tasks:data.run.tasks.map(t=>({...t,rawExpiredAt:t.rawExpiredAt??oldTasks.get(t.id)?.rawExpiredAt??null,dataExpiredAt:t.dataExpiredAt??oldTasks.get(t.id)?.dataExpiredAt??null}))};
    if(next.status==='quoted'){
      const known=[old?.expiresAt,props.entry.runId===next.id?props.entry.knownExpiresAt:undefined].filter((v):v is string=>typeof v==='string'&&date(v));
      for(const deadline of known)if(next.expiresAt&&Date.parse(deadline)<Date.parse(next.expiresAt))next.expiresAt=deadline;
      next.quoteExpired=next.quoteExpired||old?.quoteExpired===true||!next.expiresAt||Date.parse(next.expiresAt)<=Date.now();
    }
    acceptRole(data.role);patch({phase:'run',run:next,conflict:false,dirty:false,now:Date.now(),...(focus?{focus:true}:{})});
  }
  async function loadHistory(cursor?:string,keepPhase=false){
    const value=begin();if(!value)return;if(!keepPhase)patch({phase:'history',run:null});if(!cursor)patch({loaded:false,history:[],nextCursor:null});
    try{const data=await api<unknown>(trackerPath+'/runs'+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:value.controller.signal});if(!current(value))return;
      if(!object(data)||!role(data.role)||data.trackerId!==props.tracker.id||!Array.isArray(data.runs)||data.runs.length>50||!data.runs.every(summary)||!distinct(data.runs)||(data.nextCursor!==null&&!text(data.nextCursor,1024,1)))throw mismatch();
      acceptRole(data.role);const rows=cursor?[...state.current.history,...data.runs]:data.runs;patch({history:[...new Map(rows.map((r:Summary)=>[r.id,r])).values()],nextCursor:data.nextCursor,loaded:true,conflict:false});
    }catch(e){fail(e,value);}finally{finish(value);}
  }
  async function readRun(id:string,focus=false){const value=begin();if(!value)return;patch({phase:'run',...(state.current.run?.id!==id?{run:null}:{})});try{const data=await api<unknown>(`${base}/rank-checks/${id}`,{signal:value.controller.signal});if(!current(value))return;if(!envelope(data,props.tracker.id,id))throw mismatch();acceptRun(data,focus);}catch(e){fail(e,value);}finally{finish(value);}}
  async function refreshSetup(){
    const value=begin();if(!value)return;
    try{const data=await api<unknown>(trackerPath,{signal:value.controller.signal});if(!current(value))return;
      if(!object(data)||!role(data.role)||!object(data.tracker)||data.tracker.id!==props.tracker.id||!target({domain:data.tracker.domain,locationCode:data.tracker.locationCode,languageCode:data.tracker.languageCode,depth:data.tracker.depth,maxCrawlPages:data.tracker.maxCrawlPages})||!integer(data.tracker.revision,1,2147483646)||!integer(data.tracker.keywordsRevision,1,2147483646)||!integer(data.tracker.keywordCount,0,1000)||!['desktop','mobile','both'].includes(data.tracker.devices)||!nullableDate(data.tracker.archivedAt))throw mismatch();
      acceptRole(data.role);patch({tracker:{...state.current.tracker,...data.tracker},conflict:false,dirty:false});
    }catch(e){fail(e,value);}finally{finish(value);}
  }
  function refresh(){if(!leave())return;patch({dirty:false});if(state.current.phase==='run'&&state.current.run)void readRun(state.current.run.id);else if(state.current.phase==='setup')void refreshSetup();else void loadHistory();}
  function back(){if(!leave())return;invalidate();patch({dirty:false});props.onBack();}
  function prepare(){if(!writer(state.current.role)||!leave()||state.current.tracker.archivedAt!==null)return;invalidate();patch({phase:'setup',run:null,reading:false,conflict:false,dirty:false,focus:true,error:'',notice:''});void refreshSetup();}
  function history(){if(!leave())return;patch({dirty:false,focus:true});void loadHistory();}
  function open(id:string){if(!leave())return;patch({dirty:false});pollCount.current=0;void readRun(id,true);}
  async function send(saved:Intent){
    if(op.current?.write||!alive.current)return;intent.current=saved;const value=begin(true);if(!value)return;
    try{const data=await api<unknown>(saved.path,{method:'POST',body:saved.body,signal:value.controller.signal});if(!current(value))return;if(!envelope(data,props.tracker.id,saved.runId))throw mismatch();
      if(['quote','start'].includes(saved.kind)&&typeof data.replayed!=='boolean')throw mismatch();
      if(saved.kind==='quote'){
        const rows=data.run.status==='quoted'?data.run.quotedTasks:data.run.tasks,pairs=rows.map(t=>t.keywordId.toLowerCase()+':'+t.device);
        if(data.run.method!==saved.method||!sameTarget(data.run.target,saved.target)||data.run.isSubset!==saved.subset||data.run.taskCount!==saved.taskCount||rows.some(t=>!saved.devices?.includes(t.device))||saved.pairs&&saved.pairs.some(pair=>!pairs.includes(pair)))throw mismatch();
      }
      if(saved.kind==='reconcile'&&(!data.reconciliation||!['matched','inconclusive'].includes(data.reconciliation.status)||!text(data.reconciliation.message)||typeof data.reconciliation.replayed!=='boolean'))throw mismatch();
      intent.current=null;pollCount.current=0;acceptRun(data,true);patch({pending:false,notice:saved.kind==='reconcile'?data.reconciliation!.message:saved.kind==='cancel'?'Undispatched work was cancelled. Sent work and charges remain.':saved.kind==='quote'?(props.entry.purpose==='schedule'?'Review the captured inputs and maximum charge before configuring the schedule.':'Review the captured inputs and maximum charge before starting.'):'The rank check was accepted. Dispatched work may incur provider charges.'});
    }catch(e){if(!current(value))return;if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){intent.current=null;patch({pending:false,conflict:e.status===409});fail(e,value);}else patch({pending:true,error:e instanceof ApiError&&e.status===429?'The retry was rate limited. Wait before retrying the same request; its original outcome is still unknown.':''});}
    finally{finish(value);}
  }
  function mutate(kind:Intent['kind'],path:string,body:Record<string,unknown>,extra:Partial<Intent>={}){if(locked()||!writer(state.current.role)||state.current.conflict)return;try{void send({kind,path,body:structuredClone({...body,requestId:crypto.randomUUID()}),...extra});}catch{patch({error:'This browser could not prepare a safe request. Reload access before trying again.'});}}
  function quote(){const at=state.current;if(locked()||!writer(at.role)||props.entry.purpose==='schedule'&&at.role!=='owner'||at.tracker.archivedAt!==null||!props.vaultConfigured||!props.connections.some(c=>c.id===at.connectionId))return;
    const t=at.tracker,target:Target={domain:t.domain,locationCode:t.locationCode,languageCode:t.languageCode,depth:t.depth,maxCrawlPages:t.maxCrawlPages};
    const devices=t.devices==='both'?['desktop','mobile']:[t.devices],method=props.entry.purpose==='schedule'?'queued':at.method,keywordIds=props.entry.purpose==='schedule'?undefined:props.entry.keywordIds;
    mutate('quote',trackerPath+'/quote',{connectionId:at.connectionId,revision:t.revision,keywordsRevision:t.keywordsRevision,method,...(keywordIds?{keywordIds:[...keywordIds]}:{})},{target,method,subset:!!keywordIds,devices,taskCount:(keywordIds?.length??t.keywordCount)*devices.length,...(keywordIds?{pairs:keywordIds.flatMap(id=>devices.map(device=>id.toLowerCase()+':'+device))}:{})});
  }
  function start(){const r=state.current.run;if(props.entry.purpose==='schedule'||!r||locked()||!r.canStart||r.status!=='quoted'||r.quoteExpired||!r.expiresAt||Date.parse(r.expiresAt)<=Date.now())return;mutate('start',`${base}/rank-checks/${r.id}/start`,{},{runId:r.id});}
  function scheduleEligible(){const at=state.current,r=at.run;return at.role==='owner'&&!at.conflict&&r?.status==='quoted'&&r.trigger==='manual'&&r.method==='queued'&&!r.isSubset&&r.startedAt===null&&r.canStart&&!r.quoteExpired&&!!r.expiresAt&&Date.parse(r.expiresAt)>Date.now();}
  function configureSchedule(){if(!scheduleEligible()||!leave())return;const r=state.current.run!;invalidate();patch({dirty:false,reading:false});props.onConfigureSchedule(r.id,r.expiresAt!);}
  async function cancel(){const r=state.current.run;if(!r||locked()||!r.canCancel||!await confirm({title:'Cancel only work that has not been sent?',description:'Dispatched work and charges remain.',confirmLabel:'Cancel remaining checks'})||locked()||state.current.run?.id!==r.id||!state.current.run.canCancel)return;mutate('cancel',`${base}/rank-checks/${r.id}/cancel`,{},{runId:r.id});}
  function recover(id:string){const at=state.current,r=at.run;if(locked()||at.role!=='owner'||!r?.dispatches.some(d=>d.id===id&&d.canReconcile)||!props.connections.some(c=>c.id===at.recoveryConnectionId))return;mutate('reconcile',`${base}/rank-checks/${r.id}/reconcile`,{dispatchId:id,connectionId:at.recoveryConnectionId},{runId:r.id});}
  function providers(){if(state.current.role==='owner'&&leave()){invalidate();patch({dirty:false});props.onOpenProviders();}}
  const currentRun=s.run,selection=props.entry.purpose!=='schedule'&&props.entry.keywordIds?`${props.entry.keywordIds.length} selected keywords`:`All ${s.tracker.keywordCount} current keywords`;
  const q:RankQuoteDisplay|null=currentRun?.status==='quoted'?{connectionName:currentRun.connectionName,methodLabel:currentRun.method==='queued'?'Queued':'Live',targetLabel:targetText(currentRun.target),selectionLabel:selectionText(currentRun),taskCount:currentRun.taskCount,dispatchCount:currentRun.dispatchCount,estimateUsd:currentRun.estimateUsd,priceAsOf:dateText(currentRun.priceAsOf),expiresAt:dateText(currentRun.expiresAt),expired:currentRun.quoteExpired||!currentRun.expiresAt||Date.parse(currentRun.expiresAt)<=s.now,canStart:currentRun.canStart,tasks:currentRun.quotedTasks.map(t=>({id:t.keywordId+':'+t.device,keyword:t.keyword,device:t.device,maximumUsd:t.maximumUsd}))}:null;
  const result:RankResultDisplay|null=currentRun?{status:currentRun.status,target:targetText(currentRun.target),method:currentRun.method,selection:selectionText(currentRun),estimateUsd:currentRun.estimateUsd,knownChargeUsd:currentRun.knownChargeUsd,costStatus:currentRun.costStatus,createdAt:dateText(currentRun.createdAt),startedAt:dateText(currentRun.startedAt),completedAt:dateText(currentRun.completedAt),diagnostic:currentRun.diagnostic,expired:currentRun.dataExpiredAt!==null,rawExpired:currentRun.rawExpiredAt!==null,canCancel:currentRun.canCancel,
    tasks:currentRun.tasks.map(t=>{const expired=currentRun.dataExpiredAt!==null||t.dataExpiredAt!==null;return {id:t.id,keyword:t.keyword,device:t.device,outcome:expired?'Expired':t.status==='not_found'?'Not found in observed coverage':t.status,position:expired?'Expired':t.status==='ranked'?`${t.rankBasis==='absolute'?'Absolute position':'Organic rank'} ${t.position}`:'Unavailable',coverage:expired?'Expired':t.checkedDepth===null?'Not observed':`${t.checkedDepth} organic results observed; ${t.returnedItemCount??'unknown'} returned items`,observedAt:dateText(t.observedAt),rankingUrl:expired?null:t.rankingUrl};}),
    dispatches:currentRun.dispatches.map(d=>({id:d.id,label:`Request ${d.ordinal+1}`,status:`${d.phase} · ${d.costStatus}`,estimateUsd:d.estimateUsd,actualUsd:d.actualUsd,canRecover:d.canReconcile,diagnostic:d.diagnostic}))}:null;
  const historyRows:RankHistoryDisplay[]=s.history.map(r=>({id:r.id,createdAt:dateText(r.createdAt),method:r.method,selection:selectionText(r),status:r.status+(r.quoteExpired?' · Quote expired':''),cost:r.status==='skipped'?`No quote applied · Known charges $${r.knownChargeUsd}`:`${r.costStatus} · Known $${r.knownChargeUsd} · Maximum $${r.estimateUsd}`,availability:r.dataExpiredAt?'Observations expired':r.rawExpiredAt?'Raw evidence expired':'Retained receipt'}));
  const common={prefix,backLabel:props.backLabel??'Back to tracker',role:s.role,locked:s.writing||intent.current!==null,reading:s.reading,pending:s.pending&&!s.writing,error:s.error,notice:s.notice,onRefresh:refresh,onBack:back,onRetry:()=>{if(intent.current&&!op.current?.write)void send(intent.current);},onOpenProviders:providers};
  if(s.phase==='setup'||s.phase==='run'&&currentRun?.status==='quoted')return <><RankCheckView {...common} schedulePurpose={props.entry.purpose==='schedule'} canConfigureSchedule={scheduleEligible()} onConfigureSchedule={configureSchedule} phase={s.phase==='setup'?'setup':'review'} conflict={s.conflict} selectionLabel={selection} canQuote={writer(s.role)&&(props.entry.purpose!=='schedule'||s.role==='owner')&&props.vaultConfigured&&s.tracker.archivedAt===null&&s.tracker.keywordCount>0} connections={props.vaultConfigured?props.connections:[]} connectionId={s.connectionId} method={s.method} quote={q}
    onConnection={connectionId=>{if(!locked()){invalidate();patch({connectionId,reading:false,dirty:true});}}} onMethod={method=>{if(!locked()&&props.entry.purpose!=='schedule'){invalidate();patch({method,reading:false,dirty:true});}}} onQuote={quote} onStart={start}/>{confirmDialog}</>;
  return <><RankCheckResults {...common} phase={s.phase==='history'?'history':'run'} loaded={s.loaded} history={historyRows} nextCursor={s.nextCursor} run={result} canPrepare={writer(s.role)&&s.tracker.archivedAt===null&&s.tracker.keywordCount>0} connections={props.connections} recoveryConnectionId={s.recoveryConnectionId}
    onPrepare={prepare} onOpen={open} onMore={()=>{if(s.nextCursor&&!s.reading)void loadHistory(s.nextCursor);}} onHistory={history} onCancel={cancel} onRecoveryConnection={recoveryConnectionId=>{if(!locked())patch({recoveryConnectionId});}} onRecover={recover}/>{confirmDialog}</>;
}
