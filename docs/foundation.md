# ten98-monitor — foundation quickstart & limitations

> **Status:** internal foundation branch. This is **not** a public V1 or release. Full 81-feature parity remains required. MIT-licensed / free.

Related: [README](../README.md) · [Feature parity](parity.md) · [Kimi workflow](kimi-workflow.md)

## Requirements

- Node 24 only
- pnpm 11.19.0 (via corepack)
- Docker with Compose (recommended path)

## Quickstart (Docker)

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm run setup:local        # NOT `pnpm setup` — that is a pnpm builtin
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
# open http://localhost:3000
```

- `setup:local` generates an exclusive `.env` with 3 random 32-byte hex secrets. It refuses to overwrite an existing `.env` and does not touch the database.
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

- Owner token atomic claim + local sign-in; create, rename and switch workspaces.
- Team management for owners/admins, role changes and member removal. Owners can grant ownership; concurrent changes cannot remove the final owner. Admins manage editors/viewers only.
- Revocable seven-day invitation links for new and existing local accounts. Only token hashes are stored; links are displayed once for manual sharing. Existing accounts must sign in with the invited email; accepting a link never resets their password or changes an existing membership's role. Removing/demoting an inviter invalidates grants they can no longer issue.
- Project origin and public site key.
- Page-load and SPA pathname tracking, plus `window.ten98.track('signup')` after the script loads. Event names are 1–64 characters, start with a letter and use letters, digits, underscores, periods, colons or hyphens. Keep personal information out of event names. Query strings and fragments are stripped; no event properties, IP or user-agent data is stored.
- Analytics for inclusive UTC date ranges up to 366 days: page views, custom-event counts, daily chart/table and the top 20 pages/event names. Counts are stored observations, not unique visitors or sessions.
- CORS origin matching (public signals remain spoofable) and duplicate-event UUID dedup.
- Jobs: internal free worker probe; durable Postgres queue with idempotency, transaction rollback, revoked-permission handling, failed-terminal reconcile.
- Migrations: transaction + advisory lock + ordered, normalized checksums. Existing `0001` installations upgrade through `0002` and `0003`; unknown, altered or incomplete history is rejected.

## Use the team and analytics flows

1. Choose **Create workspace** to separate a team's projects and membership. The workspace selector switches between your memberships.
2. Choose **Manage team**, enter an email and role, then copy the invitation link and share it privately. No email is sent automatically. The link can create a new local account, so treat it like a temporary credential; mailbox verification is not claimed.
3. A recipient opens the link, creates a local account or signs in with their existing invited email, then joins. The fragment token is removed from the address bar and kept only in memory; re-open the original link if the page is refreshed before joining.
4. Select a project to view **Analytics**. Choose a preset or custom dates, then **Apply** to refresh. The chart and tables use server receipt dates in UTC. Query/hash-only navigation does not create a new page view.

For an existing development install, back up its database and stop web/worker before upgrading. Build the new image, run `docker compose run --rm migrate`, then start web/worker again. Repeat migrations are safe. The old application image cannot serve the upgraded schema; rolling back requires the matching pre-upgrade database backup. General backup/restore automation remains unimplemented.

## Current limitations

- Not a public V1/release. No published Docker image — build locally.
- No production HTTPS installer. A host-local tracker snippet only works for another local origin; remote visitors cannot reach a localhost collector until a proper HTTPS deployment exists.
- No provider imports, SEO, AI, OIDC, or pixel vendor loading yet — all remain full V1 scope.
- No unique-visitor claims, bot filtering, retention/data lifecycle, or advanced reports / full analytics parity yet.
- No account recovery, 2FA, OIDC, automatic invitation email delivery or project/workspace deletion yet. Invitations currently support manually shared links.
- SPA tracking observes pathname changes; hash-based routes, event properties, HTML event attributes, referrers and visitor/session identity are not implemented yet. The custom-event API does not buffer calls made before the script loads.
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
