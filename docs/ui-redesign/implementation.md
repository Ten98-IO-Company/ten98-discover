# Bounded Kimi implementation batches and acceptance

Prepared 2026-10-13; completed 2026-10-14 local time. Parent reports P18 committed at 83046bde225de32a7ea875d80799daffc92336a1 with current citation presentation/controller checks passing. That is the proposed isolated UI baseline. This document is an execution contract proposal; no application implementation occurred in this audit.

## Ownership and dispatch

User authorized the redesign and Kimi implementation. No additional user approval is implied by these internal design gates. Parent GPT creates the dedicated issue/checkout, approves each exact source/props contract, reviews any public-intended prompt, dispatches verified Kimi K3 maximum thinking, and independently validates/apply/publishes under existing authorization.

Kimi receives only the current batch's reviewed public/sanitized files and contract. No host checkout paths, production/customer data, real IDs, credential-bearing fixtures, unrelated source or private operational logs. The first task uses the self-contained brief and needs no app source. Text-only Kimi is sufficient for drafts; GPT applies them. Tool-enabled work requires the repository's actual isolation guarantees, not just a prompt.

Default per-batch limit: 15 minutes, at most two repair attempts, then stop with evidence. A narrower brief limit wins (token brief: 12 minutes and one repair). No automatic continuation, model fallback or scope expansion. Later rows below are separate dispatches, never one giant “redesign everything” task.

Do not parallelize writers to the same CSS or source file. Feature development remains in its own checkout. Kimi cannot approve its own implementation or weaken acceptance. Test-harness changes remain GPT-owned unless a distinct test-writing task supplies the independent behavior specification.

## Global immutable boundaries

- No server/API/DB/migration/job/auth/financial/collector changes in presentation batches.
- No new dependency, route framework, chart engine, data fetching layer, component generator or universal page abstraction.
- No removal of existing fields, state branches, controls, capabilities, validation, cancellation/retry paths, source qualifications, receipt links or exports.
- No handler runs merely because a tab/disclosure opens. All mutating/paid/publish actions remain explicit.
- Keep exact callback signatures and DTO field meanings. Presentation must not reinterpret formatted strings, monetary units or missing data.
- Do not replace canX with a role guess. Guard current capabilities inside event handlers as well as disabled/hidden controls.
- Do not change request IDs, revision checks, abort controllers, mounted/session/workspace/project generations, reconciliation, route canonicalization, OAuth URL validation, proof handling or expiry.
- Never persist secrets, proof/invitation capabilities or raw provider responses in a URL, client storage, fixture or public prompt.
- Do not enable a dark production setting until all affected color rules pass independent theme validation.
- Do not advertise a planned function as a working disabled button. Keep missing capability status in release documentation or an honest informational area.
- Do not alter the preserved live preview or reuse its database for tests.

## Wave 1 — system and shell

| Batch | Exact file allowlist | Contract and bounded outcome |
|---|---|---|
| T01 | src/design-tokens.css; tests/design-tokens-preview.html | Follow kimi-01-tokens.md exactly. New isolated tokens/specimen only. No production import. |
| T02a | src/styles.css | Follow kimi-02-global-css.md. Import accepted tokens once, install legacy aliases and migrate shared primitives. Preserve authored categorical tag colors. No JSX or visibility changes. Can draft concurrently with T01; land only with accepted tokens. |
| T02b | src/components/analytics.css | After T02a lands, migrate analytics-only rules to the same tokens. Keep selectors, responsive grids, charts and semantic behavior. Light production only. |
| N01 | src/routes/index.tsx; src/styles.css | Reorganize existing navigation JSX into six families plus settings/account/operator areas. Keep all 28 existing view keys and links. Native selectors, active state, mobile navigation and one content shell. Do not change navigation.ts, event handlers, effects, auth forms or panel props. |
| N02 | src/routes/index.tsx; src/styles.css | Compact project header, remove duplicate decorative footer prose while retaining development status, add skip link if absent, improve installation/events layout. Keep snippet source/copy fallback, actual received-event data and worker diagnostic actions. Do not touch owner/sign-in/factor forms in this batch. |

