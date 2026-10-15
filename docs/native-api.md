# Native bearer API contract

This development increment documents 24 implemented operations: 17 project/team/analytics operations, including Journeys, observed-key Retention, observed Attribution and three current-period Revenue readers, and seven authored-prompt operations. It does not complete the 81-requirement register, expose paid prompt execution, or implement a generic HTTP batch dispatcher. The separately documented MCP transport has its own fixed tool inventory.

`GET /api/openapi.json` returns a static OpenAPI 3.1.2 document before configuration, database readiness and installation setup checks. It accepts no query or body, uses relative server `/`, and does not reflect request hosts or credentials. Other methods return 405. There is no hosted documentation renderer, CDN or automatic provider request. The document describes bearer access; browser cookie routes and the separate public tracker are not its inventory.

## Authority

Send one `Authorization: Bearer <token>` header without cookies or alternate key headers. Keys remain tied to their issuer and workspace. Owner/admin can manage keys; effective grants are intersected with current membership. Editors can use prompt read/write grants; viewers can use prompt read only. `prompts:write` does **not** imply `prompts:read`. Existing grants remain unchanged by migration 0041; no saved key receives a new permission automatically.

| Scope | Implemented operations |
|---|---|
| `projects:read` | List workspace projects |
| `projects:write` | Create project |
| `team:read` | Read team; current owner/admin required |
| `analytics:read` | Recent events, overview/comparison, realtime, Journeys, observed-key Retention, observed Attribution, Revenue summary/key list/key activity, Explorer, sessions, session details and explicitly linked activity |
| `events:write` | Record API observation |
| `prompts:read` | List/search prompts, read prompt, list text versions |
| `prompts:write` | Create 1–100 prompts atomically, update, archive, restore |

Prompt bearer calls reuse the existing `withContentProject` transaction. They acquire the workspace SHARE lock for reads or UPDATE lock for writes, then reauthorize the token and bind its current issuer to the requested user and workspace. They use READ COMMITTED so the final authorization statement observes current expiry and authority before commit. The existing cookie gate and unrelated content callers are unchanged. Supported key/team mutations use the same workspace lock, and writes additionally lock the project. The final check is a publication/commit decision point; it cannot retract bytes already delivered. A key that expires during a write causes all prompt rows, text versions and receipts in that transaction to roll back.

Bearer prompt statements and lock waits each have a five-second bound. These are **not** a total-request deadline: a batch executes several statements. A bound failure returns a sanitized 503; retry writes with the same request ID. The existing key rate limit is 120 requests/minute, plus the existing content limit of 120 requests/minute per issuer.

## Authored prompt routes

All routes start with `/api/projects/{projectId}/prompts`.

| Method and suffix | Contract |
|---|---|
| GET (none) | `status=active\|archived\|all`, `q`, `tag`, `classification=branded\|unbranded`, opaque `cursor`; 50 results/page |
| GET `/{promptId}` | Current prompt; no query parameters |
| GET `/{promptId}/versions` | Immutable text versions, descending number, 50/page; only `cursor` |
| POST `/bulk` | `{requestId,prompts:[{text,topic?,tags?,enabled?}]}`; 1–100 rows, 201 |
| POST `/{promptId}/update` | `{requestId,revision,text?,topic?,tags?,enabled?}`; at least one editable field |
| POST `/{promptId}/archive` | `{requestId,revision}`; preserves text history |
| POST `/{promptId}/restore` | `{requestId,revision}`; rejects active exact-text conflicts |

Each supported query parameter may occur once. Writes accept no query and require `application/json`, at most 262144 UTF-8 bytes, and strict object keys. Text is trimmed; NUL and lone surrogates are rejected. Existing UTF-16 limits are text 2000, topic 100, tag 80, search 200; at most 20 submitted tags, lowercased/deduplicated after validation. New prompts default to topic `General`, no tags, and `enabled=false`. Saving or enabling a prompt does not call a provider or start a job.

The whole batch succeeds or fails in one transaction. Duplicate normalized text within a batch is a 400; conflict with an existing active prompt is a 409 and rolls back earlier inserts. The existing project-scoped content receipt binds request ID, operation and normalized input. Concurrent identical requests serialize and replay one result. Reusing an ID for different changes returns 409. Replays return **current** DTOs for retained result identifiers, not an immutable copy of the original response. Revision checks prevent lost updates; only text changes append an immutable text version.

