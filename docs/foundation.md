# ten98-monitor — foundation quickstart & limitations

> **Status:** internal foundation branch. This is **not** a public V1 or release. Full 81-feature parity remains required. MIT-licensed / free.

Related: [README](../README.md) · [Feature parity](parity.md) · [Kimi workflow](kimi-workflow.md)

The [interface refresh](interface.md) groups measurement, research and connection pages under the selected project, with workspace tools in a separate menu. **Context** and **Prompts** store project knowledge and immutable prompt text history; neither starts provider work. On narrow screens, choose **Menu** to navigate. **Install tracker** contains the snippet and collapsed worker diagnostics; **Recent events** contains received observations. Workspace, project and section links survive reload and browser history; they require authentication and current workspace access. With no requested project, the overview opens the first available project without overriding newer navigation or identity verification.

The refreshed production UI passed independent Edge checks at desktop and 360px widths: consent/privacy flows, known/unavailable metrics, report editing/sharing, stale responses, permissions, keyboard menu operation, focus transfer and delayed initial-project loading. No fake measurements were added. Existing database accounts and projects are preserved.

The navigation increment passed TypeScript, production build, 144 unit checks (two platform-specific skips) and 12 focused production Edge groups against a separate local database. Checks cover reload/history/new tabs, malformed and foreign targets, removal of unknown query keys, failed-list retry, delayed workspace and creation responses, returning to an earlier URL, session changes, callback priority, factor cancellation and capability removal. The existing Google, native analytics, retention, Explorer, context/prompt and isolated report-sharing browser runners also passed sequentially with real local API/database behavior. Google endpoints and authorization were synthetic fixtures; no live provider calls or public deployment are claimed. Optional runners use the externally supplied `PLAYWRIGHT_MODULE`; URL navigation stores no filter state or form drafts and does not replace the separate public report-share feature.

## Requirements

- Docker with Compose (recommended path; no host Node/pnpm required)
- Native development only: Node 24 and pnpm 11.19.0 (via corepack)

## Quickstart (Docker)

```sh
sh scripts/deploy.sh local http://localhost:3000 3000 ten98-monitor
# open http://localhost:3000
```

- Follow the [Docker setup guide](docker-setup.md) for native Windows commands, existing/bundled HTTPS, safe reruns, backups and upgrades. This is a source-built development deployment, not a published release image.
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

Observed integration coverage (independent GPT run): schema mismatch restore, owner concurrency/rollback, roles/tenant boundary, CORS/URL privacy/idempotence, worker completion/queue rollback/revoked permissions, failed job reconciliation, logout; plus invitation signup/session cookies, existing-account protection, token replacement/revocation/expiry, concurrent acceptance, concurrent last-owner changes, delayed-body permission revocation, and date-filtered analytics fixtures.

Verified locally on 2026-10-12:

| Check | Observed result |
|---|---|
| Node 24 build, TypeScript, unit tests | Passed; 15 input-validation and actual tracker checks |
| Real PostgreSQL web/worker integration | Passed the authorization, transaction, privacy and lifecycle cases above |
| Docker Desktop / Linux amd64 | Image built; PostgreSQL, web and worker healthy; artifact storage writable; initial and repeat migration passed |
| Browser / installed Microsoft Edge | Owner setup, form labels/keyboard access, login/logout, project creation, snippet, real tracker requests and persisted counts passed |
| Tracker browser privacy | Two embeds produced one event per page load; requests omitted credentials, cookies, query strings and fragments |
| Worker and responsive UI | Queued check completed; desktop 1360 px and mobile 360 px layouts passed without page overflow |
| Planning and dependencies | All 81 V1 rows retained; production and full dependency audits reported no known advisories at check time |
| Kimi runner | Offline process/timeout checks and a real bounded Skill-only K3 smoke task passed |

The independent browser check used synthetic accounts and a local fixture website; it does not verify provider integrations. Base images are pinned to the tested digests. ARM, public HTTPS, backup restoration and production load testing remain outstanding. Hosted CI results are linked from the pull request rather than inferred from local runs.

Screenshots from the completed browser check: [desktop](screenshots/foundation-desktop.png) · [mobile](screenshots/foundation-mobile.png).

Workspace and analytics increment verified locally on 2026-10-13 (Asia/Dubai):

