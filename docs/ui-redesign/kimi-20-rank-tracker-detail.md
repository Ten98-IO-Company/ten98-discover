# R01 — Rank detail and view-local touch targets

Public Kimi brief, design only. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"R1","replacement":"exact detail section"},{"id":"R2","replacement":"exact root line"}]}. Only approved Skill tools.

## Scope/flow

Only R1/R2 in src/components/RankTrackingView.tsx change. Freeze creation/list/filter/paging and outer paid/error/notice/loading/pending/conflict/role-null behavior, types/helpers/controllers. No CSS file, dependency, state, effect, helper or API change.

routes/index.tsx → RankTrackingPanel → sole production view caller RankController, keyed by user/workspace/project. Controller owns validation, dirty prompts, focus and exact UUID/revision retries. Child Check/History/Reporting/Schedule panels own paid quote/start, observations, reports and owner-approved recurrence. Their types/callbacks remain frozen.

## Design

Reuse row/stack/btn/ghost/primary/dim/hint/pill/table-wrap, inherited colors and --space-2/3/4, --text-lg. No truncation/sticky UI. R2 changes only the root opening tag: add style={{ '--control-md': 'var(--control-touch)' } as React.CSSProperties}. This scopes 44px controls to all modes, including frozen creation/list/loading/denied. No global CSS.

1. One wrapping header: title/status plus original Back to trackers/Refresh tracker. Title/pill only when t !== null && d !== null. Keep heading id/tabIndex/text; margin0, --text-lg, minWidth0; row gap --space-3. Buttons retain exact callbacks/disabled={p.locked}. Preserve the t/d-null loading/unavailable branch and the separate frozen outer null-detail recovery.
2. All original entry buttons stay visible, outside disclosures, above keywords in current order. Preserve exact guards/handlers. Schedule remains accessible to all known roles; Prepare a rank check remains writer&&!archived and disabled={busy||t.keywordCount===0}.
3. Change the settings card to plain compact context. Domain/subdomains, market/language and immutable-target guidance stay visible. Devices/Requested results/Maximum billable pages stays outside disclosure under original nonediting condition, equivalently !(p.editing && writer). Editing fields provide this context while editing; no duplicate summary.
4. After context, BEFORE Keywords: writer-only native <details open={p.editing}> with summary Tracker settings. Put the existing edit-form/action-row branches inside; preserve p.editing && writer and writer guards. No empty viewer disclosure. Keep all fields/options, form submit wrapper, ids, handlers, values, disabled expressions, archived guidance and Cancel. Native close retains the mounted form/draft; no toggle handler. onEdit opens via p.editing before controller focus. Archive/reactivate keeps its existing explicit confirmation.
5. Keywords remains expanded. Move the existing Add keywords trigger into its wrapping title/count row, retaining writer&&!archived&&!p.adding. Keep the explicit add form below with every field, case toggle, normalization/line/limit warning and Save/Cancel unchanged. Move the complete original selected-count/action row BEFORE table/No keywords yet; preserve writer/archived/busy/selection guards and pin true/false arguments. Actions must precede even 1,000 rows. No automatic selection, inferred total or hidden columns.
6. Preserve Keywords region role/label/tabIndex, minWidth 640 table, keys, exact strings/dates and checkbox labels/checked/handlers. R2 supplies 44px controls at desktop too; native summaries inherit touch height. Preserve checkbox inputs and enlarge table checkbox targets with 44px native label wrappers, not glyph scaling. Natural wrapping and table-local scrolling only. Existing add-form card may remain; no decorative nested cards.

## Invariants and independent acceptance

Keep every original callback argument/body, capability/archival predicate, input type/name/value/checked/maxLength and submit/preventDefault semantics. Only stated presentation wrappers/order/guards/root style change. busy stays locked||conflict, not reading. Back interrupts reads but not unresolved writes. Archived writers may pin/remove and edit name; existing device/depth/page and paid/new-keyword restrictions stay. Pending exact retry and known-conflict reload remain distinct and visible.

GPT retains all 12 original tests/rank-tracking-browser.mjs groups. Only add native settings-opening steps before Edit/Archive; never weaken safety, creation/catalog, retry/conflict/access, focus or provider-repair assertions.

Add meaningful checks: visible scope/billable limits and entry controls with settings closed; writer-only settings; native toggle emits no callback/request. Edit opens/focuses edit-heading; close/reopen preserves drafts/selection and dirty confirmation. Add still opens/focuses its form; case and exact %/+ text unchanged. Action row precedes table for zero/one/multiple selections, with exact pin/remove/all-versus-subset entry callbacks. Preserve empty/archived/viewer/edit/add/null-detail/error/unknown/conflict states; hostile text inert. Synthetic dispatch relies on frozen controller guards; do not demand new direct-view guards.

