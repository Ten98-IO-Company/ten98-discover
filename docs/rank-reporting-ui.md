# Rank reporting contract

Status: implemented and accepted locally on 2026-10-13. The distribution service, recent-check matrix, bounded CSV export and reporting UI have database/API and browser acceptance recorded below. This document does not declare P51 or live-provider acceptance complete.

## Source and reuse

Pinned OpenSEO `89e5a00717cdf049b7c2b4e29646edb3a7d4995b` uses [keyword rows by recent check columns](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/client/features/rank-tracking/RankTrackingHistoryMatrix.tsx), [completed full-run selection](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/rank-tracking/repositories/snapshotQueries.ts#L104) and a [default12, maximum26 run limit](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/types/schemas/rank-tracking.ts#L163). Its [latest-results export](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/client/features/rank-tracking/RankTrackingTableParts.tsx#L164) is useful design evidence, not code copied into this increment.

ten98 reuses the existing rank run/task records, stable keyword UUIDs, immutable captured targets, `withContentProject` read-only repeatable snapshots, `readContentCursor`, and `csvCell` formula neutralization. It adds no snapshot table, provider request, queue, scheduling path, dependency or reporting framework. Existing latest/baseline and per-keyword history remain separate complete views; this increment does not substitute a matrix export for their eventual export contracts.

## One compact reporting surface

Add **Reporting** to tracker detail. Within it, use native buttons for **Distribution** and **Recent checks**. Keep the parent shell and existing `research-panel` styles, one h2, one current-scope summary and explicit loading/error/empty states. No placeholder graphs, duplicate page title or large dashboard of empty cards. Run headers open the existing read-only check receipt or select that run's distribution; a keyword opens existing keyword history. No reporting interaction reruns a check.

Distribution consumes the exact exported `RankDistribution` DTO from `src/server/rank-distribution.ts`. It shows latest retained compatible observations by default, or an explicitly selected run's captured population. Display source, target, selected devices, server as-of and actual observation/retrieval date ranges. Never call latest aggregation a single completed check. Counters partition the denominator; organic buckets, absolute positions, negative observations through100, limited coverage, never checked, expired, pending, unavailable and incompatible stay distinct. `observedCoverage` and `top100Comparable` are separate counts/completeness flags. Empty population has false completeness. No client percentages, sums of overlapping runs, inferred rank0, or fabricated country/location labels.

Recent checks uses one explicitly selected currently enabled device. Native filters are device, literal keyword contains, pin state and recent checks count (default12, maximum26); Apply is explicit. A checked scope does not change merely because a draft field changes. One table page contains up to50 current keywords; Back/Next keyword-page controls replace the table instead of appending rows under a changed set of run headers. Show server as-of for each response. Each response is coherent; separate pages and exports are new snapshots, not a frozen browsing session.

Columns are the newest full started checks, newest first, with full local date/time and accessible UTC date, outcome, method/trigger and captured target compatibility. Pending, failed, partial, cancelled and expired checks remain visible. Unstarted quotes, skipped schedules and subset checks are omitted with a concise explanation and **Check history** navigation. The26-column bound is a recent-window limit, not a lifetime history cap.

Rows use current stable keyword IDs. A removed/recreated spelling cannot inherit the previous ID's observations. A cell distinguishes:

- **Not in this check:** the captured plan did not contain this keyword/device pair.
- **Unavailable:** the plan contains the pair but its task is absent or unavailable.
- **Pending**, **Failed**, **Uncertain**, **Cancelled:** actual recorded attempt state.
- **Expired:** task or run derived-data tombstone; numeric/source payload remains hidden even during partial cleanup.
- **Different setup:** captured target, keyword text or case rule is incompatible with the current row. Open the receipt to inspect that captured scope.
- **Ranked:** explicit organic rank or absolute position, actual observed/retrieved dates and measured coverage.
- **Not found in observed coverage:** successful observation, nullable position, actual checked depth including zero. Never label this unconditionally “outside top100.”

A delta compares only the immediately adjacent older displayed check, and only two readable compatible ranked observations of the same basis with strictly increasing observed timestamps. It never skips a failed/expired cell, invents a position for absence, mixes organic/absolute ranks or compares equal-time observations. Positive means improvement. Empty keyword filters and no started checks are separate empty states.

Use bounded horizontal scrolling, readable keyword/device columns, plain inert provider URLs and status text that does not rely on color. No new chart package. On360px, the page itself must not overflow; table controls remain keyboard accessible and at least44px high.

## Exact service and proposed route seam

`getRankMatrix(projectId, userId, trackerId, URLSearchParams)` accepts exactly `device=desktop|mobile`, optional literal `search` (maximum200 UTF-16 code units, valid Unicode/no NUL), `pinned=true|false`, `runLimit=1..26`, and opaque `cursor`. Unknown or duplicate fields fail400. An explicit disabled device fails400. All current members may read; absent membership or foreign tracker fails404.

Proposed route: `GET /api/projects/:projectId/rank-trackers/:trackerId/matrix`. No route is registered by this design file. The service exports `RankMatrix`, `RankMatrixColumn`, `RankMatrixRow` and `RankMatrixCell` in `src/server/rank-matrix.ts`; use type-only imports in the GPT-owned controller rather than redeclaring the server DTO. The envelope contains current role, tracker ID, fixed DataForSEO/Google/organic-search source, current target, enabled devices, as-of, applied filters, matching keyword count, ordered columns/rows and next cursor. Full UTC SQL timestamps retain microseconds. Cursor scope binds project/tracker, filters, target and authored/keyword revisions. A changed scope requires reloading, not rewriting an opaque cursor.

`exportRankMatrix(projectId, userId, trackerId, raw, signal?)` accepts only `{device, search?, pinned?, runLimit?}` with numeric `runLimit`; it rejects a supplied cursor, row data or metrics. It exports all matching current keywords, up to the tracker cap1000, against one stable set of up to26 run columns inside one repeatable-read server snapshot. Output is long-form: one keyword/device/run row, not a giant wide spreadsheet. Header-only output for zero checks is legitimate and reports rowCount0; the UI explains the population before download.

Proposed route: `POST /api/projects/:projectId/rank-trackers/:trackerId/matrix/export`, existing cookie/current-membership/Origin checks, no bearer capability expansion. Return the actual CSV with fixed filename `rank-matrix.csv`, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and bounded decimal `X-Export-Row-Count`. Do not return CSV as JSON or construct filenames from untrusted keywords. Financial fields, credentials, actors, raw SERP, internal account fingerprints and provider task IDs are excluded.

Every CSV cell goes through existing `csvCell`, including keywords, URLs, dates and signed deltas; quoting alone does not prevent formula execution. Missing numeric values are empty with adjacent explicit status/basis/coverage, while measured zero remains0. Preserve keyword/run/task UUIDs, captured scope, compatibility, observed/retrieved timestamps and raw/derived expiry markers. Query statements have5-second limits; export has a30-second elapsed check,16MiB output cap and AbortSignal checks. An oversized export returns413 with no partial download. A timeout/error never becomes an empty successful file.

The UI's export action captures the applied filters, aborts superseded reads, checks response type/count/size, then creates a short-lived Blob URL only after the same account/project/generation is still current. Revoke it on use/unmount. 401/403/404 purge role, data and pending downloads. Navigation may abort a read/export; there are no writes or unknown-mutation retry states in this reporting surface. An explicit refresh may retry a failed export. Never automatically fetch provider data to fill a gap.

## Bounded implementation and acceptance

Backend additions are `src/server/rank-matrix.ts` and `tests/rank-matrix-integration.ts`. Parent owns later route wiring and optional workflow invocation; identity owns distribution source/tests. Shared existing sources remain frozen until explicitly assigned. The first Kimi leaf should be one pure `RankReportingView.tsx`, with already formatted strings and callbacks from a GPT-owned controller, no fetching, state, router, dates, financial arithmetic or metric inference. Publish/review its exact public contract before launch. No Kimi task has been started for this surface.

Required checks: current-role/tenant boundaries, duplicate/unknown query rejection, literal wildcard characters, microsecond cursor ties and scope changes, full/partial/failed/pending/expired column selection, subset/quote/skipped exclusion, removed/recreated IDs, missing task versus absent capture, raw-only versus derived expiry, exact target/basis/equal-date delta guards, formula/quote/newline CSV cells, all1000 rows beyond the visible page, output/abort limits, zero checks and server-owned filter selection. Browser acceptance must cover applied/draft filters, late responses, scope remounts, role loss, no download after abort/navigation, exact date/basis copy, 1440px/360px and keyboard focus. These synthetic checks do not establish live DataForSEO or general capacity acceptance.

## Self-contained presentation leaf

The following is an original public-intended presentation contract. It contains no fixtures, credentials or customer data. After supervising review/publication, the bounded Kimi task may receive this section verbatim. Produce only `src/components/RankReportingView.tsx`, a pure React19/TypeScript JSX component of at most160lines. Export the exact types and named component below. Import only `type * as React from 'react'`. No hooks, state, effects, timers, API, router, DOM access, storage, sorting, parsing, date/math operations, new dependencies or external assets. Only reviewed Ponytail/UX Copy Refiner Skill calls are permitted; no shell/files/network/subagents. GPT supplies the lifecycle controller and independent acceptance.

```ts
export type RankReportingDevice='desktop'|'mobile';
export type RankMatrixFilters={device:RankReportingDevice;search:string;pinned:'all'|'true'|'false';runLimit:number};
export type RankDistributionGroupDisplay={id:string;title:string;denominator:string;observedCoverage:string;top100Comparable:string;counts:readonly {id:string;label:string;value:string}[]};
export type RankMatrixColumnDisplay={id:string;startedAt:string;utc:string;status:string;method:string;trigger:string;target:string;compatibility:string};
export type RankMatrixCellDisplay={runId:string;state:string;position:string;change:string;coverage:string;observedAt:string;retrievedAt:string;availability:string};
export type RankMatrixRowDisplay={id:string;keyword:string;caseRule:string;pinned:boolean;cells:readonly RankMatrixCellDisplay[]};
export type RankReportingViewProps={
 prefix:string;role:'owner'|'admin'|'editor'|'viewer'|null;mode:'distribution'|'matrix';
 loaded:boolean;reading:boolean;exporting:boolean;error:string;notice:string;
 source:string;target:string;asOf:string;dates:string;enabledDevices:readonly RankReportingDevice[];
 distributionDevice:'both'|'desktop'|'mobile';distributionDirty:boolean;distributionApplied:string;
 runChoiceId:string;runChoices:readonly {id:string;label:string}[];loadingRuns:boolean;runsError:string;
 canPreviousRuns:boolean;canNextRuns:boolean;
 runLabel:string|null;groups:readonly RankDistributionGroupDisplay[];
 matrixFilters:RankMatrixFilters;matrixDirty:boolean;matrixApplied:string;population:string;
 columns:readonly RankMatrixColumnDisplay[];rows:readonly RankMatrixRowDisplay[];
 hasNext:boolean;canFirst:boolean;canExport:boolean;
 onMode:(mode:'distribution'|'matrix')=>void;onDistributionDevice:(device:'both'|'desktop'|'mobile')=>void;
 onApplyDistribution:()=>void;onLatestDistribution:()=>void;
 onRunChoice:(runId:string)=>void;onPreviousRuns:()=>void;onNextRuns:()=>void;
 onMatrixFilters:(filters:RankMatrixFilters)=>void;onApplyMatrix:()=>void;
 onNext:()=>void;onFirst:()=>void;onExport:()=>void;onCancelExport:()=>void;
 onRunDistribution:(runId:string)=>void;onOpenRun:(runId:string)=>void;
 onOpenKeyword:(keywordId:string)=>void;onCheckHistory:()=>void;
 onRefresh:()=>void;onBack:()=>void;
};
export function RankReportingView(p:RankReportingViewProps):React.JSX.Element;
```

All strings/counts/date labels/deltas are validated and formatted by the controller. Render them verbatim; do not derive percentages, infer observations, replace missing values with0 or calculate colors from positions. Unknown/expired/incompatible text is deliberate. Arrays arrive in display order. No provider setup, quote creation, paid/scheduled actions, run-ID text field or fetch belongs in this view. The controller reuses the existing `/runs` endpoint with50-row page replacement for native run choices, retaining an explicit option for the selected run if outside that page. Labels identify full/subset, status and dates honestly, including quoted/skipped receipts. No unbounded option accumulation.

Use existing `research-panel stack`, `card stack`, `row`, `between`, `field`, `hint`, `dim`, `alert`, `notice`, `btn primary`, `btn ghost`, `table-wrap`, `pill`. Header h2 exact **Rank reporting**, id `prefix+'heading'`, tabIndex=-1, no h1. Common **Back to tracker** button calls onBack. Error text is role alert, notice is role status. Reading says **Loading rank reporting…**; exporting says **Preparing CSV…** and shows **Cancel export**. These are reads: Back and filter editing remain usable while loading/exporting, with cancellation owned by the controller.

When role is null, show no protected scope, filters, table or aggregate. After loading ends show **Reload access** calling onRefresh and **Reporting is unavailable. Reload access or return to the tracker.** Otherwise common buttons **Distribution**, **Recent checks** have aria-pressed from mode and call onMode. **Refresh reporting** calls onRefresh. Scope card displays source, target, **As of:** asOf and, when nonempty, dates. Avoid repeating a giant empty card per metric.

Distribution form prevents submit and calls onApplyDistribution. Native select label **Distribution source** uses runChoiceId/onRunChoice: first option **Latest retained observations** value `latest`, then supplied runChoices id/label. Native select label **Distribution device** has Both applicable devices (`both`) plus enabledDevices options only; values are desktop/mobile with readable labels. onChange calls onDistributionDevice. Submit **Apply selection**; show distributionApplied separately, and distributionDirty hint **Apply the selection to update the summary.** LoadingRuns shows **Loading check choices…**, runsError is a text alert, **Previous check choices** and **Next check choices** are shown only for their can flags and call the supplied callbacks, disabled during loadingRuns. If runLabel is nonnull, display it and **Latest distribution** calling onLatestDistribution. No free text for arbitrary run IDs. Empty population remains explicit in supplied group/coverage strings; do not invent a success banner. Render each group as a modest card with h3 title, **Population:** denominator, observedCoverage and top100Comparable, then a two-column accessible table of provided label/value pairs. Never merge absolute ranks or limited coverage into organic buckets.

Matrix form prevents submit and calls onApplyMatrix. Native controls: **Device** (enabledDevices only, single device), **Keyword contains** (maxLength200), **Pinned keywords** (all/true/false => All/Pinned/Unpinned), **Recent check count** number min1 max26. Events call onMatrixFilters with a complete shallow copy; use `valueAsNumber` for count without normalization/clamping. Button **Apply filters**. Show matrixApplied and population; matrixDirty hint **Apply filters to update the matrix.** **Export matrix CSV** calls onExport and is disabled only when !canExport, matrixDirty or exporting. Export includes all matching current keywords in one fresh snapshot, not merely this page: state that in one hint.

The matrix uses a labelled/focusable region (`table-wrap`, role region, aria-label **Recent rank checks**, tabIndex0). Table minimum width900; each run column minimum180px with a readable keyword column minimum200px, so360px scroll is contained within the region. Header first cell **Keyword**. Each run header contains a button labelled startedAt calling onOpenRun(id), UTC text, status, method/trigger, captured target and compatibility; secondary **Distribution** button calls onRunDistribution(id) with an aria-label that includes startedAt and UTC to distinguish repeated dates. Provider target strings remain inert text. Each row begins with keyword button calling onOpenKeyword(row.id), caseRule and optional Pinned pill. Each cell shows position, state, change, coverage, **Observed:** observedAt, **Retrieved:** retrievedAt and availability as distinct supplied text. Do not collapse every unknown into an em dash. No links, rawHTML, tooltips as the sole source of measurement dates or client-derived delta arrows.

Show loaded/nonerror/nonreading empty states accurately: rows empty => **No current keywords match these filters.**; otherwise columns empty => **No full started checks are available in this recent window.** Quotes, skipped schedules and subset checks remain in **Check history**, a button calling onCheckHistory. Do not show a wide empty table when either dimension is empty. Footer **First keyword page** calls onFirst, shown when canFirst; **Next keyword page** calls onNext, shown when hasNext. Disable page buttons while reading or matrixDirty. Pagination replaces the full envelope and columns; it is not appending to an immutable report. If the controller masks newly expired data from remembered tombstones, canExport stays false until a fresh authoritative response confirms safe scope; the view must not override it. Explicit button types, associated labels, unique prefix-based IDs, status text and44px native controls are required. No extra configuration/design system or format support.

Observed backend acceptance at this checkpoint: seven synthetic real PostgreSQL groups pass through0024, including real `handleApi` viewer/cookie/Origin/API-key/body/query/rate checks. A fresh1,000-keyword×26-run export produced26,000 rows in1.505seconds on its isolated fixture; a larger URL payload correctly failed the16MiB cap without returning a partial file. This is one measured workload, not a capacity guarantee. Reporting UI/browser and live-provider acceptance remain pending.

## Local acceptance

The implementation and evidence are recorded in [rank tracking](rank-tracking.md#reporting-acceptance-2026-10-13). Six distribution and seven matrix PostgreSQL/API groups, eight reporting browser groups, production build and TypeScript pass. The pure view was drafted by guarded Kimi K3 from this published contract; GPT owns the protected controller, services and acceptance. Preview publication and hosted CI are recorded separately. Latest-results and full-history exports remain separate outstanding contracts.
