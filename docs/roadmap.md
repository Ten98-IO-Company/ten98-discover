# Delivery plan and release gates

All implementation below is future work. The first usable/public V1 release requires every [parity row](parity.md), all confirmed provider options, and the deployment/security checks. Internal milestones are development checkpoints, not a smaller public MVP.

## Milestones and dependencies

| Milestone | Work package | Prerequisites | Exit evidence |
|---|---|---|---|
| M0 — freeze comparison and licenses | Confirm pinned versions, enumerate every route/report/tool/adapter under each grouped parity row, classify hosted behavior, finish dependency/asset license inventory | Owner function decisions | Baseline manifest, unresolved list, accepted reuse ledger and license-compatible dependencies |
| M1 — portable foundation | Import audited foundation; one schema/auth shell, workspace roles, local/OIDC/2FA, web/worker/migrate commands, pg-boss, credentials/budgets, artifact storage | M0 | Tracker event + stub queued job + shared screen; tenant attacks denied; clean DB install/restart/migration check |
| M2 — complete analytics | Tracker and recorder, every analytics report/explorer, identities, links/pixels/boards, sharing/export/retention | M1 | P27–P46 fixture results, redacted replay and heatmap, upstream semantic comparison and workload measurements |
| M3 — complete AI visibility | All provider adapters/engines, prompt lifecycle, sampling, evidence, metrics, fan-out, citation research, opportunities and exports | M1 | P11–P26 fixtures and limited configured-provider checks; budgets and error denominators proven |
| M4 — complete SEO | Keywords/domain/backlinks/ranks, static/rendered audits and Lighthouse, GSC/GA4, local SEO, context | M1 | P47–P60 behavior mapping; both browser backends; OAuth refresh/revoke; known crawl graph results |
| M5 — unified workflows | Assistant, report templates/shares, complete REST/MCP coverage, branding/localization, free full-feature access, alerts/email, provider options | M2–M4 contracts | P01–P10 and P61–P69 reconciled; every tool mapped; SMTP/CF, direct/gateway and role paths checked; no subscription/seat gates |
| M6 — migration, operations and release | Importers, resource/soak tests, accessibility, isolated-browser security, backups/restore/upgrades, multiarch packaging and docs | M2–M5 | Independent GPT release review and reproducible evidence for all rows; no unresolved release blocker |

M2/M3/M4 can progress in parallel after shared contracts stabilize, with separate file ownership and GPT integration review. Shared schema/auth/budget changes remain serialized. Fix shared root causes rather than adding different guards in each module.

Planning allowance: roughly **20–35 engineer-weeks**, with large uncertainty, for a complete reused-code integration and hardening effort; this is an estimate, not a commitment or a Kimi speedup claim. M0/M1 should replace it with measured import complexity and throughput. Calendar time depends on team size, integration access, provider budgets, migration volume and scope clarification.

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
| Import/restore | GPT designs/reviews, Kimi bounded transforms | Idempotent import and validated restore instructions | Counts/metrics reconcile and source data stays unchanged |

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
| Operations | Cold start, concurrent migration, schema mismatch, 2 installs/DNS isolation, external DB, each storage path, restore with keyring, image rollback boundary |

Normal CI uses stubs and local fixtures, with no paid calls. Controlled external integration runs require configured provider credentials, a small explicit spend allowance and designated test recipients. Do not mark a provider verified from a stub alone. GPT owns the final independent execution and interpretation, even when Kimi wrote the tests.

## Proposed performance and recovery envelope

These are **acceptance targets for measurement**, not existing performance claims. Adjust explicitly after M1/M2 evidence; do not alter them merely to hide failures.

- Test a documented 4-vCPU/8-GB application+database host; browser worker isolated with its own declared resources.
- Seed 10 projects, 1 million retained events, 100,000 sessions and representative report definitions. Drive 50 events/second for 30 minutes while 4 bounded background jobs run. Track collector latency, error rate, DB growth and queue delay.
- Target collector p95 under 200 ms and normal dashboard p95 under 2 s in that stated local network workload; distinguish browser/render/provider latency from local app latency.
- Replay test: 10 simultaneous sampled recordings with payload caps; assert no collector starvation, recover dropped chunks as designed, and measure bytes per recorded minute.
- A 24-hour soak combines health probes, ingestion and bounded retries. Compare steady-state memory after warm-up; investigate a sustained increasing trend rather than accepting restart-as-memory-management.
- Default proposed retention: raw analytics 90 days, replay 7 days, raw provider evidence 90 days, derived history 1 year; owner must confirm before data retention/deletion becomes active. Preview storage implications and allow changes.
- Proposed small-deployment recovery target: RPO 24 hours, RTO 4 hours. Demonstrate an off-host restore with keys/artifacts; operators can select stricter targets with a different backup schedule.

## Release checklist

1. All 69 parity rows and every sub-capability mapped and independently verified; scope changes require explicit owner decisions.
2. All chosen operator paths work: bundled/external DB, local/object storage, local/OIDC, browser local/CF, models direct/gateway, SMTP/CF email.
3. No transitive license or copied-asset blocker; notices/SBOM complete; dependency/runtime versions pinned and reviewed.
4. No open critical/high auth, tenant, browser-escape, secret exposure or data-loss defect; documented limitations do not substitute for required features.
5. Accessibility checks and representative operator/analyst walkthroughs pass with error/empty/loading states.
6. Restore, migration, rollback and historical-data reconciliation pass; original deployments remain available until cutover accepted.
7. Multiarch images and actual Compose configurations verified; documentation starts from an empty host and records supported versions.
8. GPT reviews final code and runs final checks independently. Owner accepts any unresolved business-function decisions before V1 release.

## Planning deliverable checks

This planning repository uses `node scripts/check-plan.mjs` for internal links and the requirement register. GPT also reviews source trace credibility, scope consistency, public-data hygiene and Kimi configuration. These checks do not imply product tests have passed. Kimi's initial text-only smoke task only verifies CLI/model access and the no-tool task profile.
