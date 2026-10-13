Load Ponytail from the supplied Skill-only profile. Initial draft cap12minutes; total batch cap15minutes including at most two bounded repairs. All provided public source below is the sole task input.

Implement approved presentation batch A02 using verified Kimi K3, thinking enabled, maximum effort. Draft only, no tools except explicitly permitted curated Skill reading. No shell/filesystem/network/subagents/API/DB/provider/account/publication. Deadline 15 minutes total including at most two repairs; stop at first bound with partial evidence. No automatic continuation/model substitution.

Return one JSON object with `replacements`: exactly five objects `{ "id": "S1", "new": "..." }` through S5. Each new string is replacement TSX; S5 empty. No code fence/explanation/full file. GPT verifies hashes, applies and tests. Unsupplied source is frozen.

Only src/components/AIComparisonView.tsx may change. Keep all exported types/functions/controls/capability expressions/callback arguments/state branches. No imports, new functions/hooks/effects, arithmetic/parsing, API/controller/route/CSS/dependency edits. No function or parity removal. Markup/style/order only.

Audience/job: analyst compares equivalent prompt/model/settings cells, then opens evidence or exports the whole comparison. Compact research table, system typography, restrained semantic tokens. Signature: equal-cell rates followed by paired current/previous coverage and exact evidence. No score tiles/charts/hero/icons/gradient/shadow/abstraction.

Existing tokens: --color-text, --color-text-muted, --color-surface, --color-surface-subtle, --color-border, --color-border-control, --color-accent, --color-focus, --color-disabled-text, --color-disabled-surface; --space-2, --space-3, --space-4, --space-6; --text-xs, --text-sm, --text-lg; --radius-sm, --radius-md; --control-touch. Use var() for colors/spacing. Preserve minHeight44 controls, numeric table widths/responsive minmax. Use logical margins/borders/padding. Global focus/disabled/table/field styling exists. Classes: research-panel, stack, row, between, field, hint, alert, btn, btn ghost, table. btn is neutral outlined; ghost quiet. No unsupported modifier. Global field margin-bottom18px, p margin-bottom10px, h3 browser margins; compact locally. row wraps, between justifies apart. Text stays inert React children.

DOM: heading/actions → whole-export helper if authorized → error/notice/loading/export status → applied filters/compact cohort form → visible report scope/snapshot/cohort/status/basis/warnings/provenance → unchanged equal-cell rates table → Period coverage → unchanged Comparison evidence/tables/pager. Export moves once to header.

S1: Keep style-constant names. controlStyle stays minHeight44/maxWidth100%; nowrapStyle/scrollRegionStyle semantics unchanged. Keep wrapping wrapRowStyle. formStyle becomes wrapping flex row with alignItems:flex-end, token gap, width100%/minWidth0; Applied filters spans first row. coverageGridStyle retains auto-fit,minmax(min(100%,240px),1fr), token gap. coverageCardStyle becomes plain column: minWidth0, subtle 1px solid var(--color-border) borderBlockStart, var(--space-3) paddingBlock; no card background/radius. No fixed heights/overflow hiding/new stylesheet.

S2: One wrapping row contains exact h2 (headingId/tabIndex/text preserved; marginInlineEnd:auto), Back, Reload and relocated export/cancel. Export/cancel guarded by role!==null && report!==null; copy exact disabled/callback/conditional behavior from S5. Whole-export helper follows header with same guard. Back always usable; Reload only locks busy; Cancel usable while exporting, never reportLocked. Preserve every error/notice/reading/exporting branch/text.

Keep role-gated form, preventDefault/submit guard, exact Applied filters/id/aria-label/filtersLabel and full-width field. Keep Prompt cohort native label/id/value/options/onChange/disabled and Apply cohort type/disabled. Field margins zero; select + Apply share wrapping row. Narrow select fits width. Dirty notice stays visible spanning full form row. No disclosure/new open state/draft reset.

S3: Replace context-and-coverage with compact context only. Preserve every scopeLabel/snapshotLabel/cohortLabel/statusLabel/basisLabel/warning and both exact static provenance sentences visibly. Scope may be strong; snapshot hint; cohort/status/basis may be wrapping zero-margin paragraphs. Do not concatenate/transform/parse values/infer status tones. Warnings remain individual visible paragraphs, key index. History/current-context and API/no-search sentences stay by rates. No truncation/disclosure. Remove coverage solely for S4 relocation. Next unchanged heading/table is Equal-cell mention and citation rates.