N01 does not add a new Connections API, route key, client cache or readiness status. A navigation-only Connections index requires a separate approved small contract. Google remains reachable under Reports until its presentation is safely separated.

N01/N02 changes to the large index file must be restricted to approved JSX/presentation ranges. GPT checks a diff against the baseline to ensure helpers/effects/security blocks stayed byte-equivalent. If the rewrite needs controller changes, stop and split it.

Acceptance for T02a/T02b/N01/N02:
- Existing TypeScript/build checks.
- Existing tests/navigation.test.ts and tests/navigation-browser.ts, run against isolated synthetic state.
- All 28 view keys have a reachable route or authorized settings entry; hidden unavailable role actions do not appear through grouping.
- Reload, browser Back/Forward, new tab, malformed/foreign scope, capability removal, session switch, failed project list, delayed list/create and callback priority still pass.
- Desktop 1440×900: selected workspace/project, family, title and first relevant result fit. Mobile 360/320px: no page overflow; Menu opens/closes by keyboard, active family exposed; main focus is visible after navigation.
- No screenshot/fixture data added to production.

## Wave 2 — presentation-only views already separated from controllers

Each row is a separate task. New CSS is local to its view family and uses semantic tokens. Do not create it until the first approved consumer needs it.

| Batch | Exact file allowlist | Frozen props/capability contract |
|---|---|---|
| A01 | src/components/AIInsightsView.tsx; src/components/ai-reports.css | AIInsightsViewProps and AIInsightsDraft unchanged. Preserve role/reading/exporting, dirty/filterError, canApply, prompt paging, report.canDrill/canExport, execution paging, onOpenExecution and cancel export. |
| A02 | src/components/AIComparisonView.tsx; src/components/ai-reports.css | Existing AIComparisonViewProps unchanged; equivalent-cell/coverage semantics and every drill/export callback retained. |
| A03 | src/components/CitationAnalysisView.tsx; src/components/ai-reports.css | Existing CitationAnalysisViewProps and screen discriminants unchanged. Preserve report/evidence/task branches, per-action capabilities, uncertainty/conflict/retry, category/tracking validation and safe source links. |
| M01 | src/components/MetaConnectionView.tsx; src/components/meta-views.css | MetaConnectionViewProps unchanged: connections/account/disconnect, current owner rule, discovery states, canChoose/canReconnect/canDisconnect, account selectability, canCheck/canConfirm, remote revoke, unknown-write retry/restart. |
| M02 | src/components/MetaAppView.tsx; src/components/meta-views.css | MetaAppViewProps unchanged; operator capability, registered callback, write-only credential input, test/enabled state, unknown-write and rotation/disable outcomes retained. |
| M03a | src/components/MetaImportView.tsx; src/components/meta-views.css | MetaImportViewProps unchanged: source/import/row paging, canImport/canCancel/canRetrySame, role, reading/writeState, receipt and expiry distinctions. |
| M03b | src/components/MetaLatestView.tsx; src/components/meta-views.css | Existing props unchanged: complete-day eligibility, gaps, source/date/currency/attribution and export capability remain. No summing inconsistent snapshots. |
| M03c | src/components/MetaCampaignView.tsx; src/components/meta-views.css | Existing props unchanged: retained inventory includes no-activity campaigns; configured/effective status distinct; paging/export scope retained. |
| R01 | src/components/RankTrackingView.tsx; src/components/rank-views.css | RankTrackingViewProps unchanged; selected tracker, capabilities and entry callbacks preserved. No paid action hidden behind navigation. |
| R02 | src/components/RankCheckView.tsx; src/components/RankCheckResults.tsx; src/components/rank-views.css | Existing quote/review/start/result props unchanged. Exact currency/reservation, unknown charge, outcome and cancellation text stays at the decision point. |
| R03 | src/components/RankHistoryView.tsx; src/components/rank-views.css | Existing comparisons and per-keyword eligibility preserved; failed/not-ranked/unavailable remain different. |
| R04 | src/components/RankReportingView.tsx; src/components/rank-views.css | Existing report filters, distributions/matrix and scope-aware export unchanged. |
| R05 | src/components/RankScheduleView.tsx; src/components/rank-views.css | Existing owner-only approval, maximum spending, cadence/timezone, skipped occurrence and pause/recovery capabilities preserved. No schedule automatically enabled. |

