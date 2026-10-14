# R05 — Rank schedule: status, calendar review, spending approval

Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"R5","replacement":"exact replacement text"}]}. Only R5 in src/components/RankScheduleView.tsx changes; GPT applies/validates. Approved Skill tools only. K3 maximum-thinking initial420 seconds, at most one separately authorized120-second repair. Stop on ambiguity/deadline; no automatic continuation/application.

## Scope

Static review only, no fresh test pass. Sole view caller RankSchedulePanel; parent RankTrackingPanel enters from tracker or RankCheckPanel purpose=schedule with full quote/earliest expiry. Preserve dynamic Back and hidden-mounted parent report/history.

Freeze prefix/suffix and all controllers/callers/helpers/state/APIs/shared CSS/dependencies. Preserve every string/value/handler/condition/disabled expression, whitespace formatting only. Only specified styles/wrappers/subtree moves; no new copy, disclosure, parsing or derived capabilities.

## Approved layout

1. Root research-panel stack retains section/aria-labelledby; style={{'--control-md':'var(--control-touch)'} as React.CSSProperties} sets native controls44px locally. No other token overrides. Compact wrapping row between header groups unchanged h2/id/tabIndex, full trackerName hint and existing Back/Refresh nested row; h2 margin0 allowed. Busy/error/notice/pending/conflict stay below header before content, with original roles.

2. Current schedule first: group existing status/Next due/optional saved maximum compactly using row or native auto-fit grid. Keep h3/id, all status/UTC/fallbacks, every stale reason, and initially closed mounted Current grant details/dl. Disable and its exact consequence/aria-describedby remain together outside details; non-owner explanation stays visible. Disabled schedule may retain approval; never hide it or imply future work. No duplicated values/giant metrics.

3. Owner-ready/no-quote becomes card stack with existing heading, free-view qualification and one Prepare. Owner-ready/quote keeps quote card BEFORE form: exact maximum+USD, target, count, expiry+UTC and conditional expired warning/Prepare. No new status or inferred approval.

4. Existing form becomes card stack. Preserve onSubmit and ONE fieldset with same disabled expression/controls. Retain minWidth:0; border:0,margin:0,padding:0 allowed. Keep legend Schedule settings. Interval/Timezone/Hour/Minute/conditional Weekday join native grid: repeat(auto-fit,minmax(min(100%,200px),1fr)), gap var(--space-3), minWidth:0; .field margin0 allowed. Remove only hour/minute row wrapper. All field attrs/labels/hints/handlers unchanged; monthly/IANA hints stay with their fields. One column at320/360.

5. Inside that fieldset after calendar grid, group existing Preview occurrences + free hint. Move COMPLETE preview&& section into fieldset immediately AFTER this hint; it is read-only output, no added disabled control. Preserve heading/id, named tabIndex0 region, rows/map key, calculated-at/first-occurrence/DST qualifications. Table minWidth600; th minimums200/200/112px. Date/offset td whiteSpace:nowrap,overflowWrap:normal; timezone header wraps full text. Exactly one labelled horizontal scroll region.

6. Move entire Per-occurrence ceiling field+USD hint immediately AFTER preview, INSIDE same fieldset; close fieldset before consent as originally. Consent/approval stay outside with exact own guards. Replace consent row/separate label with ONE associated label wrapping unchanged checkbox/exact text; preserve id/htmlFor. Label flex, gap var(--space-2), minHeight:var(--control-touch), margin0,paddingBlock:var(--space-2); full wrapping text clickable. Do not enlarge checkbox to44px/duplicate labels. Approval qualification remains adjacent above button with aria-describedby. Calendar evidence thus precedes ceiling/consent/approval; no auto-consent/implicit approval/dialog.

Keep existing button classes, native details marker/display:list-item. No fixed heights, clipping, ellipsis or hidden data.

## Frozen contracts

Every original handler, branch and disabled expression stays token-identical; no added behavioral guards. Moving read-only preview into fieldset must not change any existing control’s effective disabled state.

