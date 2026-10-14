import {useEffect,useId,useRef,useState,type CSSProperties} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';

type Role='owner'|'admin'|'editor'|'viewer';
type Range={from:string;to:string;timeZone:string};
type Definition={date:string;allDay:boolean;note:string};
type DayDefinition={day:string;timeZone:string;allDay:true;note:string};
type Item={id:string;projectId:string;revision:number;definition:Definition;createdAt:string;updatedAt:string};
type Timeline={range:Range;days:{date:string;count:number;previews:Item[]}[];totalCount:number};
type Attempt={kind:'create'|'update'|'delete';id?:string;body:{requestId:string;revision?:number;definition?:Definition|DayDefinition}};
type Editor={item:Item|null;note:string;day:string;timeZone:string;timed:boolean;instant:string;changeDate:boolean};
type Props={projectId:string;userId:string;range:Range|null;onUnauthorized:()=>void;onAccessLost:(status:number)=>void};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const clean=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(v))===v;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const roleValue=(v:unknown):v is Role=>['owner','admin','editor','viewer'].includes(v as string);
const writable=(v:Role|null)=>v==='owner'||v==='admin'||v==='editor';
const dayValue=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v&&v>='1970-01-01'&&v<='9998-12-31';
const instantValue=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v&&v>='1970'&&v<'9999';
function localDay(date:string,timeZone:string){const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(date));return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');}
function validItem(v:unknown,projectId:string):v is Item{
  if(!record(v)||!uuid(v.id)||v.projectId!==projectId||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||Number(v.revision)>2147483647||!record(v.definition))return false;
  const d=v.definition;return instantValue(d.date)&&typeof d.allDay==='boolean'&&clean(d.note,500)&&d.note.trim()===d.note&&d.note.length>0&&['createdAt','updatedAt'].every(key=>typeof v[key]==='string'&&Number.isFinite(Date.parse(v[key] as string)));
}
function matchedDefinition(expected:Definition|DayDefinition,actual:Definition){return expected.note.trim()===actual.note&&expected.allDay===actual.allDay&&('day'in expected?localDay(actual.date,expected.timeZone)===expected.day:new Date(expected.date).toISOString()===actual.date);}
const field={width:'100%',minWidth:0,minHeight:44};
const summary={minHeight:44,paddingBlock:10};

