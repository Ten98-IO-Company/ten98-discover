# ten98-monitor UI redesign: evidence and decision record

Design date: 2026-10-13. GPT-6 Astra Ultra design record for issue #50. Not a release or implementation claim.

## Boundary and evidence

This audit read the current application checkout at base 5d47eded00c903099c6d988ea9b3eb330f5cedbd, including its in-progress citation changes. It did not modify application source, launch an application, change a database, or inspect credentials. The protected history preview was not mutated. Line references below describe the files as inspected; rebase before implementation because citation work is concurrent.

Reviewed the repository instructions and README, brief, foundation, parity, release-status, UI/onboarding specifications, the navigation parser, shell/auth/project flows, theme/styles, current analysis presentation contracts, Google/Meta connection/import flows, OIDC draft/test/enable flow and destination publish gates. This is a bounded interaction/visual audit, not a complete backend or 81-capability source-contract audit.

Visual evidence inspected:
- AI insights desktop capture from tests/navigation-browser.ts
- AI insights mobile capture from tests/navigation-browser.ts
- Meta reports mobile capture from tests/navigation-browser.ts

These are pre-existing synthetic browser-acceptance captures, not fresh screenshots from the user's live preview. The desktop AI capture is a full page of 1440 × 2462; the mobile capture is 360 × 3556. Their test names/values are fixtures, not customer observations. They establish layout problems, not current live data or completion status.

Reference source pins, verified read-only:
- Elmo: 3c673d0253d01ae030fa41519f62ad7e54f2281b
- Umami: ec0ff50388c264ed8ce46f00967e92f7e71476ae
- OpenSEO: 89e5a00717cdf049b7c2b4e29646edb3a7d4995b
- Actual local reference folder is open-seo, not openseo.

Reference findings are static source observations. The reference apps were not run or visually compared in this audit.

## Main decision

Build a compact analytics and research workspace: a quiet neutral shell, one blue action accent, a clear selected project, a short family navigation, local subnavigation, result-first report pages, and progressive setup forms. Preserve current controllers, permissions, mutation gates, receipt semantics, and recoverable error paths. Replacing their presentation is sufficient; a new component framework, router, data layer, or chart dependency is unnecessary.

Do not build a universal cross-source overview from incompatible metrics. Keep native analytics, imported provider reports, prompt observations, and paid research visibly sourced.

## Current findings

| Priority | Evidence | User consequence | Required change |
|---|---|---|---|
| High | src/routes/index.tsx:501–522 exposes 18 project links; operator app setup sits in Workspace settings at :533–534. | Basic measurement, research, account authorization, and host configuration compete in one long rail. | Use six project families with local pages; separate workspace, account, and instance settings by actual authority. Keep all existing URLs reachable. |
| High | AI desktop/mobile screenshots; AIInsightsView.tsx:78 onward renders the complete date/model/prompt/tag/matcher/search form before results. | An analyst must pass a large setup form before seeing the report. On mobile the report starts several screens below the title. | Show applied range/model and a compact Filters control first. Reveal draft controls on demand. Put metrics, coverage summary and results before methodology details. Preserve every filter and explicit Apply. |
| High | index.tsx:551–554 creates a page h1; AIInsightsView.tsx:66 and MetaImportView.tsx:93 add the same visible title as an h2. | Repeated headings and introductory copy consume space without adding context. | One visible page title; retain a distinct accessible section heading for standalone fixtures. An additive embedded-heading option may be used only in a reviewed contract. Do not remove the controller's focus target. |
| High | AI screenshots show scope, recomputation caveat, snapshot/revision, four explanatory bullets, ten coverage counts and multiple stacked tables. | Honest limitations are present but dominate the hierarchy. | Keep source, coverage, stale/error state and consequential limitations visible. Move full methodology, identities and receipt detail into named disclosures. Do not conceal a restriction that changes interpretation. |
| Medium | Meta mobile screenshot contains an empty source select and two disabled source-page buttons. | Empty state resembles a broken form and provides no focused next step. | Empty source list: “No reporting sources connected” and a role-appropriate connection action. Retain pagination when pages exist; hide inapplicable empty controls while keeping explicit loading/error states. |
| Medium | styles.css:1–9 has 14 variables: colors plus monospace. Most sizes, spacings, surfaces, radii and state colors are literal values. | New feature views drift visually; dark theme cannot be applied reliably. | Introduce semantic tokens, then migrate shared rules and bounded view batches. Keep temporary old-token aliases until every caller is migrated. |
| Medium | styles.css:58 uses 24px card padding with 20px bottom margin; nested cards occur in OIDC, context and destination forms. | Dense workflows become long white-card stacks; relationships are harder to scan. | One panel around a table; dividers and compact rows within it. Form sections use headings or fieldsets, not nested cards by default. |
| Medium | index.tsx:463–466 derives snippet and last-event state; :641 onward mixes installation help, developer API prose and worker diagnostics. | Tracker success and background-worker success can be confused. | Installation should show snippet, consent/origin requirements and received-event evidence. Preserve worker diagnostics in their clearly named disclosure; later relocate to instance operations only when equivalent access exists. |
| Medium | OidcPanel.tsx:457–548 puts callback, provider inventory and a full new draft form together. | Operators face an advanced form even when reviewing an already-working provider. | Provider rows first. “Add provider” or “Edit draft” opens the existing form. Keep successful test proof and explicit enable separate. |
| Medium | GoogleReportsPanel.tsx combines connection creation, property selection, import submission, history and row display. Meta has explicit presentation/controller boundaries. | Similar source operations look unrelated across providers. | Align labels and layouts first; preserve provider-specific contracts. Split the Google presentation only after a full controller trace and independent acceptance. |
| Medium | Existing public native/Google/Meta/AI data contracts distinguish failed, expired, unavailable and valid zero values. | A cosmetic redesign could silently turn missing data into numeric zero or a misleading green “Connected.” | Status components accept explicit text/tone; they never infer readiness from a truthy count or configured credential. |
| Low | Body 14px is reasonable; table headers/captions often 11px; mobile 44px control minimum exists in many views. | Some metadata becomes unnecessarily small; density is being achieved in text rather than layout. | Keep 14px body, 13px tables, 12px minimum auxiliary text; compact spacing rather than reducing mobile targets. |