| Check | Observed result |
|---|---|
| Build, TypeScript and unit tests | Passed; 32 tests across validation, date semantics and actual tracker code |
| Real PostgreSQL web/worker integration | Passed the foundation cases and new team/invitation/analytics cases above |
| Original-install upgrade | Original `0001` SQL unchanged; existing account credentials, membership, project, event and job data preserved through `0002`/`0003`; repeat migration passed |
| Migration failure and history | Injected failure rolled back both pending migrations; changed, future and incomplete history rejected |
| Docker Desktop / Linux amd64 | Final image built; fresh migrations applied; PostgreSQL, web and worker healthy |
| Real browser tracking and reports | Two embeds, SPA navigation and manual custom event produced three stored events; credentials, cookies, referrer, query and fragment absent from collector requests; date filters and zero-data view passed |
| Browser team flows | Create/rename workspaces, new/existing-account invitations, expired-session sign-in recovery, roles, last-owner protection, revocation, removal and login persistence passed; desktop 1360 px and mobile 360 px checked, including readable role controls in the horizontally scrollable member table |
| Scope and dependencies | All 81 V1 rows retained; no new application dependencies |

Upgrade checks are runnable with `TEN98_INTEGRATION_TEST=1 node --env-file=.env tests/migrations-integration.ts` against a **separate empty local test database**, without the web/worker running. The check refuses a populated database, retains its fixtures, and does not restore or erase an operator's data. CI creates that database separately from the normal integration database.

Current screenshots: [analytics desktop](screenshots/analytics-desktop.png) · [analytics mobile](screenshots/analytics-mobile.png) · [team desktop](screenshots/team-desktop.png) · [team mobile](screenshots/team-mobile.png).

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
- Workspace owners/admins can create and revoke expiring, scoped API keys. Tokens appear once and only their hashes are stored. Current membership and scopes are enforced on every allowed API request.
- Owners can save, rotate and revoke encrypted OpenRouter/DataForSEO credentials, run an explicit read-only account check, set workspace/connection budgets, and inspect the app's spending ledger. Paid execution adapters are still being built; saving credentials does not start work.
- Team management for owners/admins, role changes and member removal. Owners can grant ownership; concurrent changes cannot remove the final owner. Admins manage editors/viewers only.
- Revocable seven-day invitation links for new and existing local accounts. Only token hashes are stored; links are displayed once for manual sharing. Existing accounts must sign in with the invited email; accepting a link never resets their password or changes an existing membership's role. Removing/demoting an inviter invalidates grants they can no longer issue.
- Project origin and public site key.
- Page-load and SPA pathname tracking, plus `window.ten98.track('signup')` after the script loads. Event names are 1–64 characters, start with a letter and use letters, digits, underscores, periods, colons or hyphens. Keep personal information out of event names. Query strings and fragments are stripped; no event properties, IP or user-agent data is stored.
- Analytics for inclusive UTC date ranges up to 366 days: page views, custom-event counts, daily chart/table and the top 20 pages/event names. Counts are stored observations, not unique visitors or sessions.
- CORS origin matching (public signals remain spoofable) and duplicate-event UUID dedup.
- Jobs: internal free worker probe; durable Postgres queue with idempotency, transaction rollback, revoked-permission handling, failed-terminal reconcile.
- Migrations: transaction + advisory lock + ordered, normalized checksums. Existing `0001` installations upgrade through the included ordered migrations; unknown, altered or incomplete history is rejected.

## Use the team and analytics flows

1. Choose **Create workspace** to separate a team's projects and membership. The workspace selector switches between your memberships.
2. Choose **Manage team**, enter an email and role, then copy the invitation link and share it privately. No email is sent automatically. The link can create a new local account, so treat it like a temporary credential; mailbox verification is not claimed.
3. A recipient opens the link, creates a local account or signs in with their existing invited email, then joins. The fragment token is removed from the address bar and kept only in memory; re-open the original link if the page is refreshed before joining.
4. Select a project to view **Analytics**. Choose a preset or custom dates, then **Apply** to refresh. The chart and tables use server receipt dates in UTC. Query/hash-only navigation does not create a new page view.

For an existing development install, back up its database and stop web/worker before upgrading. Build the new image, run `docker compose run --rm migrate`, then start web/worker again. Repeat migrations are safe. The old application image cannot serve the upgraded schema; rolling back requires the matching pre-upgrade database backup. General backup/restore automation remains unimplemented.

