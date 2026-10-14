# Rank tracking implementation contract

> Code and safety contracts retained from [docs/rank-tracking.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/rank-tracking.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/rank-tracking-implementation-contract-implementation-history-6d85OmGVzB). Qualifications are preserved; this adds no acceptance claim.

## Source and product flow

Pinned OpenSEO `89e5a00717cdf049b7c2b4e29646edb3a7d4995b` provides [tracker/keyword/run/snapshot storage](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/db/pg/app.schema.ts#L215), [management and execution entry points](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/serverFunctions/rank-tracking.ts), [SERP matching](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/dataforseo/serp.ts#L134), [scheduled execution](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/rank-tracking/services/scheduledRankChecks.ts) and [latest/history comparisons](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/rank-tracking/services/rankTrackingResults.ts). These are static source observations, not upstream runtime acceptance.

Add **Rank tracking** beside Keywords and Site audits in the planned Search/SEO navigation group. Its list leads to a tracker detail screen with Latest, History and Runs. Setup captures domain, supported national/local SERP location, language, desktop/mobile/both, requested depth 10–100 and a visible page limit. Prefill the project hostname. Public competitor hosts are valid targets without granting collector-domain authorization. Match organic results using an exact hostname or dot-boundary subdomain; do not report SERP-wide features as features owned by the target.

Create tracker → add pasted or selected saved keywords → review check cost → start → inspect durable pair-level progress/results. Adding, pinning, removing, filtering and inspecting history never make paid requests. Save and cancel actions are explicit. Default scheduling is Manual only. An owner can separately approve daily, weekly or local month-end recurring checks with a timezone, next occurrence and per-run ceiling.

Keyword case preservation is explicit. Default add trims and lowercases; case-preserving add retains spelling. Preserve internal whitespace and literal percent/plus text. Stable keyword UUIDs, rather than spelling alone, bind jobs and history. Remove/recreate never redirects old work to a new record. Pins are shared project state. Input batches accept at most 2,000 raw entries; capacity checks reject overflow atomically, never truncate. The upstream operational bound of 1,000 keywords per tracker allows up to 2,000 keyword/device tasks in a full check. This is not a paid tier or a limit on the number of projects.

## Provider and spending contract

Use dedicated DataForSEO Google organic SERP adapters: Live Advanced for interactive checks, standard queued Task Post and free Task Get for scheduled work, and SERP ID List for recovery. Validate supported SERP locations/languages separately from Labs keyword markets. Restrict transport to fixed endpoints, Windows desktop/Android mobile, normal priority, organic target matching, and approved parameters. Do not expose arbitrary provider URLs or paid AI-overview/PAA/rectangle flags. Preserve literal `%` and `+` using the provider's encoding rules. [Live request contract](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/), [queued request contract](https://docs.dataforseo.com/v3/serp/google/organic/task_post/)

Do not copy the pinned source's 75% extra-page pricing. Current Google-specific pricing uses a full base price per additional page. Runtime quotes use verified account prices, exact integer currency, an explicit crawl-page ceiling and conservative search-operator treatment. Multiple-operator documentation is ambiguous; the quote calculation and tests must make its conservative interpretation explicit. [Current Google pricing](https://dataforseo.com/pricing/google-serp/google-organic-serp-api)

Requested result depth is distinct from billed crawl pages. Capture both depth and `max_crawl_pages`; when a page limit yields fewer results, display observed coverage instead of claiming absence throughout the requested depth. [Page-limit semantics](https://dataforseo.com/help-center/what-is-max-crawl-pages-and-how-does-it-work)

Each paid HTTP dispatch references one existing spending-ledger reservation. A parent quote captures exact keyword UUID/text/device pairs, target/market, actor, configuration version, connection revision, persisted version-2 account fingerprint, price evidence, maximum charge and expiry. Start first checks the durable request receipt, then fresh authority and immutable inputs; all reservations and queue jobs commit atomically. Paid POSTs have no automatic retries. Unknown acknowledgements remain uncertain and pause spending. Free known-task polling is restartable and does not resend the paid request.

Queued post charges are provisional. Keep the approved ceiling reserved until terminal evidence proves the final charge, including early-stop refunds. Free retrieval reports the original task's charge, not another bill. Publication can be partial while financial settlement waits for the remaining tasks. [Task retrieval](https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/), [early-stop charging](https://dataforseo.com/help-center/using-the-stop_crawl_on_match-parameter-in-serp-api)

Recovery binds account, task tag, exact captured request, provider task ID when known and dispatch time. Ambiguous/truncated evidence remains unresolved. A new paid live fallback needs a separate explicit quote or an already approved fallback ceiling; there is no hidden escalation after a queued timeout. Cancelling stops only undispatched work. Permission removal after dispatch must not suppress the incurred charge. [Recovery metadata](https://docs.dataforseo.com/v3/serp/id_list/)

## Persistence and recurring execution

Reuse existing PostgreSQL, project mutation gates, actor-bound content receipts, encrypted credentials/account identity, spending ledger, pg-boss and retention. Proposed rank-specific tables are tracker, keyword, immutable quote/run, paid dispatch and task/observation. Task rows also supply history; avoid another snapshot-copy table. Composite scope constraints guard cross-project association. Quote/approval references must join the shared missing-account-key safeguards so identity keys cannot be regenerated after rank financial history exists.

Store IANA zone, wall-clock hour/minute, weekly weekday where needed and local month-end cadence. Use PostgreSQL calendar arithmetic and `AT TIME ZONE`; no separate timezone dependency. Preview exact upcoming local and UTC occurrences. Define and test gap/fold behavior, including half-hour transitions. PostgreSQL's conversion policy prefers the pre-transition offset for gaps and the post-transition offset for folds. [PostgreSQL timezone rules](https://www.postgresql.org/docs/18/datetime-invalid-input.html)

A standing recurring grant belongs to a current owner and binds the approved request definition, keyword set, provider revision/account and per-occurrence ceiling. Changing paid inputs invalidates that grant; pinning does not enlarge spending. Read due candidates without holding locks, fetch free prices outside transactions, then recheck under workspace → project → tracker locks. A unique approval/occurrence key, run, reservations, jobs and next occurrence commit together. Record overlap/empty/budget/authority skips and advance beyond now without catch-up bursts. Workers use durable bounded polling with lease/generation fencing, not a sleeping fifteen-minute job.

## Results, metrics and history

Keep last successful observation and latest attempt separate. Distinguish ranked, not found in observed coverage, not checked, pending, failed, cancelled and expired. Store each observation's immutable target, location, language, device, depth/page limit, organic rank basis and timestamp. Compare only compatible definitions. For 1/7/30/90-day comparisons, expose the actual baseline date; an earliest-observation fallback is labelled as such. Never turn missing data into rank zero.

Provide literal search, outcome/device filters, shared pins, subset checks, CSV/spreadsheet-safe exports, recent-run matrix, per-keyword history and complete-run distributions with coverage. Graphs show missing observations as gaps. Keyboard-accessible horizontal tables retain readable keyword/outcome columns at 360px. Read-only roles cannot mutate or approve work. Unknown acknowledgements retain exact retry intent; stale responses or live access loss cannot repopulate another project.

Keyword metrics and ranked-keyword suggestions are separate explicitly quoted capabilities. Reuse the existing Labs worker only where its actual market contract applies. Upstream local metrics combine Ads local volume/CPC with national Labs difficulty, and non-Labs countries need Ads; a national substitute is not local parity. These paths and their paid actions remain required implementation work. Copying Saved keywords into a tracker does not couple their deletion lifecycles. [Source metric routing](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/dataforseo/keyword-metrics.ts#L115)

Authored trackers/keywords/pins survive retention. Raw evidence follows the approved 90-day default; derived rank/metric history follows 365 days, both configurable. Preserve necessary idempotency/financial evidence. Late polling or reconciliation cannot resurrect expired payloads. Archive pauses future scheduling and preserves retained history.

## Acceptance and Kimi leaves

Independent checks must cover literal `C++`/`%20`, case variants, domain boundaries, unsupported markets, exact pricing/page caps, partial device outcomes, incompatible comparison baselines, queue rollback, lost acknowledgements without POST retry, provisional refunds, duplicate schedules, worker restart, DST/month end, credential/login-secret rotation, post-dispatch demotion, delete/recreate and retention races. Production desktop/mobile browser flows, upgrade preservation and actual scheduler tests are required. Synthetic providers do not establish live-provider acceptance.

First Kimi leaf: one pure keyword mutation parser for add/remove/pin; strict JSON-shaped inputs, stable error, request UUID/revision, bounded arrays and literal case-aware normalization. Subsequent leaves may draft controlled setup/schedule fields and read-only result cells. No Kimi leaf may change SQL, pricing, recurrence, permissions, network transport or tests used to approve itself. Use the established K3/max-thinking Skill-only runner, reviewed public inputs and finite deadlines; record observed usage without inventing savings.

## Retention and recovery invariants

Run tombstones immediately mask children awaiting bounded cleanup; extending policy cannot resurrect expired payloads. Financial receipts survive, charge reconciliation remains possible after measurement expiry, and expired settled observations do not trigger a new retrieval loop.

Unknown acknowledgements preserve the exact request, including after a rate-limited retry. Server-supplied recovery capability uses the same predicate as the authoritative recovery service. Run and task expiry remain irreversible in the current view; incurred financial evidence stays separate from unknown final charges.

## History and receipt invariants

Run lists, latest compatible observations and per-keyword history use scoped microsecond cursors; removed/recreated keywords retain separate identities. The1/7/30/90-day baselines report actual dates and label earliest-available fallback. Latest attempt remains distinct from last available observation. Incompatible definitions, missing ranks and expired data never become rank zero.

History keeps current device scope, latest attempts, retained observations and unavailable/expired data distinct. Hidden history requests abort while a run is open; returning rereads current access and preserves filters without reviving expired payloads.

## Recurring authority and execution limits

Disabling future spending remains possible at the authored revision ceiling and without decrypting provider credentials. Approval uses one database clock for expiry, capture and the next occurrence.

One immutable approval/occurrence creates the full run, reservations and jobs atomically. Fresh prices, current ownership, definition, connection/account identity and both budget levels are checked; workers recheck standing authority before each paid batch. Disabling prevents unsent work while incurred work can still be collected and settled. Invalid grants disable themselves; overlap, budget, provider and price refusals produce durable skips with no paid child requests. Unexpected queue or reservation conflicts roll back instead of being disguised as budget skips. Missed intervals advance beyond the current time without catch-up bursts.

The timer handles at most one due tracker per ten-second tick per worker; this is an explicit throughput limit, not a capacity claim.

The owner flow is **Schedule → Prepare full queued quote → Configure schedule → Preview five occurrences → Approve recurring spend**. It never starts an immediate paid check. Daily, weekly and local month-end setup displays timezone, exact upcoming local/UTC times and a per-occurrence USD ceiling. The separate monthly budget still applies. Manual full queued quotes can also open schedule setup; live/subset quotes cannot. Saving, disabling and ambiguous responses retain exact request identity; Back/router navigation stays blocked while a write outcome is unknown. A known quote deadline cannot be extended by returning through another screen.

## Browser checks

The runnable browser checks are `tests/rank-tracking-browser.mjs`, `tests/rank-check-browser.mjs`, `tests/rank-history-browser.mjs` and `tests/rank-schedule-browser.mjs` with their documented opt-in environment.

## Reporting contract

The distribution and recent-check matrix reuse existing retained rank observations. Distribution partitions every captured keyword/device pair, including never-checked, limited, incompatible, expired and failed states. The matrix shows recent full started checks without dropping failed or pending columns. It separates organic and absolute positions, compares only the immediately older compatible readable observation, and opens existing receipts or keyword history. The scoped CSV includes every filtered row rather than just the visible page; formula-like cells are escaped. No reporting action contacts a provider or changes a schedule.

Returning to detail now clears protected cached content before rechecking access while keeping Back available.
