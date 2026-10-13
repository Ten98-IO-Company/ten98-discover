# R02b — Rank check results and retained receipts

Public Kimi presentation contract. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"R2B","replacement":"exact replacement text"}]}. Only R2B in src/components/RankCheckResults.tsx may change. GPT applies and independently validates. Skill-only drafting; no source access or execution. This is static design review, including existing synthetic screenshots, not fresh tested acceptance.

## Scope and real flow

Freeze imports/types/locals/helpers and the final component brace. R2B covers the role-null early return and known-role component return, not a nested map return. In the role-null return ONLY the root div's style may change; leave its entire condition, children and fallback exact. No hooks/state/helpers/abstractions/dependencies/API/CSS files/controller edits. RankTrackingView is another agent's work.

RankTrackingPanel mounts RankCheckPanel from tracker/history/observations/reporting/schedule; dynamic Back labels preserve the mounted parent and focused return. RankCheckPanel is user/workspace/project/tracker keyed, verifies API responses/current role, and passes already formatted strings. It owns immutable write intent, same-request retry, stale-read denial, bounded free polling and irreversible quote/retention expiry. Server rank-execution reserves each paid dispatch atomically at explicit start; rank-reconciliation permits owner-only captured-account recovery without paid resubmission or unpausing spending. This view must neither implement nor imply those side effects.

Current results put three tall timestamp fields before financial status and rank rows. Cancel appears after an arbitrarily long observation table. History has a separate Back row and action row. Goal: compact navigation, visible charge qualifications and cancellation at the decision point, then observations, then complete receipt detail. No data or action is retired.

## Exact design

1. Both existing return roots may gain render-local style with '--control-md':'var(--control-touch)' cast as React.CSSProperties. This reuses the 44px token for descendant native buttons/selects without touching frozen b or global styles. Known-role root also display:grid, gap:var(--space-3), minWidth:0. Use existing research-panel/stack/card/row/btn/hint/alert/notice/table-wrap and semantic tokens. No new classes, CSS file, fixed heights, overflow clipping, sticky/fixed bars or tiny type.
2. Known-role header: one wrapping row, space-between, alignItems:flex-start, minWidth:0. Exactly one phase-appropriate h2 with unchanged hd and literal text. Group the existing Back plus phase-appropriate Refresh/Prepare OR Check history/Refresh actions alongside it. Move each existing b call once; preserve every argument, label and guard. Header precedes alerts. Error/notice/loading/pending recovery remain visible outside cards; retry's false disabled argument is intentional and must remain.
3. History: preserve the entire named history scroll region, table, rows and row callbacks, empty-state condition and Load more condition/lock. No collapsed history, invented empty result, new sorting/filtering or pagination. Only compact surrounding margins; section remains valid with pending/read/error/empty pages.
4. Run: compact current summary card with marginBottom:0 and gap:var(--space-3). Keep outcome pill, method, full selection and target. Present the three existing financial spans together in a wrapping row or responsive native grid; remove their .field margin rather than increasing density through smaller text. Retain their complete literal/expression text. All uncertain/pending/not_started paragraphs and run diagnostic remain immediately with this financial summary, fully visible. No success coloring for uncertain/final/zero, and no client-side totals or status normalization.
5. Move the exact guarded Cancel undispatched work subtree from below the observations to directly after the summary and before retention notices/observations. It may gain a wrapping row container. Button and the exact dispatched-work/charges consequence stay adjacent and visible together; keep w&&r.canCancel and all b arguments. No new confirmation or disabled rule.
6. Keep expired/rawExpired notices before the unchanged named Rank observations scroll region. An h3 'Rank observations' may label the visible section. Preserve all seven columns, exact task map/keys/values and empty-observations condition. Ranking URL stays plain text; do not create links. No cards-per-row, truncation, virtual rows or hiding unavailable/expired cells.
7. Move the complete Created/Started/Completed timestamp row AFTER observations and their empty-state paragraph, BEFORE recovery/dispatches. Retain each label and formatted value exactly, and remove .field margins. Use a compact wrapping row/grid; every timestamp stays visible even when observations expired. No disclosure or extra state.
8. Keep owner recovery card and Provider request charges table together beneath the timestamp row. An h3 'Provider request charges' may precede the card. Preserve owner && dispatches.some guard, exact connection label/select/options/value/disabled/onChange, account-evidence hint and no-connections Open providers action. Preserve every dispatch cell, diagnostic and row recovery callback/lock. No financial/recovery data or action may be collapsed. Keep both table minWidth720 values, names and tabIndex0 via rg/tw; narrow overflow belongs to the named region, never the page.

