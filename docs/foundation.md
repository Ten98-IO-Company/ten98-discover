# ten98 Discover — foundation quickstart & limitations

> Code and safety contracts retained from [docs/foundation.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/foundation.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/ten98-monitor-foundation-quickstart-and-limitations-implementation-h-f1qEnZxqJA). Qualifications are preserved; this adds no acceptance claim.

> **Status:** internal foundation branch. This is **not** a public V1 or release. Full 81-feature parity remains required. MIT-licensed / free.

Related: [README](../README.md) · [Feature parity](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5) · [Kimi workflow](kimi-workflow.md)

## Navigation and access

Workspace, project and section links survive reload and browser history; they require authentication and current workspace access. With no requested project, the overview opens the first available project without overriding newer navigation or identity verification.

## Browser verification and navigation

Optional runners use the externally supplied `PLAYWRIGHT_MODULE`; URL navigation stores no filter state or form drafts and does not replace the separate public report-share feature.

## Requirements

- Docker with Compose (recommended path; no host Node/pnpm required)
- Native development only: Node 24 and pnpm 11.19.0 (via corepack)

## Stack and migration ownership

The application uses TypeScript with React, TanStack Start/Router, Vite and Nitro on Node 24. PostgreSQL stores application data and pg-boss jobs. The worker holds one dedicated LISTEN connection so job inserts wake it immediately, with a 30 s idle poll as backstop; through a transaction-mode PgBouncer, LISTEN is unavailable and it falls back to the 2 s poll (0.5 s for prompt children). Shared presentation comes from `@ten98/ui`; shared server mechanisms come from `@ten98/runtime`.

JavaScript in `public/` is served directly to websites: the tracker loads the consent-controlled destinations, performance and replay scripts. Standalone `.mjs` files provide Node setup/verification commands and browser/integration test runners. They are entrypoints, not duplicate compiled copies of the TypeScript app. Docker host commands use one POSIX shell procedure; application runtime code has no PowerShell dependency.

`src/server/schema.ts` supplies the authentication tables to Better Auth’s Drizzle adapter. Other features use parameterized PostgreSQL queries through `pg`. `pnpm migrate` applies the ordered SQL files in `migrations/`, verifying their recorded checksums; changing the Drizzle declarations alone does not migrate the database. Keep applied migrations immutable and add a new migration for database changes.

