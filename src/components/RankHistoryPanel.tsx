import {useEffect,useId,useRef,useState} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import type {RankRole,RankTracker} from './RankTrackingView';
import type {RankHistoryTarget,RankHistoryObservation,RankLatestRow,RankBaseline} from '../server/rank-history';
import {RankHistoryView,type RankObservationFilters,type RankLatestDisplay,type RankObservationDisplay} from './RankHistoryView';

type Props={workspaceId:string;projectId:string;userId:string;tracker:RankTracker;active?:boolean;onUnauthorized:()=>void;onBack:()=>void;onOpenRun:(id:string)=>void};
type Keyword={id:string;keyword:string;matchCase:boolean;removed:boolean};
type Latest={role:RankRole;trackerId:string;target:RankHistoryTarget;enabledDevices:'desktop'|'mobile'|'both';asOf:string;rows:RankLatestRow[];nextCursor:string|null};
type History={role:RankRole;trackerId:string;keyword:Keyword;target:RankHistoryTarget;enabledDevices:'desktop'|'mobile'|'both';observations:RankHistoryObservation[];nextCursor:string|null};
type State={role:RankRole|null;phase:'latest'|'keyword';reading:boolean;loaded:boolean;error:string;target:RankHistoryTarget|null;enabledDevices:string;asOf:string;firstRead:string;draft:RankObservationFilters;applied:RankObservationFilters;latestFilters:RankObservationFilters;rows:RankLatestRow[];observations:RankHistoryObservation[];keyword:Keyword|null;keywordId:string|null;nextCursor:string|null;focus:boolean};
type Expiry={rawExpiredAt:string|null;dataExpiredAt:string|null};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const integer=(v:unknown,min=0,max=2147483647)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const role=(v:unknown):v is RankRole=>['owner','admin','editor','viewer'].includes(v as string);
const cursor=(v:unknown)=>v===null||text(v,512,1);
const target=(v:unknown):v is RankHistoryTarget=>object(v)&&text(v.domain,253,1)&&integer(v.locationCode,1)&&text(v.languageCode,16,1)&&integer(v.depth,10,100)&&v.depth%10===0&&integer(v.maxCrawlPages,1,10);
const status=['pending','ranked','not_found','failed','uncertain','cancelled','unavailable'];
function observation(v:unknown):v is RankHistoryObservation{
 if(!object(v)||!uuid(v.taskId)||!uuid(v.runId)||!['desktop','mobile'].includes(v.device)||!status.includes(v.status)||!['quoted','queued','running','waiting','completed','partial','failed','cancelled','skipped'].includes(v.runStatus)||typeof v.isSubset!=='boolean'||typeof v.compatible!=='boolean'||!target(v.target)||!date(v.attemptedAt)||!nullableDate(v.observedAt)||!nullableDate(v.retrievedAt)||!nullableDate(v.rawExpiredAt)||!nullableDate(v.dataExpiredAt)||(v.diagnostic!==null&&!text(v.diagnostic)))return false;
 if(!(v.position===null||integer(v.position,1))||!(v.rankBasis===null||['organic','absolute'].includes(v.rankBasis))||!(v.absolutePosition===null||integer(v.absolutePosition,1))||!(v.rankingUrl===null||text(v.rankingUrl,4096,1))||!(v.serpFeatures===null||Array.isArray(v.serpFeatures)&&v.serpFeatures.length<=100&&v.serpFeatures.every((s:unknown)=>text(s,80,1)))||!(v.checkedDepth===null||integer(v.checkedDepth))||!(v.returnedItemCount===null||integer(v.returnedItemCount)))return false;
 if(v.dataExpiredAt!==null)return v.position===null&&v.rankBasis===null&&v.absolutePosition===null&&v.rankingUrl===null&&v.serpFeatures===null&&v.checkedDepth===null&&v.returnedItemCount===null;
 return v.status==='ranked'?v.position!==null&&v.rankBasis!==null&&v.rankingUrl!==null&&v.observedAt!==null&&v.checkedDepth!==null:v.position===null&&v.rankBasis===null&&v.absolutePosition===null&&v.rankingUrl===null;
}
function latestRow(v:unknown):v is RankLatestRow{
 if(!object(v)||!uuid(v.keywordId)||!text(v.keyword,200,1)||typeof v.matchCase!=='boolean'||!nullableDate(v.pinnedAt)||!['desktop','mobile'].includes(v.device)||!(v.latestAttempt===null||observation(v.latestAttempt)&&v.latestAttempt.device===v.device)||!(v.latestObservation===null||observation(v.latestObservation)&&v.latestObservation.device===v.device)||!['available','expired','not_checked','unavailable','incompatible'].includes(v.observationStatus)||!Array.isArray(v.baselines)||v.baselines.length!==4)return false;
 const latest=v.latestObservation;
 if(latest!==null&&(!['ranked','not_found'].includes(latest.status)||!latest.compatible||latest.dataExpiredAt!==null||latest.observedAt===null)||v.observationStatus==='available'!==(latest!==null))return false;
 return v.baselines.every((b:unknown,i:number)=>{
  if(!object(b)||b.days!==[1,7,30,90][i]||!date(b.targetAt)||!['at_or_before','earliest_available','unavailable'].includes(b.source)||!(b.observation===null||observation(b.observation)&&b.observation.device===v.device)||!(b.change===null||integer(b.change,-2147483647)))return false;
  const old=b.observation;if(b.source==='unavailable')return old===null&&b.change===null;
  if(old===null||!['ranked','not_found'].includes(old.status)||!old.compatible||old.dataExpiredAt!==null||old.observedAt===null)return false;
  const change=latest?.status==='ranked'&&old.status==='ranked'&&latest.rankBasis===old.rankBasis&&latest.taskId!==old.taskId?old.position-latest.position:null;
  return b.change===change;
 });
}
const unique=(values:string[])=>new Set(values.map(v=>v.toLowerCase())).size===values.length;
const sameFilters=(a:RankObservationFilters,b:RankObservationFilters)=>a.device===b.device&&a.search===b.search&&a.pinned===b.pinned;
const defaults=():RankObservationFilters=>({device:'both',search:'',pinned:'all'});
const initial=():State=>({role:null,phase:'latest',reading:false,loaded:false,error:'',target:null,enabledDevices:'',asOf:'',firstRead:'',draft:defaults(),applied:defaults(),latestFilters:defaults(),rows:[],observations:[],keyword:null,keywordId:null,nextCursor:null,focus:false});
const bad=()=>new Error('The server response could not be verified. Refresh these observations.');
const dateText=(v:string|null)=>v===null?'Unavailable':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
const capturedTarget=(v:RankHistoryTarget)=>`${v.domain} and subdomains · Location ${v.locationCode} · ${v.languageCode} · Up to ${v.depth} results · ${v.maxCrawlPages} maximum billable page(s)`;
const position=(v:RankHistoryObservation|null)=>!v?'Unavailable':v.dataExpiredAt?'Expired':v.status==='ranked'?`${v.rankBasis==='absolute'?'Absolute position':'Organic rank'} ${v.position}`:v.status==='not_found'?'Not found in observed coverage':'Unavailable';
const coverage=(v:RankHistoryObservation|null)=>!v?'Not observed':v.dataExpiredAt?'Expired':v.checkedDepth===null?'Not observed':`${v.checkedDepth} organic results observed; ${v.returnedItemCount??'unknown'} returned items`;
const availability=(v:RankHistoryObservation)=>v.dataExpiredAt?'Observations expired':v.rawExpiredAt?'Raw evidence expired':['ranked','not_found'].includes(v.status)?'Retained observation':'Retained attempt; no rank observation';

