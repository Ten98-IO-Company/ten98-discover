# Native keyword research: implementation and evidence

Issue: [#20](https://github.com/Ten98-IO-Company/ten98-monitor/issues/20). Source review and synthetic acceptance: 2026-10-13.

The server, worker and [Research → Keywords interface](research-ui.md) implement DataForSEO keyword overview and bounded keyword ideas. Production browser acceptance uses synthetic provider responses and real local receipts; this is not a released V1 or completed P47/P48 parity. The public UI contract is [recorded on the issue](https://github.com/Ten98-IO-Company/ten98-monitor/issues/20#issuecomment-6135229497). No live provider account, paid request, customer keyword, or real result was used in acceptance.

## Scope and measurement

Overview accepts 1–100 unique normalized keywords. Ideas accepts one seed and a limit of 25, 50, or 100. Both use a selected supported Google country/language pair; each keyword is limited to 80 Unicode characters and 10 words. The server fixes the endpoints and disables clickstream/SERP extras. It never chooses a different paid endpoint, adds automatic pages, or schedules a follow-up request.

Saved metrics distinguish unavailable values from zero. Search volume is a provider estimate, CPC is USD, paid competition is separate from keyword difficulty, and monthly history retains its dates. Results retain retrieval time and metric update times. Omitted overview keywords and a limited ideas result are explicit. No observed native visits, Search Console measurements, or Google Analytics sessions are inferred from these estimates.

The [overview](https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_overview-live/) and [ideas](https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_ideas-live/) endpoint documentation define the request/result fields. The free [market catalog](https://docs.dataforseo.com/v3/dataforseo_labs_locations_and_languages/) supplies supported combinations. OpenSEO commit [89e5a007](https://github.com/every-app/open-seo/commit/89e5a00717cdf049b7c2b4e29646edb3a7d4995b) informed the source investigation; this slice uses original application code, with no copied upstream implementation or new dependency.

## Spending boundary

Reading saved state never contacts a provider. An explicit market refresh or quote can make free metadata requests using an encrypted workspace connection. Quotes use the account-specific prices returned by [user data](https://docs.dataforseo.com/v3/appendix-user-data/); published pricing is not embedded as a permanent authorization. Costs use exact integer micro-USD, with unsupported precision rejected rather than silently rounded down.

A quote lasts five minutes and binds the project, initiating actor, exact normalized request, connection revision, provider account fingerprint, and price. Start takes only the quote ID and an idempotency key. A workspace-locked transaction rechecks current access and limits, reserves the upper bound, stores the run, and inserts its pg-boss job atomically. The same key cannot authorize a changed quote or a different actor. One quote starts at most one run.

Immediately before dispatch, the worker rechecks the actor, quote lifetime, credentials revision, and budgets under the same workspace lock. Dispatch is committed before one fixed-host request. The transport has a 30-second deadline, rejects redirects, bounds the response body, and never retries the paid call. The job has zero retries. Cancellation is possible only before dispatch, by its initiating user or an owner.

A supported terminal task and matching request identity are required to settle cost. The explicit allowlist covers completed results, no-results, failed-execution, partial completion, and invalid-input outcomes documented in [status codes](https://docs.dataforseo.com/v3/appendix-errors/). Pending and unknown statuses cannot prove a final zero charge. A known charge remains recorded even if its result cannot be parsed; unsupported/conflicting evidence remains uncertain and blocks more spending. Charges above the estimate pause the budget. Network failure and stale dispatched work also become uncertain, never automatically resubmitted.

An owner can explicitly reconcile an uncertain charge through free [task metadata](https://docs.dataforseo.com/v3/dataforseo_labs-id_list/). Current credentials must identify the same original provider account; same-account credential rotation is supported. One bounded query must find exactly one terminal task with the same tag, endpoint, market, keywords and paid options. If a verified response already supplied a provider task ID, later proof must also match that ID before and after the workspace lock. Missing, duplicate, truncated, pending, or foreign evidence leaves the charge unresolved. This implementation limits metadata recovery to 28 days. Reconciliation restores charge evidence, not a lost live result, and does not unpause spending automatically.

## Routes and integration

All management routes are cookie-only under `/api/projects/:projectId/keyword-research`, with existing same-origin write checks. API keys do not implicitly authorize research. All members can read saved state; owner/admin/editor can refresh markets, quote, and start. Reconciliation is owner-only. Current membership is checked again after external metadata reads and before writes.

| Method and suffix | Purpose |
|---|---|
| GET base | Connections, saved catalog and 20 recent runs; no external request |
| POST `/catalog` | Explicit free market refresh |
| POST `/quote` | Explicit free account/price check and bound quote |
| POST `/runs` | Reserve and enqueue one approved quote |
| GET `/runs/:runId` | Saved status and normalized result |
| POST `/runs/:runId/cancel` | Cancel undispatched work |
| POST `/runs/:runId/reconcile` | Owner-triggered free charge verification |

Migration 0016 follows Google's 0015 and reuses its project/workspace uniqueness. Earlier migrations and checksums are unchanged. The shared API and worker register both Google imports and keyword research. The optional `dispatchSpend` preparation callback preserves prior callers.

Normalized result payloads follow workspace `derivedHistoryDays`; quotes used by runs, charge evidence and financial ledger records remain. The shared project retention transaction serializes with policy changes and provider result publication, handles bounded batches, and never removes authored context/prompts. The active derived-history preview reports Google imports and keyword results separately. Incomplete batches reschedule; any failure rolls back native, Google and keyword cleanup together.

## Validation

Six focused unit tests pass. Eight isolated PostgreSQL/API/worker acceptance groups cover input/money parsing, quote and actor binding, concurrent idempotency, one paid dispatch, enqueue rollback, concurrent budget reservations, permission/credential revocation, interrupted and above-estimate charges, terminal-status verification, exact reconciliation, result retention, and cookie/origin/API-key boundaries. Every provider response is synthetic and unexpected fetch calls throw.

Backend acceptance at migration 0016: lock-controlled tests demonstrate that a retention extension protects newly retained results and that a stale crash sweep cannot replace a real settled result or uncertain charge evidence. An actual pg-boss worker dispatched one synthetic request with retries disabled. All 147 then-current unit tests passed, with two platform-specific skips. Typecheck and the production build passed; existing Nitro beta warnings remain. Fresh CLI installation through 0016, original-install rollback/history checks, and a seeded 0015→0016 upgrade passed. A separate reviewer reproduced upgrade preservation and forced a shared cleanup rollback after Google deletion; all observations and financial evidence survived, then the retry removed only the intended payloads. The production HTTP suite, Google offline-provider suite and desktop/360px Google/retention browser checks passed.

The subsequent [public browser harness](../tests/research-ui/README.md) passed keyword overview, ideas limits 25/50/100, exact costs, unavailable versus zero, retained history, keyboard-scrollable tables, desktop/360px layout, current role changes and stale project responses. Lost, 503, malformed and malformed nested acknowledgements preserve the original quote/key through expiry; double clicks, cancellation during a held poll, owner reconciliation and current 403/404 recovery use real routes and database receipts. GPT inspected the rendered result screens. Live-account compatibility remains unverified.