No automated accessibility score is claimed. The inspected screenshots and source show visible focus styling, many proper labels, mobile menus, no-data distinctions, guarded asynchronous updates, explicit mutating actions and useful disclosures. Preserve these working properties. Color, keyboard, reflow, RTL, screen reader and live-browser acceptance remain required for the redesigned implementation.

## What to learn from each source

| Pattern | Source evidence | Adaptation |
|---|---|---|
| Scope/task navigation | Elmo apps/web/src/components/app-sidebar.tsx:77–115; OpenSEO src/client/navigation/items.ts:115–160 | Family navigation plus local tabs, never one entry per capability. |
| Stable project shell | OpenSEO src/client/components/Sidebar.tsx:54–55,125–153 | Selected project above family navigation, stable labels while loading, restrained active indicator. |
| Compact responsive frame | Umami src/app/(main)/SideNav.tsx:72–85 and App.tsx:63–75; Elmo apps/web/src/components/site-header.tsx:37–48 | 232px desktop rail, 56px top bar, native mobile disclosure. No second persistent side rail. |
| Quiet hierarchy | Umami src/app/global.css:1–30; OpenSEO src/client/styles/app.css:52–104 and components/PageHeader.tsx:23–34; Elmo apps/web/src/styles.css:70–99 | Native system font, 24px title, neutral surfaces, 8px corners, one blue accent. No new font/network dependency. |
| Local filters and actions | Elmo apps/web/src/components/filter-bar.tsx:26–32,77–93; OpenSEO DataTableToolbar.tsx:49–85; Umami WebsiteControls.tsx:30–46 | Compact applied-filter summary, active count, explicit reset, page-local actions. URL filter persistence is a later controller contract; not silently introduced in a styling patch. |
| Tables and metric strips | Umami WebsitesTable.tsx:29–92, MetricsBar.tsx:8–12 and WebsiteMetricsBar.tsx:18–25,66–89 | Result rows plus small honest metrics. Retain exact denominator/source/provenance access. |
| Distinct empty states | Elmo filtered-list-shell.tsx:68–91; Umami LoadingPanel.tsx:32–53 | Separate first use, no matches, loading, denied, failed, stale and unavailable. |
| Short recoverable setup | Elmo brand-onboarding.tsx:63–117; OpenSEO DashboardOnboarding.tsx:49–62,107–149 and DashboardSetupAction.tsx:76–125; Umami WebsiteTrackingCode.tsx:31–46 | One outcome, minimum necessary fields, defer optional connections, confirm saved configuration or received evidence. |

Paths without a full prefix in the last table are within the named reference's application components; the reference audit supplied their surrounding directories. Before copying source, reopen the exact file and retain required attribution. This specification adapts interaction ideas and does not authorize copying assets or importing reference dependencies.

## Patterns to reject

- Elmo Billing/hosted plan gates and OpenSEO local-mode account restrictions. This is a free Docker product; provider spending controls remain.
- Marketing landing-page heroes or large decorative dashboards.
- Production fixture numbers, pseudo-realtime values, invented comparative arrows or charts drawn through missing observations.
- OpenSEO setup completion triggered only by clicking an exploration link (dashboardSteps.ts:61–69). Configuration completion must be evidence-backed.
- Mandatory 520px chart height (Umami WebsitePage.tsx:23); use a 200–260px primary plot when real data supports it.
- Tailwind/shadcn/React Zen or an additional router merely to resemble the references.
- Per-client custom domains, SaaS checkout, and migration from former products. Native provider report imports, own backup/restore, domain aliases and report share slugs remain required.

## Handoff

tokens.md defines exact visual values and states.
flows.md maps every current view and preserves all 81 capability groups.
implementation.md defines bounded file ownership and acceptance.
kimi-01-tokens.md is the only initially public-intended Kimi prompt. It is self-contained, contains no app source, and must still pass the parent's content/model/isolation checks before dispatch.

kimi-02-global-css.md is the follow-up public-intended stylesheet-only prompt. It may draft concurrently with tokens because file ownership is disjoint. Parent review adapts the delivery envelope to the actual Kimi profile; the design/capability contract stays unchanged.
