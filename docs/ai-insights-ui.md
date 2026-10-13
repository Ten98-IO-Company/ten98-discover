# Retained-answer AI insights interface

This is the approved interface contract for the local retained-answer increment
described in [AI insights](ai-insights.md). Contained view/controller browser
acceptance and production navigation have passed locally. This increment does not
complete historical comparisons or the full P15–P17 scope.

All current project members can read and export. Opening this screen never
requests an answer, starts a job or checks provider credentials. The controller
uses the existing scoped Insights and prompt-library reads. Parent navigation
owns opening an existing comparison receipt; the view never constructs links.

## Flow and evidence

The first read uses the most recent seven calendar days in the browser's resolved
IANA timezone. A native filter form stages From, To, Timezone, Model, Prompt,
Current tag and Matching method; Apply filters performs a fresh read. Draft
changes leave the old report explicitly labelled with its applied scope and
disable paging/export/drilldown until applied or reverted. The report range is
at most 31 inclusive days. The named prompt selector uses the existing local
`status=all` library search and 50-row cursor pages; preserve the selected prompt
when it is off the visible option page. Label archived/disabled prompts in those
options. Prompt text and tag classification are current, not historical.

Always show these evidence limits beside a report:

- **Recomputed from retained answers using current project context**.
- **OpenRouter API · web search off**. No consumer ChatGPT/search inference.
- **Daily dates use the comparison's requested day in the applied timezone.**
- **Provider citation annotations are separate from prose mentions.**

Coverage separates attempted, eligible, queued, running, no-answer, empty,
truncated, content-filtered, expired and invalid observations. Visibility and
citation rates show exact integer numerator/denominator beside the percentage.
Share of voice divides entity-answer matches by all displayed entity-answer
matches. A known zero is `0 / N (0%)`; no eligible population is `Unavailable`.
No carry-forward, seeded history, rank, sentiment or performance recommendation
is inferred. The daily table displays one selected entity, with actual coverage
and null denominators on days without eligible answers.

Entity actions drill into exact mentioned, eligible-not-mentioned or cited
executions. The All executions, Eligible answers and Unavailable answers controls
change only drilldown; summary/daily metrics keep the full applied population.
Each validated row can open its existing comparison receipt. Show requested and
resolved models distinctly when available. Do not display raw answer content or
turn provider/user text into HTML, URLs or executable content.

Export report CSV exports the **whole applied population**, not the selected
drilldown/page. The controller sends the displayed selection revision, checks the
fixed filename/type/row-count, bounds the streamed body to 16 MiB, validates UTF-8
and creates a short-lived Blob only while the scope/request is still current.
Cancel export, Back and scope changes abort the download. No automatic retry.

## Protected controller boundary

`AIInsightsPanel` takes `userId`, `workspaceId`, `projectId`, `onUnauthorized`,
`onBack`, `backLabel`, and `onOpenComparison(comparisonId, promptId)`. It remounts
by identity and scope. Every continuation checks its current abort generation.
GETs have a 45-second overall client deadline. There is no background polling.
401/403/404/409 discard report, prompt metadata, cursor stacks and authority;
401 notifies the parent. Explicit Reload insights revalidates from page one.
Malformed successful bodies also clear protected content. Cursor/revision
changes never silently combine snapshots. Learned expired execution IDs cannot
become readable in a later response within the same mounted scope.

The controller validates nested DTOs, filter echo, subject identity/order,
coverage partitions, metric denominators, daily reconciliation, execution
eligibility/matches and exact drilldown membership before giving the view data.
Unknown comparisons are not navigable: callbacks accept only a row currently
present in a validated response. Named prompt pages are also validated and
current access failures clear the whole screen.

## Pure Kimi leaf

Implement **only** `src/components/AIInsightsView.tsx`. Export the declarations
below and the named function `AIInsightsView(props: AIInsightsViewProps)`.
The protected controller and tests are GPT-owned. This is presentation only:
no fetch, hooks/state/effects, router, clocks, storage, logging, URL/Blob creation,
clipboard, raw HTML, numerical derivation, new dependencies or other files.
Use React rendering, native labelled controls and callbacks. All supplied text
is inert. Do not import server code. No mutation of props.

```ts
export type AIInsightsDraft = {
  from: string; to: string; timeZone: string; model: string;
  promptId: string; tag: string;
  matcher: 'unicode-boundary-v1' | 'elmo-substring-v1';
};
export type AIInsightsViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  reading: boolean; exporting: boolean;
  error: string; notice: string; filterError: string; dirty: boolean;
  draft: AIInsightsDraft;
  promptSearch: string;
  promptOptions: {id: string; label: string}[];
  canPreviousPrompts: boolean; canNextPrompts: boolean;
  canApply: boolean;
  backLabel: string;
  report: null | {
    scopeLabel: string; contextLabel: string; snapshotLabel: string;
    warnings: string[];
    coverage: {label: string; value: string}[];
    metrics: {id: string; name: string; visibility: string;
      shareOfVoice: string; citations: string; canDrill: boolean}[];
    dailyEntityId: string;
    dailyEntities: {id: string; label: string}[];
    dailyRows: {date: string; attempted: string; eligible: string;
      visibility: string; shareOfVoice: string; citations: string}[];
    drilldownLabel: string; rowCountLabel: string;
    executions: {id: string; requestedAt: string; model: string;
      eligibility: string; matches: string}[];
    canPrevious: boolean; canNext: boolean; canExport: boolean;
  };
  onChange: (field: keyof AIInsightsDraft, value: string) => void;
  onPromptSearchChange: (value: string) => void;
  onSearchPrompts: () => void;
  onPreviousPrompts: () => void; onNextPrompts: () => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onDailyEntity: (id: string) => void;
  onDrilldown: (outcome: 'all' | 'eligible' | 'unavailable' |
    'mentioned' | 'not_mentioned' | 'cited', entityId?: string) => void;
  onPrevious: () => void; onNext: () => void;
  onOpenExecution: (id: string) => void;
  onExport: () => void; onCancelExport: () => void;
};
```

