# Claude continuation

The owner requested this handoff on 17 October 2026. **The app is incomplete. This is a development snapshot, not a release candidate.** Read AGENTS.md first. Claude takes over the lead responsibilities described there; preserve independent review for authorization, destructive operations, finance and privacy.

## Start here

Continue from `codex/claude-handoff`. It contains scoped board sharing, analytics reset and the reviewed website-deletion implementation through schema61. It descends from `codex/scoped-board-sharing`.

Other published branches must still be composed:

| Branch | Source commit | Work |
| --- | --- | --- |
| codex/scoped-board-sharing | 6c38039e0799934b302142485b8d7ee85925b994 | Sharing/reset baseline before deletion |
| codex/heatmap-background | 0c2263dcbb10d09cc1cfee9bbd7623a70899203d | Newer replay/heatmap geometry fixes and VM checks |
| codex/analytics-export | 847050c74fdfad01a9401f240d18cdb97da01aec | Seven-dataset ZIP export and compact accessible dialog |

These are parallel snapshots with overlapping changes. **Do not copy entire shared files over newer implementations or merge with an ours/theirs strategy.** Compose their hunks, especially api.ts, db.ts, AnalyticsPanel, replay/heatmap modules, retention and migration fixtures. Preserve reset publication fences and exact microseconds when integrating export. Append each migration once; never rewrite published migration bytes.

At handoff, remote dev is 949e19153167dba858793eb4be77c7113a2b3120 and main is afd09c8a02270007c8f09e1ee5d54591900fef1b. Main remains the default branch. Neither was promoted or deployed for this handoff. Target reviewed feature merges to dev; release promotion to main waits for genuine readiness.

## What was actually checked

| Snapshot | Result and limits |
| --- | --- |
| Handoff code, schema61 | TypeScript passed (3803ms); all320 checks in34 complete offline test files passed (5606ms), zero connections/listeners/DNS. This is a relevant subset, not the entire test suite. |
| Sharing before reset/deletion | Compiled SSR/hydration public-board browser run passed6groups/3contexts, including null-history canonicalization, capability-only reads and revocation. Output was built from the earlier sharing source and is stale for this branch. |
| Export branch | Native export5groups passed; current dialog browser7groups/27contexts/104API/20POST/four verified downloads/four screenshots passed (23711ms). Controls measured44px; Escape/Close returned focus; cancellation/authority races passed. Synthetic component testing is not compiled whole-app proof. |
| Heatmap branch | TypeScript and208 offline checks passed; native13 passed; actual classic-scrollbar LTR and body/root CSS125% zoom passed. RTL classic-scrollbar readiness still fails. |

Actual failed reset checks on the pre-deletion schema60 snapshot MUST remain failed:

- Native8 timed out at85022ms after6groups; the owned OS job terminated it. Group7 covers microsecond boundary reads/cleanup and replay/heatmap Begin. Group8 was not reached. Six markers are not a whole pass. A later read-only inspection found zero remaining clients/idle transactions/worker heartbeats, one synthetic ledger row and two reset receipts; the administrator database still had zero public tables.
- Reset component browser7 failed at15523ms, before its first group, in context2 while waiting for the Reset analytics button (analytics-reset-browser.mjs line45 in that snapshot). Source remained unchanged; browser/Vite cleanup completed.
- Deletion's authority-keyed danger-child remount may address a related parent busy/recovery seam, but this has **not** been demonstrated by rerunning the reset/browser checks.

The deletion code received root and independent source review with no additional P1/P2 finding. Its3pure checks now pass. Its8native groups,7component groups/20contexts/35GET/24POST/four screenshots, migrationCLI29 and compiled project-selector/navigation behavior are **not executed**. The new native CI lane is not wired.

## Validation on 2026-10-17 (Claude, original machine)

Environment: Node 24.19.0, pnpm 11.19.0, Playwright 1.62.1 with headless Microsoft Edge 155, and a fresh trust-auth PostgreSQL 18 container bound to 127.0.0.1:5432 with CI-shaped database names (`GITHUB_ACTIONS=true`, `TEN98_ISOLATED_CI_DATABASE=1`). Every lane below was run from this branch; no paid provider, email or deployment was involved.

