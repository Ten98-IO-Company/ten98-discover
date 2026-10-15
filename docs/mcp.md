# Native MCP

This increment exposes 16 implemented native tools at `POST /api/mcp`. It uses the pinned official server/core SDK 2.3.1, modern protocol 2026-07-28 and the SDK's stateless legacy Streamable HTTP support. It is an incomplete P06 inventory: full pinned Elmo/OpenSEO tools, interactive OAuth authorization and paid-operation tools remain required work. It does not claim V1 completion or compatibility with an untested desktop client. See [native API](native-api.md) for the corresponding native contracts and [third-party notices](../THIRD_PARTY_NOTICES.md) for the SDK and bundled licenses.

Use one `Authorization: Bearer t98k_…` header. These are native workspace API keys, not OAuth tokens. Cookie authentication, cookies combined with a bearer, alternate `x-api-key`, and URL query parameters are refused. No authorization-server metadata, registration or automatic browser sign-in is advertised. A present `Origin` must exactly equal configured `APP_URL`, including scheme and port; absent Origin is allowed. Empty, `null`, multiple or nonmatching origins are refused. There is no wildcard CORS. GET, DELETE and OPTIONS return 405.

Each request creates its own official SDK server and handler. Modern requests use the official `_meta` envelope and matching `MCP-Protocol-Version`, `Mcp-Method` and, when required, `Mcp-Name` headers. The SDK owns protocol classification, metadata validation and finite JSON/SSE encoding. Legacy initialize and subsequent calls are stateless: there is no session ID or standalone GET stream. Modern responses use automatic JSON/SSE selection; finite legacy SSE remains supported. No tasks, resources, protocol prompts, sampling, roots, elicitation or subscriptions are advertised. Tool list-change notifications are disabled and the subscription limit is zero. SDK instances and the adapter's abort listener are closed/removed after completion, failure or cancellation; no second HTTP listener is created.

## Fixed catalog

| Tool | Grant | Native implementation |
|---|---|---|
| `ten98_whoami` | Any valid key | Current user/workspace IDs, effective scopes and permitted tool names only |
| `ten98_read_analytics` | `analytics:read` | `projectAnalytics` |
| `ten98_read_realtime` | `analytics:read` | `projectRealtime` |
| `ten98_list_sessions` | `analytics:read` | `listSessions` |
| `ten98_read_session` | `analytics:read` | `getSessionDetail` |
| `ten98_read_linked_activity` | `analytics:read` | `getLinkedSessionActivity` |
| `ten98_read_journeys` | `analytics:read` | `projectJourneys` |
| `ten98_read_retention` | `analytics:read` | `projectRetentionReport` |
| `ten98_read_attribution` | `analytics:read` | `projectAttribution` |
| `ten98_list_prompts` | `prompts:read` | `listPrompts` |
| `ten98_read_prompt` | `prompts:read` | `getPrompt` |
| `ten98_list_prompt_versions` | `prompts:read` | `promptVersions` |
| `ten98_create_prompts` | `prompts:write` | Atomic `createPrompts` |
| `ten98_update_prompt` | `prompts:write` | `updatePrompt` |
| `ten98_archive_prompt` | `prompts:write` | `setPromptArchived(true)` |
| `ten98_restore_prompt` | `prompts:write` | `setPromptArchived(false)` |

Discovery filters this fixed catalog by the key's current role-intersected grants. Write does not imply read. Each invocation independently reauthorizes; explicit project IDs must belong to the key's workspace. Native readers keep their SQL authority checks. Read results, discovery and whoami additionally pass a fresh publication decision; if effective authority changes while the response is prepared, the stale response is refused. This cannot retract bytes already delivered by an earlier request. No principal or tool list is cached between requests.

The endpoint reuses the existing 120 requests/key/minute budget. Realtime also uses 60/user/minute and the three session tools share 30/user/minute, including their native HTTP routes. Prompt transactions retain their workspace lock, current issuer/role check and final key check before commit. Expired writes roll back. Per-statement and lock-wait bounds are not a total-request timeout.

Journeys, Retention and Attribution each share their existing native HTTP 30/user/minute limit. Each receives the original API-key token, retains its native workspace admission and fresh SQL authority checks, and passes the existing MCP final publication checks. Inputs are strict native URL-wire objects without grouping, paging or arbitrary routing. Journeys permits optional dates/timezone and atomic typed start/end pairs with 2–7 steps (default 3). Attribution requires a typed conversion and defaults to first-click. Retention requires an explicit month and named timezone, and returns its native same-snapshot CSV. Each tool preserves null/zero, coverage, provenance and observed-key limitations; see [Journeys](journeys.md), [Retention](retention-report.md) and [Attribution](attribution.md). Separate tool calls are not one common snapshot. The existing 8 MiB complete MCP envelope, including both result copies, can refuse a native Journeys response below that reader's own 12 MiB ceiling; no successful prefix is returned.