// Callers are keyed by account and project; a range change keeps immutable pending intent.
export function useAnnotations({projectId,range,onUnauthorized,onAccessLost}:Props){
  const uid=useId(),base=`/api/projects/${encodeURIComponent(projectId)}/annotations`,rangeKey=range?JSON.stringify(range):'';
  const [role,setRole]=useState<Role|null>(null),[rows,setRows]=useState<Item[]>([]),[cursor,setCursor]=useState<string|null>(null),[timeline,setTimeline]=useState<Timeline|null>(null);
  const [scope,setScope]=useState<'range'|'all'>('range'),[day,setDay]=useState(''),[search,setSearch]=useState(''),[appliedSearch,setAppliedSearch]=useState('');
  const [open,setOpen]=useState(false),[editor,setEditor]=useState<Editor|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false),[pending,setPending]=useState<Attempt|null>(null);
  const alive=useRef(false),opRef=useRef<AbortController|null>(null),epoch=useRef(0),roleRef=useRef<Role|null>(null),pendingRef=useRef<Attempt|null>(null),deleted=useRef(new Set<string>()),rangeRef=useRef(rangeKey),callbacks=useRef({onUnauthorized,onAccessLost}),manager=useRef<HTMLDetailsElement>(null);
  callbacks.current={onUnauthorized,onAccessLost};rangeRef.current=rangeKey;
  function clearData(){setRows([]);setTimeline(null);setCursor(null);setEditor(null);setLoaded(false);setRole(null);roleRef.current=null;setNotice('');}
  function deny(status:number,keep:Attempt|null=null){epoch.current++;opRef.current?.abort();opRef.current=null;setBusy(false);clearData();setSearch('');setAppliedSearch('');pendingRef.current=keep;setPending(keep);setError('Annotation access could not be verified. Reload annotations to check current access.');if(status===401)callbacks.current.onUnauthorized();else callbacks.current.onAccessLost(status);}
  function acceptRole(value:unknown){if(!roleValue(value)){deny(403,pendingRef.current);throw new Error('Annotation access could not be verified.');}roleRef.current=value;setRole(value);return value;}
  function edit(item:Item|null){if(pendingRef.current||!writable(roleRef.current)||!range)return;setEditor({item,note:item?.definition.note??'',day:item?localDay(item.definition.date,range.timeZone):range.to,timeZone:range.timeZone,timed:item?!item.definition.allDay:false,instant:item?.definition.date??'',changeDate:!item});setNotice('');}
  async function load(options:{scope?:'range'|'all';day?:string;search?:string;cursor?:string;id?:string}={}){
    if(opRef.current&&pendingRef.current||options.id&&pendingRef.current)return;
    const currentRange=range;if(!currentRange)return;
    opRef.current?.abort();const op=new AbortController(),generation=epoch.current,key=rangeRef.current;opRef.current=op;setBusy(true);setError('');roleRef.current=null;
    const nextScope=options.scope??scope,nextDay=options.day??day,nextSearch=options.search??appliedSearch;
    const params=new URLSearchParams(nextScope==='range'?{from:nextDay||currentRange.from,to:nextDay||currentRange.to,timeZone:currentRange.timeZone}:{});
    if(nextSearch)params.set('search',nextSearch);if(options.cursor)params.set('cursor',options.cursor);
    try{
      const signal=AbortSignal.any([op.signal,AbortSignal.timeout(20000)]);
      const [list,marks]=await Promise.all([api<unknown>(options.id?`${base}/${encodeURIComponent(options.id)}`:base+'?'+params,{signal}),api<unknown>(base+'/timeline?'+new URLSearchParams(currentRange),{signal})]);
      if(!alive.current||op.signal.aborted||generation!==epoch.current||key!==rangeRef.current)return;
      if(!record(list)||!record(marks))throw new Error('Annotations could not be verified. Reload annotations.');
      const currentRole=acceptRole(list.role);if(!roleValue(marks.role)||marks.role!==currentRole){deny(403,pendingRef.current);return;}
      const markRange=marks.range;
      if(!record(markRange)||markRange.from!==currentRange.from||markRange.to!==currentRange.to||markRange.timeZone!==currentRange.timeZone||!Array.isArray(marks.days)||marks.days.length>366||!Number.isSafeInteger(marks.totalCount)||Number(marks.totalCount)<0)throw new Error('Annotation dates could not be verified. Reload annotations.');
      const seen=new Set<string>(),previewIds=new Set<string>();let total=0;
      for(const mark of marks.days){
        if(!record(mark)||!dayValue(mark.date)||mark.date<currentRange.from||mark.date>currentRange.to||seen.has(mark.date)||!Number.isSafeInteger(mark.count)||Number(mark.count)<1||!Array.isArray(mark.previews)||mark.previews.length>3||mark.previews.length>Number(mark.count))throw new Error('Annotation counts could not be verified.');
        seen.add(mark.date);total+=Number(mark.count);
        for(const item of mark.previews){if(!validItem(item,projectId)||localDay(item.definition.date,currentRange.timeZone)!==mark.date||previewIds.has(item.id)||deleted.current.has(item.id))throw new Error('Annotation previews could not be verified.');previewIds.add(item.id);}
      }
      if(!Number.isSafeInteger(total)||total!==marks.totalCount)throw new Error('Annotation total could not be verified.');
      if(options.id){if(!validItem(list.item,projectId)||list.item.id!==options.id||deleted.current.has(options.id))throw new Error('This annotation is no longer available. Reload annotations.');if(writable(currentRole)){const item=list.item;setEditor({item,note:item.definition.note,day:localDay(item.definition.date,currentRange.timeZone),timeZone:currentRange.timeZone,timed:!item.definition.allDay,instant:item.definition.date,changeDate:false});}else setEditor(null);}
      else{
        if(!Array.isArray(list.items)||list.items.length>50||!list.items.every(item=>validItem(item,projectId))||new Set(list.items.map(item=>item.id)).size!==list.items.length||list.nextCursor!==null&&(!clean(list.nextCursor,4096)||!list.nextCursor))throw new Error('Annotation list could not be verified. Reload annotations.');
        const values=(list.items as Item[]).filter(item=>!deleted.current.has(item.id));
        if(nextScope==='range'&&values.some(item=>{const date=localDay(item.definition.date,currentRange.timeZone);return date<(nextDay||currentRange.from)||date>(nextDay||currentRange.to);}))throw new Error('Annotation scope could not be verified.');
        setRows(old=>[...new Map([...(options.cursor?old:[]),...values].map(item=>[item.id,item])).values()]);setCursor(list.nextCursor as string|null);setScope(nextScope);setDay(nextDay);setAppliedSearch(nextSearch);setLoaded(true);if(!writable(currentRole))setEditor(null);
      }
      setTimeline(marks as unknown as Timeline);
    }catch(e){if(!alive.current||op.signal.aborted||generation!==epoch.current||key!==rangeRef.current)return;const status=e instanceof ApiError?e.status:0;if([401,403,404].includes(status))deny(status,pendingRef.current);else{clearData();setError(errMsg(e));}}
    finally{if(opRef.current===op){opRef.current=null;if(alive.current)setBusy(false);}}
  }
  async function save(attempt:Attempt){
    if(opRef.current||!writable(roleRef.current))return;
    const confirming=pendingRef.current===attempt;
    pendingRef.current=attempt;setPending(attempt);const op=new AbortController(),generation=epoch.current;opRef.current=op;setBusy(true);setError('');setNotice('');let refresh=false,conflict=false;
    try{
      const data=await api<unknown>(attempt.kind==='create'?base:`${base}/${encodeURIComponent(attempt.id!)}/${attempt.kind}`,{method:'POST',body:attempt.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==epoch.current)return;
      if(!record(data))throw new Error('The annotation acknowledgement could not be verified.');acceptRole(data.role);
      if(!writable(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The annotation acknowledgement could not be verified.');
      if(attempt.kind==='delete'){
        if(data.id!==attempt.id||data.deleted!==true)throw new Error('The deletion acknowledgement could not be matched.');deleted.current.add(attempt.id!);setNotice('Annotation deleted. Traffic and CSV are unchanged.');
      }else if(data.deleted){
        if(data.item!==null||data.replayed!==true)throw new Error('The annotation receipt could not be verified.');if(attempt.id)deleted.current.add(attempt.id);setNotice('The original save was confirmed, but the annotation was since deleted. It was not recreated.');
      }else{
        if(!validItem(data.item,projectId)||attempt.id&&data.item.id!==attempt.id||deleted.current.has(data.item.id)||attempt.body.revision!==undefined&&data.item.revision<=attempt.body.revision||!data.replayed&&(data.item.revision!==(attempt.body.revision??0)+1||!matchedDefinition(attempt.body.definition!,data.item.definition)))throw new Error('The annotation acknowledgement could not be matched.');
        setNotice(data.replayed?'Original save confirmed. Reloaded notes show the current version.':'Annotation saved. Notes outside this range appear under All notes.');
      }
      pendingRef.current=null;setPending(null);setEditor(null);setRows([]);setTimeline(null);setCursor(null);refresh=true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==epoch.current)return;const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setError('The outcome is unknown. Retry the same request to confirm it. The original note, date and revision are kept.');
      else{pendingRef.current=null;setPending(null);if([401,403,404].includes(status))deny(status,confirming?attempt:null);else if(status===409){setEditor(null);setError('This annotation changed. Reloading its current version; review it before saving again.');conflict=true;}else setError(errMsg(e));}
    }finally{if(opRef.current===op){opRef.current=null;if(alive.current)setBusy(false);}}
    if(alive.current&&generation===epoch.current){if(conflict){await load({id:attempt.id});setError('This annotation changed. Review its reloaded version before saving again.');}else if(refresh)void load();}
  }
  function submit(){
    if(!editor||pendingRef.current||opRef.current||!writable(roleRef.current))return;const note=editor.note.trim();if(!clean(note,500)||!note){setError('Enter a note of 1 to 500 characters.');return;}
    let definition:Definition|DayDefinition;
    if(editor.item&&!editor.changeDate)definition={...editor.item.definition,note};
    else if(editor.timed){const date=editor.instant;if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(date)||!dayValue(date.slice(0,10))||date.endsWith('-00:00')||!Number.isFinite(Date.parse(date))||!instantValue(new Date(date).toISOString())){setError('Enter a valid time with Z or an explicit offset, for example 2026-03-08T09:30:00-04:00.');return;}definition={date,allDay:false,note};}
    else{if(!dayValue(editor.day)){setError('Choose a valid date from 1970 to 9998.');return;}definition={day:editor.day,timeZone:editor.timeZone,allDay:true,note};}
    void save({kind:editor.item?'update':'create',...(editor.item?{id:editor.item.id}:{}),body:{requestId:crypto.randomUUID(),...(editor.item?{revision:editor.item.revision}:{}),definition}});
  }
  useBlocker({shouldBlockFn:()=>pendingRef.current!==null&&!window.confirm('An annotation request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>pendingRef.current!==null});
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;opRef.current?.abort();};},[]);
  useEffect(()=>{epoch.current++;opRef.current?.abort();opRef.current=null;setBusy(false);clearData();setDay('');setSearch('');setAppliedSearch('');setScope('range');if(range)void load({scope:'range',day:'',search:''});},[rangeKey]);
  const locked=busy||!!pending,zone=range?.timeZone??'UTC';
  function dayButton(date:string){
    const count=timeline?.days.find(mark=>mark.date===date)?.count??0;
    return <button key={date} className="btn annotation-day" type="button" disabled={busy||!timeline} aria-label={`${date}: ${timeline?count:'unavailable'} ${count===1?'annotation':'annotations'}`} aria-controls={`${uid}-manager`} onClick={()=>{setOpen(true);setSearch('');void load({scope:'range',day:date,search:''});manager.current?.querySelector('summary')?.focus();}}>{timeline?count:'—'} {count===1?'note':'notes'}</button>;
  }
  const panel=<section className="stack annotations" aria-label="Annotations" style={{minWidth:0,overflowWrap:'anywhere','--control-md':'var(--control-touch)'} as CSSProperties}>
    <div className="row between"><h3>Annotations</h3><button type="button" className="btn" disabled={busy||!range} onClick={()=>void load()}>Reload annotations</button></div>
    <p className="hint">Project notes add context. They do not change traffic, filters or CSV exports.</p>
    {range?<p className="hint">{range.from} to {range.to} ({zone}){timeline?` · ${timeline.totalCount} ${timeline.totalCount===1?'annotation':'annotations'}`:''}</p>:<p className="hint">Load report results to see annotations for the applied dates.</p>}
    {busy&&<p role="status">{pending?'Saving annotation…':'Loading annotations…'}</p>}
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="alert" role="alert">{error}</p>}
    {pending&&<div className="row"><p className="hint">Only the original request can be retried until its outcome is confirmed.</p><button type="button" className="btn" disabled={busy||!writable(role)} onClick={()=>void save(pending)}>Retry same request</button></div>}
    {timeline?.totalCount===0&&<p className="hint">No annotations in this range.</p>}
    <details id={`${uid}-manager`} ref={manager} open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary style={summary}>View or manage notes</summary><div className="stack">
      <div className="row"><button className="btn" type="button" aria-pressed={scope==='range'&&!day} disabled={busy||!range} onClick={()=>void load({scope:'range',day:''})}>Current range</button><button className="btn" type="button" aria-pressed={scope==='all'} disabled={busy||!range} onClick={()=>void load({scope:'all',day:''})}>All notes</button>{writable(role)&&<button className="btn" type="button" disabled={locked||!range} onClick={()=>edit(null)}>Add annotation</button>}</div>
      {day&&scope==='range'&&<p className="hint">Notes on {day} ({zone}).</p>}{scope==='all'&&<p className="hint">All project notes, including future dates. Dates shown in {zone}.</p>}
      <form className="row" onSubmit={e=>{e.preventDefault();const text=search.trim();if(!clean(text,200)){setError('Search must be 200 characters or fewer.');return;}void load({search:text});}}><div style={{flex:'1 1 220px',minWidth:0}}><label htmlFor={`${uid}-search`}>Search notes</label><input id={`${uid}-search`} maxLength={200} value={search} disabled={busy||!role} style={field} onChange={e=>setSearch(e.target.value)}/></div><button type="submit" className="btn" disabled={busy||!role}>Search notes</button></form>
      {loaded&&<p className="hint">{rows.length} {rows.length===1?'note':'notes'} shown{cursor?' · More notes available':''}{appliedSearch?` matching “${appliedSearch}”`:''}.</p>}
      {rows.map(item=><article className="card stack" key={item.id}><p><time dateTime={item.definition.date}>{localDay(item.definition.date,zone)}{item.definition.allDay?' · All day':` · ${new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(item.definition.date))} (${zone})`}</time></p><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.definition.note}</p><details><summary style={summary}>Note details</summary><p className="hint">Saved instant: {item.definition.date} · Revision {item.revision}. Dates follow the report time zone; editing only the text keeps this instant and its all-day or timed setting.</p></details>{writable(role)&&<div className="row"><button type="button" className="btn" disabled={locked} onClick={()=>void load({id:item.id})}>Edit annotation</button><button type="button" className="btn" disabled={locked} onClick={()=>{if(!locked&&writable(roleRef.current)&&window.confirm('Delete this annotation? Traffic and CSV exports will stay unchanged.'))void save({kind:'delete',id:item.id,body:{requestId:crypto.randomUUID(),revision:item.revision}});}}>Delete annotation</button></div>}</article>)}
      {cursor&&<button type="button" className="btn" disabled={busy} onClick={()=>void load({cursor})}>Load more notes</button>}
      {role==='viewer'&&<p className="hint">You can read notes. An owner, admin or editor can add or change them.</p>}
      {editor&&writable(role)&&<form className="card stack" aria-label={editor.item?'Edit annotation':'Add annotation'} onSubmit={e=>{e.preventDefault();submit();}}><fieldset className="stack" disabled={locked} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <h4>{editor.item?'Edit annotation':'Add annotation'}</h4>
        {editor.item&&!editor.changeDate?<div><p>{editor.item.definition.date} · {editor.item.definition.allDay?'All day':'Timed'}. Saving the note keeps this date and setting.</p><button className="btn" type="button" onClick={()=>setEditor({...editor,changeDate:true})}>Change date or time</button></div>:<>
          {!editor.timed&&<div><label htmlFor={`${uid}-day`}>Annotation date ({editor.timeZone})</label><input id={`${uid}-day`} type="date" min="1970-01-01" max="9998-12-31" value={editor.day} style={field} onChange={e=>setEditor({...editor,day:e.target.value})}/><p className="hint">All-day note in {editor.timeZone}. Future dates are allowed.</p></div>}
          <details open={editor.timed||undefined}><summary style={summary}>Advanced: specific time</summary><label className="row" style={{minHeight:44}}><input type="checkbox" checked={editor.timed} onChange={e=>setEditor({...editor,timed:e.target.checked})}/>Use a specific time</label>{editor.timed&&<div><label htmlFor={`${uid}-instant`}>Date and time with UTC offset</label><input id={`${uid}-instant`} value={editor.instant} placeholder="2026-03-08T09:30:00-04:00" style={field} onChange={e=>setEditor({...editor,instant:e.target.value})}/><p className="hint">Use Z for UTC or an explicit offset such as -04:00. Precision up to milliseconds.</p></div>}</details>
        </>}
        <div><label htmlFor={`${uid}-note`}>Note</label><textarea id={`${uid}-note`} autoFocus maxLength={500} rows={4} value={editor.note} style={field} onChange={e=>setEditor({...editor,note:e.target.value})}/><p className="hint">{editor.note.length}/500 characters</p></div>
        <div className="row"><button className="btn" type="submit">{editor.item?'Save annotation':'Add annotation'}</button><button className="btn" type="button" onClick={()=>setEditor(null)}>Cancel note</button></div>
      </fieldset></form>}
    </div></details>
  </section>;
  return {panel,dayButton};
}