| Check | Result |
| --- | --- |
| TypeScript, offline suite, build | `pnpm typecheck` passed; `pnpm test` passed 898 of 901 (3 skipped) before and after the component change; `pnpm build` passed. |
| Reset native8 | Reproduced the handoff stall exactly: six groups in two seconds, then group7 idle until timeout. Root cause was the test seam, not the product: `beginAt` replaced `pool.connect` with a promise-only function and then called `pool.query`, whose pg-pool implementation drives `connect` through a callback that the seam never invoked. The epoch read now precedes the seam; all eight groups pass in about two seconds with every original assertion intact. |
| Reset browser7 | Reproduced the handoff failure exactly in context2. Root cause was the settings parent: after an accepted reset the reset child stayed open, so the `Reset analytics` button and the parent status line could never appear. The parent now remounts both danger-action children under a new owner and reloads; seven groups,18 contexts,30 GET,20 POST and four screenshots pass. |
| Deletion native8 | Eight groups pass on a fresh schema61 database. |
| Deletion browser7 | First run failed in the settings parent because both danger-action children shared one React sibling key, which React documents as unsupported; with distinct keys seven groups,20 contexts,35 GET,24 POST and four screenshots pass. |
| Migrations CLI lane | Full lane passed, including the actual CLI60-to-61 upgrade and the61 no-op. |
| CI wiring | `ten98_analytics_reset_ci` and `ten98_project_delete_ci` lanes added to the foundation workflow. |
| Compiled-App deletion | `tests/project-delete-compiled-browser.mjs` drove the real built server on a fresh migrated database in headless Edge: owner claim, two websites, deletion from Collection and privacy, router/selector/reload/404/stale-link checks, eight steps passed with no page errors. |
| Heatmap composition | `codex/heatmap-background` merged by three-way composition: its newer replay overlay script, tracker, heatmap panel and VM tests were adopted; the handoff's SQL-clock Begin seams, shared coverage helper, migration registry through61 and migration lane were kept; the one-line gutter-tolerant Meta check and the thirteenth native group were carried over. Typecheck,900 offline tests, the overlay unit test, heatmap native13/13 (three consecutive runs), session-replay, boards, tracked-assets, web-performance, reset, delete and migration lanes, and the heatmap browser harness all pass. One latent flake was fixed in the fixture only: saved-replay page anchors were ordered by random UUID, so the exact-name search occasionally targeted the unsaved recording. |
| Export composition | `codex/analytics-export` merged by three-way composition: only the CI lane list and the OpenAPI browser inventory conflicted, both kept additively. The export gate now carries `analytics_epoch` in its first and final reads as the reset contract requires, and the native lane admits the registered61 prefix instead of58. Typecheck,904 offline tests, export native5/5, export browser7/7 (27 contexts), reset, deletion, boards, tracked-assets and explorer lanes pass. |

Still open from the list below: RTL classic-scrollbar heatmap calibration (item4; the branch composition itself is done) and the full register audit (item6).

## Immediate work

1. Done 2026-10-17; see the validation table. Original wording: Diagnose the two reset failures above without weakening assertions, extending deadlines or treating partial markers as acceptance.
2. Done 2026-10-17; see the validation table. Original wording: Validate deletion in a fresh isolated schema61 database: exact current owner/admin, actor/body/request retry after deletion, reserved/dispatched/uncertain paid-work refusal, financial/other-project preservation, FK dependency order and atomic rollback. Run the authored CLI29: genuine60-to61 upgrade and61 no-op; preserve all older populated-fixture assertions.
3. Done 2026-10-17; see the validation table. Original wording: Verify compiled App behavior after deletion: invalidate current owner, remove selector entry, navigate and reload the project catalog. Component callback tests do not prove this.
4. Composition done 2026-10-17; calibration still open. Original wording: Diagnose classic RTL heatmap calibration, then compose the newer heatmap branch. Existing numeric probes suggest a scrollbar-origin offset but have not proved a supported-DOM fix. Use agents/handoff/heatmap-calibration-probe.mjs only as a diagnostic; it never replaces the original readiness assertion. Rerun RTL/narrow/classic/zoom and original6/collector17 regressions after any asset change.
5. Done 2026-10-17; see the validation table. Original wording: Compose export without losing reset epoch/cutoff checks, then run its native/browser/compiled checks on the combined tree.
6. Resume the complete81-requirement audit and implementation. A smaller milestone does not waive V1 scope. Open areas include click-ID attribution, remaining AI/SEO datasets and flows, platform imports, rendered/protected/scheduled audits, local SEO, OIDC policies, full public-sharing scopes and Docker backup/restore/capacity/privacy acceptance. Verify each against source and the requirement register before changing its status.

P30's concrete gap: the tracker/normalizer currently collect five UTM values; Paid Ads attribution is unavailable. Pinned Umami stores six bounded raw click IDs (gclid,fbclid,msclkid,ttclid,li_fat_id,twclid), while its Paid Ads UI classifies their presence in that order. Raw values versus minimized presence remains an unresolved implementation decision; do not silently claim parity for a different contract. Preserve captureCampaigns, cookieless/DNT/GPC/refusal, no identity coupling, historical unknowns and current selected-touch semantics.

## Run and preserve the boundaries

Stack: TypeScript7, React19, TanStack Start/Router, Vite8, Nitro Node server, Node24, PostgreSQL18 and pg-boss. Keep the lockfile and existing dependencies.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:plan
pnpm build
```

Use the repository's isolated integration contracts and CI workflow. Never point migration/reset/delete tests at a real database. Native tests use fresh retained synthetic databases; do not drop/reuse them or widen port/host admission. Preserve exact test groups, original assertions, time/resource bounds, financial checks, cleanup evidence and failures. Windows Vite's optional `net use` mapping probe can be answered asynchronously with ENOSYS in the exact pinned test guard; that does not authorize subprocess execution or broader networking.

No paid provider calls, real emails, production migrations, credential changes or release deployments were performed for this handoff. Do not expose or copy existing provider credentials. Continue within the owner's existing cumulative live-test allowance only after checking actual prior spend; do not reset that allowance. Per-connection caps remain editable; there is no aggregate app monetary cap.

Full product scope, user flows, research and release gaps live in [Docmost](https://wiki.ten98.io/s/ten98-docs/p/ten98-monitor-0oQB5fKF1h), especially the [81-requirement register](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5) and [release status](https://wiki.ten98.io/s/ten98-docs/p/release-status-vBt9k2HJBg). Keep product planning there; repository docs are code contracts, required notices and agent harnesses. No SaaS billing/paywalls. Keep existing reference-flow fidelity, native integrations, consent boundaries and hosted share slugs.

Local evidence and held harnesses, when continuing on the original machine, are indexed in ignored `private/claude-handoff-context.md`. They contain synthetic diagnostic material and must not be uploaded wholesale. A clean remote clone does not have that local evidence. Reproduce checks rather than inventing results.
