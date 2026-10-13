# Adjacent-period AI comparisons

Implemented and tested locally on 2026-10-13 as an extension to [retained-answer
insights](ai-insights.md), tracked in
[issue 46](https://github.com/Ten98-IO-Company/ten98-monitor/issues/46).
It adds no schema, provider request or schedule. This does not complete P16/P17.

## Measurement

The current range has 1–31 inclusive local calendar days. The previous range is
the immediately preceding equal number of calendar dates, in the same selected
IANA timezone. A 23-hour, 25-hour or skipped local day is not replaced with an
elapsed UTC-day window. Current date/model/prompt/tag/matcher filters apply to
both periods. Capacity limits cover the combined population, including rows
excluded by the cohort: 1,000 execution children, 10 MiB of retained answer and
copied-request payload, and bounded matching work. Overflow fails explicitly.

The default cohort is **Currently classified neutral prompts**: classify each
execution's immutable prompt version using current brand context, aliases and
current user-tag overrides. **All prompts** is an explicit alternative. This
does not claim to recover earlier tags, brand context, markets or languages.

A comparison cell identifies project, prompt/version, exact rendered message
sequence, maximum output tokens, requested model, selected OpenAI route and
fixed API-text/no-search collection profile. It also binds the current subject
profile, matcher and answer-eligibility version. Credentials, prices, quote IDs,
actors and sibling model selections do not define a cell. The existing quote
input hash includes those unrelated values and must not be reused as the cell
key. Resolved-model absence on a failed child cannot create another coverage
cell; valid supported answers must match the requested model.

Copied inputs must remain available under the same elapsed-24-hour retention
cutoff and pending-child protection used by receipt reads and cleanup. Validate
the messages against immutable authored text and captured request fields. Missing
or expired identity stays unavailable; malformed identity is separate. Do not
reconstruct a removed system message from current settings or retain raw input
solely to make the comparison work.

One execution child is one attempt. Usable evidence requires both an eligible
retained answer and an available validated cell identity. Two-model comparisons
contribute two children. Failure, pending work, truncation, filtering, expiry and
invalid evidence remain in coverage; they are never negative brand mentions.

Cells with usable answers in both periods are matched. For each entity, average
the mention rates of those cells with equal weight; do the same independently
for citation rates. Return reduced exact rational fractions and integer counts
per cell. For example, cells with 2/2 and 0/1 mentions average 50%; pooling their
answers would give 66.7% and answers a different question. This metric is not
share of voice. When no cells match, show the current all-cell rate with its
explicit basis; previous matched rates and deltas remain unavailable.

## Availability and comparability

Evaluate states in this order:

| State | Meaning |
| --- | --- |
| `no_data` | No current attempts in the selected cohort. |
| `no_previous` | No previous attempts. |
| `unavailable` | Either period has no usable answers. |
| `scope_changed` | Both periods have usable answers but no shared cells. |
| `in_progress` | Shared cells exist, but the current end date is today or later locally. |
| `incomplete` | Shared cells exist, but usable/attempted coverage is below 90% in either period. |
| `comparable` | Both closed periods meet the threshold and share usable cells. |

Only `comparable` exposes signed change, displayed as percentage points. The
coverage threshold uses integer multiplication, not rounded percentages.
Always separate collection coverage from matched-cell coverage: a high answer
completion rate does not imply every prompt or cell matched. No significance,
causation or performance recommendation is inferred from a difference.

## Read, drilldown and export

`GET /api/projects/:projectId/prompt-insights/comparison` admits current membership
into one repeatable-read snapshot. Every role, including viewer, can read and
export. No provider credential, available credit or running worker is required.

The default page contains up to 50 comparison cells. Execution pages select a
current/previous period, optional cell and an all/usable/unavailable or entity
mention/non-mention/citation outcome. Headline populations do not change with
drilldown. Revision-bound cursors and full-report CSV include both periods,
cohort/formula/classifier, current context, semantic identities and evidence
availability. Changed evidence rejects stale pages/exports with 409; no silent
resampling or latest-only truncation.

Each report also carries a bounded, raw-text-free evidence-state list for the
whole selected population, even while displaying one cell or execution page.
The controller checks those states against coverage and remembers learned expiry
across page changes and nested receipts. Ordinary insights has the same scoped
answer-state check; parent and comparison exchange learned answer expiry. This
prevents already-observed expiry from reappearing in aggregate rates after a
retention-policy extension during that mounted workflow. IDs outside the selected
population do not invalidate unrelated reports. This is not a new persistent
retention store; existing server masks and purge markers remain authoritative.

`POST /api/projects/:projectId/prompt-insights/comparison/export` accepts only the
full applied filters and expected selection revision. CSV contains coverage,
entity means, both sides of every cell and all selected executions, regardless
of the displayed page. Preserve formula protection, explicit headers and the
16 MiB bound. It contains derived matches and authored prompt previews, not raw
answer or copied system-message text. See the [interface contract](ai-comparison-ui.md).

## Source correspondence and remaining requirements

The pinned [OpenSEO trend implementation](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/ai-visibility/services/aiVisibilityTrend.ts)
motivates equal-cell weighting and coverage-gated differences. Its captured
automatic neutral cohort and rolling UTC windows differ from this explicitly
current-context local-calendar method. Exact baseline compatibility and
prospective immutable historical identity capture remain required.

The pinned [Elmo series implementation](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/postgres-read.ts)
carries per-prompt daily count vectors and seeds leading gaps from the first
in-window observation. Its carried trends/current standings and actual pooled
totals are different views. Those source methods remain required, with explicit
provenance and retention barriers preventing an expired newer observation from
silently reviving an older one. This increment does not claim those capabilities.

## Local acceptance

The full unit suite passed 398 checks with two existing platform-specific skips.
Four new arithmetic groups independently verify exact rational means/differences,
unequal cell populations, scaling/order invariance and invalid-input limits.
Eight comparison PostgreSQL/API groups passed on a fresh isolated schema-29
database, covering every availability state, copied identity/cohort changes,
membership, pagination and full CSV, elapsed retention, DST/skipped dates,
snapshot consistency, capacity rejection and HTTP authorization boundaries.
The seven existing insight integration groups also passed with the full-population
state manifest. CI runs both database suites independently.

Browser acceptance passed eight pure-view groups, eight protected comparison
groups, nine insights/controller groups and eight existing receipt groups.
These cover role/dirty/busy controls, hostile text, stale and cancelled requests,
malformed responses, exact export bounds, both-direction expiry, off-page evidence,
and receipt Back with preserved entity/cohort/filter scope. The Kimi K3 presentation
draft received GPT review and corrections for unapplied-cohort locking and readable
table columns; it performs no data access or metric calculation.

Eighteen production application navigation groups passed against a separate local
database and production server. Owner and viewer both read/exported the two-period
fixture, opened the exact current/previous receipts, and returned with preserved
filters and fresh reads. The original retention and financial-state assertions
remain. Desktop and 360px screenshots were inspected, with horizontal table
scrolling contained inside the page. TypeScript, production build and the plan
checker passed. No real provider calls, worker jobs, live-preview fixtures or
production-capacity claims are part of this evidence.
