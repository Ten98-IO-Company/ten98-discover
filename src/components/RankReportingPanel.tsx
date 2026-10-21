import {useEffect,useId,useRef,useState} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import type {RankTracker,RankRole} from './RankTrackingView';
import type {RankHistoryTarget,RankRunSummary} from '../server/rank-history';
import type {RankDistribution,RankDistributionCounts} from '../server/rank-distribution';
import type {RankMatrix,RankMatrixCell} from '../server/rank-matrix';
import {RankReportingView,type RankReportingViewProps} from './RankReportingView';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime';

type Props={workspaceId:string;projectId:string;userId:string;tracker:RankTracker;active?:boolean;onUnauthorized:()=>void;onBack:()=>void;onOpenRun:(id:string)=>void;onOpenKeyword:(id:string)=>void;onCheckHistory:()=>void};
type Device='desktop'|'mobile';
type MatrixFilters={device:Device;search:string;pinned:'all'|'true'|'false';runLimit:number};
type DistributionFilters={device:Device|'both';runId:string};
type Expiry={raw:string|null;data:string|null};
type State={mode:'distribution'|'matrix';role:RankRole|null;reading:boolean;exporting:boolean;error:string;notice:string;focus:boolean;
 distribution:RankDistribution|null;matrix:RankMatrix|null;distributionDraft:DistributionFilters;distributionApplied:DistributionFilters;
 matrixDraft:MatrixFilters;matrixApplied:MatrixFilters;matrixPages:(string|null)[];matrixPage:number;
 runs:RankRunSummary[];runsPages:(string|null)[];runsPage:number;runsNext:string|null;masked:boolean};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!v.includes('\0')&&!/[\uD800-\uDFFF]/u.test(v);
