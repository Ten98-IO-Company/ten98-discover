# Explicit prompt execution and comparison backend

This internal backend increment implements explicit paid requests for one or both of `openai/gpt-4o-mini` and `openai/gpt-4o` through the standard OpenAI route on OpenRouter. It does not complete V1 AI monitoring. Execution UI, scheduling, the seven-day result cache, other provider/model routes, visibility analysis and live paid acceptance remain pending. Saving or enabling a library prompt does not start a request.

## Authorization and API

All routes require browser sign-in. API keys have no implied execution scope. Owners, admins and editors can quote/start; all current project members can read. Only the initiating user or workspace owner can cancel a comparison; only the owner can reconcile a charge. POST requires the application Origin. Every mutation rechecks current membership under the workspace gate.

Under `/api/projects/:projectId/prompt-executions`:

| Method/path | Behavior |
|---|---|
| `GET /` | Latest 20 comparisons, supported models and connection readiness; no provider call |
| `POST /quote` | Read-only key/endpoint lookup, five-minute quote and exact rendered input preview |
| `POST /comparisons` | `{quoteId, requestKey}`; atomically reserve every child and insert one queue job |
| `GET /comparisons/:id` | Input, per-model answers, charge and expiry states |
| `POST /comparisons/:id/cancel` | Stop undispatched children; in-flight work can still be charged |
| `POST /runs/:id/reconcile` | Explicit read-only generation lookup, never a paid replay |

Quote input is strictly `{connectionId,promptId,versionId,systemText,models,maxCompletionTokens,fundedCredits:true}`. The text version belongs to this project and must remain unarchived at quote, start and dispatch. A later edit does not change that immutable version. `systemText` is explicit, bounded to 4,000 characters; project context is never silently inserted. Output allowance is 16–4,096 tokens. Models are unique, with at most the two named above. Every new comparison requires a new explicit quote. Retrying the same request key returns the existing comparison only for the same actor, project and quote.

## Money and dispatch

The reservation is the selected endpoint's full published prompt capacity multiplied by its input price, plus the chosen output allowance and optional request fee. Decimal and exponent prices use integer coefficients; all terms are summed before a single upward microUSD rounding step. Node 24 preserves the original numeric cost lexeme in response JSON. The ledger keeps the rounded charge and the original reported amount separately. Token counters never substitute for billing evidence.

This is a conservative ceiling under the verified provider contract, not an external invoice guarantee. It excludes credit-purchase fees, taxes and upstream provider-account BYOK invoices. Ordinary OpenRouter-funded API keys are supported without account changes; management keys and free-tier accounts are rejected. The caller explicitly confirms funded-credit use. OpenRouter does not expose a verified per-request BYOK-disable control in this adapter: an unexpected BYOK response records its credit charge, clearly separates the external invoice and pauses further spending.

The public endpoint catalog currently omits optional request fees and includes numeric `discount: 0`. Omission becomes a zero fee, also sent as the request-price ceiling; nonzero discount metadata or unsupported billable dimensions fail readiness. Standard prompt/completion prices are required. Nonzero cache-write/search/reasoning prices are unsupported. Text-only requests contain no tools, search, media or cache-write controls. Because a base provider slug can match future variants, readiness rejects any additional `openai/*` endpoints until their limits are reviewed.

Immediately before each paid call, the worker rechecks read-only endpoint metadata, then commits a fresh role, archive, key-revision, quote-expiry and budget check together with `dispatched`. Both selected children are reserved in one transaction and run sequentially. The queue has zero automatic retries. Duplicate workers cannot resend a dispatched child. Transport loss, missing/unknown finality or a crash after dispatch leaves a charge uncertain and cancels undispatched siblings. Actual overrun or unexpected BYOK pauses the workspace. Manual cancellation never invents a refund.

## Receipts and retention

The generation header is saved before bounded response parsing. Valid terminal charge evidence remains recorded when the answer is empty, malformed or unsafe for PostgreSQL. Missing terminal evidence retains the reported amount as unresolved evidence, rather than settling a provisional zero. Answers are untrusted text; only actual provider citation annotations become safe HTTPS links. Links found merely inside answer prose are not citation evidence.

Reconciliation uses only the saved generation ID and original key identity, exact model/provider, dispatch time, session ID and stored actor pseudonym. Those fields are documented in generation metadata; missing, conflicting or pending values remain inconclusive. The actor is stored at quote time, and key identity is a domain-separated SHA-256 fingerprint kept only server-side, so login-secret rotation does not orphan receipts. A matched lookup can recover the credit charge without recovering the answer. It leaves spending paused for owner review. No ID means no lookup, balance inference or automatic resend.

Generated answers/citations and copied execution input are **raw provider evidence**, using the workspace's default **90-day** period. Copied input expires only after all children leave queued/running and their completion times precede the cutoff. This includes old uncertain outcomes: their generation IDs, actor/key binding, route, exact charge evidence, ledger and idempotency receipts remain. Authored prompt-library versions remain. DTOs report `resultExpired` and `inputExpired`; purged payloads are null, never presented as a genuinely empty original. Google and keyword results continue using derived-history retention (365 days by default). Unused expired quotes are removed after 24 hours. Batches are bounded and share the existing workspace/project transaction with the other cleaners.

## Validation and remaining gate

Run `node --test tests/prompt-execution.test.ts` for exact arithmetic, public-catalog shape, finality, safe output, fixed transport and receipt matching. On an isolated migrated local database with synthetic credentials, run `TEN98_INTEGRATION_TEST=1 node --env-file=.env tests/prompt-execution-integration.ts`. Its default network path is blocked until workers stop, including failure cleanup. It checks atomic reservations and queue rollback, live revocation, idempotency, immutable versions, crash/reconciliation, retention and real pg-boss execution using a fake transport.

No live paid request or authenticated provider account test is part of this increment. Real response-model compatibility and presence of reconciliation context fields still require an explicitly bounded paid acceptance allowance. Unknown shapes fail closed; these synthetic checks are not live-provider validation.

## Primary references

- [Endpoint catalog](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model) and current public [GPT-4o-mini endpoints](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints), [GPT-4o endpoints](https://openrouter.ai/api/v1/models/openai/gpt-4o/endpoints).
- [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection) and [provider slug matching](https://openrouter.ai/blog/insights/model-routing/).
- [Chat request fields](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation).
- [BYOK behavior](https://openrouter.ai/docs/guides/overview/auth/byok) and [spend-control limits](https://openrouter.ai/docs/guides/best-practices/spend-controls).

Observed local checks: six new pure groups and 153 total unit passes (two pre-existing skips); TypeScript, build and plan checks; `0016` to `0017` upgrade/rollback/history checks; existing keyword and new seven-group prompt PostgreSQL/worker suites; shared Google/keyword retention regression; real Edge retention flow at desktop and 360px. Independent GPT review reran all six pure groups and found no remaining blocker in the bounded reviewed surface. No live paid acceptance was performed.

Retention evidence: [desktop](screenshots/prompt-retention-desktop.png) and [mobile](screenshots/prompt-retention-mobile.png). These show synthetic local data and the existing shell; the execution UI is still pending.
