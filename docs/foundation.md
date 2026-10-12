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

Observed integration coverage (root GPT run): schema mismatch restore, owner concurrency/rollback, roles/tenant boundary, CORS/URL privacy/idempotence, worker completion/queue rollback/revoked permissions, failed job reconciliation, logout.

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

The independent browser check used synthetic accounts and a local fixture website; it does not verify provider integrations. Base images are pinned to the tested digests. ARM, public HTTPS, restore/upgrade and production load testing remain outstanding. Hosted CI results are linked from the pull request rather than inferred from local runs.

Screenshots from the completed browser check: [desktop](screenshots/foundation-desktop.png) · [mobile](screenshots/foundation-mobile.png).

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

- Owner token atomic claim + local sign-in; default workspace/role data.
- Project origin and public site key.
- Single page-load tracker: path-only events (query + hash stripped), no IP, no user agent.
- CORS origin matching (public signals remain spoofable) and duplicate-event UUID dedup.
- Jobs: internal free worker probe; durable Postgres queue with idempotency, transaction rollback, revoked-permission handling, failed-terminal reconcile.
- Migrations: transaction + advisory lock + explicit normalized checksum.

## Current limitations

- Not a public V1/release. No published Docker image — build locally.
- No production HTTPS installer. A host-local tracker snippet only works for another local origin; remote visitors cannot reach a localhost collector until a proper HTTPS deployment exists.
- No provider imports, SEO, AI, OIDC, or pixel vendor loading yet — all remain full V1 scope.
- No unique-visitor claims, bot filtering, retention/data lifecycle, or advanced reports / full analytics parity yet.
- No invitations, workspace admin UI, account recovery, or OIDC. Role authorization data is real, but the UI for creating additional members is not built.
- No SaaS billing.
- Secrets in compose env are plaintext, not encrypted. The backend supports `_FILE` for `AUTH_SECRET` / `BOOTSTRAP_TOKEN` / `DATABASE_URL` (exclusive with direct values), but the current recipe uses `.env`. No production secrets manager is claimed.
- Worker status refresh is manual; no global auto-poll.
- Nitro 3.0.260903-beta is a prerelease; the production gate is pending. Optional Cloudflare features are not built.

## Work process

- Kimi 2.1.1 acts as skill-only drafter on prompt-supplied public files; GPT owns architecture, security, design, and tests.
- Maximum K3 effort was requested with a fixed model alias; K3 HighSpeed is not available, and older K2.7 HighSpeed was not used.
- Swarm uses independent file ownership for parallel UI/packaging/validation; review repairs are mandatory.
- The existing native CLI uses individual OAuth and is not embedded in the app.
- No quota/savings counts verified.