## Current limitations

- Not a public V1/release. No published Docker image — build locally.
- The optional Caddy recipe has local proxy/configuration checks; public certificate issuance is not yet verified. A host-local tracker snippet only works for another local origin; remote visitors cannot reach a localhost collector until a proper HTTPS deployment exists.
- Native Search Console and GA4 report imports are available with bounded snapshots and synthetic acceptance; see [Google reporting setup](google-reports.md). Other platform imports, SEO and AI visibility are unfinished. The browser loader implements ten tag adapters with synthetic checks; real vendor-account validation remains a release gate.
- Identity coverage and visit semantics remain limited as documented below; bot filtering and advanced reports / full analytics parity remain unfinished. Workspace retention is implemented for native analytics, Google import snapshots, normalized keyword results, generated prompt answers and copied execution input. Replay storage remains unimplemented.
- No email password recovery, workspace-wide identity/2FA enforcement, automatic invitation email delivery or project/workspace deletion yet. Local authenticator/recovery-code and generic OIDC flows are implemented; invitations currently support manually shared links.
- SPA tracking observes pathname changes; hash-based routes, native event properties, HTML event attributes, referrers and visitor/session identity are not implemented yet. The tag loader accepts only its bounded canonical properties. The custom-event API does not buffer calls made before the script loads.
- No SaaS billing.
- Secrets in compose env are plaintext, not encrypted. The backend supports `_FILE` for `AUTH_SECRET` / `BOOTSTRAP_TOKEN` / `DATABASE_URL` (exclusive with direct values), but the current recipe uses `.env`. No production secrets manager is claimed.
- Worker status refresh is manual; no global auto-poll.
- Nitro 3.0.260903-beta is a prerelease; the production gate is pending. Optional Cloudflare features are not built.

## Work process

- Kimi 2.1.1 acts as skill-only drafter on prompt-supplied public files; GPT owns architecture, security, design, and tests.
- Maximum K3 effort was requested with a fixed model alias; K3 HighSpeed is not available, and older K2.7 HighSpeed was not used.
- Swarm uses independent file ownership: the first batch covered UI/packaging/validation, and the next covered team UI, analytics UI and tracker behavior. Review repairs are mandatory; actual durations and skills are recorded in the [Kimi ledger](kimi-workflow.md).
- The existing native CLI uses individual OAuth and is not embedded in the app.
- No quota/savings counts verified.

## Account, API-key and provider controls

Choose **Account security** to change your password, review sessions or enable an authenticator. Enrollment becomes active only after a valid six-digit code. Save recovery codes when shown: each works once, and generating replacements invalidates the previous set. Security changes revoke other sessions and pending challenges. A partially authenticated sign-in cannot access workspace data. Email recovery and workspace enforcement remain separate V1 work.

Choose **API keys** as a workspace owner or administrator. Select only the required scopes and an expiry from 1–365 days (90 by default). Copy the token once. Supported bearer routes currently are:

| Scope | Routes |
|---|---|
| `projects:read` | `GET /api/workspaces/:workspaceId/projects` |
| `projects:write` | `POST /api/workspaces/:workspaceId/projects` |
| `analytics:read` | `GET /api/projects/:projectId/analytics`, `GET /api/projects/:projectId/events` |
| `events:write` | `POST /api/projects/:projectId/events` with `{eventId,name,url,properties?,dimensions?}`; server observations never claim browser identity |
| `team:read` | `GET /api/workspaces/:workspaceId/team` |

Send exactly one `Authorization: Bearer <token>` header without cookies or alternate API-key headers. Tokens cannot manage authentication, credentials, budgets or other keys. Removing membership deletes its keys; rejoining does not revive them. OpenAPI, batch endpoints, compatibility access and complete MCP coverage remain outstanding.

Choose **Providers and spending** as a workspace owner. A saved connection starts **untested**. **Run check** contacts only the provider's documented read-only account endpoint: [OpenRouter current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) or [DataForSEO user data](https://docs.dataforseo.com/v3/appendix-user-data/). Acceptance of credentials does not prove paid endpoint permissions or sufficient credit. Diagnostics never display the provider's response body or submitted credentials.

