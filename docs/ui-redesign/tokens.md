# Token specification v1 — ten98-monitor

Status: GPT-6 Astra Ultra design contract for issue #50, reviewed for bounded Kimi implementation. This contract does not establish production theme/preferences support.

## Visual direction

A useful analytics workspace, visually closer to a restrained research table than a marketing dashboard. White panels on a cool neutral canvas, dark ink, blue for actions/selection, and limited semantic colors. No gradients, glass, ornamental illustrations, oversized score cards, heavy shadows or colored backgrounds for entire sections. Brand mark may retain “98”; do not redesign the logo in this batch.

Use existing React, TanStack navigation, native HTML and CSS. Do not introduce a component dependency, icon font, web font, theme provider framework, generated utility system or generic schema-driven form engine.

## Theme contract

Target product preference is Light / Dark / System, user-scoped when that capability is implemented. First token batch only provides CSS modes and a standalone specimen; it does not add preference storage or production controls.

- :root and [data-theme="light"] resolve to the light values.
- [data-theme="dark"] resolves to the dark values and color-scheme: dark.
- [data-theme="system"] uses light unless prefers-color-scheme: dark matches.
- An absent attribute intentionally keeps today's light default until the product preference flow is implemented and validated.
- Theme attribute belongs on html in the application. Nested attributes are permitted only in the specimen to compare swatches.
- Use semantic tokens at component call sites. Do not select arbitrary primitive colors.
- User branding later may change a brand-only accent after contrast checking; it must not replace success/danger or erase disabled/focus indicators.

## Semantic colors

All values are opaque CSS colors; opacity must not be applied to an entire disabled control or parent surface. “Muted” is readable text, not placeholder decoration.

| CSS token | Light | Dark | Purpose |
|---|---|---|---|
| --color-canvas | #F7F8FA | #10161F | Page background |
| --color-surface | #FFFFFF | #17202C | Tables, fields, dialogs |
| --color-surface-subtle | #F0F3F7 | #1D2938 | Headers, quiet row hover, inset code |
| --color-surface-raised | #FFFFFF | #223044 | Menus/popovers only |
| --color-text | #18212F | #EAF0F8 | Main text |
| --color-text-muted | #566274 | #ADB9CA | Supporting text and labels |
| --color-text-placeholder | #68758A | #A0ADBF | Example input text; never a label |
| --color-border | #DCE2EA | #344258 | Dividers and decorative container border |
| --color-border-control | #8793A5 | #788BA6 | Identifies inputs/secondary buttons |
| --color-accent | #3454D1 | #ACC0FF | Primary action, links, selection indicator |
| --color-accent-hover | #2845B4 | #C1CFFF | Hovered primary action |
| --color-accent-active | #223C9C | #D2DCFF | Pressed primary action |
| --color-on-accent | #FFFFFF | #142447 | Text on filled primary |
| --color-accent-subtle | #EEF2FF | #243457 | Selected row/tab background |
| --color-success | #176B49 | #80D8AE | Successful, confirmed outcome |
| --color-success-subtle | #EAF5EF | #173C2D | Success chip/notice surface |
| --color-warning | #825208 | #F3CC78 | Partial coverage, action needed |
| --color-warning-subtle | #FFF5DC | #3E321B | Warning chip/notice surface |
| --color-danger | #B42318 | #FFA399 | Failed action, destructive action text |
| --color-danger-subtle | #FEEDEB | #492A2A | Error chip/notice surface |
| --color-info | #245AA8 | #99C2FF | Informational state |
| --color-info-subtle | #EDF4FF | #223751 | Info chip/notice surface |
| --color-disabled-text | #68758A | #A0ADBF | Disabled control text |
| --color-disabled-surface | #F0F3F7 | #1D2938 | Disabled control surface |
| --color-focus | #3454D1 | #ACC0FF | Keyboard focus outline |
| --color-chart-1 | #3454D1 | #ACC0FF | Primary measured series |
| --color-chart-2 | #14796F | #71CFC3 | Second series |
| --color-chart-3 | #926008 | #E5BE73 | Third series |
| --color-chart-4 | #9A417F | #E7A0CC | Fourth series |
| --color-chart-5 | #59687C | #B0BDD1 | Fifth series |
| --color-overlay | rgb(16 22 31 / 40%) | rgb(0 0 0 / 60%) | Modal overlay only |

Calculated sRGB contrast against the specified surface/state backgrounds:
- Light main text 16.19:1; muted 6.19:1; primary white-on-blue 6.30:1; input border 3.11:1.
- Light success/warning/danger/info text on respective tinted backgrounds: 5.81 / 6.12 / 5.80 / 6.12.
- Light chart series against white: 6.30 / 5.26 / 5.39 / 6.11 / 5.68.
- Dark main text 14.32:1; muted 8.26:1; primary text on accent 8.55:1; input border 4.72:1.
- Dark success/warning/danger/info text on respective tinted backgrounds: 7.18 / 8.18 / 6.65 / 6.64.

