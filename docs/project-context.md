# Project context and prompt library

This slice stores project knowledge and a versioned prompt library. Saving either does not call providers, start tracking, create schedules, or authorize spending. It implements part of P09/P11; provider execution remains separate work. Three MCP tools (`ten98_read_context`, `ten98_list_context_research`, `ten98_update_context`) and the bearer scopes `context:read`/`context:write` expose the context routes; see [native MCP](mcp.md) and the [native API contract](native-api.md).

## Context

Owners, admins and editors can edit the brand name/aliases, four standard prose sections, up to 20 custom sections, 100 competitors, 100 key pages, and research notes. Viewers can read. The project name and collector origin remain unchanged. Context domains are exact normalized public hostnames; they do not prove ownership or enable collection. Key pages keep HTTP versus HTTPS, host prefixes, path and query parameters; fragments are removed. These URLs are metadata and are never fetched here. Remove credentials or sensitive query values before saving.

Updates carry a context revision and UUID request ID. A whole batch (up to 50 operations) commits together; a stale revision returns 409. Omitted fields preserve existing values, while supported empty strings clear them. Research uses the server's UTC date and authenticated actor, displays 20 records per page, and retains authored notes until explicitly deleted. Report templates reuse the existing report store with bounded text previews.

## Prompts

Prompts have stable IDs, an optimistic revision, and immutable numbered text versions. Text edits append a version; topic, tags, enabled preference and archive changes preserve existing versions. An active exact duplicate is rejected, including an atomic bulk batch of up to 100 entries. Archiving keeps history and supports restore. Enabled defaults to false and is only a saved preference while automatic scheduling is unavailable. The separate [manual execution API](prompt-execution.md) requires an explicit quote and start; saving a prompt never starts work.

Lists paginate 50 entries and support active/archived/all, literal text search, user tag and branded classification filters. Histories paginate by immutable version number, independently of timestamps. System classification preserves Elmo's versioned substring heuristic; user branded/unbranded tags remain separate. Exactly one of those tags overrides the automatic result; both or neither use the automatic result. The heuristic can overmatch short brand terms. See THIRD_PARTY_NOTICES.md for source and MIT notice.

## API and authorization

The context routes accept a cookie session or an API key holding `context:read` (reads) or `context:write` (the CAS batch); `context:write` does not imply `context:read`, and a key issued before migration 0062 gains nothing automatically. Bearer calls hold the workspace SHARE lock for reads or UPDATE lock for the write under READ COMMITTED with five-second statement and lock-wait bounds, and the key's current authority is rechecked before publication or commit and again after a rollback, on the same connection and even when the lock wait itself failed. A bearer POST `/context/update` returns `{revision,replayed}` only; the cookie route keeps the full context DTO. The prompt routes keep their `prompts:read`/`prompts:write` gate. Writes recheck current owner/admin/editor membership after obtaining the workspace lock, then lock the project. Cookie reads use a repeatable-read snapshot; every read always filters by project.

- GET `/api/projects/:id/context`; POST `/context/update`; GET `/context/research-log?cursor=...`.
- GET `/api/projects/:id/prompts`; POST `/prompts/bulk`.
- GET `/prompts/:promptId`; POST `/:promptId/update`, `/:promptId/archive`, `/:promptId/restore`; GET `/:promptId/versions`.

Mutation request IDs are bound to the project, operation and normalized payload. An exact retry does not create a second write; reusing an ID with changed input returns 409. Receipts retain result identifiers, rather than another copy of authored text. Cursors bind ordinary navigation to project, list and filters; authorization is checked independently.

## Checks