Project creation has no such receipt. API event ID deduplication lasts only while its evidence is retained. Neither contract is promoted to generic batch idempotency.

## Expanded location search

The existing analytics GET accepts `geoDetail=region|city`, optional `geoPeriod=current|comparison` (default `current`) and optional `geoSearch` (default empty). Both companion parameters require `geoDetail`; `comparison` also requires `compare=prev|yoy`. Each parameter occurs once. Current input dates remain limited to 366 days; the selected derived prior range may contain 367 days.

Search has a 2048-byte raw UTF-8 ceiling, then trims and normalizes NFC before enforcing 128 Unicode scalars / 512 UTF-8 bytes. Controls and isolated surrogates are rejected. It is a literal case-insensitive contains search using the database locale across recorded names, region identity and country code, without accent folding, wildcard syntax or localized country-name matching. Search applies before the 500-row detail ceiling; no page, offset or unbounded export is supported.

One aggregate SQL statement refreshes the parent overview, both periods when comparing, and the selected `geographyDetail`. Detail identifies its actual period/dates, normalized search, generation time, matching/returned counts and truncation. Unavailable history yields no rows and null counts; retained empty results yield zero counts. Generation time is not an event-time upper bound or a replay token. Coverage and provenance remain in the selected parent period. Calls without `geoDetail` retain their previous response shape; country detail remains its complete bounded parent report. See [geography](analytics-geography.md) for the full contract and returned-row CSV scope.

## Observed Journeys

`GET /api/projects/{projectId}/journeys` uses current workspace membership and `analytics:read`. It reuses the Explorer population date/timezone/kind/exact/property/advanced/cohort filters, without grouping. Optional `steps` is one ASCII digit from 2–7, default 3. Optional `startKind`/`startValue` and `endKind`/`endValue` are atomic pairs: omit both or supply both. `pageview` values are literal pathnames starting with `/`, at most 2048 UTF-16 code units, without query/fragment, NUL or isolated surrogates. `custom` values follow the native 1–64-character ASCII event-name grammar and exclude `page_view`. Values are not trimmed. Start/end constrain the first/last shown step without re-anchoring; incompatible otherwise-valid type/start/end selections yield an empty intersection.

Only the listed parameters are accepted, each once; no body, grouping, cursor, limit or sort. The serialized query ceiling is 65,536 characters, with the inherited Explorer subset still limited to 20,000. The reader rechecks authority after workspace lock admission and at its report statement clock. Existing five-second statement/lock ceilings and 30 requests/user/minute apply alongside the API-key budget; these are not total-request deadlines.

The full eligible population is aggregated before the top 100 typed prefixes, with total/displayed/omitted counts. The unit is an observed native visitor/visit key pair; rotating keys do not identify people or complete sessions. Adjacent equal typed matching observations collapse before the step cap. Edges mean next matching retained observations, not causal transitions or proven exits. `selection.evidenceIncomplete` discloses incomplete selection/history/identity evidence; missing observations can move visits between paths, so path assignments are not guaranteed lower bounds. Retained empty data may yield zero, while unavailable visit/path/ranking values stay null. `asOf` is report/authority time, not an event-time fence. The complete JSON reply is bounded to 12 MiB (12,582,912 UTF-8 bytes); excess returns 503 rather than hidden truncation. See [Journeys](journeys.md) for timing ties, coverage and reference differences.

## Observed-key Retention

`GET /api/projects/{projectId}/retention-report` requires explicit `month` and `timeZone`, plus optional Explorer entry filters and exact saved-cohort revision. It accepts no body, `from`/`to`, grouping or pagination; the encoded query is bounded to 20,000 characters. It returns all local dates and ten exact return offsets inside the same month. These cohorts describe each rotating key's first retained matching date, with unfiltered returns; they are not first-ever users and do not merge explicit identity links. Incomplete assignment suppresses rates, while missing identity/history and known zero remain distinct. Entry, qualification and return scans share a receipt-time fence. The complete JSON is bounded to 512 KiB including a same-snapshot CSV bounded to 256 KiB. Current authorization and per-user/key limits apply. See [Retention](retention-report.md) for timing, coverage and UI contracts.

## Recorded Revenue comparison

