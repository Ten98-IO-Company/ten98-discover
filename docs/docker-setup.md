# Docker setup for the development foundation

This is a source-built development deployment, not the full V1 release or a published release image. Docker runs PostgreSQL, the app and its worker; Node and pnpm are not needed on the host. Optional Caddy provides HTTPS. Setup never enables paid providers, edits DNS, mounts the Docker socket into the app, or deletes data volumes.

## Choose an address

| Mode | Address | Who handles HTTPS? |
|---|---|---|
| `local` | `http://localhost:3000` | Local evaluation only |
| `proxy` | `https://monitor.example.com` | Your existing host reverse proxy forwards to `127.0.0.1:3000` |
| `caddy` | `https://monitor.example.com` | Bundled Caddy; point DNS at this host and allow inbound TCP 80/443 |

On `https` origins the app itself sends `Strict-Transport-Security` on its application documents (not on report share pages or on redirects), so in `proxy` mode your proxy only needs to terminate TLS and redirect HTTP to HTTPS; `local` mode is plain HTTP and sends none. The app port stays on host loopback in every mode. PostgreSQL has no published port. An existing proxy in another container needs a deliberately configured shared network; `127.0.0.1` inside that container is not the Docker host. Public origins must be DNS names, not private IP addresses. A public hostname can still resolve to a private network behind your existing proxy.

Sign-in, two-factor, password recovery, OIDC and public invitation routes apply their anonymous rate limits per client. `TRUSTED_PROXIES` (empty by default) is a comma-separated list of at most 32 IPs or CIDRs whose `X-Forwarded-For` the app honours for these limits. While it is empty, the transport peer is the client, so behind `proxy` or `caddy` mode every visitor arrives from the proxy's address and shares that proxy's per-client limits. To separate clients, list exactly the addresses the app sees for your proxy (for bundled Caddy, its address on the Compose network; for a host proxy, the Docker gateway address the published port presents), never a range that includes clients. A peer outside the list is the client and its forwarding headers are ignored; behind a trusted peer, the right-most untrusted `X-Forwarded-For` entry is the client, and a missing or malformed chain falls back to one conservative shared key. Addresses are used only as keyed hashes in short-lived limit counters. An invalid list stops startup with a redacted error. This setting is separate from the analytics `ANALYTICS_TRUSTED_PROXIES` list.

Use Docker Engine 28 or newer with Linux containers, and Compose supporting `up --wait-timeout`. Older Docker versions had a documented exception to localhost port isolation. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

