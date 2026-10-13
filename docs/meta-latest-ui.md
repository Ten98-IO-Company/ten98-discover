# Latest complete Meta coverage

GPT-reviewed implementation and presentation contract, 2026-10-13. This is the
next increment after manual imports, not a claim that the new view is working.
It implements retained reporting, without contacting Meta or creating imports.

## Selection and journey

From one retained report, choose **Latest complete coverage**. Its captured
definition selects the account, report grain, currency, timezone, Graph version
and attribution profile. Names and grant revisions are not compatibility keys.
Enter an explicit range of at most31 account-local days and apply it. Show the
chosen profile, each day's coverage, then retained daily rows. Allow opening the
underlying import and exporting the current selection. Back returns to imports.

For each day, choose the newest compatible completed receipt by original request
time and ID, before applying deletion or expiry. A complete empty receipt replaces
older rows for that day; missing campaigns do not become invented zeroes. Failed,
partial and unfinished attempts never replace complete coverage. Expired/deleted
winners remain unavailable; do not fall back to older readable values. A retained
non-display definition fingerprint permits selection after source erasure. A
legacy deleted receipt with unknown profile conservatively blocks its newer
covered dates. Different currencies, timezones and attribution profiles remain
separate; there are no summed conversions, cross-currency totals or FX estimates.

The member-only GET uses an explicit reference receipt, report and date range in
one repeatable-read transaction. Rows are paged50 at a time; a selection revision
binds the winning receipts and their visibility to each cursor. Recompute on each
page and reject changes with409/Reload. Limit expansion to selected readable
receipts containing at most25000 stored rows and a5s SQL timeout; fail explicitly
when a narrower range is needed. No truncated success or lifetime history cap.

Export is a local read requiring the displayed selection revision. Recheck scope
and selection in one transaction; preserve exact decimal strings, receipt/source
metadata and distinct coverage records. Separate JSON columns preserve null/empty
actions and overlapping action windows. Reuse CSV formula protection, a16MiB byte
limit and cancellation. CSV bytes retain precision; spreadsheet auto-conversion
is outside that guarantee. No provider budget reservation or job is created.

## Pure Kimi presentation file

Implement only `src/components/MetaLatestView.tsx`, with the exact exported types
below and named `MetaLatestView` function. No imports, hooks, effects, networking,
state, URL creation, timers, storage, clipboard, raw HTML, number/date formatting
or console. Render supplied text and invoke supplied callbacks only. Use existing
`research-panel`, `card`, `stack`, `row`, `field`, `btn`, `hint`, `alert`,
`table-wrap` classes with small inline styles. No dependencies, icons or assets.

```ts
export type MetaLatestProfile = {
  accountLabel: string; reportLabel: string; currency: string;
  timeZone: string; attributionLabel: string;
};
export type MetaLatestCoverage = {
  date: string;
  state: 'rows' | 'empty' | 'missing' | 'expired' | 'deleted' | 'incompatible';
  stateLabel: string; countsLabel: string; help: string;
  receiptId: string | null;
};
export type MetaLatestRow = {
  key: string; date: string; campaignLabel: string;
  impressions: string; clicks: string; spend: string;
  actions: {label: string; value: string}[] | null;
  actionValues: {label: string; value: string}[] | null;
};
export type MetaLatestResult = {
  rangeLabel: string; asOfLabel: string; countLabel: string;
  selectionRevision: string;
  coverage: MetaLatestCoverage[];
};
export type MetaLatestViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean; exporting: boolean;
  error: string; exportError: string; notice: string;
  profile: MetaLatestProfile | null;
  from: string; to: string;
  result: MetaLatestResult | null; rows: MetaLatestRow[];
  canApply: boolean; canExport: boolean;
  canPreviousRows: boolean; canNextRows: boolean;
  onFrom: (value: string) => void; onTo: (value: string) => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onOpenImport: (id: string) => void;
  onExport: () => void; onCancelExport: () => void;
};
```

## Rendering and interaction