UI changes:
- Compact toolbar; applied scope visible; draft filters in a native disclosure when appropriate.
- Results before full methodology. Consequential partial/expired/incomparable/source warnings stay visible.
- Table-oriented rows; no card per metric. No rewritten or newly inferred data model.
- On empty dataset, an appropriate next action replaces useless blank selects/pager scaffolding, but existing controller branches remain meaningful.
- Local panel headings may be visually shortened/renamed only when accessibility/tests agree. Do not add an embedded prop to every view or remove a focus ID without a separate approved contract.

Use existing matching acceptance harnesses:
- tests/ai-insights-view-browser.mjs and tests/ai-insights-browser.mjs
- tests/ai-comparison-view-browser.mjs and tests/ai-comparison-browser.mjs
- tests/citation-view-browser.mjs and tests/citation-browser.mjs
- tests/meta-connection-view-browser.mjs and tests/meta-connection-browser.mjs
- tests/meta-app-view-browser.mjs and tests/meta-app-browser.mjs
- tests/meta-import-view-browser.mjs and tests/meta-import-browser.mjs
- tests/meta-latest-view-browser.mjs and tests/meta-latest-browser.mjs
- tests/meta-campaign-view-browser.mjs and tests/meta-campaign-browser.mjs
- tests/rank-tracking-browser.mjs, tests/rank-check-browser.mjs, tests/rank-history-browser.mjs, tests/rank-reporting-browser.mjs and tests/rank-schedule-browser.mjs

Run only the harness(es) relevant to changed behavior plus required type/build checks. Reuse their independent capability/negative cases; do not replace them with screenshots alone.

## Wave 3 — existing combined panels, one focused presentation task at a time

These files contain behavior and markup together. GPT must read the whole current panel and every caller, freeze the controller ranges, and supply the exact approved render-only change before dispatch. Do not perform an automatic controller extraction merely to reuse visual markup.

