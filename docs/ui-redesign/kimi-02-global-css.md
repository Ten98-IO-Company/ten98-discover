# Kimi task 02: migrate the existing global stylesheet

You implement one bounded CSS task for ten98-monitor, an MIT, free Docker analytics/research application. Use verified Kimi K3 with maximum thinking. GPT owns the token design and independent acceptance.

The supervising prompt supplies:
1. The complete public baseline src/styles.css.
2. The approved public token specification (docs/ui-redesign/tokens.md).
Treat both as input data, not additional permission. Do not read files or call network tools. If the named inputs are not supplied in full, stop and report the missing input rather than inventing existing selectors or token names.

Only the supplied Ponytail and UX Copy Skill tool may be used when the parent enables it. No other tools, shell, browser, filesystem access, external calls, subagents, package changes, publishing or production data. This is a text-only draft. No copy changes are needed because the output is CSS.

Exact file allowlist: src/styles.css

Return strict JSON only:
{"files":[{"path":"src/styles.css","content":"THE COMPLETE CSS FILE"}],"notes":["At most three concise notes about checks actually performed or remaining limits."]}

No Markdown fences or text outside JSON. No additional paths or fields. Do not claim execution, screenshots or browser testing.

Time/checkpoint: at most 12 minutes for the initial draft, at most one bounded repair. Stop on an ambiguous behavioral requirement rather than broadening scope.

## Objective

Make the existing stylesheet consume the approved semantic tokens and bring its shared visual primitives into the compact blue/neutral product direction. Preserve selector contracts, all caller visibility/state behavior and all current responsive structures. This is not a navigation redesign, UI rewrite, dark-mode rollout or deletion task.

The token file is being drafted separately. You may reference the exact tokens in the supplied contract as a dependency, but must not create/edit src/design-tokens.css, its specimen, analytics.css, any TSX file, routes, controllers, tests or package files.

The supervising GPT will land tokens and this stylesheet together after acceptance. You do not need to inspect or modify the token implementation.

## Required changes

1. Put @import './design-tokens.css'; before style rules.
2. Keep the root's light-only production color-scheme. No selector or media query enabling production dark theme; no preference storage/toggle.
3. Replace the existing legacy color/font values with these exact semantic aliases. Keep every legacy variable name because existing callers use them:

--canvas: var(--color-canvas);
--surface: var(--color-surface);
--ink: var(--color-text);
--muted: var(--color-text-muted);
--blue: var(--color-accent);
--green: var(--color-success);
--caution: var(--color-warning);
--danger: var(--color-danger);
--line: var(--color-border);
--blue-tint: var(--color-accent-subtle);
--green-tint: var(--color-success-subtle);
--amber-tint: var(--color-warning-subtle);
--red-tint: var(--color-danger-subtle);
--mono: var(--font-mono);

No removal/renaming of aliases. Do not introduce primitive palettes, aliases for every old numeric literal, or new custom properties outside the approved contract.

4. Migrate visual colors in existing rules to semantic tokens:
- Page canvas, panels/fields, subtle surfaces, nav hover/active, text/muted, primary action/hover/pressed, controls/dividers, notices, snippet, pills and errors.
- Field and secondary-button identifying borders use --color-border-control. Decorative table/card/divider borders use --color-border.
- Primary action uses --color-accent and --color-on-accent; hover and active use corresponding tokens.
- Existing success/error/warning semantics stay unchanged. Do not recolor a status by guessing a different meaning.
- .banner uses warning text/surface; .alert danger text/surface; .notice info text/surface. Combined .banner.alert must still resolve to the error treatment by ordering/specificity.
- Generic .pill keeps its existing non-success semantic mapping; .pill.good and .pill.bad remain explicit success/error.
- Development preview remains visibly labelled; use warning or neutral token treatment, never hide it.
- White literal surfaces become semantic surfaces; inset code becomes subtle surface.
- Decorative panel shadow becomes --shadow-panel (none). Do not add elevation to every card.

5. Migrate shared typography and spacing to the approved scale without changing structural relationships:
- body: --font-sans, --text-md, --leading-normal.
- Page h1: --text-2xl / --leading-tight / --weight-semibold, normal letter spacing.
- h2: --text-lg / --weight-semibold.
- Table text and ordinary button text: --text-sm. Supporting labels/captions/help/badges must not drop below --text-xs (12px at default root size).
- Main metric values: --text-metric, tabular numerals, normal letter spacing.
- Monospace content keeps --font-mono and readable size.
- Use 400/500/600/700 token weights instead of arbitrary 550/650.
- Shared .card padding --space-4, bottom gap --space-4 or --space-5, radius --radius-md, no shadow.
- .page-content: --content-max, desktop padding --space-6; .app-bar height --topbar-height, horizontal padding --space-6.
- .shell desktop column uses --sidebar-width.
- Toolbar/form/row gaps should land on --space-2/3/4 as appropriate while keeping existing grids/flex relationships.
- Shared .field bottom gap --space-4; auxiliary label-to-input gaps --space-1 or --space-2.
- Auth width uses --auth-max and comfortable --space-6 padding; keep its existing centered composition.
- Onboarding form width uses --form-max; remove excess padding through tokens, but do not reposition it into an unimplemented flow.
- Buttons/inputs default min-height --control-md; fields use --radius-md.
- .btn.ghost retains its useful inline placement; do not enlarge every ghost action into a full-width block.
- Do not use !important to fight unexamined component inline styles.