1. Root `research-panel stack`; heading **Latest complete coverage** with
   `id=prefix+'heading'` and `tabIndex=-1`. Intro: **Read the latest completed
   imports for this report definition. This view does not request data from Meta.**
   Show supplied error and exportError separately with `role=alert`; notice as
   status. **Back to imports** always remains available: the controller aborts
   any pending read/export. **Reload coverage** is disabled during reading/export.
2. Unknown role hides profile, dates, result, rows, coverage, receipt IDs and
   export controls even if supplied. It may show loading/error and Back/Reload.
   All known roles have the same read/export controls; no owner-only gates.
3. Show **Loading coverage…** while not loaded or reading. During export show
   **Preparing CSV…** and **Cancel export**. Exporting disables every other
   action/control except Back and Cancel export. Ordinary reading disables all
   actions and fields except Back. Disabled actions must not fire callbacks.
4. Profile shows accountLabel, reportLabel, currency and timeZone in a compact
   wrapping description grid, then attributionLabel as plain text. Make currency
   and timezone visible without opening a disclosure. Text: **Completed imports
   replace earlier values for each covered day. Missing values are not zero.**
5. Controlled **From** and **To** `type=date` inputs and **Apply date range** in a
   responsive grid, using supplied values without conversion. Apply requires
   known role, canApply, nonempty dates, and neither reading nor exporting.
   Help: **Use at most 31 account-local days. Changing dates does not request a
   new import.** Associate this help with both date inputs. Never compute dates.
6. A non-null result shows rangeLabel, asOfLabel and countLabel. Put the exact
   selectionRevision in a native **Selection details** disclosure. Do not shorten
   or invent IDs. **Export CSV** requires known role, result, canExport and idle.
   Export help: **Includes coverage and receipt metadata. Decimal values are
   preserved in the file; spreadsheet software may convert them when opened.**
7. Always show per-day coverage when result is present: a native captioned table
   in a focusable horizontal-scroll region named **Daily coverage**. Columns
   Date, Coverage, Rows, Details, Import. Render date/stateLabel/countsLabel/help
   verbatim; never infer measured zero from state or empty arrays. For receiptId,
   show **Open import** with accessible name **Open import for {date}**, invoking
   onOpenImport(receiptId); otherwise **No receipt**. Buttons obey read/export
   locks. Do not print internal state codes as substitute copy. If the supplied
   coverage array is empty say **No coverage entries returned.**
8. With result present, nonempty rows render another captioned native table in
   a focusable horizontal-scroll region named **Latest daily Meta rows**. Columns
   Date, Campaign, Impressions, Clicks, Spend, Actions, Action values. Preserve
   supplied strings exactly. Null action arrays show **Unavailable**; empty arrays
   show **No entries returned**; other entries show label and value as text.
   All provider strings are inert text; no math, parsing or HTML.
9. Empty rows with result say **No readable rows on this page. Review daily
   coverage for empty, missing or unavailable dates.** Never label this as no
   activity. Without result say **Apply a date range to read saved coverage.**
   Show **Previous row page** and **Next row page** only with result; each requires
   its capability and idle state. No supplied rows render without result.
10. Display **Spend is provider-estimated. Action types and attribution windows
    can overlap; they are not additive totals.** No totals, aggregate charts or
    hidden compatibility inference. Use row.key only as React key.
11. Every button has `type=button`; controls and disclosures have44px targets.
    Stable label IDs derive from prefix. Long labels wrap; `minWidth:0` where
    needed. Tables keep readable minimum widths (coverage720px, rows960px) inside
    their own scroll regions; the360px document must not overflow. Compact fields
    align horizontally on desktop and stack on mobile. Keep native keyboard focus.

GPT independently tests role purge, read/export cancellation locks, exact copy,
null/empty/decimal distinctions, hostile strings, both table scroll regions,
coverage receipt callbacks, pagination,44px controls and1440/360px rendering.
Controller/service acceptance separately checks source/role changes,409 revision
recovery, aborted downloads, exact scoped filters and zero provider requests.
