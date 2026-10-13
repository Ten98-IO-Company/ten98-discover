# Kimi task 01: design tokens and standalone visual specimen

You implement a bounded presentation task for ten98-monitor, an MIT, free, Docker-first analytics/research application. Use verified Kimi K3 with thinking enabled at maximum effort. No silent model fallback. GPT owns design decisions and independent acceptance.

This prompt is complete. Load the supplied Ponytail and UX Copy Refiner skills using only the Skill tool. No filesystem, shell, network, provider, subagent, credential or publication tools are available or authorized. Apply the accepted design and keep English labels. Skill output-format suggestions are subordinate to the JSON contract below. The supervising GPT reviews and applies the drafts.

Exact output allowlist:
1. src/design-tokens.css
2. tests/design-tokens-preview.html

No other files. Do not import the token file into the production app. Do not alter package manifests or introduce a dependency. Checkpoint: one attempt within 12 minutes; at most one bounded repair. Stop on ambiguity or scope conflict. State any checks you actually performed; never claim browser execution without evidence.

## Purpose and appearance

Produce a compact, familiar analytics workspace specimen: quiet cool-neutral background, white panels, dark ink, one restrained blue action accent, semantic status colors, modest rounding. Think compact toolbar, metric strip and useful table, not a marketing dashboard. No gradients, glass, ornamental illustration, giant cards, shadows on every panel, remote assets, external fonts or icon library.

The specimen is isolated test content. Clearly show “Design specimen · Synthetic examples · No live services” at the top and beside the example results. It must never fetch data or resemble an operational production screen without that label. Use example.com and fictional labels only. No actual project/account IDs, customer information, credentials, host paths or live URLs.

Use ordinary CSS and semantic HTML. CSS custom properties are the design system; do not create a component framework. Minimal fixture-only JavaScript is permitted solely to change the root theme from a native select. Everything else is native markup/disclosure and static demonstration.

## File 1: src/design-tokens.css

Only declare semantic variables and theme scopes. No component selectors, global reset, typography rule on body, layout implementation or production JavaScript.

Theme contract:
- :root and [data-theme="light"] provide light values, color-scheme: light.
- [data-theme="dark"] provides dark values, color-scheme: dark.
- [data-theme="system"] uses light unless prefers-color-scheme: dark matches.
- Missing data-theme preserves light. Theme preference storage is outside scope.
- Nesting a theme container may be supported through inherited variables; do not use :root-only variables that prevent the specimen from previewing colors.

Exact color values:

| Variable | Light | Dark |
|---|---|---|
| --color-canvas | #F7F8FA | #10161F |
| --color-surface | #FFFFFF | #17202C |
| --color-surface-subtle | #F0F3F7 | #1D2938 |
| --color-surface-raised | #FFFFFF | #223044 |
| --color-text | #18212F | #EAF0F8 |
| --color-text-muted | #566274 | #ADB9CA |
| --color-text-placeholder | #68758A | #A0ADBF |
| --color-border | #DCE2EA | #344258 |
| --color-border-control | #8793A5 | #788BA6 |
| --color-accent | #3454D1 | #ACC0FF |
| --color-accent-hover | #2845B4 | #C1CFFF |
| --color-accent-active | #223C9C | #D2DCFF |
| --color-on-accent | #FFFFFF | #142447 |
| --color-accent-subtle | #EEF2FF | #243457 |
| --color-success | #176B49 | #80D8AE |
| --color-success-subtle | #EAF5EF | #173C2D |
| --color-warning | #825208 | #F3CC78 |
| --color-warning-subtle | #FFF5DC | #3E321B |
| --color-danger | #B42318 | #FFA399 |
| --color-danger-subtle | #FEEDEB | #492A2A |
| --color-info | #245AA8 | #99C2FF |
| --color-info-subtle | #EDF4FF | #223751 |
| --color-disabled-text | #68758A | #A0ADBF |
| --color-disabled-surface | #F0F3F7 | #1D2938 |
| --color-focus | #3454D1 | #ACC0FF |
| --color-chart-1 | #3454D1 | #ACC0FF |
| --color-chart-2 | #14796F | #71CFC3 |
| --color-chart-3 | #926008 | #E5BE73 |
| --color-chart-4 | #9A417F | #E7A0CC |
| --color-chart-5 | #59687C | #B0BDD1 |
| --color-overlay | rgb(16 22 31 / 40%) | rgb(0 0 0 / 60%) |