Only new visible copy permitted: the two optional section headings named above. Preserve all existing content once, callback source bodies/arguments, conditional permissions, disabled expressions, controlled props, IDs, table names and keys. Pure layout wrappers may change; no additional renderer/helper or derived variables.

## Independent acceptance after application

Keep all 12 existing tests/rank-check-browser.mjs groups and assertions: exact free quote/paid binding; unknown/lost/429/malformed write retries with identical body after expiry and one dispatch; cancellation vs held reads/writes; owner-only free recovery and unknown != zero; irreversible task/run expiry retaining financial evidence; malformed subset binding; viewer/current-role/403 stale purge; mobile keyboard Back; observations/reporting return preserving filters/focus; skipped scheduled receipt without invented quote; separate recurring approval and immutable quote expiry. The real Router/controller fixture remains in use. Do not weaken an assertion to accept layout.

Add focused leaf/controller presentation coverage, reusing existing tooling and synthetic loopback interception: one header heading/back/action instance in each phase; heading focus still lands before subsequent clicks; DOM order financial warning -> eligible cancellation+consequence -> observation table -> timestamps -> recovery/charges. Populate many rows to prove cancellation is not below the table; all mapped rows/cells and six-decimal currency strings remain exact. Unknown charges with known $0.000000 must still say not final/Unconfirmed. Include skipped, pending, final, uncertain, not_started, no observations, full expiry, raw-only expiry, diagnostics, null/loading/error/unknown role and owner/admin/editor/viewer branches. Null/denied cannot disclose stale records. No new GET/POST triggered by presentation; recover never invokes paid start.

320/360/768/1440, long names/keywords/URLs/diagnostics, LTR/RTL, CSS layout zoom200% and forced colors: no page overflow; all controls >=44px; full labels/values remain readable; first keyword column must not become a one-character vertical strip. Both result tables and history region remain keyboard reachable and genuinely scroll horizontally when needed, with visible focus and intact accessible names. Inspect current, uncertain, expired, empty and history screenshots. CSS zoom is a layout probe, not complete assistive-technology certification. No DB/provider/live-preview calls. This brief itself runs no tests.

## Exact input integrity

Source SHA256: 73C4A2DA09EAAB94FC861E7D77FC837A11C9881F73C4898EFC1AE82E35F62524.
R2B SHA256 (exact UTF-8 bytes, excluding the separating LF before the closing Markdown fence): 0048F58B553B6C24A22E13F5C8D19034FD63B4A59911061D6CD9EAC9A8EDC8D6.
Component-return boundaries were selected by unique line anchors. Read-only prefix + R2B + read-only suffix reconstruct the source exactly. Both fences start/end on standalone lines. Everything outside R2B is frozen.

### Read-only prefix: exact types and existing helper context