These are arithmetic checks of the exact pairs, not a full accessibility certification. Check actual composed control states, images and browser forced colors separately.

Charts must distinguish series with labels, symbols/dashes or accessible tabular equivalents as well as color. Missing observations remain gaps; an unavailable measurement is never a zero-height bar. No new chart is authorized when the current data contract lacks trustworthy series/denominators.

## Typography and numbers

| Token | Value |
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

Use root browser font size unchanged. Body 14px equivalent / 1.5; page title 24px / 1.25 / 600; section title 16px / 1.5 / 600; table 13px / 1.5; auxiliary metadata 12px minimum. Do not use uppercase tracking for whole navigation groups or labels; ordinary title case is easier to scan. Brief uppercase context labels are optional at 12px, never required.

Metric values 28px, tabular numerals, normal letter spacing. Table numeric columns align to the logical end. Use the existing controller's formatted values and locale/timezone labels. Do not round money, coerce null to zero, parse already-formatted metric strings or remove denominators to fit the design. Monospace is for code, IDs and exact receipts, not all dates or prose.

## Space, size, shape, elevation and motion

| Group | Tokens / values |
|---|---|
| Spacing | --space-0: 0; --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem; --space-5: 1.25rem; --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem; --space-12: 3rem |
| Radius | --radius-sm: 0.25rem; --radius-md: 0.5rem; --radius-lg: 0.75rem; --radius-pill: 999px |
| Border | --border-width: 1px; --focus-width: 3px; --focus-offset: 2px |
| Layout | --sidebar-width: 14.5rem; --topbar-height: 3.5rem; --content-max: 90rem; --form-max: 42rem; --auth-max: 28rem; --reading-max: 70ch |
| Controls | --control-sm: 2.25rem; --control-md: 2.5rem; --control-touch: 2.75rem |
| Icons | --icon-sm: 1rem; --icon-md: 1.25rem |
| Layers | --z-sticky: 10; --z-popover: 20; --z-dialog: 30 |
| Elevation | --shadow-panel: none; --shadow-popover: 0 4px 16px rgb(16 22 31 / 12%); --shadow-dialog: 0 12px 40px rgb(16 22 31 / 20%) |
| Motion | --motion-fast: 120ms; --motion-normal: 180ms; --ease-standard: cubic-bezier(0.2, 0, 0, 1) |

Use 16px panel padding, 12px toolbar padding and 8–12px row gaps. Adjacent sections use 24px. Compactness comes from fewer duplicate sections and less nesting, not tiny controls.

Desktop: sidebar 232px, top bar 56px, main padding 24px, one h1 with optional one-line subtitle. Cap dense reports at 1440px content width. Forms cap at 672px and align at the content start; auth caps at 448px and may be centered.

At 1024px and below, reduce main padding to 20px and allow toolbar wrapping. At 760px and below, collapse the rail into the existing native disclosure navigation; main padding 16px and controls/primary actions at least 44px. At 480px and below, 12px main padding is allowed. Breakpoints are documented CSS constants because custom properties cannot be used directly in normal media-query conditions.

No entire-page horizontal scroll at 320px viewport or 200% zoom. Wide data tables scroll inside one labelled, keyboard-focusable region. Do not hide essential columns. A row can show additional fields in a details disclosure if all fields and actions remain reachable with their associations intact. Long source URLs wrap in dedicated cells; buttons remain legible. Use logical properties for inline/block padding, borders, placement and text alignment. Do not use left/right assumptions for business content.

Motion: only color/opacity transitions, no content bounce/scale. Disable nonessential transitions and animation under prefers-reduced-motion. Never animate a loading number through fake intermediate values.

## Component contracts: reuse classes before inventing wrappers

Most visuals need semantic HTML and CSS classes. Introduce a React primitive only after at least two real callers need identical behavior. Keep existing view/controller boundaries. Do not create a configurable “universal dashboard.”

