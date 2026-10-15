# Native bearer API contract

This development increment documents 18 implemented operations: 11 existing project/team/analytics operations and seven authored-prompt operations. It does not complete the 81-requirement register, provide MCP transport, expose paid prompt execution, or implement a generic HTTP batch dispatcher.

`GET /api/openapi.json` returns a static OpenAPI 3.1.2 document before configuration, database readiness and installation setup checks. It accepts no query or body, uses relative server `/`, and does not reflect request hosts or credentials. Other methods return 405. There is no hosted documentation renderer, CDN or automatic provider request. The document describes bearer access; browser cookie routes and the separate public tracker are not its inventory.

## Authority

Send one `Authorization: Bearer <token>` header without cookies or alternate key headers. Keys remain tied to their issuer and workspace. Owner/admin can manage keys; effective grants are intersected with current membership. Editors can use prompt read/write grants; viewers can use prompt read only. `prompts:write` does **not** imply `prompts:read`. Existing grants remain unchanged by migration 0041; no saved key receives a new permission automatically.

| Scope | Implemented operations |
|---|---|
| `projects:read` | List workspace projects |
| `projects:write` | Create project |
| `team:read` | Read team; current owner/admin required |
| `analytics:read` | Recent events, overview/comparison, realtime, Explorer, sessions, session details and explicitly linked activity |
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

## Schema coverage and source mapping

`src/server/openapi.ts` has exact operation paths, permission requirements, prompt wire fields and batch bounds. It intentionally leaves complex analytics, team, project and nested classification responses broad; it is not a complete generated SDK schema. Cross-field rules, Unicode normalization, canonical geography JSON, retention and cursor validation remain authoritative in the implementations. Native unknown/unavailable values must not be converted to zero.

| Source | Contract |
|---|---|
| `api.ts`, `api-keys.ts` | Bearer whitelist, mixed-credential refusal, scope/role projection and key storage |
| `project-context.ts`, `prompts.ts`, `context-input.ts` | Optional prompt bearer gate, receipts, prompt revisions, strict input and paging |
| `validation.ts`, `native-analytics.ts` | Project input and API observation validation |
| `analytics.ts`, `analytics-comparison.ts` | Overview filters and paired periods |
| `realtime.ts`, `explorer-input.ts`, `session-explorer-input.ts` | Fixed live window, exploration and session query rules |

See [Explorer](explorer.md), [session evidence](session-explorer.md), [tracking](tracking.md) and [prompt execution](prompt-execution.md) for the separate measurement and paid-execution boundaries. Expanded geography search is part of the existing analytics operation, so the inventory remains 18 operations. Journeys is not in this integrated inventory and must be documented when its supported bearer route is integrated. Compatibility APIs and full upstream MCP tool coverage remain required work.

## Runnable checks

Run `node --test tests/openapi.test.ts` and `node node_modules/typescript/bin/tsc --noEmit` with Node 24. `tests/native-prompt-api-integration.ts` requires both `TEN98_INTEGRATION_TEST=1` and `TEN98_NATIVE_PROMPT_API_TEST=1`, an empty owned `ten98_prompt_api_<12hex>` database on `127.0.0.1:55501`, and `APP_URL=http://127.0.0.1:3111`. It retains fixtures, performs the real 40→41 upgrade, opens its own HTTP server, checks actual PostgreSQL lock waits and rolls back expired writes. It also runs the original API-key integration assertions with that test's original five-grant role fixture. Never point it at saved application data.
