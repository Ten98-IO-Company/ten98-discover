# UI redesign: implementation evidence

The owner requested GPT-6 Astra Ultra for design and Kimi K3 for implementation. The [design](tokens.md), [flow map](flows.md) and [bounded batches](implementation.md) govern this work. This is an incremental development branch, not a completed redesign or V1 release.

## Accepted locally on 2026-10-14

- Semantic color, typography, spacing, size, focus and motion tokens. Explicit light/dark/system token scopes work; production remains light. No theme preference or complete dark interface is claimed.
- Shared stylesheet uses the tokens while preserving existing layout selectors, table scrolling and mobile menu behavior. Authored keyword-tag color pairs remain unchanged. Disabled, pressed, placeholder and forced-color states have independent browser checks.
- All 27 links inside the replaced navigation block remain, grouped into Analytics, AI visibility, Search, Reports, Connections and Tracking; Project context remains a direct link. Workspace, Account and Instance settings are separate. Existing URLs, role/operator guards, project selector and New project remain intact.
- Analytics typography, controls and chart colors now use the shared tokens. Existing selectors, chart geometry, layouts and metric semantics remain intact. Disabled preset buttons retain their disabled appearance even when selected or hovered.
- AI insights presents entity metrics before coverage and daily observations. Applied scope, uncertainty and dirty-filter warnings remain visible; Report filters and Selection details use native disclosures. Report filters opens automatically for missing reports, draft changes or validation errors. Export and Cancel export are in the report header; all original controls, callbacks and guarded actions remain.

Independent checks passed: four token-browser groups, two actual-stylesheet groups, ten existing citation-presentation groups, all 20 production navigation groups, four navigation unit tests, TypeScript, production build and plan checks. Production browser checks used a new synthetic database and a separate localhost server; no live-preview database or provider was used. They cover owner/viewer/operator visibility, deep links, history, native new tabs, delayed reads/creates, session changes, receipt handoff, retention masking, exports and 320/360/1440px layouts. Screenshots and synthetic operational evidence stay private.

The standalone token-preview dashboard was retired after its initial combined draft timed out without an artifact. An in-memory token probe and the real application fixtures provide acceptance instead. The initial token response wrapped JSON in one code fence; only that outer packaging was removed. Its CSS payload was applied unchanged.

The analytics increment passed its existing production browser workflow, including consent, privacy, unavailable metrics, role revocation and stale-response handling, plus 320/360/1440px layouts and the extended shared-stylesheet probe. AI insights passed all eight presentation groups and nine controller groups, including guarded callbacks, retained-evidence expiry, bounded CSV, cancelled/stale exports, actual keyboard table scrolling and 320/360/1440px layouts. The combined increment then passed all 20 production navigation groups, TypeScript, build, plan and a selected server-only browser-bundle marker scan. Existing assertions were preserved; tests now operate the native Report filters disclosure. Screenshots were inspected independently. No provider call or live-preview update was part of these checks.

The shell increment adds a native keyboard skip link without changing identity-callback fragments, a compact project heading, one retained-event empty message, named keyboard-scroll regions, and a direct scoped link from installation to observed events. Copy success/failure, consent and localhost restrictions, retention caveats, worker diagnostics and all role/busy actions remain. The duplicate footer is retired; the Development preview badge remains.

N02 passed the four navigation units and all20 existing production-navigation groups. Independent screenshot review caught small diagnostics touch targets, a lost native disclosure marker and a long-name header reflow defect. Kimi's single bounded repair fixed touch/marker/event-name issues. At the specified stop checkpoint, Astra Ultra handled the remaining responsive design defect with four scoped header/breadcrumb CSS edits: natural header height, wrapping, and a two-row narrow-layout breadcrumb grid. No further Kimi retry occurred. A hash reversal proves all other CSS bytes stayed unchanged. The final production build and all five focused shell groups pass with unchanged thresholds:320/360/768/1440px, long names, LTR/RTL, keyboard focus and unchanged hash,44px targets, native markers, retained data/loading/errors, clipboard recovery, scoped navigation, worker role/busy/errors, CSS200% zoom and forced colors. CSS zoom is a layout check, not a claim of complete assistive-technology acceptance.

## Kimi execution record

Native CLI 2.1.1, `kimi-code/k3-256k`, thinking enabled and maximum-effort override; Skill-only profile with no shell/filesystem/network/delegation tools. GPT supplied explicit public contracts, reviewed exact output paths, applied drafts and tested independently. This profile is not an operating-system sandbox.

| Batch | Observed skill calls | Capture interval | Result |
|---|---|---:|---|
| Initial token/specimen | Ponytail and UX Copy Refiner | about 721 s | 720 s deadline stopped it; no artifact |
| Token-only repair | Ponytail | about 139 s | Accepted exact CSS; 420 s cap; no further retry |
| Shared stylesheet | Ponytail | about 650 s | Reviewed; residual legacy colors identified |
| Shared stylesheet repair | Ponytail | about 40 s | Eight exact color/shadow substitutions and four scoped state rules accepted |
| Navigation block | Ponytail | about 211 s | Exact scoped JSX applied; all 27 targets and guards retained |
| Analytics stylesheet | Ponytail | about 177 s | Exact scoped CSS applied; no repair |
| AI insights presentation | Ponytail | about 607 s | Exact TSX applied; no repair; all exported types preserved |
| Shell and installation | Ponytail and UX Copy Refiner | about239 s | Seven exact original-boundary replacements plus scoped CSS |
| Shell repair | Ponytail | about65 s | One repair; remaining header defect handed to Astra Ultra design at the stop checkpoint |

Intervals come from private capture-file timestamps and are approximate, not model token usage. The token batch remained below its combined 20-minute ceiling; the stylesheet batch used one repair and also remained below that ceiling. An oversized earlier stylesheet prompt failed local preflight before invoking Kimi. The prompt-size guard was preserved.

The read-only allowance check during this work reported 39% five-hour usage and 84% weekly usage. Per-batch usage deltas, cost and savings are unknown. No HighSpeed substitution, account-plan change or model fallback occurred.

## Still in progress

AI comparison and citation-view presentation updates and a bounded rank-family loading improvement are in progress. Remaining view families, setup flows, production dark preference, cross-interface theme coverage and final accessibility/release acceptance remain open. No existing workflow is considered retired until its replacement preserves capabilities and passes its relevant checks. The user's preserved preview remains on its previous accepted build.
