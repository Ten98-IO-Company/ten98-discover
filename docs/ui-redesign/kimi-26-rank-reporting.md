# R04 — Rank reporting: results with applied scope

Public Kimi contract. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"R4","replacement":"exact replacement text"}]}. Only R4 in src/components/RankReportingView.tsx may change. GPT applies/independently validates. Approved Skill tools only. Static review of source, callers, tests and existing synthetic screenshots; no fresh test/provider acceptance claimed.

## Scope and flow

Freeze imports/types/signature/locals f,pf,dev,noData and final brace. R4 is the full component return, selected by unique line anchors, not a nested map return. No helpers/hooks/state/controller/API/shared CSS/dependencies. Other rank leaves are separate tasks.

RankTrackingPanel hides but retains reporting during keyword/receipt navigation. User/workspace/project/tracker-keyed RankReportingPanel cancels work and revalidates on return, preserving applied filters. It owns current-role validation, exact count partitions, microsecond cursors/expiry, immutable retention and bounded CSV. Distribution covers latest compatible observations OR a captured check; matrix covers recent full started checks and adjacent comparable observations. Reporting starts no paid check/provider call. Preserve that controller/server behavior.

Expanded source/filter cards currently push mobile distribution results below the first viewport. Compact actions/applied evidence, native collapsed filters and complete results improve the flow without removing qualifiers or controls.

## Exact design

1. Keep one wrapping header, unchanged h2 id pf+'heading'/tabIndex-1 and always-available Back to tracker. Move existing Refresh reporting into header under p.role!==null. Move existing Export matrix CSV into header under p.role!==null&&p.mode==='matrix'; keep type/class/onClick and disabled={!p.canExport||p.matrixDirty||p.exporting} EXACT. No writer-only export guard/new lock. Root may gain display:grid/gap:var(--space-3)/minWidth0. Preserve rank-reporting/report-filters classes: existing CSS already gives 44px controls. No new CSS/helper.
2. All error/notice/loading/export-progress and Cancel export stay visible outside disclosures under exact guards. Keep Back/Refresh/edit interruption behavior. Role-null fallback/Reload access stays exact. Mode row retains Distribution/Recent checks, original aria-pressed and callbacks; no tabs/state.
3. Flatten source/target/as-of/dates card to unframed stack, gap:var(--space-2)/minWidth0. Keep all strings and dates!=='' condition visible in both modes; no truncation/hidden evidence.
4. Distribution: move distributionApplied, runLabel, Latest distribution and distributionDirty hint outside form/disclosure with exact guards/text/callback. Applied source/device and captured-run identity stay visibly tied to results, distinct from draft selection. Latest distribution stays available when closed. loadingRuns/runsError remain visible outside disclosure with exact guards.
5. Wrap existing distribution form in native details open={p.distributionDirty}, summary 'Distribution filters'. Clean default closed; dirty transition opens fields. Keep fields mounted within the existing mode branch. No onToggle/state/key/remount/conditional field mounting. Preserve all source/device selectors/options/labels/IDs/values/change payloads, Previous/Next choice buttons/locks, Apply selection and submit body. Form may become stack with margin0/token gap instead of card; retain report-filters. Manual close/reopen retains drafts, without applying/resetting.
6. Existing distribution sections become a responsive grid: repeat(auto-fit,minmax(min(100%,280px),1fr)), gap:var(--space-4). Card marginBottom0/token gap. Keep each key/title, Population denominator, observedCoverage and top100Comparable before its count table. Every category/value stays in order, including 0/limited/unknown/expired/incompatible; preserve th scope=row. No new percentages/charts/merged devices/completeness inference. Protect labels with th minWidth140/overflowWrap:normal; count td minWidth64/whiteSpace:nowrap/textAlign:end. Labels wrap between words; no clipped/page overflow.
7. Matrix: move exact export-scope hint, guarded matrixApplied/population and dirty hint outside form/disclosure to a visible stack before the table. Preserve all-matching/current-page/fresh-snapshot/recent-window qualifications. Keep noData/loaded/reading/error empty-state ternary EXACT; never reinterpret loading/error/missing columns as zero.
8. Wrap matrix form in native details open={p.matrixDirty}, summary 'Matrix filters', with the same mounted-field rules. Keep every input, report-filters class, min/max/maxLength/type, value/change expression and submit body. Only Apply filters stays in form action row after Export moves once. Invalid drafts survive close/reopen; validation must not hide/clear them. Form may lose card. Toggle never requests/applies/resets. Keep existing mode-branch mounting.
9. Recent rank checks table remains expanded with same name/role/tabIndex0/minWidth900. Preserve all maps/keys/th scopes, exact run/keyword/Distribution callbacks and aria-labels. Keep local/UTC times, status, method/trigger, target, compatibility, case rule, pin, position/basis, state/change/coverage, observed/retrieved dates and availability visible. No metadata disclosures, links, totals or success inference. Keep keyword header minWidth200; increase mapped run-header minWidth180 to240. Named scrolling accommodates columns. Position may use strong without changing its expression. Preserve bottom Check history/First/Next row with exact guards/locks.

