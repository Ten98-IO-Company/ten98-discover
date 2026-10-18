# Website public share links

Code contract for P45 website (project analytics) shares and the P02 creator rule from owner decision D6. Implemented in `src/lib/website-shares.ts`, `src/server/website-shares.ts`, the share mode of `projectAnalytics` in `src/server/analytics.ts`, `src/components/WebsiteSharePanel.tsx` and `src/components/SharedBoardPanel.tsx`. Board shares are described in [boards.md](boards.md), tracked link and pixel shares in [tracked-assets.md](tracked-assets.md).

An owner or admin opens **Collection and privacy** for a website, chooses **New public link**, names it, picks sections and an expiry, and copies the URL once. Anyone with the URL can read the approved sections for any 1–366 day UTC range until the link expires or is revoked.

## Defaults the owner may override

These were lead decisions on the open questions, recorded for the owner to confirm or change:

- Expiry is required, 1 hour to 365 days, like board, tracked and report shares (pinned Umami shares never expire).
- Sections are `overview`, `events` and an opt-in `locations`. Individual sessions, visitors and recordings are never shareable. Realtime, UTM, revenue, goals and funnels stay shareable through board shares only.
- Regions and cities appear only in the opt-in `locations` section. Counts are exact in every section with no minimum group size (k-suppression), matching Umami, and recipients may choose a one-day range, so on a low-traffic website any section can single out individual visits. The creation form says so, and that region and city rows are the most identifying.
- Recipients may change the dates only: no filters, segments, cohorts, comparison, dimension or location search.
- A restore quarantine revokes every live website share, as it does tracked-asset shares. Board and report shares are unchanged by this increment.
- The owner/admin listing shows the creator's name and email with a former-member marker (D6). Board, tracked and report listings gain the creator in roadmap item 10.
- Only current owners and admins create, list or revoke. Editors and viewers get 404, like board and report share management.
- Share pages are never embeddable: the root document policy sends `frame-ancestors 'none'`.
- Capacity: 120 reads per share per minute, 300 per minute across all website shares, at most two concurrent public reads per web process, and a 300 s recipient refresh.
- Open, not part of this increment: the "OpenSEO hosted flag" equivalent named in P45.

## Storage

Migration `0069_project_shares.sql` adds `project_share`: `id`, `project_id` (cascades with the website), `label` (1–120), `token_hash` (unique hex sha256), `sections` (non-empty subset of the three names), `created_by` (`"user"` id, set to NULL when the account is deleted), `created_at`, `expires_at`, `revoked_at` (millisecond stamps, `expires_at > created_at`). Grants are immutable except `revoked_at`, which never returns to NULL; any change, rotation included, is revoke plus create. No raw token is stored anywhere. Request receipts reuse `project_content_request`, which cascades with the website. The workspace derives through the project; `transferProject` (roadmap item 10) must revoke the project's shares in its own transaction.

## Management (cookie only, owner/admin)

All routes sit under `/api/projects/{projectId}/website-shares`, so the workspace two-factor requirement applies; bearer keys get 403; POSTs need the exact application Origin. Rate limits are 120 reads and 30 writes per user per minute. A `#` anywhere, a query on a POST, a body on a GET or more than one cursor answer 400; other methods 405.

The gate is `BEGIN READ COMMITTED`, 5 s statement and lock timeouts, then workspace FOR SHARE, project FOR SHARE, and the membership role checked in `('owner','admin')` after the waits. Everyone else, including a removed member, gets 404 `Website share not found or unavailable.`

| Route | Contract |
| --- | --- |
| GET collection | `{projectId,role,items,nextCursor}`: 20 items newest first plus a sentinel, cursor bound to `{projectId,list:'website-shares'}`. Each item is `{id,label,sections,createdAt,expiresAt,revokedAt,state,creator}` with `state` active/expired/revoked on the database clock and `creator` `{name,email,member}` or null for a deleted account. Never a token, hash or URL. |
| POST collection | Strict `websiteShareCreate` (≤4096 bytes): `requestId`, trimmed `label`, unique sorted `sections`, `expiresAt` (ISO, millisecond precision, 1 h–365 d on the database clock) and a canonical 43-character base64url `token`. Receipt `website.share.create.v1` binds actor, label, sections, expiry and token hash: an identical retry returns the original acknowledgment with the current item (possibly revoked, never revived) and `replayed:true`; a changed body or another actor is 409; a reused token is 409. |
| POST `/{shareId}/revoke` | Strict `{requestId}` (≤1024 bytes). Receipt `website.share.revoke.v1` binds actor and share. The grant row is taken FOR UPDATE (public readers never lock it) and `revoked_at` is set once; idempotent and irreversible. |

