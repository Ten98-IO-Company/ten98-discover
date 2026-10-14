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
 return (
  <section className="research-panel" aria-labelledby={idPrefix + 'heading'} style={{'--control-md':'var(--control-touch)'} as React.CSSProperties}>
   <div className="row between">
    <div style={{minWidth:0}}>
     <h2 id={idPrefix + 'heading'} tabIndex={-1} style={{margin:0}}>Rank schedule</h2>
     <p className="hint">{trackerName}</p>
    </div>
    <div className="row">
     <button type="button" className="btn" onClick={onBack} disabled={locked}>{props.backLabel??'Back to tracker'}</button>
     <button type="button" className="btn" onClick={onRefresh} disabled={locked || busy}>Refresh</button>
    </div>
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
     <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,200px),1fr))',gap:'var(--space-3)',minWidth:0}}>
      <p style={{margin:0}}><strong>{schedule.enabled ? (schedule.approvalStale ? 'Approval needs review' : 'Approved schedule') : 'Schedule disabled'}</strong></p>
      <p style={{margin:0}}>Next due: {schedule.nextDueAt !== null ? schedule.nextDueAt + ' UTC' : 'Not scheduled'}</p>
      {schedule.approval && <p style={{margin:0}}>Maximum per occurrence: <strong>{schedule.approval.maximumUsd + ' USD'}</strong></p>}
     </div>
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
    <section className="card stack" aria-labelledby={idPrefix + 'quote-heading'}>
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
     <form className="card stack" onSubmit={(event) => { event.preventDefault(); onPreview(); }}>
      <fieldset disabled={locked || busy || quote.expired || conflict} style={{minWidth:0,border:0,margin:0,padding:0}}>
       <legend>Schedule settings</legend>
       <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,200px),1fr))',gap:'var(--space-3)',minWidth:0}}>
        <div className="field" style={{margin:0,minWidth:0}}>
         <label htmlFor={idPrefix + 'interval'}>Interval</label>
         <select id={idPrefix + 'interval'} value={form.interval} style={{maxWidth:'100%',width:'100%',minWidth:0,minHeight:'var(--control-touch)'}}
          aria-describedby={form.interval === 'monthly' ? idPrefix + 'monthly-hint' : undefined}
          onChange={(event) => onChange({ ...form, interval:event.target.value as ScheduleForm['interval'], consent:false })}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Month end</option>
         </select>
         {form.interval === 'monthly' && <p className="hint" id={idPrefix + 'monthly-hint'}>Runs on the last calendar day in the selected timezone.</p>}
        </div>
        <div className="field" style={{margin:0,minWidth:0}}>
         <label htmlFor={idPrefix + 'timezone'}>Timezone</label>
         <input id={idPrefix + 'timezone'} type="text" maxLength={100} value={form.timezone} style={{maxWidth:'100%',width:'100%',minWidth:0,minHeight:'var(--control-touch)'}}
          aria-describedby={idPrefix + 'timezone-hint'}
          onChange={(event) => onChange({ ...form, timezone:event.target.value })} />
         <p className="hint" id={idPrefix + 'timezone-hint'}>Use an IANA timezone, such as America/New_York.</p>
        </div>
        <div className="field" style={{margin:0,minWidth:0}}>
         <label htmlFor={idPrefix + 'hour'}>Hour</label>
         <input id={idPrefix + 'hour'} type="number" min={0} max={23} step={1} value={form.hour} style={{maxWidth:'100%',width:'100%',minWidth:0,minHeight:'var(--control-touch)'}}
          onChange={(event) => onChange({ ...form, hour:event.target.value })} />
        </div>
        <div className="field" style={{margin:0,minWidth:0}}>
         <label htmlFor={idPrefix + 'minute'}>Minute</label>
         <input id={idPrefix + 'minute'} type="number" min={0} max={59} step={1} value={form.minute} style={{maxWidth:'100%',width:'100%',minWidth:0,minHeight:'var(--control-touch)'}}
          onChange={(event) => onChange({ ...form, minute:event.target.value })} />
        </div>
        {form.interval === 'weekly' && (
         <div className="field" style={{margin:0,minWidth:0}}>
          <label htmlFor={idPrefix + 'weekday'}>Weekday</label>
          <select id={idPrefix + 'weekday'} value={form.weekday} style={{maxWidth:'100%',width:'100%',minWidth:0,minHeight:'var(--control-touch)'}}
           onChange={(event) => onChange({ ...form, weekday:event.target.value })}>
           {WEEKDAYS.map((name, index) => <option key={name} value={String(index)}>{name}</option>)}
          </select>
         </div>
        )}
       </div>
       <button type="submit" className="btn" disabled={!canPreview} aria-describedby={idPrefix + 'preview-hint'}>Preview occurrences</button>
       <p className="hint" id={idPrefix + 'preview-hint'}>Preview is free and creates no job.</p>
   {preview && (
    <section aria-labelledby={idPrefix + 'preview-heading'}>
     <h3 id={idPrefix + 'preview-heading'}>Next five occurrences</h3>
     <div className="table-wrap" role="region" aria-labelledby={idPrefix + 'preview-heading'} tabIndex={0}>
      <table style={{minWidth:600}}>
       <thead>
        <tr>
         <th scope="col" style={{minWidth:200}}>{'Local time (' + preview.timezone + ')'}</th>
         <th scope="col" style={{minWidth:200}}>UTC</th>
         <th scope="col" style={{minWidth:112}}>UTC offset</th>
        </tr>
       </thead>
       <tbody>
        {preview.occurrences.map((occurrence) => (
         <tr key={occurrence.utc}>
          <td style={{whiteSpace:'nowrap',overflowWrap:'normal'}}>{occurrence.local}</td>
          <td style={{whiteSpace:'nowrap',overflowWrap:'normal'}}>{occurrence.utc}</td>
          <td style={{whiteSpace:'nowrap',overflowWrap:'normal'}}>{formatOffset(occurrence.offsetSeconds)}</td>
         </tr>
        ))}
       </tbody>
      </table>
     </div>
     <p className="hint">{'Calculated at ' + preview.capturedAt + ' UTC. The first occurrence is recalculated when approval is saved. Daylight saving changes follow the selected timezone.'}</p>
    </section>
   )}
       <div className="field">
        <label htmlFor={idPrefix + 'maximum'}>Per-occurrence ceiling (USD)</label>
        <input id={idPrefix + 'maximum'} type="text" inputMode="decimal" maxLength={14} value={form.maximumUsd} style={{maxWidth:'100%'}}
         aria-describedby={idPrefix + 'maximum-hint'}
         onChange={(event) => onChange({ ...form, maximumUsd:event.target.value, consent:false })} />
        <p className="hint" id={idPrefix + 'maximum-hint'}>USD per full occurrence, at least the quoted maximum. This is not a monthly budget.</p>
       </div>
      </fieldset>
      <label htmlFor={idPrefix + 'consent'} style={{display:'flex',alignItems:'flex-start',gap:'var(--space-2)',minHeight:'var(--control-touch)',margin:0,paddingBlock:'var(--space-2)'}}>
       <input id={idPrefix + 'consent'} type="checkbox" checked={form.consent} disabled={locked || busy || quote.expired || conflict} style={{flexShrink:0}}
        onChange={(event) => onChange({ ...form, consent:event.target.checked })} />
       <span>I approve recurring provider charges up to this ceiling per occurrence.</span>
      </label>
      <p className="hint" id={idPrefix + 'approve-hint'}>Each occurrence still requires current owner approval, unchanged tracked scope and available workspace and connection budgets. Saving approval does not run a check immediately.</p>
      <button type="button" className="btn primary" onClick={onApprove} disabled={!canApprove || locked || busy} aria-describedby={idPrefix + 'approve-hint'}>Approve recurring spend</button>
     </form>
    </>
   )}
  </section>
 );
}