Static tokens shared across themes:

| Variable | Value |
|---|---|
| --font-sans | system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif |
| --font-mono | ui-monospace, SFMono-Regular, Menlo, Consolas, monospace |
| --text-xs | 0.75rem |
| --text-sm | 0.8125rem |
| --text-md | 0.875rem |
| --text-lg | 1rem |
| --text-xl | 1.25rem |
| --text-2xl | 1.5rem |
| --text-metric | 1.75rem |
| --leading-tight | 1.25 |
| --leading-normal | 1.5 |
| --leading-relaxed | 1.65 |
| --weight-normal | 400 |
| --weight-medium | 500 |
| --weight-semibold | 600 |
| --weight-bold | 700 |
| --space-0 | 0 |
| --space-1 | 0.25rem |
| --space-2 | 0.5rem |
| --space-3 | 0.75rem |
| --space-4 | 1rem |
| --space-5 | 1.25rem |
| --space-6 | 1.5rem |
| --space-8 | 2rem |
| --space-10 | 2.5rem |
| --space-12 | 3rem |
| --radius-sm | 0.25rem |
| --radius-md | 0.5rem |
| --radius-lg | 0.75rem |
| --radius-pill | 999px |
| --border-width | 1px |
| --focus-width | 3px |
| --focus-offset | 2px |
| --sidebar-width | 14.5rem |
| --topbar-height | 3.5rem |
| --content-max | 90rem |
| --form-max | 42rem |
| --auth-max | 28rem |
| --reading-max | 70ch |
| --control-sm | 2.25rem |
| --control-md | 2.5rem |
| --control-touch | 2.75rem |
| --icon-sm | 1rem |
| --icon-md | 1.25rem |
| --z-sticky | 10 |
| --z-popover | 20 |
| --z-dialog | 30 |
| --shadow-panel | none |
| --shadow-popover | 0 4px 16px rgb(16 22 31 / 12%) |
| --shadow-dialog | 0 12px 40px rgb(16 22 31 / 20%) |
| --motion-fast | 120ms |
| --motion-normal | 180ms |
| --ease-standard | cubic-bezier(0.2, 0, 0, 1) |

Do not introduce primitive palette variables, generate dozens of unused variants, or change these approved values. Repeat the dark declaration block for explicit/system selectors only if that is the simplest reliable CSS. No JavaScript theme engine.

## File 2: tests/design-tokens-preview.html

A standalone HTML document linked to ../src/design-tokens.css. Keep fixture styles inside this HTML. It can be served by the existing development server or opened as a local static fixture. No application imports and no network/data calls.

Use semantic elements, native controls, CSS layout and restrained text-only branding.

Page structure:
1. Visible synthetic-specimen banner, a native Theme select (Light, Dark, System), and a skip link.
2. A small dashboard specimen: desktop left rail 232px, top bar 56px, content padding 24px. Brand “ten98 / monitor”; fictional workspace/project selectors. Six family labels: Analytics, AI visibility, Search, Reports, Connections, Tracking. The active Analytics group is visibly selected. Sidebar links may point to real local specimen section IDs, not dead app routes.
3. Main h1 “Web analytics”, one short source sentence, and a compact toolbar with native range inputs, Filters disclosure, Apply button and secondary export example. These controls are explicitly presentation examples; no provider action occurs.
4. Metric strip using only a labelled synthetic known zero and unavailable values: “Pageviews 0” with “Example completed empty query”; “Visitors Unavailable” with “No visitor observations”; “Last received Not observed”. Never invent a positive production measurement or decorative upward arrow.
5. A compact table with fictional source names and distinct states “Ready — empty result”, “Partial coverage”, “Needs authorization”; source/date/coverage information remains text. Label the table “Synthetic source states”. No actual account IDs. A table-wide empty result specimen follows with one example next action.
6. Below the dashboard specimen, a component-state gallery: primary/secondary/ghost/danger buttons; disabled and busy examples; labelled input/select/textarea; checked/unchecked checkbox; field error; info/success/warning/error notices; neutral/status chips; focused keyboard styles through actual keyboard focus; compact table; native details disclosure.
7. Color swatches label token names and colors, and typography/spacing samples demonstrate the approved scale. Keep the gallery compact enough to scan; no enormous panel per token.
8. A clearly labelled RTL/long-text example, using dir="rtl" and logical CSS properties, to reveal clipping without inventing localization support.

