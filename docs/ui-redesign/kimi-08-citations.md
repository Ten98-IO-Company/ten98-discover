Load Ponytail from the supplied Skill-only profile before drafting. Only the supplied public source is task input.

Implement approved bounded A03 presentation draft with verified Kimi K3, thinking enabled, maximum effort. No tools except explicitly permitted curated Skill reading; no shell/filesystem/network/delegation/API/DB/provider/publication. Draft deadline 12 minutes; total task including at most two repairs 15 minutes. Stop at the first limit; no automatic continuation/fallback.

Return exactly `{ "replacements": [{ "id": "S1", "new": "..." }, ...] }` containing S1–S5 once each. Values are exact replacement TSX. No Markdown fence/explanation/full file. GPT verifies originals, applies and independently tests. No access to unsupplied source is needed or authorized.

Allowlist: src/components/CitationAnalysisView.tsx, only supplied five originals. Everything else stays byte-equivalent after LF normalization. Keep every exported type/helper/function and helper signature. No imports/new helpers/hooks/effects/controllers/API/routes/dependencies/stylesheets or calculations. This is presentation; safe links, classification, authorization, request identity and unknown-write recovery are not yours to change.

Audience/job: analysts inspect retained citation sources and coverage, drill to exact annotations, and explicitly track/classify a domain when permitted. White semantic surfaces, system type, compact research-table layout. Signature: two clearly labelled periods with plain count summaries followed by the selected source table. No dashboard hero/cards per metric/graph/gradient/shadow/icons, inferred success or manufactured data.

Use existing CSS variables: --color-text, --color-text-muted, --color-border, --color-surface; --space-1, --space-2, --space-3, --space-4; --text-xs, --text-sm, --text-lg; --weight-semibold; --control-touch. Existing classes research-panel, stack, row, between, field, hint, alert, btn, btn ghost, table have token-based styling. No new class or CSS import. btn is neutral outlined, ghost quiet. Global native details summary is keyboard accessible and >=44px; global focus/disabled states already exist. Use logical margins/borders/padding, minWidth:0 and wrapping. Never hide overflow or cut text. Body text >=14px, tables13px, hints12px; keep button/control targets44px. All numbers are formatted strings, including Unavailable and exact coverage text: never parse, shorten, recalculate or infer a delta.

S1, HeaderSummary: keep the exact function signature. Refine markup only. Outer grid has token gap. Keep scopeLabel prominent and appliedFiltersLabel as a full-width visible line. Place snapshotLabel and groupingLabel in one wrapping metadata row with zero paragraph margins. Keep measurementLabel, filterScopeLabel, overlapLabel, static current-context/historical-ownership sentence and every mapped warning visibly rendered before the period counts. No disclosure/truncation/tooltip-only warning. Preserve warning .alert class and key index; do not infer tones from supplied prose.

The two period sections use a responsive grid `repeat(auto-fit,minmax(min(100%,280px),1fr))` with token gap. Each is a plain section with minWidth0 and a subtle block-start border using --color-border plus space-3 block padding, no nested card surface/shadow. Preserve each period key, label heading (h3 with zero margins), range, all six values and exact labels. Present the five counts (Eligible answers, Answers with citations, Annotation occurrences, Unique grouped URLs, Unique domains) as one small definition-list grid inside each period, `repeat(auto-fit,minmax(min(100%,120px),1fr))`. dt labels stay readable; dd values have margin0 and tabular numerals; no giant number/card. Keep existing label words/colons. Coverage is a separate full-width visible paragraph, never a metric or hidden methodology. Keep the exact final sentence “Answers in selected date/model/prompt/tag scope”. No metric is removed or calculated. Shared helper must work unchanged in report and evidence branches.

S2, heading/actions: make one wrapping row containing existing h2, Back, Reload and conditional export/cancel group. h2 retains props.prefix+'heading', tabIndex=-1 and dynamic heading text; marginInlineEnd:auto lets actions align. Use token gaps. Preserve each button's text, type, class, style, disabled expression and guarded onClick byte-for-byte. Preserve exportVisible and exporting ternary. Do not move/add/delete controls or touch the following export-scope helper/status/unknown-write retry/branch dispatch. Task screen still has no export; saving/unknown remains locked by unchanged locals.