Budgets start paused at zero. Amounts use integer USD micro-units (six decimal places), with independent workspace and connection caps. The ledger covers this app's requests, not spending elsewhere on the provider account. Concurrent reservations share a workspace lock; retries cannot enqueue or dispatch the same request twice. Outstanding work still consumes budget across a month boundary. Unknown charges pause spending and block new work even if someone unpauses the budget; reconcile the original request first. Owners can cancel undispatched reservations, including work whose initiating member has been removed.

The internal settlement contract returns `reconciliationRequired` for unknown charges or reported amounts above the current $1M per-charge ledger limit. Such rows stay uncertain, preserve their provider reference and pause spending. Execution adapters must retain the exact reported amount/evidence with their job result and inspect this outcome before marking work complete. There is no automatic retry of a dispatched paid call.

### Encryption keys and upgrades

New installs generate `CREDENTIAL_KEYS` (JSON mapping version names to base64 32-byte keys) and `CREDENTIAL_ACTIVE_KEY`. Existing installations need an operator-generated keyring before saving credentials. The native process also accepts an exclusive `CREDENTIAL_KEYS_FILE` alternative; a Compose secret-file recipe must explicitly mount that file. The default Compose recipe passes the keyring from the private `.env`.

Stored credentials bind encryption to the workspace, connection, provider and revision. Missing keys or invalid authenticated ciphertext fail readiness and worker startup; diagnostics make no provider calls. Protect and back up the keyring separately with access sufficient to restore the matching database. Environment variables are visible to host/container administrators; database encryption does not hide secrets from those administrators.

To rotate encryption keys, stop all web and worker writers, add the new key while retaining old entries, choose it as active, and run `docker compose run --rm web node src/server/cli.ts rekey`. Recreate every web/worker process with the same updated configuration before accepting writes. Keep old keys for every retained backup that needs them. Provider connections and OIDC credentials rotate in separate transactions: a failure rolls back its own credential family, and rerunning safely resumes the other. Keep both keys until the whole command succeeds and readiness passes. An old process still using the old active key can otherwise write old-key ciphertext after rotation.

The owner approved configurable retention defaults: raw analytics 90 days, replays 7 days, raw provider evidence 90 days and derived history 1 year. Workspace retention controls and the bounded worker are active for implemented data types; see [retention](retention.md) for exclusions and execution limits. No history migration from the three replaced apps is required; native provider report imports and this app's backup/export remain included. Shared reports use revocable slugs under `APP_URL`, without separate per-client domain provisioning.

## Identity provider setup and recovery

Open **Identity sign-in**. Instance operators configure the provider's issuer, client ID, client authentication method and allowed endpoint origins. Register the callback URL displayed by the app with the identity provider. Save a draft, authenticate with that provider to test it, then enable the tested revision. A failed test leaves the previously enabled settings in service. Public PKCE clients use POST authentication with an empty secret; confidential clients use their configured secret.

Workspace ownership does not grant instance administration. A newly claimed instance grants its first owner that separate role. On an upgraded installation, an operator with host access can grant it to an existing account:

```sh
docker compose run --rm web node src/server/cli.ts operator grant owner@example.com
```

Use `operator revoke` with the same email argument to remove it. These changes are audited. Endpoint requests are HTTPS, DNS pinned and restricted to the configured origins; private-address exceptions require explicit operator configuration. The local HTTP issuer used by tests is available only with the integration-test opt-in.

Accounts link by the exact issuer and subject after explicit proof; matching email alone never merges accounts. An invitation can create an OIDC-only account without requiring a second password. Such an account can use fresh provider verification to add an optional local recovery password, enroll an authenticator or change recovery codes. Once enabled, app two-factor verification also applies to OIDC sign-in. Disabling a provider revokes its sessions and pending challenges; users with no other sign-in method lose access. Configure independent recovery before disabling the last method.

Generic protocol, invitation, linking, revocation and fresh-verification flows are covered by signed local issuer fixtures. Real external IdPs and workspace-enforced policies/group mapping still require implementation or validation; fixture success is not vendor certification.

## Browser destinations

Select a project and **Destinations**. Choose **Live** or **Test**, add public asset IDs, choose supported event mappings and declare whether ten98 or an existing integration owns each tag. Save, run a dry preview, then publish. An ownership confirmation is required before managed tags can publish. Preview makes no vendor requests. Concurrent drafts reject stale versions; rollback creates a new immutable revision and consent epoch.

