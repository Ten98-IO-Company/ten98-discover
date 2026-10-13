# Research and audit interface integration

Implemented for [#35](https://github.com/Ten98-IO-Company/ten98-monitor/issues/35), joining the existing [keyword](keyword-research.md), [prompt execution](prompt-execution-ui.md) and [Site Audit](site-audit-ui.md) contracts. Synthetic production-browser acceptance passed on 2026-10-13. This development increment does not complete V1 parity.

The interface follows the [recorded upstream patterns](interface.md): persistent project context, compact result tables, and focused evidence views. It uses the existing React application and styles without a new component framework.

## Entry points

| Navigation | Deliberate flow | Return path |
|---|---|---|
| Research → Keywords | Choose market and inputs → Prepare quote → Review exact keywords and USD amounts → Run quoted research | Inspect saved runs and retained results; an owner can open Providers and spending with the workspace/project preserved |
| Research → Prompts | Review a saved current or historical version → Get quote → Start one or two paid requests | Back to library preserves filters and loaded pages, rechecks access, and restores the invoking control's focus when available |
| Measure → Site audits | Choose eligible origin, entry path and page limit → Start or explicitly queue a static audit → Inspect findings/pages/evidence | Back to results and audit history; links to domain setup and data retention when permitted |

Saving a prompt or loading any screen does not authorize provider work. Prompt execution uses an immutable saved version, including when a tracking preference is disabled. Archived prompts remain readable and cannot start new runs. Unsaved edits use the library's existing discard confirmation.

## Recovery and evidence

Lost start acknowledgements keep the original request identifier and body for a deliberate identical retry. An expired quote does not prohibit recovering a start that may already have been accepted. A normal new start still requires a valid quote and current server-side spending/access checks.

Current access failures clear protected results and mutation controls. Project/account changes remount the panels; request generations and cancellation prevent old responses from repopulating another selection. Polling reads saved status only and stops at terminal states. Network errors, empty results, expired payloads, partial coverage and unknown charges have separate messages.

Costs retain the server's decimal USD strings. Missing metrics are unavailable rather than zero. Provider/model answers and copied crawl content render as text; any offered citation links require an explicit click and a validated web URL. A completed bounded audit is not a claim that the entire website was crawled or indexed.

## Validation boundary

TypeScript, production build, navigation allowlist/role regression checks, the fixture guard regression and the plan/link check pass. GPT ran the [public browser harness](../tests/research-ui/README.md) sequentially against a separate local PostgreSQL database and the production build, then inspected desktop and 360px screenshots. Actual routes, queue receipts and worker handlers were used; provider fetch and native crawl transport were contained synthetic replacements. Browser requests outside the application origin were blocked, and no unexpected provider fetch was observed. No paid requests, public crawls or customer data were used.

| Surface | Passed evidence |
|---|---|
| Keywords | Overview and ideas limits 25/50/100; exact cost and missing/zero metrics; one receipt per explicit intent; lost/503/malformed acknowledgements through quote expiry; double clicks; held-poll cancellation; owner charge reconciliation; current 403/404 purge and stale project response isolation; retained evidence expiry; selected-result focus and responsive tables |
| Prompts | Immutable current/historical versions; disabled versus archived behavior; dirty-draft confirmation; library filters/pagination/return focus; one/two-model messages; safe plain answers/citations; known and uncertain charges; lost/503/malformed starts through expiry; queued cancellation during a held poll; current and stale permissions; reconciliation, observed-empty answers and raw-result expiry |
| Site audits | Eligible serving origins and excluded redirect aliases; explicit queueing; actual robots/HTML/graph worker; partial coverage and findings; page/incoming/outgoing evidence and focus restoration; an earlier-launched read observing later expiry; no resurrection from older evidence; lost/malformed starts and double clicks; held-poll cancellation; current permissions and stale project responses; confirmed deletion; desktop/360px layouts |

Initial harness failures came from reading a prior result before a retry completed, expecting HTTP 200 instead of the research endpoints' documented 202, and matching a cell without its additional resource text. The checks were corrected to the actual contract and rerun with fresh named actors, preserving failed fixtures. Independent review also found and closed a test-only database URL override: query options/fragments are rejected before connection. Syntax-only checks are not counted as browser acceptance. Live provider compatibility, production capacity and accessibility certification remain unverified.

The existing 81-row release register stays intact. Additional keyword sources and saved keyword sets, broader model/cache/scheduling/visibility work, rendered/protected audits and Lighthouse remain V1 requirements; this UI increment must not be described as full parity.
