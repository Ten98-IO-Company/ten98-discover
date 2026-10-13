# Meta daily report normalization

GPT-reviewed pure implementation contract, 2026-10-13. This is the next bounded
Kimi implementation leaf for [native Meta imports](meta-reports.md). The transport,
authorization, report creation/polling, pagination, persistence and source/date
authority remain GPT-owned. This parser performs no requests or writes.

## Public interface

Create only `src/server/meta-report-rows.ts`, using the installed Zod dependency
and Node standard library if helpful. No new dependency, network, filesystem,
environment, clock, randomness, logging or mutable global state. Export:

```ts
export type MetaReportKind = 'account_daily' | 'campaign_daily';
export type MetaReportScope = {
  report: MetaReportKind;
  accountId: string;
  currency: string;
  from: string;
  to: string;
};
export type MetaAction = {
  type: string;
  value: string | null;
  windows: Record<string, string | null>;
};
export type MetaDailyRow = {
  date: string;
  accountId: string;
  campaignId: string | null;
  campaignName: string | null;
  impressions: string | null;
  clicks: string | null;
  spend: string | null;
  actions: MetaAction[] | null;
  actionValues: MetaAction[] | null;
};
export function normalizeMetaRows(value: unknown, scope: MetaReportScope): MetaDailyRow[];
```

`value` is the already-decoded `data` array from one Insights page, not its envelope.
Require a dense array of at most500 rows. An explicit empty array succeeds. Missing,
null or another type fails; do not invent successful emptiness. Every invalid
input/scope throws only `Error('Meta returned an invalid report page.')`, without
provider content, detailed Zod errors or a partially normalized result.

## Validation and interpretation

Validate the supplied scope as well as rows; TypeScript is not runtime authority.
Scope has exactly the five defined own keys and known report kind. Mandatory
scope, row and action members must be own properties; never consume inherited
optional values as provider evidence. Provider IDs are
positive canonical decimal strings of1–40 digits. No Number conversion. Currency
is exactly three uppercase ASCII letters. Dates are exactly `YYYY-MM-DD`, years
0001–9999, valid Gregorian dates using a native UTC round trip, from<=to and at most31 inclusive
days. Provider-local current-day/history checks happen before this parser; it
must not use the machine's current date or timezone.

Each row requires:

- `account_id`: exact scope.accountId.
- `account_currency`: exact scope.currency.
- `date_start` and `date_stop`: valid equal dates within the inclusive scope.
- For `campaign_daily`, canonical `campaign_id`; optional/null `campaign_name`.
- For `account_daily`, `campaign_id` and `campaign_name` must be absent or null.

Optional/null `account_name` and `campaign_name` are display text of at most512 UTF-16
code units. Null/absent campaign names normalize to null, not an invented label.
When present, names must be nonempty and valid Unicode with no ASCII controls
or DEL. Preserve case and spaces, render as text later. Account name is validated
if supplied but does not become a join key or override the captured source label.
The complete row-key allowlist is `account_id`, `account_currency`, `account_name`,
`date_start`, `date_stop`, `campaign_id`, `campaign_name`, `impressions`, `clicks`,
`spend`, `actions`, `action_values`. Reject every other key. In particular, do not
discard an unexpected ad/ad-set/demographic/platform breakdown and pretend its
one slice is an account or campaign total. Any non-null campaign identity on an
account-grain row is a contradictory grain and fails.

`impressions` and `clicks` are optional/null canonical nonnegative integer strings,
at most30 digits. `spend` is an optional/null nonnegative ordinary decimal string:
canonical integer part of1–30 digits, optional fraction of1–18 digits. Apply the
same decimal rule to action totals and window values. No sign, exponent, comma,
whitespace, leading zero except integer0, numeric JSON primitive, NaN or Infinity.
Never round, convert to Number, change scale or strip trailing zeroes. For example
`9007199254740993.012300` remains that exact string. Omission/null becomes null;
explicit `0` or `0.00` stays explicit zero. Negative reporting adjustments require
a separately reviewed provider contract; this profile fails closed on them.

Normalize optional/null `actions` and `action_values` independently to null.
Explicit empty arrays stay empty. Each non-null dense array has at most200 items. Each
item is an object with required nonempty `action_type` text up to200 code units,
valid Unicode and no controls/DEL, optional/null decimal `value`, and optional
window fields from the following fixed allowlist:

```text
1d_click 7d_click 28d_click 1d_view 7d_view 28d_view
```

Map action_type to type; value to the exact string or null; include only supplied
window fields, retaining null values. Missing windows do not become zero or null
entries. Reject duplicate action types within each array, unknown item keys,
unexpected action breakdowns, nested values and malformed metrics. Do not combine
actions with action_values, parent and child action types, or attribution windows.
The two arrays may contain the same action type and remain separate.

These six field names are factual response vocabulary in the official pinned
[AdsActionStats reference](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adsactionstats.py).
Only7d_click and1d_view are requested by the initial report definition. Preserving
another returned supported field does not claim it was requested, supported for
every account, additive, or the effective ad-set attribution setting. Other/new
response profiles require an explicit contract update, not silent interpretation.
No SDK code is copied or installed.

Reject duplicate logical row keys within this page: `(date, accountId, campaignId)`.
Account and campaign grains never merge. Preserve the provider's row/action order;
the worker separately rejects keys repeated across pages and incompatible snapshot
metadata. Produce fresh objects/arrays and never mutate input. No raw envelope,
paging URL, cursor, account_name or unknown fields escape in the output.

## Independent GPT acceptance

Use Node's existing test runner. Cover both grains; leap-day and invalid calendar
dates;31-day inclusive limit; source/currency/date/grain mismatch; same-name distinct
IDs beyond safe integer; null/absent/empty versus explicit zero; fractional actions
and large exact decimal scale; malformed numeric primitives/exponents/signs;
duplicate row/action keys; disallowed nested action dimensions/windows; controls,
unpaired surrogates and valid astral/hostile-looking plain text;500/501 rows and200/201
actions; sparse arrays and inherited fields; terminal line breaks in exact-format
values; years0001–0099; safe action-type labels such as `__proto__`; input
immutability and uniform redacted errors. Test these semantic
boundaries, not a second copy of the implementation. Synthetic parser checks do
not claim a working import worker or live-provider acceptance.