320/360/768/1440, 120-character names, 253-character domains, 512-character locations, 200-character keywords; LTR/RTL, 200% CSS zoom, forced colors: no document overflow; independent keyboard table scroll, visible focus/native marker, 44px targets including loading/denied/new/list roots. Inspect populated closed-settings desktop/mobile and edit/add/archive. No DB/provider/live preview or paid work.

## Boundaries

Source SHA256: C5412074BD4E402D1A0E866BEE26B7CFA6F482D878096482170A41629063D017. R1 SHA256: 68E275F2A4907AAF57200EE4AAE620989AE632A7345FE8CFEF7546E5506AE5E4.
R1 = lines 96–196 inclusive, final LF included. Start AFTER unique `      ) : p.mode === 'detail' ? (\n`; stop BEFORE unique `      ) : (\n        <section className="stack">\n          <div className="row between">\n            <h2 id={pre + 'list-heading'}`. Both occur once. Never last-return matching; surrounding ternary delimiters excluded. UTF-8/LF; outside R1/R2 bytes frozen.
R2 SHA256: B91F5EB51BCBEB1650BB63FDD80C9551E1733E0ADFFEBA8A5962D4CB425C0C70.
R2 is the unique whole root opening line 52 (including LF), identified by its exact fenced original, not by return matching. Its style alias is the only allowed change. Hashes include fenced content's final LF. First fence is frozen source lines 1–50; imported field types there belong to untouched creation. The R1 and R2 fences alone are editable.

## Frozen exact prefix

```tsx
import type * as React from 'react';
import { RankTrackingFields, type RankTrackingFieldsValue, type RankLocationOption, type RankLanguageOption, type RankLocationOptions, type RankTrackingFieldErrors } from './RankTrackingFields';

export type RankRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type RankDevices = 'desktop' | 'mobile' | 'both';
export type RankFilter = 'active' | 'archived' | 'all';
export type RankTracker = {
  id: string; name: string; domain: string; countryCode: number; countryIso: string; locationCode: number;
  locationName: string; locationType: string; languageCode: string; languageName: string; devices: RankDevices;
  depth: number; maxCrawlPages: number; revision: number; keywordsRevision: number; authoredRevision: number;
  keywordCount: number; archivedAt: string | null; createdAt: string; updatedAt: string;
  schedule: { interval: 'manual' | 'daily' | 'weekly' | 'monthly'; enabled: boolean; nextDueAt: string | null };
};
export type RankKeyword = { id: string; keyword: string; matchCase: boolean; pinnedAt: string | null; createdAt: string };
export type RankConnection = { id: string; name: string; checkStatus: 'untested' | 'ok' | 'error' };
export type RankDetail = { role: RankRole; tracker: RankTracker; keywords: RankKeyword[]; replayed?: boolean };
export type RankEdit = { name: string; devices: RankDevices; depth: number; maxCrawlPages: number };
export type RankCreate = { name: string; connectionId: string; value: RankTrackingFieldsValue };
export type RankTrackingViewProps = {
  prefix: string; role: RankRole | null; mode: 'list' | 'new' | 'detail'; locked: boolean; reading: boolean;
  pending: boolean; conflict: boolean; error: string; notice: string; loaded: boolean; filter: RankFilter;
  trackers: RankTracker[]; nextCursor: string | null; connections: RankConnection[]; vaultConfigured: boolean;
  detail: RankDetail | null; create: RankCreate; catalogReady: boolean; countries: readonly RankLocationOption[];
  languages: readonly RankLanguageOption[]; localLocations: RankLocationOptions; fieldErrors: RankTrackingFieldErrors;
  editing: boolean; edit: RankEdit; adding: boolean; words: string; matchCase: boolean; selected: string[];
  onRefresh: () => void; onFilter: (v: RankFilter) => void; onMore: () => void; onNew: () => void;
  onOpen: (id: string) => void; onBack: () => void; onCreateChange: (v: RankCreate) => void; onCatalog: () => void;
  onLocalQuery: (v: string) => void; onSearchLocal: () => void; onMoreLocal: () => void; onCreate: () => void;
  onCancelCreate: () => void; onEdit: () => void; onEditChange: (v: RankEdit) => void; onSaveEdit: () => void;
  onCancelEdit: () => void; onArchive: () => void; onAdd: () => void; onWords: (v: string) => void;
  onMatchCase: (v: boolean) => void; onSaveWords: () => void; onCancelWords: () => void;
  onSelect: (id: string, checked: boolean) => void; onSelectAll: (checked: boolean) => void;
  onPin: (pinned: boolean) => void; onRemove: () => void; onRetry: () => void; onReload: () => void;
  onOpenProviders: () => void; onChecks: () => void; onPrepareCheck: () => void; onPrepareSelected: () => void; onObservations: () => void; onSchedule: () => void; onReporting: () => void;
};

const DEVICE_LABELS: Record<RankDevices, string> = { desktop: 'Desktop', mobile: 'Mobile', both: 'Desktop & mobile' };
const DEPTHS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const PAGE_CAPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const fmt = (iso: string): string => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function RankTrackingView(p: RankTrackingViewProps): React.JSX.Element {
  const pre = p.prefix;
  const writer = p.role === 'owner' || p.role === 'admin' || p.role === 'editor';
  const busy = p.locked || p.conflict; // mutation submissions only; Cancel/Reload/Retry stay available
  const d = p.detail;
  const t = d === null ? null : d.tracker;
  const archived = t !== null && t.archivedAt !== null;
  const noProvider = !p.vaultConfigured || p.connections.length === 0;
  const submit = (fn: () => void) => (e: React.FormEvent) => { e.preventDefault(); fn(); };
```