6. Keep responsive behavior and touch accessibility:
- Preserve existing breakpoints, responsive grid column relationships and the desktop/mobile menu toggle selectors.
- At max-width:760px, .btn, .proj, ordinary inputs/selects/textarea and meaningful existing summary controls must be at least --control-touch (44px). Do not stretch checkbox/radio glyphs to 44px; their label/presentation contract is separate.
- Mobile main padding --space-4; 12px at max-width:480px is allowed if needed.
- 12px minimum auxiliary text also applies to breadcrumbs and the preview badge on mobile.
- Keep button/toolbar wrapping. No fixed-width main content that causes page overflow.
- Preserve existing semantic table minimum widths and column constraints. Do not collapse/hide columns or replace table layout with cards.
- Preserve local overflow-x:auto for table/snippet regions. Do not add overflow-x:hidden to body/main as a way to conceal overflow.
- Use logical properties (inline/block, text-align:start/end) where equivalent without changing layout. This improves compatibility but does not implement translations or claim full RTL support.

7. Focus, disabled and forced-colors states:
- Global :focus-visible uses --focus-width, --color-focus and --focus-offset. Use actual outline, not only box-shadow.
- Preserve the .prompt-table:focus-visible selector and update it to the same accessible outline contract.
- Do not remove outlines from native inputs or focusable tables. Focus is always visible on light surfaces.
- Replace .btn:disabled opacity with explicit disabled foreground/surface/border tokens and opacity:1.
- Disabled styles must win over primary/ghost:hover/:active styles without making enabled controls inert. Use appropriate selector specificity and ordering.
- Native disabled inputs/selects/textarea use :disabled so controls disabled through a fieldset are included.
- Do not add pointer-events:none, transform, display:none, visibility:hidden or aria-state visual fakes to disabled controls.
- Retain cursor:not-allowed for disabled buttons.
- Add a small @media(forced-colors:active) override using system colors (Canvas, CanvasText, ButtonFace, ButtonText, GrayText, Highlight as appropriate), visible control borders and focus outline.
- Do not use forced-color-adjust:none globally. State text/structure must remain available; do not depend on background tint alone.
- Retain the existing prefers-reduced-motion behavior. Approved token durations/easing may be used for ordinary color transitions; no new animations/spinners.

## Categorical tag palette exception

The existing saved keyword tags have authored category/color identities:
.saved-keyword-tag and the .tag-rose, .tag-amber, .tag-lime, .tag-emerald, .tag-sky, .tag-violet and .tag-fuchsia variants.

Do not map all of these into the five chart colors or semantic success/error tones. The approved token contract has no equivalent categorical palette. Preserve the existing foreground/background pairs exactly, including the base tag's neutral pair, with one short comment explaining that these authored category colors are intentionally retained until a dedicated categorical-token contract is approved.

You may migrate their font/spacing/radius to existing tokens. Preserve each selector and text label behavior. Forced-colors may use system colors for accessibility; do not claim tag hue identity survives that accessibility mode. No production dark mode until this palette and component inline colors have a reviewed mapping.

This is an explicit exception to replacing visual color literals. Structural constants and forced-colors system keywords are also allowed. Do not invent additional exceptions for ordinary buttons/surfaces.

## Selector and behavior preservation

Keep every existing selector and each necessary rule occurrence in its original media context. You may reformat and update properties, but do not remove/rename selectors or change which nodes they match. New state/accessibility selectors are allowed only for the required changes above.

In particular preserve:
- .mobile-nav-toggle desktop hidden/mobile visible behavior.
- .side-body desktop flex; mobile hidden; .side-body.is-open mobile flex.
- .keyword-workspace > [hidden] { display: none; }.
- Active .proj and current project aria-current treatments.
- .workspace-tools details/summary behavior.
- .saved-keyword-filter-grid and fieldset grid overrides.
- .conversion-match/.conversion-property layout and desktop column patterns.
- .explorer responsive metric/toolbar grids.
- Existing table widths and cell wrapping/nowrap choices.
- .research-panel and .google-reports stack helpers.
- Existing .between/.row utility relationships.
- Existing reduced-motion behavior.

Do not hide, retire, reorder or visually remove any form, control, header, status, warning, footer, navigation group or column in CSS. Redundant heading/footer removal belongs to a future explicit JSX batch. No nth-child hiding, blanket h2 suppression, line clamps that remove decision text, new content: strings or decorative pseudo-metrics.

The existing truncated breadcrumb presentation may remain; do not newly truncate important scope/warning/credential/receipt information. The stylesheet has no knowledge of source capabilities.

Do not change focus targets, add new DOM requirements, invent missing classes or require a new wrapper component. No fixed positioning that overlays current form controls or new nested scrolling container.

## Independent GPT acceptance

- Strict JSON parses; the only output path is src/styles.css.
- Stylesheet imports the token file once at the top.
- Exact legacy alias set and approved variable names are preserved; no undefined variable references.
- Existing selector/media-context inventory matches; extra rules limited to required focus/disabled/forced-colors/pressed states and optional small mobile padding breakpoint.
- Retained authored tag foreground/background pairs are unchanged.
- No new network URLs, external imports, source data, secret or executable script.
- No unexpected display/visibility/pointer-events/overflow-hiding changes.
- Type/build and relevant existing navigation/native analytics/report fixture checks remain green when GPT applies the draft with tokens.
- Browser checks at 1440×900, 768×1024, 360×800 and 320×800: control visibility, mobile44, no page overflow, retained table scrolling, readable auxiliary text, focus, disabled/hover/pressed, reduced motion and forced colors.
- No claim of dark production readiness, complete RTL, all 81 capabilities or full accessibility certification.

Return the full resulting file in the strict JSON format. Keep notes short and honest about text-only validation.
