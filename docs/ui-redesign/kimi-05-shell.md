Use Kimi K3 maximum thinking. Load Ponytail and UX Copy Refiner from the supplied Skill-only profile before drafting.

Implement presentation batch N02 for ten98-monitor using only the supplied public source. GPT reviews/applies/tests independently. No tools, browsing, filesystem access or subagents in text-only mode; an already-approved Skill-only profile may use only its explicitly allowed skills. No external/model/provider/deploy call. Deadline 12 minutes, at most one repair, then stop with actual evidence. No fallback/continuation.

Return one JSON object, no fences/extra prose:
{"replacements":[{"id":"S1","after":"..."},{"id":"S2","after":"..."},{"id":"S3","after":"..."},{"id":"S4","after":"..."},{"id":"S5","after":"..."},{"id":"S6","after":""},{"id":"C1","after":""}],"appendCss":"...","checksNotRun":["TypeScript/build/browser checks require parent validation"]}
Only listed IDs, exactly once. Each after replaces its original block below. Keep source indentation. No whole-file output. Allowlist: src/routes/index.tsx, src/styles.css. No tests/docs/other file output, dependency, state, effect, controller extraction, generalized component or route change.

Design: quiet white/neutral analytics workspace using existing tokens/native HTML/Link. Compact by removing repetition and spacing, not tiny targets. Production stays light. All routes, role checks, forms, errors, real observations, snippets and diagnostics survive. Keep every existing onClick expression/argument byte-equivalent; native disabled conditions remain exact. Preserve branches/data expressions except the specific changes below. No inferred success/readiness.

S1 — Keep shell div and insert its first child as this exact approved affordance:
<a className='skip-link' href='#main-content' onClick={(event) => { event.preventDefault(); mainRef.current?.focus() }}>Skip to main content</a>
This additive handler preventsDefault on EVERY activation including Ctrl/Meta. Fragments are reserved for identity callbacks; never change hash. No router/state/helper; reuse existing mainRef.

S2 — Existing main keeps className/ref/tabIndex exactly; add id='main-content' and aria-label='Main content'. No second main or focus target.

S3 — Preserve project/workspace/projectView condition. Order existing h1/pageTitles[view], then origin, then description. Origin stays fully visible and wraps. Render description only when it exists and view is neither events nor installation; preserve descriptions for every other view. Do not edit title/description dictionaries, imported feature headings or auth/setup forms.

S4 — Preserve view/workspace/project guard, section aria-labelledby='ev-h' and aria-busy={eventsBusy}; add events-panel class. Rename local h2 to 'Retained events', retaining id. Remove p 'Events currently retained'. Put h2/count group and existing Refresh events button in .row.between.events-toolbar. Count remains exactly {events !== null ? events.total : project.eventCount}; never turn missing into zero.
Move original retention expression/copy visibly below toolbar, unchanged. Replace ONLY the lastReceived ternary paragraph with a conditional paragraph when lastReceived !== null, displaying 'Last retained event received ' and fmt(lastReceived). Controller derivation stays untouched. This removes the duplicate empty sentence and avoids announcing empty during loading.
Preserve eventsError/loading branches and both events !== null && events.events.length branches. Empty state keeps its one strong 'No retained events available.'; explanatory text becomes 'Install your tracker, allow analytics in Tracking preferences, then refresh this list. Counts include only retained events the collector has persisted.' Origin stays in the page header instead of repeating it here. Existing Install tracker Link/search expression stays exact.
Keep populated table headers/all mapped cells/keys/fmt calls/count footnote unchanged. Add role='region', aria-label='Retained event rows', tabIndex={0} to existing table-wrap; table gets aria-labelledby='ev-h'. Keep four columns and one scroll region. Refresh events remains one button with exact disabled={eventsBusy}, callback and busy/idle labels. No automatic refresh or duplicate refresh button on installation.

S5 — Keep aria-labelledby='snip-h'; add installation-panel class. Rename h2 to 'Tracking snippet', retaining id. Put h2 and existing Copy snippet button in wrapping .row.between.installation-toolbar, h2 first. Change button className to 'btn primary'; preserve onClick exactly. This is the panel's only primary action.
Keep canonical/verified HTTPS origin paragraph exact and expanded. Preserve pre/code/snippet binding; add only role='region', aria-label='Tracking snippet', tabIndex={0} to pre for keyboard scrolling/selection. Move copied success/failure paragraphs immediately after pre, preserving conditions, roles and full messages exactly. Do not put copy failures in details.
Keep FIRST footnote fully expanded and exact, including isLocal condition, consent, earlier-activity/public HTTPS restriction. Immediately after it add one Link: className='btn', to='/', search={target('events')}, text 'View recent events'. It navigates to existing observations; it never proves setup completion or runs a diagnostic.
Wrap only SECOND original footnote in native details className='installation-help', with summary 'Custom events and collection details'. Preserve entire paragraph/code verbatim. No state/fetch/onToggle. Background worker diagnostics outside this block remains byte-equivalent, including statuses/errors/actions and role/busy checks. Worker completion never means tracker delivery.

