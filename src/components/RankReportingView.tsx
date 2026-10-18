import type * as React from 'react';

type RankReportingDevice='desktop'|'mobile';
type RankMatrixFilters={device:RankReportingDevice;search:string;pinned:'all'|'true'|'false';runLimit:number};
type RankDistributionGroupDisplay={id:string;title:string;denominator:string;observedCoverage:string;top100Comparable:string;counts:readonly {id:string;label:string;value:string}[]};
type RankMatrixColumnDisplay={id:string;startedAt:string;utc:string;status:string;method:string;trigger:string;target:string;compatibility:string};
type RankMatrixCellDisplay={runId:string;state:string;position:string;change:string;coverage:string;observedAt:string;retrievedAt:string;availability:string};
type RankMatrixRowDisplay={id:string;keyword:string;caseRule:string;pinned:boolean;cells:readonly RankMatrixCellDisplay[]};
export type RankReportingViewProps={
 prefix:string;role:'owner'|'admin'|'editor'|'viewer'|null;mode:'distribution'|'matrix';
 loaded:boolean;reading:boolean;exporting:boolean;error:string;notice:string;
 source:string;target:string;asOf:string;dates:string;enabledDevices:readonly RankReportingDevice[];
 distributionDevice:'both'|'desktop'|'mobile';distributionDirty:boolean;distributionApplied:string;
 runChoiceId:string;runChoices:readonly {id:string;label:string}[];loadingRuns:boolean;runsError:string;
 canPreviousRuns:boolean;canNextRuns:boolean;runLabel:string|null;groups:readonly RankDistributionGroupDisplay[];
 matrixFilters:RankMatrixFilters;matrixDirty:boolean;matrixApplied:string;population:string;
 columns:readonly RankMatrixColumnDisplay[];rows:readonly RankMatrixRowDisplay[];hasNext:boolean;canFirst:boolean;canExport:boolean;
 onMode:(mode:'distribution'|'matrix')=>void;onDistributionDevice:(device:'both'|'desktop'|'mobile')=>void;
 onApplyDistribution:()=>void;onLatestDistribution:()=>void;
 onRunChoice:(runId:string)=>void;onPreviousRuns:()=>void;onNextRuns:()=>void;
 onMatrixFilters:(filters:RankMatrixFilters)=>void;onApplyMatrix:()=>void;
 onNext:()=>void;onFirst:()=>void;onExport:()=>void;onCancelExport:()=>void;
 onRunDistribution:(runId:string)=>void;onOpenRun:(runId:string)=>void;
 onOpenKeyword:(keywordId:string)=>void;onCheckHistory:()=>void;onRefresh:()=>void;onBack:()=>void;
};

