# Retained Meta campaign inventory

Implementation contract reviewed2026-10-13. This closes the campaign-inventory
part of the accepted native Meta reporting scope; it is not implemented yet.
Existing advertising-account selection and daily Insights reports are separate.

## Provider evidence

The tagged official [AdAccount read edge](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py#L2520-L2554)
supports campaign enumeration with an effective-status filter. Request a fixed
GET on `v26.0/act_{account}/campaigns`, page size100, with no activity/date filter.
The [Campaign fields and status vocabulary](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/campaign.py#L28-L105)
support `id,account_id,name,status,effective_status`. Include all six reviewed
effective statuses: ACTIVE, PAUSED, ARCHIVED, DELETED, IN_PROCESS, WITH_ISSUES.
Configured status and effective status are different values. Preserve omitted
values as unavailable and unfamiliar bounded labels as unknown; neither means
active. This SDK establishes the request shape, not full account permissions or
a guarantee of every deleted campaign's availability.

The official [cursor implementation](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/api.py#L765-L808)
distinguishes an after cursor from the presence of another page. A final response
may still contain after. The application follows only a validated opaque cursor
when a next-page indicator exists, rebuilding its fixed route. It never follows
the supplied URL. Empty intermediate pages with continuation are not completion.
Duplicate campaign IDs across pages, repeated cursors, malformed data or foreign
account rows invalidate publication. Nothing from that SDK is copied or installed.

## Smallest complete workflow

From a selected Meta source, open **Campaigns**, review the last retained
inventory and choose **Refresh campaign inventory** explicitly. Current owners
may refresh or cancel; current members may read retained inventory and CSV.
Opening the screen, restarting the worker or disconnecting a source never
requests a provider refresh. Retained historical Insights rows remain readable
when a campaign is absent from the current inventory.

Reuse the fixed Meta HTTP boundary, source/grant admission, pg-boss queue,
workspace role checks, actor-bound request receipts and existing source-lock
order. Every outbound GET and publication rechecks the captured source/grant and
account metadata. HTTP never runs under database locks. Jobs carry local IDs.
Inventory is a separate receipt/page dataset: daily date-range constraints and
async-report submission states do not fit a campaign metadata walk.

Capture source identity, immutable grant/app/connection revisions, request time,
first/last observation time, status, cursor/generation/lease and completeness.
Use queued → reading → completed/partial, with failed/denied/cancelled outcomes.
No report-creation POST or charge reservation is needed. A captured interval is
not an atomic Meta snapshot; campaigns can change between pages. A complete
empty inventory means no records returned under this grant, never zero activity.

Bound refresh to50pages of100records,30minutes and three retries per GET operation
with the existing15/30/60-second backoff/cooldown policy. The refresh deadline
bounds repeated failures across pages. Each step publishes one
validated page under its current lease. A clean final page completes; a capacity
or deadline stop leaves an explicitly partial snapshot. An invalid later page
hides the whole attempt. Never let a partial/failed attempt replace an earlier
completed snapshot as the default. Preserve history and exact receipt provenance.

Extend signed-deletion admission and its completion check to inventory receipts
and pages, including older grants. Retention uses the existing derived-history
policy and bounded physical page cleanup. Visibility masks apply immediately
before asynchronous erasure; extending retention cannot restore erased data.
Cancellation/role loss/reconnect/disable/deletion must reject late publication.
Export reuses formula-safe CSV and explicit size limits; there are no activity,
spend, reach or conversion totals in this metadata dataset.

Acceptance requires pure parsing checks, actual PostgreSQL/API/queue recovery,
tenant/current-role and deletion fences, zero unintended provider calls, browser
read/refresh/cancel/history/export, and a separately authorized live-account
check. These limits are application capacity decisions, not Meta quota claims.

## Pure Kimi parser contract

Implement only `src/server/meta-campaign-rows.ts`; export exactly this API:

```ts
export type MetaCampaign = {
  id: string; accountId: string; name: string | null;
  status: string | null; effectiveStatus: string | null;
};
export class MetaCampaignRowsError extends Error {}
export function normalizeMetaCampaigns(value: unknown, accountId: string): MetaCampaign[];
```

This is a pure boundary for JSON-decoded provider values, not an arbitrary
JavaScript plugin-object sandbox. No I/O, logging, environment, clocks,
randomness, dependencies, URLs, database or other module changes. Native
`toUSVString` from `node:util` may check Unicode; do not rely on an unavailable
TypeScript String.isWellFormed library declaration.

- Validate `accountId` as1–40 ASCII decimal digits with a nonzero first digit;
  no numeric inputs, leading zeros, `act_` prefix or whitespace normalization.
- Input must be an array of0–100 non-null object records, excluding arrays.
  Every record requires own string `id` and `account_id` with the same ID grammar;
  `account_id` must equal the supplied account. Reject duplicate IDs within the
  page. Preserve input order and do not mutate the input.
- Optional fields are read only when present as own properties. `name` absent,
  undefined or null becomes null. Otherwise require a string of
  at most512 UTF-16 code units, valid Unicode and no ASCII control characters
  U+0000–U+001F or U+007F. Preserve empty strings, whitespace, punctuation and
  non-ASCII text exactly; do not trim, escape, format or infer a label.
- `status` and `effective_status` absent, undefined or null become null.
  Otherwise accept only1–64 characters matching ASCII `[A-Z_]+` exactly.
  Preserve unfamiliar values; do not collapse them to an existing enum. UI
  interpretation is separate from this source-evidence parser.
- Return only the five named output fields. Ignore unrelated source fields;
  never copy them, merge source objects or return raw input. Reject malformed
  selected fields rather than silently dropping individual records.
- All invalid inputs throw `MetaCampaignRowsError` with the fixed safe message
  `Meta returned an unsupported campaign inventory.` No raw value in errors.
  Use a native Set for duplicate detection; no generic parsing framework.

GPT owns independent tests and downstream transport/storage/UI integration.
Do not generate a test file or call this parser directly from a live provider.

### Parser acceptance

The pure parser was drafted by Kimi K3 with maximum-effort thinking under the
bounded public-input profile. GPT review and eight independent Node test groups
pass: strict IDs/account scope,100-record limit/duplicates/sparse arrays,
Unicode/control/status boundaries, null versus empty, own-property evidence,
exact output projection and input immutability. The inventory workflow remains
under implementation; parser acceptance alone does not complete it.