```tsx
import type * as React from 'react';
export type RankHistoryDisplay={id:string;createdAt:string;method:string;selection:string;status:string;cost:string;availability:string};
export type RankResultDisplay={status:string;target:string;method:string;selection:string;estimateUsd:string;knownChargeUsd:string;
 costStatus:'not_started'|'pending'|'uncertain'|'final';createdAt:string;startedAt:string;completedAt:string;
 diagnostic:string|null;expired:boolean;rawExpired:boolean;canCancel:boolean;
 tasks:readonly {id:string;keyword:string;device:string;outcome:string;position:string;coverage:string;observedAt:string;rankingUrl:string|null}[];
 dispatches:readonly {id:string;label:string;status:string;estimateUsd:string;actualUsd:string|null;canRecover:boolean;diagnostic:string|null}[]};
export type RankCheckResultsProps={prefix:string;backLabel:string;role:'owner'|'admin'|'editor'|'viewer'|null;phase:'history'|'run';
 locked:boolean;reading:boolean;pending:boolean;error:string;notice:string;loaded:boolean;
 history:readonly RankHistoryDisplay[];nextCursor:string|null;run:RankResultDisplay|null;
 canPrepare:boolean;connections:readonly {id:string;name:string}[];recoveryConnectionId:string;
 onPrepare:()=>void;onOpen:(id:string)=>void;onMore:()=>void;onRefresh:()=>void;onBack:()=>void;onHistory:()=>void;
 onRetry:()=>void;onCancel:()=>void;onRecoveryConnection:(id:string)=>void;onRecover:(id:string)=>void;onOpenProviders:()=>void};
export function RankCheckResults(p:RankCheckResultsProps):React.JSX.Element{
 const w=p.role==='owner'||p.role==='admin'||p.role==='editor',r=p.run;
 const hd={id:p.prefix+'results-heading',tabIndex:-1} as const,rg={className:'table-wrap',role:'region',tabIndex:0} as const,tw={minWidth:720};
 const b=(t:string,f:()=>void,d:boolean,c:string='btn ghost')=><button type="button" className={c} onClick={f} disabled={d}>{t}</button>;
```

### R2B — only allowed original span