S6 — Delete redundant footer. Existing top app-bar 'Development preview' badge remains byte-equivalent. No new release link (no approved release-details route), completion or release claim.

C1 — Delete unused .app-footer rule. No other existing CSS edits. Append short scoped CSS only:
- .skip-link and :focus: offscreen fixed link revealed on focus, maximum inline-size fits viewport, z-index var(--z-dialog), semantic surface/text/control border, 3px var(--color-focus) outline. At least 44px tall while shown. No display:none, animation or new JS; out of grid flow. Keep global focus rules.
- .page-content > .proj-head: 16px bottom gap; its h1 24px/1.25/600, normal letter-spacing, 4px bottom gap. TeamPanel's own .proj-head must be unaffected. Existing origin 12px/muted/wrapping remains; no ellipsis/hiding.
- .events-panel/.installation-panel descendants: 12px toolbar gap, h2 margin 0, events count 28px/tabular/normal tracking, empty-state padding 16px, long content wrapping. Event table minimum inline-size around 36rem, scrolling in existing table-wrap. No hidden column/retention/error/status.
- .installation-panel .installation-help > summary: native keyboard behavior, visible focus, cursor:pointer, min-height var(--control-touch)=44px. 16px separation before details; expanded paragraph readable.
- Only if scope names need top-bar reflow, .app-bar/.breadcrumbs may gain wrapping/min-height/overflow-wrap; keep badge visible. No app-wide reset or unrelated primitives. Existing controls already become 44px at max-width:760px.
Reuse var(--space-1/2/3/4), var(--text-xs/sm/md/lg/2xl/metric), var(--weight-semibold), var(--color-*), var(--radius-sm/md), var(--control-touch), var(--z-dialog). Values: spaces 4/8/12/16px; font sizes 12/13/14/16/24/28px; semibold 600. No new tokens/colors/fonts/icons/libraries/theme preference.

GPT acceptance, not claimed drafting results: existing navigation/type/build tests including callback/capability removal; skip keyboard focus and unchanged URL/hash with normal/Ctrl/Meta activation; event values/branches exact; clipboard success/failure, consent/localhost visible; direct events navigation scoped; diagnostics exact; 320/360/768/1440px, 200% zoom, long names, RTL/forced-colors without document overflow. No new hidden action. Do not claim a test ran.

ORIGINAL SOURCE BLOCKS (public source, exact boundaries):

S1 — SHA-256 `ec9dcca6a0952d05bd5827c55c0f774f54c38dbd65192771ffe80047a66ae329`
```tsx
    <div className='shell'>
```

S2 — SHA-256 `add1ea4ca8544141a2e7ee0f9417003d0a8f90a3ccc0247e88cb8929e4518760`
```tsx
      <main className='main' ref={mainRef} tabIndex={-1}>
```

S3 — SHA-256 `ac10d51b6a6c7108ebe7ddfca5d96124e9262fbae5656aca8358738c31d98cae`
```tsx
        {project && workspace && projectView && <header className='proj-head'>
          <p className='project-origin'>{project.origin}</p>
          <h1>{pageTitles[view]}</h1>
          <p className='dim'>{projectDescriptions[view]}</p>
        </header>}
```

S4 — SHA-256 `92faff22b2f4e3d5ba3c26907d20f76b7ab6ceadc44683201b4a18287b03e0cf`
```tsx
        {view === 'events' && workspace && project !== null && (
            <section className='card' aria-labelledby='ev-h' aria-busy={eventsBusy}>
              <div className='row between'>
                <div>
                  <h2 id='ev-h'>Recent events</h2>
                  <p className='big-num'>{events !== null ? events.total : project.eventCount}</p>
                  <p className='dim'>Events currently retained</p>
                  {(events?.retainedFrom ?? project.retainedFrom) && <p className='hint'>History before {fmt((events?.retainedFrom ?? project.retainedFrom)!)} is unavailable after retention. This is not a lifetime total.</p>}
                  <p className='dim'>{lastReceived !== null ? `Last retained event received ${fmt(lastReceived)}` : 'No retained events available.'}</p>
                </div>
                <button className='btn' disabled={eventsBusy} onClick={() => void loadEvents(project.id)}>{eventsBusy ? 'Refreshing…' : 'Refresh events'}</button>
              </div>
              {eventsError !== '' && <div role='alert' className='alert'>{eventsError}</div>}
              {events === null && eventsError === '' && <p role='status' className='dim'>Loading events…</p>}
              {events !== null && events.events.length === 0 && (
                <div className='empty'>
                  <p><strong>No retained events available.</strong></p>
                  <p>Install your tracker on {project.origin}, allow analytics in Tracking preferences, then refresh this list. Counts include only retained events the collector has persisted.</p><Link className='btn' to='/' search={target('installation')}>Install tracker</Link>
                </div>
              )}
              {events !== null && events.events.length > 0 && (
                <>
                  <div className='table-wrap'>
                    <table>
                      <thead><tr><th scope='col'>Event</th><th scope='col'>Origin</th><th scope='col'>Path</th><th scope='col'>Received</th></tr></thead>
                      <tbody>
                        {events.events.map((ev) => (
                          <tr key={ev.id}><td>{ev.eventName}</td><td className='mono'>{ev.origin}</td><td className='mono'>{ev.path}</td><td className='mono'>{fmt(ev.receivedAt)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className='dim footnote'>Showing the latest {events.events.length} of {events.total} persisted events.</p>
                </>
              )}
            </section>
        )}
```

