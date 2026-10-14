# Analytics exploration

> Code and safety contracts retained from [docs/explorer.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/explorer.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/analytics-exploration-implementation-history-XhvZ0te4GU). Qualifications are preserved; this adds no acceptance claim.

Choose a project and **Explore**. Select inclusive calendar dates, a named timezone, event type and breakdown. More filters supports exact event/page/referrer/language/campaign matches and one typed property equality or missing-value condition. A saved result keeps its applied filters while you edit the next query; a visible notice identifies unapplied changes, and Apply filters executes the new query. Numeric summaries omit trailing decimal zeros for readability; CSV keeps the original exact decimal strings. All current members can read, and existing `analytics:read` API keys can use GET `/api/projects/:id/explore` within their workspace.

**Origin** groups and exactly filters the authorized page origin, including verified serving domains. Use its serialized scheme and hostname (and a port only when the canonical project origin has one), without a trailing slash. Historical rows written before origin provenance was introduced belong to the immutable canonical project origin: the earlier collector permitted that origin only. Revoking a serving domain stops new collection but does not relabel its retained history. Origin does not create a separate visitor identity or a cross-domain person identifier; the existing project-scoped measurement rules still apply.

The overview remains UTC. Explore resolves named timezones using runtime and PostgreSQL timezone data, with1–366 local dates per request. Its UTC start/end are an inclusive/exclusive envelope, with an additional exact local-date predicate. Repeated midnight and historical dates that briefly reverse cannot be represented as a single ordinary calendar interval: adjacent envelopes may overlap, but the date predicate assigns each event to its actual local date. Missing midnight starts at the first real instant; a skipped date is labelled explicitly. Counts, daily buckets, breakdowns, property inventory and CSV share one database snapshot and filter population.

Properties use their exact normalized stored key, including escaped dots/backslashes and meaningful whitespace. Numeric42, string"42", empty string, null, missing, booleans, UTC dates and whole arrays remain separate. Numeric statistics use PostgreSQL decimal aggregation and return decimal text without conversion through JavaScript floating-point sums. Inventory and breakdown each return at most100 entries with explicit truncation; groups sort by event count then a stable label. Referrer absence is missing/uncollected, never assumed direct traffic.

Visitor/visit estimates cover only identified events and follow the existing rotating native identity contract. No valid identity means unavailable estimates, even when event counts are known. Retention is applied before every aggregate: expired ranges display unavailable counts, partial ranges contain only retained observations, and a genuinely empty available range is zero. The query has a five-second database deadline and a per-user rate limit; a deadline asks for narrower filters rather than silently returning a partial result. Raw aggregation has no production-volume guarantee.

**Download CSV** exports the exact currently displayed result, including applied scope, timezone, UTC envelope, retention status, totals, bounded groups, daily data and numeric statistics. Cells are quoted and leading spreadsheet formulas are neutralized. It is a bounded exploration export, not the complete seven-dataset ZIP/reset lifecycle required by P46. Loading, failed requests, access loss and project/account changes clear downloadable data. Saved funnels and goals are implemented; see [conversions](conversions.md). Paths, realtime/comparisons, replay and remaining V1 reports are still required.

## Saved filter contract

Saved Explorer filters are project-owned predicates, separate from applied report results. `parseSegmentDefinition` validates `{schemaVersion: 1, name, query}`: a trimmed nonblank name of at most 200 UTF-16 code units, matching the browser input, and a canonical query string of at most 20,000 characters. `explorerQuery` supplies the existing validation and normalization. The query includes `kind`, the exact Explorer filters and an optional typed property predicate; dates, timezone, grouping, cursors and unknown or repeated keys are rejected. Explicit empty values remain distinct from absent filters. Schema 0033 adds one `analytics_segment` table; no result cache or membership population is stored.

The browser-session API uses `/api/projects/:projectId/segments`:

