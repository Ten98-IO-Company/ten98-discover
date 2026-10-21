# ten98 Discover

Common architecture and server mechanisms are maintained in [ten98-code-system](https://github.com/Ten98-IO-Company/ten98-code-system). `pnpm check:architecture` validates the installed shared contract; the normal test and build commands include it.

SEO, AEO and GEO intelligence, combined with web analytics in an MIT-licensed, self-hosted application. The app is free and fully featured by design; external data/model providers may charge.

**Status: development foundation; not a V1 release.** Full source parity, additional platform integrations and operational acceptance remain in progress. See the [current implementation and release gaps](https://wiki.ten98.io/s/ten98-docs/p/release-status-vBt9k2HJBg) and [81-requirement register](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5). No release image is published.

## Documentation

[ten98-monitor in Docmost](https://wiki.ten98.io/s/ten98-docs/p/ten98-monitor-0oQB5fKF1h) contains product scope, research, design, user flows, delivery plans and historical acceptance records. Runnable setup, current code/security contracts, required notices and AI guardrails remain in this repository. The [latest UI checkpoint](https://wiki.ten98.io/s/ten98-docs/p/ui-redesign-acceptance-through-r04-p2uXBbp8rZ) records its incremental validation and remaining work.

The product and repository are named ten98 Discover (`ten98-discover`). Existing Docker image identifiers remain `ten98-monitor`. Keep the existing Compose project name when upgrading to reuse its volumes.

## Run with Docker

From a checkout of the version you intend to run, with Docker and Compose installed:

```sh
sh scripts/deploy.sh local http://localhost:3000 3000 ten98-monitor
```

Open the configured address and use the privately generated bootstrap token to claim the owner account. Follow [Docker setup](docs/docker-setup.md) for the shared POSIX shell procedure (including Windows through WSL2), HTTPS, backups, safe reruns and upgrades. This is a source-built development deployment. The [foundation runbook](docs/foundation.md) covers native development, migrations and current limitations.

## Code and contribution

For current contributor scope and accepted owner decisions, read [Codex continuation](CLAUDE.md).

- [Contributor ownership and guardrails](AGENTS.md), [Kimi/GPT workflow](docs/kimi-workflow.md).
- [Implementation and security contracts](docs), including [tracking and measurement](docs/tracking.md), [Google imports](docs/google-reports.md), [rank tracking](docs/rank-tracking.md) and [AI insights](docs/ai-insights.md).
- Boundary contracts: [explicit identity links](docs/explicit-identity-links.md), [Sessions and Journeys navigation](docs/report-navigation.md), and [static audit admission and pacing](docs/site-audit-policy.md).
- [Third-party provenance and complete license notices](THIRD_PARTY_NOTICES.md). This is an independent combined project, not an official product of the upstream projects.

With Node 24 and pnpm 11.19.0 installed:

```sh
pnpm typecheck
pnpm test
pnpm check:plan
pnpm build
```

`pnpm typecheck` checks application TypeScript, the maintained tracker and destination scripts, and temporary views of the replay and performance adapters derived from their served bundles. The adapter check verifies pinned vendor bytes and wrapper boundaries, maps diagnostics back to the served files, and removes its temporary inputs. Builds and source CI run this check through the normal typecheck command.

The documentation check validates local links/fences, the no-tool Kimi profile and a pinned Docmost requirement reference with 81 frozen IDs. It does not authenticate to Docmost or certify current remote content or feature completion. See the foundation runbook for integration-test isolation and evidence limits.

Licensed under [MIT](LICENSE).