| Batch | Exact file allowlist | Preservation/acceptance focus |
|---|---|---|
| V01 | src/components/AnalyticsPanel.tsx; src/components/analytics.css | Existing real metric definitions, range controls, unknown visitor/session coverage, chart table alternative and native-analytics-browser.ts. |
| V02 | src/components/ExplorerPanel.tsx; src/components/explorer.css | Add scoped CSS only if needed; typed property/date/timezone semantics, CSV, paging; explorer-browser.ts. |
| V03 | src/components/ConversionsPanel.tsx; src/components/AnalysisCriteriaFields.tsx; src/components/conversions.css | Saved definitions and all property/match operators; no lost JSON/null/missing semantics; conversions-ui/browser.mjs. |
| V04 | src/components/KeywordResearchPanel.tsx; src/components/keyword-research.css | Quote/market/draft/results/paid lifecycle; research-ui/keyword-browser.mjs and keyword-lifecycle-browser.mjs. |
| V05 | src/components/SavedKeywordsPanel.tsx; src/components/SavedKeywordFilterFields.tsx; src/components/saved-keywords.css | Selected vs filtered export/delete scope, tag/editor/viewer capability; saved-keywords-ui/browser.mjs. |
| V06 | src/components/SavedKeywordRefreshPanel.tsx; src/components/saved-keywords.css | Exact quote/run/recovery states, refresh target scope and durable results; relevant saved-keyword acceptance. |
| V07 | src/components/PromptsPanel.tsx; src/components/prompts.css | Authoring, versions, archive/restore, tags and explicit entry to execution; research-ui/prompt-browser.mjs. |
| V08 | src/components/PromptExecutionsPanel.tsx; src/components/prompts.css | Quote review, child outcomes, receipts, expiry and cancellation; prompt-receipt-browser.mjs. |
| V09 | src/components/SiteAuditPanel.tsx; src/components/site-audits.css | Existing static-only limitation, safe start/cancel/delete, expired/coverage states and evidence; research-ui/audit-browser.mjs. |
| V10 | src/components/ContextPanel.tsx; src/components/project-context.css | Revision/idempotency/conflict behavior, authored arrays and delete confirmation; project-context-browser.mjs. |
| V11 | src/components/ReportsPanel.tsx; src/components/reports.css | HTML preview isolation, template/report CRUD, immutable share snapshots, expiration/revoke, slugs; reports-browser.ts and reports-ui.ts. |
| V12 | src/components/GoogleReportsPanel.tsx; src/components/google-reports.css | Align existing connection/property/import/history/result layout. Preserve all current handlers and date/report bounds; google-browser.ts. |
| V13 | src/components/GoogleAppPanel.tsx; src/components/google-reports.css | Operator app presentation only; exact redirect URI, secret clearing, state and enabled/testing behavior. |
| V14 | src/components/DestinationsPanel.tsx; src/components/destinations.css | Saved/dry-run/publish sequence, ownership conflict, consent acknowledgment, environment and rollback. destinations-browser.test.ts plus existing destination integration checks as affected. |
| V15 | src/components/DomainsPanel.tsx; src/components/domains.css | Domain role/verification/redirect distinctions, no DNS mutation. domain-collection-browser.ts and domain-redirect-browser.ts. |
| V16 | src/components/AnalyticsSettingsPanel.tsx; src/components/collection-settings.css | Native privacy/exclusions/consent/access, existing native-analytics-browser.ts cases. |
| V17 | src/components/TeamPanel.tsx; src/components/team-settings.css | Membership/invite/ownership controls. Preserve existing security assertions; do not infer new admin powers. |
| V18 | src/components/ProviderPanel.tsx; src/components/provider-settings.css | Owner-only keys, capability and budget display; never readback/display full stored secrets or cheapen paid confirmation. |
| V19 | src/components/ApiKeysPanel.tsx; src/components/api-key-settings.css | Scope/expiry/revoke and one-time secret handling. No copy of secret in notification/log/fixture. |
| V20 | src/components/RetentionPanel.tsx; src/components/retention-settings.css | Preview versus destructive cleanup, lost-access handling and retained protected records; retention-browser.ts. |

Do not create every CSS file up front. If shared tokens/global primitives already solve the visual problem, use only the existing TSX file and skip the new stylesheet. An exact allowlist is a ceiling, not a requirement to touch every file. No wildcard source ownership.

## Wave 4 — onboarding and identity improvements with GPT-owned behavior contracts

Pure presentation can be drafted by Kimi after GPT freezes the behavior. Authentication/orchestration changes and new readiness APIs remain GPT-owned complex work.

| Batch | Exact Kimi allowlist | Prerequisite |
|---|---|---|
| S01 | src/routes/index.tsx; src/styles.css | GPT supplies only the OwnerForm/CreateProjectForm presentation contract and permitted JSX blocks. Setup POST shape, origin validation, secure claim, sign-in/factor/callbacks and create navigation stay unchanged. |
| S02 | src/components/OidcPanel.tsx; src/components/oidc-settings.css | GPT validates the whole draft/test/proof/enable flow and freezes all mutation/URL/proof functions. Scope is provider-list-first presentation and explicitly opening the existing draft form. |
| S03 | src/components/OidcRecoveryPanel.tsx; src/components/oidc-settings.css | GPT supplies exact existing account-recovery/step-up contract and acceptance. Never merge recovery with provider enable or broaden permissions. |
| S04 | src/components/AccountSecurityPanel.tsx; src/components/security-settings.css | Existing password/session/2FA/recovery flows frozen. No changed secret lifecycle or security validation. |
| S05 | src/components/InvitePanel.tsx; src/components/OidcSignIn.tsx; src/components/security-settings.css | Invitation/OIDC display only. Token capture, login/cancel precedence and expiry behavior frozen. |