Use existing `card`, `stack`, `row`, `field`, `btn`, `btn-secondary`, `hint`,
`alert`, `table-wrap` classes and small inline layout styles where necessary.
No global CSS, icon library, imagery or dependency. All controls must have at
least 44px height. Use a wrapping header with h2 **AI insights**,
`id={prefix+'heading'}` and `tabIndex={-1}`, Back (supplied label), and
**Reload insights**. Back is always enabled, including during reads/exports.
Role null hides filters/report/prompt metadata even if stale props are supplied;
show loading/error and Reload only. Render error with `role="alert"`, notice
with `role="status"`. Reading and exporting get distinct visible status.

When role is known, render a filter `<form>` whose submit prevents default and
calls onApply only when canApply and neither busy flag is true. Exact labels:
**From**, **To**, **Timezone**, **Model**, **Prompt**, **Current tag**,
**Matching method**, **Find prompt**. Dates use type=date. Model options are
All models (`''`), GPT-4o mini (`openai/gpt-4o-mini`), GPT-4o (`openai/gpt-4o`).
Prompt starts with All prompts (`''`), then supplied options. Matching options:
**Unicode word boundaries** (`unicode-boundary-v1`) and
**Elmo substring baseline** (`elmo-substring-v1`). Prompt-search buttons:
**Search prompts**, **Previous prompts**, **Next prompts**. These are type=button.
Tag helper: **Matches current user tags; historical tags were not recorded.**
Method helper: **Substring matching can include parts of unrelated words.**
Render filterError and **Unapplied filter changes. The report below still uses
the applied filters.** when dirty. Apply button: **Apply filters**.
All filter/search inputs and non-Back actions are disabled while reading or
exporting; no event handler may ignore its capability flag.

Report layout: applied scope, context/snapshot labels and warning text; wrapping
coverage counts; entity metric table; daily entity selector/table; execution
drilldown/table and paging. Use h3 headings **Answer coverage**, **Entity metrics**,
**Daily observations**, **Execution evidence**. Display empty states honestly:
**No executions match this drilldown.** and **No eligible retained answers in
this range.** (the latter is controller warning text, not leaf inference).

Use captioned tables in labelled `role="region"`, `tabIndex={0}` scroll wrappers:
**Entity metrics**, **Daily observations**, **Execution evidence**. Give tables
sufficient minWidth (700–1000px) and the wrappers width100%, minWidth0,
maxWidth100%, overflowXauto; prevent whole-page overflow at360px. Add short
**Scroll horizontally to see every column.** hints. Preserve native keyboard
scrolling; do not implement keyboard handlers. Use scoped th headers.

Metric row buttons have exact accessible names **Show mentions for {name}**,
**Show non-mentions for {name}**, **Show citations for {name}**; call onDrilldown
with the corresponding ID/outcome. Disable when !canDrill or dirty/busy.
Daily selector label **Daily entity**; supplied options only. Execution controls:
**All executions**, **Eligible answers**, **Unavailable answers**. Disable while
dirty/busy. Row button visible **Open comparison**, accessible name
**Open comparison for execution {id}**; pass only its supplied execution ID.
Paging buttons: **Previous executions**, **Next executions**.
Export button: **Export report CSV**; helper **Exports all executions in the
applied report, including coverage and entity metrics; not only this drilldown.**
During export show **Cancel export** and invoke onCancelExport.

## Acceptance ownership

GPT checks actual DTO/API/controller behavior, abort generations, scopes,
expiry/revision changes, numerator/drilldown reconciliation, invalid-success
handling, CSV headers/limits/cancellation, viewer reads, and 1440/360px keyboard
and focus behavior. A pure presentation fixture cannot prove backend authority
or provider integration.

The seven controller Edge groups in `tests/ai-insights-browser.mjs` pass against
the real controller and view with synthetic local responses. They cover exact
population/drilldown counts, staged labels, named prompt pagination, zero versus
unavailable, malformed nested responses, revision/expiry/access purges,
A→B→A stale-response isolation, receipt callbacks, CSV validation/cancellation,
and 1440/360px keyboard scrolling with a reachable comparison action. Eight
independent pure-view groups also pass. TypeScript and the documentation plan
check pass. These checks use no database, provider or production account.

Run the controller check with `TEN98_AI_INSIGHTS_BROWSER=1`, an externally
installed `PLAYWRIGHT_MODULE` absolute module path, optional
`PLAYWRIGHT_CHANNEL=msedge`, and `node tests/ai-insights-browser.mjs`. It creates
an ephemeral loopback Vite fixture and blocks unexpected/outbound traffic.
Screenshots and failure diagnostics are written only to ignored local evidence.

Seventeen production navigation groups pass against a separate PostgreSQL
database with synthetic retained evidence and no worker or provider traffic.
They include owner/viewer report reads and CSV, exact comparison handoff,
fresh current-context reads after Back, and immediate policy-expiry masking.
The final desktop/mobile screens have no document overflow; evidence tables
scroll independently. These checks do not establish live-provider acceptance.
