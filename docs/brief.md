# Accepted brief and prompt critique

Planning baseline: 2026-10-12. The brief below records the original planning request. The owner subsequently authorized coding; the repository now contains a [working development build](foundation.md). Historical instructions limiting that planning task to documentation do not limit the current implementation work.

## Why the original prompt needed refinement

| Ambiguity | Resolution |
|---|---|
| Product names could refer to unrelated projects | Deployment notes identify elmohq/elmo, umami-software/umami, and every-app/open-seo |
| “Fork three apps” could mean three dashboards or one product | One application, login, workspace/project model and navigation; selectively reuse attributed MIT source |
| “All capabilities” had no version or acceptance boundary | Pin the deployed versions; inventory source-visible capabilities, including API/MCP and hosted-mode functions; require full parity for V1 |
| An MVP could silently remove requested capabilities | User explicitly selected full parity from the first usable release; milestones are internal only |
| Open source could be confused with free third-party data | MIT app; operator-owned OpenRouter/DataForSEO credentials, visible costs and spending limits |
| Docker alone does not establish portability | Native production runtime, persisted state, migrations, browser options and tested restore; no mandatory cloud emulator |
| “Use Kimi as much as possible” had no ownership or safety boundary | Kimi handles bounded routine work; GPT owns planning, design, complex decisions and final validation |
| Private deployment evidence could leak into a public repository | Publish generalized lessons and provenance filenames, never source operational logs, secrets or infrastructure identifiers |

No dedicated prompt-improvement skill was found in the available catalog or searched local skill directories. This critique uses requirements, constraints, evidence and acceptance criteria; it does not claim to have invoked a nonexistent skill. Ponytail guides reuse and scope; REA guides evidence; UX Flow Wireframer and Frontend Design guide the interface; Cloudflare and Cloudflare Email Service guide the optional provider paths.

## Improved executable brief

Plan **ten98-monitor**, a fully open-source MIT application combining the complete user-capability union of Elmo 0.4.4, Umami 3.4.0 and OpenSEO 0.1.12. Trace pinned source from interface through authorization, jobs, data and results. Distinguish observed implementation, deployment experience, proposed design and unverified runtime behavior. Preserve third-party notices and check the actual dependency graph before copying code.

Deliver a source-backed parity matrix, one coherent UI and user-flow specification, stack and data model, provider contracts, Docker operations plan, deployment-gap analysis, migration strategy, milestones, acceptance gates and a Kimi development policy. Create a new public repository under the existing Ten98 organization. Do not implement or deploy the app in this planning task.

Full parity is a V1 gate. Internal milestones do not authorize a reduced public release. Include source-visible shared reports, teams, advanced analytics, session replay, heatmaps, local SEO, agent/assistant workflows and programmatic interfaces. Treat unsupported or inaccessible upstream behavior as an explicit discovery item, never as a completed feature.

Support multiple workspaces, teams and roles, local login and optional generic OIDC. Use OpenRouter and DataForSEO as primary BYOK providers. Offer a bundled browser worker or Cloudflare Browser Run, optional Cloudflare AI Gateway, and SMTP or Cloudflare Email Sending REST for alerts. Cloudflare is optional; no commercial feature gate in the application.

Use Kimi K3 through the user's individual subscription for routine implementation, documentation and tests written from GPT-approved criteria. GPT owns planning, architecture, design, complex/security-sensitive tasks and independent final testing/review. Restrict Kimi tools and filesystem access, supply only public or sanitized context, limit retries and work duration, record available usage, and disallow autonomous publishing/deployment/account operations.

## Decisions confirmed by the owner

- First usable release: full feature parity across all three references.
- Identity: multiple workspaces, teams, roles, local login and optional OIDC.
- Primary data/model services: DataForSEO and OpenRouter with user-owned credentials.
- Browser execution: local bundled worker or Cloudflare Browser Run.
- AI routing: direct providers or optional Cloudflare AI Gateway.
- Email: standard SMTP or Cloudflare REST sending.
- License/distribution: MIT, public source, Docker deployment selected by the operator.
- Commercial scope: free, fully featured for everyone; no SaaS subscription sales, seat limits, payment checkout or application feature paywalls. Provider spending and workspace budgets remain.
- Development: authenticated individual Kimi subscription; entitlement and quota must be checked in the operator's account. Personal subscription details and quota history do not belong in the public repository.

## Accepted tracking and domain extension

The owner subsequently requested one centrally managed header snippet that injects providers' own browser tags, with browser-to-vendor traffic rather than mandatory server event middleware. They confirmed extending this plan/backlog only. V1 includes Meta/Facebook, GA4, Google Ads, Cloudflare Web Analytics, TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X, plus separate read-only report imports from their supported APIs.

Add canonical domains, additional serving domains and redirect aliases. The requested example groups crystal-group.ae, crystalgroup.ae and cre.sh under crystal.re; actual ownership/redirect behavior remains unverified. Measure HTTP redirects through configured server/edge sources, not imaginary alias pixel execution, and preserve separate GSC/backlink scopes.

The [refined prompt and specification](tracking.md) define the complete addition. P70–P81 are new V1 requirements; no original parity requirement is removed. Advertising CAPI middleware, campaign editing, arbitrary custom tag execution and automatic DNS/redirect edits are outside this addition.

## Accepted setup refinement

The owner chose native platform integrations after evaluating Zernio and requested a critique and easier deployment, identity and account-connection flows. The [setup design](onboarding.md) separates host installation, instance OAuth app registration, workspace authorization and browser tag publication. It adds a resumable first-result journey, tested OIDC activation/recovery, operator handoffs and measurable usability gates. These refine existing requirements and preserve all 81 V1 rows. Optional business-outcome/social-reporting additions from the earlier discussion are not adopted by this decision. No installer or application is implemented in this planning task.

## Remaining function decisions

These do not prevent a full plan. Ask before implementing the dependent feature.

1. The pinned deployed versions also matched the latest upstream release tags when checked on 2026-10-12. Keep this explicit comparison baseline; newer upstream features require a baseline decision rather than silently following main.
2. Subscription sales are explicitly excluded by the owner. Preserve full technical capabilities, branding and provider usage/budgets; do not reproduce upstream SaaS payment or entitlement restrictions.
3. Choose expected event/replay volume, retention and deployment recovery targets. Preserve baseline language selection, locale formatting and RTL behavior; any reduced language set needs an explicit scope decision. Proposed test workload is in the roadmap, not a capacity guarantee.
4. Choose default alert thresholds/recipients and whether client-facing custom domains are needed beyond revocable shared reports and branding.
5. Choose which historical datasets must migrate. Existing applications remain available until reconciliation and rollback checks pass.

## Method and completion boundary

The [REA skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) routes complete source repositories to normal repository inspection. That route was followed. No binary decompilation, REA runtime capture, live product test, paid provider test, or application implementation is claimed here. The research ledger records representative traces and remaining discovery work.
