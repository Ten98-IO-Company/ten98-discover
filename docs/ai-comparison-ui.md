# AI period comparison interface

Implementation contract for the next current-context comparison increment. This
document is not acceptance evidence or a claim of historical-capture parity.

From a validated AI insights report, **Compare periods** opens the same applied
date/model/prompt/tag/matcher filters. The previous period is the immediately
preceding equal number of local calendar days. Back preserves authored filters
and rereads insights. This flow starts no provider work.

Default cohort: **Currently classified neutral prompts**. The alternative is
**All prompts**. Stage the native selector and explicitly Apply cohort. Current
classification uses immutable execution prompt text with current brand context
and current user overrides. It is not captured historical classification.

Each comparable prompt/model/settings cell has equal weight. Mention and citation
means are distinct from pooled answer rates and share of voice. Show exact cell
fractions; never calculate rates in the presentation component. Coverage includes
all attempted children, and usable evidence requires both a retained eligible
answer and a reconstructable cell identity. A 90% coverage threshold does not
mean all cells matched. Open periods show provisional rates but no delta.

The protected controller owns scope, validation, calculations, API and CSV,
abort/deadline handling, selection revisions, monotone expiry and receipt IDs.
The Kimi presentation component owns only semantic markup and controlled events.
No imports, hooks, fetch/storage/timers, raw HTML, parsing or arithmetic. React
JSX runtime is automatic. Export exactly the types below and `AIComparisonView`.

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

Use the existing `research-panel stack`, `row between`, `btn`, `btn ghost`,
`field`, `hint`, `alert`, and `table` classes. The outer section has minWidth:0,
overflowWrap:anywhere. Use existing typography, white/light surfaces and purple
focus treatment. No dashboard hero, gradient, dependency, CSS file or decorative
chart. Every numeric string is supplied; render it unchanged.

The h2 is **Compare AI periods**, id prefix+'heading', tabIndex=-1. The controller
focuses it. Top buttons **Back to insights** (always usable), **Reload comparison**
(disabled during reading/exporting). Role null shows only heading, Back, Reload,
error/status; suppress all protected report/filter/cohort content. All four known
roles can read/export. Error uses role=alert; notice/loading/export status use
role=status. Render text normally, never HTML.

Native form: read-only filtersLabel; select label **Prompt cohort**, id using
prefix; options above. Button **Apply cohort** disabled when !canApply or busy.
Prevent default submit and guard callback even on synthetic submit. Dirty notice:
**Unapplied cohort change. The report below still uses the applied cohort.**
Keep the report's supplied cohortLabel visible; dirty state disables report
navigation, entity/evidence changes and exports until applied.

Report starts with scopeLabel, snapshotLabel, cohortLabel, statusLabel, basisLabel
and supplied warnings. Also always show **Recomputed using current project
context; historical identities were not captured.** and **OpenRouter API · web
search off**. Do not repeat or infer a success assertion from the status.

Use headings **Period coverage**, **Equal-cell mention and citation rates** and
**Comparison evidence**. Coverage has two cards in a responsive grid, each showing
label/range and supplied attempted, eligible, usable, identity-unavailable,
identity-invalid, matched and details values with plain labels. Use responsive
`repeat(auto-fit,minmax(min(100%,240px),1fr))` columns so 360px fits.

Metrics table columns: Entity, Current mentions, Previous mentions, Change,
Current citations, Previous citations, Citation change. Display supplied strings
including Unavailable, exact ratios, signed percentage points and 0 unchanged.

Evidence controls: select **Evidence entity** (supplied entities/id); buttons
**Show comparison cells**, **Show current executions**, **Show previous executions**.
Use aria-pressed for the active view. When executions are shown, select **Evidence**
with All executions, Usable answers, Unavailable answers, Mentions, Non-mentions,
Citations mapping to the outcome union. Display evidenceLabel and pageLabel.

Cells table columns: Prompt, Model, Identity, Status, Current coverage, Previous
coverage, Current mentions, Previous mentions, Current citations, Previous
citations, Actions. Buttons **Current executions** and **Previous executions**
have accessible names **Show current executions for cell {id}** / **Show previous
executions for cell {id}**, invoke supplied id/period and obey their capability
flags. Empty text: **No comparison cells match these filters.**

Execution table columns: Requested at, Model, Answer eligibility, Cell identity,
Matches, Comparison. Button **Open comparison**, accessible **Open comparison for
execution {id}**, passes only supplied executionId and obeys canOpen. Empty text:
**No executions match this selection.** No raw answer, URL or provider request.

Every table sits in its own focusable role=region with unique accessible label,
visible caption, column scopes and overflowX:auto. Minimum table width 760px;
cells table 1100px. Explain **Scroll horizontally to see every column.** in an
aria-describedby hint with unique id. Never give an outer section the same
accessible name as its table region. Header words and action text do not split;
action columns have enough minimum width. Only tables may overflow, never the
document. Controls have minHeight44 and maxWidth100%; wrapping button rows use
flexWrap. Supplied long identifiers/hostile strings remain inert and contained.

Buttons below evidence: **Previous page**, **Next page**, obey capability flags.
Export button **Export comparison CSV**, helper **Exports both periods, all cells
and executions in the applied comparison; not only this page.** While exporting,
show **Cancel export** and keep it enabled. Reading or exporting disables all
other form/report controls except Back and Cancel export. No report means no
evidence table, paging or export control.

GPT acceptance will cover formulas, identities, tenant/retention boundaries,
current-cohort labels, parent filter restoration, drift/abort/CSV behavior,
known-expired evidence, exact receipt handoff and 1440/360px keyboard scrolling.
Presentation-fixture success alone cannot establish service integration.