```tsx
 if(p.role===null)return <div className="research-panel stack">{b(p.backLabel,p.onBack,p.locked)}{p.reading?<p role="status">Loading checks…</p>:<p className="alert" role="alert">{p.error||'Access is unavailable. Return to the tracker to reload access.'}</p>}</div>;
 return <div className="research-panel stack">
  {b(p.backLabel,p.onBack,p.locked)}
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading checks…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry the same request to recover its result.</p>{b('Retry same request',p.onRetry,false,'btn primary')}</div>}
  {p.phase==='history'?<>
   <h2 {...hd}>Rank check history</h2>
   <div className="row">{b('Refresh checks',p.onRefresh,p.locked)}{p.canPrepare&&w&&b('Prepare a rank check',p.onPrepare,p.locked,'btn primary')}</div>
   <div {...rg} aria-label="Rank check history"><table style={tw}>
    <thead><tr><th>Created</th><th>Method</th><th>Scope</th><th>Outcome</th><th>Costs</th><th>Data</th></tr></thead>
    <tbody>{p.history.map(h=><tr key={h.id}><td><button type="button" className="btn ghost" onClick={()=>p.onOpen(h.id)} disabled={p.locked}>{h.createdAt}</button></td><td>{h.method}</td><td>{h.selection}</td><td>{h.status}</td><td>{h.cost}</td><td>{h.availability}</td></tr>)}</tbody>
   </table></div>
   {p.loaded&&p.error===''&&p.history.length===0&&<p className="dim">No rank checks yet.</p>}
   {p.nextCursor!==null&&b('Load more checks',p.onMore,p.locked||p.reading)}
  </>:<>
   <h2 {...hd}>Rank check result</h2>
   <div className="row">{b('Check history',p.onHistory,p.locked)}{b('Refresh check',p.onRefresh,p.locked)}</div>
   {r===null?(!p.reading&&<p className="dim">Check unavailable.</p>):<>
    <div className="card stack">
     <div className="row between"><span className="pill">{r.status}</span><span className="dim">{r.method} · {r.selection}</span></div>
     <p>{r.target}</p>
     <div className="row between"><span className="field">Created {r.createdAt}</span><span className="field">Started {r.startedAt}</span><span className="field">Completed {r.completedAt}</span></div>
     <div className="row between"><span className="field">{r.status==='skipped'?'No quote applied':'Quoted maximum $'+r.estimateUsd}</span><span className="field">Known charges ${r.knownChargeUsd}</span><span className="field">Charge status {r.costStatus}</span></div>
     {r.costStatus==='uncertain'&&<p className="alert" role="alert">Some charges are unresolved. Known charges are not the final total. Recovery does not submit another paid check or unpause spending.</p>}
     {r.costStatus==='pending'&&<p className="hint">The provider is still processing work or confirming charges. Known charges are not the final total.</p>}
     {r.costStatus==='not_started'&&<p className="hint">{r.status==='skipped'?'No paid check started.':'This check has not started.'}</p>}
     {r.diagnostic!==null&&<p className="alert" role="alert">{r.diagnostic}</p>}
    </div>
    {r.expired&&<p className="notice" role="status">Rank observations expired under workspace retention. The check outcome and financial receipt remain.</p>}
    {r.rawExpired&&!r.expired&&<p className="hint">Raw provider evidence expired; retained rank observations are shown below.</p>}
    <div {...rg} aria-label="Rank observations"><table style={tw}>
     <thead><tr><th>Keyword</th><th>Device</th><th>Outcome</th><th>Position</th><th>Coverage</th><th>Observed</th><th>Ranking URL</th></tr></thead>
     <tbody>{r.tasks.map(t=><tr key={t.id}><td>{t.keyword}</td><td>{t.device}</td><td>{t.outcome}</td><td>{t.position}</td><td>{t.coverage}</td><td>{t.observedAt}</td><td>{t.rankingUrl??'—'}</td></tr>)}</tbody>
    </table></div>
    {r.tasks.length===0&&!r.expired&&<p className="dim">No rank observations are available for this receipt.</p>}
    {w&&r.canCancel&&<>{b('Cancel undispatched work',p.onCancel,p.locked)}<p className="hint">Only work not yet sent can be cancelled; dispatched work and charges remain.</p></>}
    {p.role==='owner'&&r.dispatches.some(d=>d.canRecover)&&<div className="card stack">
     <label className="field" htmlFor={p.prefix+'recovery'}>Recovery DataForSEO connection</label>
     <select id={p.prefix+'recovery'} value={p.recoveryConnectionId} onChange={e=>p.onRecoveryConnection(e.target.value)} disabled={p.locked}>
      <option value="">Choose connection</option>{p.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select>
     <p className="hint">Use the provider account that received this check. The server verifies eligibility and evidence.</p>
     {p.connections.length===0&&b('Open providers',p.onOpenProviders,p.locked)}
    </div>}
    <div {...rg} aria-label="Provider request charges"><table style={tw}>
     <thead><tr><th>Request</th><th>State</th><th>Maximum</th><th>Confirmed charge</th><th>Recovery</th></tr></thead>
     <tbody>{r.dispatches.map(d=><tr key={d.id}><td>{d.label}</td><td>{d.status}{d.diagnostic!==null&&<p className="hint">{d.diagnostic}</p>}</td><td>${d.estimateUsd}</td><td>{d.actualUsd===null?'Unconfirmed':'$'+d.actualUsd}</td><td>{p.role==='owner'&&d.canRecover?b('Recover '+d.label,()=>p.onRecover(d.id),p.locked||p.recoveryConnectionId===''):'—'}</td></tr>)}</tbody>
    </table></div>
   </>}
  </>}
 </div>;
```

### Read-only suffix

```tsx

}
```

## Execution cap

One initial K3 maximum-thinking draft, 420-second wall-clock cap; at most one separately authorized repair capped at120 seconds. Stop at deadline/ambiguity; no automatic continuation, extra model, source application or claimed test result. Return the requested JSON only.
