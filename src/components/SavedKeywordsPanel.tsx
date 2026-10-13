import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {api,ApiError,errMsg} from '../lib/api';
import {SavedKeywordFilterFields,emptySavedKeywordFilters,type SavedKeywordFilterDraft} from './SavedKeywordFilterFields';
import {SavedKeywordRefreshPanel} from './SavedKeywordRefreshPanel';
import {isKeywordMetricRow} from '../lib/keyword-metrics';

type Role='owner'|'admin'|'editor'|'viewer';
type Tag={id:string;name:string;color:string|null;count?:number};
type Metrics={keyword:string;searchVolume:number|null;cpcUsd:string|null;competition:number|null;competitionLevel:string|null;keywordDifficulty:number|null;intent:string|null;metricsUpdatedAt:string|null;intentUpdatedAt:string|null;monthlySearches:{year:number;month:number;searchVolume:number|null}[]};
type Row={id:string;keyword:string;locationCode:number;languageCode:string;createdAt:string;updatedAt:string;tags:Tag[];metrics:{status:'available'|'unavailable'|'expired';row:Metrics|null;sourceRunId:string|null;sourceRowIndex:number|null;source:string|null;fetchedAt:string|null;observedAt:string|null};refresh:{eligible:boolean;reason:string|null;lastAttemptStatus:string|null;lastAttemptAt:string|null}};
type List={role:Role;revision:number;metricRevision:string;filters:Record<string,unknown>;total:number;rows:Row[];tags:Tag[];nextCursor:string|null;tagsNextCursor:string|null};
type Setup={role:Role;vaultConfigured:boolean;spendingPaused:boolean;connections:{id:string;name:string;checkStatus:string}[];catalog:{updatedAt:string|null;markets:{locationCode:number;locationName:string;languageCode:string;languageName:string}[]}};
type Intent={path:string;body:Record<string,unknown>;message:string;closeForm?:boolean};
export type ResearchSaveSeed={key:string;runId:string;rowIndexes:number[];keywords:string[];locationCode:number;languageCode:string};
export type KeywordSelection={type:'ids';keywordIds:string[]}|{type:'filtered';filters:Record<string,unknown>};
const roleValue=(v:unknown):v is Role=>typeof v==='string'&&['owner','admin','editor','viewer'].includes(v);
const rec=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const time=(v:string|null)=>v?new Date(v).toLocaleString():'Not observed';
const number=(v:number|null|undefined)=>v==null?'Unavailable':v.toLocaleString();
const lines=(text:string)=>text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const colors=['slate','rose','amber','lime','emerald','sky','violet','fuchsia'];
function filtersOf(d:SavedKeywordFilterDraft){
  const result:Record<string,unknown>={search:d.search,includeTerms:lines(d.includeTerms),excludeTerms:lines(d.excludeTerms),tagIds:d.tagIds,metrics:d.metrics,sort:d.sort,order:d.order};
  for(const key of ['locationCode','minVolume','maxVolume','minDifficulty','maxDifficulty']as const)if(d[key]!==''){const n=Number(d[key]);if(!Number.isSafeInteger(n))throw new Error('Use whole numbers for location, volume and difficulty.');result[key]=n;}
  for(const key of ['languageCode','minCpcUsd','maxCpcUsd']as const)if(d[key]!=='')result[key]=d[key];
  return result;
}
const nullableText=(v:unknown)=>v===null||typeof v==='string';
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const nullableDate=(v:unknown)=>v===null||date(v);
const validTag=(t:unknown)=>rec(t)&&uuid(t.id)&&typeof t.name==='string'&&(t.color===null||colors.includes(String(t.color)));
function validList(d:unknown):d is List{
  return rec(d)&&roleValue(d.role)&&Number.isInteger(d.revision)&&typeof d.metricRevision==='string'&&Number.isSafeInteger(d.total)&&rec(d.filters)&&Array.isArray(d.tags)&&d.tags.every(validTag)&&Array.isArray(d.rows)&&d.rows.every(r=>rec(r)&&uuid(r.id)&&typeof r.keyword==='string'&&Number.isInteger(r.locationCode)&&typeof r.languageCode==='string'&&date(r.createdAt)&&date(r.updatedAt)&&Array.isArray(r.tags)&&r.tags.every(validTag)&&rec(r.metrics)&&['available','unavailable','expired'].includes(String(r.metrics.status))&&(r.metrics.status==='available'?isKeywordMetricRow(r.metrics.row):r.metrics.row===null)&&nullableText(r.metrics.source)&&nullableDate(r.metrics.fetchedAt)&&nullableDate(r.metrics.observedAt)&&rec(r.refresh)&&typeof r.refresh.eligible==='boolean'&&nullableText(r.refresh.reason)&&nullableText(r.refresh.lastAttemptStatus)&&nullableDate(r.refresh.lastAttemptAt))&&nullableText(d.nextCursor)&&nullableText(d.tagsNextCursor);
}