The existing header snippet loads `/destinations.js` once. Published configuration contains public asset IDs and mappings only; report credentials remain separate. The loader supports Meta, GA4, Google Ads, Cloudflare Web Analytics, TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X. It shares Google's SDK, refuses detected foreign SDK ownership, limits readiness queues, discards events observed before consent, and reports SDK invocation rather than inventing a delivery receipt. Cloudflare owns its own page observations and has no custom-event mapping.

Use `data-environment="test"` on the snippet to select the test configuration and suppress native analytics writes. Test assets can still send real traffic to vendors when consent is granted: this is separate configuration, not a vendor sandbox. Without that attribute, the snippet uses live configuration. This increment allows one asset per vendor and eight canonical event names; complete upstream event coverage and multi-asset ownership remain open.

The browser API uses an explicit context, for example `{siteKey: 'PROJECT_PUBLIC_KEY', environment: 'live'}`. Check `window.ten98?.destinationStatus(context).ready` before opening `window.ten98.consentPreferences(context)` from a visitor action. The `ten98:destinations-ready` event signals validated configuration; the panel includes a working preferences-button example. A CMP can call `window.ten98.consent({analytics, advertising, adUserData, adPersonalization}, {...context, acknowledgeReload: true})` after displaying the reload/storage-failure warning. All four choices must be booleans. Unknown consent, GPC and DNT prevent vendor loading. No previous page event is replayed when a visitor first grants consent. Saved consent expires 180 days after the explicit choice; revisits do not extend it.

Loaded vendor SDKs can perform their own observations. A saved withdrawal reloads the page because clearing this app's queue cannot stop arbitrary loaded code. If storage cannot save or erase consent, the loader instead navigates to a blank page to leave the running SDKs; clear site data before returning. If the browser blocks navigation, the visitor must close the page. The preference flow warns about unsaved work before granting consent. Configuration is valid for 60 seconds and refreshed every 30 seconds; expiry or a changed published revision stops routing and requires renewed consent/reload. Already transmitted data and requests in flight cannot be retracted. CSP, blockers, browser storage failures and provider settings require controlled acceptance checks before a V1 claim. Native collection now shares this consent gate and honors DNT/GPC, collection disablement and path exclusions; broader P31 retention and bot/IP controls remain unfinished.

## Native collection and measurement

Open a project and **Collection and privacy**. Owners/admins can enable native collection, choose the built-in preferences button or an existing consent platform, configure optional referrer hostname/UTM/screen capture and exclude path prefixes. Other members can inspect the saved settings. A save invalidates prior consent; a conflicting save preserves the draft and asks the user to reload. The same consent epoch also changes when destination policy changes.

Native collection defaults to enabled **after explicit analytics consent**, with optional metadata disabled. A fresh grant records the current page; it never replays activity or custom properties from before that grant. The response context stays in memory. Only consent choices are persisted in browser storage. The tracker discards URL queries/fragments, uses credential-free requests and aborts pending collection when consent is withdrawn. Caller-supplied custom properties must still avoid personal data.

`ANALYTICS_NETWORK_MODE=off` is the default: event/page counts work and visitor/visit estimates remain unavailable. `direct` uses the actual Node socket peer; `proxy` additionally requires an explicit `ANALYTICS_TRUSTED_PROXIES` IP/CIDR allowlist and a correctly configured forwarding chain. Client forwarding headers never substitute for a missing transport peer. Do not choose direct mode behind a shared proxy. Native production-server direct mode is covered by the integration test; a particular reverse-proxy deployment needs its own verification.

IP, User-Agent and explicit distinct ID are inputs to a project-specific keyed hash, never raw event columns. Monthly visitor rotation and hourly visit keys with a bounded browser context follow the documented [measurement contract](analytics-measurement.md). Overview cards show measured pageview coverage, preserve unavailable values and explain visit/bounce/duration semantics. Overview dates use UTC. The [Explore screen](explorer.md) adds named calendar timezones, exact filters, typed property breakdowns and a bounded CSV snapshot. Advanced reports, realtime/comparisons, identity links and remaining dimensions are still required for V1.

## Reports and domain records

Choose **Reports** from a project's navigation to author static HTML, edit template briefs, preview saved reports and create immutable shared snapshots. Source stays private; preview and public sharing render a static allowlist under an opaque browser sandbox. Scripts, navigation, forms and external resources cannot execute. Sharing returns the complete `APP_URL/share/<slug>-<random-token>` URL once, stores only its digest and supports expiry/revocation. Editing a report does not alter an existing snapshot. Deleting a report revokes its shares. Editors can author reports; only owners/admins can create/revoke shares. Conflicting revisions preserve the draft until an explicit reload. AI report generation remains separate unfinished work.

