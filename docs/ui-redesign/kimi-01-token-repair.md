Kimi K3 maximum thinking. Load only the supplied Ponytail skill. Draft ONLY src/design-tokens.css from the exact approved contract below. No other tools, shell, files, network, providers, subagents or publication. This is the one bounded repair after the initial combined token/specimen attempt timed out with no draft:7-minute hard cap, no automatic further retry. The optional standalone HTML specimen is retired; GPT validates tokens against test probes and existing app browser fixtures. Do not draft HTML or redesign the values. Return only strict JSON {"files":[{"path":"src/design-tokens.css","content":"COMPLETE CSS"}],"notes":["Checks actually performed; do not claim execution"]}.
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