S4: Prepend complete Period coverage heading and mapped period JSX removed from S3 to exact Comparison evidence heading. Retain period.id keys, label, range, all seven values/labels: Attempted, Eligible, Usable, Identity unavailable, Identity invalid, Matched, Details. Use S1 coverage styles and row between layout; small readable text/tabular numerals allowed. Details includes excluded-cohort and failed/pending/expired breakdowns: never hide. Exact strings once. Rates precede coverage in DOM, no CSS ordering. Comparison evidence heading unchanged.

S5: Empty string removes old footer export, now in header. Adjacent Previous page/Next page untouched.

Frozen semantics: busy=reading||exporting; reportLocked=busy||dirty. Null role suppresses protected filters/report/export even with populated props; Back/Reload/error/status remain. All four known roles read/export. Null report has no tables/pager/export. No-data/current-only/incomparable/expired are supplied strings, never inferred zero/success. Numeric strings are preformatted (fractions, signed pp, Unavailable), stay exact. Equal-cell means are not pooled percentages/share of voice. Collection/matched-cell coverage separate. Completion is not comparability.

Evidence callbacks outside supplied blocks enter controller current-capability guards; keep handlers/disabled flags unchanged. Form synthetic-submit guard stays. Exact labels/native semantics/aria associations are contracts; controller focuses prefix+'heading'. CSV covers both periods/all cells/all executions, not visible page. Hostile/long strings inert; no HTML/links/providers/truncation.

Frozen public types and source blocks follow.

```tsx
export type ComparisonCohort = 'current-neutral' | 'all';
export type ComparisonOutcome = 'all' | 'usable' | 'unavailable' | 'mentioned' | 'not_mentioned' | 'cited';
export type AIComparisonViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  reading: boolean; exporting: boolean; dirty: boolean; canApply: boolean;
  error: string | null; notice: string | null;
  filtersLabel: string; cohort: ComparisonCohort;
  report: null | {
    scopeLabel: string; snapshotLabel: string; cohortLabel: string;
    statusLabel: string; basisLabel: string; warnings: string[];
    periods: {id: 'current' | 'previous'; label: string; range: string;
      attempted: string; eligible: string; usable: string; identityUnavailable: string;
      identityInvalid: string; matched: string; details: string}[];
    metrics: {id: string; name: string; current: string; previous: string;
      delta: string; citationsCurrent: string; citationsPrevious: string; citationsDelta: string}[];
    entities: {id: string; name: string}[]; entityId: string;
    view: 'cells' | 'current' | 'previous'; outcome: ComparisonOutcome;
    evidenceLabel: string; pageLabel: string; canPrevious: boolean; canNext: boolean; canExport: boolean;
    cells: {id: string; prompt: string; model: string; identity: string; status: string;
      current: string; previous: string; currentMentions: string; previousMentions: string;
      currentCitations: string; previousCitations: string;
      canCurrent: boolean; canPrevious: boolean}[];
    executions: {id: string; requestedAt: string; model: string; eligibility: string;
      identity: string; matches: string; canOpen: boolean}[];
  };
  onCohortChange: (value: ComparisonCohort) => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onEntityChange: (id: string) => void;
  onView: (value: 'cells' | 'current' | 'previous') => void;
  onOutcome: (value: ComparisonOutcome) => void;
  onCell: (id: string, period: 'current' | 'previous') => void;
  onOpenComparison: (executionId: string) => void;
  onPrevious: () => void; onNext: () => void;
  onExport: () => void; onCancelExport: () => void;
};
```

Existing frozen locals (all props already destructured):
```tsx
  const busy = reading || exporting;
  const reportLocked = busy || dirty;
  const headingId = prefix + 'heading';
  const filtersId = prefix + 'filters';
  const cohortId = prefix + 'cohort';
  const entitySelectId = prefix + 'entity';
  const outcomeSelectId = prefix + 'outcome';
  const metricsHintId = prefix + 'metrics-scroll-hint';
  const cellsHintId = prefix + 'cells-scroll-hint';
  const executionsHintId = prefix + 'executions-scroll-hint';
```