Writes answer `{projectId,ack:{requestId,operation,shareId},item,replayed}`. The owner's tab generates the token, keeps the exact body for an uncertain retry, and shows `/share/websites/{shareId}#{token}` once.

## Hosted page

`/share/websites/{shareId}` (`src/routes/share/websites/$shareId.tsx`) sets robots `noindex, nofollow`, referrer `no-referrer` and inherits the root document headers: nonce CSP with `frame-ancestors 'none'`, `no-store`, COOP and `nosniff`. The fragment is captured once and removed with `history.replaceState`; router preflight scrubs malformed `/share/websites/` fragments. A query, a malformed path or a malformed token renders "incomplete link" and sends no request. Reads use `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, `redirect: 'error'`, a 25 s timeout and a 2 MiB stream cap; they refresh every 300 s while visible and on becoming visible, and purge on hide, 401/403/404 and at `expiresAt`. The recipient picks UTC from/to dates (default the last 7 days).

## Public read

`POST /api/website-shares/{shareId}/read`, admitted right after the board block in `src/server/api.ts` and before any API-key or session lookup, in this order: Authorization or x-api-key 403; `?` or `#` 400; non-POST 405 with `Allow: POST`; `X-Ten98-Website-Share` must be a canonical 43-character base64url value, else 404; Origin must equal `APP_URL` and `sec-fetch-site` must not be `cross-site`, else 403; then `website-share:global` (300/min) and `website-share:{id}:read` (120/min); body ≤1024 bytes, strict `{from,to}`, 1–366 days. Responses are `no-store`, `nosniff`, `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow`, with no CORS headers and no cookie.

Authority: a lock-free locator finds the live grant by id and token hash, then `projectAnalytics(projectId,'',{from,to},undefined,{shareId,tokenHash})` runs in share mode:

1. `BEGIN` with the same 5 s timeouts;
2. a plain read of the website's `analytics_epoch`, with no workspace gate, no grant lock and no project row lock;
3. the unchanged single aggregate, whose target joins `project_share` on project, id, token hash, `revoked_at IS NULL` and `expires_at > clock_timestamp()` in place of the membership join;
4. the same join as a plain SELECT before COMMIT, also requiring the epoch read in step 2.

Unknown id, wrong token, revoked, expired, a foreign website's id or token, and a deleted website all answer the same 404; an epoch change during the read (a reset, a settings save, a serving-domain eligibility change or a restore) and timeouts answer 503. The member and bearer SQL is byte-for-byte unchanged.

Lock contract: a public reader takes no row lock, so no writer ever waits on a lock it holds or starves behind overlapping reads: not revocation, membership writes or API-key revocation, and not the project FOR UPDATE writers (identified collection and identify, the retention worker, reset, deletion, settings saves and the worker gates). The final check replaces the lock as the publication fence. Every reset changes `analytics_epoch` before it commits, so a reset that commits before a read's final check makes that read answer 503, and one that commits after it is concurrent with the read, exactly as it would be after a lock holder's COMMIT: every published read's final check precedes the reset's commit, the same ordering a project lock gave. A read whose final check ran just before a revoke or deletion committed can still deliver; the next read answers 404. A retention pass committing during a read is concurrent with it: the read publishes its own consistent snapshot, as a read that finished just before the pass would. The board public reader still holds the workspace gate and project rows (see [boards.md](boards.md)). Pool capacity is bounded separately: the limits count requests per minute, and at most two public aggregates run at once in a web process, so a third concurrent read answers 503 at once instead of queueing for one of the 10 shared connections that collection also needs (marked `ponytail:` in `api.ts`).

## Response

Closed `publicWebsiteShareSchema`, version `public-website-share-v1`. The server parses before sending (503 if it cannot verify), the page decodes before rendering.

