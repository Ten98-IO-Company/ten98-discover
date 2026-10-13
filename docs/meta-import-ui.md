# Meta report import workflow

GPT-reviewed presentation contract, 2026-10-13. The bounded Kimi presentation
task is implemented and independently accepted in [Meta reports](meta-reports.md#manual-report-acceptance-2026-10-13).
Authorization, queue/lease handling and API DTO validation remain GPT-owned.
This contract is not live-provider or full-feature acceptance.

## Journey and truthful states

Open **Meta reports**, choose a connected source, choose **Account by day** or
**Campaign by day**, review the account currency/time zone and enter an explicit
date range. An owner starts one bounded import. Show its durable receipt and
status; after completion, show the retained daily rows and exact action fields.
Other current members can read retained reports. Connecting a pixel is unrelated.

Default dates come from the controller in the selected account's time zone and
end yesterday. An explicitly selected current day is provisional. The limit is
31 days per import within the provider's supported history; the service validates
it. No view code computes time zones, dates, money, totals, identifiers or permissions.

One selected source and one selected immutable report receipt are enough. Source
list, receipt list and report-row paging are separate controlled actions. Switching
source clears the previous receipt and rows. Failed/partial refreshes leave prior
complete receipts available in the history list; never silently add snapshots.
No schedule, campaign inventory, latest-overlap view or export is claimed in this
slice; those remain required separate workflows.

Reuse existing `research-panel`, `stack`, `card`, `field`, `row`, `btn`, `hint`,
`alert`, `table-wrap` classes. Neutral/violet styling, system typography, one
primary import action, semantic labels and wrapping layout. No dependencies,
icons, charts, remote fonts, provider logo downloads or custom CSS framework.

## Exact pure leaf

Implement only `src/components/MetaImportView.tsx`. Export the following types
unchanged and one named function `MetaImportView`. No imports, hooks, state,
effects, fetch, timers, storage, clipboard, router, URL creation, number/date
formatting, raw HTML or console. The leaf renders controlled data and invokes
callbacks. Every button uses `type="button"`.

```ts
export type MetaImportSourceOption = { id: string; label: string };
export type MetaImportChoice = { id: string; label: string };
export type MetaImportSourceSummary = {
  name: string; accountId: string; currency: string; timeZone: string;
  statusLabel: string; help: string;
};
export type MetaImportSummary = {
  id: string; statusLabel: string; dataStateLabel: string; rangeLabel: string;
  requestedAtLabel: string; completedAtLabel: string; sourceLabel: string;
  currencyLabel: string; timeZoneLabel: string; attributionLabel: string;
  countsLabel: string; diagnosticLabel: string; warnings: string[];
  state: 'pending' | 'available' | 'unavailable' | 'expired';
  coverage: 'complete' | 'partial' | 'unavailable';
};
export type MetaImportTableRow = {
  key: string; date: string; campaignLabel: string;
  impressions: string; clicks: string; spend: string;
  actions: { label: string; value: string }[] | null;
  actionValues: { label: string; value: string }[] | null;
};
export type MetaImportViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string; notice: string;
  sources: MetaImportSourceOption[]; selectedSourceId: string;
  source: MetaImportSourceSummary | null;
  canPreviousSources: boolean; canNextSources: boolean;
  report: 'account_daily' | 'campaign_daily'; from: string; to: string;
  canImport: boolean; canCancel: boolean; canRetrySame: boolean;
  pendingActionLabel: string;
  imports: MetaImportChoice[]; selectedImportId: string;
  canPreviousImports: boolean; canNextImports: boolean;
  summary: MetaImportSummary | null;
  rows: MetaImportTableRow[];
  canPreviousRows: boolean; canNextRows: boolean;
  onSource: (id: string) => void;
  onPreviousSources: () => void; onNextSources: () => void;
  onReport: (report: 'account_daily' | 'campaign_daily') => void;
  onFrom: (value: string) => void; onTo: (value: string) => void;
  onImport: () => void; onSelectImport: (id: string) => void;
  onPreviousImports: () => void; onNextImports: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onCancel: () => void; onRetrySame: () => void;
  onReload: () => void; onConnections: () => void;
};
```

## Rendering and action rules

1. Root `research-panel stack`; heading **Meta reports**,
   `id=prefix+'heading'`, `tabIndex=-1`. Intro: **Import read-only advertising
   reports. Browser pixels and native analytics remain separate sources.**
   Show supplied error as `role=alert` and notice as `role=status`.
2. `role===null` hides all source choices, summaries, date fields, history and
   rows even when supplied. Render loading/error plus **Reload reports** and
   **Manage connections** only, respecting write locks. A previous role's data
   must never remain visible while authority is unknown.
3. While `submitting`, disable every action, field, select and navigation.
   Show supplied pendingActionLabel as status. While `unknown`, disable all
   ordinary actions and fields, including Reload and Manage connections;
   show **The result is not confirmed. Retry the same request to check its
   saved result.** Only **Retry same request** is permitted, and only for a
   known owner with canRetrySame and not reading. Never invent a new request.
4. During an ordinary read, disable competing actions/fields but allow
   **Manage connections**. No callback should fire when its action is disabled.
   While idle/not-reading, **Reload reports** is available to known members.
5. Source selector: labeled **Source**, blank **Choose a source** option,
   controlled selectedSourceId, supplied options verbatim. Use distinct
   **Previous source page** / **Next source page** buttons with corresponding
   capabilities. When loaded and sources empty, say **No sources on this page.**
   Do not claim there are no ad accounts anywhere. Manage connections stays
   available when allowed; selecting never creates or imports anything.
6. When source is non-null, show name, exact accountId, currency, timeZone,
   statusLabel and help as text. Use a wrapping description list. Owners see
   labeled **Report**, **From**, **To** controls. Dates are controlled `type=date`
   values, preserved without conversion. Report options are exactly Account by
   day and Campaign by day. Show **Dates follow the account time zone. Import
   at most 31 days at a time. Today's data can still change.**
7. Primary **Import report** requires owner, canImport, source, nonempty from/to,
   idle and not reading. Do not infer permission from source status text.
   Nonowners see **A workspace owner can start or cancel imports. You can read
   retained reports.** They never see enabled import/date/report/cancel controls.
8. When a source is selected, show labeled **Import history** selector, blank
   **Choose an import**, supplied choices, **Previous import page** and
   **Next import page**. Missing choices with loaded/not-reading is **No imports
   on this page.** This is not a failed or zero-valued report. Off-page selected
   options, if needed, are included by the controller.
9. A non-null summary shows statusLabel and dataStateLabel, then sourceLabel,
   rangeLabel, currencyLabel, timeZoneLabel, countsLabel, requested/completed
   labels and exact receipt ID. Secondary provenance uses native details.
   Show attributionLabel and fixed **Spend is provider-estimated. Action types
   and attribution windows can overlap; they are not additive totals.**
   Render every supplied warning and diagnosticLabel as plain text.
10. Pending reports show **Report in progress. Reload to check its latest saved
    state.** Unavailable reports show **No report data is available for this
    attempt. Earlier completed reports remain in import history.** Expired
    reports show **Report rows expired under the workspace retention policy.
    The import receipt is retained.** Never show supplied rows for these states.
    Partial coverage carries a visible **Partial coverage** label; never present
    it as a full-range result. For available state with zero rows, say
    **This report completed with no returned rows. Missing rows are not measured
    zero activity.** (Use **This page has no returned rows.** instead if row paging
    capabilities indicate another page.)
11. Available rows render in a `table-wrap` horizontal-scroll region with
    accessible name **Daily Meta report rows**, then a native table/caption.
    Columns Date, Campaign, Impressions, Clicks, Spend, Actions, Action values.
    Use supplied exact strings with no math. Null action arrays mean
    **Unavailable**; empty arrays mean **No entries returned**; nonempty arrays
    show label/value text. Preserve distinct action types/windows; never add them.
    Use row.key only as React key. All provider labels render as text, never HTML.
12. **Previous report page** / **Next report page** require available state,
    corresponding capability, idle and not reading. Owner-only **Cancel local
    import** additionally requires canCancel and summary.state pending; explain
    **Stops local work. It does not cancel a report at Meta.** This click is the
    explicit action, no redundant confirmation wizard.
13. Stable label IDs derive only from prefix. Buttons/inputs/selects have at
    least44px height; wrap rows and long labels, `minWidth:0` where necessary.
    The page must not overflow a360px viewport; only the table region scrolls.
    Keyboard and screen-reader names remain distinct across the three pagers.

## Independent acceptance

GPT tests pure presentation with hostile strings/long IDs, owner/viewer/null
roles, pending/empty/partial/failed/expired states, exact string amounts and
action null/empty/value distinctions, unknown-write retry gating, three pagers,
keyboard labels and360px wrapping. A later controller suite checks actual API
DTOs, scope generations, bounded reads, durable same-body retries and exact
receipt identity. No provider request, credential or customer data is needed for
the Kimi draft or these synthetic presentation checks.
