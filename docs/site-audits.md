# Manual Site Audit API

This is a development increment toward P53–P56, not a complete V1 crawler. The API stores explicit manual static audits and their durable lifecycle. The worker, bounded public transport and isolated parsers share this receipt; reading setup or history never starts network work.

Cookie login and current workspace membership are required. Owners and admins may start, cancel and delete. Other members may inspect. API keys gain no audit scope. The selected origin is either the canonical public HTTPS project origin or an exact currently verified serving domain. The canonical origin is project metadata, not a DNS ownership claim. Redirect aliases, private/IP/local origins and arbitrary full start URLs are excluded.

## Start and inspect

`GET /api/projects/:projectId/audits/setup` returns current role, eligible origins, worker heartbeat readiness and fixed limits. `POST /api/projects/:projectId/audits` accepts only:

```json
{"requestId":"UUID","domainId":null,"startPath":"/","maxPages":50,"mode":"static"}
```

A null domain selects the canonical origin. The path must be rooted and query-free; fragments, credentials, invalid percent encoding, controls and malformed Unicode are rejected. The default is 50 HTML resources; this increment caps requested pages at 1,000. Its other ceilings are 30 minutes from creation, one request/second, 3×maxPages+100 requests, 500 MiB cumulative body-capacity allowance, 10,000 frontier rows, 100,000 edges and 20 sitemap documents/depth three. These are configured ceilings, not measured throughput claims or a physical TCP-bandwidth cap.

New work returns 202. Retry the identical request ID and body after a lost response: 200 returns its original receipt. Changed intent with that ID conflicts. Queue insertion and run/frontier insertion share one transaction. Deleting history preserves the receipt; a late retry returns 410 instead of starting new work. Workspace and installation active constraints are enforced in PostgreSQL.

History uses `GET /audits`; run details use `GET /audits/:runId`. Under that run, `/pages`, `/issues`, `/pages/:pageId` and `/pages/:pageId/links` expose bounded scoped observations. Lists default to 50 rows and allow at most 100. Use returned opaque cursors; filters cannot be moved between scopes. Page filters are coverage/resourceKind, issue filters are code/severity/pageId, and link direction is in/out. Duplicate or unsupported query fields are rejected.

The selected role and `canCancel`/`canDelete` are refreshed per response. Private queue IDs, leases, generation tokens, hashes and robots body bytes are absent from public DTOs. Extracted evidence is plain text; complete HTML, cookies and arbitrary response headers are never stored by this API.

## Cancellation, expiry and truthful results

`POST /audits/:runId/cancel {}` immediately cancels queued work. Running work becomes cancelling and increments its generation; the exact old owner is retained only to acknowledge abort-and-join cleanup. Late responses cannot publish under the old generation. Terminal cancellation is idempotent. `POST /audits/:runId/delete {}` only accepts terminal work and schedules bounded cleanup; active work must finish or be cancelled first.

Run status describes the outcome. `dataStatus` and `rawEvidenceStatus` separately describe retained data. Raw expiry hides copied evidence while facts may remain. Derived expiry returns explicitly expired pages/issues with no cursor, preserving original counts as receipt metadata. An expired page lookup returns 410. Unobserved facts are null; missing body or expired title text never becomes an observed empty title.

Graph output has an exact detected total and a bounded retained prefix. Per-severity/filter counts derived from stored issues are labelled retained counts. A null unfinished summary or expired list does not mean zero issues. Only completed observed scope can support absence findings.

## Checks

`node --test tests/site-audits.test.ts` exercises strict intent/query parsing, role/expiry DTO semantics and safe counter conversion. `TEN98_INTEGRATION_TEST=1 node --env-file=<private-local-fixture> tests/site-audits-integration.ts` requires an explicitly migrated isolated local PostgreSQL database. It uses synthetic users/projects and a forbidden external fetch, and does not start a live crawler. It checks atomic queue rollback, receipts, scope/role/proof changes, cancellation, composite foreign keys, pagination, expired-data suppression and real cookie/Origin/API-key boundaries. Fixtures are retained for inspection; this is not a production-data test.

Rendering, protected-site credentials, scheduled audits, performance/Lighthouse and larger measured capacity remain separate V1 gates. No public crawl, paid provider, customer-data test or production deployment is claimed by these checks.
