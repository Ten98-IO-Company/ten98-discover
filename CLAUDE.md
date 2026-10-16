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

## Immediate work

1. Diagnose the two reset failures above without weakening assertions, extending deadlines or treating partial markers as acceptance.
2. Validate deletion in a fresh isolated schema61 database: exact current owner/admin, actor/body/request retry after deletion, reserved/dispatched/uncertain paid-work refusal, financial/other-project preservation, FK dependency order and atomic rollback. Run the authored CLI29: genuine60-to61 upgrade and61 no-op; preserve all older populated-fixture assertions.
3. Verify compiled App behavior after deletion: invalidate current owner, remove selector entry, navigate and reload the project catalog. Component callback tests do not prove this.
4. Diagnose classic RTL heatmap calibration, then compose the newer heatmap branch. Existing numeric probes suggest a scrollbar-origin offset but have not proved a supported-DOM fix. Use agents/handoff/heatmap-calibration-probe.mjs only as a diagnostic; it never replaces the original readiness assertion. Rerun RTL/narrow/classic/zoom and original6/collector17 regressions after any asset change.
5. Compose export without losing reset epoch/cutoff checks, then run its native/browser/compiled checks on the combined tree.
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