S3, form opening: wrap the existing report-only form in native `<details open={screen.dirty}>` with exactly `<summary>Source filters</summary>`. Keep existing form submit prevention/guard exactly. Change only its layout: responsive columns `repeat(auto-fit,minmax(min(100%,180px),1fr))`, token space-3 gap and marginBlockStart. All existing form children remain outside this replacement and unchanged. No custom state/effect/onToggle/key/remount/persistence or automatic submission. Default false means returning users see results; true exposes unapplied work. Opening/closing must preserve the controller-owned draft.

S4, form closing: close that new details immediately after the existing form. Leave both original following messages outside: grouping explanation and conditional dirty notice. Keep their exact words, conditions and classes, with only zero/token margins if needed. Then the existing report table selection and pager continue untouched. Applied scope and grouping remain visible in HeaderSummary when filters are closed. No availability/capability changes from toggling.

S5, existing advanced filter opening: preserve native details and exact More source filters summary; change only the nested grid's columns to `repeat(auto-fit,minmax(min(100%,180px),1fr))` and token gap. All five advanced labels/options/values/callbacks stay unchanged. This is the second disclosure level; no third. Do not make advanced filters a new form or lose draft fields.

Frozen contracts: null role overrides supplied screen and hides protected content; four known roles read/export, only writer actions may edit. ready/steady/dirty/read/export/write-state and each canX guard remain. URL grouping/source filters act only on annotations; eligible-answer denominator remains selected date/model/prompt/tag population. Counts across sources/categories overlap. Retained annotation occurrences are not unique answers; current ownership is not historical/verified ownership. Unavailable/expired differs from zero. Six report views, evidence-period selector, paging, exact receipt IDs, all source/coverage/uncertainty text stay. Existing safeHref alone determines deliberate external links, with noopener/noreferrer and target blank; do not create links from labels. Retained title null/empty remain distinct.

Tracking/category/task forms and original request-retry block are unsupplied and frozen: no edits to brand/existing/new competitor/category options, scope help, required fields, selected-action enabled checks, conflict/dirty handling, Save/Cancel, or unknown-write recovery. No changes to HeaderSummary callers or screen union. Existing controller focus targets and form draft preservation remain.

Required public source context and exact originals follow. Types shown are read-only excerpts; all other exported types remain in the unchanged file.

```tsx
export type CitationPeriod = 'current' | 'previous';
export type CitationHeader = {
  scopeLabel: string; snapshotLabel: string; groupingLabel: string;
  appliedFiltersLabel: string; measurementLabel: string; filterScopeLabel: string;
  warnings: string[]; overlapLabel: string;
  periods: { id: CitationPeriod; label: string; range: string; eligibleAnswers: string;
    citingAnswers: string; annotations: string; uniqueUrls: string; uniqueDomains: string;
    coverage: string }[];
};

const controlStyle = { minHeight: 44, minWidth: 0, width: '100%' } as const;
const buttonStyle = { minHeight: 44 } as const;
const blockStyle = { display: 'block' } as const;
const actionColumnStyle = { display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'stretch' } as const;

function ReportSection({ screen, props, ready, writer }: { screen: CitationReportScreen; props: CitationAnalysisViewProps; ready: boolean; writer: boolean }) {
  const steady = ready && !screen.dirty;
  const draft = screen.draft;
  const applyAllowed = ready && screen.canApply;
  // Existing return body begins here; it remains except S3-S5.
}

export function CitationAnalysisView(props: CitationAnalysisViewProps) {
  const idle = props.writeState === 'idle';
  const known = props.role !== null;
  const writer = props.role === 'owner' || props.role === 'admin' || props.role === 'editor';
  const ready = known && idle && !props.reading && !props.exporting;
  const screen = known ? props.screen : null;
  const reportDirty = screen !== null && screen.kind === 'report' && screen.dirty;
  const steady = ready && !reportDirty;
  const backAllowed = props.canLeave && idle;
  const reloadAllowed = props.canReload && idle && !props.exporting;
  const cancelExportAllowed = props.exporting && idle;
  const exportVisible = screen !== null && screen.kind !== 'task';
  const exportAllowed = steady && props.canExport && exportVisible;
  const retryAllowed = writer && props.writeState === 'unknown' && props.canRetrySameRequest && !props.reading && !props.exporting;
  const heading = screen === null || screen.kind === 'report' ? 'Citations' : screen.kind === 'evidence' ? 'Citation evidence' : 'Track or classify domain';
  // Existing return body begins here; it remains except S2.
}
```

