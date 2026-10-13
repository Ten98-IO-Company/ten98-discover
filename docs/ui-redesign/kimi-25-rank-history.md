# R03 — Rank observations and keyword history

Public GPT-6 Astra Ultra design. Use Ponytail and UX Copy Refiner; only approved Skill tools. Return JSON only: {"replacements":[{"id":"RH1","replacement":"..."},{"id":"RH2","replacement":"..."},{"id":"RH3","replacement":"..."},{"id":"RH4","replacement":"..."},{"id":"RH5","replacement":"..."},{"id":"RH6","replacement":""}]}, all six exact strings including final LF (RH6 empty). No filesystem/shell/network/subagents. Draft cap 420 seconds; at most one separately requested 120-second repair, then stop. GPT applies and validates independently.

## Scope and real flow

Only six spans in src/components/RankHistoryView.tsx may change. No CSS/dependency/helper extraction/state/effect/type/controller/route/request/format change. Exact full source/types follow. Cell and DeviceField are frozen. Scope changes only its root presentation line; signature, children, optional asOf condition and strings remain unchanged.

RankTrackingPanel opens RankHistoryPanel from Latest observations or at a keyword from RankReportingPanel. Its controller is keyed by user/workspace/project/tracker/entryKeywordId. Preserve Back to tracker/reporting, Latest observations, focus IDs and read-only run drilldown. Opening an attempt does not quote/run it. Hidden history suspends reads while its child check/schedule is active.

Controller verification, role/scope fences, opaque cursors and irreversible expiry masking stay frozen. onFilters edits the draft and aborts stale reads without a request. Apply reads the draft; Refresh reads applied filters and replaces the draft. Load more remains guarded while reading/dirty. Latest return restores prior latest applied filters. No new confirmation/auto-apply/disabled conditions/filter state.

## Design

Reuse research-panel/stack/row/between/btn/ghost/primary/dim/hint/notice/table-wrap and semantic tokens. No new components, icons, charts, truncation or sticky UI. Group the header and disclose draft controls; result qualifications remain visible.

1. RH1: replace Scope’s `card stack` with `stack`, adding `style={{gap:'var(--space-1)'}}`; all remaining bytes stay unchanged. Captured target/limits, devices and latest as-of remain visible outside details. No invented history timestamp.
2. RH2/RH3: both section roots, including role-null loading/denied, receive `style={{'--control-md':'var(--control-touch)',display:'grid',gap:'var(--space-3)'} as React.CSSProperties}`. Preserve their classes. This view-local alias gives buttons, inputs and selects 44px targets at every tested width. Existing native summaries already use --control-touch. Do not edit global tokens/styles or shrink table/button text.
3. RH3: one wrapping compact header contains the existing h2 and back control. Preserve heading id, tabIndex, ternary text and back variable. Heading style: margin:0, fontSize:'var(--text-lg)', minWidth:0. Existing row/between wrapping with gap:'var(--space-3)' is sufficient. When latest, place the exact existing Refresh observations button here, moved from RH4; when keyword, retain the original Latest observations and Refresh history buttons. Keep all type/class/handlers and existing predicates, with no new disabled behavior. There must be exactly one appropriate Refresh control, visible when filters are closed. Error alert and reading status immediately following RH3 stay unchanged and visible.
4. RH4 latest order: Scope; exact p.appliedFilters paragraph; existing conditional dirty hint; native disclosure; then the frozen results table/pager. Use `<details key="latest-filters">` with `<summary>Observation filters</summary>`, initially closed with no open/onToggle/controlled state. Place the existing form inside, retaining onSubmit, every field/label/id/value/maxLength/option/onChange and Apply filters submit button. Remove only its card class (keep stack); the Refresh observations button moves to RH3. Existing row wrapping and optional token gaps suffice. Do not conditionally mount the form based on disclosure openness or loaded rows. Toggling must retain mounted draft values and emit no request. All fields remain available for empty/error results.
5. RH5 keyword order: exact keyword paragraph; original removed-keyword notice under its unchanged guard; Scope; exact applied-filter paragraph; unchanged conditional dirty hint; native disclosure; the existing history qualification paragraph moved from RH6. Use `<details key="history-filters">` with `<summary>History filters</summary>`, initially closed; preserve the existing DeviceField form, Apply device filter submission and all arguments. Remove only the form’s card class. No copy or guards change. The moved qualification stays outside details directly before the frozen history table: “History includes failed and incompatible attempts. Opening a check does not run it again.”
6. RH6 becomes empty because its exact paragraph now occurs once in RH5. Tables and everything else remain byte-for-byte unchanged. In particular, preserve both table min widths, fixed layout, colgroups, labels/roles/tabIndex, map keys, drill callbacks and every cell. Never hide a baseline/source/coverage/outcome column to fit mobile.