Choose **Domains** as an owner or administrator to record the canonical hostname, additional serving domains and redirect aliases with an expected destination. Ownership proof uses a short-lived exact-host DNS TXT challenge; only its digest is stored. Reissuing or revoking invalidates the earlier proof, and verification rechecks permission after the DNS response. Verified, unrevoked **serving** domains can use the same snippet at their exact HTTPS origin on port 443. Redirect aliases never authorize collection. The canonical project origin remains allowed exactly as configured. See [serving-domain collection](serving-domains.md) for consent changes, source provenance and remaining redirect work.

Verified redirect aliases also offer [manual HTTP redirect checks](domain-redirects.md), with pinned public-address transport, current-authority/configuration rechecks, immutable receipts and raw-evidence expiry. Migration `0018` is additive after `0017`. Synthetic database, upgrade and production browser checks cover lost acknowledgements, stale configuration, role changes and sanitized evidence. This observes HTTP redirects only; schedules, redirect counts/log imports, JavaScript/meta behavior and backlink consolidation remain unfinished.

Native/report/domain increment checked locally on 2026-10-13: production build, TypeScript, 127 unit/browser-VM checks (two additional platform-specific skips) and the full PostgreSQL production web/worker integration passed. New cases cover typed properties, actual Node transport, consent-policy publication while collection waits, duplicates, identity coverage, report/share authorization and immutable sanitized snapshots. Separate fresh-database checks passed DNS challenge expiry/reissue/revocation/role races with mocked DNS. Original-install upgrades through `0012`, failed-upgrade rollback and repeat migration passed. These checks make no real vendor, DNS ownership or paid-provider claim.

Production Edge acceptance passed native consent before/after grant, withdrawal, stale policy dialogs, privacy-setting conflicts/role loss and known/unavailable metric cards. The integrated report UI passed edit/reload, revision conflict preservation, templates, immutable snapshots, one-time link clearing, duplicate submission, denied/deferred clipboard, deletion, project changes, role loss and expired login. Desktop and 360px layouts fit without horizontal document overflow. Domain UI checks exercised create/proof/reissue/revoke and stale responses against synthetic data; no real domain ownership was asserted. Optional browser runners use an operator-installed Playwright via `PLAYWRIGHT_MODULE`, keeping it out of the application's production dependencies.

The same increment passed a fresh Linux amd64 Docker build/install through `0012`, nonroot web/worker health, consent collection, report sharing, domain records and restart persistence. Default network measurement stayed off despite forged forwarding headers. A real web shutdown failure was fixed: a Nitro close hook now awaits the actual queue resources and then database pools, including across the separate SSR/runtime bundles. With a web-created queue open, web and worker exited cleanly and restarted with sessions, reports, revocations and events intact. No shutdown timeout was increased and no forced process exit was added. A separate-module regression verifies ordering and safe error reporting. Public HTTPS, ARM and real proxy identity remain separate acceptance gates.

Security/tracking increment checked locally on 2026-10-13: production build, TypeScript, the full fresh PostgreSQL web/worker integration suite, and original-schema upgrades through `0009` passed. The integration suite covers OIDC signed claims and fresh verification, two-factor recovery, account log redaction, API-key live revocation, encrypted credential rotation, concurrent spending caps, and destination HTTP/CORS/role/revision isolation. Tests used synthetic data and no external IdP or paid provider traffic.

Edge production-build checks passed OIDC-only invited signup, fresh provider verification, authenticator enrollment, replacement recovery codes, optional local password, local/recovery login and callback-error recovery. Destination checks passed save/preview/publish/rollback, actual tracker/loader/preferences integration, stored-consent restoration and withdrawal reload. Desktop 1360 px and mobile 360 px were checked without document overflow. Vendor scripts were intercepted with local stubs: no real vendor-account delivery claim.

The integrated Linux amd64 Docker image built and its fresh `0001`–`0009` migrations, web/worker readiness, keyring diagnostics, owner claim, operator role, event collection, analytics and queued worker operation passed on an isolated local installation. Docker helper checks ran with networking disabled; the synthetic shell regression requires an executable container temporary mount. Packaging tests do not establish public HTTPS, ARM, performance or full V1 completion. Detailed setup/backup checks are in [docker-setup.md](docker-setup.md).


