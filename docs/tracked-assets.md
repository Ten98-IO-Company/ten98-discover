# Native tracked links and pixels

This implementation uses four workspace-owned tables in migration0058, independent of website projects and browser tracking. The migration must follow the actual0056/0057 prefix before registration and execution. Source preparation alone does not demonstrate acceptance or complete P44/P45.

`src/lib/tracked-assets.ts` is the closed request/result contract. `src/server/tracked-assets.ts` owns validation, current authorization, HTTP collection and retained reports. There are no provider calls, destination fetches, third-party pixels, browser DOM access or new dependencies.

## Configuration and request handling

Owners, admins and editors create/edit/delete; all four roles read private reports. Link and pixel kinds are immutable. A stable random public routing key is separate from report sharing. A link has a saved HTTPS destination; a pixel has no destination. Names, destinations, active state and collection choices can change through revision CAS and actor-specific request receipts. Exact unknown writes retain their request ID and body. A later point GET is not an acknowledgment. Receipts survive asset deletion, contain IDs/hashes only, and cannot replay as another actor.

Destinations use strict Unicode/percent validation before platform URL parsing, public host syntax, HTTPS and no credentials. The service rejects a direct loop into its own tracking route. It never fetches a destination or claims to verify its DNS, reputation or final content. Generated opaque routing keys are used; vanity slug editing is not implemented.

`GET /api/track/link/{publicKey}` returns302 to the saved destination. `GET /api/track/pixel/{publicKey}` returns a fixed transparent1×1GIF. HEAD has matching target/headers with no body and no observation. Other methods are405. Query values cannot replace the destination and are not stored. Invalid/excessive raw query encoding fails before parsing. Response headers disable caching, cookies and referrer disclosure; the GIF permits cross-origin image embedding without credentialed CORS. Inactive, deleted and missing targets return404.

Basic collection is an explicit operator setting, not evidence of visitor consent. GET observations honor DNT/GPC, configured named-bot exclusion and available prefetch/prerender purpose headers. Refused, disabled or rate-limited collection still permits the current active redirect/image. Counts describe accepted HTTP requests, not people, confirmed clicks, delivery or email opens. Privacy proxies and scanners can resemble browsers; caches may prevent requests from reaching the application.

Each request locks workspace then asset, and reads active/settings after waiting. Recording has a savepoint after those locks. A failed INSERT/rate check may roll back only recording while preserving the locked current target. If initial authority, rollback recovery or transaction commit fails, the response does not use an earlier unprotected target. Rate accounting uses the existing limiter with its optional caller client, avoiding nested pool acquisition. No automatic retry or detached recording queue is used.

Only normalized device/browser/OS, optional public referrer hostname and optional local database geography are stored. Address-literal, private-host and malformed referrers are omitted. Raw IP, UA, Referer path/query, request path/query, cookies, distinct IDs and arbitrary properties are absent. Network off or unavailable network identity leaves visitor/visit keys null. Existing native identity hashing is scoped by asset UUID, with monthly rotating visitor keys and hourly visits; signed browser context is discarded and never returned. These are estimates, not cross-asset identities or sliding sessions. Geography availability follows existing local database/network controls.

## Private API and reports

Base: `/api/workspaces/{workspaceId}/tracked-assets`.

- GET collection requires `kind=link|pixel`, optional scoped cursor; pages contain20 records plus a continuation cursor.
- POST collection: `{requestId,asset}`.
- GET `/{assetId}`: current saved record.
- POST `/{assetId}/update`: `{requestId,revision,asset}`; POST `/delete`: `{requestId,revision}`.
- GET `/{assetId}/report`: explicit `from`, `to`, `timeZone`; optional one dimension/limit and supported exact filters.
- GET/POST `/{assetId}/shares`; POST `/shares/{shareId}/revoke`.

These are cookie routes with exact APP_URL Origin for writes, not analytics API-key routes. Request bodies are16KiB; results2MiB; report ranges1–366 days. Current membership is read after the workspace lock. The update receipt binds actor, operation, canonical body, result IDs and applied revision. Current item/role is returned separately from that immutable ACK.