| Method and suffix | Input | Result |
| --- | --- | --- |
| `GET /` | Optional single `cursor` | `{role, items, nextCursor}`, at most 50 items |
| `GET /:id` | No query parameters | `{role, item}` |
| `POST /` | `{requestId, definition}` | `{role, item, deleted, replayed}` |
| `POST /:id/update` | `{requestId, revision, definition}` | Same save envelope |
| `POST /:id/delete` | `{requestId, revision}` | `{role, id, deleted: true, replayed}` |

An item contains `id`, `projectId`, `revision`, `definition`, `createdAt` and `updatedAt`. All current members can read; owners, admins and editors can mutate. Writes use the existing workspace lock and recheck membership before applying changes or replaying receipts. Request identity binds the actor, operation and normalized payload. Replays return the current item, or `item: null, deleted: true` when it was deleted; they never recreate it. Updates and deletion require the loaded revision. Receipts retain identifiers only. The routes enforce configured Origin, no-store responses, bounded JSON, rate limits and scoped cursors; this adds no bearer-key permissions.

Loading a saved filter replaces the Explorer draft predicate and preserves its dates, timezone and grouping. It does not fetch analytics. Saving also leaves the currently applied result and CSV unchanged. Only Apply requests a new result. An uncertain write retains its exact request ID and payload for deliberate retry; a confirmed conflict requires a fresh read. Account/project changes and access loss clear saved data and cancel obsolete reads. These definitions do not represent cohorts, timeline annotations, richer upstream all/any or session operators, or automatic application to reports with different query semantics.

## Verification

- `node --test tests/explorer.test.ts`: query boundaries, exact typed input and formula-safe CSV.
- `node --test tests/segment-input.test.ts`: saved predicate round trips, exact empty/literal values, typed properties, excluded report fields and canonical-size bounds.
- `TEN98_INTEGRATION_TEST=1 TEN98_SEGMENTS_TEST=1 node --env-file=<fresh-private-test-env> tests/segments-integration.ts`: requires a newly migrated loopback database on port 55501 named `ten98_segments_<12 hex characters>`, or the exact isolated CI database declared by the workflow. Exercises actual Explorer equivalence, receipts, authorization, revision conflicts, cursors and HTTP boundaries without provider calls.
- `TEN98_INTEGRATION_TEST=1 node --env-file=<private-test-env> tests/explorer-integration.ts`: migrated local synthetic PostgreSQL fixtures; also called by the full production web/worker integration suite. Covers role/tenant/API-key boundaries, injection-shaped values, empty/null/mixed types and escaped keys, exact decimals, limits, retention, DST, skipped dates, missing midnight, and the1987 Goose Bay date reversal.
- `tests/explorer-browser.ts`: optional installed Playwright via `PLAYWRIGHT_MODULE`, a matching production server and isolated local test environment. Creates synthetic accounts/projects and blocks external browser traffic. Covers real navigation, filters, whitespace keys, same-query refresh, snapshot-exact downloads, errors, delayed responses, project/access changes, expired sessions and360px layout.
- `TEN98_SAVED_FILTERS_BROWSER=1 node tests/saved-filters-browser.mjs`: the actual Explorer controller with synthetic transport in an owned loopback Vite fixture. Checks draft-only loading, immutable unknown-write retry, current access, revision conflicts, deleted receipts, canonical dates, keyboard controls and responsive layouts.
- `TEN98_INTEGRATION_TEST=1 TEN98_SEGMENTS_BROWSER=1 node --env-file=<fresh-private-test-env> tests/segments-browser.mjs`: saved-filter flows through a matching production application and synthetic PostgreSQL data. Requires the original Explorer browser suite to have seeded that same owned fixture first; refuses a different database or application origin. Provider traffic is blocked.

## Model and source evidence

The design follows Umami's focused filtering/breakdown pattern and the stored native property contract. PostgreSQL calendar operations are based on its [date/time documentation](https://www.postgresql.org/docs/18/functions-datetime.html); regression fixtures determine edge behaviour. This slice copies no upstream application source.