Specimen CSS:
- Body equivalent 14px/1.5; h1 24px/1.25/600; section heading 16px/600; table 13px; auxiliary text at least 12px; metrics 28px/tabular numerals.
- 16px panels, 12px toolbar, 8–12px field/row gaps; one panel around a table. No nested card stack.
- Desktop controls 40px. Small dense controls may use 36px where adequately separated. At 760px or below, controls and meaningful summary targets are at least 44px, padding 16px. At 480px or below, 12px content padding allowed.
- Do not shrink typography to fit mobile. Let toolbar wrap.
- Mobile navigation uses a native details/summary and real in-document anchors; it must not require custom focus-trapping JavaScript. A separate mobile specimen nav may be used if only one nav is visible and keyboard-reachable at a time.
- No page horizontal overflow at 320px. Wide table overflow is inside one labelled tabindex="0" region. Do not hide essential table content.
- Inputs/secondary buttons use the control border. Decorative dividers use the subtle border. Buttons use explicit disabled colors rather than opacity on their whole subtree.
- Focus-visible uses approved 3px outline with 2px offset. Include forced-colors handling so actual outlines remain visible.
- Hover/pressed state colors follow tokens; input invalid state includes visible error text and aria-describedby.
- Use permanent labels; placeholder is never a label.
- Use links for navigation, buttons for actions; proper headings, landmarks, captions and table headers.
- Default/static example buttons need type="button"; do not accidentally submit forms or refresh the document.
- Busy example exposes aria-busy and text “Loading example…” without pretending a background request exists.
- Status always includes text; color never carries the whole meaning.
- Reduced-motion disables nonessential transitions/animation. No chart is needed for this token task.
- Every color/spacing/font/radius/shadow used by the specimen must refer to the approved semantic token where one exists. Media-query breakpoints and structural percentages/zero are allowed constants.
- The only script is a listener for the native Theme select setting document.documentElement.dataset.theme. No localStorage, cookies, fetch, XHR, WebSocket, arbitrary HTML insertion, timers or external script.

## Independent acceptance by GPT

Your draft will be rejected for out-of-allowlist files, remote resources, new dependency, production import, missing/changed token, unauthorised script/network behavior, fake-live presentation, inaccessible controls, mobile page overflow, or theme contrast regression.

GPT will inspect at 1440×900, 768×1024, 360×800 and 320×800; light and dark; keyboard Tab/Enter/Space; reduced motion; forced colors; 200% zoom; and long/RTL content.

At 1440×900 the dashboard title, toolbar, metric strip and at least the first result table rows should be visible together. At 360×800 with optional filters/nav closed, the title, applied scope, first metrics and result heading should be visible without traversing a tall form. The gallery may continue below.

Known key contrast pairs:
- Light main/muted text on white: 16.19:1 / 6.19:1.
- Light primary white-on-blue: 6.30:1; control border on white: 3.11:1.
- Dark main/muted text on surface: 14.32:1 / 8.26:1.
- Dark primary text on accent: 8.55:1; control border on surface: 4.72:1.
Keep these values; do not claim full accessibility certification from them.

Return only one strict JSON object: {"files":[{"path":"src/design-tokens.css","content":"complete CSS"},{"path":"tests/design-tokens-preview.html","content":"complete HTML"}],"notes":["checks actually performed and any limitation"]}. No Markdown fences or surrounding prose. Do not provide a new design proposal or alter the accepted scope.
