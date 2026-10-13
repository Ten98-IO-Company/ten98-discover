import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
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
const GROUPS=[['event','Event name'],['path','Path'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content'],['screenWidth','Screen width'],['screenHeight','Screen height'],['property','Property']] as const;
const FILTERS=[['eventName','Event name'],['path','Path'],['referrer','Referrer'],['language','Language'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content']] as const;
const PROP_TYPES=['missing','string','number','boolean','null','date','array'] as const;
const TIMEZONES=['UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/London','Europe/Berlin','Asia/Dubai','Asia/Tokyo','Australia/Sydney'];

const utcDate=(d:Date)=>d.toISOString().slice(0,10);
const labelOf=(list:readonly (readonly [string,string])[],v:string)=>list.find(([k])=>k===v)?.[1]??v;
const num=(v:number|null)=>v==null?'Unavailable':String(v);

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

  useEffect(()=>{
    const ctrl=new AbortController();
    setResult(null);setPhase('loading');setMessage('');
    api<ExploreResult>(`/api/projects/${encodeURIComponent(projectId)}/explore?${applied}`,{signal:ctrl.signal})
      .then(r=>{if(!ctrl.signal.aborted){setResult(r);setPhase('ok');}})
      .catch(e=>{
        if(ctrl.signal.aborted)return;
        setResult(null);
        if(e instanceof ApiError&&e.status===401){
          setDraft(initialDraft());setFormError('');
          setPhase('denied');setMessage('Your session has ended. Sign in again to continue.');
          unauthRef.current();
        }else if(e instanceof ApiError&&(e.status===403||e.status===404)){
          setDraft(initialDraft());setFormError('');
          setPhase('unavailable');setMessage('This project is unavailable. It may have been removed or you may not have access.');
        }else{
          setPhase('error');setMessage(`Couldn't load explore data. ${errMsg(e)}`);
        }
      });
    return()=>ctrl.abort();
  },[applied,attempt,projectId]);

  const refresh=()=>{setResult(null);setPhase('loading');setMessage('');setAttempt(a=>a+1);};

  const apply=(e:FormEvent)=>{
    e.preventDefault();
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

  return(
    <section className="explorer stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Explore</h2>

      <form className="card stack" onSubmit={apply}>
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
        {formError&&<p className="alert" role="alert">{formError}</p>}
        {phase==='ok'&&result&&<p className="hint dim">CSV downloads the current bounded table, daily data and scope — it is not a complete data export.</p>}
      </form>

      <p role="status" aria-live="polite" className={phase==='loading'||phase==='ok'?'hint dim':'alert'}>
        {phase==='loading'?'Loading explore data…':message}
      </p>
      {(phase==='error'||phase==='unavailable')&&<button className="btn" type="button" onClick={refresh}>Retry</button>}

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
                  <td>{result.numeric.sum??'Unavailable'}</td>
                  <td>{result.numeric.average??'Unavailable'}</td>
                  <td>{result.numeric.min??'Unavailable'}</td>
                  <td>{result.numeric.max??'Unavailable'}</td>
                </tr></tbody>
              </table>
            </div>
          </div>
        )}
      </>)}
    </section>
  );
}