| Pattern | Required visual and behavior |
|---|---|
| Page header | One h1, optional one-line helper, at most one primary action. Secondary actions share a row; they wrap before clipping. Source/project context is compact and visible. |
| Button | Primary, secondary, ghost, danger; 40px desktop default, 36px dense controls only with adequate spacing, 44px touch. Visible text by default. Disabled uses explicit state colors; busy retains action width and an announced status. |
| Input/select/textarea | Permanent associated label; 40px default, 44px touch; meaningful help only. Error border plus text and aria-describedby, never color alone. Native date/select controls unless a proven blocker. |
| Filter bar | Applied range/model/query summary and Filters count. Native details can reveal draft fields. Apply changes only through the existing callback. Unsaved changes stay visible; opening/closing the disclosure must not submit or discard them. |
| Status chip | Text + semantic tone. Neutral for queued, draft, unavailable, disabled; success only for actual accepted/complete state; warning for partial/stale/action required; error for failure. No green “connected” from token presence alone. |
| Notice | Short title/actionable sentence. Inline near affected content. Destructive, billing, permission, coverage and unknown-write warnings remain visible at the decision point. Methodology can be disclosed. |
| Metric strip | Label, exact formatted value, optional coverage/source; four to six columns on wide screens, two on narrow screens. Values remain text, no enclosing card per metric. No delta without comparable data. |
| Table | Caption or labelled section; header row 36px minimum, content rows typically 44px; horizontal padding 12px, vertical 8px; row hover subtle. Row selection uses native checkbox. Every row action has a context-aware accessible name. |
| Pagination | Inside table footer with count/range when provided, previous/next labels, capability gates. No disabled pagination scaffold for an empty dataset with no pages. Never infer final page from current row count. |
| Disclosure | Native details/summary for filters, methodology, diagnostics and advanced forms. Summary has a text label and expanded state from the browser; keyboard target at least 44px on touch. Do not nest disclosures more than two levels. |
| Form section | Heading/legend, 12–16px field gaps, one action footer. No card within card just to group labels. Setup edit mode opens on explicit action. |
| Confirmation | Existing native confirm is acceptable initially. A later dialog must trap focus, restore it, support Escape, name the action and preserve current capability checks. Do not replace a working confirm merely for style. |
| Empty state | Within results region, 16–24px padding, short explanation and one appropriate next action. No illustration/hero. Separate zero, no matches, no source, unavailable, expired and error. |
| Progress | Actual status, completed/total only when supplied, cancel/retry only when allowed. No manufactured percentage or ETA. |

## State invariants

1. Loading is not empty. Keep prior values only if the controller explicitly regards them as current/usable; show refresh/stale status and never allow a mutation from stale capability state.
2. Unknown write result remains unresolved until the controller's existing reconcile/retry path. Cosmetic work must not convert it to success, retry automatically, or create a fresh request ID.
3. Permission loss clears/hides privileged content according to existing controller behavior. Every action must guard inside its event handler as well as its disabled/hidden state.
4. Role names are not universal capabilities. Use canX props where supplied and the existing role rules where they are not; owners, admins and operators are distinct.
5. Browser tag publication, report imports, domain verification, OIDC enable, paid execution and report publication keep separate explicit actions.
6. Disabled controls require a nearby understandable reason when the reason is not obvious. Unimplemented features are not presented as disabled working controls.

## Accessibility acceptance

Target: WCAG AA contrast, keyboard access and 320px reflow; 44px is the product's touch-target choice. This audit does not certify conformance.

- Main skip link; named navigation and main landmarks; one page h1; logical heading order.
- Use links for navigation and buttons for actions. Preserve aria-current and browser history.
- Focus outline is 3px with 2px offset; do not rely on box-shadow alone. Ensure sticky elements do not cover focused controls.
- On page navigation, focus the existing page target. On inline detail close, restore the trigger when appropriate.
- Tabs must be actual linked local pages or a fully implemented keyboard tab pattern. A row of arbitrary buttons with role=tab is insufficient.
- Toast-only validation is prohibited. Errors remain in context; form validation identifies the field and correction.
- Keep non-color labels for every status. Icons decorative unless they carry unique meaning; no emoji as the only status marker.
- Test light, dark, forced-colors, reduced motion, keyboard-only, 200% zoom and a long RTL/long-name fixture.
- Chart alternatives and table focus regions remain accessible in both themes.

## Migration strategy

Introduce src/design-tokens.css with no application import initially. Validate it in tests/design-tokens-preview.html. Next batch imports it once in the existing stylesheet and defines compatibility aliases:

--canvas -> --color-canvas; --surface -> --color-surface; --ink -> --color-text; --muted -> --color-text-muted; --blue -> --color-accent; --green -> --color-success; --caution -> --color-warning; --danger -> --color-danger; --line -> --color-border; --blue-tint -> --color-accent-subtle; --green-tint -> --color-success-subtle; --amber-tint -> --color-warning-subtle; --red-tint -> --color-danger-subtle; --mono -> --font-mono.

Do not delete aliases until a complete caller search returns no use. Dark mode stays specimen-only until hardcoded colors in the affected production scope are migrated and independently checked. This is an explicit staged rollout, not a claim that P07 is complete.
