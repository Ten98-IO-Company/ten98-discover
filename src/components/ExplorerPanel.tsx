import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';

type Coverage='complete'|'partial'|'unavailable';

interface ExploreResult{
  range:{from:string;to:string;timeZone:string;start:string;end:string};
  query:{from:string;to:string;timeZone:string;kind:string;groupBy:string;groupProperty:string|null;filters:Record<string,string>;property:{key:string;type:string;value:unknown}|null};
  coverage:{status:Coverage;retainedFrom:string|null};
  totals:{events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
  daily:Array<{date:string;start:string;end:string;skipped:boolean;coverage:Coverage;events:number|null;pageViews:number|null;customEvents:number|null}>;
  breakdown:{groups:Array<{type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null}>;totalGroups:number;returnedGroupEvents:number;truncated:boolean};
  properties:{keys:string[];truncated:boolean};
  numeric:{samples:number;sum:string|null;average:string|null;min:string|null;max:string|null}|null;
  csv:string;
}

const KINDS=[['all','All events'],['pageviews','Page views'],['custom','Custom events']] as const;
const GROUPS=[['event','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content'],['screenWidth','Screen width'],['screenHeight','Screen height'],['property','Property']] as const;
const FILTERS=[['eventName','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content']] as const;
const PROP_TYPES=['missing','string','number','boolean','null','date','array'] as const;
const TIMEZONES=['UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/London','Europe/Berlin','Asia/Dubai','Asia/Tokyo','Australia/Sydney'];

const utcDate=(d:Date)=>d.toISOString().slice(0,10);
const labelOf=(list:readonly (readonly [string,string])[],v:string)=>list.find(([k])=>k===v)?.[1]??v;
const num=(v:number|null)=>v==null?'Unavailable':String(v);
const decimal=(v:string|null)=>v===null?'Unavailable':v.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

interface FilterRow{on:boolean;value:string}
interface Draft{
  from:string;to:string;timeZone:string;kind:string;groupBy:string;groupProperty:string;
  filters:Record<string,FilterRow>;
  prop:{on:boolean;key:string;type:string;value:string};
}

function initialDraft():Draft{
  const now=Date.now();
  const filters:Record<string,FilterRow>={};
  for(const [k] of FILTERS)filters[k]={on:false,value:''};
  return{from:utcDate(new Date(now-6*864e5)),to:utcDate(new Date(now)),timeZone:'UTC',kind:'all',groupBy:'event',groupProperty:'',filters,prop:{on:false,key:'',type:'missing',value:''}};
}

function buildParams(d:Draft):{qs:string}|{error:string}{
  const from=Date.parse(d.from),to=Date.parse(d.to);
  const days=(to-from)/864e5+1;
  if(!d.from||!d.to||Number.isNaN(from)||Number.isNaN(to)||to<from||days>366)
    return{error:'Enter a valid range of 1 to 366 days.'};
  if(!d.timeZone.trim())return{error:'Enter an IANA time zone, e.g. UTC or America/New_York.'};
  if(d.groupBy==='property'&&!d.groupProperty.length)return{error:'Enter a property key to group by.'};
  const p=new URLSearchParams();
  p.set('from',d.from);p.set('to',d.to);p.set('timeZone',d.timeZone.trim());
  p.set('kind',d.kind);p.set('groupBy',d.groupBy);
  if(d.groupBy==='property')p.set('groupProperty',d.groupProperty);
  for(const [k] of FILTERS){const f=d.filters[k];if(f.on)p.set(k,f.value);}
  if(d.prop.on){
    const key=d.prop.key;
    if(!key)return{error:'Enter a property key for the property filter, or turn it off.'};
    p.set('propertyKey',key);p.set('propertyType',d.prop.type);
    if(d.prop.type!=='missing'){
      const raw=d.prop.value.trim();
      if(!raw)return{error:'Enter the property value as a JSON literal, e.g. "starter", 42, true, null.'};
      try{JSON.parse(raw);}catch{return{error:'The property value is not valid JSON. Use a literal like "starter", 42, true, null or ["a",1].'};}
      p.set('propertyValue',raw);
    }
  }
  return{qs:p.toString()};
}

type Role='owner'|'admin'|'editor'|'viewer';
type Definition={schemaVersion:1;name:string;query:string};
type SavedFilter={id:string;projectId:string;revision:number;definition:Definition;createdAt:string;updatedAt:string};
type SaveAttempt={kind:'create'|'update'|'delete';id?:string;body:{requestId:string;revision?:number;definition?:Definition}};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const clean=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const roleValue=(value:unknown):value is Role=>['owner','admin','editor','viewer'].includes(value as string);
const canSave=(role:Role|null)=>role==='owner'||role==='admin'||role==='editor';
// Reuse Explorer's serializer; saved predicates deliberately have no report context.
function draftFilterQuery(draft:Draft){
  const built=buildParams({...draft,from:'2000-01-01',to:'2000-01-01',timeZone:'UTC',groupBy:'event',groupProperty:''});
  if('error'in built)return built;
  const query=new URLSearchParams(built.qs);for(const key of ['from','to','timeZone','groupBy','groupProperty'])query.delete(key);
  return {qs:query.toString()};
}
function savedPredicates(query:unknown):Pick<Draft,'kind'|'filters'|'prop'>|null{
  if(!clean(query,20000))return null;
  const p=new URLSearchParams(query),allowed=new Set<string>(['kind',...FILTERS.map(([key])=>key),'propertyKey','propertyType','propertyValue']);
  for(const [key,value] of p)if(!allowed.has(key)||p.getAll(key).length!==1||!clean(value,['path','origin'].includes(key)?2048:key==='propertyValue'?8192:320))return null;
  const kind=p.get('kind');if(!KINDS.some(([key])=>key===kind))return null;
  const filters=Object.fromEntries(FILTERS.map(([key])=>[key,{on:p.has(key),value:p.get(key)??''}]));
  let prop=initialDraft().prop;
  if(['propertyKey','propertyType','propertyValue'].some(key=>p.has(key))){
    const key=p.get('propertyKey'),type=p.get('propertyType'),value=p.get('propertyValue');
    if(!key||!PROP_TYPES.some(t=>t===type)||type==='missing'&&value!==null||type!=='missing'&&value===null)return null;
    if(type!=='missing'){
      let parsed:unknown;try{parsed=JSON.parse(value!);}catch{return null;}
      if(type==='null'?parsed!==null:type==='array'?!Array.isArray(parsed):type==='date'?typeof parsed!=='string'||!Number.isFinite(Date.parse(parsed)):typeof parsed!==type)return null;
    }
    prop={on:true,key,type:type!,value:value??''};
  }
  return {kind:kind!,filters,prop};
}
function validSaved(value:unknown,projectId:string):value is SavedFilter{
  if(!record(value)||!uuid(value.id)||value.projectId!==projectId||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||Number(value.revision)>2147483647||!record(value.definition))return false;
  const d=value.definition;return d.schemaVersion===1&&clean(d.name,200)&&d.name.trim().length>0&&savedPredicates(d.query)!==null&&['createdAt','updatedAt'].every(key=>typeof value[key]==='string'&&Number.isFinite(Date.parse(value[key] as string)));
}
function sameDefinition(expected:Definition,actual:Definition){
  const normalize=(query:string)=>{const value=savedPredicates(query);if(!value)return null;let literal:unknown=value.prop.type==='missing'?null: value.prop.on?JSON.parse(value.prop.value):null;
    if(value.prop.on&&value.prop.type==='date'){const text=literal as string,fraction=text.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1]??'000';literal=new Date(text).toISOString().slice(0,19)+'.'+fraction.padEnd(3,'0')+'Z';}
    return {...value,prop:{...value.prop,value:literal}};};
  return expected.name.trim()===actual.name&&JSON.stringify(normalize(expected.query))===JSON.stringify(normalize(actual.query));
}