Controller frozen: only current owner manages. Auth loss purges; stale scope cannot restore. Foreign/started/subset/live/nonmanual quote unavailable versus expired; exact USD/task/expiry verification stays. Server owns recurrence/DST. Explicit preview free; calendar edit clears preview+consent, ceiling edit clears consent. Approval needs valid fresh preview, consent, ceiling>=quote. Per-occurrence, not monthly budget; owner/scope/workspace+connection budgets rechecked each run. Save starts no check.

Unknown approve/disable retries identical requestId/revision/body even after expiry; pending/write locks navigation/refresh/edit/new approval.403 purges,409 reloads,408/429/5xx/lost/malformed ack recovers. Disable confirms future/unsent stop, retaining sent charges. Dirty confirmation/router/beforeunload/focus/escaping and all server contracts unchanged.

## GPT acceptance; no execution claim

- Preserve all6 original rank-schedule-browser.mjs groups and every assertion, especially identical unknown-write retry bodies after expiry, navigation locks, authorization purge, conflicts, and consent invalidation.
- Loading/null/manual-disabled/approved/stale/retained approval; owner/admin/editor/viewer/demotion. Current status/next due/saved maximum precede setup; ordinary360 status starts before400px. No-quote one Prepare/no editable form. Expired warning+Prepare and disabled controls; pending original retry retained. Recovery/conflict/disable consequences visible.
- Daily/weekly/month-end exact fields/hints. Exact USD/target/count/UTC expiry, five local/UTC/offset rows(+05:30/second-offset), all qualifications. Preview precedes ceiling/consent/approval; edits reset correct consent/preview. Earliest expiry never extends; exact save/disable/retry bodies unchanged. Viewing/details/reflow causes no write.
- Visible buttons/inputs/selects/summary/consent label >=44px at320/360/768/1440; pending/working/loading/expired/conflict/canX guards retained. Heading focus before details; native Enter/Space toggles metadata without request/draft loss; label/Space changes consent only.
- LTR/RTL, CSS200% layout zoom, forced colors, long tracker/provider/target/timezone/amounts: no document overflow/lost data; multiple calendar columns1440/one360; legible date/offset/short words; keyboard region scrolling. Fresh initial/approved/read-only/preview/pending desktop/mobile screenshots, TypeScript/diff checks. No production build/server/DB/provider work.

## Exact source boundary

Whole-file SHA256: 950F97E3523B0C4B394B964589483EFDE41866EE33A50CC508A10EDCA17EE290. R5 lines39–214, SHA256: 2F5B3C0A9CDA932D9B2ADEE9BD9E16BA09CACFC5507ED5AD8A4FA7E3F3E8683E. The unique component return below ends with its matching closing parenthesis/semicolon plus LF, never a nested return. Prefix + R5 + suffix round-trip byte-for-byte. Return only R5 replacement including final LF.

### Read-only exact original prefix

