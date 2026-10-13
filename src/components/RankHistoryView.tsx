import type * as React from 'react';

export type RankObservationFilters={device:'both'|'desktop'|'mobile';search:string;pinned:'all'|'true'|'false'};
export type RankBaselineDisplay={days:1|7|30|90;change:string;source:string;targetAt:string;observedAt:string;position:string};
export type RankLatestDisplay={id:string;keywordId:string;keyword:string;device:string;pinned:boolean;attempt:string;observation:string;coverage:string;observedAt:string;availability:string;baselines:readonly RankBaselineDisplay[]};
export type RankObservationDisplay={id:string;runId:string;device:string;attemptedAt:string;observedAt:string;retrievedAt:string;outcome:string;position:string;coverage:string;target:string;compatibility:string;scope:string;availability:string;rankingUrl:string|null;diagnostic:string|null};
export type RankHistoryViewProps={
 prefix:string;backLabel?:'Back to tracker'|'Back to reporting';role:'owner'|'admin'|'editor'|'viewer'|null;phase:'latest'|'keyword';reading:boolean;loaded:boolean;error:string;
 target:string;enabledDevices:string;asOf:string;filters:RankObservationFilters;filterDirty:boolean;appliedFilters:string;
 latest:readonly RankLatestDisplay[];keyword:string;removed:boolean;observations:readonly RankObservationDisplay[];nextCursor:string|null;
 onFilters:(value:RankObservationFilters)=>void;onApply:()=>void;onRefresh:()=>void;onMore:()=>void;onBack:()=>void;onLatest:()=>void;
 onKeyword:(id:string)=>void;onRun:(id:string)=>void;
};

function Cell({b}:{b:RankBaselineDisplay}):React.JSX.Element{
  return <td><div>{b.change}</div><div className="hint">{b.position}</div><div className="hint">{b.source}</div>
    <div className="hint">{'Target '+b.targetAt}</div><div className="hint">{'Observed '+b.observedAt}</div></td>;
}

function DeviceField({id,value,onChange}:{id:string;value:string;onChange:(v:RankObservationFilters['device'])=>void}):React.JSX.Element{
  return <div className="field"><label htmlFor={id}>Device</label>
    <select id={id} value={value} onChange={e=>onChange(e.target.value as RankObservationFilters['device'])}>
      <option value="both">Both devices</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option>
    </select></div>;
}

function Scope({target,devices,asOf}:{target:string;devices:string;asOf?:string}):React.JSX.Element{
  return <div className="stack" style={{gap:'var(--space-1)'}}><p>{target}</p><p className="dim">{'Enabled devices: '+devices}</p>
    {asOf!==undefined&&<p className="dim">{'Results as of: '+asOf}</p>}</div>;
}

