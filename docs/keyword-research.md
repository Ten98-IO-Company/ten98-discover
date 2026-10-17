# Native keyword research: implementation and evidence

> Code and safety contracts retained from [docs/keyword-research.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/keyword-research.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/native-keyword-research-implementation-and-evidence-implementation-xyCfLuN4yp). Qualifications are preserved; this adds no acceptance claim.

## Scope and measurement

Overview accepts 1–100 unique normalized keywords. Ideas accepts one seed and a limit of 25, 50, or 100. Both use a selected supported Google country/language pair; each keyword is limited to 80 Unicode characters and 10 words. The server fixes the endpoints and disables clickstream/SERP extras. It never chooses a different paid endpoint, adds automatic pages, or schedules a follow-up request.

Saved metrics distinguish unavailable values from zero. Search volume is a provider estimate, CPC is USD, paid competition is separate from keyword difficulty, and monthly history retains its dates. Results retain retrieval time and metric update times. Omitted overview keywords and a limited ideas result are explicit. No observed native visits, Search Console measurements, or Google Analytics sessions are inferred from these estimates.

The [overview](https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_overview-live/) and [ideas](https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_ideas-live/) endpoint documentation define the request/result fields. The free [market catalog](https://docs.dataforseo.com/v3/dataforseo_labs_locations_and_languages/) supplies supported combinations. OpenSEO commit [89e5a007](https://github.com/every-app/open-seo/commit/89e5a00717cdf049b7c2b4e29646edb3a7d4995b) informed the source investigation; this slice uses original application code, with no copied upstream implementation or new dependency.

## Spending boundary

Reading saved state never contacts a provider. An explicit market refresh or quote can make free metadata requests using an encrypted workspace connection. Quotes use the account-specific prices returned by [user data](https://docs.dataforseo.com/v3/appendix-user-data/); published pricing is not embedded as a permanent authorization. Costs use exact integer micro-USD, with unsupported precision rejected rather than silently rounded down.

A quote lasts five minutes and binds the project, initiating actor, exact normalized request, connection revision, provider account fingerprint, and price. Start takes only the quote ID and an idempotency key. A workspace-locked transaction rechecks current access, the manual pause and uncertain charges, records the quoted upper bound as the idempotent reservation, stores the run, and inserts its pg-boss job atomically. The same key cannot authorize a changed quote or a different actor. One quote starts at most one run.

Immediately before dispatch, the worker rechecks the actor, quote lifetime, credentials revision, and the manual pause and uncertain-charge state under the same workspace lock; a saved-keyword refresh child skips the quote-lifetime recheck because its Start authorized it ([saved keywords](saved-keywords.md)). Dispatch is committed before one fixed-host request. The transport has a 30-second deadline, rejects redirects, bounds the response body, and never retries the paid call. The job has zero retries. Cancellation is possible only before dispatch, by its initiating user or an owner.

A supported terminal task and matching request identity are required to settle cost. The explicit allowlist covers completed results, no-results, failed-execution, partial completion, and invalid-input outcomes documented in [status codes](https://docs.dataforseo.com/v3/appendix-errors/). Pending and unknown statuses cannot prove a final zero charge. A known charge remains recorded even if its result cannot be parsed; unsupported/conflicting evidence remains uncertain and blocks more spending. Charges above the estimate are recorded as charged. Network failure and stale dispatched work also become uncertain, never automatically resubmitted.

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
