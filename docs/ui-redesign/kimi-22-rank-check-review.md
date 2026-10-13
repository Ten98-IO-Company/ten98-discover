# R02a — Rank check setup and explicit price review

Public Kimi presentation contract. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"R2A","replacement":"exact replacement text"}]}. Only R2A in src/components/RankCheckView.tsx may change. GPT applies and independently validates. Only approved Skill tools. Static design review with existing synthetic screenshots; no new acceptance result is claimed.

## Scope and flow

Freeze imports, exact types, function signature, writer/hid/q locals and final brace. R2A is the single component section return, containing BOTH setup and review; no nested-return extraction. No new helper/state/hook/abstraction/dependency/CSS file/controller/API. RankCheckResults and RankTrackingView are disjoint tasks. Reuse native HTML and existing tokens/primitives.

RankTrackingPanel enters RankCheckPanel from tracker/history, scoped observations/reporting, or schedule setup. Dynamic Back must preserve mounted parent/filter/focus context. RankCheckPanel verifies roles, UUIDs, literal keyword/device pairs, method/target/revisions and exact six-decimal amounts before creating these display props. It owns immutable same-request retry, write locks, stale-response purge, dirty navigation and irreversible expiry (also across schedule return/remount). Server rank-execution performs free quote account/price lookup; only explicit start makes atomic reservations/jobs. A schedule quote instead forces all keywords and queued method, then hands its captured ID/deadline to separate owner spending approval. Those workflows remain untouched.

Current paid action is below every quoted row, which can run to2000 rows. Back and the title occupy separate bands. Goal: compact setup, then one clear price-review decision block above a complete, inspectable quote table. Never make a quote look like a paid start, a schedule approval, a final bill or a no-cost provider operation.

## Exact design

1. Existing section gets render-local style with '--control-md':'var(--control-touch)' and display:grid/gap:var(--space-3)/minWidth:0, cast as React.CSSProperties. This ensures native controls >=44px without global CSS. Use research-panel/stack/card/row/field/btn/hint/notice/alert/table-wrap and semantic tokens. No new class/helper, fixed or sticky bars, truncation, clipped overflow or small type.
2. One compact wrapping header, space-between/flex-start: existing phase-appropriate h2 and existing Back button. Keep id hid/tabIndex-1 and exact heading/back texts. Move the title once from each branch into the header using p.role!==null and the SAME setup-versus-review phase condition. A null role still has Back and access/loading fallback, never a fabricated review title. Button type/disabled/onClick stay exact. Error/notice/loading/pending/conflict follow header and remain outside form/review/table. Their full copy/roles and retry/refresh callbacks/locks remain unchanged and immediately usable; retry has no disabled attribute intentionally.
3. Setup: keep exact selectionLabel visible below status. Form remains under writer&&(!p.schedulePurpose||p.role==='owner'), same aria-labelledby and onSubmit body. Compact fields with margin0/minWidth0, grouped in a responsive native grid (auto-fit/minmax(min(100%,220px),1fr), token gap). Form may use maxWidth:var(--form-max), width:100%, marginBottom:0, token gap. Keep full connection options and native select attributes/callback. Keep schedulePurpose fixed-method explanation instead of the method select; normal queued/live select remains exact. Keep the exact free-quote/possible-provider-charge/separate-schedule-approval hint visibly immediately before its current action. Preserve zero-connections owner Open providers versus nonowner request-owner text versus Prepare quote and its entire disabled expression. No automatically selected connection or auto-submit.
4. Review: compact the existing summary card, marginBottom0/token gap. Maximum total label/id and associated exact dollar string remain prominent (existing big-num may be used, without changing amount text). Preserve connection/method, full target/selection, task and dispatch counts, price-check and expiry strings. Do not hide evidence in details, change wording, recalculate a number, imply a reservation already exists or color the amount as savings/success.
5. Move the quote table AFTER the original guarded action row. Review order must be summary -> expired notice (if any) -> upper-bound/uncertain-outcome hint -> requester qualification (if any) -> original action row -> full quote table. Keep cost, expiry and requester qualifications immediately adjacent above any paid action; no unrelated content between them. Only rendering restructure needed: remove table from current q nonnull fragment, keep all other fragment content and then render that unchanged table under q!==null after the original action row. This equivalent table guard is explicitly allowed; retain q===null fallback and original (q!==null||!p.conflict) action-row guard. Do NOT put the action row inside q!==null, which would erase Refresh quote for the null/nonconflict fallback.
6. Every action expression stays exact: schedulePurpose chooses Configure schedule with locked||!canConfigureSchedule versus Start paid rank check with locked||conflict||!writer||!q.canStart||q.expired; !schedulePurpose&&canConfigureSchedule controls Set up recurring checks, !conflict controls Refresh quote. Preserve exact callbacks/types/labels. No new guards, silent payment, paid action duplication, new confirmation or conflating Configure schedule with immediate paid start.
7. Table remains always expanded for a nonnull quote, minWidth640, exact named region/role/tabIndex0, all three columns/task keys/rows/dollar expressions. It stays fully inspectable after the decision block. An h3 'Quoted keyword and device costs' may precede it. Prevent first keyword cells becoming a one-character strip with a modest cell minWidth if needed; keep overflowing long data inside the named scroll region, never hide/truncate it. Only the optional section heading is new copy; no other text edits.