const integer=(v:unknown,min=0,max=2147483647)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
// Preserve server microseconds when comparing snapshots; Date truncates them.
const stamp=(v:string)=>v.replace(/(?:\.(\d{1,6}))?Z$/,(_,part:string|undefined)=>'.'+(part??'').padEnd(6,'0')+'Z');
const cursor=(v:unknown)=>v===null||text(v,512,1);
const role=(v:unknown):v is RankRole=>workspaceRoles.includes(v as WorkspaceRole);
const unique=(v:string[])=>new Set(v.map(x=>x.toLowerCase())).size===v.length;
const target=(v:unknown):v is RankHistoryTarget=>object(v)&&text(v.domain,253,1)&&integer(v.locationCode,1)&&text(v.languageCode,16,1)&&integer(v.depth,10,100)&&v.depth%10===0&&integer(v.maxCrawlPages,1,10);
const deviceList=(v:unknown):v is Device[]=>Array.isArray(v)&&v.length<=2&&v.every(d=>d==='desktop'||d==='mobile')&&unique(v);
const source=(v:unknown)=>object(v)&&v.provider==='dataforseo'&&v.engine==='google'&&v.report==='organic_search';
const states=['pending','ranked','not_found','failed','uncertain','cancelled','unavailable'];
const runStates=['quoted','queued','running','waiting','completed','partial','failed','cancelled','skipped'];
const categories:readonly (keyof RankDistributionCounts)[]=['organic1To3','organic4To10','organic11To20','organic21To100','organicAbove100','absoluteRanked','notFoundThrough100','limitedCoverage','neverChecked','expired','pending','unavailable','incompatible'];
const labels:Record<keyof RankDistributionCounts,string>={organic1To3:'Organic ranks 1–3',organic4To10:'Organic ranks 4–10',organic11To20:'Organic ranks 11–20',organic21To100:'Organic ranks 21–100',organicAbove100:'Organic ranks above 100',absoluteRanked:'Absolute positions',notFoundThrough100:'Not found through 100 observed results',limitedCoverage:'Not found in limited coverage',neverChecked:'Never checked',expired:'Expired',pending:'Pending',unavailable:'Unavailable',incompatible:'Different setup'};
function totals(v:any):boolean{
 if(!object(v)||!integer(v.denominator,0,2000)||!object(v.counts)||!categories.every(k=>integer(v.counts[k],0,2000))||categories.reduce((n,k)=>n+v.counts[k],0)!==v.denominator)return false;
 const comparable=categories.slice(0,5).reduce((n,k)=>n+v.counts[k],0)+v.counts.notFoundThrough100,observed=comparable+v.counts.absoluteRanked+v.counts.limitedCoverage;
 return ([['observedCoverage',observed],['top100Comparable',comparable]] as const).every(([key,n])=>object(v[key])&&v[key].count===n&&v[key].complete===(v.denominator>0&&n===v.denominator));
}
function validDistribution(v:unknown,trackerId:string,f:DistributionFilters):v is RankDistribution&{role:RankRole}{
 if(!object(v)||!role(v.role)||v.trackerId!==trackerId||!source(v.source)||!target(v.target)||!date(v.asOf)||!deviceList(v.enabledDevices)||!deviceList(v.selectedDevices)||v.selectedDevices.some(d=>!v.enabledDevices.includes(d))||!integer(v.keywordCount,0,1000)||!totals(v.totals)||!Array.isArray(v.byDevice)||v.byDevice.length!==v.selectedDevices.length||!v.byDevice.every((d:any,i:number)=>object(d)&&d.device===v.selectedDevices[i]&&totals(d)))return false;
 if((f.device==='both'?v.selectedDevices.join()!==v.enabledDevices.join():v.selectedDevices.join()!==f.device)||v.byDevice.reduce((n:number,d:any)=>n+d.denominator,0)!==v.totals.denominator||!categories.every(k=>v.byDevice.reduce((n:number,d:any)=>n+d.counts[k],0)===v.totals.counts[k]))return false;
 if(!object(v.observationDates)||!['earliestObservedAt','latestObservedAt','earliestRetrievedAt','latestRetrievedAt'].every(k=>nullableDate(v.observationDates[k])))return false;
 if(f.runId){const r=v.run;if(v.mode!=='run'||!object(r)||r.id!==f.runId||!runStates.includes(r.status)||typeof r.isSubset!=='boolean'||!date(r.createdAt)||!nullableDate(r.startedAt)||!nullableDate(r.completedAt)||!nullableDate(r.dataExpiredAt))return false;}
 else if(v.mode!=='latest'||v.run!==null||v.totals.denominator!==v.keywordCount*v.selectedDevices.length)return false;
 return true;
}
function validCell(v:unknown,runId:string):v is RankMatrixCell{
 if(!object(v)||v.runId!==runId||!(v.taskId===null||uuid(v.taskId))||![...states,'not_in_run','expired','incompatible'].includes(v.state)||!(v.resultStatus===null||states.includes(v.resultStatus))||!['observedAt','retrievedAt','rawExpiredAt','dataExpiredAt'].every(k=>nullableDate(v[k])))return false;
 if(!['position','absolutePosition'].every(k=>v[k]===null||integer(v[k],1))||!(v.rankBasis===null||['organic','absolute'].includes(v.rankBasis))||!(v.rankingUrl===null||text(v.rankingUrl,4096,1))||!['checkedDepth','returnedItemCount'].every(k=>v[k]===null||integer(v[k]))||!(v.change===null||integer(v.change,-2147483647)))return false;
 if(v.state==='ranked')return v.position!==null&&v.rankBasis!==null&&v.rankingUrl!==null&&v.observedAt!==null&&v.retrievedAt!==null&&v.checkedDepth!==null&&v.returnedItemCount!==null&&v.dataExpiredAt===null;
 return v.position===null&&v.rankBasis===null&&v.absolutePosition===null&&v.rankingUrl===null&&v.change===null&&(v.state==='not_found'||v.checkedDepth===null&&v.returnedItemCount===null);
}
function validMatrix(v:unknown,trackerId:string,f:MatrixFilters):v is RankMatrix&{role:RankRole}{
 if(!object(v)||!role(v.role)||v.trackerId!==trackerId||!source(v.source)||!target(v.target)||!date(v.asOf)||!deviceList(v.enabledDevices)||!v.enabledDevices.includes(f.device)||!object(v.filters)||v.filters.device!==f.device||v.filters.search!==f.search||(v.filters.pinned??'all')!==f.pinned||v.filters.runLimit!==Number(f.runLimit)||!integer(v.keywordCount,0,1000)||!cursor(v.nextCursor)||!Array.isArray(v.columns)||v.columns.length>Number(f.runLimit)||!Array.isArray(v.rows)||v.rows.length>50)return false;
 if(!v.columns.every((c:any)=>object(c)&&uuid(c.runId)&&runStates.includes(c.status)&&!['quoted','skipped'].includes(c.status)&&['manual','scheduled'].includes(c.trigger)&&['live','queued'].includes(c.method)&&date(c.startedAt)&&nullableDate(c.completedAt)&&nullableDate(c.scheduledFor)&&target(c.target)&&typeof c.compatible==='boolean'&&nullableDate(c.rawExpiredAt)&&nullableDate(c.dataExpiredAt))||!unique(v.columns.map((c:any)=>c.runId)))return false;
 if(!v.rows.every((r:any)=>object(r)&&uuid(r.keywordId)&&text(r.keyword,200,1)&&typeof r.matchCase==='boolean'&&nullableDate(r.pinnedAt)&&Array.isArray(r.cells)&&r.cells.length===v.columns.length&&r.cells.every((c:any,i:number)=>validCell(c,v.columns[i].runId)))||!unique(v.rows.map((r:any)=>r.keywordId)))return false;
 return v.rows.every((r:any)=>r.cells.every((c:any,i:number)=>{const p=r.cells[i+1],expected=c.state==='ranked'&&p?.state==='ranked'&&c.rankBasis===p.rankBasis&&stamp(c.observedAt)>stamp(p.observedAt)?p.position-c.position:null;return c.change===expected;}));
}
function validRuns(v:unknown,id:string):v is {role:RankRole;trackerId:string;runs:RankRunSummary[];nextCursor:string|null}{
 return object(v)&&role(v.role)&&v.trackerId===id&&cursor(v.nextCursor)&&Array.isArray(v.runs)&&v.runs.length<=50&&v.runs.every((r:any)=>object(r)&&uuid(r.id)&&runStates.includes(r.status)&&['manual','scheduled'].includes(r.trigger)&&['live','queued'].includes(r.method)&&typeof r.isSubset==='boolean'&&integer(r.taskCount,0,2000)&&date(r.createdAt)&&['startedAt','completedAt','scheduledFor','rawExpiredAt','dataExpiredAt'].every(k=>nullableDate(r[k])))&&unique(v.runs.map((r:any)=>r.id));
}
const defaults=(t:RankTracker):State=>{const matrix:MatrixFilters={device:t.devices==='mobile'?'mobile':'desktop',search:'',pinned:'all',runLimit:12},distribution:DistributionFilters={device:'both',runId:''};return {mode:'distribution',role:null,reading:false,exporting:false,error:'',notice:'',focus:true,distribution:null,matrix:null,distributionDraft:distribution,distributionApplied:distribution,matrixDraft:matrix,matrixApplied:matrix,matrixPages:[null],matrixPage:0,runs:[],runsPages:[null],runsPage:0,runsNext:null,masked:false};};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const bad=()=>new Error('The report response could not be verified. Refresh the report.');
const formatted=(value:string|null)=>value===null?'Not recorded':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const scopeText=(t:RankHistoryTarget)=>`${t.domain} and subdomains · Location ${t.locationCode} · ${t.languageCode} · Up to ${t.depth} results · ${t.maxCrawlPages} maximum billable page(s)`;