## Project knowledge and prompt library

**Research > Context** stores brand aliases, business guidance, competitors, key pages and authored research notes. **Research > Prompts** supports single/bulk entry, user tags, automatic/manual branded classification, filters, archive/restore and immutable numbered text history. Editors can write and viewers can read. Saving an enabled preference does not activate provider execution, scheduling or spending. Research and prompt history survive analytics retention. See the [contract, source provenance and verification](project-context.md).

The integrated checkpoint passed TypeScript, production build, 135 unit checks (two platform-specific skips), isolated project-content database/API checks, and original-install upgrades through 0014 with rollback/history checks. Real production Edge checks exercised both panels and actual navigation at desktop and 360px, with conflict preservation, lost-response retry, permission purge and project/account isolation. These synthetic local checks do not establish upstream runtime parity, provider behavior, capacity, public HTTPS or a V1 release. The existing retention worker and shutdown cleanup remain unchanged.

## Docker recovery acceptance through 0014

On 2026-10-13, committed source `903e6fa78295545ae54262110c884527895854d7` passed an isolated Docker Desktop Linux amd64 backup and restore drill (Engine 29.8.1, Compose 5.5.1). The image was built from a Git archive, excluding private inputs. Fresh and repeated migrations, nonroot web/worker health and existing-configuration overwrite refusal passed.

With both source writers stopped, a PostgreSQL custom-format dump, artifact archive and matching deployment configuration/keyring were backed up outside the source tree. Restoration used separately verified empty volumes and the identical image. The restored installation preserved all 14 migration checksums, an existing session and fresh login, workspace retention and collection settings, a consented event and its Explorer result, project context, two prompt versions, a shared report, an artifact and an encrypted synthetic provider credential. A queued probe survived the backup and completed after the restored worker started. Graceful web/worker shutdown returned exit code 0 without an OOM; restart and heartbeat checks passed.

The check made no provider calls and left spending paused. Only the two isolated acceptance projects were stopped afterward; the development preview and previous Docker resources were preserved. This local drill does not establish public TLS, ARM, off-host recovery, production capacity or full POSIX helper orchestration. No application fix was required.


## Keyword backend and shared retention checkpoint

The [DataForSEO keyword backend](keyword-research.md) now provides explicit price quotes, atomic budget/queue reservations, single-dispatch overview/ideas jobs, and conservative charge reconciliation. The routine keyword panel is pending because its bounded Kimi attempt reached the subscription usage limit. This server increment does not complete keyword or full SEO parity.

Migration 0016 follows Google 0015 without changing older files. Fresh installation, original-schema migration rollback and a seeded 0015 upgrade pass. The integrated code passes 147 unit tests (two platform-specific skips), typecheck/build, the full production HTTP integration suite, offline Google and keyword worker suites, and desktop/360px Google and shared-retention browser checks. Independent review also reproduced preservation of encrypted credentials and settled/uncertain ledger entries across upgrade, and proved that a failure after Google deletion rolls back native, Google and keyword cleanup together. No live Google/DataForSEO account or paid request was used.

## Explicit prompt execution backend

[Prompt execution](prompt-execution.md) adds browser-authenticated quote/start/read/cancel/reconcile APIs for selected standard GPT-4o-mini/GPT-4o routes through OpenRouter. It reuses immutable prompt versions, encrypted credentials and the spending ledger. Both comparison children reserve atomically; no paid retries or hidden context injection occur. Generated answers and copied execution input use raw provider evidence retention (90 days by default), while authored prompts and charge receipts remain. Migration `0017` is additive. The execution UI, scheduler, cache, further model/provider routes and explicitly budgeted live paid acceptance are still pending; this does not complete AI visibility parity.

The prompt backend was verified locally with Node 24: 153 unit checks passed (2 existing skips), TypeScript/build/plan checks passed, the additive `0016` to `0017` upgrade preserved existing records and immutable prompt versions, and both the existing keyword suite and seven prompt execution integration groups passed with synthetic transports. Shared Google/keyword retention regressions passed. Real Edge retention checks at 360px and 1360px covered the separate raw-evidence cutoff/counts, explicit preview/save, stale response recovery and permission loss, with external traffic blocked. These observations do not validate live provider behavior.