export function SavedKeywordsPanel({projectId,userId,active,seed,onUnauthorized,onLockChange}:{projectId:string;userId:string;active:boolean;seed:ResearchSaveSeed|null;onUnauthorized:()=>void;onLockChange:(locked:boolean)=>void}){
  return <Panel key={userId+':'+projectId} {...{projectId,active,seed,onUnauthorized,onLockChange}}/>;
}
function Panel({projectId,active,seed,onUnauthorized,onLockChange}:Omit<Parameters<typeof SavedKeywordsPanel>[0],'userId'>){
  const base='/api/projects/'+encodeURIComponent(projectId)+'/saved-keywords',uid=useId();
  const [data,setData]=useState<List|null>(null),[setup,setSetup]=useState<Setup|null>(null),[draft,setDraft]=useState(emptySavedKeywordFilters),[applied,setApplied]=useState<Record<string,unknown>>({});
  const [selected,setSelected]=useState<string[]>([]),[reading,setReading]=useState(false),[writing,setWriting]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [intent,setIntent]=useState<Intent|null>(null),[conflict,setConflict]=useState(false),[form,setForm]=useState<'manual'|'run'|null>(null),[dirty,setDirty]=useState(false);
  const [words,setWords]=useState(''),[location,setLocation]=useState(''),[language,setLanguage]=useState('en'),[tagText,setTagText]=useState(''),[tagMode,setTagMode]=useState<'append'|'replace'>('append');
  const [tagAction,setTagAction]=useState<'add'|'remove'|'replace'|'clear'>('add'),[removeTags,setRemoveTags]=useState<string[]>([]),[editTag,setEditTag]=useState<Tag|null>(null),[tagName,setTagName]=useState(''),[tagColor,setTagColor]=useState('');
  const [refreshSelection,setRefreshSelection]=useState<KeywordSelection|null>(null),[refreshLocked,setRefreshLocked]=useState(false),[refreshEpoch,setRefreshEpoch]=useState(0);
  const alive=useRef(false),epoch=useRef(0),readRef=useRef<AbortController|null>(null),writeRef=useRef<object|null>(null),intentRef=useRef<Intent|null>(null),seedRef=useRef<ResearchSaveSeed|null>(null),unauthorized=useRef(onUnauthorized),heading=useRef<HTMLHeadingElement|null>(null);
  unauthorized.current=onUnauthorized;
  const locked=writing||!!intent||refreshLocked;
  useEffect(()=>{onLockChange(locked||dirty);},[locked,dirty,onLockChange]);
  function stopRead(){epoch.current++;readRef.current?.abort();readRef.current=null;setReading(false);}
  function resetIntent(){intentRef.current=null;setIntent(null);}
  function fail(e:unknown){
    if(e instanceof ApiError&&[401,403,404].includes(e.status)){stopRead();setData(null);setSetup(null);setSelected([]);setWords('');setTagText('');setForm(null);setDirty(false);setEditTag(null);setRefreshSelection(null);setRefreshEpoch(n=>n+1);resetIntent();if(e.status===401)unauthorized.current();}
    if(e instanceof ApiError&&e.status===409)setConflict(true);
    setError(errMsg(e));
  }
  async function load(filters=applied,cursor?:string){
    if(writeRef.current||intentRef.current)return;stopRead();const generation=epoch.current,controller=new AbortController();readRef.current=controller;setReading(true);setError('');
    try{
      const [result,state]=await Promise.all([api<unknown>(base+'/list',{method:'POST',body:{filters,pageSize:50,...(cursor?{cursor}:{})},signal:controller.signal}),api<Setup>('/api/projects/'+projectId+'/keyword-research',{signal:controller.signal})]);
      if(!alive.current||controller.signal.aborted||generation!==epoch.current)return;
      if(!validList(result)||!roleValue(state?.role)||!Array.isArray(state.connections)||!Array.isArray(state.catalog?.markets))throw new Error('The saved keywords could not be read. Reload the list.');
      setData(old=>({...result,...(old&&old.revision===result.revision?{tags:old.tags,tagsNextCursor:old.tagsNextCursor}:{}),rows:cursor&&old?[...old.rows,...result.rows.filter(r=>!old.rows.some(p=>p.id===r.id))]:result.rows}));setSetup(state);setApplied(filters);setConflict(false);
      if(!cursor)setSelected([]);
      if(result.role==='viewer'){setForm(null);setEditTag(null);setDirty(false);setWords('');setTagText('');}
    }catch(e){if(alive.current&&!controller.signal.aborted&&generation===epoch.current)fail(e);}
    finally{if(alive.current&&generation===epoch.current){setReading(false);readRef.current=null;}}
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;readRef.current?.abort();};},[]);
  useEffect(()=>{if(active&&!data&&!writeRef.current&&!intentRef.current)void load();if(!active)stopRead();},[active]);
  useEffect(()=>{if(seed&&seed.key!==seedRef.current?.key){seedRef.current=seed;setForm('run');setWords(seed.keywords.join('\n'));setLocation(String(seed.locationCode));setLanguage(seed.languageCode);setTagText('');setDirty(true);setError('');setMessage('');queueMicrotask(()=>heading.current?.focus());}},[seed?.key]);
  useEffect(()=>{if(form&&data)heading.current?.focus();},[form,!!data]);
  async function mutate(pending:Intent){
    if(writeRef.current||!alive.current)return;stopRead();const token={},generation=epoch.current;writeRef.current=token;setWriting(true);setError('');setMessage('');let accepted=false;
    try{
      const result=await api<unknown>(pending.path,{method:'POST',body:pending.body});if(!alive.current||generation!==epoch.current)return;
      if(!rec(result)||!roleValue(result.role)||!Number.isInteger(result.revision)||typeof result.metricRevision!=='string'||typeof result.replayed!=='boolean'||!Array.isArray(result.ids)||!result.ids.every(uuid)||!Array.isArray(result.missingIds)||!result.missingIds.every(uuid)||!['inserted','existing','skippedOlder','metricsUpdated','affected'].every(key=>Number.isSafeInteger(result[key])&&Number(result[key])>=0))throw new Error('The save acknowledgement was incomplete.');
      resetIntent();setConflict(false);setDirty(false);setEditTag(null);if(pending.closeForm)setForm(null);setMessage((result.replayed?'The original request was confirmed. The current list is shown below.':pending.message)+(result.missingIds.length?` ${result.missingIds.length} keywords have since been removed.`:'')+(Number(result.skippedOlder)>0?` ${result.skippedOlder} older observations did not replace newer metrics.`:''));accepted=true;
    }catch(e){if(alive.current&&generation===epoch.current){if(!(e instanceof ApiError)||e.status===0||e.status>=500)setError(errMsg(e)+' The outcome is unknown. Retry the same request to confirm it.');else{resetIntent();fail(e);}}}
    finally{if(writeRef.current===token){writeRef.current=null;if(alive.current)setWriting(false);}}
    if(accepted&&alive.current)void load();
  }
  function change(path:string,body:Record<string,unknown>,message:string,closeForm=false){
    if(locked||!data||data.role==='viewer'||conflict)return;
    const pending={path:base+path,body:{...body,requestId:crypto.randomUUID(),revision:data.revision},message,closeForm};intentRef.current=pending;setIntent(pending);void mutate(pending);
  }
  function leaveForm(){if(locked)return;if(dirty&&!window.confirm('Discard your unsaved keyword changes?'))return;setForm(null);setEditTag(null);setDirty(false);setTagText('');setError('');}
  function addManual(){if(locked||dirty)return;setForm('manual');setWords('');setLocation('');setLanguage('en');setTagText('');setTagMode('append');setError('');queueMicrotask(()=>heading.current?.focus());}
  function save(e:FormEvent){e.preventDefault();if(!form)return;const source=form==='run'&&seedRef.current?{type:'run',runId:seedRef.current.runId,rowIndexes:seedRef.current.rowIndexes}:{type:'manual',keywords:lines(words),locationCode:Number(location),languageCode:language};change('',{source,tags:lines(tagText),tagMode},'Keywords saved.',true);}
  function bulkTags(e:FormEvent){e.preventDefault();change('/bulk-tags',{keywordIds:selected,operation:tagAction,...(tagAction==='remove'?{tagIds:removeTags}:tagAction==='clear'?{}:{tags:lines(tagText)})},'Keyword tags updated.');}
  function remove(){if(window.confirm(`Remove ${selected.length} saved keywords? Their research runs and provider charges remain available.`))change('/remove',{keywordIds:selected},'Saved keywords removed.');}
  function apply(e?:FormEvent){e?.preventDefault();if(locked)return;try{setRefreshSelection(null);void load(filtersOf(draft));}catch(e){setError(errMsg(e));}}
  const selection:KeywordSelection=selected.length?{type:'ids',keywordIds:selected}:{type:'filtered',filters:applied};
  async function moreTags(){
    if(locked||!data?.tagsNextCursor)return;stopRead();const generation=epoch.current,controller=new AbortController();readRef.current=controller;setReading(true);setError('');
    try{const result=await api<{role:Role;revision:number;metricRevision:string;tags:Tag[];nextCursor:string|null}>(base+'/tags/list',{method:'POST',body:{cursor:data.tagsNextCursor},signal:controller.signal});if(!alive.current||controller.signal.aborted||generation!==epoch.current)return;if(!roleValue(result?.role)||result.revision!==data.revision||!Array.isArray(result.tags)||!result.tags.every(validTag)||!nullableText(result.nextCursor))throw new Error('Tag options changed. Reload the list.');setData(old=>old?{...old,role:result.role,tags:[...old.tags,...result.tags.filter(t=>!old.tags.some(prior=>prior.id===t.id))],tagsNextCursor:result.nextCursor}:old);}
    catch(e){if(alive.current&&!controller.signal.aborted&&generation===epoch.current)fail(e);}finally{if(alive.current&&generation===epoch.current){setReading(false);readRef.current=null;}}
  }
  async function exportFile(format:'csv'|'tsv',copy=false){
    if(locked)return;stopRead();const generation=epoch.current,controller=new AbortController();readRef.current=controller;setReading(true);setError('');
    try{
      const response=await fetch(base+'/export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({selection,format}),signal:controller.signal});
      if(!response.ok){const result=await response.json().catch(()=>null);const e=new ApiError(typeof result?.error==='string'?result.error:'Export failed. Try again.');e.status=response.status;throw e;}
      const text=await response.text();if(!alive.current||generation!==epoch.current||controller.signal.aborted)return;
      const count=response.headers.get('x-export-row-count');if(!/^\d+$/.test(count??'')||!response.headers.get('content-type')?.startsWith(format==='csv'?'text/csv':'text/tab-separated-values'))throw new Error('The export response was incomplete. Try again.');
      if(copy){await navigator.clipboard.writeText(text);if(alive.current&&generation===epoch.current)setMessage(`${count} rows copied for a spreadsheet.`);}
      else{const url=URL.createObjectURL(new Blob([text],{type:response.headers.get('content-type')!})),a=document.createElement('a');a.href=url;a.download='saved-keywords.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage(`${count} rows exported.`);}
    }catch(e){if(alive.current&&!controller.signal.aborted&&generation===epoch.current)fail(e);}
    finally{if(alive.current&&generation===epoch.current){setReading(false);readRef.current=null;}}
  }
  const canWrite=data&&data.role!=='viewer',tags=data?.tags??[],markets=setup?.catalog.markets??[];
  return <section className="research-panel saved-keywords stack" aria-label="Saved keywords" aria-busy={reading||writing}>
    <div className="row between"><div><h2>Saved keywords</h2><p className="dim">Keep your research shortlist, markets and tags together.</p></div><div className="row"><button className="btn ghost" disabled={locked} onClick={()=>void load()}>Reload list</button>{canWrite&&<button className="btn primary" disabled={locked||dirty} onClick={addManual}>Add keywords</button>}</div></div>
    {error&&<div className="alert" role="alert">{error}</div>}{message&&<p role="status">{message}</p>}
    {intent&&<div className="notice"><p>{writing?'Saving changes…':'The previous request may have been accepted. Retrying confirms that same request.'}</p><button className="btn" disabled={writing} onClick={()=>void mutate(intentRef.current!)}>Retry same request</button></div>}
    {conflict&&<p className="notice">The list changed. Reload it to review the current state before saving again. Your draft is retained.</p>}
    {!data?<p className="dim">{reading?'Loading saved keywords…':'Reload the list to continue.'}</p>:<>
      {form&&canWrite&&<form className="card stack" onSubmit={save} aria-label="Save keywords"><h3 ref={heading} tabIndex={-1}>{form==='run'?`Save ${seedRef.current?.rowIndexes.length??0} research keywords`:'Add keywords'}</h3>
        <fieldset className="saved-keyword-fields" disabled={locked||conflict}><legend>Keywords and market</legend>
          {form==='run'?<><p>The selected research result supplies the market and observed metrics. Saving starts no paid work.</p><details><summary>Selected keywords</summary><ul>{seedRef.current?.keywords.map((k,i)=><li key={i}>{k}</li>)}</ul></details><p>Location {location} · {language}</p><button type="button" className="btn ghost" onClick={()=>setForm('manual')}>Save manually without metrics</button></>:<>
            <label htmlFor={uid+'words'}>Keywords, one per line</label><textarea id={uid+'words'} rows={6} maxLength={250500} required value={words} onChange={e=>{setWords(e.target.value);setDirty(true);}}/><p className="hint">Up to 500 per save. Saved text may be longer than the metric provider supports.</p>
            {markets.length>0&&<div className="field"><label htmlFor={uid+'market'}>Choose a market</label><select id={uid+'market'} value={markets.some(m=>String(m.locationCode)===location&&m.languageCode===language)?location+'|'+language:''} onChange={e=>{if(e.target.value){const [loc,lang]=e.target.value.split('|');setLocation(loc);setLanguage(lang);setDirty(true);}}}><option value="">Enter location and language below</option>{markets.map(m=><option key={m.locationCode+'|'+m.languageCode} value={m.locationCode+'|'+m.languageCode}>{m.locationName} / {m.languageName}</option>)}</select></div>}
            <div className="saved-keyword-filter-grid"><div className="field"><label htmlFor={uid+'location'}>Location code</label><input id={uid+'location'} type="number" min={1} max={2147483647} step={1} required value={location} onChange={e=>{setLocation(e.target.value);setDirty(true);}}/></div><div className="field"><label htmlFor={uid+'language'}>Language code</label><input id={uid+'language'} maxLength={6} required placeholder="en or en-US" value={language} onChange={e=>{setLanguage(e.target.value);setDirty(true);}}/></div></div><p className="hint">Use a DataForSEO location code, such as 2840 for United States. A provider connection is only needed when refreshing metrics.</p>
          </>}
          <div className="field"><label htmlFor={uid+'save-tags'}>Tags, one per line (optional)</label><textarea id={uid+'save-tags'} rows={2} value={tagText} onChange={e=>{setTagText(e.target.value);setDirty(true);}} maxLength={1300}/></div>
          <div className="field"><label htmlFor={uid+'tag-mode'}>For keywords already saved</label><select id={uid+'tag-mode'} value={tagMode} onChange={e=>{setTagMode(e.target.value as typeof tagMode);setDirty(true);}}><option value="append">Keep existing tags and add these</option><option value="replace">Replace tags with these</option></select></div>
          <button className="btn primary" type="submit">Save keywords</button>
        </fieldset><button type="button" className="btn ghost" disabled={locked} onClick={leaveForm}>Cancel</button>
      </form>}
      <form onSubmit={apply} className="card stack"><SavedKeywordFilterFields value={draft} onChange={setDraft} tags={tags} disabled={locked} prefix={uid+'filter'}/>{data.tagsNextCursor&&<button type="button" className="btn ghost" disabled={locked||reading} onClick={()=>void moreTags()}>Load more project tags</button>}<div className="row"><button type="submit" className="btn" disabled={locked}>Apply filters</button><button type="button" className="btn ghost" disabled={locked} onClick={()=>{setDraft(emptySavedKeywordFilters());setRefreshSelection(null);void load({});}}>Reset filters</button></div></form>
      <div className="card stack"><div className="row between"><h3>{data.total.toLocaleString()} matching keywords</h3><span className="dim">{selected.length?`${selected.length} selected`:'No selection · actions use all matching keywords'}</span></div>
        <div className="row"><button className="btn" disabled={locked||data.total===0} onClick={()=>void exportFile('csv')}>Export {selected.length?'selected':'all matching'} CSV</button><button className="btn" disabled={locked||data.total===0} onClick={()=>void exportFile('tsv')}>Export TSV</button><button className="btn ghost" disabled={locked||data.total===0} onClick={()=>void exportFile('tsv',true)}>Copy for spreadsheet</button>{canWrite&&<button className="btn primary" disabled={locked||dirty||data.total===0} onClick={()=>{stopRead();setRefreshSelection(structuredClone(selection));}}>Refresh {selected.length?'selected':'all matching'} metrics</button>}</div>
        {data.rows.length===0?<div className="empty"><strong>{Object.keys(applied).length?'No keywords match these filters.':'Your keyword list starts here.'}</strong><p>{Object.keys(applied).length?'Adjust the filters or reset them to see your saved keywords.':'Save research results or add your own keywords. Metrics stay unavailable until observed.'}</p></div>:<>
          <div className="row"><button className="btn ghost" disabled={locked} onClick={()=>setSelected(data.rows.map(r=>r.id).slice(0,2000))}>Select {Math.min(data.rows.length,2000)} loaded keywords</button><button className="btn ghost" disabled={locked||!selected.length} onClick={()=>setSelected([])}>Clear selection</button></div>
          <div className="table-wrap" role="region" aria-label="Saved keyword table" tabIndex={0}><table><thead><tr><th>Select</th><th>Keyword / market</th><th>Monthly volume</th><th>CPC (USD)</th><th>Competition</th><th>Difficulty</th><th>Tags</th><th>Observed metrics</th></tr></thead><tbody>{data.rows.map(row=><tr key={row.id}><td><input type="checkbox" aria-label={`Select ${row.keyword}, ${row.locationCode} ${row.languageCode}`} checked={selected.includes(row.id)} disabled={locked||!selected.includes(row.id)&&selected.length>=2000} onChange={e=>setSelected(ids=>e.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/></td><td><strong>{row.keyword}</strong><p className="hint">{markets.find(m=>m.locationCode===row.locationCode&&m.languageCode===row.languageCode)?.locationName??row.locationCode} · {row.languageCode}</p>{!row.refresh.eligible&&<p className="hint">{row.refresh.reason}</p>}</td><td>{number(row.metrics.row?.searchVolume)}</td><td>{row.metrics.row?.cpcUsd==null?'Unavailable':'$'+row.metrics.row.cpcUsd}</td><td>{number(row.metrics.row?.competition)}</td><td>{number(row.metrics.row?.keywordDifficulty)}</td><td>{row.tags.length?row.tags.map(t=><span className={'saved-keyword-tag tag-'+(colors.includes(t.color??'')?t.color:'slate')} key={t.id}>{t.name}</span>):'No tags'}</td><td>{row.metrics.status==='available'?time(row.metrics.fetchedAt):row.metrics.status==='expired'?'Expired':'Not observed'}{row.metrics.row&&<details><summary>Details and history</summary><p>{row.metrics.source} · provider keyword: {row.metrics.row.keyword}</p><p>Intent: {row.metrics.row.intent??'Unavailable'} · metrics updated {time(row.metrics.row.metricsUpdatedAt)}</p>{row.metrics.row.monthlySearches.length>0&&<ul>{row.metrics.row.monthlySearches.map(m=><li key={m.year+'-'+m.month}>{m.year}-{String(m.month).padStart(2,'0')}: {number(m.searchVolume)}</li>)}</ul>}</details>}{row.refresh.lastAttemptStatus&&<p className="hint">Last refresh: {row.refresh.lastAttemptStatus} · {time(row.refresh.lastAttemptAt)}</p>}</td></tr>)}</tbody></table></div>
          {data.nextCursor&&<button className="btn" disabled={locked||reading} onClick={()=>void load(applied,data.nextCursor!)}>Load more keywords</button>}
        </>}
        {canWrite&&selected.length>0&&<details><summary>Manage {selected.length} selected keywords</summary><form className="stack" onSubmit={bulkTags}><fieldset className="saved-keyword-fields" disabled={locked||conflict||!!form||!!editTag}><legend>Update tags</legend><label htmlFor={uid+'bulk'}>Tag action</label><select id={uid+'bulk'} value={tagAction} onChange={e=>setTagAction(e.target.value as typeof tagAction)}><option value="add">Add tags</option><option value="replace">Replace all tags</option><option value="remove">Remove chosen tags</option><option value="clear">Clear all tags</option></select>{tagAction==='remove'?<fieldset><legend>Tags to remove</legend>{tags.map(t=><label className="row" key={t.id}><input type="checkbox" checked={removeTags.includes(t.id)} onChange={e=>setRemoveTags(ids=>e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{t.name}</label>)}</fieldset>:tagAction!=='clear'?<><label htmlFor={uid+'bulktext'}>Tags, one per line</label><textarea id={uid+'bulktext'} rows={2} maxLength={1300} required value={tagText} onChange={e=>setTagText(e.target.value)}/></>:<p>All tags will be detached from these keywords.</p>}<div className="row"><button className="btn" type="submit">Apply tag action</button><button className="btn danger" type="button" onClick={remove}>Remove selected keywords</button></div></fieldset></form></details>}
      </div>
      {canWrite&&tags.length>0&&<details className="card"><summary>Manage project tags</summary><div className="stack">{tags.map(t=><div key={t.id} className="row between"><span>{t.name}</span><div className="row"><button className="btn ghost" disabled={locked||dirty} onClick={()=>{setEditTag(t);setTagName(t.name);setTagColor(t.color??'');setDirty(true);}}>Edit {t.name}</button><button className="btn ghost" disabled={locked||dirty||conflict} onClick={()=>{if(window.confirm(`Delete tag “${t.name}”? It must be detached from all keywords first.`))change('/tags/'+t.id+'/delete',{},'Tag deleted.');}}>Delete {t.name}</button></div></div>)}{editTag&&<form className="stack" onSubmit={e=>{e.preventDefault();change('/tags/'+editTag.id+'/update',{name:tagName,color:tagColor||null},'Tag updated.');}}><fieldset className="saved-keyword-fields" disabled={locked||conflict}><legend>Edit tag</legend><label htmlFor={uid+'tagname'}>Tag name</label><input id={uid+'tagname'} maxLength={64} required value={tagName} onChange={e=>setTagName(e.target.value)}/><label htmlFor={uid+'tagcolor'}>Tag color</label><select id={uid+'tagcolor'} value={tagColor} onChange={e=>setTagColor(e.target.value)}><option value="">Default</option>{colors.map(c=><option key={c}>{c}</option>)}</select><button className="btn primary">Save tag</button></fieldset><button className="btn ghost" type="button" disabled={locked} onClick={leaveForm}>Cancel tag edit</button></form>}</div></details>}
      {setup&&<SavedKeywordRefreshPanel key={refreshEpoch} {...{projectId,active,selection:refreshSelection,setup,onUnauthorized}} onLockChange={setRefreshLocked} onDone={()=>{setRefreshSelection(null);void load();}} onRoleLost={fail}/>}
    </>}
  </section>;
}