```tsx
import type * as React from 'react';

export type ScheduleForm = { interval:'daily'|'weekly'|'monthly'; timezone:string; hour:string; minute:string; weekday:string; maximumUsd:string; consent:boolean };
export type ScheduleInfo = { enabled:boolean; approvalStale:boolean; interval:'manual'|'daily'|'weekly'|'monthly'; timezone:string|null; hour:number|null; minute:number|null; weekday:number|null; nextDueAt:string|null; approval:null|{id:string;approvedAt:string|null;approvedByUserId:string;maximumUsd:string;connectionId:string;connectionName?:string}; staleReasons:string[] };
export type ScheduleQuote = { id:string; targetText:string; taskCount:number; estimateUsd:string; expiresAt:string; expired:boolean };
export type SchedulePreview = { capturedAt:string; timezone:string; occurrences:{utc:string;local:string;offsetSeconds:number}[] };
export type RankScheduleViewProps = {
 idPrefix:string; backLabel?:string; trackerName:string; schedule:ScheduleInfo|null; quote:ScheduleQuote|null; preview:SchedulePreview|null;
 form:ScheduleForm; canManage:boolean; loading:boolean; working:boolean; locked:boolean; pending:boolean; conflict:boolean;
 canApprove:boolean; canPreview:boolean; canDisable:boolean; error:string; notice:string;
 onChange:(value:ScheduleForm)=>void; onPreview:()=>void; onApprove:()=>void; onDisable:()=>void;
 onRetry:()=>void; onRefresh:()=>void; onBack:()=>void; onPrepareQuote:()=>void;
};

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const INTERVAL_LABELS: Record<ScheduleInfo['interval'],string> = { manual:'Manual', daily:'Daily', weekly:'Weekly', monthly:'Month end' };
const STALE_REASONS: Record<string,string> = {
 disabled:'Schedule is disabled.',
 archived:'Tracker is archived.',
 approver_no_longer_owner:'The approving user is no longer an owner.',
 connection_changed:'The provider connection changed.',
 definition_changed:'The tracked definition changed.',
};

function formatOffset(seconds:number): string {
 const sign = seconds < 0 ? '-' : '+';
 const abs = Math.abs(seconds);
 const base = sign + String(Math.floor(abs / 3600)).padStart(2,'0') + ':' + String(Math.floor((abs % 3600) / 60)).padStart(2,'0');
 const rest = abs % 60;
 return rest === 0 ? base : base + ':' + String(rest).padStart(2,'0');
}

export function RankScheduleView(props:RankScheduleViewProps): React.JSX.Element {
 const { idPrefix, trackerName, schedule, quote, preview, form, canManage, loading, working, locked, pending, conflict,
  canApprove, canPreview, canDisable, error, notice,
  onChange, onPreview, onApprove, onDisable, onRetry, onRefresh, onBack, onPrepareQuote } = props;
 const busy = loading || working;
 const ownerReady = canManage && schedule !== null;
```

### R5 — only allowed original span

