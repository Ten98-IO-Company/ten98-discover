# Retention

Workspace members can inspect retention. Owners can preview and explicitly save a policy. Durations are whole days from 1 to 3,650. A day is 86,400 seconds; cutoffs use UTC receipt time and delete rows strictly before the cutoff, retaining rows exactly on it.

| Category | Default days | Current storage and cleanup |
| --- | ---: | --- |
| Raw analytics | 90 | Events, their properties/dimensions and unreferenced visitor identities |
| Replay | 7 | Not implemented; policy saved for future storage |
| Raw provider evidence | 90 | Generated prompt answers/citations, copied execution input and completed manual redirect-chain observations, measured from completion; authored prompt versions and financial/idempotency receipts remain |
| Derived history | 365 | Finished Google import rows/quality metadata and normalized keyword results, measured from completion; original outcomes, used quotes, charge evidence and idempotency receipts remain |

All provider spending and request-deduplication records are preserved, including reserved, dispatched, uncertain, settled and cancelled requests. Authored project context, research notes, prompts and immutable versions, mutation receipts, reports, templates, shared snapshots, credentials, accounts, teams and configuration are also preserved. The worker does not scan or delete arbitrary artifact files. This increment implements part of P31/P68, not complete retention/export/erasure parity.

## Preview and save

The preview estimates eligible event rows and their approximate logical size. It examines at most 10,001 candidates and labels a capped count as at least 10,000. Bytes describe the first 10,000 sampled rows; they are not a complete storage inventory or a promise of reclaimed filesystem space. Query timeouts appear as an unavailable estimate, never zero. Separate previews count eligible finished Google imports and keyword result payloads against the derived cutoff, and generated prompt answers, copied inputs and redirect observations against the raw-evidence cutoff. Each uses the same 10,001-candidate bound and explicit unavailable state. Replay storage remains unimplemented.

Saving requires a preview bound to the exact policy, workspace, owner and current revision. It expires after five minutes. The API rechecks live ownership under the workspace lock. Stale or expired previews require a new preview; changing the draft invalidates the browser confirmation. The preview is advisory: data arriving after it may change the eventual eligible count.

Shorter periods permanently remove older observations. Extending retention stops the previous shorter target before the next batch but cannot restore deleted history. This app does not erase retained operator backups. Follow a separate private backup and recovery policy.

## Worker and reporting

The existing worker attempts one project per ten-second tick, with at most 1,000 event deletions, 1,000 orphan visitor deletions, 20 expired Google imports (each at most ten pages), 100 keyword result payloads, 100 prompt results, 100 copied prompt inputs and 100 completed redirect observations in each transaction. It also removes at most 100 expired unused quotes from each research adapter. Workspace then project locks serialize policy changes, collection and provider result publication. A two-second statement timeout and a short lock timeout bound contention; failures roll back the batch and expose a redacted cleanup status. No provider scheduler is enabled. Shutdown waits for the active batch. A failure rolls back all cleaners together, and any remaining batch prevents a premature completed status.

Projects with pending work become eligible again after ten seconds; completed projects after an hour. This is a bounded maintenance cadence, not a deletion deadline under arbitrary load or an unavailable worker. Inspect failed-project status and database/worker health when cleanup falls behind. Latest completed project cleanup is not proof that every project has caught up.

Google snapshot cleanup retains the original status, counts, request ID and source; it marks the data expired and removes rows/quality metadata only for completed, partial, failed or denied imports. Queued/running imports are excluded. Expired data is unavailable rather than an empty successful result, and repeated requests return the original receipt. See [Google imports](google-reports.md). Keyword cleanup clears only normalized result payloads and marks them expired; used quotes, requests, reconciliation evidence and all financial ledger fields remain. An abandoned quote without a run can expire after 24 hours. See [keyword research](keyword-research.md).

Prompt cleanup expires generated answers/citations and copied execution input under the raw-evidence policy. Copied input becomes eligible only when every comparison child has finished before the cutoff; queued/running children prevent expiry. Old uncertain charges retain generation IDs, original key and actor bindings, route, exact financial evidence and idempotency receipts for reconciliation. Authored prompt versions remain. Expired payloads are null with explicit expiry flags; reconciliation does not restore them or resend a paid request. See [prompt execution](prompt-execution.md).

Manual redirect cleanup removes only the observed chain strictly before its completion-time cutoff, retaining the receipt, expected configuration, original outcome and request ID. Active checks are excluded. Expired evidence is explicitly unavailable; a retained completed status is not a current health assertion. See [redirect checks](domain-redirects.md).

Each successful raw-analytics batch records a monotonic history boundary. While a multi-batch pass is in progress, older observations are excluded from reports so partial deletion cannot be mistaken for a complete total. A later policy extension does not move this boundary backward. Daily buckets before it are unavailable rather than zero; a day crossing it is partial. Recent-event counts describe retained observations, never a lifetime total. Visitor first/last timestamps describe their remaining observations. Analytics event-ID deduplication lasts only while the event exists; financial request deduplication is preserved separately.

## Upgrade and verification

Migration 0013 adds policy defaults, cleanup state and supporting indexes; it does not delete rows. Existing workspaces receive the defaults above. After explicit migration, starting the updated worker activates automatic cleanup. Review the policy and maintain a verified backup before upgrading a deployment with existing analytics. Index creation occurs in the existing migration transaction, so allow a maintenance window for a large event table. Do not edit old migrations or reset database volumes.

Normal PostgreSQL vacuum makes deleted-row space available for reuse and generally does not shrink filesystem usage. The application never runs `VACUUM FULL`. See [PostgreSQL vacuum guidance](https://www.postgresql.org/docs/18/routine-vacuuming.html).

Checks: `node --test tests/retention.test.ts`; the isolated integration runner calls `runRetentionChecks({ownerId})` from `tests/retention-integration.ts` and `runRetentionCoverageChecks()` from `tests/retention-coverage-integration.ts`. Both require `TEN98_INTEGRATION_TEST=1` and a local synthetic PostgreSQL database. They cover batch/restart boundaries, rollback, live authorization, concurrent collection, protected records, estimates and unavailable/partial reporting.

The integrated Google/keyword check is `node --env-file=.env tests/google-retention-integration.ts`. It covers separate scoped preview counts, exact cutoffs, bounded shared batches and preserved financial receipts. The Google browser runner also checks both preview counts and unavailable estimates at desktop and 360px widths, with external traffic blocked.

`tests/prompt-execution-integration.ts` checks raw-evidence previews, bounded payload-only batches, rollback and reconciliation after copied input expires. `tests/retention-browser.ts` checks the shared retention screen at desktop and mobile sizes. These runners require isolated synthetic local databases; no live provider calls are needed.