## R1 — original detail section

```tsx
        <section className="stack">
          <div className="row between">
            <button type="button" className="btn ghost" onClick={p.onBack} disabled={p.locked}>Back to trackers</button>
            <button type="button" className="btn ghost" onClick={p.onRefresh} disabled={p.locked}>Refresh tracker</button>
          </div>
          {t === null || d === null ? <p role="status">{p.reading ? 'Loading tracker…' : 'Tracker unavailable.'}</p> : (
          <>
            <div className="row"><h2 id={pre + 'detail-heading'} tabIndex={-1}>{t.name}</h2><span className="pill">{archived ? 'Archived' : 'Active'}</span></div>
            <div className="row"><button type="button" className="btn ghost" onClick={p.onObservations} disabled={p.locked}>Latest observations</button><button type="button" className="btn ghost" onClick={p.onReporting} disabled={p.locked}>Reporting</button><button type="button" className="btn ghost" onClick={p.onChecks} disabled={p.locked}>Check history</button><button type="button" className="btn ghost" onClick={p.onSchedule} disabled={p.locked}>Schedule</button>{writer&&!archived&&<button type="button" className="btn primary" onClick={p.onPrepareCheck} disabled={busy||t.keywordCount===0}>Prepare a rank check</button>}</div>
            <div className="card stack">
              <p>{t.domain} (including subdomains) · {t.locationName}, {t.countryIso} · {t.languageName}</p>
              <p className="hint">Create another tracker to change the target or market.</p>
              {p.editing && writer ? (
              <form className="stack" onSubmit={submit(p.onSaveEdit)}>
                <h3 id={pre + 'edit-heading'} tabIndex={-1}>Edit settings</h3>
                <div className="field"><label htmlFor={pre + 'edit-name'}>Tracker name</label>
                  <input id={pre + 'edit-name'} type="text" maxLength={120} value={p.edit.name} disabled={p.locked}
                    onChange={(e) => p.onEditChange({ ...p.edit, name: e.target.value })} /></div>
                <div className="field"><label htmlFor={pre + 'edit-devices'}>Devices</label>
                  <select id={pre + 'edit-devices'} value={p.edit.devices} disabled={p.locked || archived}
                    onChange={(e) => p.onEditChange({ ...p.edit, devices: e.target.value as RankDevices })}>
                    <option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="both">Desktop &amp; mobile</option>
                  </select></div>
                <div className="field"><label htmlFor={pre + 'edit-depth'}>Requested results</label>
                  <select id={pre + 'edit-depth'} value={p.edit.depth} disabled={p.locked || archived}
                    onChange={(e) => p.onEditChange({ ...p.edit, depth: Number(e.target.value) })}>
                    {DEPTHS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select></div>
                <div className="field"><label htmlFor={pre + 'edit-pages'}>Maximum billable pages</label>
                  <select id={pre + 'edit-pages'} value={p.edit.maxCrawlPages} disabled={p.locked || archived}
                    onChange={(e) => p.onEditChange({ ...p.edit, maxCrawlPages: Number(e.target.value) })}>
                    {PAGE_CAPS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select></div>
                {archived && <p className="hint">Reactivate the tracker to change check settings.</p>}
                <div className="row">
                  <button type="submit" className="btn primary" disabled={busy}>Save changes</button>
                  <button type="button" className="btn ghost" onClick={p.onCancelEdit} disabled={p.locked}>Cancel</button>
                </div>
              </form>
              ) : (
              <>
                <p className="dim">Devices: {DEVICE_LABELS[t.devices]} · Requested results: {t.depth} · Maximum billable pages: {t.maxCrawlPages}</p>
                {writer && <div className="row">
                  <button type="button" className="btn ghost" onClick={p.onEdit} disabled={p.locked}>Edit settings</button>
                  <button type="button" className="btn ghost" onClick={p.onArchive} disabled={busy}>{archived ? 'Reactivate tracker' : 'Archive tracker'}</button>
                </div>}
              </>
              )}
            </div>
            <section className="stack">
              <div className="row between"><h3>Keywords</h3><span className="dim">{d.keywords.length} of 1,000 keywords</span></div>
              {writer && !archived && !p.adding && <p><button type="button" className="btn primary" onClick={p.onAdd} disabled={p.locked}>Add keywords</button></p>}
              {writer && p.adding && (
              <form className="card stack" onSubmit={submit(p.onSaveWords)}>
                <h3 id={pre + 'add-heading'} tabIndex={-1}>Add keywords</h3>
                <div className="field"><label htmlFor={pre + 'words'}>Keywords, one per line</label>
                  <textarea id={pre + 'words'} rows={6} maxLength={402000} value={p.words} disabled={p.locked}
                    onChange={(e) => p.onWords(e.target.value)} /></div>
                <div className="field"><label htmlFor={pre + 'match-case'}>
                  <input id={pre + 'match-case'} type="checkbox" checked={p.matchCase} disabled={p.locked}
                    onChange={(e) => p.onMatchCase(e.target.checked)} /> Preserve keyword case</label></div>
                <p className="hint">Lines are trimmed and lowercased by default; internal spaces, % and + are preserved. Up to 2,000 lines per add and 1,000 unique keywords in total; duplicates are ignored server-side.</p>
                <div className="row">
                  <button type="submit" className="btn primary" disabled={busy}>Add keywords</button>
                  <button type="button" className="btn ghost" onClick={p.onCancelWords} disabled={p.locked}>Cancel</button>
                </div>
              </form>
              )}
              {d.keywords.length === 0 ? <p className="dim">No keywords yet</p> : (
              <div className="table-wrap" role="region" aria-label="Keywords" tabIndex={0}>
                <table style={{ minWidth: 640 }}>
                  <thead><tr>
                    {writer && <th><input type="checkbox" aria-label="Select all keywords" disabled={busy}
                      checked={d.keywords.every((k) => p.selected.includes(k.id))}
                      onChange={(e) => p.onSelectAll(e.target.checked)} /></th>}
                    <th>Keyword</th><th>Case</th><th>Pinned</th><th>Created</th>
                  </tr></thead>
                  <tbody>{d.keywords.map((k) => (
                    <tr key={k.id}>
                      {writer && <td><input type="checkbox" aria-label={'Select ' + k.keyword} disabled={busy}
                        checked={p.selected.includes(k.id)} onChange={(e) => p.onSelect(k.id, e.target.checked)} /></td>}
                      <td>{k.keyword}</td>
                      <td>{k.matchCase ? 'Preserved' : 'Lowercased on add'}</td>
                      <td>{k.pinnedAt === null ? 'Not pinned' : 'Pinned'}</td>
                      <td>{fmt(k.createdAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              )}
              {writer && <div className="row">
                <span className="dim">{p.selected.length} selected</span>
                <button type="button" className="btn ghost" onClick={() => p.onPin(true)} disabled={busy || p.selected.length === 0}>Pin selected</button>
                <button type="button" className="btn ghost" onClick={() => p.onPin(false)} disabled={busy || p.selected.length === 0}>Unpin selected</button>
                <button type="button" className="btn ghost" onClick={p.onRemove} disabled={busy || p.selected.length === 0}>Remove selected</button>
                {!archived&&<button type="button" className="btn ghost" onClick={p.onPrepareSelected} disabled={busy||p.selected.length===0}>Check selected keywords</button>}
              </div>}
            </section>
          </>
          )}
        </section>
```

## R2 — original root line

```tsx
    <div className="research-panel rank-tracking">
```

One maximum-thinking K3 draft capped 420s; one separately authorized 120s repair maximum. No automatic continuation. Return R1/R2 JSON or ambiguity; GPT owns application/acceptance.