```tsx
 return (
  <section className="research-panel" aria-labelledby={idPrefix + 'heading'}>
   <h2 id={idPrefix + 'heading'} tabIndex={-1}>Rank schedule</h2>
   <p className="hint">{trackerName}</p>
   <div className="row">
    <button type="button" className="btn" onClick={onBack} disabled={locked}>{props.backLabel??'Back to tracker'}</button>
    <button type="button" className="btn" onClick={onRefresh} disabled={locked || busy}>Refresh</button>
   </div>
   {busy && <p role="status">{loading ? 'Loading schedule\u2026' : 'Saving schedule\u2026'}</p>}
   {error !== '' && <p className="alert" role="alert">{error}</p>}
   {notice !== '' && <p role="status">{notice}</p>}
   {pending && (
    <div className="alert" role="alert">
     <p>The outcome is unknown. Retry the same request to recover its receipt. Do not create another approval.</p>
     <button type="button" className="btn" onClick={onRetry} disabled={working}>Retry same request</button>
    </div>
   )}
   {conflict && <p className="alert" role="alert">The tracker changed. Reload before approving another schedule.</p>}
   {schedule && (
    <section className="card stack" aria-labelledby={idPrefix + 'current-heading'}>
     <h3 id={idPrefix + 'current-heading'}>Current schedule</h3>
     <p><strong>{schedule.enabled ? (schedule.approvalStale ? 'Approval needs review' : 'Approved schedule') : 'Schedule disabled'}</strong></p>
     <p>Next due: {schedule.nextDueAt !== null ? schedule.nextDueAt + ' UTC' : 'Not scheduled'}</p>
     {schedule.approval && <p>Maximum per occurrence: <strong>{schedule.approval.maximumUsd + ' USD'}</strong></p>}
     <details>
      <summary>Current grant details</summary>
      <dl>
      <dt>Interval</dt>
      <dd>{INTERVAL_LABELS[schedule.interval]}</dd>
      <dt>Timezone</dt>
      <dd>{schedule.timezone ?? 'Not recorded'}</dd>
      <dt>Time</dt>
      <dd>{schedule.hour !== null && schedule.minute !== null ? String(schedule.hour).padStart(2,'0') + ':' + String(schedule.minute).padStart(2,'0') : 'Not recorded'}</dd>
      {schedule.interval === 'weekly' && (
       <>
        <dt>Weekday</dt>
        <dd>{schedule.weekday !== null ? WEEKDAYS[schedule.weekday] : 'Not recorded'}</dd>
       </>
      )}
      {schedule.approval && (
       <>
        <dt>Provider connection</dt>
        <dd>{schedule.approval.connectionName ?? 'Saved provider connection'}</dd>
        <dt>Approved at</dt>
        <dd>{schedule.approval.approvedAt ?? 'Not recorded'}</dd>
       </>
      )}
      </dl>
     </details>
     {schedule.approvalStale && schedule.staleReasons.length > 0 && (
      <ul>
       {schedule.staleReasons.map((reason) => <li key={reason}>{STALE_REASONS[reason] ?? 'Approval needs a fresh review.'}</li>)}
      </ul>
     )}
     {canManage ? (
      <>
       <p className="hint" id={idPrefix + 'disable-hint'}>Disabling stops future scheduled requests, including work not yet sent. Requests already sent and their charges remain.</p>
       <button type="button" className="btn" onClick={onDisable} disabled={!canDisable || locked || working} aria-describedby={idPrefix + 'disable-hint'}>Disable schedule</button>
      </>
     ) : (
      <p className="hint">Only workspace owners can approve or disable recurring spending.</p>
     )}
    </section>
   )}
   {ownerReady && !quote && (
    <section aria-labelledby={idPrefix + 'quote-heading'}>
     <h3 id={idPrefix + 'quote-heading'}>Full queued quote</h3>
     <p className="hint">A full queued quote is required to approve or renew a schedule. Viewing this screen starts no check.</p>
     <button type="button" className="btn primary" onClick={onPrepareQuote} disabled={locked || busy}>Prepare full queued quote</button>
    </section>
   )}
   {ownerReady && quote && (
    <>
     <section className="card stack" aria-labelledby={idPrefix + 'quote-heading'}>
      <h3 id={idPrefix + 'quote-heading'}>Full queued quote</h3>
      <p>Quoted maximum: <strong>{quote.estimateUsd + ' USD'}</strong></p>
      <p>{quote.targetText}</p>
      <p className="hint">{quote.taskCount + ' keyword/device checks · Expires ' + quote.expiresAt + ' UTC'}</p>
      {quote.expired && (
       <>
        <p className="alert" role="alert">This quote expired. Prepare another full queued quote.</p>
        <button type="button" className="btn" onClick={onPrepareQuote} disabled={locked || busy}>Prepare full queued quote</button>
       </>
      )}
     </section>
     <form onSubmit={(event) => { event.preventDefault(); onPreview(); }}>
      <fieldset disabled={locked || busy || quote.expired || conflict} style={{minWidth:0}}>
       <legend>Schedule settings</legend>
       <div className="field">
        <label htmlFor={idPrefix + 'interval'}>Interval</label>
        <select id={idPrefix + 'interval'} value={form.interval} style={{maxWidth:'100%'}}
         aria-describedby={form.interval === 'monthly' ? idPrefix + 'monthly-hint' : undefined}
         onChange={(event) => onChange({ ...form, interval:event.target.value as ScheduleForm['interval'], consent:false })}>
         <option value="daily">Daily</option>
         <option value="weekly">Weekly</option>
         <option value="monthly">Month end</option>
        </select>
        {form.interval === 'monthly' && <p className="hint" id={idPrefix + 'monthly-hint'}>Runs on the last calendar day in the selected timezone.</p>}
       </div>
       <div className="field">
        <label htmlFor={idPrefix + 'timezone'}>Timezone</label>
        <input id={idPrefix + 'timezone'} type="text" maxLength={100} value={form.timezone} style={{maxWidth:'100%'}}
         aria-describedby={idPrefix + 'timezone-hint'}
         onChange={(event) => onChange({ ...form, timezone:event.target.value })} />
        <p className="hint" id={idPrefix + 'timezone-hint'}>Use an IANA timezone, such as America/New_York.</p>
       </div>
       <div className="row">
       <div className="field">
        <label htmlFor={idPrefix + 'hour'}>Hour</label>
        <input id={idPrefix + 'hour'} type="number" min={0} max={23} step={1} value={form.hour} style={{maxWidth:'100%'}}
         onChange={(event) => onChange({ ...form, hour:event.target.value })} />
       </div>
       <div className="field">
        <label htmlFor={idPrefix + 'minute'}>Minute</label>
        <input id={idPrefix + 'minute'} type="number" min={0} max={59} step={1} value={form.minute} style={{maxWidth:'100%'}}
         onChange={(event) => onChange({ ...form, minute:event.target.value })} />
       </div>
       </div>
       {form.interval === 'weekly' && (
        <div className="field">
         <label htmlFor={idPrefix + 'weekday'}>Weekday</label>
         <select id={idPrefix + 'weekday'} value={form.weekday} style={{maxWidth:'100%'}}
          onChange={(event) => onChange({ ...form, weekday:event.target.value })}>
          {WEEKDAYS.map((name, index) => <option key={name} value={String(index)}>{name}</option>)}
         </select>
        </div>
       )}
       <div className="field">
        <label htmlFor={idPrefix + 'maximum'}>Per-occurrence ceiling (USD)</label>
        <input id={idPrefix + 'maximum'} type="text" inputMode="decimal" maxLength={14} value={form.maximumUsd} style={{maxWidth:'100%'}}
         aria-describedby={idPrefix + 'maximum-hint'}
         onChange={(event) => onChange({ ...form, maximumUsd:event.target.value, consent:false })} />
        <p className="hint" id={idPrefix + 'maximum-hint'}>USD per full occurrence, at least the quoted maximum. This is not a monthly budget.</p>
       </div>
       <button type="submit" className="btn" disabled={!canPreview} aria-describedby={idPrefix + 'preview-hint'}>Preview occurrences</button>
       <p className="hint" id={idPrefix + 'preview-hint'}>Preview is free and creates no job.</p>
      </fieldset>
   {preview && (
    <section aria-labelledby={idPrefix + 'preview-heading'}>
     <h3 id={idPrefix + 'preview-heading'}>Next five occurrences</h3>
     <div className="table-wrap" role="region" aria-labelledby={idPrefix + 'preview-heading'} tabIndex={0}>
      <table>
       <thead>
        <tr>
         <th scope="col">{'Local time (' + preview.timezone + ')'}</th>
         <th scope="col">UTC</th>
         <th scope="col">UTC offset</th>
        </tr>
       </thead>
       <tbody>
        {preview.occurrences.map((occurrence) => (
         <tr key={occurrence.utc}>
          <td>{occurrence.local}</td>
          <td>{occurrence.utc}</td>
          <td>{formatOffset(occurrence.offsetSeconds)}</td>
         </tr>
        ))}
       </tbody>
      </table>
     </div>
     <p className="hint">{'Calculated at ' + preview.capturedAt + ' UTC. The first occurrence is recalculated when approval is saved. Daylight saving changes follow the selected timezone.'}</p>
    </section>
   )}

      <div className="row">
       <input id={idPrefix + 'consent'} type="checkbox" checked={form.consent} disabled={locked || busy || quote.expired || conflict}
        onChange={(event) => onChange({ ...form, consent:event.target.checked })} />
       <label htmlFor={idPrefix + 'consent'}>I approve recurring provider charges up to this ceiling per occurrence.</label>
      </div>
      <p className="hint" id={idPrefix + 'approve-hint'}>Each occurrence still requires current owner approval, unchanged tracked scope and available workspace and connection budgets. Saving approval does not run a check immediately.</p>
      <button type="button" className="btn primary" onClick={onApprove} disabled={!canApprove || locked || busy} aria-describedby={idPrefix + 'approve-hint'}>Approve recurring spend</button>
     </form>
    </>
   )}
  </section>
 );
```

### Read-only exact original suffix

```tsx
}
```