Report dimensions: referrer, channel, browser, OS, device, country, region, city. Typed geography and environment sentinels reuse existing native validators. `referrerMissing=1` selects missing referrer and cannot combine with exact `referrer`. Channels use the existing recorded-tag meaning; because this HTTP source captures no campaign tags, only `referrer_only` and `not_recorded` are possible. Rich inferred search/social/paid channels are not fabricated. Website path/event/property/cohort/session/origin filters are rejected, never silently dropped.

`native-tracked-assets-v1` returns safe asset identity/name/revision, exact scope, snapshot date range, retention coverage, nullable identity estimates, daily local-calendar counts and a bounded grouped breakdown. Ranking and grouping happen before the row limit. The metric is explicitly `requests`; estimated visitor counts are nonadditive across days/groups. No destination, public routing key, capture configuration, raw observation rows or CSV is included. PostgreSQL owns exact retention-cutoff comparisons, including submillisecond boundaries; expired values are null and rows are empty, not invented zeroes. Genuine retained zero requests remains0.

The report service is also the narrow P43 dependency: later board wiring can use this distinct source for link/pixel metrics bars, trends, eight supported breakdowns and map. It must validate current workspace/entity/card scope and use request-specific labels. It must not pass asset IDs to project report functions or broaden incompatible board filters. The twelve website-only card types remain incompatible. P43 integration is not present in this backend change.

## Scoped public shares

Owners/admins create a share using current asset revision, immutable explicit report scope, chosen `summary`/`trend`/`breakdown` sections, label, expiry1hour–365days and a canonical43-character base64url token generated from32 random browser bytes. The server stores only its SHA256 hash; exact retries retain the token in client memory. The creation ACK permits copying the URL. Metadata lists and reloads cannot recover plaintext. No token goes in local storage or public report JSON.

`GET /api/tracked-shares/{token}` has no query overrides or arbitrary asset ID. Every read locks the grant's workspace, then reads current grant/asset and expiry. It exposes only allowed aggregates and checks expiry again before commit. Revoke uses current owner/admin role, CAS and actor receipts. A revoked/expired/deleted share is404; private membership, other grants and asset ingress remain independent. Raw tokens, token hashes and destination configuration never appear in public output. There is no cached authorization JWT.

A future public-view UI must avoid private application boot requests, prevent token referrers, and discard displayed data after revocation/expiry. This change provides link/pixel capability endpoints, not the public-view UI. P45 website/board section grants remain separate work. Existing report HTML snapshots keep their existing `/share/{slug}` behavior.

## Retention and restoration

Workspace raw-analytics retention applies even with no website project. Preview includes asset observations. Shortening policy atomically advances each asset's nondecreasing watermark; extending later cannot revive unpurged rows. Report queries apply current policy and stored watermark immediately. The existing worker retention tick runs one bounded asset cleanup after project cleanup: at most1000 observations from one asset, then10seconds if work remains or1hour if complete. There is no extra timer or generic scheduling layer.

Offline restoration pauses public assets and collection and revokes all active asset shares. Explicitly re-enabling an asset does not reactivate old share tokens. Existing financial and replay quarantine behavior remains in place.

## Reproducible checks and provenance

`tests/tracked-assets.test.ts` contains four focused pure groups. `tests/tracked-assets-integration.ts` contains eight synthetic native groups guarded by explicit opt-ins, a fresh local database and the actual58-migration prefix. They cover real SQL locks/rollback, actual API response bytes, privacy refusals, native aggregation/DST, share isolation/revocation, no-project retention1000+1, cookie/Origin/bearer/rate boundaries and restore quarantine. They do not send email or contact external providers. Authored checks must be run and inspected before claiming success. UI/browser contribution is separate.

Behavior reference: Umami v3.4 pinned `ec0ff50388c264ed8ce46f00967e92f7e71476ae3`, Link/Pixel models, q/p ingress, Link/Pixel panels and metrics bars. Existing third-party notices cover that reference. Current official [Links](https://docs.umami.is/docs/links), [Pixels](https://docs.umami.is/docs/pixels) and [public dashboards](https://docs.umami.is/docs/guides/create-a-public-dashboard) describe the reference flows; newer social-preview fetching is not claimed. [RFC9110 HEAD](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2) and [302](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.3) define the HTTP response semantics.