Only new copy: 'Distribution filters'/'Matrix filters'. Otherwise only layout wrappers/classes/inline styles change. Callback bodies/arguments, controlled/functional attrs and branch conditions stay exact except specified equivalent relocation. Native summary marker stays list-item (no display:flex). No duplicate actions or new confirmation.

## Independent acceptance

Preserve all 8 tests/rank-reporting-browser.mjs groups/assertions with the real Router/controller: exact partitions/coverage/choice paging; literal filters/cursors; malformed/stale/expiry rejection; bounded CSV/revocation/cancel/navigation; role/project isolation; contained layout/keyboard; real parent receipt/history return with applied filters and fresh reads; denial without cached parent data. No provider/paid calls.

Harness may open the filter before interacting; preserve heading-focus checks BEFORE disclosure clicks. Add native keyboard/marker/default-closed/mounted-field tests; toggle makes no request. Dirty/invalid drafts survive close/reopen, Apply preserves exact values/resets pages. Applied scope, captured run/Latest distribution, dirty notices, source/target/time, population/coverage/export hint stay visible closed; choice loading/error also visible. Keep export disabled for dirty/masked/reading; cancellation/Back/hide never downloads stale data; no extra viewer guard. Null role reveals no protected data/actions.

Verify every supplied category/count/denominator once per group, including incomplete/zero/expired and one/two-device cases. Matrix retains all metadata and unavailable-vs-zero/basis/change meaning. Preserve off-page captured run selection, paging/callback IDs. No client metric or CSV computation.

320/360/768/1440 with long literal keywords/domains/labels/dates, LTR/RTL, 200% CSS layout zoom and forced colors: no page overflow; visible controls/summaries >=44px, visible focus/intact labels/native marker. Bounded words/numbers cannot split into letter strips. Matrix keyword column>=200px/run columns>=240px with real keyboard horizontal scrolling. Ordinary existing fixtures with clean filters closed: first distribution count starts above y800 at 360px; matrix region above y800 at 1440px (retain original threshold). Inspect both modes and dirty/invalid/incomplete/expired/empty/denied states. CSS zoom is a layout probe, not full assistive-technology acceptance. Synthetic loopback only; no DB/provider/live preview. No test execution in this planning deliverable.

## Exact input integrity

Source SHA256: A4AFAD6E8BCD6D5D6A08D9979758890DE4024F2D4C82182FB721A7549580B6AE.
R4 SHA256 (exact UTF-8 bytes excluding separating LF before closing fence): 323972DA9A24DB823CFB5D4A827B12C947E0985F6F79C711432958006CD764AB.
Unique component-return anchors; prefix + span + suffix reconstruct source. Standalone fences; only R4 may change.

### Read-only exact prefix: types and locals

```tsx
import type * as React from 'react';

export type RankReportingDevice='desktop'|'mobile';
export type RankMatrixFilters={device:RankReportingDevice;search:string;pinned:'all'|'true'|'false';runLimit:number};
export type RankDistributionGroupDisplay={id:string;title:string;denominator:string;observedCoverage:string;top100Comparable:string;counts:readonly {id:string;label:string;value:string}[]};
export type RankMatrixColumnDisplay={id:string;startedAt:string;utc:string;status:string;method:string;trigger:string;target:string;compatibility:string};
export type RankMatrixCellDisplay={runId:string;state:string;position:string;change:string;coverage:string;observedAt:string;retrievedAt:string;availability:string};
export type RankMatrixRowDisplay={id:string;keyword:string;caseRule:string;pinned:boolean;cells:readonly RankMatrixCellDisplay[]};
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
```