Keep native marker, Enter/Space and focus. Phase keys separate disclosure identity; close/reopen retains mounted drafts. No open binding to dirty, no closing on Apply. Errors, loading, removed notice, applied scope, dirty hint and data qualifications stay outside details. No methodology disclosure: this prose is consequential.

Copy: retain existing strings verbatim; only add Observation filters / History filters. Latest attempt, retained observation and baseline change/position/source/target time/observed time stay distinct. Unavailable, not checked, not found, expired and incompatible never become zero. Preserve raw/derived expiry. Ranking URL remains escaped text.

## Independent acceptance

GPT preserves all seven original tests/rank-history-browser.mjs groups and assertions. Adapt only by opening native filters before existing field/Apply interactions, including after phase or scope remount. Reuse the contained production-controller harness; no new harness by default. Required checks:

- Latest and keyword headers group the same heading/back/refresh controls; Refresh, errors and loading remain visible with filters closed. Latest return and exact Back to reporting/tracker labels remain functional; role-null exposes only original access recovery/back content. Heading focus after keyword/phase navigation still works.
- Both native summaries toggle by click/Enter/Space without HTTP. Change a draft, close/reopen, assert exact draft values, visible unchanged applied text/dirty hint and disabled pagination. Apply issues the same literal search/device/pinned query and resets the cursor; Refresh still uses applied filters. Preserve superseded-read and project-remount rejection. Do not require new synthetic guards in the pure view.
- With disclosures closed, assert captured scope, enabled devices, as-of/paged-read qualification, removed keyword and relocated history qualification visible outside details. Keep the original failed latest attempt versus older ranked observation checks, incompatible captured target, baseline basis/same-observation gaps, dated earliest-available fallback, opaque microsecond cursors, expiration masking, role loss/malformed results, inert hostile URLs and read-only run drilldown. Preserve empty/error distinction and current Load more conditions.
- 320/360/768/1440px, both phases, open/closed filters, long 200-character keyword, 253-character domain, 2048-character diagnostic and 4096-character ranking URL within existing validated fixtures: no document overflow or truncation; tables remain labelled, focusable and independently keyboard-scrollable. At 200% CSS layout zoom, LTR/RTL and forced colors retain readable content/focus/native marker. Buttons, summary, inputs and selects measure at least 44px high at every width, including loading/denied roots. Inspect populated closed-filter desktop/mobile, open dirty filters and keyword-history screenshots. Preserve all eight latest and seven history columns, baseline metadata and plain-text source values.
- Check TypeScript and scoped diff; run TEN98_RANK_HISTORY_BROWSER=1 node tests/rank-history-browser.mjs with installed Playwright/Edge. Only synthetic intercepted GETs; assert no writes, quotes, providers or external requests. No database, live preview, production build or paid work in this focused acceptance. Report checks actually run, never invented results.

## Exact source boundaries

Source SHA256: 96CF478AA82B1E9EB400D6507D0550D393816FE4651AD1721BBA537A0DF194E0. UTF-8/LF. Inclusive one-based spans include final LF. Verify hashes and one occurrence per original; preserve all outside bytes. The source fence must roundtrip exactly. Use unique anchors below, never last-return selection.

