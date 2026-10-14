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

History uses `GET /audits`; run details use `GET /audits/:runId`. Under that run, `/pages`, `/issues`, `/pages/:pageId` and `/pages/:pageId/links` expose bounded scoped observations. Lists default to 50 rows and allow at most 100. Use returned opaque cursors; filters cannot be moved between scopes. Page filters are coverage/resourceKind plus the search/order fields below, issue filters are code/severity/pageId, and link direction is in/out. Duplicate or unsupported query fields are rejected.

## Retained Pages selection

Pages alone accepts `search`, `searchIn` (`url_title_meta` by default, or `url`), `sort` (`url` by default, `httpStatus`, `title`, `h1`, `wordCount`, `images`, `responseTimeMs`) and `order` (`asc` by default, or `desc`). The shared `normalizeAuditPageFields` helper rejects malformed Unicode and controls before trimming; the trimmed search is limited to 200 Unicode scalar values and 800 UTF-8 bytes. Internal spaces remain meaningful. Search is one literal case-insensitive substring of URL, title and description joined with spaces, or URL alone; percent, underscore and backslash have no wildcard meaning. Existing coverage and resource filters intersect it.

URL and title use PostgreSQL's fixed `C` collation. Numeric observations sort numerically, missing values sort last in both directions, and measured zero remains zero. Images sorts missing-alt count, then total image count. ID ascending is the final tie-break in every order. Titles sort only readable stored strings; absent evidence is unknown, not an observed empty title.

Each Pages read selects only ordered scoped IDs, refusing more than the existing 10,000-row frontier bound, then projects at most the requested 100 rows in that order. The bounded O(n) selector avoids a persisted snapshot or new index; larger measured capacity/cost would require reconsideration. Pages cursors are now strict v2 scope/revision/anchor tokens (maximum 512 characters). Old Pages tokens and tokens from another project, run or normalized filter/order are rejected; runs/issues/links retain their existing cursor format. Changed membership/order, status or expiry invalidates the selection revision with 409 and a reload message. A revision describes stable selection/order, not frozen metric values between reads.

Successful Pages responses include database-clock `asOf`, `selectionRevision`, `countBasis: retained` and `matchingRetainedCount`. The matching count is exact for terminal retained results and null while active or derived-expired. Derived expiry returns an empty list, null cursor/revision/count, and the explicit expired run status before selecting pages. Nonempty URL/title/meta search and title sorting after raw expiry return a recoverable 409 asking for URL search and another sort; the expiry latch commits before that failure. Recoverable stale-selection, missing-anchor and over-bound failures also preserve newly latched retention markers; malformed input, authorization and database failures retain the existing rollback behavior. URL-only search and URL/numeric sorting remain available.

Page DTOs add `titlePreview` with explicit available/empty/truncated/expired/not_recorded/unavailable status and nullable text. Readable previews contain at most 512 Unicode scalar values (at most 2,048 UTF-8 bytes); stored-title clipping or a known longer original title makes truncation explicit. This state concerns the captured title; whole-row evidence truncation remains separately disclosed through `rawEvidenceStatus`. Available means readable captured text, not complete/live website text. Lists still contain no description, full raw evidence or captured body text. Expired copied title/description bytes are neither selected nor searched/sorted. Exports and UI search/sort controls are separate increments, not accepted by this API change.

The existing `/issues` response adds nullable `pageUrl` and `targetPageUrl` to each finding. Both URLs are resolved by page ID and the finding's run ID; target and related pages retain their separate relationships. Existing finding fields, cursor scope and filters are preserved. No page detail request is needed to resolve these URLs.

Its `groups` array contains `{code,severity,retainedFindingCount,affectedUrlCount,unassignedFindingCount}` for all retained findings matching the same code/severity/pageId filters, independently of the row limit or cursor. Groups keep differing severities separate. Terminal counts are exact nonnegative safe integers: retained findings count every stored matching record, affected URLs count distinct resolved primary URLs, and unassigned findings count records with no resolved primary page. Targets and related pages do not add affected URLs. These remain retained counts even when the summary is absent, coverage is incomplete or findings were bounded. Active runs can identify observed groups, but all three group counts and `matchingRetainedCount` are null until finalization. An available terminal scope without retained matches returns `groups:[]` and `matchingRetainedCount:0`.

The selected role and `canCancel`/`canDelete` are refreshed per response. Private queue IDs, leases, generation tokens, hashes and robots body bytes are absent from public DTOs. Extracted evidence is plain text; complete HTML, cookies and arbitrary response headers are never stored by this API.

## Cancellation, expiry and truthful results

`POST /audits/:runId/cancel {}` immediately cancels queued work. Running work becomes cancelling and increments its generation; the exact old owner is retained only to acknowledge abort-and-join cleanup. Late responses cannot publish under the old generation. Terminal cancellation is idempotent. `POST /audits/:runId/delete {}` only accepts terminal work and schedules bounded cleanup; active work must finish or be cancelled first.

Run status describes the outcome. `dataStatus` and `rawEvidenceStatus` separately describe retained data. Raw expiry hides copied evidence while facts, issue URLs and numeric derived observations may remain. Derived expiry returns explicitly expired pages/issues with no cursor, preserving original counts as receipt metadata. Issues short-circuit before URL joins or aggregation and return `groups:null`, `issues:[]`, `nextCursor:null` and `matchingRetainedCount:null`. An expired page lookup returns 410. Unobserved facts are null; missing body or expired title text never becomes an observed empty title.

Graph output has an exact detected total and a bounded retained prefix. Per-severity/filter counts derived from stored issues are labelled retained counts. A null unfinished summary or expired list does not mean zero issues. Only completed observed scope can support absence findings.

## Checks

`node --test tests/site-audits.test.ts` exercises strict intent/query parsing, role/expiry DTO semantics and safe counter conversion. `TEN98_INTEGRATION_TEST=1 node --env-file=<private-local-fixture> tests/site-audits-integration.ts` requires an explicitly migrated isolated local PostgreSQL database. It uses synthetic users/projects and a forbidden external fetch, and does not start a live crawler. It checks atomic queue rollback, receipts, scope/role/proof changes, cancellation, composite foreign keys, pagination, expired-data suppression and real cookie/Origin/API-key boundaries. Group checks cover findings beyond the first 50 rows, duplicate primary URLs with different targets, null primary pages, severity boundaries, filtered pagination, active/terminal counts and raw/derived expiry. Fixtures are retained for inspection; this is not a production-data test.

Rendering, protected-site credentials, scheduled audits, performance/Lighthouse and larger measured capacity remain separate V1 gates. No public crawl, paid provider, customer-data test or production deployment is claimed by these checks.
