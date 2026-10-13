Use Kimi K3 maximum thinking. Load Ponytail only. This is the ONE bounded180-second repair for approved N02 shell presentation, then stop; no further repair. Skill-only profile; no shell/filesystem/network/subagents/API/provider calls. Return bare JSON {"replaceSummary":"EXACT REPLACEMENT RULE","appendCss":"SCOPED CSS RULES"}. No prose, other files or tests.

Independent browser and screenshot evidence:
1. `.diagnostics > summary` Background worker diagnostics is21px tall at320px/360px, failing44px target. Add min-height:var(--control-touch), preserve native display:list-item/marker, no JSX/controller/guard changes.
2. `.installation-panel .installation-help > summary` uses display:flex which hides its native disclosure marker. Replace ONLY that exact existing rule below with native display:list-item, cursor:pointer,min-height token and padding-block spacing; remove flex align-items. Native marker and keyboard behavior must remain; no generated icon.
3. At320px RTL with a long workspace name, app-bar reaches470px tall because breadcrumbs workspace text is squeezed beside project/badge into a narrow vertical column. Fix header reflow using scoped `.app-bar`/`.breadcrumbs` rules. At<=760px allow app-bar wrap, breadcrumbs full-row/flex-basis100% and min-width0, wrapping inside breadcrumbs with workspace text enough width to wrap naturally. Preserve project label and visible Development preview badge. Keep header in normal document flow, content not clipped/hidden; no fixed max-height/ellipsis/new truncation on workspace. Use logical properties and semantic spacing tokens. Existing project strong ellipsis behavior may remain. Desktop should also tolerate long unbroken scope names without overflow.
4. Retained event name first column breaks pageview into page/view and signup into signu/p in320 table. Set white-space:nowrap only `.events-panel` event-name column (first-child th/td); retained names stay exact, table still scrolls inside its named region. No hidden columns/data.

All other original shell checks and20production navigation groups pass. Do not claim this repair passes until independent rerun. No app-wide resets/new tokens/dependencies, and no other CSS edits. Keep typography/light theme and all frozen functionality. Avoid large layout abstraction.

CURRENT RELEVANT PUBLIC SOURCE:
.app-bar { height: var(--topbar-height); padding: 0 34px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); background: var(--surface); }
.breadcrumbs { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--muted); font-size: var(--text-xs); }
.breadcrumbs strong { color: var(--ink); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.diagnostics summary { cursor: pointer; font-weight: 500; }
@media (max-width:1100px) { .page-content { padding: 28px var(--space-6); } .app-bar { padding: 0 var(--space-6); } }
@media (max-width:760px) {
 .app-bar { height: auto; min-height: 47px; padding: 10px 18px; }
 .breadcrumbs { gap: 8px; font-size: var(--text-xs); } .preview-badge { font-size: var(--text-xs); padding: 3px 6px; }
}
.events-panel p, .events-panel td, .installation-panel p, .installation-panel code { overflow-wrap: anywhere; }
.events-panel .table-wrap table { min-inline-size: 36rem; }
.installation-panel .installation-help { margin-top: var(--space-4); }
.installation-panel .installation-help > summary { cursor: pointer; min-height: var(--control-touch); display: flex; align-items: center; }

HTML structure (frozen):
<header className='app-bar'><div className='breadcrumbs'><span>{workspace?.name ?? 'Your workspace'}</span>{project && <><span aria-hidden='true'>/</span><strong>{project.name}</strong></>}</div><span className='preview-badge'>Development preview</span></header>

Tokens: --control-touch44px, --topbar-height64px, --space-1=4px,--space-2=8px,--space-3=12px,--space-4=16px. Body border-box is already set. Only return requested CSS, not the entire source above.