## Frozen security and behavior

All original controlled props, callback bodies/arguments, guards (except the explicitly equivalent table/title render relocation), disabled expressions, labels/IDs/aria, keys and error/status text remain exact. The component cannot infer authority from data, revalidate/repair a quote, format currency, sum rows, decide expiry, clear pending intent or alter navigation. Same-request retry remains the only recovery for an unresolved write. Current role loss must not leave stale quoted contents. Quote still does not reserve/start; both retrieval methods can charge after approval. Owner recurring approval and requester paid start remain distinct. Do not add missing capability via UI or promise full product completion.

## Independent acceptance after source application

Preserve all12 tests/rank-check-browser.mjs groups and original assertions, using its real Router/controller and intercepted synthetic API. They cover free explicit quote/revision/literal inputs/exact max; lost/429/malformed acknowledgements retried with identical body after expiry and exactly one dispatch; cancel versus active read/write; unknown-cost owner free recovery; irreversible retained/expired receipts; subset pair binding and expired start; viewer/403 stale purge; mobile keyboard navigation; observations/reporting parent return; skipped schedule receipts; owner separate full queued schedule approval; manual queued shortcut versus live/subset exclusion and immutable remount expiry. No test becomes conditional to accept a failure.

Add focused render/order checks with existing harness tooling: exactly one heading/back and every eligible action once; controller still focuses h2 BEFORE any subsequent click. For2 and many quote rows, all summary evidence, upper-bound/expiry/requester qualifications and permitted actions precede the table, independent of table length; all rows/columns/six-decimal values remain exact. Check writer roles/viewer/null; requester true/false; expired; locked/reading/pending/conflict; quote null with conflict true/false; missing connection owner/admin; canQuote false; both methods and schedulePurpose. Explicitly prove null quote/nonconflict keeps Refresh quote and conflict keeps only the banner refresh; keep the paid/start/schedule truth table exact. In schedule purpose, method cannot switch, only owner prepares and no immediate start exists. Changing method/connection and keyboard submit still call once with exact callback arguments; layout itself sends no API request.

320/360/768/1440, long connection/target/keywords/price-date text, LTR/RTL,200% CSS layout zoom and forced colors: no page overflow; every button/select >=44px including null-role Back and retry/conflict controls; labels/IDs/visible focus intact. Named cost table is keyboard focusable and horizontally scrollable when narrow; no collapsed quote or single-character keyword strip. Inspect setup/manual/schedule, eligible/nonrequester/expired, conflict/pending screenshots. Synthetic loopback only; no provider/DB/live preview. No fresh execution is part of this design deliverable.

## Exact input integrity

Source SHA256: 5A04A1B6CE2E6EDF9D80EF9BC78DFF6E82968D836BC146E5AEFACB603811DE0F.
R2A SHA256 (exact UTF-8 bytes excluding the separating LF before the closing Markdown fence): E595FA240465A2E34002E328C16A1104CC08226B72C78C0A64F05F5A0CDF195B.
Unique line-anchored component boundaries cover the entire setup/review return. Prefix + span + suffix reconstruct the source exactly. Fences start/end on standalone lines; everything outside R2A is frozen.

### Read-only prefix: exact types and derived locals

```tsx
import type * as React from 'react';

export type RankQuoteDisplay={
 connectionName:string;methodLabel:string;targetLabel:string;selectionLabel:string;
 taskCount:number;dispatchCount:number;estimateUsd:string;priceAsOf:string;expiresAt:string;
 expired:boolean;canStart:boolean;
 tasks:readonly {id:string;keyword:string;device:string;maximumUsd:string}[];
};
export type RankCheckViewProps={
 prefix:string;backLabel:string;role:'owner'|'admin'|'editor'|'viewer'|null;
 schedulePurpose:boolean;canConfigureSchedule:boolean;onConfigureSchedule:()=>void;
 phase:'setup'|'review';locked:boolean;reading:boolean;pending:boolean;conflict:boolean;
 error:string;notice:string;selectionLabel:string;canQuote:boolean;
 connections:readonly {id:string;name:string}[];connectionId:string;
 method:'queued'|'live';quote:RankQuoteDisplay|null;
 onConnection:(id:string)=>void;onMethod:(method:'queued'|'live')=>void;
 onQuote:()=>void;onStart:()=>void;onRefresh:()=>void;onBack:()=>void;onRetry:()=>void;onOpenProviders:()=>void;
};

export function RankCheckView(p:RankCheckViewProps):React.JSX.Element{
 const writer=p.role==='owner'||p.role==='admin'||p.role==='editor',hid=p.prefix+'quote-heading',q=p.quote;
```

### R2A — only allowed original span