Exact original S1 (replace once):
```tsx
const controlStyle = { minHeight: 44, maxWidth: '100%' } as const;
const nowrapStyle = { whiteSpace: 'nowrap' } as const;
const scrollRegionStyle = { overflowX: 'auto' } as const;
const wrapRowStyle = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const formStyle = { display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' } as const;
const coverageGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: 12 } as const;
const coverageCardStyle = { border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#ffffff', minWidth: 0 } as const;
```

Exact original S2 (replace once):
```tsx
      <h2 id={headingId} tabIndex={-1}>Compare AI periods</h2>
      <div className="row between" style={wrapRowStyle}>
        <button type="button" className="btn ghost" style={controlStyle} onClick={onBack}>Back to insights</button>
        <button type="button" className="btn ghost" style={controlStyle} onClick={onReload} disabled={busy}>Reload comparison</button>
      </div>
      {error !== null && <p className="alert" role="alert">{error}</p>}
      {notice !== null && <p className="hint" role="status">{notice}</p>}
      {reading && <p className="hint" role="status">Loading comparison…</p>}
      {exporting && <p className="hint" role="status">Exporting comparison CSV…</p>}
      {role !== null && (
        <form
          style={formStyle}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && canApply) onApply();
          }}
        >
          <div className="field" style={{ width: '100%', minWidth: 0 }}>
            <strong>Applied filters</strong>
            <p id={filtersId} aria-label="Applied filters" className="hint">{filtersLabel}</p>
          </div>
          <div className="field">
            <label htmlFor={cohortId}>Prompt cohort</label>
            <select
              id={cohortId}
              style={controlStyle}
              value={cohort}
              disabled={busy}
              onChange={(event) => onCohortChange(event.target.value as ComparisonCohort)}
            >
              <option value="current-neutral">Currently classified neutral prompts</option>
              <option value="all">All prompts</option>
            </select>
          </div>
          <button type="submit" className="btn" style={controlStyle} disabled={busy || !canApply}>Apply cohort</button>
          {dirty && <p className="hint" role="status">Unapplied cohort change. The report below still uses the applied cohort.</p>}
        </form>
      )}
```

Exact original S3 (replace once):
```tsx
          <div>
            <p>{report.scopeLabel}</p>
            <p>{report.snapshotLabel}</p>
            <p>{report.cohortLabel}</p>
            <p>{report.statusLabel}</p>
            <p>{report.basisLabel}</p>
            {report.warnings.map((warning, index) => (
              <p className="hint" key={index}>{warning}</p>
            ))}
            <p className="hint">Recomputed using current project context; historical identities were not captured.</p>
            <p className="hint">OpenRouter API · web search off</p>
          </div>
          <h3>Period coverage</h3>
          <div style={coverageGridStyle}>
            {report.periods.map((period) => (
              <div key={period.id} style={coverageCardStyle}>
                <p><strong>{period.label}</strong></p>
                <p className="hint">{period.range}</p>
                <div className="row between"><span>Attempted</span><span>{period.attempted}</span></div>
                <div className="row between"><span>Eligible</span><span>{period.eligible}</span></div>
                <div className="row between"><span>Usable</span><span>{period.usable}</span></div>
                <div className="row between"><span>Identity unavailable</span><span>{period.identityUnavailable}</span></div>
                <div className="row between"><span>Identity invalid</span><span>{period.identityInvalid}</span></div>
                <div className="row between"><span>Matched</span><span>{period.matched}</span></div>
                <div className="row between"><span>Details</span><span>{period.details}</span></div>
              </div>
            ))}
          </div>
```

Exact original S4 (replace once):
```tsx
          <h3>Comparison evidence</h3>
```

Exact original S5 (replace once):
```tsx
          <div style={formStyle}>
            <div style={wrapRowStyle}>
              <button type="button" className="btn" style={controlStyle} disabled={reportLocked || !report.canExport} onClick={onExport}>Export comparison CSV</button>
              {exporting && (
                <button type="button" className="btn ghost" style={controlStyle} onClick={onCancelExport}>Cancel export</button>
              )}
            </div>
            <p className="hint">Exports both periods, all cells and executions in the applied comparison; not only this page.</p>
          </div>
```

Preserve checks: exact values/denominators/warnings, zero vs Unavailable, empty cells/executions, null report, role-null purge, staged-cohort locks, busy except Back/Cancel, independent row/page/export flags, callback IDs/outcome unions, 44px targets, named keyboard regions/hint IDs, widths, no overflow/view I/O. New layout: rates before coverage, one header export with helper, all coverage visible. GPT runs checks; do not claim execution.