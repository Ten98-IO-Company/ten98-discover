import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ApiError,errMsg} from '../lib/api';
import {analyticsFieldLimit} from '../lib/analytics-dimensions';
import {buildUtmParams,utmFields,utmFilterFields,validUtmResult,type UtmField} from '../lib/utm-report';
import {buildParams,initialDraft,TIMEZONES,FILTERS,labelOf,type Draft} from './ExplorerFilters';
import {readCombination,validReportBase,validCohortResult,PropertyShares,type ExploreResult} from './ExplorerPanel';

type Panel={phase:'idle'|'loading'|'error'|'ready';result?:ExploreResult;params?:string;error?:string};
type Panels=Record<UtmField,Panel>;
const emptyPanels=():Panels=>Object.fromEntries(utmFields.map(([field])=>[field,{phase:'idle'}])) as Panels;
const firstDraft=():Draft=>({...initialDraft(),kind:'pageviews',groupBy:'campaignSource'});

export function UtmPanel({projectId,userId,onUnauthorized}:{projectId:string;userId:string;onUnauthorized:()=>void}){
  const uid=useId(),[draft,setDraft]=useState(firstDraft),[panels,setPanels]=useState(emptyPanels),[applied,setApplied]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[denied,setDenied]=useState(false);
  const identity=projectId+':'+userId,[scopeIdentity,setScopeIdentity]=useState(identity),live=useRef({identity,onUnauthorized}),mounted=useRef(false),generation=useRef(0),operation=useRef<AbortController|null>(null),blocked=useRef(false);
  live.current={identity,onUnauthorized};
  useEffect(()=>{
    mounted.current=true;generation.current++;operation.current?.abort();blocked.current=false;setScopeIdentity(identity);setDraft(firstDraft());setPanels(emptyPanels());setApplied('');setError('');setDenied(false);
    return()=>{mounted.current=false;generation.current++;operation.current?.abort();};
  },[identity]);
  const patch=(value:Partial<Draft>)=>{
    generation.current++;operation.current?.abort();setDraft(old=>({...old,...value}));setError('');
    setPanels(old=>Object.fromEntries(utmFields.map(([field])=>[field,old[field].phase==='loading'?{phase:'idle'}:old[field]])) as Panels);
  };
  const scope=buildParams(draft),unapplied=!!applied&&('error'in scope||scope.qs!==applied);
  async function load(fields:readonly UtmField[],qs:string,reauthorize=false){
    if(operation.current||!mounted.current||live.current.identity!==identity||blocked.current&&!reauthorize)return;
    const controller=new AbortController(),token=++generation.current,owner=identity;operation.current=controller;blocked.current=false;setDenied(false);setBusy(true);setError('');
    const current=()=>mounted.current&&live.current.identity===owner&&generation.current===token&&!controller.signal.aborted&&!blocked.current;
    setPanels(old=>({...old,...Object.fromEntries(fields.map(field=>[field,{phase:'loading'}]))}));
    let next=0;
    const worker=async()=>{while(current()&&next<fields.length){
      const field=fields[next++];
      try{
        const params=buildUtmParams(new URLSearchParams(qs),field),result=await readCombination(`/api/projects/${projectId}/explore?${params}`,controller.signal);
        if(!current())return;
        if(!validUtmResult(result,params)||!validReportBase(result,params)||!validCohortResult(result,params,projectId))throw new Error('This campaign report could not be verified. Retry this panel.');
        if(current())setPanels(old=>({...old,[field]:{phase:'ready',result,params:params.toString()}}));
      }catch(cause){
        // Authority outranks any held success, even when the user has since edited this draft.
        if(cause instanceof ApiError&&[401,403,404].includes(cause.status)&&mounted.current&&live.current.identity===owner){
          blocked.current=true;generation.current++;controller.abort();setPanels(emptyPanels());setApplied('');setDenied(true);setError(cause.status===401?'Your session expired. Sign in again.':'Project access changed. All campaign results were cleared. Explicitly reload access to try again.');
          if(cause.status===401)live.current.onUnauthorized();return;
        }
        if(current())setPanels(old=>({...old,[field]:{phase:'error',error:errMsg(cause)}}));
      }
    }};
    try{await Promise.all(Array.from({length:Math.min(2,fields.length)},worker));}
    finally{if(operation.current===controller){operation.current=null;if(mounted.current)setBusy(false);}}
  }
  function apply(event:FormEvent){
    event.preventDefault();if(operation.current)return;
    if('error'in scope){setError(scope.error);return;}
    try{buildUtmParams(new URLSearchParams(scope.qs),'campaignSource');}catch(cause){setError(errMsg(cause));return;}
    setScopeIdentity(identity);setApplied(scope.qs);setPanels(emptyPanels());void load(utmFields.map(([field])=>field),scope.qs,true);
  }
  function download(field:UtmField,panel:Panel){
    if(scopeIdentity!==identity||blocked.current||!panel.result||!panel.params)return;
    let url:string|undefined;
    try{url=URL.createObjectURL(new Blob([panel.result.csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`utm-${field}-${panel.result.range.from}-${panel.result.range.to}.csv`;link.click();}
    catch(cause){setError(errMsg(cause));}
    finally{if(url)URL.revokeObjectURL(url);}
  }
  const visible=scopeIdentity===identity?panels:emptyPanels(),appliedParams=new URLSearchParams(scopeIdentity===identity?applied:'');
  return <section className="stack utm-report" aria-label="UTM reports">
    <div><h2>UTM reports</h2><p className="hint">Compare recorded campaign tags across pageviews. Each panel counts only pageviews with a nonempty value for that field; the five populations overlap.</p></div>
    <form className="card stack" onSubmit={apply} aria-label="UTM report scope">
      <div className="explorer-toolbar utm-toolbar">
        <div><label htmlFor={`${uid}-from`}>From</label><input id={`${uid}-from`} type="date" required max={draft.to} value={draft.from} onChange={e=>patch({from:e.target.value})}/></div>
        <div><label htmlFor={`${uid}-to`}>To</label><input id={`${uid}-to`} type="date" required min={draft.from} value={draft.to} onChange={e=>patch({to:e.target.value})}/></div>
        <div><label htmlFor={`${uid}-zone`}>Time zone</label><input id={`${uid}-zone`} required list={`${uid}-zones`} value={draft.timeZone} onChange={e=>patch({timeZone:e.target.value})}/><datalist id={`${uid}-zones`}>{TIMEZONES.map(zone=><option key={zone} value={zone}/>)}</datalist></div>
      </div>
      <details><summary>Exact filters</summary><div className="stack"><p className="hint">Enabled filters must all match. Origin must be an exact HTTP(S) origin without a path. Other blank enabled values match an empty stored value; each panel still requires its own nonempty tag.</p>{utmFilterFields.map(field=><div className="row" key={field}><label className="row"><input type="checkbox" checked={draft.filters[field].on} onChange={e=>patch({filters:{...draft.filters,[field]:{...draft.filters[field],on:e.target.checked}}})}/>Enable {labelOf(FILTERS,field)}</label><div style={{minWidth:0,flex:'1 1 180px'}}><label htmlFor={`${uid}-${field}`}>{labelOf(FILTERS,field)} equals</label><input id={`${uid}-${field}`} disabled={!draft.filters[field].on} maxLength={analyticsFieldLimit(field)} value={draft.filters[field].value} onChange={e=>patch({filters:{...draft.filters,[field]:{...draft.filters[field],value:e.target.value}}})}/></div></div>)}</div></details>
      <div className="row"><button className="btn primary" type="submit" disabled={busy}>{busy?'Loading reports…':denied?'Reload access and apply':applied&&!unapplied?'Refresh reports':'Apply reports'}</button></div>
      {error&&<p className="alert" role="alert">{error}</p>}{unapplied&&<p className="hint" role="status">Unapplied changes. Results and CSV still describe the applied scope below.</p>}
    </form>
    {appliedParams.has('from')&&<div className="card stack" aria-label="Applied UTM scope"><h3>Applied scope</h3><p>{appliedParams.get('from')} to {appliedParams.get('to')} · {appliedParams.get('timeZone')} · Pageviews</p>{utmFilterFields.filter(field=>appliedParams.has(field)).map(field=><p className="hint" key={field}>{labelOf(FILTERS,field)} equals <bdi>{JSON.stringify(appliedParams.get(field))}</bdi></p>)}<p className="hint">Five independent native report snapshots, with the same dates and exact filters. Shares use each field’s full observed tagged-pageview total, including values omitted from its top100 table; they are not shares of all traffic or visitors.</p></div>}
    <div className="utm-panels">{utmFields.map(([field,label])=>{
      const panel=visible[field],result=panel.result,total=result?.totals.pageViews,rows=result?.breakdown.groups??[];
      return <section key={field} className="card stack utm-panel" aria-labelledby={`${uid}-${field}-heading`} aria-busy={panel.phase==='loading'}>
        <h3 id={`${uid}-${field}-heading`}>{label}</h3>
        {panel.phase==='idle'&&<p className="hint">Apply reports to read this campaign field.</p>}
        {panel.phase==='loading'&&<p role="status">Loading {label.toLowerCase()}…</p>}
        {panel.phase==='error'&&<><p className="alert" role="alert">{panel.error}</p><button className="btn" type="button" disabled={busy||denied} onClick={()=>void load([field],applied)}>Retry {label.toLowerCase()}</button></>}
        {panel.phase==='ready'&&result&&<>
          <p><strong>{total===null?'Unavailable':total} {total===null?'':'tagged pageviews'}</strong></p>
          {result.coverage.status!=='complete'&&<p className="banner" role="status">{result.coverage.status==='unavailable'?'This history is no longer retained. Unavailable is not zero; choose a more recent range.':'Partial retained history. Counts and shares describe only observed tagged pageviews, not the missing history.'}</p>}
          <p className="hint">{result.range.from} to {result.range.to} · {result.range.timeZone}. {result.coverage.retainedFrom?`Retained from ${result.coverage.retainedFrom}.`:'No retention boundary.'}</p>
          {total!==null&&total===0&&<p className="hint">No retained pageviews match these filters with a nonempty {label.toLowerCase()} tag.</p>}
          {total!==null&&total!==undefined&&total>0&&<><PropertyShares items={rows.map(row=>({key:JSON.stringify(['utm',row.value]),label:row.value as string,count:row.events}))} total={total} label={`${label} tagged-pageview shares`} noun="tagged pageviews"/>
            <p className="hint">Showing all {rows.length} returned values of {result.breakdown.totalGroups}. {result.breakdown.truncated?`${total-result.breakdown.returnedGroupEvents!} tagged pageviews across ${result.breakdown.totalGroups!-rows.length} other values are omitted from the exact table and CSV breakdown.`:'No matching values were omitted.'} The ring combines smaller returned values; the exact table below does not.</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label={`${label} exact values`}><table><thead><tr><th>{label}</th><th>Tagged pageviews</th><th>Share of tagged pageviews</th></tr></thead><tbody>{rows.map(row=><tr key={row.value as string}><td><bdi>{row.value as string}</bdi></td><td>{row.events}</td><td>{(row.events/total*100).toFixed(1)}%</td></tr>)}</tbody></table></div>
          </>}
          <button className="btn" type="button" onClick={()=>download(field,panel)}>Download {label.toLowerCase()} CSV</button>
          <p className="hint dim">Downloads this exact applied native snapshot, including its bounded breakdown, daily rows and scope.</p>
        </>}
      </section>;
    })}</div>
  </section>;
}