export function RankHistoryPanel(props:Props){return <HistoryController key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.tracker.id}`} {...props}/>;}
function HistoryController(props:Props){
 const prefix=useId()+'-rank-history-',base=`/api/projects/${props.projectId}/rank-trackers/${props.tracker.id}`;
 const [s,setState]=useState(initial),state=useRef(s),active=useRef<AbortController|null>(null),alive=useRef(true),visible=useRef(true),expiry=useRef(new Map<string,Expiry>());visible.current=props.active!==false;
 function patch(update:Partial<State>){if(alive.current){state.current={...state.current,...update};setState(state.current);}}
 function invalidate(){active.current?.abort();active.current=null;}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;invalidate();expiry.current.clear();};},[]);
 useEffect(()=>{if(props.active===false){invalidate();patch({reading:false});return;}patch({role:null,focus:true});refresh();},[props.active]);
 useEffect(()=>{if(!s.focus||props.active===false)return;const h=document.getElementById(prefix+'history-heading');if(h){h.focus();patch({focus:false});}},[s.focus,s.phase,s.loaded,s.role,props.active]);
 const current=(controller:AbortController)=>alive.current&&visible.current&&active.current===controller;
 function begin(){invalidate();const c=new AbortController();active.current=c;patch({reading:true,error:''});return c;}
 function fail(e:unknown,c:AbortController){if(!current(c))return;if(e instanceof ApiError&&[401,403,404].includes(e.status)){invalidate();expiry.current.clear();state.current={...initial(),error:errMsg(e)};setState(state.current);if(e.status===401)props.onUnauthorized();return;}if(e instanceof Error&&e.name==='AbortError')return;patch({error:errMsg(e)});}
 function finish(c:AbortController){if(current(c)){active.current=null;patch({reading:false});}}
 function absorb(rows:RankHistoryObservation[]){for(const row of rows){const old=expiry.current.get(row.taskId);if(row.rawExpiredAt||row.dataExpiredAt||old)expiry.current.set(row.taskId,{rawExpiredAt:row.rawExpiredAt??old?.rawExpiredAt??null,dataExpiredAt:row.dataExpiredAt??old?.dataExpiredAt??null});}}
 function masked(row:RankHistoryObservation|null):RankHistoryObservation|null{if(!row)return null;const marker=expiry.current.get(row.taskId);if(!marker)return row;return {...row,...marker,...(marker.dataExpiredAt?{position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,serpFeatures:null,checkedDepth:null,returnedItemCount:null}:{})};}
 function maskLatest(row:RankLatestRow):RankLatestRow{return {...row,latestAttempt:masked(row.latestAttempt),latestObservation:masked(row.latestObservation),baselines:row.baselines.map(b=>({...b,observation:masked(b.observation)}))};}
 async function latest(filters:RankObservationFilters,page?:string,focus=false){
  const c=begin();patch({phase:'latest',draft:{...filters},applied:{...filters},latestFilters:{...filters},keyword:null,keywordId:null,...(!page?{loaded:false,rows:[],observations:[],nextCursor:null,asOf:'',firstRead:''}:{})});
  const query=new URLSearchParams({device:filters.device,search:filters.search,...(filters.pinned==='all'?{}:{pinned:filters.pinned}),...(page?{cursor:page}:{})});
  try{const data=await api<unknown>(base+'/results?'+query,{signal:c.signal});if(!current(c))return;
   if(!object(data)||!role(data.role)||data.trackerId!==props.tracker.id||!target(data.target)||!['desktop','mobile','both'].includes(data.enabledDevices)||!date(data.asOf)||!cursor(data.nextCursor)||!Array.isArray(data.rows)||data.rows.length>100||!data.rows.every(latestRow)||!unique(data.rows.map((r:RankLatestRow)=>r.keywordId+':'+r.device)))throw bad();
   const value=data as Latest;
   absorb(value.rows.flatMap(r=>[r.latestAttempt,r.latestObservation,...r.baselines.map(b=>b.observation)].filter((o):o is RankHistoryObservation=>o!==null)));
   const rows=page?[...state.current.rows,...value.rows]:value.rows;
   patch({role:value.role,target:value.target,enabledDevices:value.enabledDevices,asOf:value.asOf,firstRead:page?state.current.firstRead:value.asOf,rows:[...new Map(rows.map(r=>[r.keywordId+':'+r.device,maskLatest(r)])).values()],nextCursor:value.nextCursor,loaded:true,...(focus?{focus:true}:{})});
  }catch(e){fail(e,c);}finally{finish(c);}
 }
 async function history(id:string,filters:RankObservationFilters,page?:string,focus=false){
  const c=begin();patch({phase:'keyword',draft:{...filters},applied:{...filters},keywordId:id,...(state.current.keyword?.id!==id?{keyword:null}:{}),...(!page?{loaded:false,observations:[],nextCursor:null}:{})});
  try{const data=await api<unknown>(`${base}/keywords/${id}/history?`+new URLSearchParams({device:filters.device,...(page?{cursor:page}:{})}),{signal:c.signal});if(!current(c))return;
   if(!object(data)||!role(data.role)||data.trackerId!==props.tracker.id||!target(data.target)||!['desktop','mobile','both'].includes(data.enabledDevices)||!object(data.keyword)||data.keyword.id!==id||!uuid(data.keyword.id)||!text(data.keyword.keyword,200,1)||typeof data.keyword.matchCase!=='boolean'||typeof data.keyword.removed!=='boolean'||!cursor(data.nextCursor)||!Array.isArray(data.observations)||data.observations.length>50||!data.observations.every(observation)||!unique(data.observations.map((o:RankHistoryObservation)=>o.taskId)))throw bad();
   const value=data as History;absorb(value.observations);const rows=page?[...state.current.observations,...value.observations]:value.observations;
   patch({role:value.role,target:value.target,enabledDevices:value.enabledDevices,keyword:value.keyword,observations:[...new Map(rows.map(r=>[r.taskId,masked(r)!])).values()],nextCursor:value.nextCursor,loaded:true,...(focus?{focus:true}:{})});
  }catch(e){fail(e,c);}finally{finish(c);}
 }
 function refresh(){const at=state.current;if(at.phase==='keyword'&&at.keywordId)void history(at.keywordId,at.applied);else void latest(at.applied);}
 function apply(){const at=state.current;if(at.phase==='keyword'&&at.keywordId)void history(at.keywordId,at.draft);else void latest(at.draft);}
 function more(){const at=state.current;if(at.reading||!at.nextCursor||!sameFilters(at.draft,at.applied))return;if(at.phase==='keyword'&&at.keywordId)void history(at.keywordId,at.applied,at.nextCursor);else void latest(at.applied,at.nextCursor);}
 function openKeyword(id:string){if(!state.current.rows.some(r=>r.keywordId===id))return;void history(id,{...defaults(),device:state.current.applied.device},undefined,true);}
 function openRun(id:string){if(!state.current.observations.some(o=>o.runId===id))return;invalidate();patch({reading:false});props.onOpenRun(id);}
 function baseline(b:RankBaseline,latest:RankHistoryObservation|null){const o=masked(b.observation),valid=latest?.status==='ranked'&&!latest.dataExpiredAt&&o?.status==='ranked'&&!o.dataExpiredAt&&latest.rankBasis===o.rankBasis&&latest.taskId!==o.taskId;return {days:b.days,change:valid&&b.change!==null?(b.change>0?`Improved ${b.change}`:b.change<0?`Dropped ${Math.abs(b.change)}`:'No rank change'):'Change unavailable',source:b.source==='at_or_before'?'At or before target':b.source==='earliest_available'?'Earliest available fallback':'No baseline available',targetAt:dateText(b.targetAt),observedAt:dateText(o?.observedAt??null),position:position(o)};}
 const rows:RankLatestDisplay[]=s.rows.map(row=>{const r=maskLatest(row),attempt=r.latestAttempt,observed=r.latestObservation;return {id:r.keywordId+':'+r.device,keywordId:r.keywordId,keyword:r.keyword,device:r.device,pinned:r.pinnedAt!==null,attempt:attempt?`${attempt.status} · ${dateText(attempt.attemptedAt)}${!attempt.compatible?' · Different captured settings':''}${attempt.dataExpiredAt?' · Expired':''}`:'Not checked',observation:position(observed),coverage:coverage(observed),observedAt:dateText(observed?.observedAt??null),availability:observed?availability(observed):r.observationStatus==='not_checked'?'Not checked':r.observationStatus==='incompatible'?'No compatible observation':r.observationStatus==='expired'?'Observations expired':'No available observation',baselines:r.baselines.map(b=>baseline(b,observed))};});
 const observations:RankObservationDisplay[]=s.observations.map(original=>{const o=masked(original)!;return {id:o.taskId,runId:o.runId,device:o.device,attemptedAt:dateText(o.attemptedAt),observedAt:dateText(o.observedAt),retrievedAt:dateText(o.retrievedAt),outcome:o.status,position:position(o),coverage:coverage(o),target:capturedTarget(o.target),compatibility:o.compatible?'Current target/settings':'Different captured settings',scope:o.isSubset?'Selected keyword check':'Full captured keyword check',availability:availability(o),rankingUrl:o.rankingUrl,diagnostic:o.diagnostic};});
 const filters=s.applied,appliedFilters=s.phase==='latest'?`Applied: ${filters.device} devices · ${filters.search?`Contains “${filters.search}”`:'All keywords'} · ${filters.pinned==='all'?'All pin states':filters.pinned==='true'?'Pinned only':'Unpinned only'}`:`Applied: ${filters.device} devices`;
 const targetText=s.target?capturedTarget(s.target):'Target unavailable',asOf=s.asOf?(s.firstRead===s.asOf?dateText(s.asOf):`${dateText(s.firstRead)} to ${dateText(s.asOf)} (paged reads)`):'Unavailable';
 return <RankHistoryView prefix={prefix} role={s.role} phase={s.phase} reading={s.reading} loaded={s.loaded} error={s.error} target={targetText} enabledDevices={s.enabledDevices||props.tracker.devices} asOf={asOf} filters={s.draft} filterDirty={!sameFilters(s.draft,s.applied)} appliedFilters={appliedFilters} latest={rows} keyword={s.keyword?.keyword??''} removed={s.keyword?.removed??false} observations={observations} nextCursor={s.nextCursor}
  onFilters={draft=>{invalidate();patch({draft,reading:false});}} onApply={apply} onRefresh={refresh} onMore={more} onBack={()=>{invalidate();props.onBack();}} onLatest={()=>void latest(state.current.latestFilters,undefined,true)} onKeyword={openKeyword} onRun={openRun}/>;
}