| ID | Inclusive lines | SHA256 of exact original |
|---|---|---|
| RH1 | 28–28 | 68FCDBD9094A3D60080676E919A6D34B24A050C7E032A5BD1B539BFA8624EC97 |
| RH2 | 39–39 | F52BB7F68D4CCCB891D831DAC61DDD5A71D229A9B67DFCCACF043F5D4D100E5B |
| RH3 | 48–55 | 43DBF98C10575C5927371CFDB6C3120870A1AC483DC01F25D85EDBE585C854F1 |
| RH4 | 59–76 | 7C060FEB0D5CCA79EA03A102DC75EE7675E057A4D84E8D350DBC293700E8EA7B |
| RH5 | 97–107 | 7C65BFD574E5C38FBA8559524C8908C4889B51140A3447BE8AD187B5AD7BA5D8 |
| RH6 | 126–126 | 9A068E21E0F253177785158FF91D097B492EA74BB2F92938DB81BC51D5AD3723 |

RH1: Scope return line with target/devices children. RH2: four-space-indented root inside `if(p.role===null)`. RH3: two-space-indented main root through h2, stopping before error/loading. RH4: Scope call with asOf through dirty hint, stopping before Latest rank observations region. RH5: keyword paragraph through dirty hint, stopping before Keyword rank history region. RH6: unique history qualification paragraph. Match each full exact original span.

## Exact current source, including frozen types/helpers/tables

```tsx
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
  return <div className="card stack"><p>{target}</p><p className="dim">{'Enabled devices: '+devices}</p>
    {asOf!==undefined&&<p className="dim">{'Results as of: '+asOf}</p>}</div>;
}

export function RankHistoryView(p:RankHistoryViewProps):React.JSX.Element{
  const hid=p.prefix+'history-heading';
  const latest=p.phase==='latest';
  const submit=(e:React.FormEvent)=>{e.preventDefault();p.onApply();};
  const moreOff=p.reading||p.filterDirty;
  const back=<button type="button" className="btn ghost" onClick={p.onBack}>{p.backLabel??'Back to tracker'}</button>;
  if(p.role===null){
    return <section className="research-panel stack">
      <div className="row between" style={{flexWrap:'wrap'}}>{back}</div>
      {p.error!==''&&<p role="alert" className="alert">{p.error}</p>}
      {p.reading?<p role="status">Loading rank observations…</p>:<>
        <p>Rank observations are unavailable. Reload access or return to the tracker.</p>
        <div className="row"><button type="button" className="btn primary" onClick={p.onRefresh}>Reload access</button></div>
      </>}
    </section>;
  }
  return <section className="research-panel stack">
    <div className="row between" style={{flexWrap:'wrap'}}>{back}
      {!latest&&<span className="row" style={{flexWrap:'wrap'}}>
        <button type="button" className="btn ghost" onClick={p.onLatest}>Latest observations</button>
        <button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh history</button>
      </span>}
    </div>
    <h2 id={hid} tabIndex={-1}>{latest?'Latest rank observations':'Keyword rank history'}</h2>
    {p.error!==''&&<p role="alert" className="alert">{p.error}</p>}
    {p.reading&&<p role="status">Loading rank observations…</p>}
    {latest?<>
      <Scope target={p.target} devices={p.enabledDevices} asOf={p.asOf}/>
      <form className="card stack" onSubmit={submit}>
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
          <button type="button" className="btn ghost" onClick={p.onRefresh}>Refresh observations</button>
        </div>
      </form>
      <p className="dim">{p.appliedFilters}</p>
      {p.filterDirty&&<p className="hint">Apply filters to update these observations.</p>}
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
      <form className="card stack" onSubmit={submit}>
        <div className="row" style={{flexWrap:'wrap'}}>
          <DeviceField id={p.prefix+'device'} value={p.filters.device} onChange={v=>p.onFilters({...p.filters,device:v})}/>
        </div>
        <div className="row"><button type="submit" className="btn primary">Apply device filter</button></div>
      </form>
      <p className="dim">{p.appliedFilters}</p>
      {p.filterDirty&&<p className="hint">Apply filters to update these observations.</p>}
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
      <p className="hint">History includes failed and incompatible attempts. Opening a check does not run it again.</p>
      {p.loaded&&p.error===''&&p.observations.length===0&&<p>No retained attempts match this device filter.</p>}
      {p.nextCursor!==null&&<div className="row"><button type="button" className="btn ghost" onClick={p.onMore} disabled={moreOff}>Load more history</button></div>}
    </>}
  </section>;
}
```