```tsx
 return <section className="research-panel stack">
  <div className="row"><button type="button" className="btn ghost" disabled={p.locked} onClick={p.onBack}>{p.backLabel}</button></div>
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading check…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry the same request to recover its result.</p> <button type="button" className="btn primary" onClick={p.onRetry}>Retry same request</button></div>}
  {p.conflict&&<div className="banner" role="alert"><p>The saved check changed. Refresh it before continuing.</p> <button type="button" className="btn primary" disabled={p.locked} onClick={p.onRefresh}>Refresh quote</button></div>}
  {p.role===null?(!p.reading&&<p>Check access is unavailable. Return to the tracker to reload access.</p>):p.phase==='setup'?<>
   <h2 id={hid} tabIndex={-1}>Review a rank check</h2>
   <p>{p.selectionLabel}</p>
   {writer&&(!p.schedulePurpose||p.role==='owner')?<form className="card stack" aria-labelledby={hid} onSubmit={e=>{e.preventDefault();p.onQuote();}}>
    <div className="field"><label htmlFor={p.prefix+'connection'}>DataForSEO connection</label>
     <select id={p.prefix+'connection'} value={p.connectionId} disabled={p.locked} onChange={e=>p.onConnection(e.target.value)}>
      <option value="">Choose a connection</option>{p.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    {p.schedulePurpose?<p>Retrieval method: Queued. This quote includes all current keywords and configured devices.</p>:<div className="field"><label htmlFor={p.prefix+'method'}>Retrieval method</label>
     <select id={p.prefix+'method'} value={p.method} disabled={p.locked} onChange={e=>p.onMethod(e.target.value as 'queued'|'live')}>
      <option value="queued">Queued</option><option value="live">Live</option></select></div>}
    <p className="hint">Preparing a quote does not start a paid check. {p.schedulePurpose?'You will review the schedule and approve recurring spending separately.':'Both retrieval methods may incur provider charges.'}</p>
    {p.connections.length===0?(p.role==='owner'
     ?<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onOpenProviders}>Open providers</button>
     :<p className="hint">Ask a workspace owner to configure DataForSEO.</p>)
    :<button type="submit" className="btn primary" disabled={p.locked||p.reading||p.conflict||!p.canQuote||p.connectionId===''}>Prepare quote</button>}
   </form>:<p>{p.schedulePurpose?'Only workspace owners can prepare a recurring-spend approval.':'An editor can prepare a check; only its requester can start it.'}</p>}
  </>:<>
   <h2 id={hid} tabIndex={-1}>Review the maximum charge</h2>
   {q===null?<p>Quote unavailable. Refresh or return to the tracker.</p>:<>
    <div className="card stack">
     <p className="dim" id={p.prefix+'max'}>Maximum total</p>
     <p aria-labelledby={p.prefix+'max'}><strong>{'$'+q.estimateUsd}</strong></p>
     <p>{q.connectionName} · {q.methodLabel}</p>
     <p>{q.targetLabel}</p>
     <p>{q.selectionLabel}</p>
     <p className="dim">{q.taskCount} keyword/device checks · {q.dispatchCount} provider requests</p>
     <p className="dim">Prices checked {q.priceAsOf} · Quote expires {q.expiresAt}</p>
    </div>
    {q.expired&&<p className="notice">This quote expired. Return to the tracker to prepare a new quote.</p>}
    <p className="hint">This is an upper bound, not a final bill. Partial or uncertain provider outcomes remain visible until reconciled.</p>
    <div className="table-wrap" role="region" aria-label="Quoted keyword and device costs" tabIndex={0}>
     <table style={{minWidth:640}}>
      <thead><tr><th>Keyword</th><th>Device</th><th>Maximum charge</th></tr></thead>
      <tbody>{q.tasks.map(t=><tr key={t.id}><td>{t.keyword}</td><td>{t.device}</td><td>{'$'+t.maximumUsd}</td></tr>)}</tbody>
     </table></div>
    {writer&&!q.expired&&!q.canStart&&<p className="hint">Only the requester can start an eligible quote.</p>}
   </>}
   {(q!==null||!p.conflict)&&<div className="row">
    {q!==null&&(p.schedulePurpose?<button type="button" className="btn primary" disabled={p.locked||!p.canConfigureSchedule} onClick={p.onConfigureSchedule}>Configure schedule</button>:<button type="button" className="btn primary" disabled={p.locked||p.conflict||!writer||!q.canStart||q.expired} onClick={p.onStart}>Start paid rank check</button>)}
    {!p.schedulePurpose&&p.canConfigureSchedule&&<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onConfigureSchedule}>Set up recurring checks</button>}
    {!p.conflict&&<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onRefresh}>Refresh quote</button>}
   </div>}
  </>}
 </section>;
```

### Read-only suffix

```tsx

}
```

## Execution cap

One initial K3 maximum-thinking draft capped at420 seconds; at most one separately authorized120-second repair. Stop at deadline/ambiguity; no automatic continuation, model substitution, source application or invented tests. Return only the requested JSON.
