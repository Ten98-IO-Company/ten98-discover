# Docker deployment and operations plan

Status: implementation plan. No application image, working Compose release, or deployment claim exists yet.
The public repository must publish tested configuration only after the corresponding commands and image work.

V1 includes multiple workspaces, teams and roles, local accounts and generic OIDC, OpenRouter and DataForSEO,
bundled browser execution or Cloudflare Browser Rendering (now Browser Run), optional Cloudflare AI Gateway,
and email alerts through SMTP or Cloudflare Email Sending REST. These are release requirements, not deferred ideas.
See [provider options](provider-options.md) for verified service constraints, setup, cost accounting, and test gates.

The [setup critique and operator journey](onboarding.md#flow-a-deployment-to-a-first-result) define local evaluation versus public team deployment, a versioned release bundle, same-image setup/diagnosis commands, default-workspace creation, resumable setup and recovery. Those commands and an optional bundled Caddy recipe must be implemented and tested before publishing install instructions. Optional account configuration belongs in the authenticated UI; deployment-managed values are labeled read-only there. App, worker, public origin and connected-source readiness remain distinct.

## Smallest deployment that supports the product

- One TypeScript repository and one production image, with explicit `web`, `worker`, and `migrate` commands plus bounded operator `setup`/`diagnose` commands; no Docker socket or web-controlled host updater.
- Default Compose: one web container, one worker container, and one PostgreSQL container with a persistent volume.
- Selecting bundled browser execution adds an isolated browser image built from the same repository; the Cloudflare option needs no local browser container.
- The web process serves the UI, authenticated API/MCP, public tracker, and collection endpoints.
- The worker runs scheduled SEO/AEO work, reports, retention, and artifact processing using PostgreSQL-backed jobs.
- No Redis, Kafka, ClickHouse, Kubernetes, or separate identity sidecar is required for the initial release.
- One database belongs to this application. Unrelated applications need not share its database server.
- Store replay chunks, audit screenshots, and generated exports through one artifact-storage interface.
- Default artifacts use a persistent local volume shared by web and worker; an optional S3-compatible store supports external storage.
- PostgreSQL holds artifact metadata and authorization; storage location never grants access by itself.
- Local artifact storage supports the default single-host topology. Multi-host workers require shared object storage.

| Operator choice | Supported shape | Required documentation/check |
|---|---|---|
| Bundled PostgreSQL | Default three-container Compose stack | Versioned volume, persistent secrets, backup/restore |
| External PostgreSQL | Web and worker use an existing database | Supported version, TLS verification, least-privilege roles, migration permissions |
| Existing reverse proxy | Proxy terminates TLS and forwards to web | Trusted proxy settings, external URL, forwarded headers, request limits |
| Optional bundled proxy | Separate documented Compose extension | TLS certificate persistence and renewal; no mandatory proxy dependency |
| Local artifacts | Persistent volume, single host | Capacity limits, backup consistency, permissions |
| External artifacts | S3-compatible bucket | Scoped credentials, private objects, lifecycle/backup configuration |
| Browser execution | Bundled sandboxed browser worker OR Cloudflare Browser Run | Same audit capability contract, enforced egress policy, resource/spend limits |
| Model route | OpenRouter direct OR optional Cloudflare AI Gateway | Server-side credentials, explicit billing route, no hidden fallback |
| Email alerts | SMTP OR Cloudflare Email Sending REST | Verified sender, TLS, per-recipient outcomes, duplicate-safe outbox |

Use one supported PostgreSQL path; adding SQLite would double migration and query validation work.
Do not ship placeholder image coordinates or an untested Docker configuration as an installation method.

## Deployment lessons and product gaps

The evidence IDs below summarize private deployment notes without publishing infrastructure identifiers.
An incident records an event; a reported gap or troubleshooting rule does not establish a local outage.

| ID | Evidence class | Lesson from the existing deployment | Required change and acceptance |
|---|---|---|---|
| D01 | Recorded incident | Scheduled AEO work exhausted a provider balance shared with SEO; the worker was disabled | Reserve estimated spend before dispatch; enforce workspace/module caps and pause on insufficient credit; verify with a failing provider stub |
| D02 | Recorded adjacent-app incident | Generic database service aliases collided on a platform-created shared network | Keep the database private to the stack; document unique platform hostnames where needed; verify two installations cannot resolve each other's database alias |
| D03 | Documented deployed workaround | Three products required different identity proxies, shared accounts, or SSO sidecars | Native local auth and generic OIDC; individual identities, workspace roles, and separately scoped machine credentials |
| D04 | Documented operational gap | Roles and teams required manual changes; disabled identity users retained sessions/API keys | Group mapping where configured, explicit session/token revocation, tenant-isolation checks |
| D05 | Open operational work | Off-server backups were still pending, and encrypted credentials depended on external keys | Backup database, artifacts, and key inventory; prove recovery in a fresh installation |
| D06 | Documented platform behavior | Compose profiles and dependency conditions were not honored; one-shot restart defaults differed | Enforce worker enablement and startup correctness inside the app, with explicit migration command and restart policy |
| D07 | Upstream-reported gap; local mitigation documented | OpenSEO runtime retained memory; deployment imposed a memory cap | Use a native production runtime; exercise repeated health/API requests and job churn, measuring memory after warm-up |
| D08 | Documented integration gap | Interactive proxy auth prevented MCP clients from authenticating | Authenticated MCP/API service accounts with workspace scope, expiry, rotation, revocation, and audit attribution |
| D09 | Documented behavior | Health requests produced full traces; one app sent default personal data to error reporting | Cheap health endpoints; telemetry off by default; optional error reporting with source-side redaction |
| D10 | Documented bootstrap risk | A public default admin or first-user-claims-owner flow required deployment ordering safeguards | No default password; bootstrap requires a one-time operator-held secret before public account creation |
| D11 | Reported gaps, not local incident claims | Docker Search Console token expiry was reported upstream; JavaScript audits depended on an external service | Test OAuth refresh across restart; support an optional local browser worker for JavaScript audits |
| D12 | Documented user-flow gap | Provider settings blocked onboarding, and a stopped worker caused brand-analysis timeout | Manual project/brand creation works without a paid provider; show worker availability before enqueueing optional analysis |

Private provenance filenames, retained only to allow internal traceability:

- D01: `changelog.md`, `apps/elmo/set-up-providers.md`.
- D02/D06: `apps/openship/projects.md`, `decisions.md`.
- D03/D04: `apps/umami.md`, `apps/elmo.md`, `apps/openseo.md`.
- D05: `apps/umami.md`, `apps/elmo.md`, `apps/openseo.md`.
- D07/D08/D11: `apps/openseo.md`; D09: `apps/elmo.md`, `decisions.md`.
- D10: `apps/umami/deploy-openship-project.md`, `apps/elmo/set-up-providers.md`.
- D12: `apps/elmo.md`, `apps/elmo/set-up-providers.md`.

These files are not dependencies of this public repository and their contents must not be copied into it.
Public upstream reports include [memory retention](https://github.com/every-app/open-seo/issues/335) and
[Search Console expiry](https://github.com/every-app/open-seo/issues/269); their status must be rechecked before implementation.

## Image and configuration contract

- Build the application in CI; production startup does not install packages, compile the app, or emulate a cloud platform.
- Publish version tags and immutable digests after amd64/arm64 smoke tests; include license notices and an SBOM.
- Run as a non-root user. Write only to configured temporary/artifact locations; make read-only-root operation a tested option.
- Support an environment variable and a documented file-secret equivalent for sensitive settings.
- Persist the application encryption key/keyring independently of ephemeral containers; never generate a replacement on each boot.
- Validate settings with actionable errors and redacted output. Missing optional-provider keys disable that integration only.
- Document minimum supported Docker/Compose/PostgreSQL versions after testing, plus measured resource usage for a stated workload.
- Set explicit restart policies, image-level healthchecks, stop grace periods, and resource limits in the release examples.
- Make external database, public URL, trusted proxies, artifact storage, retention, and worker enablement explicit settings.
- A fresh install performs no paid requests. Provider validation uses a free endpoint where available and otherwise requires an explicit cost-approved action.

## Startup, migrations, and jobs

1. Validate local configuration without calling paid providers.
2. Retry database connection with a bounded backoff and clear diagnostics.
3. Run `migrate` as an explicit release step, using a PostgreSQL advisory lock to prevent concurrent migrations.
4. Web and worker verify schema compatibility themselves; incompatible schemas keep readiness false and prevent job execution.
5. Start the UI and collection service when the schema is ready; start paid scheduling only after an operator enables it.
6. On shutdown, stop claiming work, finish or release leased jobs within the grace period, and close database connections.

Compose `depends_on` expresses convenient ordering only; correctness does not depend on its health/completion conditions.
The migration command exits after success and must use `restart: "no"` in deployment examples.
For imported Compose environments, test the actual rendered services and runtime settings rather than assume every key survived.

The Openship compatibility guide must cover the documented importer behavior in D06: dropped dependency conditions,
ignored profiles/`env_file`/network declarations/security options/container names, limited healthcheck overrides,
and platform-controlled port publishing. Recheck behavior for the supported platform version.
An application-level scheduler switch is mandatory because a platform can start services whose Compose profile was omitted.

Use durable PostgreSQL job records with leases, attempt counts, next-run times, and idempotency keys.
Claim jobs transactionally; recover expired leases after worker failure. Do not claim exactly-once external delivery.
Retry transient failures with bounded backoff. Authentication failures, depleted credit, and exhausted budgets pause work.
Keep provider request IDs so a timeout can be reconciled before another billable request is submitted.
For providers without idempotency/reconciliation, mark the charge outcome unknown and require a policy decision before retry.
Budget reservations and actual charges must settle transactionally, including partial success and cancellation.

## Authentication and network boundaries

- Ship local accounts, generic OIDC, multiple workspaces, teams, and roles in V1; selecting OIDC must not be required to install the app.
- Bootstrap with an operator-provided, single-use secret. Disable unrestricted registration after owner creation.
- Preserve a documented operator recovery procedure; do not silently expose a login bypass when OIDC is unavailable.
- Apply workspace authorization server-side to UI, API, exports, artifacts, jobs, and MCP resources.
- Keep machine credentials independent of browser sessions; store only verifiable token hashes and display secrets once.
- Expose tracker/collection endpoints publicly while dashboard and management endpoints stay authenticated.
- Public collection validates project keys, event schemas, payload sizes, timestamps, and rate limits.
- A public website key and an Origin header are not proof of identity; treat collected data as untrusted input.
- Replay capture is an explicit site setting with masking defaults, payload limits, retention, and protected playback.
- Do not persist raw IP addresses by default; document the implemented visitor/session method without promising perfect anonymity.
- Bind the app to loopback in the simple host-port example; use a private proxy network when an external proxy is present.
- Never publish PostgreSQL. Do not trust forwarded identity headers from arbitrary clients or rely solely on a network firewall for app authorization.
- Constrain audit/browser-worker egress against private, loopback, link-local, and metadata targets, including redirects and DNS changes.
- Ship both an isolated bundled browser-worker option and Cloudflare Browser Run in V1; document their resources, permissions and costs.
- If a deployment importer drops browser sandbox/network controls, fail that browser mode closed; use a properly isolated Docker service or the selected Cloudflare backend.

## Health, observability, and storage growth

- Liveness checks process responsiveness; readiness checks database/schema and essential local storage without paid provider calls.
- Publish a separate authenticated integration-status view; provider credit failure should not make analytics collection unready.
- Expose worker heartbeat, queue age, failed/paused counts, spend reservations, and storage capacity in the operator UI.
- Emit structured logs with request/job IDs, redaction, and no credentials, raw replay contents, or full provider prompts by default.
- Optional Sentry-compatible reporting and metrics are operator-configured; telemetry and outbound usage reporting start disabled.
- Exclude healthchecks from tracing by default; sample other traces and document retention.
- Set per-project event, replay, artifact, and raw-answer retention. Delete artifact metadata and objects through a recoverable job.
- Make storage pressure visible before disk exhaustion; reject oversized uploads and pause optional captures before harming collection.
- Test memory under idle health probes, steady ingestion, job retries, replay uploads, and audit execution.
- Containers restarting at a memory cap are a failure signal to investigate, not the primary memory-management strategy.

## Backup, restore, and upgrades

Back up PostgreSQL using a supported consistent method, persistent artifacts, deployment settings, and the complete encryption-key inventory.
Keep secret recovery material encrypted with separately controlled access. A database dump alone is not a usable credential backup.
For local artifacts, coordinate a brief write pause or use a documented checkpoint/manifest strategy to align files and database metadata.
For object storage, include object version/lifecycle policies and verify that database references remain recoverable.
Retention must not delete objects needed by retained backups.

The operator selects schedule, destination, retention, and recovery targets; installation docs include an off-host example.
The restore drill provisions an empty instance, restores data and keys, verifies sample events/replays/reports and workspace permissions,
then verifies encrypted provider/OAuth credentials can be read without automatically enabling paid jobs.
Restore also pauses report imports, outgoing email and tag publication until the operator validates the new origin, credentials and configuration epoch; resuming one function does not implicitly enable the others.
Report backup age and the last verified restore; do not equate a successful upload with a tested recovery.

Upgrade procedure: review release/schema notes, take a recoverable backup, pause scheduled dispatch, run migration, start web/worker,
perform smoke checks, and explicitly resume schedules. Prefer backward-compatible schema changes where practical.
An image rollback is allowed only if the database schema remains compatible; otherwise restore the documented backup/checkpoint.
Never remove data volumes in routine restart, update, uninstall examples, or troubleshooting steps without an explicit data-deletion action.

## Tracking and import operations

The [tracking plan](tracking.md) uses the existing web/worker/PostgreSQL topology. Host the versioned loader and bounded-cache public config over HTTPS; only approved pixel IDs/settings may be public. Document CSP/script/connection origins per enabled provider, current unversioned vendor-script limitations, and measured zero/one/all-connector browser overhead. One snippet does not imply one downloaded script.

Report imports have independent concurrency/retention limits and can be paused without disabling pixels. Restore pauses imports and revalidates published configuration with a new epoch before fresh tag initialization. Kill switches and consent revocation must account for active pages and provider automatic listeners; test actual SDK disable/reload behavior.

Redirect alias observation uses existing logs or a deliberately configured redirect handler, with bounded/authenticated imports and no automatic DNS changes. Preserve useful campaign parameters through configured redirects; never count requests as unique visitors or log sensitive query values by default.

## Release acceptance: complete capability target

Incremental milestones may ship, but the release cannot claim combined full parity until the product capability matrix is satisfied.
Deployment acceptance must exercise every required module, including the resource-heavy ones:

- Analytics: page views/events, funnels, journeys, retention, session replay, and heatmaps with real ingestion and authorized playback.
- SEO: keyword research, rank schedules/history, competitor/backlink reports, static and JavaScript audits, and Search Console refresh.
- AEO: prompt schedules, repeated samples, configured engine adapters, citations/mentions, competitors, raw evidence, and opportunities.
- Cross-product: multiple workspaces, teams/roles, unified permissions, spend controls, API/MCP, reports, and email alerts.
- Tracking: one loader, vendor-direct network requests, consent lifecycle, CSP and duplicate-tag ownership; all configured report imports and source-aware totals.
- Domains: canonical/serving/redirect aliases, authenticated server/edge observations, safe redirect checks and non-overlapping SEO/property aggregation.
- Both fresh bundled-DB install and external-DB install; local artifacts and the optional external store.
- Local login and OIDC; revoked sessions/keys; tenant isolation; protected MCP; public collection independent of identity-provider availability.
- Resumable local/public setup, tested OIDC draft activation/recovery, native integration app registration and all [onboarding acceptance checks](onboarding.md#implementation-acceptance-and-usability-study); no blanket one-click-provider claim.
- Worker crash/retry, exhausted credit, missing optional credentials, duplicate enqueue, and deployment with scheduling disabled.
- Migration contention, interrupted migration recovery, supported upgrade path, verified restore, and a cold host restart.
- Vanilla Compose plus the documented deployment-importer target; two side-by-side installs without DNS or volume collision.
- Published images on both supported CPU architectures; bounded memory/storage in a documented load profile; startup without a source build.
- OpenRouter and DataForSEO configured independently; direct and optional Cloudflare AI Gateway routes with explicit BYOK/fallback policy.
- Bundled browser and Cloudflare Browser Run audited against the same JavaScript-rendered test site, including redirect/SSRF cases.
- SMTP and Cloudflare email delivery: sender setup, throttling, invalid credentials, partial outcomes, restart recovery, and unknown send outcome.
- No-cloud-provider core: analytics, local auth, workspaces, reports over stored data, local artifacts and bundled audits work without vendor credentials.

Use one small runnable integration scenario per real boundary and reuse it in release checks; avoid tests that merely restate configuration.
Record the tested version, workload, resource measurements, restore result, and unresolved limitations in each release's deployment notes.
