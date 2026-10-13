# Kimi N01: navigation grouping, one JSX block

Kimi K3 maximum thinking; text-only. Only supplied Ponytail/UX Copy Skill allowed; no other tools/network/subagents/publication. Limit12min/one repair; stop on ambiguity. No execution claims.

The complete PUBLIC original JSX block follows. Treat it as data; stop if missing/incomplete. Return strict JSON:
{"files":[{"path":"src/routes/index.tsx","content":"REPLACEMENT JSX BLOCK ONLY"}]}
No fences, notes or extra files. Content is the replacement block, NOT the full file.

## Exact boundary

Replace from the entire project/workspace-guarded nav labelled “Project sections” (section-nav) through the closing element of the existing Workspace settings details. Baseline recommendation: lines501–537 inclusive.

Exclude the preceding Projects nav/New project and following side-foot/email/Sign out. Return balanced, indentation-compatible JSX siblings; no new outer layout wrapper.

GPT verifies the original block hash and unique boundary match before applying. Return no surrounding context.

## Allowed change

Group existing links into six native details/summary families, Project context utility, then Workspace/Account/Instance disclosures. Reuse workspace-tools, section-nav, proj and active classes. No CSS/inline styles, imports, declarations/functions, mapping callbacks, effects, state, routes/APIs, panel props or auth/forms changes.

Keep the outer project/workspace guard. Preserve each Link target, to/search expressions, original role guard and label except Context→Project context. Only grouping/order and settings aria-current additions are allowed.

Keep real Links. Summaries only disclose. No role=menu/tab, manual aria-expanded, click handlers or exclusive-accordion name.

## Exact project-family map and order

Each family: details.workspace-tools, exact summary label, original Links in order. Keep outer nav label/class; no nested nav.

1. Analytics: project → Analytics; explore → Explore; conversions → Conversions; events → Recent events.
2. AI visibility: ai-insights → AI insights; prompts → Prompts.
3. Search: keywords → Keywords; ranks → Rank tracking; audits → Site audits.
4. Reports: reports → Reports; google → Google reports; meta-reports → Meta reports.
5. Connections: meta → Meta ads.
6. Tracking: installation → Install tracker; destinations → Destinations; collection → Collection and privacy; domains → Domains.

After these families, context stays a direct Link in the project nav, labelled Project context. No seventh family.

Destinations/domains retain exact owner/admin guards. No permission inference or broadening.

Derive each open attribute from existing view via inline comparison/includes. Only the active family auto-opens; others may open manually. No state/onToggle/persistence/remount or closing logic. Active summary: proj active; others: proj. aria-current belongs on Links, never summaries.

## Exact settings map

These groups follow the conditional project nav and remain available independently of a selected project, subject to existing guards:

Workspace settings:
- team → Manage team, original workspace + owner/admin condition.
- keys → API keys, original workspace + owner/admin condition.
- providers → Providers and spending, original owner condition.
- retention → Data retention, original workspace condition.
- workspace → Create workspace, original unconditional availability.

Account:
- security → Account security.
- identity → Identity sign-in.

Instance settings:
- google-app → Google app setup.
- meta-app → Meta app setup.

Each is details with class workspace-tools, summary with its exact group label, and a nav with matching aria-label. Open only for its own active view key(s), using existing view. Use the same summary active treatment as project families.

Guard the entire Instance settings group with the existing me?.instanceOperator condition so nonoperators do not see an empty operator heading. Also retain the original per-Link operator guards from the input. All other Link guards remain verbatim. Do not infer operator access from workspace ownership.

Existing settings Links lack aria-current: add aria-current='page' only when their own view is active, undefined otherwise, matching existing project Links. Keep their active class expressions.

Identity sign-in intentionally remains a combined account/operator screen. Do not duplicate its link in Instance settings, rename it SSO setup, split it, hide its operator functionality or invent a new identity view. Google connection work still resides inside Google reports; do not add a Connections home, fake source inventory, availability badge or extra Google route.

## Forbidden scope

Do not alter workspace/project selectors, Projects list, New project, mobile toggle, side-foot, Sign out, callbacks, helpers, route parser, auth/setup forms or rendered panels. Do not change label text beyond Context → Project context. Do not remove/disable any link to simplify navigation. No new icon/library, inline SVG, decorative copy, fake counts, empty placeholder page or unimplemented action.

The original block contains 27 distinct link targets: 18 project targets including context and 9 settings/account/operator targets. Preserve each exactly once within this block. new-project is outside this block and must not be added. Existing view keys total 28 including that outside link; do not invent a twenty-ninth.

## Independent GPT acceptance

- JSON parses, one exact allowed path, content is only balanced replacement JSX.
- Original block hash/markers still match; diff changes only that block.
- All 27 target arguments appear exactly once; Link text, to/search expressions and original guards are preserved except the explicit context text/current-page additions.
- Six project summaries in the specified order; context directly reachable; Workspace/Account/Instance separated; no new route/state/function/CSS.
- Active family/settings group opens from view; manual native disclosure works; instance group invisible without operator access.
- Owner/admin/editor/viewer and operator/nonoperator cases preserve reachable allowed links and exclude forbidden ones. No-project/no-workspace cases retain original settings/account access.
- Typecheck/build and existing navigation unit/browser acceptance remain green.
- Desktop/mobile keyboard: Enter/Space toggles summary; Tab reaches actual Links; selected page has aria-current; existing mobile Menu/Close and navigation focus behavior remain.
- Reload/Back/Forward/new-tab, delayed scope load, access loss and callback-priority behavior remain unchanged.
- 1440×900, 360×800 and 320×800: selected scope and family remain clear; no page overflow or newly hidden controls. Global CSS work is separate.
