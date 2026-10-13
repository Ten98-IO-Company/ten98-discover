import {useEffect,useId,useRef,useState} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import type {MetaLatestReport} from '../server/meta-latest';
import {MetaLatestView,type MetaLatestViewProps} from './MetaLatestView';

type Props={userId:string;workspaceId:string;projectId:string;connectionId:string;referenceImportId:string;report:'account_daily'|'campaign_daily';initialFrom:string;initialTo:string;onUnauthorized:()=>void;onBack:()=>void;onOpenImport:(id:string)=>void};
type Dates={from:string;to:string};
type Role=MetaLatestReport['role'];
type Operation={controller:AbortController;signal:AbortSignal;exporting:boolean};
type State={role:Role|null;loaded:boolean;reading:boolean;exporting:boolean;error:string;exportError:string;notice:string;draft:Dates;applied:Dates;data:MetaLatestReport|null;pages:(string|null)[];focus:boolean};
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,39}$(?![\s\S])/.test(v);
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&!v.startsWith('0000')&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const validRange=(v:Dates)=>day(v.from)&&day(v.to)&&v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=30*86400000;
const role=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=25000;
const number=(v:unknown,decimal=false)=>v===null||typeof v==='string'&&(decimal?/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$(?![\s\S])/:/^(?:0|[1-9][0-9]{0,29})$(?![\s\S])/).test(v);
const windows=['1d_click','7d_click','28d_click','1d_view','7d_view','28d_view'];
function actions(v:unknown):boolean{return v===null||Array.isArray(v)&&v.length<=200&&v.every(a=>obj(a)&&text(a.type,200,1)&&number(a.value,true)&&obj(a.windows)&&Object.keys(a.windows).every(k=>windows.includes(k)&&number(a.windows[k],true)))&&new Set(v.map(a=>a.type)).size===v.length;}
function source(v:unknown,report:Props['report']):boolean{return obj(v)&&v.provider==='meta_ads'&&id(v.accountId)&&text(v.accountName,512,1)&&typeof v.currency==='string'&&/^[A-Z]{3}$/.test(v.currency)&&text(v.timeZone,120,1)&&v.graphVersion==='v26.0'&&v.report===report&&v.definitionVersion===1&&v.level===(report==='account_daily'?'account':'campaign')&&Array.isArray(v.breakdowns)&&v.breakdowns.length===0&&obj(v.attribution)&&v.attribution.mode==='meta_reported'&&v.attribution.reportingPolicy==='meta_mixed'&&v.attribution.effectiveAdSetSettings==='unknown'&&Array.isArray(v.attribution.requestedWindows)&&v.attribution.requestedWindows.join('|')==='7d_click|1d_view';}
function valid(v:unknown,p:Props,f:Dates):v is MetaLatestReport{
 if(!obj(v)||!role(v.role)||v.connectionId!==p.connectionId||v.referenceImportId!==p.referenceImportId||!source(v.source,p.report)||v.from!==f.from||v.to!==f.to||!time(v.asOf)||typeof v.selectionRevision!=='string'||!/^[a-f0-9]{64}$(?![\s\S])/.test(v.selectionRevision)||!count(v.totalRows)||!(v.nextCursor===null||text(v.nextCursor,1024,1))||!Array.isArray(v.coverage)||v.coverage.length!==(Date.parse(f.to)-Date.parse(f.from))/86400000+1||!Array.isArray(v.rows)||v.rows.length>50)return false;
 for(let i=0;i<v.coverage.length;i++){
  const d=v.coverage[i],expected=new Date(Date.parse(f.from+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
  if(!obj(d)||d.date!==expected||!['rows','empty','missing','expired','deleted','incompatible'].includes(d.state))return false;
  if(['missing','incompatible'].includes(d.state)){if(d.importId!==null||d.requestedAt!==null||d.completedAt!==null||d.rowCount!==null)return false;}
  else if(!uuid(d.importId)||!time(d.requestedAt)||!time(d.completedAt)||(['expired','deleted'].includes(d.state)?d.rowCount!==null:!count(d.rowCount)||d.state==='rows'&&d.rowCount<1||d.state==='empty'&&d.rowCount!==0))return false;
 }
 if(v.coverage.reduce((n:number,d:any)=>n+(d.rowCount??0),0)!==v.totalRows||v.rows.length>v.totalRows||v.rows.length===0&&v.nextCursor!==null)return false;
 let previous='';
 for(const entry of v.rows){if(!obj(entry)||!uuid(entry.importId)||!time(entry.requestedAt)||!time(entry.completedAt)||!obj(entry.row))return false;const r=entry.row,d=v.coverage.find((d:any)=>d.date===r.date);
  if(!d||d.state!=='rows'||d.importId!==entry.importId||d.requestedAt!==entry.requestedAt||d.completedAt!==entry.completedAt||r.accountId!==v.source.accountId||!number(r.impressions)||!number(r.clicks)||!number(r.spend,true)||!actions(r.actions)||!actions(r.actionValues))return false;
  if(p.report==='account_daily'?(r.campaignId!==null||r.campaignName!==null):!id(r.campaignId)||!(r.campaignName===null||text(r.campaignName,512)))return false;
  const key=r.date+':'+(r.campaignId??'');if(key<=previous)return false;previous=key;
 }
 return true;
}
const same=(a:Dates,b:Dates)=>a.from===b.from&&a.to===b.to;
const labels={rows:'Rows available',empty:'Completed with no rows',missing:'No complete import',expired:'Expired',deleted:'Deleted',incompatible:'Different report definition'};
const help={rows:'Values come from this completed import.',empty:'This completed import replaces earlier rows. No activity or zero is inferred.',missing:'No compatible completed import covers this date.',expired:'The newest complete data expired. Earlier values are not restored.',deleted:'The newest complete data was deleted. Earlier values are not restored.',incompatible:'Saved imports use a different account, currency, time zone or attribution profile.'};
export function MetaLatestPanel(props:Props){return <Controller key={`${props.userId}:${props.workspaceId}:${props.projectId}:${props.connectionId}:${props.referenceImportId}:${props.report}`} {...props}/>;}
function Controller(props:Props){
 const prefix=useId()+'-meta-latest-',base=`/api/projects/${props.projectId}/meta/connections/${props.connectionId}/latest`,initial:Dates={from:props.initialFrom,to:props.initialTo};
 const [s,setState]=useState<State>({role:null,loaded:false,reading:false,exporting:false,error:'',exportError:'',notice:'',draft:initial,applied:initial,data:null,pages:[null],focus:false}),state=useRef(s),alive=useRef(true),operation=useRef<Operation|null>(null),tombstones=useRef(new Set<string>()),blob=useRef<string|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 function patch(value:Partial<State>){if(alive.current){state.current={...state.current,...value};setState(state.current);}}
 function revoke(){if(timer.current!==null)clearTimeout(timer.current);timer.current=null;if(blob.current)URL.revokeObjectURL(blob.current);blob.current=null;}
 function invalidate(){operation.current?.controller.abort();operation.current=null;revoke();}
 function begin(exporting=false){invalidate();const controller=new AbortController(),op={controller,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]),exporting};operation.current=op;patch({reading:!exporting,exporting,error:'',exportError:'',notice:''});return op;}
 const current=(op:Operation)=>alive.current&&operation.current===op;
 function finish(op:Operation){if(current(op)){operation.current=null;patch({reading:false,exporting:false});}}
 function fail(error:unknown,op:Operation){if(!current(op))return;const status=error instanceof ApiError?error.status:0;
  if([401,403,404,409].includes(status)){invalidate();patch({role:null,data:null,pages:[null],loaded:true,reading:false,exporting:false,error:status===409?'Coverage or its reference changed. Reload coverage; if the reference was deleted, go back and choose another retained import.':errMsg(error),exportError:''});if(status===401)props.onUnauthorized();return;}
  patch({loaded:true,...(op.exporting?{exportError:error instanceof Error&&error.name==='AbortError'?'Export timed out. Try again.':errMsg(error)}:{error:error instanceof Error&&error.name==='AbortError'?'Coverage read timed out. Reload to try again.':errMsg(error)})});
 }
 useEffect(()=>{alive.current=true;void load(initial);return()=>{alive.current=false;invalidate();};},[]);
 useEffect(()=>{if(s.focus){document.getElementById(prefix+'heading')?.focus();patch({focus:false});}},[s.focus]);
 async function load(filters:Dates,pages:(string|null)[]=[null]){
  if(!validRange(filters)){patch({error:'Choose a valid range of at most 31 account-local calendar days.'});return;}
  const old=state.current.data,op=begin();patch({role:null,data:null,pages,applied:{...filters},focus:true});
  try{const query=new URLSearchParams({referenceImportId:props.referenceImportId,report:props.report,...filters});if(pages.at(-1))query.set('cursor',pages.at(-1)!);
   const data=await api<unknown>(base+'?'+query,{signal:op.signal});if(!current(op))return;if(!valid(data,props,filters)||pages.length===1&&data.totalRows>0&&data.rows.length===0)throw new Error('The saved coverage response could not be verified. Reload coverage.');
   if(pages.length>1&&old&&data.selectionRevision!==old.selectionRevision||data.coverage.some(d=>d.importId&&tombstones.current.has(d.importId)&&['rows','empty'].includes(d.state))){const e=new ApiError('Coverage changed. Reload coverage.');e.status=409;throw e;}
   for(const d of data.coverage)if(d.importId&&['deleted','expired'].includes(d.state))tombstones.current.add(d.importId);
   patch({role:data.role,loaded:true,data,pages});
  }catch(error){fail(error,op);}finally{finish(op);}
 }
 function leave(callback:()=>void){invalidate();patch({role:null,data:null,reading:false,exporting:false});callback();}
 async function download(){const at=state.current;if(!at.role||!at.data||at.reading||at.exporting||!same(at.draft,at.applied))return;const data=at.data,op=begin(true),filename=`meta-latest-${props.report}.csv`;
  try{const response=await fetch(base+'/export',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({referenceImportId:props.referenceImportId,report:props.report,...at.applied,expectedSelectionRevision:data.selectionRevision}),signal:op.signal});if(!current(op)){await response.body?.cancel();return;}
   if(!response.ok){await response.body?.cancel();const e=new ApiError(response.status===413?'The export is too large. Narrow the dates.':`Export failed (${response.status}). Reload access or try again.`);e.status=response.status;throw e;}
   const count=response.headers.get('x-export-row-count'),length=response.headers.get('content-length');
   if(response.headers.get('content-type')?.toLowerCase()!=='text/csv; charset=utf-8'||response.headers.get('content-disposition')!==`attachment; filename="${filename}"`||count===null||!/^(?:0|[1-9]\d{0,4})$/.test(count)||Number(count)!==data.totalRows||length!==null&&(!/^\d{1,8}$/.test(length)||Number(length)>16*1024*1024)||!response.body){await response.body?.cancel();throw new Error('The export response could not be verified.');}
   const reader=response.body.getReader(),bytes=new Uint8Array(16*1024*1024);let written=0;
   try{while(true){const part=await reader.read();if(!current(op))return;if(part.done)break;if(part.value.byteLength>bytes.length-written)throw new Error('The export exceeds 16 MiB. Narrow the dates.');bytes.set(part.value,written);written+=part.value.byteLength;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   if(!current(op))return;if(!written)throw new Error('The export response was empty.');new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,written));
   const url=URL.createObjectURL(new Blob([bytes.subarray(0,written)],{type:'text/csv;charset=utf-8'}));blob.current=url;const a=document.createElement('a');a.href=url;a.download=filename;a.click();timer.current=setTimeout(revoke,1000);patch({notice:`Exported ${count} retained rows with daily coverage and receipt metadata.`});
  }catch(error){fail(error,op);}finally{finish(op);}
 }
 const d=s.data,busy=s.reading||s.exporting,formatActions=(values:MetaLatestReport['rows'][number]['row']['actions'])=>values?.flatMap(a=>[{label:a.type,value:a.value??'Unavailable'},...Object.entries(a.windows).map(([window,value])=>({label:`${a.type} · ${window.replace('_',' ')}`,value:value??'Unavailable'}))])??null;
 const view:MetaLatestViewProps={prefix,role:s.role,loaded:s.loaded,reading:s.reading,exporting:s.exporting,error:s.error,exportError:s.exportError,notice:s.notice,profile:d?{accountLabel:`${d.source.accountName} · Account ${d.source.accountId}`,reportLabel:props.report==='account_daily'?'Daily account report':'Daily campaign report',currency:d.source.currency,timeZone:d.source.timeZone,attributionLabel:'Meta reported · requested 7-day click and 1-day view · mixed reporting · effective ad-set settings unknown'}:null,from:s.draft.from,to:s.draft.to,
  result:d?{rangeLabel:`${d.from} to ${d.to} (account-local dates)`,asOfLabel:`Snapshot: ${d.asOf}`,countLabel:`${d.totalRows} retained rows`,selectionRevision:d.selectionRevision,coverage:d.coverage.map(v=>({date:v.date,state:v.state,stateLabel:labels[v.state],countsLabel:v.rowCount===null?'Unavailable':String(v.rowCount),help:help[v.state],receiptId:v.importId}))}:null,
  rows:d?d.rows.map(v=>({key:v.row.date+':'+(v.row.campaignId??''),date:v.row.date,campaignLabel:v.row.campaignId?`${v.row.campaignName??'Name unavailable'} · ${v.row.campaignId}`:'Account total',impressions:v.row.impressions??'Unavailable',clicks:v.row.clicks??'Unavailable',spend:v.row.spend??'Unavailable',actions:formatActions(v.row.actions),actionValues:formatActions(v.row.actionValues)})):[],
  canApply:!!s.role&&validRange(s.draft),canExport:!!s.role&&!!d&&same(s.draft,s.applied),canPreviousRows:s.pages.length>1&&same(s.draft,s.applied),canNextRows:!!d?.nextCursor&&same(s.draft,s.applied),
  onFrom:from=>{if(!busy)patch({draft:{...s.draft,from}});},onTo:to=>{if(!busy)patch({draft:{...s.draft,to}});},onApply:()=>{if(!busy&&s.role)void load(s.draft);},onReload:()=>{if(!busy)void load(s.applied);},onBack:()=>leave(props.onBack),
  onPreviousRows:()=>{if(!busy&&same(s.draft,s.applied)&&s.pages.length>1)void load(s.applied,s.pages.slice(0,-1));},onNextRows:()=>{if(!busy&&same(s.draft,s.applied)&&d?.nextCursor)void load(s.applied,[...s.pages,d.nextCursor]);},onOpenImport:id=>{if(!busy&&s.role&&d?.coverage.some(v=>v.importId===id))leave(()=>props.onOpenImport(id));},onExport:()=>void download(),onCancelExport:()=>{if(s.exporting){invalidate();patch({exporting:false,notice:'Export cancelled.'});}}};
 return <MetaLatestView {...view}/>;
}