PL/pgSQL is PostgreSQL’s procedural language for database functions and triggers. The prompt-history and execution-link triggers enforce database invariants across insertion/update paths; `rank_next_due` implements calendar scheduling using database timezone rules. They are part of the native SQL migrations. Replacing them with an ORM table declaration would lose that behavior. Drizzle also supports [custom SQL migrations](https://orm.drizzle.team/docs/kit-custom-migrations) for DDL its schema generator does not cover. See [PostgreSQL’s PL/pgSQL documentation](https://www.postgresql.org/docs/current/plpgsql-structure.html).

## Quickstart (Docker)

```sh
sh scripts/deploy.sh local http://localhost:3000 3000 ten98-monitor
# open http://localhost:3000
```

- Follow the [Docker setup guide](docker-setup.md) for the shared POSIX shell procedure (including Windows through WSL2), existing/bundled HTTPS, safe reruns, backups and upgrades. This is a source-built development deployment, not a published release image.
- Setup generates an exclusive private `.env` with independent 32-byte database/auth/bootstrap secrets and an encryption keyring. It refuses to overwrite saved configuration. Native development retains `pnpm run setup:local` (not the `pnpm setup` builtin).
- Docker startup does **not** auto-migrate; the separate `migrate` run is required. `postgres` starts via the migrate service's healthy dependency.
- Compose binds `127.0.0.1:3000` only; the database is never published.
- Read `BOOTSTRAP_TOKEN` privately from `.env` to claim ownership. Never paste it into issues or logs. Choose a 12–128 character password.

## Native host development

The default `.env` `DATABASE_URL` uses the `postgres` Docker hostname (compose injects its own DB URL). For native dev:

1. Point `DATABASE_URL` at your own local PostgreSQL 18.
2. Create `ARTIFACT_DIR`.
3. `pnpm migrate`
4. Start the dev server; it explicitly loads `.env` and uses port 3000:

   ```sh
   pnpm dev
   ```

5. `pnpm worker` in another terminal.

## Two isolated installs on one machine

- Use `docker compose -p <distinct-name>` per checkout.
- Set a different `APP_PORT` **and** `APP_URL` in each checkout's `.env`.
- Keep a private `.env` per checkout.
- Do not add custom external networks or `container_name`.

## Verification

```sh
pnpm test          # bounded input and browser tracker checks
pnpm build
pnpm typecheck
pnpm check:plan
```

Integration test (included in the foundation CI workflow):

```sh
TEN98_INTEGRATION_TEST=1 node --env-file=.env tests/integration.ts
```

- Requires a freshly migrated, unclaimed **local** DB plus running web and worker.
- Refuses non-local DBs and existing users; retains fixtures. **Do not run it against saved user data.**

Upgrade checks are runnable with `TEN98_INTEGRATION_TEST=1 node --env-file=.env tests/migrations-integration.ts` against a **separate empty local test database**, without the web/worker running. The check refuses a populated database, retains its fixtures, and does not restore or erase an operator's data. CI creates that database separately from the normal integration database.

## Diagnostics

```sh
docker compose ps
docker compose exec web node src/server/cli.ts diagnose
docker compose exec worker node src/server/cli.ts diagnose worker
```

- Liveness `/api/health/live` is separate from readiness `/api/health/ready`. Readiness fails on migration version/hash mismatch. Health checks make no paid calls.
- Logs may contain internal errors — do not share credentials from them.
- Migration failure: keep volumes and rerun with a matching image. **Never delete a volume as a "fix".**
- `docker compose down` retains volumes; do not default to `down -v`.

## What works today

- Owner token atomic claim + local sign-in; create, rename and switch workspaces. Account security supports password changes, session revocation, authenticator enrollment and one-use recovery codes.
- [Account closure](account-closure.md): a person closes their own account after step-up (password or fresh identity-provider sign-in, plus a second-factor code when enabled), and an instance operator can close another account with step-up and a recorded reason. Closure tombstones the account and scrubs its credentials, sessions, API keys, links, invitations and personal settings in one transaction; it is refused for the last owner of a workspace and the last instance operator. Workspace data, share links and usage records stay.
- Workspace owners/admins can create and revoke expiring, scoped API keys. Tokens appear once and only their hashes are stored. Current membership and scopes are enforced on every allowed API request. While the workspace requires two-factor authentication, a key whose issuer has no verified factor stops working (it is suspended, not revoked, and resumes when the issuer turns it on).
- Owners can save, rotate and revoke encrypted OpenRouter/DataForSEO credentials, run an explicit read-only account check, set or clear the workspace pause on paid provider work (a manual emergency stop) and inspect the app's usage ledger (quotes, reservations, receipts, reconciliation and monthly usage totals). Manual keyword research, saved-keyword refreshes and prompt comparisons now run through paid adapters; remaining provider routes are still in progress. Saving credentials never starts paid work.
- Team management for owners/admins, role changes and member removal. Owners can grant ownership; concurrent changes cannot remove the final owner. Admins manage editors/viewers only.
- A current owner can transfer their ownership to another existing member from Team settings after typing that member’s email. The browser-only `POST /api/workspaces/:workspaceId/transfer-ownership` takes strict `{targetUserId, confirmationEmail}` JSON. Both roles change in one workspace-locked transaction: the recipient becomes owner, the sender becomes admin, and other owners stay unchanged. The sender’s pending admin invitations are revoked. Cross-workspace recipients, self-transfer, stale membership/authority and mismatched confirmation are refused; an unknown browser outcome requires refreshing saved roles before retrying.
- Revocable seven-day invitation links for new and existing local accounts. Only token hashes are stored; links are displayed once for manual sharing, and when an email transport is configured the invitation is also emailed once (no retry) with fixed text that names only the installation URL, the role and the link, never the workspace or inviter, at most twenty invitation emails per installation and three per normalised address string per minute (plus-tag or dot variants of one mailbox count as distinct strings, so the installation budget is the bound). A failed or limited send answers `email: 'failed'` and never undoes the invitation; `accepted` means the provider accepted the message, not that it was delivered. Existing accounts must sign in with the invited email; accepting a link never resets their password or changes an existing membership's role. Removing/demoting an inviter invalidates grants they can no longer issue.
- Project origin and public site key.
- Page-load and SPA pathname tracking under cookieless basic or consent-first policy, plus `window.ten98.track('signup')` after the script loads with bounded typed properties. Event names are 1–64 characters, start with a letter and use letters, digits, underscores, periods, colons or hyphens. Keep personal information out of event names and properties. Optional referrer hostname, screen and UTM metadata (plus ad click identifiers after the analytics grant) is configurable; language is normalized. Query strings and fragments are stripped apart from those allowlisted values; raw IP and user-agent data is not stored.
- Analytics for inclusive UTC date ranges up to 366 days: page views, custom-event counts, daily chart/table and the top 20 pages/event names, plus visitor, visit, bounce and duration estimates where native identity coverage is available. Unknown estimates are reported as unavailable, not zero. Counts are stored observations.
- An overview **Top referrers** card: the top 20 external referrer hosts, ranked by estimated visitors then page views, where selecting a host filters every report by that referrer (see the [measurement contract](analytics-measurement.md#collection-and-privacy)).
- CORS origin matching (public signals remain spoofable) and duplicate-event UUID dedup.
- Jobs: internal free worker probe; durable Postgres queue with idempotency, transaction rollback, revoked-permission handling and failed-terminal reconcile, now also executing Google imports, manual keyword and prompt requests, redirect checks and static audits. Paid requests require an explicit quote and start; dispatched paid calls have no automatic resend. Worker startup can resume previously authorized queued work; it does not resend a dispatched paid call.

- Migrations: transaction + advisory lock + ordered, normalized checksums. Existing `0001` installations upgrade through the included ordered migrations; unknown, altered or incomplete history is rejected.

## Invitation and analytics safeguards

The copy link is always shown, also when the invitation was emailed. The link can create a new local account, so treat it like a temporary credential; mailbox verification is not claimed, because an emailed link is also held by the inviter.

The fragment token is removed from the address bar and kept only in memory; re-open the original link if the page is refreshed before joining.

The chart and tables use server receipt dates in UTC. Query/hash-only navigation does not create a new page view.

## Use the team and analytics flows

For an existing development install, back up its database and stop web/worker before upgrading. Build the new image, run `docker compose run --rm migrate`, then start web/worker again. Repeat migrations are safe. The old application image cannot serve the upgraded schema; rolling back requires the matching pre-upgrade database backup.

## Current limitations

- Not a public V1/release. No published Docker image — build locally.
- The optional Caddy recipe has local proxy/configuration checks; public certificate issuance is not yet verified. A host-local tracker snippet only works for another local origin; remote visitors cannot reach a localhost collector until a proper HTTPS deployment exists.

- Identity coverage and visit semantics remain limited as documented below; bot filtering and advanced reports / full analytics parity remain unfinished. Workspace retention is implemented for native analytics, Google import snapshots, normalized keyword results, generated prompt answers and copied execution input. The [session replay backend](session-replay.md) is source-prepared with unregistered migration55; its recorder/player and runtime acceptance remain pending.
- No workspace deletion yet. Email password recovery and invitation email (when an email transport is configured), local authenticator/recovery-code and generic OIDC flows and website (project) deletion are implemented; invitations always also return a manually shared link.
- SPA tracking observes pathname changes; hash-based routes and identity-link workflows are not implemented yet. Automatic `data-ten98-event` HTML attributes, native bounded typed event properties, optional referrer metadata and estimated visitor/visit identity are implemented. The tag loader accepts only its bounded canonical properties, distinct from native typed properties. The custom-event API does not buffer calls made before the script loads.

- Secrets in compose env are plaintext, not encrypted. The backend supports `_FILE` for `AUTH_SECRET` / `BOOTSTRAP_TOKEN` / `DATABASE_URL` (exclusive with direct values), but the current recipe uses `.env`. No production secrets manager is claimed.
- Worker status refresh is manual; no global auto-poll.
- Nitro 3.0.260903-beta is a prerelease; the production gate is pending. Optional Cloudflare features are not built.

## Account, API-key and provider controls

Choose **Account security** to change your password, review sessions or enable an authenticator. Enrollment becomes active only after a valid six-digit code. Save recovery codes when shown: each works once, and generating replacements invalidates the previous set. Security changes revoke other sessions and pending challenges. A partially authenticated sign-in cannot access workspace data.

A workspace owner can require two-factor authentication for the whole workspace under **Two-factor requirement** in Team settings (browser-only `POST /api/workspaces/:workspaceId/two-factor` with strict `{required}` JSON); turning it on is refused until the owner's own authenticator is enabled. While it is on, a member without an enabled authenticator gets 403 on that workspace's data and on its websites, including the owner who set it; their membership, role and invitations are unchanged and other workspaces are unaffected. Account security, the Identity sign-in proof for accounts without a local password, sign-in, sign-out, invitations and creating a new workspace stay reachable, so the member can enrol and then retry. Disabling one's own authenticator locks that member out of the workspace again. API keys and MCP sessions they issued are refused with the generic invalid-key answer until they enrol. Public board, tracked-asset, [website](website-shares.md) and report share links keep working (a restore quarantine revokes the website and tracked-asset links), and work already queued or approved (scheduled rank checks, recurring prompts, site audits, Google imports) keeps running. Only the app's own authenticator counts; an identity provider's multi-factor sign-in does not. The cookie check runs once per request: a request already admitted when the requirement is turned on, or when a member turns off their authenticator, can still finish.

**Close account** at the end of Account security closes the account permanently; see the [account closure contract](account-closure.md) for what is deleted, scrubbed and kept, the step-up proof, the operator API and CLI path and the last-owner rule.

Choose **API keys** as a workspace owner or administrator. Select only the required scopes and an expiry from 1–365 days (90 by default). Copy the token once. Supported bearer routes currently are:

| Scope | Routes |
|---|---|
| `projects:read` | `GET /api/workspaces/:workspaceId/projects` |
| `projects:write` | `POST /api/workspaces/:workspaceId/projects` |
| `analytics:read` | Fourteen `GET /api/projects/:projectId/…` readers: `events`, `analytics`, `realtime`, `performance`, `journeys`, `attribution`, `retention-report`, `revenue`, `revenue/sessions`, `revenue/sessions/:visitorKey`, `explore`, `sessions`, `sessions/:visitorKey`, `sessions/:visitorKey/linked-activity` |
| `events:write` | `POST /api/projects/:projectId/events` with `{eventId,name,url,properties?,dimensions?}`; server observations never claim browser identity |
| `team:read` | `GET /api/workspaces/:workspaceId/team` |
| `prompts:read` | List/search/read authored prompts and their text versions |
| `prompts:write` | Atomic 1–100 prompt creation, update, archive and restore |
| `context:read` | `GET /api/projects/:projectId/context`, `GET /api/projects/:projectId/context/research-log` |
| `context:write` | `POST /api/projects/:projectId/context/update`; one atomic batch of 1–50 operations at the current revision |
| `segments:read` | `GET /api/projects/:projectId/segments`, `…/segments/:segmentId`, `…/cohorts`, `…/cohorts/:cohortId` |
| `annotations:read` | `GET /api/projects/:projectId/annotations`, `…/annotations/timeline`, `…/annotations/:annotationId` |
| `rank:read` | `GET /api/projects/:projectId/rank-trackers`, `…/rank-trackers/:trackerId`, `…/distribution`, `…/matrix`, `…/runs` (without ledger amounts or diagnostics), `…/results` and `…/keywords/:keywordId/history` (without diagnostics); no catalog, locations, schedule, check detail, keyword change or export |
| `keywords:read` | `POST /api/projects/:projectId/saved-keywords/list` and `…/saved-keywords/tags/list`; no save, tag, removal, export or refresh |
| `google:read` | `GET /api/projects/:projectId/google` (without the instance app configuration) and `…/google/imports/:importId`; no app setup, connect, property, disconnect, import or inspection |
| `domains:read` | `GET /api/projects/:projectId/domains` (stored rows only) and `…/domains/:domainId/redirect-checks`; current owner/admin only; no registry write or check start |
| `audits:read` | `GET /api/projects/:projectId/audits`, `…/audits/:runId` and `…/audits/:runId/issues`; a read records due retention expiry exactly as a member read; no setup, pages, page detail, links, export, start, cancel or delete |

Send exactly one `Authorization: Bearer <token>` header without cookies or alternate API-key headers. Tokens cannot manage authentication, credentials, provider connections, the paid-work pause or other keys. Removing membership deletes its keys; rejoining does not revive them. The [native API contract](native-api.md) documents the public static OpenAPI document, complete supported bearer inventory and existing atomic prompt and context batches. Site audits are admitted for reads only (history, run detail and issues under `audits:read`, in both the bearer and MCP inventories). Compatibility access remains outstanding.

Choose **AI and search providers** as a workspace owner. A saved connection starts **untested**. **Run check** contacts only the provider's documented read-only account endpoint: [OpenRouter current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) or [DataForSEO user data](https://docs.dataforseo.com/v3/appendix-user-data/). Acceptance of credentials does not prove paid endpoint permissions or sufficient credit. Diagnostics never display the provider's response body or submitted credentials.

New workspaces start with paid provider work unpaused. Existing workspaces keep their pause state through migration 0063, which turns the old implicit pause (no saved setting) into an explicit one, so a workspace paused before owner decision D3, automatically or manually, stays paused until an owner clears it. The owner pause is the only switch: a manual emergency stop that refuses new reservations and queued dispatches; its endpoint accepts a pause-only body. Amounts use integer USD micro-units (six decimal places). There is no per-connection or workspace money limit (owner decision D3); budgets and wallets are managed at the providers. The ledger covers this app's requests, not spending elsewhere on the provider account. Concurrent reservations share a workspace lock; retries cannot enqueue or dispatch the same request twice. Outstanding reservations stay in the current month's reserved usage until settled. An unknown charge blocks new paid work, even while the workspace is unpaused, until an owner reconciles the original request; nothing pauses automatically. Owners can cancel undispatched reservations, including work whose initiating member has been removed.

The internal settlement contract returns `reconciliationRequired` for unknown charges or reported amounts above the current $1M per-charge ledger limit. Such rows stay uncertain and preserve their provider reference. Execution adapters must retain the exact reported amount/evidence with their job result and inspect this outcome before marking work complete. There is no automatic retry of a dispatched paid call.

A provider wallet, credit or budget refusal is a known US$0 outcome, not an unknown charge (owner decision D3). Only a response that unambiguously says the provider refused before doing any work counts. OpenRouter: HTTP 402, or HTTP 403 whose `error.metadata.limit_source` is `openrouter_key_limit`, `openrouter_guardrail_budget` or `openrouter_workspace_budget`, with a numeric `error.code` equal to the HTTP status, no `x-generation-id` header and no `id`, `usage` or `choices` in the body ([errors](https://openrouter.ai/docs/api-reference/errors), checked 2026-10-18). DataForSEO: a paid response with HTTP 200 or 402 whose response cost and every task cost are an explicit numeric 0, carrying 40200 or 40210 (balance too low) or 40203 (daily cost limit) at response level with any tasks of the same kind, or on every task of a 20000 response, or HTTP 402 with no tasks and a status code that is absent or 402 ([errors appendix](https://docs.dataforseo.com/v3/appendix-errors/), checked 2026-10-18). The request then fails, its dispatched reservation settles as a US$0.000000 receipt, and the run shows a fixed message naming the provider and its balance or limit; the provider's own message text is never shown. Nothing becomes uncertain or pauses, so siblings and other paid work continue; there is no automatic retry, and a new attempt needs a new quote. Every other response stays on the uncertain path, including a missing cost, mixed task codes, 40201 (account paused), 40202 and 40209 (rate limits), 40204 (subscription), any other HTTP 402 status code, any other OpenRouter 403 and a non-JSON body.

### Encryption keys and upgrades

New installs generate `CREDENTIAL_KEYS` (JSON mapping version names to base64 32-byte keys) and `CREDENTIAL_ACTIVE_KEY`. Existing installations need an operator-generated keyring before saving credentials. The native process also accepts an exclusive `CREDENTIAL_KEYS_FILE` alternative; a Compose secret-file recipe must explicitly mount that file. The default Compose recipe passes the keyring from the private `.env`.

Stored credentials bind encryption to the workspace, connection, provider and revision. Missing keys or invalid authenticated ciphertext fail readiness and worker startup; diagnostics make no provider calls. Protect and back up the keyring separately with access sufficient to restore the matching database. Environment variables are visible to host/container administrators; database encryption does not hide secrets from those administrators.

To rotate encryption keys, stop all web and worker writers, add the new key while retaining old entries, choose it as active, and run `docker compose run --rm web node src/server/cli.ts rekey`. Recreate every web/worker process with the same updated configuration before accepting writes. Keep old keys for every retained backup that needs them. Provider, OIDC, Google reporting and provider-account recovery records rotate in separate transactions: a failure rolls back its own family, and rerunning safely resumes the others. Keep both keys until the whole command succeeds and readiness passes. An old process still using the old active key can otherwise write old-key ciphertext after rotation.

Migration `0022` preserves existing DataForSEO account fingerprints while separating new fingerprints from the login secret. Existing keyword quotes require the matching vault keyring and original `AUTH_SECRET` during this upgrade. After capture, changing the login secret does not break charge reconciliation. Review [provider account identity and upgrades](saved-keywords.md#provider-account-identity-and-upgrades) before migration; already-lost legacy secrets cannot be recovered from a fingerprint.

The owner approved configurable retention defaults: raw analytics 90 days, replays 7 days, raw provider evidence 90 days and derived history 1 year. Workspace retention controls and the bounded worker are active for implemented data types; see [retention](retention.md) for exclusions and execution limits. No history migration from the three replaced apps is required; native provider report imports and this app's backup/export remain included. Shared reports use revocable slugs under `APP_URL`, without separate per-client domain provisioning.

## Identity provider setup and recovery

Open **Identity sign-in**. Instance operators configure the provider's issuer, client ID, client authentication method and allowed endpoint origins. Register the callback URL displayed by the app with the identity provider. Save a draft, authenticate with that provider to test it, then enable the tested revision. A failed test leaves the previously enabled settings in service. Public PKCE clients use POST authentication with an empty secret; confidential clients use their configured secret.

Workspace ownership does not grant instance administration. A newly claimed instance grants its first owner that separate role. On an upgraded installation, an operator with host access can grant it to an existing account:

```sh
docker compose run --rm web node src/server/cli.ts operator grant owner@example.com
```

Use `operator revoke` with the same email argument to remove it. These changes are audited. Endpoint requests are HTTPS, DNS pinned and restricted to the configured origins; private-address exceptions require explicit operator configuration. The local HTTP issuer used by tests is available only with the integration-test opt-in.

Accounts link by the exact issuer and subject after explicit proof; matching email alone never merges accounts. An invitation can create an OIDC-only account without requiring a second password. Such an account can use fresh provider verification to add an optional local recovery password, enroll an authenticator or change recovery codes. Once enabled, app two-factor verification also applies to OIDC sign-in. Disabling a provider revokes its sessions and pending challenges; users with no other sign-in method lose access. Configure independent recovery before disabling the last method.

Generic protocol, invitation, linking, revocation, fresh-verification and sign-out flows are covered by a signed local issuer fixture shaped like Authentik (`tests/oidc-integration.ts`, run inside the web-and-worker integration). By the owner's decision D7 (2026-10-17) a generic provider such as Authentik must work end to end; claim or group mapping to workspace membership and Umami token sign-in are not part of V1. Workspace-enforced identity policies remain open. Fixture success is not vendor certification: no live Authentik instance has been exercised.

### Authentik

The fixture models Authentik 2025.10 in its default per-application issuer mode: its discovery document, JWKS with `x5c`/`x5t` members, hashed-ID subjects, the email and profile scope claims including `groups`, and its end-session rules. Configure the two sides as follows.

- **Provider.** Create an OAuth2/OpenID provider and its application. Register the callback URL the app displays as a strict redirect URI. Confidential clients use Basic or form-body authentication with the client secret; public clients use form-body authentication with an empty secret.
- **Signing key.** Select a signing key. Without one, Authentik signs with HS256 and the client secret and advertises only HS256, which the app refuses: it accepts RS256, PS256 and ES256 ID tokens.
- **Issuer.** Enter the issuer exactly as Authentik shows it, `https://<host>/application/o/<slug>/`, trailing slash included. Discovery must return the same issuer, so a value without the slash fails the test. The global authorize and token endpoints share the issuer's origin, so no extra approved origin is needed.
- **Claims.** The app requests `openid email profile` with S256 PKCE, a nonce and `prompt=login`, and reads claims from the ID token only, never from the userinfo endpoint. Keep Authentik's option to include claims in the ID token enabled. The app uses `sub`, `email`, `email_verified`, `name` and `auth_time`; `preferred_username`, `groups` and other claims are ignored and grant no role or workspace.
- **Verified email.** From 2025.10 Authentik sends `email_verified: false` unless the operator configures verification. Invitation sign-in needs **Trust verified email** in the app and `email_verified: true` from the provider; otherwise invited users accept with a local password and link the identity from account settings.
- **Sign-out.** When the **Sign out** button ends a session that is still bound to an enabled provider, the app ends its own session and sends the browser to the provider's advertised `end_session_endpoint` with `client_id` only. Authentik then redirects into the provider's invalidation flow and shows its own signed-out page. The app keeps no ID token, so it sends no `id_token_hint` and no `post_logout_redirect_uri`; Authentik honours a return address only with the hint. If the provider lookup fails, sign-out still ends the local session.
- **Sign-out exceptions.** These never redirect to the provider: local password sessions; a session rebound to local sign-in after an OIDC-only account adds a recovery password; revoking the current session from account security; and the sign-out that precedes accepting an invitation. Discovery ignores an end-session endpoint outside the approved HTTPS origins instead of refusing the provider. A provider enabled before this change gains provider sign-out only after it is tested and enabled again, because discovery reads the end-session endpoint, and enabling again revokes all of that provider's current sessions. Leave Authentik's front-channel and back-channel logout URI empty: the app does not implement those flows.

## Browser destinations

Select a project and **Destinations**. Choose **Live** or **Test**, add public asset IDs, choose supported event mappings and declare whether ten98 or an existing integration owns each tag. Save, run a dry preview, then publish. An ownership confirmation is required before managed tags can publish. Preview makes no vendor requests. Concurrent drafts reject stale versions; rollback creates a new immutable revision and consent epoch.

The existing header snippet loads `/destinations.js` once. Published configuration contains public asset IDs and mappings only; report credentials remain separate. The loader supports Meta, GA4, Google Ads, Cloudflare Web Analytics, TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X. It shares Google's SDK, refuses detected foreign SDK ownership, limits readiness queues, discards events observed before consent, and reports SDK invocation rather than inventing a delivery receipt. Cloudflare owns its own page observations and has no custom-event mapping.

Use `data-environment="test"` on the snippet to select the test configuration and suppress native analytics writes. Test assets can still send real traffic to vendors when consent is granted: this is separate configuration, not a vendor sandbox. Without that attribute, the snippet uses live configuration. This increment allows one asset per vendor and eight canonical event names; complete upstream event coverage and multi-asset ownership remain open.

The browser API uses an explicit context, for example `{siteKey: 'PROJECT_PUBLIC_KEY', environment: 'live'}`. Check `window.ten98?.destinationStatus(context).ready` before opening `window.ten98.consentPreferences(context)` from a visitor action. The `ten98:destinations-ready` event signals validated configuration; the panel includes a working preferences-button example. A CMP can call `window.ten98.consent({analytics, advertising, adUserData, adPersonalization}, {...context, acknowledgeReload: true})` after displaying the reload/storage-failure warning. All four choices must be booleans. Unknown consent, GPC and DNT prevent vendor loading. No previous page event is replayed when a visitor first grants consent. Saved consent expires 180 days after the explicit choice; revisits do not extend it.

Loaded vendor SDKs can perform their own observations. A saved withdrawal reloads the page because clearing this app's queue cannot stop arbitrary loaded code. If storage cannot save or erase consent, the loader instead navigates to a blank page to leave the running SDKs; clear site data before returning. If the browser blocks navigation, the visitor must close the page. The preference flow warns about unsaved work before granting consent. Configuration is valid for 60 seconds and refreshed every 30 seconds; expiry or a changed published revision stops routing and requires renewed consent/reload. Already transmitted data and requests in flight cannot be retracted. CSP, blockers, browser storage failures and provider settings require controlled acceptance checks before a V1 claim. Native collection now shares this consent gate and honors DNT/GPC, collection disablement and path exclusions; broader P31 retention and bot/IP controls remain unfinished.

## Native collection and measurement

Open a project and **Collection and privacy**. Owners/admins can enable native collection, choose the built-in preferences button or an existing consent platform, configure optional referrer hostname, UTM and ad click-ID, and screen capture and exclude path prefixes. Other members can inspect the saved settings. A save invalidates prior consent; a conflicting save preserves the draft and asks the user to reload. The same consent epoch also changes when destination policy changes.

Upgrade note for migration `0065`: with campaign capture on, an analytics grant now also covers the six raw ad click identifiers used for [Paid ads attribution](attribution.md#source-and-remaining-requirements). The migration rotates the consent epoch of every project with campaign capture on, so built-in notices ask visitors again (replay grants and visit contexts of those projects reset once too). A site using an existing consent platform is not re-prompted by ten98: before upgrading it with campaign capture on, update that platform's analytics disclosure to cover ad click identifiers and re-collect consent, or turn campaign capture off.

New projects default to enabled **cookieless basic analytics**, with optional metadata disabled. Existing projects preserve their settings; a missing mode means consent-first. Owners/admins can choose either mode. Basic collection requires a current cookieless policy and stops on explicit refusal, DNT/GPC, exclusion or disablement. Identify and vendor tracking still require explicit grants. A fresh grant may record an unobserved current page, but never replays earlier activity or recounts a dispatched basic pageview. Analytics context and identity stay in memory; preferences persist in browser storage. Separately consented session replay is authorized to keep a short-lived per-tab upload capability in sessionStorage for same-origin navigation; its producer remains pending and must not persist raw DOM queues. Caller-supplied properties must avoid personal data. See the [measurement contract](analytics-measurement.md#collection-and-privacy) for envelope, namespace, opt-out and unknown-capture-coverage semantics and the [replay contract](session-replay.md) for its separate opt-in and content boundaries.

`ANALYTICS_NETWORK_MODE=off` is the default: event/page counts work and visitor/visit estimates remain unavailable. `direct` uses the actual Node socket peer; `proxy` additionally requires an explicit `ANALYTICS_TRUSTED_PROXIES` IP/CIDR allowlist and a correctly configured forwarding chain. Client forwarding headers never substitute for a missing transport peer. Do not choose direct mode behind a shared proxy. Native production-server direct mode is covered by the integration test; a particular reverse-proxy deployment needs its own verification. `ANALYTICS_EXCLUDED_IPS` excludes matching resolved addresses installation-wide in direct or proxy mode and is refused with `off` (see the [network boundary](analytics-measurement.md#network-boundary)).

IP, User-Agent and explicit distinct ID are inputs to a project-specific keyed hash, never raw event columns. Monthly visitor rotation and hourly visit keys with a bounded browser context follow the documented [measurement contract](analytics-measurement.md). Overview cards show measured pageview coverage, preserve unavailable values and explain visit/bounce/duration semantics. Overview dates use UTC. The [Explore screen](explorer.md) adds named calendar timezones, exact filters, typed property breakdowns and a bounded CSV snapshot. Advanced reports, realtime/comparisons, identity links and remaining dimensions are still required for V1.

## Reports and domain records

Choose **Reports** from a project's navigation to author static HTML, edit template briefs, preview saved reports and create immutable shared snapshots. Source stays private; preview and public sharing render a static allowlist under an opaque browser sandbox. Scripts, navigation, forms and external resources cannot execute. Sharing returns the complete `APP_URL/share/<slug>-<random-token>` URL once, stores only its digest and supports expiry/revocation. Editing a report does not alter an existing snapshot. Deleting a report revokes its shares. Editors can author reports; only owners/admins can create/revoke shares. Conflicting revisions preserve the draft until an explicit reload. AI report generation remains separate unfinished work.

Choose **Domains** as an owner or administrator to record the canonical hostname, additional serving domains and redirect aliases with an expected destination. Ownership proof uses a short-lived exact-host DNS TXT challenge; only its digest is stored. Reissuing or revoking invalidates the earlier proof, and verification rechecks permission after the DNS response. Verified, unrevoked **serving** domains can use the same snippet at their exact HTTPS origin on port 443. Redirect aliases never authorize collection. The canonical project origin remains allowed exactly as configured. See [serving-domain collection](serving-domains.md) for consent changes, source provenance and remaining redirect work.

Verified redirect aliases also offer [manual HTTP redirect checks](domain-redirects.md), with pinned public-address transport, current-authority/configuration rechecks, immutable receipts and raw-evidence expiry. Migration `0018` is additive after `0017`. Synthetic database, upgrade and production browser checks cover lost acknowledgements, stale configuration, role changes and sanitized evidence. This observes HTTP redirects only; schedules, redirect counts/log imports, JavaScript/meta behavior and backlink consolidation remain unfinished.

## Graceful shutdown

A real web shutdown failure was fixed: a Nitro close hook now awaits the actual queue resources and then database pools, including across the separate SSR/runtime bundles.
