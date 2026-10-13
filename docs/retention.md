# Retention

Workspace members can inspect retention. Owners can preview and explicitly save a policy. Durations are whole days from 1 to 3,650. A day is 86,400 seconds; cutoffs use UTC receipt time and delete rows strictly before the cutoff, retaining rows exactly on it.

| Category | Default days | Current storage and cleanup |
| --- | ---: | --- |
| Raw analytics | 90 | Events, their properties/dimensions and unreferenced visitor identities |
| Replay | 7 | Not implemented; policy saved for future storage |
| Raw provider evidence | 90 | Not implemented; policy saved for future storage |
| Derived history | 365 | Finished Google import rows and quality metadata, measured from import completion; original outcome and idempotency receipts remain |

All provider spending and request-deduplication records are preserved, including reserved, dispatched, uncertain, settled and cancelled requests. Authored project context, research notes, prompts and immutable versions, mutation receipts, reports, templates, shared snapshots, credentials, accounts, teams and configuration are also preserved. The worker does not scan or delete arbitrary artifact files. This increment implements part of P31/P68, not complete retention/export/erasure parity.

## Preview and save

The preview estimates eligible event rows and their approximate logical size. It examines at most 10,001 candidates and labels a capped count as at least 10,000. Bytes describe the first 10,000 sampled rows; they are not a complete storage inventory or a promise of reclaimed filesystem space. Query timeouts appear as an unavailable estimate, never zero. A separate preview counts eligible finished Google imports against their completion-time cutoff, with the same 10,001-candidate bound. Replay and raw provider evidence still show unavailable storage.

Saving requires a preview bound to the exact policy, workspace, owner and current revision. It expires after five minutes. The API rechecks live ownership under the workspace lock. Stale or expired previews require a new preview; changing the draft invalidates the browser confirmation. The preview is advisory: data arriving after it may change the eventual eligible count.

Shorter periods permanently remove older observations. Extending retention stops the previous shorter target before the next batch but cannot restore deleted history. This app does not erase retained operator backups. Follow a separate private backup and recovery policy.

## Worker and reporting

The existing worker attempts one project per ten-second tick, with at most 1,000 event deletions, 1,000 orphan visitor deletions and 20 expired Google imports (each at most ten pages) in each transaction. Workspace then project locks serialize policy changes, collection and Google import publication. A two-second statement timeout and a short lock timeout bound contention; failures roll back the batch and expose a redacted cleanup status. No provider scheduler is enabled. Shutdown waits for the active batch.

Projects with pending work become eligible again after ten seconds; completed projects after an hour. This is a bounded maintenance cadence, not a deletion deadline under arbitrary load or an unavailable worker. Inspect failed-project status and database/worker health when cleanup falls behind. Latest completed project cleanup is not proof that every project has caught up.

Google snapshot cleanup retains the original status, counts, request ID and source; it marks the data expired and removes rows/quality metadata only for completed, partial, failed or denied imports. Queued/running imports are excluded. Expired data is unavailable rather than an empty successful result, and repeated requests return the original receipt. See [Google imports](google-reports.md).

Each successful raw-analytics batch records a monotonic history boundary. While a multi-batch pass is in progress, older observations are excluded from reports so partial deletion cannot be mistaken for a complete total. A later policy extension does not move this boundary backward. Daily buckets before it are unavailable rather than zero; a day crossing it is partial. Recent-event counts describe retained observations, never a lifetime total. Visitor first/last timestamps describe their remaining observations. Analytics event-ID deduplication lasts only while the event exists; financial request deduplication is preserved separately.

## Upgrade and verification

Migration 0013 adds policy defaults, cleanup state and supporting indexes; it does not delete rows. Existing workspaces receive the defaults above. After explicit migration, starting the updated worker activates automatic cleanup. Review the policy and maintain a verified backup before upgrading a deployment with existing analytics. Index creation occurs in the existing migration transaction, so allow a maintenance window for a large event table. Do not edit old migrations or reset database volumes.

Normal PostgreSQL vacuum makes deleted-row space available for reuse and generally does not shrink filesystem usage. The application never runs `VACUUM FULL`. See [PostgreSQL vacuum guidance](https://www.postgresql.org/docs/18/routine-vacuuming.html).

Checks: `node --test tests/retention.test.ts`; the isolated integration runner calls `runRetentionChecks({ownerId})` from `tests/retention-integration.ts` and `runRetentionCoverageChecks()` from `tests/retention-coverage-integration.ts`. Both require `TEN98_INTEGRATION_TEST=1` and a local synthetic PostgreSQL database. They cover batch/restart boundaries, rollback, live authorization, concurrent collection, protected records, estimates and unavailable/partial reporting.
