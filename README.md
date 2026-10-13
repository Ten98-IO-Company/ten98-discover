# ten98-monitor

An MIT, Docker-first application in development, combining web analytics, SEO research and audits, and AI visibility monitoring.

**Status: development foundation; not a V1 release.** The application includes owner setup, local/OIDC login and authenticator security, multiple workspaces, team invitations and roles, scoped API keys, encrypted provider credentials and spending controls, projects, consent-gated traffic reports and typed custom events, browser destination configuration, static reports with revocable sharing, domain ownership records, configurable retention, project context and a versioned prompt library, and a durable worker check. Docker runs the web app, worker and PostgreSQL, with explicit upgrade migrations. Provider reporting imports, advanced analytics, SEO and AI visibility remain unfinished. No release image is published. See the [development quickstart and limitations](docs/foundation.md).

The first usable release must reach the complete technical capability baseline of Elmo 0.4.4, Umami 3.4.0 and OpenSEO 0.1.12. These source tags match the documented deployment versions and latest release tags checked on 2026-10-12; live image-to-commit equivalence has not been verified. Internal milestones do not reduce that scope. The register now also includes 12 owner-requested tracking, report-import and domain-alias requirements (P70–P81), in addition to the original 69.

## Start here

1. [Accepted brief and prompt critique](docs/brief.md)
2. [Source research and end-to-end traces](docs/research.md)
3. [81-requirement V1 release register](docs/parity.md)
4. [UI, navigation, wireframes and user flows](docs/ui-flows.md)
5. [Architecture, data model and reuse decisions](docs/architecture.md)
6. [Provider and Cloudflare options](docs/provider-options.md)
7. [Docker operations and deployment lessons](docs/deployment.md)
8. [Milestones, acceptance gates and work packages](docs/roadmap.md)
9. [Kimi/GPT development workflow and guardrails](docs/kimi-workflow.md)
10. [One-snippet pixels, platform report imports and alias domains](docs/tracking.md)
11. [Project context and versioned prompt library](docs/project-context.md)
12. [Setup critique, deployment journey and native connection/OIDC flows](docs/onboarding.md)

## Product direction

- One workspace/project model, local login, optional OIDC, team roles, and scoped API/MCP access.
- Guided local/team deployment, resumable first-result setup, native provider app registration and account connection flows; no Zernio dependency.
- Analytics through replays, heatmaps and advanced reports; search research, rankings, backlinks, audits, Google integrations and local SEO; AI prompt sampling, citations, comparisons and evidence-backed opportunities.
- One header snippet centrally loads official Meta, Google, Cloudflare, TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X tags directly in the browser; separate read-only account connections import their reports.
- Canonical, serving and redirect-alias domains share project context while redirect requests, visits and overlapping backlinks retain distinct measurement rules.
- OpenRouter and DataForSEO with operator-owned credentials, cost estimates and spending limits.
- Bundled browser worker or Cloudflare Browser Run; optional Cloudflare AI Gateway; alerts over SMTP or Cloudflare Email Sending REST.
- One portable application image for web/worker/migrations, PostgreSQL, and optional browser/proxy/object storage components.
- GPT leads planning, design, complex work and independent final validation. Kimi K3 performs bounded routine development under [contributor rules](AGENTS.md).

The application is free and fully featured for everyone: no SaaS subscription sales, seat limits or application feature paywalls. External data, model, browser and email providers may charge and impose their own terms. All technical capabilities remain in the release register, including source-visible hosted functions. Subscription commerce is explicitly excluded by the owner. Runtime questions are explicit in the brief and research.

## Reuse and evidence

This is a new combined project, with selective reuse planned from three MIT upstream repositories. It is not an official product of those projects. The prompt classifier selectively adapts Elmo's MIT substring-matching behavior with attribution; remaining application code is original. See [third-party provenance and dependency notices](THIRD_PARTY_NOTICES.md).

Research is static source inspection at pinned commits plus sanitized deployment lessons. Foundation checks do not establish full runtime parity, provider integration, capacity or security certification.

## Check the plan

With Node.js installed:

```sh
node scripts/check-plan.mjs
```

This checks planning files, internal links and requirement IDs. Application checks and their scope are documented in the [foundation runbook](docs/foundation.md); GPT performs independent validation.

Licensed under [MIT](LICENSE). Planning baseline: 2026-10-12.