- Always: `version`, `shareId`, `label`, `sections`, `expiresAt`, `range {from,to,timeZone:'UTC'}`, `coverage {status,retainedFrom}`.
- `overview` when granted: `pageViews`, `visitors`, `visits`, `bounceRate`, `averageVisitSeconds`, `daily [{date,pageViews,coverage}]` (≤366), `pages [{path,pageViews}]` (≤20), `referrers [{host,pageViews,visitors}]` (≤20, self-referrals excluded exactly as in the private overview), `browsers`/`operatingSystems`/`devices [{value,pageViews,visitors}]` (catalog values or null), `countries [{key,pageViews,visitors}]` (≤678).
- `events` when granted: `customEvents`, `daily [{date,customEvents,coverage}]`, `names [{name,count}]` (≤20). Counts and names only; no property values.
- `locations` when granted: `regions` and `cities [{key,regionName,pageViews,visitors}]` (≤100 each).

Never emitted: workspace, project or user ids, the project name or origin, the creator, `lastReceivedAt`, collection mode and consent-basis counts, identified/unidentified pageviews, environment coverage, `firstRecordedAt`, method blocks, geography provenance, filters, comparison, dimension, selection, geography detail, visitor/visit keys, click IDs and event properties. Page paths, referrer hosts and event names are published exactly as recorded, so a path can carry an identifier and a referrer host can name one of the website's own hosts; the form says so. Revenue events appear only as event counts, never amounts. `coverage.retainedFrom` discloses the instant of the last reset or retention boundary. The decoder refuses undeclared keys, a section present without its grant or missing when granted, a foreign share id, another range, an expired `expiresAt` and payloads over 2 MiB.

## Lifecycle

- Website deletion cascades the grants and their receipts; reads answer 404.
- Member removal (D6): the link stays live, the removed member's management answers 404, the listing marks them as a former member, and a current owner or admin can revoke.
- Reset or retention: later reads show pre-cutoff ranges as partial or unavailable with nulls.
- Restore quarantine (`restore-quarantine`) revokes every live website share.
- The workspace two-factor requirement never blocks the public link.

## Differences from pinned Umami

Umami keeps one generic share table with a plaintext 16-character slug in the path, exchanged for a non-expiring JWT; ten98 stores only the sha256 of a 256-bit fragment secret and rechecks the grant in SQL on every read. Umami shares never expire, accept custom slugs, are edited in place, are hard-deleted, can be created by any member who can update the website and are listed with live slugs to anyone who can view it; ten98 requires an expiry, has no custom slugs, keeps grants immutable (revoke plus create), revokes irreversibly, restricts management to owners and admins, never returns the secret and shows the creator. Umami offers 14 section booleans with a permissive legacy mode, client-side section routing, `allowFilter` defaulting to true, any range in the recipient's time zone, a per-share theme, the live website name and favicon, framing through `ALLOWED_FRAME_URLS`, and no restore or transfer handling. ten98 offers three server-enforced sections projected into a closed DTO (sessions, realtime, performance, compare, breakdown, goals, funnels, journeys, retention, UTM, revenue and attribution are not website-share sections), dates only in UTC, no theme, the owner's label only, `frame-ancestors 'none'`, rate limits, and revokes shares on restore; transfer must revoke them. The overview follows ten98's private overview DTO, so URL/entry/exit/channel tabs, weekly traffic, change badges, expanded views and annotations are not included.

## Checks

- `tests/website-share.test.ts` (in `pnpm test`): hosted link parser and fragment scrub, every section subset's exact projection and absence of private fields, decoder refusals, strict bodies and canonical tokens.
- `tests/website-shares-integration.ts`, CI lane `ten98_website_share_ci`: management authority and receipts, HTTP admission and limits, parity with the member overview per section, forged SQL contexts, a data-closure canary, the lock contract (revoke and member removal finish while a read waits and it then answers 404; identified collection and a retention batch finish while a read waits and it still answers; a reset that commits after a read's epoch read makes that read answer 503; the stall precedes the aggregate's snapshot, so the window inside the aggregate scan rests on the same final comparison by reasoning, not execution; a third concurrent HTTP read answers 503 while two are in flight) and the lifecycle.
- `tests/teams-integration.ts` (D6 links group) and `tests/integration.ts` (SSR headers on `/share/websites/<id>`) in the full web-and-worker integration; `tests/migrations-integration.ts` (CLI 68-to-69 and 69 no-op) in the `ten98_upgrade` lane.
- Opt-in, not in CI: `tests/project-delete-compiled-browser.mjs` on the built server also creates a link from Collection and privacy and opens it in a fresh context carrying the owner's cookies: granted sections only, fragment scrubbed, reads carry only the capability header (no cookie, authorization or referer), 44 px controls, the unavailable alert after revocation, no request after a reload, and zero console errors or policy violations.