### R4 — only allowed original span

```tsx
 return <div className="research-panel rank-reporting stack">
  <div className="row between">
   <h2 id={pf+'heading'} tabIndex={-1}>Rank reporting</h2>
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
    <button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh reporting</button>
   </div>
   <div className="card stack">
    <div className="row between"><span>{p.source}</span><span className="dim">{p.target}</span></div>
    <div className="row"><span className="dim">As of: {p.asOf}</span>{p.dates!==''&&<span className="dim">{p.dates}</span>}</div>
   </div>
   {p.mode==='distribution'?<>
    <form className="card stack" onSubmit={e=>{e.preventDefault();p.onApplyDistribution();}}>
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
     {p.loadingRuns&&<p className="dim" role="status">Loading check choices…</p>}
     {p.runsError!==''&&<p className="alert" role="alert">{p.runsError}</p>}
     <div className="row">
      {p.canPreviousRuns&&<button type="button" className="btn ghost" disabled={p.loadingRuns} onClick={p.onPreviousRuns}>Previous check choices</button>}
      {p.canNextRuns&&<button type="button" className="btn ghost" disabled={p.loadingRuns} onClick={p.onNextRuns}>Next check choices</button>}
     </div>
     <div className="row"><button type="submit" className="btn primary">Apply selection</button>
      {p.runLabel!==null&&<span className="dim">{p.runLabel}</span>}
      {p.runLabel!==null&&<button type="button" className="btn ghost" onClick={p.onLatestDistribution}>Latest distribution</button>}
     </div>
     {p.distributionApplied!==''&&<p className="dim">{p.distributionApplied}</p>}
     {p.distributionDirty&&<p className="hint">Apply the selection to update the summary.</p>}
    </form>
    {p.groups.map(g=><section key={g.id} className="card stack">
     <h3>{g.title}</h3>
     <p className="dim">Population: {g.denominator}</p>
     <p className="dim">{g.observedCoverage}</p>
     <p className="dim">{g.top100Comparable}</p>
     <table><tbody>{g.counts.map(c=><tr key={c.id}><th scope="row">{c.label}</th><td>{c.value}</td></tr>)}</tbody></table>
    </section>)}
   </>:<>
    <form className="card stack" onSubmit={e=>{e.preventDefault();p.onApplyMatrix();}}>
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
     <div className="row"><button type="submit" className="btn primary">Apply filters</button>
      <button type="button" className="btn ghost" disabled={!p.canExport||p.matrixDirty||p.exporting} onClick={p.onExport}>Export matrix CSV</button>
     </div>
     <p className="hint">Export covers all matching current keywords in one fresh snapshot, not just this page.</p>
     {p.matrixApplied!==''&&<p className="dim">{p.matrixApplied}</p>}
     {p.population!==''&&<p className="dim">{p.population}</p>}
     {p.matrixDirty&&<p className="hint">Apply filters to update the matrix.</p>}
    </form>
    {noData?(p.loaded&&!p.reading&&p.error===''&&<div className="card stack"><p className="dim">{p.rows.length===0?'No current keywords match these filters.':'No full started checks are available in this recent window.'}</p></div>):
     <div className="table-wrap" role="region" aria-label="Recent rank checks" tabIndex={0}>
      <table style={{minWidth:900}}>
       <thead><tr><th scope="col" style={{minWidth:200}}>Keyword</th>
        {p.columns.map(c=><th key={c.id} scope="col" style={{minWidth:180}}>
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
```

### Read-only exact suffix

```tsx

}
```

## Execution cap

One initial K3 maximum-thinking draft capped at 420 seconds; at most one separately authorized 120-second repair. Stop on deadline/ambiguity; no automatic continuation, substitution, application or invented tests. Return requested JSON only.