export function RankReportingView(p:RankReportingViewProps):React.JSX.Element{
 const f=p.matrixFilters,pf=p.prefix;
 const dev=(d:RankReportingDevice)=>d==='desktop'?'Desktop':'Mobile';
 const noData=p.rows.length===0||p.columns.length===0;
 return <div className="research-panel rank-reporting stack" style={{display:'grid',gap:'var(--space-3)',minWidth:0}}>
  <div className="row between">
   <h2 id={pf+'heading'} tabIndex={-1}>Rank reporting</h2>
   {p.role!==null&&<button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh reporting</button>}
   {p.role!==null&&p.mode==='matrix'&&<button type="button" className="btn ghost" disabled={!p.canExport||p.matrixDirty||p.exporting} onClick={p.onExport}>Export matrix CSV</button>}
   <button type="button" className="btn ghost" onClick={p.onBack}>Back to tracker</button>
  </div>
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p className="dim" role="status">Loading rank reporting…</p>}
  {p.exporting&&<p className="dim" role="status">Preparing CSV… <button type="button" className="btn ghost" onClick={p.onCancelExport}>Cancel export</button></p>}
  {p.role===null?(p.reading?null:<div className="card stack">
   <p>Reporting is unavailable. Reload access or return to the tracker.</p>
   <div className="row"><button type="button" className="btn primary" onClick={p.onRefresh}>Reload access</button></div>
  </div>):<>
   <div className="row">
    <button type="button" className="btn ghost" aria-pressed={p.mode==='distribution'} onClick={()=>p.onMode('distribution')}>Distribution</button>
    <button type="button" className="btn ghost" aria-pressed={p.mode==='matrix'} onClick={()=>p.onMode('matrix')}>Recent checks</button>
   </div>
   <div className="stack" style={{gap:'var(--space-2)',minWidth:0}}>
    <div className="row between"><span>{p.source}</span><span className="dim">{p.target}</span></div>
    <div className="row"><span className="dim">As of: {p.asOf}</span>{p.dates!==''&&<span className="dim">{p.dates}</span>}</div>
   </div>
   {p.mode==='distribution'?<>
    <div className="stack" style={{gap:'var(--space-2)',minWidth:0}}>
     {p.distributionApplied!==''&&<p className="dim">{p.distributionApplied}</p>}
     {p.runLabel!==null&&<div className="row">
      <span className="dim">{p.runLabel}</span>
      <button type="button" className="btn ghost" onClick={p.onLatestDistribution}>Latest distribution</button>
     </div>}
     {p.distributionDirty&&<p className="hint">Apply the selection to update the summary.</p>}
     {p.loadingRuns&&<p className="dim" role="status">Loading check choices…</p>}
     {p.runsError!==''&&<p className="alert" role="alert">{p.runsError}</p>}
    </div>
    <details open={p.distributionDirty}>
     <summary>Distribution filters</summary>
     <form className="stack" style={{margin:0,gap:'var(--space-2)'}} onSubmit={e=>{e.preventDefault();p.onApplyDistribution();}}>
      <div className="report-filters">
      <div className="field"><label htmlFor={pf+'runs'}>Distribution source</label>
       <select id={pf+'runs'} value={p.runChoiceId} onChange={e=>p.onRunChoice(e.target.value)}>
        <option value="latest">Latest retained observations</option>
        {p.runChoices.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
       </select></div>
      <div className="field"><label htmlFor={pf+'ddev'}>Distribution device</label>
       <select id={pf+'ddev'} value={p.distributionDevice} onChange={e=>p.onDistributionDevice(e.target.value as 'both'|'desktop'|'mobile')}>
        <option value="both">Both applicable devices</option>
        {p.enabledDevices.map(d=><option key={d} value={d}>{dev(d)}</option>)}
       </select></div>
      </div>
      <div className="row">
       {p.canPreviousRuns&&<button type="button" className="btn ghost" disabled={p.loadingRuns} onClick={p.onPreviousRuns}>Previous check choices</button>}
       {p.canNextRuns&&<button type="button" className="btn ghost" disabled={p.loadingRuns} onClick={p.onNextRuns}>Next check choices</button>}
      </div>
      <div className="row"><button type="submit" className="btn primary">Apply selection</button></div>
     </form>
    </details>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,280px),1fr))',gap:'var(--space-4)'}}>
     {p.groups.map(g=><section key={g.id} className="card stack" style={{marginBottom:0,gap:'var(--space-2)'}}>
      <h3>{g.title}</h3>
      <p className="dim">Population: {g.denominator}</p>
      <p className="dim">{g.observedCoverage}</p>
      <p className="dim">{g.top100Comparable}</p>
      <table><tbody>{g.counts.map(c=><tr key={c.id}><th scope="row" style={{minWidth:140,overflowWrap:'normal'}}>{c.label}</th><td style={{minWidth:64,whiteSpace:'nowrap',textAlign:'end'}}>{c.value}</td></tr>)}</tbody></table>
     </section>)}
    </div>
   </>:<>
    <div className="stack" style={{gap:'var(--space-2)',minWidth:0}}>
     <p className="hint">Export covers all matching current keywords in one fresh snapshot, not just this page.</p>
     {p.matrixApplied!==''&&<p className="dim">{p.matrixApplied}</p>}
     {p.population!==''&&<p className="dim">{p.population}</p>}
     {p.matrixDirty&&<p className="hint">Apply filters to update the matrix.</p>}
    </div>
    <details open={p.matrixDirty}>
     <summary>Matrix filters</summary>
     <form className="stack" style={{margin:0,gap:'var(--space-2)'}} onSubmit={e=>{e.preventDefault();p.onApplyMatrix();}}>
      <div className="report-filters">
      <div className="field"><label htmlFor={pf+'mdev'}>Device</label>
       <select id={pf+'mdev'} value={f.device} onChange={e=>p.onMatrixFilters({...f,device:e.target.value as RankReportingDevice})}>
        {p.enabledDevices.map(d=><option key={d} value={d}>{dev(d)}</option>)}
       </select></div>
      <div className="field"><label htmlFor={pf+'q'}>Keyword contains</label>
       <input id={pf+'q'} value={f.search} maxLength={200} onChange={e=>p.onMatrixFilters({...f,search:e.target.value})}/></div>
      <div className="field"><label htmlFor={pf+'pin'}>Pinned keywords</label>
       <select id={pf+'pin'} value={f.pinned} onChange={e=>p.onMatrixFilters({...f,pinned:e.target.value as RankMatrixFilters['pinned']})}>
        <option value="all">All</option><option value="true">Pinned</option><option value="false">Unpinned</option>
       </select></div>
      <div className="field"><label htmlFor={pf+'lim'}>Recent check count</label>
       <input id={pf+'lim'} type="number" min={1} max={26} value={f.runLimit} onChange={e=>p.onMatrixFilters({...f,runLimit:e.target.valueAsNumber})}/></div>
      </div>
      <div className="row"><button type="submit" className="btn primary">Apply filters</button></div>
     </form>
    </details>
    {noData?(p.loaded&&!p.reading&&p.error===''&&<div className="card stack"><p className="dim">{p.rows.length===0?'No current keywords match these filters.':'No full started checks are available in this recent window.'}</p></div>):
     <div className="table-wrap" role="region" aria-label="Recent rank checks" tabIndex={0}>
      <table style={{minWidth:900}}>
       <thead><tr><th scope="col" style={{minWidth:200}}>Keyword</th>
        {p.columns.map(c=><th key={c.id} scope="col" style={{minWidth:240}}>
         <button type="button" className="btn ghost" onClick={()=>p.onOpenRun(c.id)}>{c.startedAt}</button>
         <div className="dim">{c.utc}</div>
         <div className="dim">{c.status}</div>
         <div className="dim">{c.method} / {c.trigger}</div>
         <div className="dim">{c.target}</div>
         <div className="dim">{c.compatibility}</div>
         <button type="button" className="btn ghost" aria-label={'Distribution for check started '+c.startedAt+' '+c.utc} onClick={()=>p.onRunDistribution(c.id)}>Distribution</button>
        </th>)}
       </tr></thead>
       <tbody>{p.rows.map(r=><tr key={r.id}>
        <th scope="row"><button type="button" className="btn ghost" onClick={()=>p.onOpenKeyword(r.id)}>{r.keyword}</button>
         <div className="dim">{r.caseRule}</div>
         {r.pinned&&<span className="pill">Pinned</span>}
        </th>
        {r.cells.map(cell=><td key={cell.runId}>
         <div>{cell.position}</div>
         <div className="dim">{cell.state}</div>
         <div className="dim">{cell.change}</div>
         <div className="dim">{cell.coverage}</div>
         <div className="dim">Observed: {cell.observedAt}</div>
         <div className="dim">Retrieved: {cell.retrievedAt}</div>
         <div className="dim">{cell.availability}</div>
        </td>)}
       </tr>)}</tbody>
      </table>
     </div>}
    <div className="row between"><button type="button" className="btn ghost" onClick={p.onCheckHistory}>Check history</button>
     <span className="row">
      {p.canFirst&&<button type="button" className="btn ghost" disabled={p.reading||p.matrixDirty} onClick={p.onFirst}>First keyword page</button>}
      {p.hasNext&&<button type="button" className="btn ghost" disabled={p.reading||p.matrixDirty} onClick={p.onNext}>Next keyword page</button>}
     </span>
    </div>
   </>}
  </>}
 </div>;
}