export function RankHistoryView(p:RankHistoryViewProps):React.JSX.Element{
  const hid=p.prefix+'history-heading';
  const latest=p.phase==='latest';
  const submit=(e:React.FormEvent)=>{e.preventDefault();p.onApply();};
  const moreOff=p.reading||p.filterDirty;
  const back=<button type="button" className="btn ghost" onClick={p.onBack}>{p.backLabel??'Back to tracker'}</button>;
  if(p.role===null){
    return <section className="research-panel stack" style={{'--control-md':'var(--control-touch)',display:'grid',gap:'var(--space-3)'} as React.CSSProperties}>
      <div className="row between" style={{flexWrap:'wrap'}}>{back}</div>
      {p.error!==''&&<p role="alert" className="alert">{p.error}</p>}
      {p.reading?<p role="status">Loading rank observations…</p>:<>
        <p>Rank observations are unavailable. Reload access or return to the tracker.</p>
        <div className="row"><button type="button" className="btn primary" onClick={p.onRefresh}>Reload access</button></div>
      </>}
    </section>;
  }
  return <section className="research-panel stack" style={{'--control-md':'var(--control-touch)',display:'grid',gap:'var(--space-3)'} as React.CSSProperties}>
    <div className="row between" style={{flexWrap:'wrap',gap:'var(--space-3)'}}>
      <h2 id={hid} tabIndex={-1} style={{margin:0,fontSize:'var(--text-lg)',minWidth:0}}>{latest?'Latest rank observations':'Keyword rank history'}</h2>
      <span className="row" style={{flexWrap:'wrap'}}>{back}
        {latest?<button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh observations</button>:<>
          <button type="button" className="btn ghost" onClick={p.onLatest}>Latest observations</button>
          <button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh history</button>
        </>}
      </span>
    </div>
    {p.error!==''&&<p role="alert" className="alert">{p.error}</p>}
    {p.reading&&<p role="status">Loading rank observations…</p>}
    {latest?<>
      <Scope target={p.target} devices={p.enabledDevices} asOf={p.asOf}/>
      <p className="dim">{p.appliedFilters}</p>
      {p.filterDirty&&<p className="hint">Apply filters to update these observations.</p>}
      <details key="latest-filters"><summary>Observation filters</summary>
        <form className="stack" onSubmit={submit}>
          <div className="row" style={{flexWrap:'wrap'}}>
            <DeviceField id={p.prefix+'device'} value={p.filters.device} onChange={v=>p.onFilters({...p.filters,device:v})}/>
            <label className="field">Keyword contains
              <input value={p.filters.search} maxLength={200} onChange={e=>p.onFilters({...p.filters,search:e.target.value})}/></label>
            <div className="field"><label htmlFor={p.prefix+'pinned'}>Pinned keywords</label>
              <select id={p.prefix+'pinned'} value={p.filters.pinned} onChange={e=>p.onFilters({...p.filters,pinned:e.target.value as RankObservationFilters['pinned']})}>
                <option value="all">All keywords</option><option value="true">Pinned</option><option value="false">Unpinned</option>
              </select></div>
          </div>
          <div className="row">
            <button type="submit" className="btn primary">Apply filters</button>
          </div>
        </form>
      </details>
      <div className="table-wrap" role="region" aria-label="Latest rank observations" tabIndex={0}>
        <table style={{minWidth:1410,tableLayout:'fixed'}}>
          <colgroup>{[180,90,200,220,180,180,180,180].map((width,i)=><col key={i} style={{width}}/>)}</colgroup>
          <thead><tr><th>Keyword</th><th>Device</th><th>Latest attempt</th><th>Retained observation</th><th>1 day</th><th>7 days</th><th>30 days</th><th>90 days</th></tr></thead>
          <tbody>{p.latest.map(row=><tr key={row.id}>
            <td style={{overflowWrap:'anywhere'}}>
              <button type="button" className="btn ghost" onClick={()=>p.onKeyword(row.keywordId)}>{row.keyword}</button>
              {row.pinned&&<span className="pill">Pinned</span>}
            </td>
            <td>{row.device}</td>
            <td style={{overflowWrap:'anywhere'}}>{row.attempt}</td>
            <td><div>{row.observation}</div><div className="hint">{row.availability}</div>
              <div className="hint">{row.coverage}</div><div className="hint">{'Observed '+row.observedAt}</div></td>
            {row.baselines.map(b=><Cell key={b.days} b={b}/>)}
          </tr>)}</tbody>
        </table>
      </div>
      {p.loaded&&p.error===''&&p.latest.length===0&&<p>No tracked keywords match these filters.</p>}
      {p.nextCursor!==null&&<div className="row"><button type="button" className="btn ghost" onClick={p.onMore} disabled={moreOff}>Load more observations</button></div>}
    </>:<>
      <p>{p.keyword}</p>
      {p.removed&&<p className="notice">This keyword was removed from the tracker. Its retained history remains available.</p>}
      <Scope target={p.target} devices={p.enabledDevices}/>
      <p className="dim">{p.appliedFilters}</p>
      {p.filterDirty&&<p className="hint">Apply filters to update these observations.</p>}
      <details key="history-filters"><summary>History filters</summary>
        <form className="stack" onSubmit={submit}>
          <div className="row" style={{flexWrap:'wrap'}}>
            <DeviceField id={p.prefix+'device'} value={p.filters.device} onChange={v=>p.onFilters({...p.filters,device:v})}/>
          </div>
          <div className="row"><button type="submit" className="btn primary">Apply device filter</button></div>
        </form>
      </details>
      <p className="hint">History includes failed and incompatible attempts. Opening a check does not run it again.</p>
      <div className="table-wrap" role="region" aria-label="Keyword rank history" tabIndex={0}>
        <table style={{minWidth:1430,tableLayout:'fixed'}}>
          <colgroup>{[180,90,240,160,190,210,260].map((width,i)=><col key={i} style={{width}}/>)}</colgroup>
          <thead><tr><th>Attempt</th><th>Device</th><th>Outcome</th><th>Position</th><th>Coverage</th><th>Observed</th><th>Source</th></tr></thead>
          <tbody>{p.observations.map(row=><tr key={row.id}>
            <td><button type="button" className="btn ghost" onClick={()=>p.onRun(row.runId)}>{row.attemptedAt}</button></td>
            <td>{row.device}</td>
            <td style={{overflowWrap:'anywhere'}}><div>{row.outcome}</div><div className="hint">{row.compatibility}</div>
              <div className="hint">{row.availability}</div><div className="hint">{row.scope}</div>
              {row.diagnostic!==null&&<div className="hint">{row.diagnostic}</div>}</td>
            <td>{row.position}</td>
            <td style={{overflowWrap:'anywhere'}}>{row.coverage}</td>
            <td><div>{row.observedAt}</div><div className="hint">{'Retrieved '+row.retrievedAt}</div></td>
            <td style={{overflowWrap:'anywhere'}}><div>{row.target}</div>
              <div className="hint">{row.rankingUrl===null?'—':row.rankingUrl}</div></td>
          </tr>)}</tbody>
        </table>
      </div>
      {p.loaded&&p.error===''&&p.observations.length===0&&<p>No retained attempts match this device filter.</p>}
      {p.nextCursor!==null&&<div className="row"><button type="button" className="btn ghost" onClick={p.onMore} disabled={moreOff}>Load more history</button></div>}
    </>}
  </section>;
}
