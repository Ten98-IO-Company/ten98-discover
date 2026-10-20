# Codex continuation

Read [AGENTS.md](AGENTS.md), [README.md](README.md) and the relevant [foundation contracts](docs/foundation.md) before editing. Apply the current skill selector and project guardrails. Codex/GPT owns implementation and integration; use fresh bounded workers with disjoint files and independent review. Do not resume archived workers or historical branch instructions.

Discover is a development foundation, not a V1 release. Full first-release parity remains required within the accepted owner decisions below. Use the [81-requirement register](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5), [release gaps](https://wiki.ten98.io/s/ten98-docs/p/release-status-vBt9k2HJBg), current source and owning GitHub issues to select work and verify completion. Historical issue [#207](https://github.com/Ten98-IO-Company/ten98-monitor/issues/207) and its merged changes are evidence, not instructions to repeat completed work.

The [committed preview.9 handoff](https://github.com/Ten98-IO-Company/ten98-discover/blob/7d030e8d1114bb35c626868ee111b3dc4ec4a3fa/CLAUDE.md) preserves the historical validation tables cited by dated audits and migration-test comments. Those results describe their original snapshots, not acceptance of current source.

## Accepted owner decisions

These decisions define scope; they do not establish implementation or acceptance. The latest organic-only decision D12 supersedes earlier advertising-import proposals.

| Decision | Required contract |
| --- | --- |
| D1 — Attribution | With campaign capture enabled and current analytics consent, retain the six bounded raw click IDs (gclid, fbclid, msclkid, ttclid, li_fat_id, twclid), derive Paid ads in pinned Umami order and erase the IDs with their event rows. Preserve consent-epoch rotation and the declared measurement differences in [attribution](docs/attribution.md). |
| D2 — Providers | OpenRouter is the sole V1 LLM transport; DataForSEO ChatGPT is the consumer-surface scraper. No direct OpenAI/Anthropic/Mistral adapters or additional scrapers are required. Preserve the current text-only/web-search boundary. |
| D3 — Accounting | No app-enforced per-connection, workspace, quote or run monetary limits or automatic pauses. Provider wallet refusals are request errors. Keep quotes, idempotent reservations, receipts, reconciliation, usage reporting and the uncertain-charge ledger block. Keep the manual workspace emergency pause; new workspaces start unpaused. Start authorizes every child job; children retain their own time limits and the parent finishes after its last child. |
| D4 — Domain rank | DataForSEO's explicitly labelled 0–100 rank is the only rating. No Ahrefs connector. |
| D5 — Keyword metrics | Local volume/CPC and blended metrics use DataForSEO Google Ads keyword endpoints through the existing quote/ledger path. Keyword research is separate from an advertising-account connector. |
| D6 — Teams and sharing | Project transfer requires the actor to own both workspaces. Send invitations through the configured email transport, with manual links as fallback. Share links remain workspace-owned after creator removal; listings show the creator. |
| D7 — OIDC | Preserve generic OIDC, including discovery, PKCE, claims and sign-out, with Authentik-compatible acceptance. Umami token SSO and claim/group-to-workspace mapping are not V1 requirements. |
| D8 — Onboarding | One quoted OpenRouter site-analysis job fetches through the existing crawl boundary and proposes editable brand, aliases, competitors, pages and personas, accepted through the context CAS flow. |
| D9 — Audits | Rendered audits and Lighthouse use a separate Playwright/Chromium worker image profile with dependency provenance review. Per-audit crawl credentials remain encrypted in the credential vault. |
| D10 — Imports | Keep the planned Cloudflare Web Analytics reporting import. Advertising-platform reporting imports are excluded by D12; retain GSC and every supported GA4 report. |
| D11 — SPA referrer | A page view after pushState carries the previous in-app page origin; the landing view keeps the external referrer. Preserve hostname-only measurement and no private URL/query capture. |
| D12 — Organic scope | Discover provides organic SEO/AEO/GEO, AI prompt discovery and web analytics. It never connects advertising-account campaign tools or imports advertising-platform reports. Those belong in ten98-campaign. Keep all ten unified analytics/conversion destinations, inbound click-ID capture, Paid ads attribution and DataForSEO volume/CPC research. Extend reviewed prompt candidates from authorized organic/first-party evidence; any paid research retains quote and explicit Start. |

## Implementation boundaries

- Import maintained shared mechanisms from @ten98/runtime and presentation from @ten98/ui. Follow the canonical architecture declaration and immutable vendored archives/lockfile; coordinate package and shared-file leases with the integration owner. Keep app authorization, identity, storage and paid-work controllers in their owning layer.
- Keep the flat Measure / Research / Connect shell, authorized project navigation on workspace-wide tools, native consent and authorization, workspace MFA, role/operator separation, drafts and uncertain-save retries, unavailable versus zero, dark/System themes, RTL and accessible 44px controls. Keep native server contracts when applying shared presentation.
- Keep authentication branding noninteractive so it cannot reload away in-memory invitation, reset or factor capabilities; each authentication form supplies its single h1.
- Preserve workspace authorization on every API, MCP, export and worker entrypoint. Public collection remains separate from dashboard login. Never replay an uncertain paid operation; reconcile its original receipt. Never make provider calls during startup or health checks.
- Preserve immutable migration bytes, reset publication fences, exact timestamp precision, retention coverage and native export/share boundaries. Migration/reset/delete checks use fresh isolated synthetic databases, never a real installation. Do not drop/reuse their retained databases or widen host/port admission.
- Preserve test assertions, full groups, deadlines and resource caps. Synthetic component/browser evidence does not establish native authorization, database, provider, compiled-app or release acceptance. Check current source and receipts before carrying an old failure forward or claiming completion.
- Retain THIRD_PARTY_NOTICES.md and upstream licenses. Campaign's common UI was originally inspected from a dated local snapshot on 18 October 2026 without an immutable commit/hash pin; do not describe that historical inspection as exact upstream provenance. Current shared-package adoption requires its own verified immutable inputs.

## Run and verify

Use Node 24 and pnpm 11.19.0 with the existing lockfile and dependencies:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:plan
pnpm build
```

Run affected native/browser/CI gates under [AGENTS.md](AGENTS.md) and the [foundation workflow](.github/workflows/foundation.yml). Windows Vite's optional net-use mapping probe may return ENOSYS only through the exact pinned asynchronous test guard; this does not authorize subprocess execution or broader networking.

Deployment follows [Docker setup](docs/docker-setup.md). Keep the existing Compose project name and volumes on upgrades. Publication/deployment requires the current task authorization and qualified combined-tree checks, not a historical handoff approval.

Check actual prior spend and the current manual pause/uncertain ledger before any authorized live test. Preserve the owner's cumulative allowance; never reset it or confuse it with an app-enforced budget. No secrets, provider payloads, production logs or private synthetic evidence belong in Git. Local retained evidence is ignored; reproduce missing checks on a clean clone rather than inventing results.

Product scope, designs, plans and historical acceptance live in [Docmost](https://wiki.ten98.io/s/ten98-docs/p/ten98-monitor-0oQB5fKF1h) and the owning GitHub issues. Repository documents retain operational/code/security contracts, required notices and active guardrails. The app remains free and fully featured without SaaS billing or paywalls, using hosted-domain slugs for sharing.
