# Campaign inventory interface

GPT-reviewed presentation/controller contract,2026-10-13. Implements the
[inventory journey](meta-campaigns.md); this specification is not acceptance.

From the selected source in Meta reports, open **Campaign inventory**. Read the
latest completed inventory and the most recent attempt without requesting Meta.
History can select an explicit complete or partial receipt. **Show latest
complete** returns to the default selection; never silently substitute an older
snapshot for an expired/deleted newest one. A member can read/export retained
records with disconnected credentials. Only the current owner can explicitly
refresh/cancel. Return to reports revalidates source and selected receipt access.

## Pure Kimi display

Implement only `src/components/MetaCampaignView.tsx`. Export the exact types and
named function below. No imports, hooks, state, effects, network, URL/storage,
clipboard, timers, raw HTML, number/date conversion, assets or dependencies.
Display supplied text and invoke supplied callbacks; GPT owns the controller.
Use existing `research-panel`, `card`, `stack`, `row`, `field`, `btn`, `hint`,
`alert`, `table-wrap` classes and small inline styles. Reuse native controls.

```ts
export type MetaCampaignSummary = {
  id: string; statusLabel: string; coverageLabel: string;
  state: 'pending' | 'available' | 'expired' | 'unavailable';
  sourceLabel: string; requestedAtLabel: string; completedAtLabel: string;
  intervalLabel: string; countsLabel: string; diagnosticLabel: string;
  warnings: string[];
};
export type MetaCampaignTableRow = {
  id: string; nameLabel: string; statusLabel: string; effectiveStatusLabel: string;
};
export type MetaCampaignViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean; exporting: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string; exportError: string; notice: string;
  source: {label: string; accountLabel: string; statusLabel: string; help: string} | null;
  latestAttemptLabel: string; showingLatest: boolean;
  inventories: {id: string; label: string}[]; selectedInventoryId: string;
  summary: MetaCampaignSummary | null; rows: MetaCampaignTableRow[];
  canRefresh: boolean; canCancel: boolean; canRetrySame: boolean;
  canPreviousHistory: boolean; canNextHistory: boolean;
  canPreviousRows: boolean; canNextRows: boolean; canExport: boolean;
  pendingActionLabel: string;
  onBack: () => void; onReload: () => void; onLatest: () => void;
  onRefresh: () => void; onCancel: () => void; onRetrySame: () => void;
  onSelectInventory: (id: string) => void;
  onPreviousHistory: () => void; onNextHistory: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onExport: () => void; onCancelExport: () => void;
};
```

## Rendering and locks

1. Root is `research-panel stack`. Heading **Campaign inventory** has
   `id=prefix+'heading'`, `tabIndex=-1`. Intro: **Read retained campaign metadata,
   including campaigns without reported activity. This screen does not measure
   campaign performance.** Render error/exportError independently as `role=alert`
   and notice as `role=status`. Show **Loading inventory…** when not loaded or
   reading. Do not derive counts, dates, statuses or completeness in this leaf.
2. **Back to reports** and **Reload saved inventory** are always present. Back
   stays usable during a read/export; disable it during any non-idle write.
   Reload is disabled during reading, exporting or non-idle writes. Unknown
   role hides source/account, latest attempt, history, summary, rows and all
   write/export controls. Recovery/Back and errors stay visible.
3. With known role and source, show source label, account label, status and help
   in one compact card. Always explain: **Refreshing requests a new read from
   Meta. Opening this screen or reloading saved inventory does not.** For owner
   only, show **Refresh campaign inventory**, disabled unless canRefresh and no
   read/export/non-idle write. Nonowners see **A workspace owner can refresh or
   cancel inventory. You can read and export saved results.**
4. Known roles see latestAttemptLabel when nonempty, then a labelled **Inventory
   history** select with `id=prefix+'history'`, controlled selectedInventoryId,
   a **Choose an inventory** empty option and supplied choices. **Previous
   history page**/**Next history page** obey independent history capabilities.
   **Show latest complete** is disabled while busy; show **Latest complete
   inventory** or **Selected history receipt** according to showingLatest.
   All history controls require source and are disabled during any operation.
5. For owner with summary, show **Cancel local refresh** only when canCancel;
   disable it while busy. Explain **Requests already sent to Meta may continue
   there.** when the control is shown. Submitting shows pendingActionLabel as
   status. Unknown write shows **The result is not confirmed. Retry the same
   request to check its saved result.** and owner-only **Retry same request**;
   enable only canRetrySame, no reading/exporting, writeState unknown. Do not
   enable fresh refresh, history, Back or cancellation while outcome is unknown.
6. Known role and summary show supplied status, coverage, source, request and
   completion times, observation interval and counts. Show warnings as separate
   text and diagnosticLabel when nonempty. Put exact receipt ID in native
   **Receipt details** disclosure, with wrapping text. Explain **Pages were
   observed over an interval. Campaigns may change during collection. Missing
   records do not prove deletion or zero activity.**
7. Render the campaign table only when summary.state is available. If rows are
   empty show **No campaigns returned on this page. Review the snapshot coverage
   before drawing conclusions.** Otherwise use a caption **Saved campaigns**,
   four scoped column headings **Campaign ID**, **Name**, **Configured status**,
   **Effective status**. Show supplied values exactly as text. No links or status
   color implying health. Table minimum width760px, each column minimum180px,
   inside independently focusable region `aria-label=Saved campaigns` with
   horizontal scrolling. Receipt state pending/expired/unavailable hides rows
   even if stale props contain them; show respectively **Refresh is in
   progress. Reload saved inventory to check its status.**, **This snapshot's
   campaign data has expired.**, **Campaign data is unavailable for this receipt.**
8. Row paging buttons **Previous campaign page**/**Next campaign page** require
   available summary and supplied capabilities. **Export CSV** also requires
   available summary and canExport; allow an explicitly complete empty snapshot
   export. Disable paging/export during busy operations. Export help: **Exports
   this named snapshot with its observation interval and coverage. No campaign
   activity or performance totals are inferred.** While exporting show
   **Preparing CSV…** and **Cancel export**; only Cancel export and Back remain
   enabled. All role checks still apply. Summary null hides rows/exports/paging
   and shows **No saved inventory selected.** once loaded and not reading.
9. Every button has `type=button`; inputs/buttons/disclosures have44px targets.
   Stable IDs derive from prefix. Labels and long IDs wrap, children minWidth0,
   fields margin0. Use compact wrapping control rows, retain desktop horizontal
   alignment, and ensure the360px document does not overflow. Retained table
   scroll must not collapse individual columns to a few characters.

## Controller and independent acceptance

The controller keys actor/workspace/project/source, validates source and every
DTO, separates source/history/row operations and aborts stale reads/downloads.
Refresh/cancel use actor-bound request UUIDs; uncertain acknowledgements retain
the exact body and permit only identical retry. Known active attempts disable
fresh refresh. Back uses a fresh parent read, never cached authority. Mask source
metadata on signed deletion; reconnecting a new grant must not revive old data.

Members may export an explicit available snapshot by ID with its displayed
revision. Validate fixed CSV headers, actual streamed16MiB size and UTF-8; do not
equate compressed Content-Length with decoded size. Abort/cancel/unmount prevents
late downloads. Rejected role/scope/revision responses purge stale data. Display
raw unknown status labels as explicitly unknown, without treating them as active.

GPT independently tests the pure display and controller, actual routes/worker,
permission/deletion/retry races and desktop/mobile rendering. No browser route
auto-refreshes Meta; any background schedule requires a separate owner action.