function groupValue(type:string,value:unknown):string{
  if(type==='missing')return 'Missing / uncollected';
  if(value===null)return 'null';
  if(typeof value==='string'&&value==='')return '(empty string)';
  if(Array.isArray(value))return JSON.stringify(value);
  return String(value);
}
const groupType=(type:string)=>type?type.charAt(0).toUpperCase()+type.slice(1):'Unknown';

type Props={projectId:string;userId:string;onUnauthorized:()=>void};
export function ExplorerPanel(props:Props){
  return <ExplorerInner key={`${props.userId}:${props.projectId}`} {...props}/>;
}
function ExplorerInner({projectId,onUnauthorized}:Props){
  const uid=useId();
  const unauthRef=useRef(onUnauthorized);
  unauthRef.current=onUnauthorized;

  const [draft,setDraft]=useState<Draft>(initialDraft);
  const [applied,setApplied]=useState<string>(()=>{const r=buildParams(initialDraft());return 'qs'in r?r.qs:'';});
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<ExploreResult|null>(null);
  const [phase,setPhase]=useState<'loading'|'ok'|'error'|'unavailable'|'denied'>('loading');
  const [message,setMessage]=useState('');
  const [formError,setFormError]=useState('');
  const base=`/api/projects/${encodeURIComponent(projectId)}/segments`;
  const [savedItems,setSavedItems]=useState<SavedFilter[]>([]),[savedCursor,setSavedCursor]=useState<string|null>(null),[savedLoaded,setSavedLoaded]=useState(false);
  const [savedRole,setSavedRole]=useState<Role|null>(null),[selected,setSelected]=useState<SavedFilter|null>(null),[selectedId,setSelectedId]=useState(''),[savedName,setSavedName]=useState('');
  const [savedBusy,setSavedBusy]=useState(false),[savedError,setSavedError]=useState(''),[savedNotice,setSavedNotice]=useState(''),[pending,setPending]=useState<SaveAttempt|null>(null);
  const alive=useRef(false),accessEpoch=useRef(0),accessDenied=useRef(false),analyticsRead=useRef<AbortController|null>(null);
  const savedOp=useRef<AbortController|null>(null),savedRoleRef=useRef<Role|null>(null),pendingRef=useRef<SaveAttempt|null>(null),deletedIds=useRef(new Set<string>());
  function purgeAccess(status:number,notice?:string,keepAttempt:SaveAttempt|null=null){
    accessEpoch.current++;accessDenied.current=true;analyticsRead.current?.abort();savedOp.current?.abort();savedOp.current=null;
    setResult(null);setDraft(initialDraft());setFormError('');setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);setSelected(null);setSelectedId('');setSavedName('');setSavedRole(null);savedRoleRef.current=null;setSavedBusy(false);setSavedError('');setSavedNotice('');pendingRef.current=keepAttempt;setPending(keepAttempt);
    const initial=buildParams(initialDraft());if('qs'in initial)setApplied(initial.qs);
    setPhase(status===401?'denied':'unavailable');setMessage(notice??(status===401?'Your session has ended. Sign in again to continue.':'This project is unavailable. It may have been removed or you may not have access.'));
    if(status===401)unauthRef.current();
  }
  function acceptRole(value:unknown){if(!roleValue(value)){purgeAccess(403,'Project access could not be verified. Reload access before confirming any pending save.',pendingRef.current);throw new Error('Project access could not be verified.');}savedRoleRef.current=value;setSavedRole(value);return value;}
  async function readSaved(id?:string,loadDraft=false,cursor?:string,recover=false){
    if(accessDenied.current&&!recover||pendingRef.current&&loadDraft)return;
    savedOp.current?.abort();const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');savedRoleRef.current=null;
    try{
      const data=await api<unknown>(id?`${base}/${encodeURIComponent(id)}`:base+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current||savedOp.current!==op)return;
      if(!record(data))throw new Error('Saved filters could not be verified. Refresh the saved list.');acceptRole(data.role);
      if(id){
        if(!validSaved(data.item,projectId)||data.item.id!==id||deletedIds.current.has(id))throw new Error('This saved filter is no longer available. Refresh the saved list.');
        const item=data.item;setSelected(item);setSelectedId(id);setSavedName(item.definition.name);setSavedItems(old=>old.map(value=>value.id===id?item:value));
        if(loadDraft){const predicates=savedPredicates(item.definition.query)!;setDraft(old=>({...old,...predicates}));setFormError('');setSavedNotice('Saved filters loaded into your draft. Apply filters to update results and CSV.');}
      }else{
        if(!Array.isArray(data.items)||data.items.length>50||!data.items.every(value=>validSaved(value,projectId))||new Set(data.items.map(value=>value.id)).size!==data.items.length||data.nextCursor!==null&&!clean(data.nextCursor,4096))throw new Error('Saved filters could not be verified. Refresh the saved list.');
        const items=(data.items as SavedFilter[]).filter(value=>!deletedIds.current.has(value.id));
        setSavedItems(old=>[...new Map([...(cursor?old:[]),...items].map(value=>[value.id,value])).values()]);setSavedCursor(data.nextCursor as string|null);setSavedLoaded(true);
      }
      if(recover){accessDenied.current=false;setPhase('error');setMessage('Access rechecked. Apply filters to load report results.');}
      return true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){
        if(id&&e.status===404){deletedIds.current.add(id);purgeAccess(404,'This saved filter or project is unavailable. Retry to reload access.');}
        else purgeAccess(e.status);
      }else{setSavedRole(null);savedRoleRef.current=null;setSelected(null);setSavedError(errMsg(e));}
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
  }
  async function saveAttempt(value:SaveAttempt){
    if(savedOp.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    pendingRef.current=value;setPending(value);const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');setSavedNotice('');
    let conflict=false,reloadList=false;
    try{
      const data=await api<unknown>(value.kind==='create'?base:`${base}/${encodeURIComponent(value.id!)}/${value.kind}`,{method:'POST',body:value.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('The save acknowledgement could not be verified.');acceptRole(data.role);
      if(!canSave(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The save acknowledgement could not be verified.');
      if(value.kind==='delete'){
        if(data.deleted!==true||data.id!==value.id)throw new Error('The deletion acknowledgement could not be matched.');
        deletedIds.current.add(value.id!);setSavedItems(old=>old.filter(item=>item.id!==value.id));setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('Saved filter deleted. Your draft and applied results are unchanged.');
      }else if(data.deleted){
        if(data.item!==null||data.replayed!==true)throw new Error('The saved filter receipt could not be verified.');
        if(value.id){deletedIds.current.add(value.id);setSavedItems(old=>old.filter(item=>item.id!==value.id));}else{setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);reloadList=true;}
        setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('The original save was confirmed, but that saved filter was since deleted. It was not recreated.');
      }else{
        if(!validSaved(data.item,projectId)||value.id&&data.item.id!==value.id||value.body.revision!==undefined&&data.item.revision<=value.body.revision||deletedIds.current.has(data.item.id)||!data.replayed&&(data.item.revision!==(value.body.revision??0)+1||!sameDefinition(value.body.definition!,data.item.definition)))throw new Error('The save acknowledgement could not be matched.');
        const item=data.item;setSavedItems(old=>[item,...old.filter(row=>row.id!==item.id)]);setSelected(item);setSelectedId(item.id);setSavedName(item.definition.name);setSavedNotice(data.replayed?'Original save confirmed. The current saved definition is shown; your draft is unchanged.':'Saved. Results and CSV still use the applied filters.');
      }
      pendingRef.current=null;setPending(null);
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setSavedError('The outcome is unknown. Retry the same request to confirm it; the original settings are kept.');
      else{
        pendingRef.current=null;setPending(null);
        if([401,403,404].includes(status))purgeAccess(status,status===404?'This saved filter or project is unavailable. Retry to reload access.':undefined);
        else if(status===409){setSelected(null);setSavedError('This saved filter changed. Reloading its current definition; review it before saving again. Your report draft is unchanged.');conflict=true;}
        else setSavedError(errMsg(e));
      }
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
    if(conflict&&alive.current&&generation===accessEpoch.current&&await readSaved(value.id))setSavedError('This saved filter changed. Its current definition was reloaded. Review it before saving again; your report draft is unchanged.');
    if(reloadList&&alive.current&&generation===accessEpoch.current)void readSaved();
  }
  function saveFilters(kind:'create'|'update'|'rename'|'delete'){
    if(savedOp.current||pendingRef.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    if(kind!=='create'&&!selected)return;
    if(kind==='delete'){
      if(window.confirm('Delete this saved filter? Your report draft and results will stay unchanged.'))void saveAttempt({kind,id:selected!.id,body:{requestId:crypto.randomUUID(),revision:selected!.revision}});return;
    }
    const name=savedName.trim();if(!clean(name,200)||!name){setSavedError('Enter a name of 1 to 200 characters.');return;}
    const query=kind==='rename'?{qs:selected!.definition.query}:draftFilterQuery(draft);if('error'in query){setSavedError(query.error);return;}
    void saveAttempt({kind:kind==='create'?'create':'update',...(kind!=='create'?{id:selected!.id}:{}),body:{requestId:crypto.randomUUID(),...(kind!=='create'?{revision:selected!.revision}:{}),definition:{schemaVersion:1,name,query:query.qs}}});
  }
  useBlocker({shouldBlockFn:()=>pendingRef.current!==null&&!window.confirm('A saved-filter request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>pendingRef.current!==null});
  useEffect(()=>{alive.current=true;void readSaved();return()=>{alive.current=false;accessEpoch.current++;savedOp.current?.abort();pendingRef.current=null;};},[]);

  useEffect(()=>{
    if(accessDenied.current)return;
    const ctrl=new AbortController();
    const generation=accessEpoch.current;analyticsRead.current=ctrl;
    setResult(null);setPhase('loading');setMessage('');
    api<ExploreResult>(`/api/projects/${encodeURIComponent(projectId)}/explore?${applied}`,{signal:ctrl.signal})
      .then(r=>{if(!ctrl.signal.aborted&&generation===accessEpoch.current){setResult(r);setPhase('ok');}})
      .catch(e=>{
        if(ctrl.signal.aborted||generation!==accessEpoch.current)return;
        setResult(null);
        if(e instanceof ApiError&&e.status===401){
          purgeAccess(401);
        }else if(e instanceof ApiError&&(e.status===403||e.status===404)){
          purgeAccess(e.status);
        }else{
          setPhase('error');setMessage(`Couldn't load explore data. ${errMsg(e)}`);
        }
      });
    return()=>ctrl.abort();
  },[applied,attempt,projectId]);

  const refresh=()=>{if(accessDenied.current){accessDenied.current=false;void readSaved();}setResult(null);setPhase('loading');setMessage('');setAttempt(a=>a+1);};

  const apply=(e:FormEvent)=>{
    e.preventDefault();
    if(accessDenied.current)return;
    const r=buildParams(draft);
    if('error'in r){setFormError(r.error);return;}
    setFormError('');setApplied(r.qs);refresh();
  };

  const download=()=>{
    if(phase!=='ok'||!result)return;
    const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');
    a.href=url;a.download='ten98-explore.csv';
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
  };

  const patch=(p:Partial<Draft>)=>setDraft(d=>({...d,...p}));
  const patchFilter=(k:string,p:Partial<FilterRow>)=>setDraft(d=>({...d,filters:{...d.filters,[k]:{...d.filters[k],...p}}}));
  const patchProp=(p:Partial<Draft['prop']>)=>setDraft(d=>({...d,prop:{...d.prop,...p}}));

  const keyList=phase==='ok'&&result?result.properties.keys:[];
  const keysTruncated=phase==='ok'&&result?result.properties.truncated:false;
  const t=result?.totals;
  const currentParams=buildParams(draft);
  const unapplied='error'in currentParams||currentParams.qs!==applied;

  return(
    <section className="explorer stack" aria-labelledby={`${uid}-h`} style={{'--control-md':'var(--control-touch)'} as import('react').CSSProperties}>
      <h2 id={`${uid}-h`}>Explore</h2>

      <form className="card stack" onSubmit={apply}>
        <fieldset className="stack" disabled={phase==='denied'||phase==='unavailable'} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <section className="stack" aria-label="Saved filters" style={{minWidth:0,overflowWrap:'anywhere'}}>
          <div className="row" style={{alignItems:'end'}}>
            <div style={{flex:'1 1 240px',minWidth:0}}><label htmlFor={`${uid}-saved`}>Saved filters</label><select id={`${uid}-saved`} style={{width:'100%',minWidth:0}} disabled={savedBusy||!!pending||!savedRole} value={selectedId} onChange={e=>{const id=e.target.value;setSelectedId(id);setSelected(null);setSavedName('');setSavedNotice('');if(id)void readSaved(id);}}><option value="">Choose a saved filter</option>{savedItems.map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></div>
            <button className="btn" type="button" disabled={savedBusy||!!pending||!selected||!savedRole} onClick={()=>void readSaved(selectedId,true)}>Load</button>
            <button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved()}>Refresh saved filters</button>
            {savedCursor&&<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,savedCursor)}>Load more saved filters</button>}
          </div>
          <p className="hint">Load replaces draft filters only. Dates, time zone and grouping stay as you set them. Apply filters to update results and CSV.</p>
          {savedBusy&&<p role="status">{pending?'Saving filters…':'Loading saved filters…'}</p>}
          {savedLoaded&&!savedItems.length&&!savedBusy&&<p className="hint">No saved filters yet.</p>}
          {savedNotice&&<p className="notice" role="status">{savedNotice}</p>}
          {savedError&&<p className="alert" role="alert">{savedError}</p>}
          {pending&&<div className="row"><p className="hint">This request keeps its original name, filters and revision.</p><button className="btn" type="button" disabled={savedBusy||!canSave(savedRole)} onClick={()=>void saveAttempt(pending)}>Retry same request</button></div>}
          {canSave(savedRole)&&<details><summary>Save or manage filters</summary><div className="stack">
            <p className="hint">Save the current draft's event kind, exact filters and typed property filter. Dates, time zone and grouping are excluded.</p>
            <details><summary>Draft filters to save</summary><p>{labelOf(KINDS,draft.kind)}</p>{FILTERS.filter(([key])=>draft.filters[key].on).map(([key,label])=><p key={key}>{label} equals {JSON.stringify(draft.filters[key].value)}</p>)}{draft.prop.on&&<p>Property {JSON.stringify(draft.prop.key)}: {draft.prop.type}{draft.prop.type!=='missing'?` equals ${draft.prop.value}`:''}</p>}{!FILTERS.some(([key])=>draft.filters[key].on)&&!draft.prop.on&&<p>No additional filters.</p>}</details>
            <div><label htmlFor={`${uid}-saved-name`}>Saved filter name</label><input id={`${uid}-saved-name`} style={{width:'100%',minWidth:0}} maxLength={200} value={savedName} disabled={savedBusy||!!pending} onChange={e=>setSavedName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();saveFilters(selected?'rename':'create');}}}/></div>
            {selected&&<p className="hint">Selected: {selected.definition.name} · Revision {selected.revision}. Rename keeps its saved predicates; Update saved filter replaces them with your current draft.</p>}
            <div className="row"><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('create')}>{selected?'Save as new':'Save filters'}</button>{selected&&<><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('update')}>Update saved filter</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('rename')}>Rename</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('delete')}>Delete saved filter</button></>}</div>
          </div></details>}
          {savedRole==='viewer'&&<p className="hint">You can load saved filters. An owner, admin or editor can save changes.</p>}
        </section>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-from`}>From</label>
          <input id={`${uid}-from`} type="date" required max={draft.to} value={draft.from} onChange={e=>patch({from:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-to`}>To</label>
          <input id={`${uid}-to`} type="date" required min={draft.from} value={draft.to} onChange={e=>patch({to:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-tz`}>Time zone</label>
          <input id={`${uid}-tz`} type="text" required list={`${uid}-tzl`} value={draft.timeZone} onChange={e=>patch({timeZone:e.target.value})}/>
          </div>
          <datalist id={`${uid}-tzl`}>{TIMEZONES.map(z=><option key={z} value={z}/>)}</datalist>
        </div>
        <p className="hint dim">Dates include the whole calendar day in your selected time zone.</p>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-kind`}>Show</label>
          <select id={`${uid}-kind`} value={draft.kind} onChange={e=>patch({kind:e.target.value})}>
            {KINDS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div><div>
          <label htmlFor={`${uid}-gb`}>Group by</label>
          <select id={`${uid}-gb`} value={draft.groupBy} onChange={e=>patch({groupBy:e.target.value})}>
            {GROUPS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div>
          {draft.groupBy==='property'&&(<div>
            <label htmlFor={`${uid}-gp`}>Property key</label>
            <input id={`${uid}-gp`} type="text" required maxLength={320} list={`${uid}-keys`} placeholder="nested.count or a\.b" value={draft.groupProperty} onChange={e=>patch({groupProperty:e.target.value})}/>
          </div>)}
          <datalist id={`${uid}-keys`}>{keyList.map(k=><option key={k} value={k}/>)}</datalist>
        </div>
        {draft.groupBy==='property'&&keysTruncated&&(
          <p className="hint dim">Key suggestions show the top 100 keys only; exact keys not listed still work.</p>
        )}

        <details>
          <summary>More filters</summary>
            <div className="stack">
            {FILTERS.map(([k,l])=>(
              <div className="row" key={k}>
                <input id={`${uid}-${k}-on`} type="checkbox" checked={draft.filters[k].on} onChange={e=>patchFilter(k,{on:e.target.checked})}/>
                <label htmlFor={`${uid}-${k}-on`}>Enable {l}</label>
                <label htmlFor={`${uid}-${k}-v`}>{l} equals</label>
                <input id={`${uid}-${k}-v`} type="text" disabled={!draft.filters[k].on} value={draft.filters[k].value} onChange={e=>patchFilter(k,{value:e.target.value})}/>
              </div>
            ))}
            <div className="row">
              <input id={`${uid}-pf-on`} type="checkbox" checked={draft.prop.on} onChange={e=>patchProp({on:e.target.checked})}/>
              <label htmlFor={`${uid}-pf-on`}>Enable property filter</label>
            </div>
            {draft.prop.on&&(<>
              <div className="row">
                <label htmlFor={`${uid}-pf-key`}>Property key</label>
                <input id={`${uid}-pf-key`} type="text" required maxLength={320} list={`${uid}-keys`} value={draft.prop.key} onChange={e=>patchProp({key:e.target.value})}/>
                <label htmlFor={`${uid}-pf-type`}>Type</label>
                <select id={`${uid}-pf-type`} value={draft.prop.type} onChange={e=>patchProp({type:e.target.value})}>
                  {PROP_TYPES.map(p=><option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {draft.prop.type!=='missing'&&(
                <div className="row">
                  <label htmlFor={`${uid}-pf-val`}>Value (JSON literal)</label>
                  <input id={`${uid}-pf-val`} type="text" required placeholder='"starter", 42, true, null' value={draft.prop.value} onChange={e=>patchProp({value:e.target.value})}/>
                </div>
              )}
              <p className="hint dim">Valid date strings are normalized; arrays compare the whole array.{keysTruncated?' Key suggestions show the top 100 keys only; exact keys not listed still work.':''}</p>
            </>)}
          </div>
        </details>

        <div className="row">
          <button className="btn primary" type="submit">Apply filters</button>
          <button className="btn" type="button" disabled={phase==='loading'} onClick={refresh}>Refresh</button>
          {phase==='ok'&&result&&<button className="btn" type="button" onClick={download}>Download CSV</button>}
        </div>
        {unapplied&&<p className="hint" role="status">You have unapplied changes. Apply filters to update the results and CSV.</p>}
        {formError&&<p className="alert" role="alert">{formError}</p>}
        {phase==='ok'&&result&&<p className="hint dim">CSV downloads the current bounded table, daily data and scope — it is not a complete data export.</p>}
        </fieldset>
      </form>

      <p role="status" aria-live="polite" className={phase==='loading'||phase==='ok'?'hint dim':'alert'}>
        {phase==='loading'?'Loading explore data…':message}
      </p>
      {(phase==='error'||phase==='unavailable')&&(accessDenied.current&&pending?<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,undefined,true)}>Reload saved-filter access</button>:<button className="btn" type="button" onClick={refresh}>Retry</button>)}

      {phase==='ok'&&result&&t&&(<>
        <p className="hint dim">
          {result.range.from} to {result.range.to} ({result.range.timeZone}) · {labelOf(KINDS,result.query.kind)} · grouped by {labelOf(GROUPS,result.query.groupBy)}{result.query.groupProperty?`: ${result.query.groupProperty}`:''}
        </p>
        <details className="explorer-scope"><summary>Applied filters and boundaries</summary>
          <p className="hint">UTC bounds: {result.range.start} (inclusive) to {result.range.end} (exclusive). Only instants within the selected local dates are included.</p>
          {Object.entries(result.query.filters).map(([key,value])=><p key={key}>{labelOf(FILTERS,key)} equals {JSON.stringify(value)}</p>)}
          {result.query.property&&<p>Property {JSON.stringify(result.query.property.key)}: {result.query.property.type}{result.query.property.type!=='missing'?` equals ${JSON.stringify(result.query.property.value)}`:''}</p>}
          {!Object.keys(result.query.filters).length&&!result.query.property&&<p className="hint">No additional filters.</p>}
        </details>
        {result.coverage.status!=='complete'&&(
          <p className="hint">Coverage is {result.coverage.status}: results include retained observations only{result.coverage.retainedFrom?` from ${result.coverage.retainedFrom}`:''}.</p>
        )}

        <div className="metric-grid">
          <div className="card">
            <div className={`metric-value${t.events===null?' is-unavailable':''}`}>{num(t.events)}</div>
            <div className="metric-label">Events</div>
            <div className="hint dim">{num(t.identifiedEvents)} identified · {num(t.unidentifiedEvents)} unidentified</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.pageViews===null?' is-unavailable':''}`}>{num(t.pageViews)}</div>
            <div className="metric-label">Page views</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.customEvents===null?' is-unavailable':''}`}>{num(t.customEvents)}</div>
            <div className="metric-label">Custom events</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.visitors===null?' is-unavailable':''}`}>{num(t.visitors)}</div>
            <div className="metric-label">Visitors</div>
            <div className="hint dim">{t.visitors==null?'Visitor estimate unavailable':`${num(t.visits)} visits`}</div>
          </div>
        </div>

        <div className="card stack">
          <h3>Breakdown</h3>
          <p className="hint dim">
            {result.coverage.status==='unavailable'?'Breakdown unavailable after retention.':<>
            Returned {result.breakdown.returnedGroupEvents} of {num(t.events)} events across {result.breakdown.totalGroups} groups.
            {result.breakdown.truncated?' Breakdown truncated — apply filters to narrow the results.':''}
            </>}
          </p>
          {result.breakdown.groups.length===0?(
            <p className="hint dim">{result.coverage.status==='unavailable'?'This history is no longer available. Choose a more recent range.':'No retained events match these filters. Change the dates or remove filters.'}</p>
          ):(
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Breakdown data, scroll horizontally for all columns">
              <table>
                <thead><tr><th>Value</th><th>Type</th><th>Events</th><th>Visitors</th></tr></thead>
                <tbody>
                  {result.breakdown.groups.slice(0,100).map((g,i)=>(
                    <tr key={i}>
                      <td>{groupValue(g.type,g.value)}</td>
                      <td>{groupType(g.type)}</td>
                      <td>{g.events}</td>
                      <td>{g.visitors==null?'Unavailable':g.visitors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <details className="card">
          <summary>Daily data ({result.daily.length} {result.daily.length===1?'day':'days'})</summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Daily data, scroll horizontally for all columns">
            <table>
              <thead><tr><th>Date</th><th>Events</th><th>Page views</th><th>Custom events</th><th>Coverage</th></tr></thead>
              <tbody>
                {result.daily.map(d=>(
                  <tr key={d.date}>
                    <td>
                      {d.date}
                      {d.skipped?(
                        <div className="hint dim">This calendar date did not occur in {result.range.timeZone}.</div>
                      ):(
                        <details>
                          <summary className="hint dim">UTC boundaries</summary>
                          <div className="hint dim">{d.start} – {d.end}</div>
                        </details>
                      )}
                    </td>
                    <td>{d.skipped?'—':num(d.events)}</td>
                    <td>{d.skipped?'—':num(d.pageViews)}</td>
                    <td>{d.skipped?'—':num(d.customEvents)}</td>
                    <td>{d.coverage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {result.numeric&&(
          <div className="card stack">
            <h3>Property values</h3>
            <p className="hint dim">{result.numeric.samples} numeric {result.numeric.samples===1?'sample':'samples'} · exact decimal values</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Numeric property data, scroll horizontally for all columns">
              <table>
                <thead><tr><th>Sum</th><th>Average</th><th>Min</th><th>Max</th></tr></thead>
                <tbody><tr>
                  <td>{decimal(result.numeric.sum)}</td>
                  <td>{decimal(result.numeric.average)}</td>
                  <td>{decimal(result.numeric.min)}</td>
                  <td>{decimal(result.numeric.max)}</td>
                </tr></tbody>
              </table>
            </div>
          </div>
        )}
      </>)}
    </section>
  );
}