S5 — SHA-256 `e1f0fd502dabce9d29604a0399ab6c3e513a5b8b526cf6a38c5d1f067bd1e92f`
```tsx
            <section className='card' aria-labelledby='snip-h'>
              <h2 id='snip-h'>Install the tracker</h2>
              <p>Add this tag to the pages served from <strong>{project.origin}</strong> or a verified HTTPS serving domain configured under Domains:</p>
              <pre className='snippet'><code>{snippet}</code></pre>
              <div className='row'>
                <button className='btn' onClick={() => void copySnippet(snippet)}>Copy snippet</button>
                {copied === 'copied' && <p role='status' className='dim'>Copied to clipboard.</p>}
                {copied === 'failed' && <p role='alert' className='dim'>Copy failed — select the snippet text above and copy it manually.</p>}
              </div>
              <p className='dim footnote'>Install the snippet on the canonical origin or a verified HTTPS serving domain, choose analytics consent in Tracking preferences, then refresh events to confirm delivery. Earlier activity is discarded.{isLocal ? ' This app is running on a localhost URL (including [::1]), so external websites cannot reach the collector until it is deployed at a public HTTPS address.' : ''}</p>
              <p className='dim footnote'>After consent, page loads and SPA path changes are observed automatically. Call <code>window.ten98.track('signup', {'{'}plan: 'starter'{'}'})</code> for a custom event with optional properties. Use fixed event names and avoid personal data. Native page URLs omit queries and fragments; optional metadata follows Collection and privacy settings. Vendor tags have their own collection behavior.</p>
            </section>
```

S6 — SHA-256 `f1c9edba4af53988f2798dc2007618143180f3081616f60bb946dce368dcaaba`
```tsx
        <footer className='app-footer'><span>ten98-monitor · Self-hosted and open source</span><span>Development build · Implementation and validation are ongoing.</span></footer>
```

C1 — SHA-256 `4bf1d30ecb0e9c56ecae87bfd0191647b7a86f45e4abddc338704ee295e812bd`
```css
.app-footer { display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: var(--text-xs); }
```

Existing CSS context (read-only except C1; append scoped overrides):

```css
h1 { font-size: var(--text-2xl); line-height: 1.25; letter-spacing: -.8px; font-weight: 700; margin: 0 0 8px; }
h2 { font-size: var(--text-lg); font-weight: 600; margin: 0; }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
.app-bar { height: var(--topbar-height); padding: 0 34px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); background: var(--surface); }
.breadcrumbs { display: flex; align-items: center; gap: 12px; min-width: 0; color: var(--muted); font-size: var(--text-xs); }
.breadcrumbs strong { color: var(--ink); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.preview-badge { color: var(--caution); background: var(--amber-tint); border: 1px solid var(--color-warning); padding: 3px 8px; border-radius: 5px; font-size: var(--text-xs); white-space: nowrap; }
.proj-head { margin-bottom: 26px; }
.proj-head p { margin: 0; }
.project-origin { color: var(--muted); font-size: var(--text-xs); margin-bottom: 6px !important; overflow-wrap: anywhere; }
.proj-head h1 { margin-bottom: 6px; }
.card { min-width: 0; margin-bottom: 20px; padding: var(--space-4); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-panel); }
.card h2 { margin-bottom: 12px; }
.empty { margin-top: 12px; padding: 26px 20px; background: var(--canvas); border: 1px dashed var(--line); border-radius: var(--radius-md); color: var(--muted); font-size: var(--text-sm); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.between { justify-content: space-between; }
.big-num { margin: 7px 0 2px; font-size: 30px; font-weight: 600; letter-spacing: -1px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.snippet { margin: 14px 0; padding: 18px; background: var(--color-surface-subtle); border: 1px solid var(--line); border-radius: 7px; font-family: var(--mono); font-size: var(--text-xs); overflow-x: auto; white-space: pre; }
.table-wrap { margin-top: 12px; overflow-x: auto; }
```

At max-width:760px existing .btn/.proj/input/select min-height is var(--control-touch), .proj-head margin-bottom 22px. Scoped appended header selector must win. Existing table-wrap has overflow-x:auto; card/main have min-width:0. Do not replace global typography.