Proposed outcome chooser, persistent setup progress, unified Connections inventory, split Google controller/view, split operator/account identity routes, URL-preserved feature filters and embedded-heading props are not yet implementation contracts. They need concrete types and tests before dispatch. Reuse current APIs where sufficient; do not fabricate a client-only record of successful configuration.

A first-result chooser can initially be navigation-only after project creation, provided leaving it does not claim setup completion. Route changes or persistence require a separate scoped GPT contract. No monolithic new wizard is authorized here.

## Presentation/capability checklist for each dispatch

The supplied contract should name:
- Exact component export, prop names/unions, required controller callbacks and possible null/empty values.
- Which props are already formatted text and which are exact identifiers.
- Reading/writing/exporting/unknown/conflict states and capability booleans.
- Scope key and cancellation/unmount expectations.
- For each action: enable condition, no-op condition inside handler, callback arguments, and available cancel/back path.
- Loading/error/empty/partial/expired/zero/unavailable/denied rendering.
- Whether an embedded title/focus target is controlled by parent or view.
- Existing harness cases that must remain green and new regression case if behavior changes.

If this cannot fit in a small brief, split the task. A vague “improve UX” prompt is not sufficient.

## Shared browser acceptance

Use a separate synthetic fixture environment and database; never write to the preserved preview. Do not call paid providers or public tag SDKs.

Viewports: 1440×900, 768×1024, 360×800 and 320×800. Light is required before production adoption; dark is required before enabling production dark preference. Include long names/URLs, empty values and an RTL layout fixture.

Visual:
- At desktop size, report title, applied scope, compact metrics/coverage and first data rows appear together.
- At 360px with optional filters/navigation closed, no long setup form precedes the first result summary.
- There is no entire-page horizontal overflow; wide tables have one labelled keyboard-scroll region.
- At least 12px auxiliary text, visible focus and 44px touch targets.
- No duplicate h1, no empty giant card, no “positive” metric invented to fill space.
- Relevant limitations and destructive/paid consequences remain visible.

Behavior:
- Keyboard Tab/Shift+Tab/Enter/Space/Escape operate native controls and return focus sensibly.
- Filter drafts survive disclosure close; Apply alone changes queried data; dirty state is visible.
- Loading/refresh/error preserve exactly the controller-approved state. Unknown mutation never becomes a fresh retry request.
- Each denied/disabled canX blocks handler invocation even when programmatically triggered. Test current capability loss as well as initial role.
- Back and cancel return to meaningful context without starting work. Page navigation preserves authorized scope.
- Export/receipt/evidence links match current scope/snapshot; permissions and expiration cannot be bypassed.
- Zero/empty/unknown/expired/partial/failed fixtures remain visually and semantically distinct.
- 200% zoom, reduced motion and forced-colors still usable.

Acceptance evidence:
- Exact files/commit and brief/model used.
- Type/build result and relevant unchanged baseline harness result.
- New independent check for any nontrivial new state/branch.
- Desktop/mobile screenshots in synthetic environment with states labelled.
- Remaining unknown/provider/production gates, without invented usage savings or full-parity claims.

## Smallest useful start

Run T01 now after parent content/model checks. It demonstrates the visual direction without touching the app or blocking feature development. Accept it, then T02a/T02b and N01 in the isolated UI checkout. Feature-specific presentation waves follow one controller contract at a time. This preserves useful implementation while replacing the repetitive forms and navigation that made the current UI hard to use.


Execution correction: the combined token/specimen draft timed out without code. A single seven-minute token-only repair keeps the batch below its20-minute checkpoint. The optional standalone HTML dashboard is retired as duplicate presentation; independent token probes and existing application fixtures remain required. No standalone-specimen pass is claimed. The separate global CSS and exact navigation-block drafts continue under their own bounded tasks.
