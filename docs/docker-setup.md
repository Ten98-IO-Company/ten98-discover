# Docker setup for the development foundation

This is a source-built development deployment, not the full V1 release or a published release image. Docker runs PostgreSQL, the app and its worker; Node and pnpm are not needed on the host. Optional Caddy provides HTTPS. Setup never enables paid providers, edits DNS, mounts the Docker socket into the app, or deletes data volumes.

## Choose an address

| Mode | Address | Who handles HTTPS? |
|---|---|---|
| `local` | `http://localhost:3000` | Local evaluation only |
| `proxy` | `https://monitor.example.com` | Your existing host reverse proxy forwards to `127.0.0.1:3000` |
| `caddy` | `https://monitor.example.com` | Bundled Caddy; point DNS at this host and allow inbound TCP 80/443 |

The app port stays on host loopback in every mode. PostgreSQL has no published port. An existing proxy in another container needs a deliberately configured shared network; `127.0.0.1` inside that container is not the Docker host. Public origins must be DNS names, not private IP addresses. A public hostname can still resolve to a private network behind your existing proxy.

Use Docker Engine 28 or newer with Linux containers, and Compose supporting `up --wait-timeout`. Older Docker versions had a documented exception to localhost port isolation. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

Caddy needs correct DNS and external reachability to obtain and renew certificates. Its local healthcheck does not prove certificate issuance or remote reachability. Certificate state persists in `caddy_data`; never treat it as disposable cache. No DNS-provider credentials or Cloudflare subscription are required by this recipe. [Automatic HTTPS](https://caddyserver.com/docs/automatic-https), [official Caddy image](https://hub.docker.com/_/caddy)

## Linux or macOS: one host command

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

## Native Windows: Docker commands

Use PowerShell in the checkout and Docker Desktop with Linux containers. This path does not require Git Bash or host Node. Use a new project name and confirm it has no existing containers or volumes before creating fresh credentials:

```powershell
docker version
docker compose version
docker volume ls --filter label=com.docker.compose.project=ten98-monitor
docker ps -a --filter label=com.docker.compose.project=ten98-monitor
docker build -t ten98-monitor:setup-helper .
docker run --rm --network none --mount "type=bind,source=$($PWD.Path),target=/setup" --workdir /setup ten98-monitor:setup-helper node /app/scripts/docker-setup.mjs storage
docker run --rm --network none --mount "type=bind,source=$($PWD.Path),target=/setup" --workdir /setup ten98-monitor:setup-helper node /app/scripts/docker-setup.mjs setup local http://localhost:3000 3000 ten98-monitor
docker run --rm --network none --mount "type=bind,source=$($PWD.Path),target=/setup" --workdir /setup ten98-monitor:setup-helper node /app/scripts/docker-setup.mjs inspect
$env:TEN98_IMAGE = 'ten98-monitor:ten98-monitor'
docker tag ten98-monitor:setup-helper $env:TEN98_IMAGE
docker compose --env-file .env -p ten98-monitor config --quiet
docker compose --env-file .env -p ten98-monitor run --rm migrate
docker compose --env-file .env -p ten98-monitor up -d --no-build --wait --wait-timeout 180 web worker
docker compose --env-file .env -p ten98-monitor exec -T worker node src/server/cli.ts diagnose worker
```

Check each command succeeds before continuing. Do not run `setup` over an existing file or when the chosen project already has state; restore the original configuration. On a rerun, keep `.env`, stop web/worker before migration, and skip secret generation. Ensure the shell has no unrelated app-secret/origin variables: Compose gives those precedence over `.env`. Do not use `docker compose config` without `--quiet` in logs, because expanded configuration contains secrets.

For public access, replace `local` and its URL with the selected mode and HTTPS origin. With bundled Caddy, add `-f compose.yaml -f compose.caddy.yaml` to each Compose command and include `caddy` in the final `up` service list. An existing-proxy deployment uses the base Compose file. The app port remains loopback-only.

## Existing installations and verification

The new helper intentionally does not adopt an old `.env` automatically. Preserve its original database password, auth secret, bootstrap token and all encryption keys. Determine its existing Compose project name with `docker compose ls`, then privately add `DEPLOYMENT_MODE`, `COMPOSE_PROJECT_NAME` and `TEN98_IMAGE=ten98-monitor:YOUR_PROJECT_NAME` to that file. Keep the origin/port unchanged. The helper builds that project-specific image; persisting its name also keeps later manual Compose commands on the same image. An older installation without a keyring should use the normal manual Compose path until its matching application version's documented key initialization is complete; never replace keys protecting existing data. The application uses this keyring for provider and OIDC credentials; see [encryption keys and upgrades](foundation.md#encryption-keys-and-upgrades).

After startup, run `docker compose ps` using the same project and overlay options. Verify all intended services are healthy, then:

1. Open the app from another device using the intended public origin. Verify a browser-trusted certificate and the expected sign-in page.
2. Create a test project and explicitly run its worker check.
3. Embed its tracker on a controlled HTTPS page reachable by that browser. Verify a real event arrives; localhost-only tests do not establish public collection.
4. With bundled Caddy, verify HTTP redirects to HTTPS. Keep its admin port 2019 unpublished.

Public certificate issuance, ARM execution, production capacity and external-proxy platform imports require separate evidence. A successful local readiness check is not a completed public deployment. The current setup work is tracked in [issue #6](https://github.com/Ten98-IO-Company/ten98-monitor/issues/6).

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

Use an isolated checkout, new Compose project name, empty database/artifact volumes and a different loopback port. Restore the saved configuration privately, changing only deployment metadata and the test origin/port; retain its original secrets and keyring. Do not regenerate them. Start only PostgreSQL, restore the dump with `pg_restore --exit-on-error --no-owner --no-privileges`, and unpack artifacts into the new artifacts volume while app writers remain stopped. Never restore over an existing production database. Apply only migrations belonging to the chosen image, then start web/worker and run readiness plus worker diagnosis.

Verify login, workspace access, known projects and event counts against the saved installation. Restore certificate state only when deliberately moving the original public host; an isolated drill should not request certificates for that live domain. Current foundation workers make no paid calls. Future versions with imports, outbound email or tag publication must use their documented pause procedure before restoring; this helper does not invent a generic restore-safe switch.

A backup is not verified until this separate restore succeeds. Record the tested version/date, observed checks, backup destination/retention and any unverified modules; do not publish the backup itself.

## Observed validation

Checked on 2026-10-13 using Docker Desktop's Linux amd64 engine 29.8.1 and Compose 5.5.1. The source image built successfully. Forty unit tests passed in Linux, followed by the added host-script failure-path regression (all nine setup tests passed). Fresh and repeated migration, web/worker readiness, configuration-preserving refusal, occupied-port detection, offline pinned Caddy configuration, and a real Caddy-to-web request on an isolated network passed. Synthetic database records restored into a separate empty database; an artifact archive restored into a separate empty volume.

The POSIX script passed shell syntax and offline failure-path checks; its complete real-host orchestration has not been exercised on Linux/macOS. The native Windows Docker sequence was exercised instead. No public certificate was requested, no production data was used, and these results do not establish an off-host disaster-recovery drill or application capacity.

Kimi task DKR-SETUP-01 drafted the dependency-free helper and tests from a supplied public contract with only the reviewed Ponytail Skill tool. CLI 2.1.1, K3-256k, thinking enabled and maximum-effort override; 277.56 seconds within a 480-second deadline, no repairs. Quota/token delta is unavailable. GPT corrected a false-positive test catch, added host-script failure checks, reviewed the code and independently ran validation. Kimi had no shell, file, network, deployment or publication tools.
