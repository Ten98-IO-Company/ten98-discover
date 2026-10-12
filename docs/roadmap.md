# Delivery plan and release gates

The first usable/public V1 release requires every [parity row](parity.md), all confirmed provider options, and the deployment/security checks. Internal milestones are development checkpoints, not a smaller public MVP.

Implementation started with [issue #1](https://github.com/Ten98-IO-Company/ten98-monitor/issues/1): the [development foundation](foundation.md) provides local owner login, workspace authorization, persisted page views, a durable worker probe and tested local Docker startup. The following security increment implements local/OIDC/2FA, encrypted credentials, scoped keys and spending controls; browser destinations implement part of M2T. Remaining setup, recovery and provider validation keep M1 and the release gates open. No grouped parity row is marked complete by these increments.

[Issue #3](https://github.com/Ten98-IO-Company/ten98-monitor/issues/3) adds workspace/team screens, expiring invitation links, roles, UTC analytics and SPA/custom-event tracking, with transactional upgrades. These implement portions of P01/P02/P27/P28/P32/P33; each grouped parity requirement remains open until all of its sub-capabilities pass.

[Issue #8](https://github.com/Ten98-IO-Company/ten98-monitor/issues/8) adds authored static reports, template briefs and revocable snapshots; [issue #9](https://github.com/Ten98-IO-Company/ten98-monitor/issues/9) adds domain roles and DNS ownership proofs; [issue #10](https://github.com/Ten98-IO-Company/ten98-monitor/issues/10) adds native consent/privacy, typed properties and measured visitor/visit overview. Alias collection, observed redirects, generated reports, advanced analytics and automatic retention remain separate unfinished capabilities. See the current evidence and limitations in the foundation runbook.

## Milestones and dependencies

| Milestone | Work package | Prerequisites | Exit evidence |
|---|---|---|---|
| M0 — freeze comparison and licenses | Confirm pinned versions, enumerate every route/report/tool/adapter under each grouped parity row, classify hosted behavior, finish dependency/asset license inventory | Owner function decisions | Baseline manifest, unresolved list, accepted reuse ledger and license-compatible dependencies |
| M1 — portable foundation | Import audited foundation; one schema/auth shell, workspace roles, local/OIDC/2FA, web/worker/migrate commands, pg-boss, credentials/budgets, artifact storage | M0 | Tracker event + stub queued job + shared screen; tenant attacks denied; clean DB install/restart/migration check |
| M2 — complete analytics | Tracker and recorder, every analytics report/explorer, identities, links/pixels/boards, sharing/export/retention | M1 | P27–P46 fixture results, redacted replay and heatmap, upstream semantic comparison and workload measurements |
| M2T — one-snippet tracking | Browser-direct tag loader, all ten connector entries, consent, mappings, configuration lifecycle and existing-tag migration | M1 + M2 collector contract + TRK-01 | P70–P75/P78 fixtures, real controlled vendor checks, no mandatory advertising event proxy |
| M3 — complete AI visibility | All provider adapters/engines, prompt lifecycle, sampling, evidence, metrics, fan-out, citation research, opportunities and exports | M1 | P11–P26 fixtures and limited configured-provider checks; budgets and error denominators proven |
| M4 — complete SEO | Keywords/domain/backlinks/ranks, static/rendered audits and Lighthouse, GSC/GA4, local SEO, context | M1 | P47–P60 behavior mapping; both browser backends; OAuth refresh/revoke; known crawl graph results |
| M4T — imported reports and domains | Platform reporting connections, source-aware consolidation, canonical/serving/redirect roles, redirect observations and alias SEO | M1 + M4 Google/report contracts + TRK-01 | P76–P77/P79–P80; every named reporting connector verified, alias/visit/backlink overlap fixtures |
| M5 — unified workflows | Assistant, report templates/shares, complete REST/MCP coverage, branding/localization, free full-feature access, alerts/email, provider options | M2–M4 plus M2T/M4T contracts | P01–P10 and P61–P69 reconciled; every tool mapped; SMTP/CF, direct/gateway and role paths checked; no subscription/seat gates |
| M6 — operations and release | Resource/soak tests, accessibility, isolated-browser security, backups/restore/upgrades, multiarch packaging and docs | M2–M5 | Independent GPT release review and reproducible evidence for all rows; no unresolved release blocker |

M2/M3/M4 can progress in parallel after shared contracts stabilize, with separate file ownership and GPT integration review. Shared schema/auth/budget changes remain serialized. Fix shared root causes rather than adding different guards in each module.

Original-scope planning allowance was roughly **20–35 engineer-weeks**, with large uncertainty. It does **not** include the new tracking/import/domain work and is not a current combined estimate or Kimi speedup claim. M0/M1 and TRK-01 must re-estimate using actual adapter complexity, approval lead times and integration throughput. The additional scope cannot be absorbed by silently reducing original V1 parity.

## First implementation backlog

Each row is ready to become an issue after M0; issue creation is not required for this planning deliverable. GPT writes acceptance before Kimi implements routine portions.

| Work item | Owner | Smallest useful deliverable | Required check |
|---|---|---|---|
| Freeze baseline and feature enumeration | GPT | Route/tool/report list attached to parity IDs, license resolution | Every named source capability has a destination/check; no silent hosted exclusion |
| Foundation reuse spike | GPT, Kimi for mechanical edits | One shell, one database, one queue, one tracker event | End-to-end event/job in clean Docker development environment |
| Tenant/auth boundary | GPT | Role matrix and common server authorization path | Two tenants; cross-resource/job/export/share/API/MCP access denied |
| Local/OIDC/2FA | GPT design/review, Kimi bounded forms | Local lifecycle, issuer mapping, session/token revocation | OIDC outage/recovery, partial 2FA token rejection, privilege escalation cases |
| Cost ledger | GPT | Reservation/settlement contract and shared implementation | Concurrent requests cannot oversubscribe app budget; ambiguous paid timeout pauses |
| Collector port | Kimi, GPT contract/review | Tracker ingestion and event persistence | Fresh load, SPA change, malformed payload, public ingress with protected dashboard |
| Analytics query port | Kimi | One parity-defined report at a time | Same original synthetic dataset yields documented expected result |
| Recorder port | GPT privacy design, Kimi mechanics | Masked recorder/transport/player | Sensitive fields absent from stored chunks; authorization; order/loss/retry fixtures |
| Provider adapters | Kimi from approved contracts | One named adapter and stub per task | Success, empty, partial, rate limit, credit failure and uncertain charge |
| Browser isolation | GPT | Local image/egress restrictions and CF adapter | Public fixture renders; redirect/subresource/private targets fail safely |
| Google connectors | GPT OAuth design, Kimi routine flows | Property connection and report mapping | Refresh survives restart; revoke blocks future queries; foreign property denied |
| Email/alerts | Kimi from approved outbox contract | SMTP and CF REST adapters, delivery history | Deduplication, partial recipients, unknown outcome, no silent transport fallback |
| Assistant/MCP | GPT tool security, Kimi mechanical tool mapping | Shared authorized domain calls and evidence | Retrieved prompt injection cannot trigger tool writes/spend; token scope/revocation |
| Provider import/restore | GPT designs/reviews, Kimi bounded transforms | Idempotent native provider report imports and validated ten98 restore instructions | Counts/metrics reconcile and source data stays unchanged; no legacy application history import |

## Tracking, report imports and alias-domain backlog

Scope and improved prompt: [tracking.md](tracking.md). Development now includes draft/preview/publish/rollback, browser loader adapters, native consent settings and a domain ownership registry; their incomplete coverage is recorded in [foundation.md](foundation.md). Reporting imports and domain traffic consolidation remain unimplemented. Each connector is its own bounded implementation task even when grouped below. API approvals and controlled test access are dependencies, not a reason to claim success from fixtures alone.

| ID / requirement | Owner | Deliverable and dependency | Acceptance |
|---|---|---|---|
| TRK-01 / P70–P81 | GPT | Freeze current browser SDK/event/report capability matrix, API scopes/versions, legacy owners, approvals, source licenses and updated estimate | All ten connector entries have explicit supported/unsupported fields, test-account needs and evidence gaps; no obligatory CAPI middleware |
| TRK-02 / P71–P72/P75 | GPT; Kimi routine schema/forms | Config, consent, event identity/trust and read-only endpoint contracts after TRK-01 | Tenant isolation, browser-first/backend-first order cases, public-secret separation and no campaign mutations |
| TRK-03 / P70/P78 | Kimi from GPT contract; GPT lifecycle review | Extend existing tracker with one loader, page-lifetime SDK registry, bounded readiness queues, config preview/publish/rollback | Direct vendor requests, repeated initialization/SPA/revision change, blocked script, withdrawn consent and no fabricated receipts |
| TRK-04 / P73 | Kimi, one connector per task | Meta, GA4, Google Ads and official Cloudflare beacon adapters after TRK-02/03 | Shared Google loader, explicit event maps, auto-injection ownership and controlled provider checks; Cloudflare custom events unavailable |
| TRK-05 / P74 | Kimi, one connector per task | TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X browser adapters | Every named connector passes event/consent/diagnostic checks independently; no placeholders marked complete |
| TRK-06 / P76 | GPT auth/access design; Kimi routine imports | Reuse GSC/GA4 connection patterns for every analytics/ad reporting connector; schedules/cursors/history | Report-only and tag-only setups, endpoint read allowlist, pagination, revoked access, quotas, partial response, restart and idempotency |
| TRK-07 / P77 | GPT metric contract; Kimi tables/queries | Unified source-labeled reporting with explicit account/campaign mappings after TRK-06 | Overlapping accounts/conversions, currencies/timezones, late revisions and missing data reconcile without duplicate totals |
| TRK-08 / P79/P80 | GPT domain/SSRF design; Kimi bounded UI/imports | Domain registry, expected redirects, verification, authenticated redirect observations and server-log/optional CF imports; reuse P44/P53 | Four-domain example, real rendering versus HTTP redirect, safe target checks, query handling, no DNS edits and no request-as-visitor counting |
| TRK-09 / P80 | GPT scope rules; Kimi query adaptations | Alias GSC property and backlink grouping after TRK-08 and M4 | Distinct registered-domain properties, overlapping prefixes, indirect backlinks and summary-only coverage limitations |
| TRK-10 / P78/P81 | GPT independent final validation; Kimi fixture mechanics | Migration walkthrough, accessibility, browser/network checks, privacy and Docker restore/load tests | All 12 tracking acceptance scenarios, zero/one/all-connector overhead, no silent script retry or live test, imports paused and config revalidated after restore |

Kimi receives only approved public contracts, synthetic fixtures and explicit file allowlists. GPT owns consent/security/metric decisions, provider-access interpretation, design and final checks. Real accounts/tokens/customer logs are never supplied to Kimi; initial docs work uses the tools-disabled profile.

## Deployment and onboarding backlog

Owner decision: use native integrations, without Zernio. The [setup critique and flows](onboarding.md) refine existing V1 requirements; they do not change the 81-row baseline or authorize a smaller release. Follow these flows during M1 and connector implementation, rather than treating setup as an M6 documentation task. Any effort estimate must include provider registration/review work and distinguish active work from external waiting time.

| ID / existing requirements | Owner | Deliverable | Acceptance |
|---|---|---|---|
| ONB-01 / P63–P69/P81 | GPT design; Kimi bounded packaging | Versioned release bundle, local/public paths, same-image setup/diagnose and optional Caddy recipe | Tested published artifacts; idempotent secret init, explicit migration, loopback local mode, real HTTPS production event, no host socket or source build |
| ONB-02 / P01–P04/P08/P10 | GPT design; Kimi approved forms | Atomic owner claim, automatic sign-in, default workspace and resumable first-result checklist | No provider/SMTP requirement; returning instance cannot be reclaimed; duplicate submission safe; empty overview usable |
| ONB-03 / P10/P57–P58/P71/P76 | GPT auth; Kimi routine forms | Instance Integration apps and workspace Connections catalogue, native recipes, callback generation and operator handoff | Prerequisite ownership explicit; broad provider permissions disclosed; tenant/callback/asset attacks rejected; current Google Ads access recipe |
| ONB-04 / P57–P58/P76–P78 | GPT contracts; Kimi one connector per task | Authorize/select/review/import/status/reconnect flows for every required source | Selected-account read, partial scopes, empty assets, access review, quota, restart/refresh; reconnection preserves history and never enables pixel |
| ONB-05 / P02–P04 | GPT security; Kimi bounded UI copy/forms | OIDC discovery/draft/test/enable, identity-link/invite proof and recovery | Old policy survives failed test; exact issuer/subject binding; no email-only merge, unexpected admin mapping or SSRF; recovery/offboarding tested |
| ONB-06 / P10/P63–P69/P81 | GPT recovery; Kimi diagnostics UI | Role-aware app/worker/source status, config source precedence, upgrade/restore checklist and redacted diagnostics | Missing key stops safely; no phantom progress; restore pauses outbound work; topology-specific instructions and no volume deletion |
| ONB-07 / P07/P08/P10/P78 | GPT design and independent study; Kimi approved wording | Accessibility and first-time user walkthroughs covering all three setup journeys | All 12 onboarding checks; measured completion/help/time, explicit external waits, keyboard/screen reader/RTL/reflow; targets not advertised before validation |

These packages reuse foundation/auth, native adapter and operations work above; do not implement a parallel setup framework. Core product parity, native provider integration and recovery tests still gate V1. Kimi receives only bounded public contracts/synthetic fixtures; GPT owns architecture, access decisions and final testing.

## Acceptance evidence format

For each parity ID record: named sub-capability, baseline path/version, expected result, implementation path, runnable command, fixture or controlled integration setup, actual result/date/revision, coverage limitations and GPT reviewer. A grouped row passes only when every named sub-capability has evidence.

Retain synthetic provider fixtures in Git with licensing/provenance. Keep private replay/customer data, authentication artifacts and raw production responses out of the public repository. Live checks record a redacted summary and provider/task reference, never credentials.

## Meaningful validation suite

| Boundary | Smallest checks that must fail on a regression |
|---|---|
| Math/semantics | Visitors vs sessions; funnel/retention/attribution windows; currency precision; AI numerator/denominator; zero vs unknown; timezone/DST; matcher version |
| Isolation | Swap workspace/project IDs in UI APIs, MCP, reports, artifacts, jobs and import/export; revoked role/key/session cannot still act |
| Public collection | Valid tracker event accepted without dashboard cookie; invalid/oversized/spoofed input rejected; rate controls; bot/exclusion behavior |
| Privacy | Inputs and blocked selectors absent from captured replay; configured erasure removes all referenced storage; diagnostics redact credentials |
| Durable execution | Duplicate enqueue, worker crash before/after dispatch, cancelled job, rate limit and credit exhaustion; no duplicate paid submission without reconciliation |
| Browser | Redirect to private IP, IPv6/link-local and DNS change, subresource fetch to metadata, oversized/never-ending page; inspect actual container sandbox/egress |
| OAuth | State/nonce/PKCE, refresh rotation, issuer/account linking, revoked token, tenant property scope, restart, expired credential status |
| AI/assistant | Consumer/API labels, actual-model mismatch, absent fan-out; malicious page text cannot change instructions or approve cost/write action |
| Reporting | CSV formula escaping, safe HTML report isolation, accessible chart table, scoped share expiry/revocation |
| Delivery | SMTP TLS, CF queued/bounced/suppressed outcomes, timeout ambiguity and restart; outbox claims never promise exactly-once delivery |
| Browser tags/imports | One page-lifetime initialization, direct vendor traffic, consent before SDK load, external-tag ownership, tag-only/report-only setup, no import write endpoints, distinct SDK invocation and report attribution |
| Alias domains | Safe redirect chain/query checks, exact host scopes, idempotent log records, no pixel on HTTP-only response, separate landing visits and overlapping backlink/GSC scope reconciliation |
| Operations | Cold start, concurrent migration, schema mismatch, 2 installs/DNS isolation, external DB, each storage path, restore with keyring, image rollback boundary |

Normal CI uses stubs and local fixtures, with no paid calls. Controlled external integration runs require configured provider credentials, a small explicit spend allowance and designated test recipients. Do not mark a provider verified from a stub alone. GPT owns the final independent execution and interpretation, even when Kimi wrote the tests.

## Proposed performance and recovery envelope

These are **acceptance targets for measurement**, not existing performance claims. Adjust explicitly after M1/M2 evidence; do not alter them merely to hide failures.

- Test a documented 4-vCPU/8-GB application+database host; browser worker isolated with its own declared resources.
- Seed 10 projects, 1 million retained events, 100,000 sessions and representative report definitions. Drive 50 events/second for 30 minutes while 4 bounded background jobs run. Track collector latency, error rate, DB growth and queue delay.
- Target collector p95 under 200 ms and normal dashboard p95 under 2 s in that stated local network workload; distinguish browser/render/provider latency from local app latency.
- Replay test: 10 simultaneous sampled recordings with payload caps; assert no collector starvation, recover dropped chunks as designed, and measure bytes per recorded minute.
- A 24-hour soak combines health probes, ingestion and bounded retries. Compare steady-state memory after warm-up; investigate a sustained increasing trend rather than accepting restart-as-memory-management.
- Owner-approved retention defaults: raw analytics 90 days, replay 7 days, raw provider evidence 90 days and derived history 1 year. Allow workspace configuration and preview storage implications before changes take effect.
- Proposed small-deployment recovery target: RPO 24 hours, RTO 4 hours. Demonstrate an off-host restore with keys/artifacts; operators can select stricter targets with a different backup schedule.

## Release checklist

1. All 81 requirements (69 original plus P70–P81) and every sub-capability mapped and independently verified; scope changes require explicit owner decisions.
2. All chosen operator paths work: bundled/external DB, local/object storage, local/OIDC, browser local/CF, models direct/gateway, SMTP/CF email.
3. No transitive license or copied-asset blocker; notices/SBOM complete; dependency/runtime versions pinned and reviewed.
4. No open critical/high auth, tenant, browser-escape, secret exposure or data-loss defect; documented limitations do not substitute for required features.
5. Accessibility checks and representative operator/analyst walkthroughs pass with error/empty/loading states.
   Include the [onboarding study and acceptance cases](onboarding.md#implementation-acceptance-and-usability-study); operator registration and third-party approval waits are visible in completion evidence.
6. ten98-monitor backup restoration, schema upgrades and rollback pass. Historical migration from the replaced Elmo, Umami and OpenSEO installations is excluded by the owner; native provider reporting imports still require source reconciliation.
7. Multiarch images and actual Compose configurations verified; documentation starts from an empty host and records supported versions.
8. GPT reviews final code and runs final checks independently. Owner accepts any unresolved business-function decisions before V1 release.

## Planning deliverable checks

This planning repository uses `node scripts/check-plan.mjs` for internal links and the requirement register. GPT also reviews source trace credibility, scope consistency, public-data hygiene and Kimi configuration. These checks do not imply product tests have passed. Kimi's initial text-only smoke task only verifies CLI/model access and the no-tool task profile.
