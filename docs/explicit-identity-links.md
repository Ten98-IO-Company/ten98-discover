# Explicit identity-link evidence

Collection/storage contract; linked-activity reads are still unavailable.

## Admission and identity

A project must explicitly enable linkIdentities through its existing analytics settings. Absent means false; existing settings are not rewritten. Saving rotates the analytics consent epoch, so new collection requires current analytics consent. Disabling stops new links and preserves retained evidence.

New accepted browser events and identify operations with a validated explicit distinctId can record an assignment. Anonymous observations, missing usable network identity, denied collection, server/API events and duplicate event/identify receipts do not create or refresh links. Identifiers are caller assertions, not authenticated customer identities.

Exact validated identifiers become project-scoped, domain-separated AUTH_SECRET HMAC references. Raw identifiers are not stored. Different projects or secret generations cannot join. Rotating AUTH_SECRET disconnects new assignments from prior retained generations; there is no history backfill or transitive identity graph.

Each project/rotating-visitor-key assignment is immutable. An incompatible assignment returns a generic conflict and rolls back the entire event or identify transaction. Multiple directly matching keys can share an identity reference. Profile values remain key-scoped and are not merged.

## Time, retention and locking

First and last acceptance preserve PostgreSQL UTC microseconds. Future linked reads must exclude events received before each assignment's first acceptance, even within the same millisecond. No earlier anonymous or pre-link identified activity is merged.

Links follow workspace raw-analytics retention independently of events and current properties. A monotonic project cutoff and sticky loss marker prevent shortening then extending retention from restoring expired evidence. Renewing an expired matching assignment starts a new prospective interval; it cannot restore the old interval. Logical expiry applies before physical cleanup.

Collectors acquire workspace SHARE then project UPDATE for explicit identifiers. Policy is reread after admission. Cleanup uses the same lock order, deletes at most 1,000 links per batch and keeps the project incomplete while eligible links remain. Preview caps estimates at 10,000 with an at-least indicator. Old profile/receipt persistence semantics remain unchanged.

Migration 0037 creates an empty analytics_identity_link table and three nullable project markers. It does not alter existing settings, epochs, events, profiles or receipts.

## Runnable checks

The pure checks are tests/identity-links.test.ts. The database runner is tests/identity-links-integration.ts with TEN98_INTEGRATION_TEST=1 and TEN98_IDENTITY_LINK_TEST=1; it requires a fresh empty schema-37 loopback database named ten98_identity_<12 lowercase hex digits> on port 55501. The existing isolated CI job uses ten98_identity_ci on port 5432 with its explicit CI guard. These guards exclude preview and production databases.

The integration checks cover exact prospective fences, immutable conflicts and atomic rollback, duplicate no-op, observed consent-publication lock races, concurrent writers, monthly context continuation, missing/API identity exclusions, irreversible retention and 1,001-row cleanup continuation. No paid provider request is needed.