Exact original S1 (replace once):
```tsx
function HeaderSummary({ header }: { header: CitationHeader }) {
  return (
    <div style={{ display: 'grid', gap: '0.25rem' }}>
      <p className="hint" style={{ margin: 0 }}>{header.scopeLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.snapshotLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.groupingLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.appliedFiltersLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.measurementLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.filterScopeLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.overlapLabel}</p>
      <p className="hint" style={{ margin: 0 }}>Classified using current project context; historical ownership was not captured.</p>
      {header.warnings.map((warning, index) => (
        <p key={index} className="alert" style={{ margin: 0 }}>{warning}</p>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        {header.periods.map((period) => (
          <section key={period.id} style={{ flex: '1 1 240px', minWidth: 0 }}>
            <h3>{period.label}</h3>
            <p className="hint" style={{ margin: 0 }}>{period.range}</p>
            <p style={{ margin: 0 }}>Eligible answers: {period.eligibleAnswers}</p>
            <p style={{ margin: 0 }}>Answers with citations: {period.citingAnswers}</p>
            <p style={{ margin: 0 }}>Annotation occurrences: {period.annotations}</p>
            <p style={{ margin: 0 }}>Unique grouped URLs: {period.uniqueUrls}</p>
            <p style={{ margin: 0 }}>Unique domains: {period.uniqueDomains}</p>
            <p style={{ margin: 0 }}>Coverage: {period.coverage}</p>
          </section>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>Answers in selected date/model/prompt/tag scope</p>
    </div>
  );
}
```

Exact original S2 (replace once):
```tsx
      <h2 id={props.prefix + 'heading'} tabIndex={-1}>{heading}</h2>
      <div className="row between" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost" style={buttonStyle} disabled={!backAllowed} onClick={() => { if (backAllowed) props.onBack(); }}>{props.backLabel}</button>
          <button type="button" className="btn ghost" style={buttonStyle} disabled={!reloadAllowed} onClick={() => { if (reloadAllowed) props.onReload(); }}>{props.reloadLabel}</button>
        </div>
        {exportVisible && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {props.exporting ? (
              <button type="button" className="btn ghost" style={buttonStyle} disabled={!cancelExportAllowed} onClick={() => { if (cancelExportAllowed) props.onCancelExport(); }}>Cancel export</button>
            ) : (
              <button type="button" className="btn" style={buttonStyle} disabled={!exportAllowed} onClick={() => { if (exportAllowed) props.onExport(); }}>Export full analysis CSV</button>
            )}
          </div>
        )}
      </div>
```

Exact original S3 (replace once):
```tsx
      <form onSubmit={(event) => { event.preventDefault(); if (applyAllowed) props.onApplyFilters(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', alignItems: 'start' }}>
```

Exact original S4 (replace once):
```tsx
      </form>
      <p className="hint">Grouping changes which retained URLs are counted together. Evidence preserves the retained URL and title. Neither mode fetches a page.</p>
      {screen.dirty && <p className="hint">Unapplied source filters. The report still uses the applied selection.</p>}
```

Exact original S5 (replace once):
```tsx
        <details>
          <summary>More source filters</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
```

GPT acceptance preserves all existing citation view/controller assertions. Harness setup must open Source filters before existing form interactions, then More source filters where needed; do not delete assertions. New independent checks cover default closed/dirty open, keyboard toggling with no callback/I/O, draft preservation across close/reopen, qualifications visible while closed, one compact header action group across report/evidence/task, all period values, unchanged capability locks, 320/360/768/1440px reflow and existing named table regions. No runtime check has been run by this drafting task.