Only GET /api/projects/{projectId}/revenue accepts optional compare=prev|yoy; omission is Off. Current input dates remain at most366 local calendar dates, while a derived prior year can contain367. One report snapshot/fence/cutoff covers both periods and returns a prior summary plus five exact changes. Incomplete or ongoing evidence suppresses deltas; percentages require a strictly positive previous value. The complete paired JSON retains the2MiB ceiling. Series, dimensions, initial keys and all sessions/detail/search/paging remain current-period only; those subordinate endpoints reject compare. See [Revenue](revenue.md) for exact money, evidence, authority and UI contracts.

## Schema coverage and source mapping

`GET /api/projects/{projectId}/attribution` requires the typed `conversionKind`/`conversionValue` pair and accepts `model=first-click|last-click` plus inherited Explorer population filters without grouping. Conversion filters do not also filter the retained keyed touch pool. One touch credit per converted observed key precedes the top20 source-value display; missing/empty metadata, unkeyed conversions, unavailable history and timestamp ties are explicit. Incomplete evidence suppresses shares. Referrers are recorded hosts including self; no Direct or paid-click identity is inferred. There is no new collection. The complete JSON ceiling is2MiB; see [Attribution](attribution.md) for exact scope, authority and assignment rules.

`src/server/openapi.ts` has exact operation paths, permission requirements, prompt wire fields and batch bounds. It intentionally leaves complex analytics, team, project and nested classification responses broad; it is not a complete generated SDK schema. Cross-field rules, Unicode normalization, canonical geography JSON, retention and cursor validation remain authoritative in the implementations. Native unknown/unavailable values must not be converted to zero.

| Source | Contract |
|---|---|
| `api.ts`, `api-keys.ts` | Bearer whitelist, mixed-credential refusal, scope/role projection and key storage |
| `project-context.ts`, `prompts.ts`, `context-input.ts` | Optional prompt bearer gate, receipts, prompt revisions, strict input and paging |
| `validation.ts`, `native-analytics.ts` | Project input and API observation validation |
| `analytics.ts`, `analytics-comparison.ts` | Overview filters and paired periods |
| `realtime.ts`, `explorer-input.ts`, `session-explorer-input.ts` | Fixed live window, exploration and session query rules |
| `journeys.ts`, `lib/journeys.ts` | Typed observed-visit prefixes, shared population filters and complete-response ceiling |
| `attribution.ts`, `lib/attribution.ts` | Typed conversion, unfiltered retained touches, one observed-key credit and incomplete-evidence shares |

See [Explorer](explorer.md), [session evidence](session-explorer.md), [tracking](tracking.md) and [prompt execution](prompt-execution.md) for the separate measurement and paid-execution boundaries. Expanded geography search is part of the existing analytics operation; Journeys, Retention and Attribution bring the inventory to21. Compatibility APIs and full upstream MCP tool coverage remain required work.

## Runnable checks

The existing analytics GET also accepts `dimension` (one of15 native choices, requires `compare`) and `selection` (nested exact/presence fields or predicates). Selection permits only Match All with1–9 unique fields from path, eventName, referrer, language and the five campaign fields; operators are eq/exists/missing, without properties or session properties. Exact literals are untrimmed and retain empty versus missing. Canonical selection is echoed. The optional `dimensionComparison` carries two independently ranked top20 lists and full opposite-period counterparts, actual ranges/coverage and current-minus-previous changes. Zero baseline percentages, missing identity and incomplete-retention changes are null. Dimension/selection requests bound the whole encoded query to20,000 characters and the complete UTF-8 response to2MiB; unsafe stored scalar metadata, oversized results and the five-second statement/lock deadlines return a whole503 error. This adds no operation or paid request. See [comparison](analytics-comparison.md); complex response schemas remain intentionally broad in OpenAPI.

Run `node --test tests/openapi.test.ts` and `node node_modules/typescript/bin/tsc --noEmit` with Node 24. `tests/native-prompt-api-integration.ts` requires both `TEN98_INTEGRATION_TEST=1` and `TEN98_NATIVE_PROMPT_API_TEST=1`, an empty owned `ten98_prompt_api_<12hex>` database on `127.0.0.1:55501`, and `APP_URL=http://127.0.0.1:3111`. It retains fixtures, performs the real 40→41 upgrade, opens its own HTTP server, checks actual PostgreSQL lock waits and rolls back expired writes. It also runs the original API-key integration assertions with that test's original five-grant role fixture. Never point it at saved application data.