export function RankReportingPanel(props:Props){return <ReportingController key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.tracker.id}`} {...props}/>;}
function ReportingController(props:Props){
 const prefix=useId()+'-rank-report-',base=`/api/projects/${props.projectId}/rank-trackers/${props.tracker.id}`;
 const [s,setState]=useState(()=>defaults(props.tracker)),state=useRef(s),active=useRef<AbortController|null>(null),alive=useRef(true),visible=useRef(true);
 const runsExpired=useRef(new Map<string,Expiry>()),tasksExpired=useRef(new Map<string,Expiry>()),expiryFloor=useRef(''),blob=useRef<string|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);visible.current=props.active!==false;
 function patch(value:Partial<State>){if(alive.current){state.current={...state.current,...value};setState(state.current);}}
 function revoke(){if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}if(blob.current!==null){URL.revokeObjectURL(blob.current);blob.current=null;}}
 function invalidate(){active.current?.abort();active.current=null;revoke();}
 const current=(c:AbortController)=>alive.current&&visible.current&&active.current===c;
 function begin(exporting=false){invalidate();const c=new AbortController();active.current=c;patch({reading:!exporting,exporting,error:'',notice:''});return c;}
 function finish(c:AbortController){if(current(c)){active.current=null;patch({reading:false,exporting:false});}}
 function fail(error:unknown,c:AbortController){if(!current(c))return;if(error instanceof ApiError&&[401,403,404].includes(error.status)){invalidate();state.current={...defaults(props.tracker),error:errMsg(error),focus:true};setState(state.current);if(error.status===401)props.onUnauthorized();return;}if(error instanceof Error&&error.name==='AbortError')return;patch({error:errMsg(error)});}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;invalidate();runsExpired.current.clear();tasksExpired.current.clear();};},[]);
 useEffect(()=>{invalidate();patch({role:null,distribution:null,matrix:null,runs:[],reading:false,exporting:false,focus:true});if(props.active!==false)void refresh();},[props.active]);
 useEffect(()=>{if(!s.focus||!s.role||s.reading||props.active===false)return;const heading=document.getElementById(prefix+'heading');if(heading){heading.focus();patch({focus:false});}},[s.focus,s.role,s.reading,props.active]);
 function remember(map:Map<string,Expiry>,id:string,raw:string|null,data:string|null,asOf?:string){if(!raw&&!data)return;const old=map.get(id);map.set(id,{raw:old?.raw??raw,data:old?.data??data});const times=[raw,data,asOf].filter((v):v is string=>v!==null&&v!==undefined);for(const at of times)if(stamp(at)>expiryFloor.current)expiryFloor.current=stamp(at);}
 function fresh(asOf:string){if(stamp(asOf)<expiryFloor.current)throw new Error('This report predates an observed expiry. Refresh for current data.');}
 function maskMatrix(value:RankMatrix){
  for(const c of value.columns)remember(runsExpired.current,c.runId,c.rawExpiredAt,c.dataExpiredAt,value.asOf);
  for(const r of value.rows)for(const c of r.cells)if(c.taskId)remember(tasksExpired.current,c.taskId,c.rawExpiredAt,c.dataExpiredAt,value.asOf);
  let changed=false;const columns=value.columns.map(c=>{const marker=runsExpired.current.get(c.runId);if(!marker)return c;if(marker.raw&&!c.rawExpiredAt||marker.data&&!c.dataExpiredAt)changed=true;return {...c,rawExpiredAt:marker.raw??c.rawExpiredAt,dataExpiredAt:marker.data??c.dataExpiredAt};});
  const rows=value.rows.map(r=>{const cells=r.cells.map((c,i)=>{if(c.state==='not_in_run')return c;const marker=c.taskId?tasksExpired.current.get(c.taskId):undefined,raw=marker?.raw??columns[i].rawExpiredAt??c.rawExpiredAt,data=marker?.data??columns[i].dataExpiredAt??c.dataExpiredAt;if(raw&&!c.rawExpiredAt||data&&!c.dataExpiredAt)changed=true;return {...c,rawExpiredAt:raw,dataExpiredAt:data,...(data?{state:'expired' as const,position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,checkedDepth:null,returnedItemCount:null,change:null}:{})};});
   for(let i=0;i<cells.length;i++)if(cells[i].state!=='ranked'||cells[i+1]?.state!=='ranked')cells[i].change=null;return {...r,cells};});return {value:{...value,columns,rows},changed};
 }
 function maskDistribution(value:RankDistribution){
  if(value.run?.dataExpiredAt)remember(runsExpired.current,value.run.id,null,value.run.dataExpiredAt,value.asOf);
  const marker=value.run&&runsExpired.current.get(value.run.id)?.data;if(!marker)return value;
  const expired=(v:RankDistribution['totals'])=>({...v,counts:Object.fromEntries(categories.map(k=>[k,k==='expired'?v.denominator:0])) as RankDistributionCounts,observedCoverage:{count:0,complete:false},top100Comparable:{count:0,complete:false}});
  return {...value,run:{...value.run!,dataExpiredAt:marker},totals:expired(value.totals),byDevice:value.byDevice.map(d=>({...expired(d),device:d.device})),observationDates:{earliestObservedAt:null,latestObservedAt:null,earliestRetrievedAt:null,latestRetrievedAt:null}};
 }
 async function choices(c:AbortController,page:number){
  const cursor=state.current.runsPages[page],data=await api<unknown>(base+'/runs'+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:c.signal});if(!current(c))return false;if(!validRuns(data,props.tracker.id))throw bad();
  for(const r of data.runs)remember(runsExpired.current,r.id,r.rawExpiredAt,r.dataExpiredAt);
  const shown=state.current.distribution,currentMatrix=state.current.matrix,invalidated=!!shown&&stamp(shown.asOf)<expiryFloor.current||!!currentMatrix&&stamp(currentMatrix.asOf)<expiryFloor.current;
  patch({role:data.role,runs:data.runs,runsPage:page,runsNext:data.nextCursor,...(invalidated?{distribution:null,matrix:null,notice:'A check expired after this report was read. Refresh the report.'}:shown?{distribution:maskDistribution(shown)}:{})});return true;
 }
 async function loadDistribution(filters:DistributionFilters,loadChoices=false){
  const c=begin();patch({mode:'distribution',distribution:null,matrix:null,distributionApplied:{...filters},distributionDraft:{...filters}});
  try{if(loadChoices&&!await choices(c,state.current.runsPage))return;const data=await api<unknown>(base+'/distribution?'+new URLSearchParams({device:filters.device,...(filters.runId?{runId:filters.runId}:{})}),{signal:c.signal});if(!current(c))return;if(!validDistribution(data,props.tracker.id,filters))throw bad();fresh(data.asOf);patch({role:data.role,distribution:maskDistribution(data),focus:true});}catch(error){fail(error,c);}finally{finish(c);}
 }
 async function loadMatrix(filters:MatrixFilters,page=0){
  if(!integer(filters.runLimit,1,26)||!text(filters.search,200)){patch({error:'Choose 1–26 recent checks and a valid keyword filter.'});return;}
  const c=begin(),cursor=state.current.matrixPages[page];patch({mode:'matrix',matrix:null,distribution:null,matrixApplied:{...filters},matrixDraft:{...filters},masked:false});
  try{const data=await api<unknown>(base+'/matrix?'+new URLSearchParams({device:filters.device,search:filters.search,runLimit:String(filters.runLimit),...(filters.pinned==='all'?{}:{pinned:filters.pinned}),...(cursor?{cursor}:{})}),{signal:c.signal});if(!current(c))return;if(!validMatrix(data,props.tracker.id,filters))throw bad();fresh(data.asOf);const masked=maskMatrix(data);patch({role:data.role,matrix:masked.value,masked:masked.changed,matrixPage:page,focus:true,...(masked.changed?{notice:'Previously observed expiry remains applied. Refresh before exporting.'}:{})});}catch(error){fail(error,c);}finally{finish(c);}
 }
 async function refresh(){const at=state.current;if(at.mode==='matrix')await loadMatrix(at.matrixApplied,at.matrixPage);else await loadDistribution(at.distributionApplied,true);}
 function edit(value:Partial<State>){invalidate();patch({...value,reading:false,exporting:false,error:'',notice:''});}
 function mode(mode:State['mode']){if(mode==='matrix'){patch({matrixPages:[null],matrixPage:0});void loadMatrix(state.current.matrixApplied);}else void loadDistribution(state.current.distributionApplied,true);}
 function pageRuns(direction:1|-1){const at=state.current;if(at.reading||at.exporting)return;const page=at.runsPage+direction;if(page<0||direction===1&&!at.runsNext)return;if(direction===1)patch({runsPages:[...at.runsPages.slice(0,page),at.runsNext]});const c=begin();void choices(c,page).catch(e=>fail(e,c)).finally(()=>finish(c));}
 function matrixPage(first=false){const at=state.current;if(at.reading||at.exporting||!same(at.matrixDraft,at.matrixApplied))return;const page=first?0:at.matrixPage+1;if(!first&&!at.matrix?.nextCursor)return;if(!first)patch({matrixPages:[...at.matrixPages.slice(0,page),at.matrix!.nextCursor]});void loadMatrix(at.matrixApplied,page);}
 function navigate(callback:()=>void){invalidate();patch({reading:false,exporting:false});callback();}
 function runDistribution(id:string){if(!state.current.matrix?.columns.some(c=>c.runId===id))return;void loadDistribution({device:'both',runId:id},true);}
 async function download(){
  const at=state.current;if(at.mode!=='matrix'||!at.role||!at.matrix||at.masked||at.reading||at.exporting||!same(at.matrixDraft,at.matrixApplied))return;
  const filters={...at.matrixApplied},c=begin(true);try{
   const response=await fetch(base+'/matrix/export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({device:filters.device,search:filters.search,runLimit:filters.runLimit,...(filters.pinned==='all'?{}:{pinned:filters.pinned})}),signal:c.signal});if(!current(c)){await response.body?.cancel();return;}
   if(!response.ok){await response.body?.cancel();const error=new ApiError(response.status===413?'The export is too large. Narrow the filters or recent checks.':`Export failed (${response.status}). Refresh access or try again.`);error.status=response.status;throw error;}
   const count=response.headers.get('x-export-row-count'),length=response.headers.get('content-length');if(response.headers.get('content-type')?.toLowerCase()!=='text/csv; charset=utf-8'||response.headers.get('content-disposition')!=='attachment; filename="rank-matrix.csv"'||count===null||!/^(?:0|[1-9]\d{0,4})$/.test(count)||Number(count)>26000||length!==null&&(!/^\d{1,8}$/.test(length)||Number(length)>16*1024*1024)||!response.body){await response.body?.cancel();throw new Error('The export response could not be verified.');}
   const reader=response.body.getReader(),bytes=new Uint8Array(16*1024*1024);let written=0;try{while(true){const part=await reader.read();if(!current(c))return;if(part.done)break;if(part.value.byteLength>bytes.length-written)throw new Error('The export exceeds 16 MiB. Narrow the filters.');bytes.set(part.value,written);written+=part.value.byteLength;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   if(!current(c))return;new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,written));if(!written)throw new Error('The export response was empty.');
   const url=URL.createObjectURL(new Blob([bytes.subarray(0,written)],{type:'text/csv;charset=utf-8'}));blob.current=url;const anchor=document.createElement('a');anchor.href=url;anchor.download='rank-matrix.csv';anchor.click();timer.current=setTimeout(revoke,1000);patch({notice:`Exported ${count} rows from a fresh server snapshot.`});
  }catch(error){fail(error,c);}finally{finish(c);}
 }
 const matrix=s.matrix,distribution=s.distribution,report=s.mode==='matrix'?matrix:distribution,enabled:Device[]=report?.enabledDevices??(props.tracker.devices==='both'?['desktop','mobile']:[props.tracker.devices]);
 const group=(id:string,title:string,v:RankDistribution['totals'])=>({id,title,denominator:String(v.denominator),observedCoverage:`Observed results: ${v.observedCoverage.count} of ${v.denominator}; ${v.observedCoverage.complete?'complete':'incomplete'}.`,top100Comparable:`Comparable to the top 100: ${v.top100Comparable.count} of ${v.denominator}; ${v.top100Comparable.complete?'complete':'incomplete'}.`,counts:categories.map(id=>({id,label:labels[id],value:String(v.counts[id])}))});
 const runLabel=distribution?.run?`${distribution.run.isSubset?'Selected keyword':'Full captured'} check · ${distribution.run.status} · ${formatted(distribution.run.startedAt??distribution.run.createdAt)}`:null;
 const choicesDisplay=s.runs.map(r=>({id:r.id,label:`${formatted(r.startedAt??r.createdAt)} · ${r.isSubset?'Subset':'Full'} · ${r.status} · ${r.method}`}));
 if(s.distributionDraft.runId&&!choicesDisplay.some(r=>r.id===s.distributionDraft.runId))choicesDisplay.unshift({id:s.distributionDraft.runId,label:distribution?.run?.id===s.distributionDraft.runId?runLabel!:'Selected captured check'});
 const selected=s.distributionApplied,m=s.matrixApplied,dates=distribution?.observationDates;
 const groups=distribution?[group('total',distribution.selectedDevices.length===1?(distribution.selectedDevices[0]==='desktop'?'Desktop':'Mobile'):'All selected devices',distribution.totals),...(distribution.byDevice.length>1?distribution.byDevice.map(d=>group(d.device,d.device==='desktop'?'Desktop':'Mobile',d)):[])]:[];
 const rows=matrix?.rows.map(row=>({id:row.keywordId,keyword:row.keyword,caseRule:row.matchCase?'Case sensitive':'Case insensitive',pinned:row.pinnedAt!==null,cells:row.cells.map(c=>({runId:c.runId,state:({not_in_run:'Not in this check',not_found:'Not found in observed coverage',incompatible:'Different setup',expired:'Expired',pending:'Pending',failed:'Failed',uncertain:'Uncertain',cancelled:'Cancelled',unavailable:'Unavailable',ranked:'Ranked'})[c.state],
  position:c.state==='ranked'?`${c.rankBasis==='organic'?'Organic rank':'Absolute position'} ${c.position}`:c.state==='not_found'?'Not found in observed coverage':c.state==='expired'?'Expired':'No rank observation',
  change:c.change===null?'Change unavailable':c.change>0?`Improved ${c.change}`:c.change<0?`Dropped ${-c.change}`:'No rank change',coverage:c.checkedDepth===null?'Coverage not recorded':`${c.checkedDepth} organic results observed; ${c.returnedItemCount??'unknown'} returned items`,observedAt:formatted(c.observedAt),retrievedAt:formatted(c.retrievedAt),availability:c.dataExpiredAt?'Derived observations expired':c.rawExpiredAt?'Raw evidence expired; derived observation retained':'No expiry recorded'}))}))??[];
 const view:RankReportingViewProps={prefix,role:s.role,mode:s.mode,loaded:report!==null,reading:s.reading,exporting:s.exporting,error:s.error,notice:s.notice,
  source:'DataForSEO · Google · Organic search',target:report?scopeText(report.target):'Target unavailable',asOf:report?`${formatted(report.asOf)} · ${report.asOf}`:'Not recorded',dates:dates?`Observed: ${formatted(dates.earliestObservedAt)} to ${formatted(dates.latestObservedAt)}. Retrieved: ${formatted(dates.earliestRetrievedAt)} to ${formatted(dates.latestRetrievedAt)}.`:'',enabledDevices:enabled,
  distributionDevice:s.distributionDraft.device,distributionDirty:!same(s.distributionDraft,selected),distributionApplied:`Applied: ${selected.runId?'Captured check':'Latest retained compatible observations'} · ${selected.device==='both'?'all applicable devices':selected.device}.`,runChoiceId:s.distributionDraft.runId||'latest',runChoices:choicesDisplay,loadingRuns:s.mode==='distribution'&&s.reading,runsError:'',canPreviousRuns:s.runsPage>0,canNextRuns:!!s.runsNext,runLabel,groups,
  matrixFilters:s.matrixDraft,matrixDirty:!same(s.matrixDraft,m),matrixApplied:`Applied: ${m.device} · ${m.search?`Contains “${m.search}”`:'All keywords'} · ${m.pinned==='all'?'All pin states':m.pinned==='true'?'Pinned':'Unpinned'} · ${m.runLimit} recent checks.`,population:matrix?`${matrix.keywordCount} matching current keywords; ${matrix.rows.length} on this page. Each page and export is a fresh snapshot.`:'',
  columns:matrix?.columns.map(c=>({id:c.runId,startedAt:formatted(c.startedAt),utc:c.startedAt,status:c.status,method:c.method,trigger:c.trigger,target:scopeText(c.target),compatibility:c.compatible?'Current setup':'Different setup'}))??[],rows,hasNext:!!matrix?.nextCursor,canFirst:s.matrixPage>0,canExport:!!matrix&&!!s.role&&!s.masked&&!s.reading,
  onMode:mode,onDistributionDevice:device=>edit({distributionDraft:{...state.current.distributionDraft,device}}),onRunChoice:id=>{if(id==='latest'||state.current.runs.some(r=>r.id===id)||state.current.distribution?.run?.id===id)edit({distributionDraft:{...state.current.distributionDraft,runId:id==='latest'?'':id}});},
  onApplyDistribution:()=>void loadDistribution(state.current.distributionDraft),onLatestDistribution:()=>void loadDistribution({device:'both',runId:''},true),onPreviousRuns:()=>pageRuns(-1),onNextRuns:()=>pageRuns(1),
  onMatrixFilters:matrixDraft=>edit({matrixDraft}),onApplyMatrix:()=>{patch({matrixPages:[null],matrixPage:0});void loadMatrix(state.current.matrixDraft);},onNext:()=>matrixPage(),onFirst:()=>matrixPage(true),onExport:()=>void download(),onCancelExport:()=>{invalidate();patch({exporting:false,notice:'Export cancelled.'});},onRunDistribution:runDistribution,
  onOpenRun:id=>{if(state.current.matrix?.columns.some(c=>c.runId===id))navigate(()=>props.onOpenRun(id));},onOpenKeyword:id=>{if(state.current.matrix?.rows.some(r=>r.keywordId===id))navigate(()=>props.onOpenKeyword(id));},onCheckHistory:()=>navigate(props.onCheckHistory),onRefresh:()=>void refresh(),onBack:()=>navigate(props.onBack)};
 return <RankReportingView {...view}/>;
}