## Input and result contracts

Tools take strict named objects. Every project tool requires `projectId`; prompt detail/mutations use `promptId`, observed activity uses `visitorKey`. Read `query` objects contain native URL wire strings, not arbitrary URLs or routes. Session dates and named timezone are explicit; `pageSize` is a canonical string from `1` to `100`, and cursor scope is validated natively. Advanced `predicates` and `propertyValue` are JSON text interpreted by the existing bounded parsers. Native date, Unicode, geography composite-key, filter, cohort and cursor validation remains authoritative. Unknown argument/query fields reject the operation. Realtime accepts only projectId. Overview carries the accepted comparison and 500-row expanded location search; it does not create an unbounded export or cross-tool snapshot.

Every HTTP body is limited to 262144 actual UTF-8 bytes and decoded fatally by native `readJson` before the SDK receives `parsedBody`. Declared excess, invalid UTF-8/JSON and non-JSON content types are refused. JSON-RPC arrays/scalars are rejected. Request IDs are safe integers or strings of at most 128 UTF-16 code units. Prompt bulk is one atomic tool call of 1–100 entries, not JSON-RPC batching or an arbitrary operation dispatcher.

Successful reads return native DTOs in both `structuredContent` and JSON text content. Dates serialize to ISO strings; null, zero, retained coverage, identity limitations and provenance are preserved. Estimates describe rotating native keys, not persistent people. Each read has its own native snapshot semantics. Retention applies its raw receipt-time `asOf` cutoff to entry, qualification and return events. Journeys and Attribution retain their documented report clocks and calendar boundaries; their `asOf` is not an event-time fence. Complete HTTP responses, including duplicated result data and finite legacy framing, are capped at 8 MiB. Oversized reads return an error asking for a narrower selection, never a successful prefix. This response cap does not bound all database intermediate work.

The four prompt mutations return a compact receipt:

```json
{"committed":true,"requestId":"<submitted UUID>","replayed":false,"items":[{"id":"<prompt UUID>","revision":1,"currentVersionId":"<version UUID>","archivedAt":null}]}
```

The result is at most 100 fixed-shape identifiers/revisions/timestamps, below 64 KiB including both result copies at the tested maximum. Authored text, tags and classification are not repeated after commit. Native receipt replay returns the current state of the saved IDs, not an immutable historic snapshot. Reuse the same requestId only for the identical normalized operation; changed payload/operation conflicts. A transport interruption is not proof of rollback: retry that same requestId to resolve the outcome. Saving, enabling, editing, archiving and restoring never schedule or execute provider work. Write annotations are conservatively destructive and idempotent only under this explicit receipt contract.

Native tool failures use bounded `isError` results with safe status/message fields; protocol and ingress failures use JSON-RPC errors with appropriate HTTP status. Internal SQL, credentials, raw network values and stack traces are not returned. Unknown tool names cannot select arbitrary native functions. No tools accept code, SQL, provider endpoints or arbitrary request routing. Discovery performs no provider/catalog/network lookup, and this entire catalog makes no paid calls.

## Verification boundary

`tests/mcp.test.ts` checks the fixed schemas/scopes, complete UTF-8 size accounting, bounded receipts, exact Origin, and actual official modern/legacy catalog encoding. `tests/mcp-report-tools.test.ts` adds the three report schemas, unchanged native wire interpretation, closed scope/parameter boundaries and read-only SDK discovery. These pure checks do not establish database or transport acceptance. `tests/mcp-integration.ts` is opt-in and restricted to a fresh synthetic PostgreSQL fixture on `127.0.0.1:55501` with owned HTTP port 3111. Its six original groups exercise the original 13 tools through native HTTP → handleApi → SDK → domain functions, transaction waits, late authority loss, receipts and provider inactivity. Four additive groups compare the three report tools with their actual direct readers and native HTTP routes over both MCP transports, including typed filters, cohorts, calendar boundaries, all four roles, 12 observed late-authority waits, complete-result refusals and shared native rate limits. Per-call report clocks are checked separately rather than treated as one common snapshot. The raw HTTP fixture uses `agent:false`; it does not establish official-client pooling compatibility. Production compilation is a separate check from actual compiled HTTP and resource acceptance.
