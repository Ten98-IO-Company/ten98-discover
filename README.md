# ten98-monitor

An MIT-licensed, self-hosted application combining web analytics, SEO and AI visibility monitoring. The app is free and fully featured by design; external data/model providers may charge.

**Status: development foundation; not a V1 release.** Full source parity, additional platform integrations and operational acceptance remain in progress. See the [current implementation and release gaps](https://wiki.ten98.io/s/ten98-docs/p/release-status-vBt9k2HJBg) and [81-requirement register](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5). No release image is published.

## Documentation

[ten98-monitor in Docmost](https://wiki.ten98.io/s/ten98-docs/p/ten98-monitor-0oQB5fKF1h) contains product scope, research, design, user flows, delivery plans and historical acceptance records. Runnable setup, current code/security contracts, required notices and AI guardrails remain in this repository. The [latest UI checkpoint](https://wiki.ten98.io/s/ten98-docs/p/ui-redesign-acceptance-through-r04-p2uXBbp8rZ) records its incremental validation and remaining work.

## Run with Docker

From a checkout of the version you intend to run, with Docker and Compose installed:

```sh
sh scripts/deploy.sh local http://localhost:3000 3000 ten98-monitor
```

Open the configured address and use the privately generated bootstrap token to claim the owner account. Follow [Docker setup](docs/docker-setup.md) for native Windows commands, HTTPS, backups, safe reruns and upgrades. This is a source-built development deployment. The [foundation runbook](docs/foundation.md) covers native development, migrations and current limitations.

## Code and contribution

- [Contributor ownership and guardrails](AGENTS.md), [Kimi/GPT workflow](docs/kimi-workflow.md).
- [Implementation and security contracts](docs), including [tracking and measurement](docs/tracking.md), [Google imports](docs/google-reports.md), [Meta imports](docs/meta-reports.md), [rank tracking](docs/rank-tracking.md) and [AI insights](docs/ai-insights.md).
- [Third-party provenance and complete license notices](THIRD_PARTY_NOTICES.md). This is an independent combined project, not an official product of the upstream projects.

With Node 24 and pnpm 11.19.0 installed:

```sh
pnpm typecheck
pnpm test
pnpm check:plan
pnpm build
```

The documentation check validates local links/fences, the no-tool Kimi profile and a pinned Docmost requirement reference with 81 frozen IDs. It does not authenticate to Docmost or certify current remote content or feature completion. See the foundation runbook for integration-test isolation and evidence limits.

Licensed under [MIT](LICENSE).