`node --test tests/project-context.test.ts` exercises strict validation, exact host/URL normalization, classification and cursor binding. After migrating a new empty local test database, run `TEN98_INTEGRATION_TEST=1 node --env-file=<test-env> tests/project-context-integration.ts` using the environment syntax for your shell. The integration runner refuses a nonempty user database and remote hosts. It checks roles, lock-time demotion, tenant isolation, atomic caps, replay receipts, retained old research, immutable/version-number history, pagination, cookie-only access for the prompt neighbours, retention preserving authored data and retry receipts, and zero provider/DNS/job activity. Its bearer CAS group drives the context routes through `handleApi` with a bearer alone, no cookie and no Origin: a `projects:read` key never gains the context read; a `context:read` key reads the same DTO as the cookie GET while a `context:write`-only key is refused on reads; cookie plus bearer is 400; a `context:read` key is refused on the write; a `context:write` key commits one batch (revision n+1, `replayed:false`, the key's issuer recorded as the section author), replays the identical request ID and body to the same revision with `replayed:true` and no second receipt row, and gets 409 for a changed payload under that request ID and for a stale revision, with no receipt left by refused writes; a key issued by an admin still writes after demotion to editor, is refused on the write after demotion to viewer and keeps the read; a foreign-workspace key sees 404 on both routes; a revoked key is refused with 401 and the revision is unchanged. Synthetic records remain in that isolated database.

Migration 0014 must be applied through the migration runner. Earlier migrations remain unchanged; the integrated migration list applies 0013 retention before 0014.

## Bounded Kimi drafting evidence

The two original UI contracts were published on issue 13 before external drafting:
[Context](https://github.com/Ten98-IO-Company/ten98-monitor/issues/13#issuecomment-6134596637), [Prompts](https://github.com/Ten98-IO-Company/ten98-monitor/issues/13#issuecomment-6134596957). Only those public contracts and reviewed skills were supplied, without environment files, credentials or synthetic fixture secrets. Each run used the fixed CLI 2.1.1, K3-256K, maximum thinking, Skill-only agent, no subagents, isolated output directory, 8-step limit and hard process timeout.

- PromptsPanel produced one allowlisted file, with observed output duration 610.4 seconds inside its 900-second cap. Observed tools: Skill for Ponytail and UX Copy Refiner.
- ContextPanel attempt 1 reached its 900-second timeout with no final file. Observed tools: Skill for Ponytail and UX Copy Refiner.
- Its final 300-second retry also timed out with no final file or observed tool call. Drafting stopped after the two attempts; no third request was made.

Output duration is file timestamp observation, not measured provider latency. Subscription usage, token consumption and savings were not available and are not estimated.

GPT review repaired PromptsPanel's network-uncertain handling (the shared helper reports a status-zero ApiError), exact request-ID retries, concurrent-response invalidation after permission loss, callback freshness, and bounded current-prompt conflict lookup. Edge checks used synthetic local fixtures and blocked external browser requests. They passed prompt creation/editing, immutable history, conflict draft preservation, bulk duplicates, archive/restore, exact same-payload retry after a committed response was lost, project/account switching, viewer controls, delayed history response after 403, and 360px layout. These initial panel checks used Vite and real local APIs. The production integration checks below also passed.

After the two bounded ContextPanel failures, the coordinating GPT task explicitly approved a checkpoint handoff for the remaining context design, sensitive draft handling, permission handling and retry flow. GPT implemented only that panel, using native forms and collapsible groups with the existing classes. Another GPT reviewer found no material lifecycle blocker. Edge acceptance then exercised every context editor and deletion type, IDN host normalization, URL metadata preservation, conflict draft retention, exactly-once append after a lost committed response, research pagination, project/account changes, permission purge, viewer controls and 360px form layout. Browser feedback corrected accessible names on prefilled textareas and the page-role selector.

The repeatable browser runner is `tests/project-context-browser.mjs`. Use a migrated isolated local database and a production server from this checkout with the same environment and APP_URL; complete owner setup in that test installation first. Set `TEN98_INTEGRATION_TEST=1` and `PLAYWRIGHT_MODULE` to your installed Playwright module URL (optionally `PLAYWRIGHT_CHANNEL`, default msedge), then run it with Node 24 and that test environment file. No browser dependency is added to the app. The runner creates synthetic users/projects, blocks browser requests outside the local app origin, navigates the actual app, and retains synthetic database records and screenshots under private/evidence. It does not use real provider credentials or make vendor calls.

## Integrated checkpoint

The Research navigation group now opens Context and Prompts for the selected project. Panels remount for either a project or account change and inherit the responsive application shell. Build, TypeScript, all 135 passing unit tests (two platform-specific skips), planning checks, fresh project-content database/API tests, and original-install upgrade/rollback checks through migration 0014 passed. Production Edge acceptance ran both complete panel workflows at desktop and 360px widths, including the real mobile menu, saved-data conflicts, committed-response retries, viewer controls and access-loss cleanup. Shutdown hooks, the retention worker and existing route authorization remain unchanged. This is still partial P09/P11 implementation, with no provider execution or full-V1 claim.

Historical screenshots and their original checkpoint captions are in the [delivery archive](https://wiki.ten98.io/s/ten98-docs/p/historical-screenshots-project-context-and-prompt-retention-VrWna880ye).