Caddy needs correct DNS and external reachability to obtain and renew certificates. Its local healthcheck does not prove certificate issuance or remote reachability. Certificate state persists in `caddy_data`; never treat it as disposable cache. No DNS-provider credentials or Cloudflare subscription are required by this recipe. [Automatic HTTPS](https://caddyserver.com/docs/automatic-https), [official Caddy image](https://hub.docker.com/_/caddy)

## One POSIX shell procedure

Use a POSIX shell with Docker CLI access on Linux or macOS. On Windows, run the same commands inside a WSL2 distribution with [Docker Desktop WSL integration enabled](https://docs.docker.com/desktop/features/wsl/#enable-docker-in-a-wsl-2-distribution), keeping the checkout in that distribution’s Linux filesystem. No separate PowerShell procedure is maintained.

From a checkout of the exact version you intend to run:

```sh
sh scripts/deploy.sh local http://localhost:3000 3000 ten98-monitor
# Or choose ONE public mode:
# sh scripts/deploy.sh proxy https://monitor.example.com 3000 ten98-monitor
# sh scripts/deploy.sh caddy https://monitor.example.com 3000 ten98-monitor
```

Arguments are mode, app origin, private upstream port, and a unique Docker project name. A second install needs a different project name, checkout and app port. Two bundled proxies cannot share the same host ports 80/443; use one existing proxy for that topology.

The script checks the local Docker daemon and Compose capability, reports detected CPU/memory, builds the application, checks the mounted configuration directory and selected Docker port mappings, writes `.env` once, runs an explicit migration, and waits up to 180 seconds for app/worker health. The build needs network access and can take longer; installation does not download dependencies during container startup. There is no measured production capacity minimum yet. The reported directory free space may differ from Docker's named-volume storage, particularly on Docker Desktop; inspect its disk allocation separately.

Open the configured address. Read `BOOTSTRAP_TOKEN` privately from `.env`, enter it in the owner-claim form, and choose your owner password. Do not put the token in a URL, command argument, screenshot or support request. Setup creates independent database/auth/bootstrap secrets and a durable encryption keyring. Keep the whole file private and backed up.

After a failed or interrupted setup, run without arguments:

```sh
sh scripts/deploy.sh
```

The existing configuration is validated and retained. The app and worker stop before explicit migration. A migration failure leaves them stopped so they cannot use an incompatible schema; diagnose the cause, then rerun. The helper never resets a volume or silently repairs a mismatched migration checksum. Read the backup steps before using this command for an upgrade.

The helper supports local Unix/named-pipe Docker contexts only. Run it on the Docker host, not against a remote TCP/SSH context. It does not read `.env` as shell code. Generated files request POSIX mode `0600`; on Windows-backed Docker Desktop mounts, Windows ACLs determine actual access, so inspect those permissions privately. Compose environment variables are visible to a host operator with Docker privileges; this is not encrypted secret storage. The backend also supports `_FILE` secrets for operator-managed recipes. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)

## Existing installations and verification

The new helper intentionally does not adopt an old `.env` automatically. Preserve its original database password, auth secret, bootstrap token and all encryption keys. Determine its existing Compose project name with `docker compose ls`, then privately add `DEPLOYMENT_MODE`, `COMPOSE_PROJECT_NAME` and `TEN98_IMAGE=ten98-monitor:YOUR_PROJECT_NAME` to that file. Keep the origin/port unchanged. The helper builds that project-specific image; persisting its name also keeps later manual Compose commands on the same image. An older installation without a keyring should use the normal manual Compose path until its matching application version's documented key initialization is complete; never replace keys protecting existing data. The application uses this keyring for provider and OIDC credentials; see [encryption keys and upgrades](foundation.md#encryption-keys-and-upgrades).

After startup, run `docker compose ps` using the same project and overlay options. Verify all intended services are healthy, then:

1. Open the app from another device using the intended public origin. Verify a browser-trusted certificate and the expected sign-in page.
2. Create a test project and explicitly run its worker check.
3. Embed its tracker on a controlled HTTPS page reachable by that browser. Verify a real event arrives; localhost-only tests do not establish public collection.
4. With bundled Caddy, verify HTTP redirects to HTTPS. Keep its admin port 2019 unpublished.
5. `curl -IL https://monitor.example.com/` (your origin) must show `content-security-policy` and `strict-transport-security` on the final page response; the first response is a 307 redirect to `/?view=project` and carries neither.

Public certificate issuance, ARM execution, production capacity and external-proxy platform imports require separate evidence. A successful local readiness check is not a completed public deployment. The current setup work is tracked in [issue #6](https://github.com/Ten98-IO-Company/ten98-monitor/issues/6).

## Optional local country, region and city database

The base installation does not download or mount a location database. `compose.geo.yaml` adds a read-only database directory and a 1 GiB, no-swap limit **only to web**. Worker and migration services do not load it. This is an optional development profile; combined workload acceptance is recorded separately and is not a general production-capacity guarantee.

Build the selected application version first, using the existing project-specific image name from your saved configuration. The explicit installer accepts only a named release listed on the official DB-IP City Lite page; it verifies the published uncompressed SHA-1, bounded decompression, the actual City Lite reader metadata and a local SHA-256 before replacing `city.mmdb`. It retains a `city.json` provenance receipt. There is no boot download or updater. October 2026 is the example release below; choose the release actually listed when installing.

From the same POSIX shell and checkout, replace `YOUR_PROJECT_NAME` with the existing project name:

```sh
mkdir -p data/geography
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD/data/geography,target=/geo" \
  ten98-monitor:YOUR_PROJECT_NAME node scripts/analytics-geo.mjs 2026-10 /geo
# Continue only after successful verification. Add compose.caddy.yaml before compose.geo.yaml if used.
docker compose --env-file .env -p YOUR_PROJECT_NAME -f compose.yaml -f compose.geo.yaml config --quiet
docker compose --env-file .env -p YOUR_PROJECT_NAME -f compose.yaml -f compose.geo.yaml up -d --no-build --force-recreate --wait --wait-timeout 180 web
```

A host with Node 24 and the checked-out dependencies can instead run `node scripts/analytics-geo.mjs 2026-10`.

The downloaded database is separately CC BY 4.0; the application stays MIT. The data directory is already excluded from Git and Docker build context. Keep the directory readable by the image's nonroot user, and do not put secrets there. The receipt records source, license, build, byte length and hashes; the running reader independently hashes the actual file and does not trust the receipt. A failure between the two atomic renames can leave an older receipt, so use the reader's actual build/hash when checking readiness. No service is restarted by the installer itself.

**Keep `-f compose.geo.yaml` on every subsequent migration, upgrade, restart and diagnostic command**, together with the same base/Caddy files, image, project and private `.env`. The current `scripts/deploy.sh` selects its own base/Caddy files and drops this optional override; use the documented manual upgrade sequence for a geography-enabled installation. Updating the verified file requires restarting web; a running process keeps its original immutable reader.

Collection also needs the project's Location setting and a correctly configured analytics network resolver. Existing projects remain off until explicitly enabled; new project defaults cannot make a missing file or unknown address measurable. Verify the actual visitor-to-proxy chain before enabling an existing public site. Do not widen trusted proxies or trust caller-supplied country/Cloudflare headers to make a map appear populated. Raw addresses and coordinates are not stored; reports show approximate retained observations, unknown values and unrecorded history separately.

## Back up before upgrading

Use the same Compose project, `.env`, image selection and overlay options for every command. In the examples below, `docker compose` means that exact configuration. The backup directory must be outside the checkout/build context, private, and copied to access-controlled encrypted off-host storage. A local backup alone does not cover host loss.

```sh
umask 077
backup_dir=$(mktemp -d ../ten98-backup.XXXXXX)
backup_dir=$(cd "$backup_dir" && pwd)
docker compose stop web worker
# Bundled proxy: docker compose stop caddy
docker compose exec -T postgres pg_dump -U ten98 -d ten98 -Fc > "$backup_dir/database.dump"
docker compose run --rm --no-deps --user 0:0 --entrypoint sh --volume "$backup_dir:/backup" web -c 'umask 077; tar -czf /backup/artifacts.tar.gz -C /data artifacts'
cp .env "$backup_dir/deployment.env"
chmod 600 "$backup_dir/deployment.env"
git rev-parse HEAD > "$backup_dir/source-commit.txt"
cp compose.yaml "$backup_dir/compose.yaml"
# Bundled proxy: also save compose.caddy.yaml, deploy/caddy/Caddyfile and certificate volumes:
# docker compose run --rm --no-deps --user 0:0 --entrypoint sh --volume "$backup_dir:/backup" caddy -c 'umask 077; tar -czf /backup/caddy.tar.gz /data /config'
docker compose up -d --no-build --wait --wait-timeout 180 web worker
# Bundled proxy: include caddy in the up service list.
```

Check every backup command succeeds before proceeding. Keep the exact image/source version and the complete encryption keyring, including older keys retained for decryption. Database dumps contain account/session material and must stay private. The brief writer pause aligns database metadata and local artifacts; `pg_dump` provides a consistent database snapshot. [PostgreSQL backup documentation](https://www.postgresql.org/docs/18/backup-dump.html)

Upgrade by reviewing release/schema notes, taking this backup, checking out the chosen version, and running the setup helper without arguments. It builds that source, pauses app writers, applies pending migrations atomically, then starts and checks both processes. Never use volume deletion to fix an upgrade. Do not start an old image against a newer incompatible schema; restore the matching backup into a separate empty installation instead.

## Restore drill

Use an isolated checkout, new Compose project name, empty database/artifact volumes and a different loopback port. Restore the saved configuration privately, changing only deployment metadata and the test origin/port; retain its original secrets and keyring. Do not regenerate them. Stop every web and worker process connected to the restored database. Start only PostgreSQL, restore the dump with `pg_restore --exit-on-error --no-owner --no-privileges`, and unpack artifacts into the new artifacts volume while app writers remain stopped. Never restore over an existing production database. Apply only migrations belonging to the chosen image.

Before starting the restored application, quarantine its saved spending authorizations. Use this source version or a later compatible version that includes the command; do not use the setup helper here because it starts workers automatically. Run each command with the isolated Compose project/environment and continue only after success:

```sh
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps migrate node src/server/cli.ts restore-quarantine
docker compose up -d --no-build --wait --wait-timeout 180 web
docker compose exec -T web node src/server/cli.ts diagnose
```

The offline quarantine atomically sets the manual pause on every workspace, permanently cancels undispatched provider reservations, and disables saved rank schedules/clears their next due time. It leaves credentials, request IDs, quote/input hashes and dispatched/uncertain/settled charge evidence intact. Repeating its spending quarantine makes no further financial changes. It revokes every live tracked-asset and website share link, since their secrets are browser-held; owners create new links after review. It also disables replay and rotates the native consent epoch on every invocation for every replay-configured project, including disabled configurations, so browser-held upload capabilities from the restored signing key cannot revive. Existing replay history is preserved; re-enabling needs fresh explicit consent. A later owner unpause cannot revive those cancelled reservations: any new paid work needs a new explicit authorization. A cancelled restored reservation does not prove that the original installation incurred no charge after the backup. The command makes no provider requests and does not decrypt provider credentials. It cannot retract a request already in flight, which is why all restored writers must be stopped first.

Keep the worker stopped for the default drill. Verify login, workspace access, known projects and event counts against the saved installation. Do not click provider checks, imports, research starts or crawl actions during an isolated restore check. Existing workers can make paid DataForSEO/OpenRouter requests, Google imports and website requests; an old backup can contain queued work whose original installation completed after the snapshot. A local receipt cannot detect that later activity in another database. Before intentionally enabling this restored installation's worker, review its queued imports/crawls and compare provider receipts with the original installation; resolve uncertain charges and explicitly approve fresh spending/schedules. Start the worker and run `diagnose worker` only after that review. Public tracker/tag configuration must also be revalidated before exposing the restored origin; a database restore is not proof that a vendor asset still belongs to this installation.

Restore certificate state only when deliberately moving the original public host; an isolated drill should not request certificates for that live domain.

A backup is not verified until this separate restore succeeds. Record the tested version/date, observed checks, backup destination/retention and any unverified modules; do not publish the backup itself.

## Observed validation

Checked on 2026-10-13 using Docker Desktop's Linux amd64 engine 29.8.1 and Compose 5.5.1. The source image built successfully. Forty unit tests passed in Linux, followed by the added host-script failure-path regression (all nine setup tests passed). Fresh and repeated migration, web/worker readiness, configuration-preserving refusal, occupied-port detection, offline pinned Caddy configuration, and a real Caddy-to-web request on an isolated network passed. Synthetic database records restored into a separate empty database; an artifact archive restored into a separate empty volume.

The POSIX script passed shell syntax and offline failure-path checks; its complete real-host orchestration has not been exercised on Linux/macOS. The native Windows Docker sequence was exercised instead. No public certificate was requested, no production data was used, and these results do not establish an off-host disaster-recovery drill or application capacity.

`tests/restore-quarantine-integration.ts` adds a separate fresh-database safety check. With a migrated isolated loopback fixture, run `TEN98_INTEGRATION_TEST=1 TEN98_RESTORE_TEST=1 node --env-file=<private-test-env> tests/restore-quarantine-integration.ts`. It passed transaction rollback, evidence preservation, repeated quarantine, standing schedule disablement, owner unpause plus duplicate-receipt rejection, and actual keyword/prompt worker cancellation with synthetic transport and zero paid requests. The real CLI also passed with provider decryption keys absent. This is database/worker boundary evidence, not a new complete Docker restore drill.

Kimi task DKR-SETUP-01 drafted the dependency-free helper and tests from a supplied public contract with only the reviewed Ponytail Skill tool. CLI 2.1.1, K3-256k, thinking enabled and maximum-effort override; 277.56 seconds within a 480-second deadline, no repairs. Quota/token delta is unavailable. GPT corrected a false-positive test catch, added host-script failure checks, reviewed the code and independently ran validation. Kimi had no shell, file, network, deployment or publication tools.
