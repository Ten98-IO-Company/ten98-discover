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
  return (
    <div className="research-panel rank-tracking" style={{ '--control-md': 'var(--control-touch)' } as React.CSSProperties}>
      <p className="dim">Manage trackers and keywords, review a maximum charge, then start a manual rank check. Owners can separately approve recurring checks.</p>
      {p.error !== '' && <p className="alert" role="alert">{p.error}</p>}
      {p.notice !== '' && <p className="notice" role="status">{p.notice}</p>}
      {p.reading && <p className="dim" role="status">Loading…</p>}
      {p.mode==='detail'&&p.detail===null&&<div className="row"><button type="button" className="btn ghost" onClick={p.onBack} disabled={p.locked}>Back to trackers</button></div>}
      {p.pending && <div className="banner" role="alert">The change may already be saved. Retry the same request to recover its result.{' '}
        <button type="button" className="btn ghost" onClick={p.onRetry}>Retry same request</button></div>}
      {p.conflict && <div className="banner">The saved tracker has changed.{' '}
        <button type="button" className="btn ghost" onClick={p.onReload}>Reload tracker</button></div>}
      {p.role === null ? <p>{p.error ? <button type="button" className="btn primary" onClick={p.onReload}>Reload access</button> : 'Loading tracker access…'}</p>
      : p.mode === 'new' ? (
        <section className="stack">
          <div className="row between">
            <h2 id={pre + 'new-heading'} tabIndex={-1}>New tracker</h2>
            <button type="button" className="btn ghost" onClick={p.onCancelCreate} disabled={p.locked}>Cancel</button>
          </div>
          {!writer ? <p className="dim">You need an editor role to create trackers.</p> : (
          <form className="card stack" onSubmit={submit(p.onCreate)}>
            <div className="field"><label htmlFor={pre + 'create-name'}>Tracker name</label>
              <input id={pre + 'create-name'} type="text" maxLength={120} value={p.create.name} disabled={p.locked}
                onChange={(e) => p.onCreateChange({ ...p.create, name: e.target.value })} /></div>
            <div className="field"><label htmlFor={pre + 'create-connection'}>DataForSEO connection</label>
              <select id={pre + 'create-connection'} value={p.create.connectionId} disabled={p.locked}
                onChange={(e) => p.onCreateChange({ ...p.create, connectionId: e.target.value })}>
                <option value="">Select a connection</option>
                {p.connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.checkStatus})</option>)}
              </select></div>
            {noProvider && (p.role === 'owner'
              ? <p><button type="button" className="btn ghost" onClick={p.onOpenProviders} disabled={p.locked}>Open providers</button></p>
              : <p className="hint">Ask a workspace owner to configure DataForSEO.</p>)}
            <p><button type="button" className="btn ghost" onClick={p.onCatalog}
              disabled={p.locked || p.reading || p.create.connectionId === '' || !p.vaultConfigured}>Load search options</button></p>
            {p.catalogReady && (
              <RankTrackingFields value={p.create.value} onChange={(value) => p.onCreateChange({ ...p.create, value })}
                countries={p.countries} languages={p.languages} localLocations={p.localLocations} errors={p.fieldErrors}
                disabled={p.locked} prefix={pre + 'target-'} onLocalQueryChange={p.onLocalQuery}
                onSearchLocalLocations={p.onSearchLocal} onLoadMoreLocalLocations={p.onMoreLocal} />
            )}
            <div className="row"><button type="submit" className="btn primary" disabled={busy || !p.catalogReady}>Create tracker</button></div>
          </form>
          )}
        </section>
      ) : p.mode === 'detail' ? (
        <section className="stack">
          <div className="row between" style={{ gap: 'var(--space-3)' }}>
            {t !== null && d !== null && (
            <>
              <h2 id={pre + 'detail-heading'} tabIndex={-1} style={{ margin: 0, fontSize: 'var(--text-lg)', minWidth: 0 }}>{t.name}</h2>
              <span className="pill">{archived ? 'Archived' : 'Active'}</span>
            </>
            )}
            <button type="button" className="btn ghost" onClick={p.onBack} disabled={p.locked}>Back to trackers</button>
            <button type="button" className="btn ghost" onClick={p.onRefresh} disabled={p.locked}>Refresh tracker</button>
          </div>
          {t === null || d === null ? <p role="status">{p.reading ? 'Loading tracker…' : 'Tracker unavailable.'}</p> : (
          <>
            <div className="row"><button type="button" className="btn ghost" onClick={p.onObservations} disabled={p.locked}>Latest observations</button><button type="button" className="btn ghost" onClick={p.onReporting} disabled={p.locked}>Reporting</button><button type="button" className="btn ghost" onClick={p.onChecks} disabled={p.locked}>Check history</button><button type="button" className="btn ghost" onClick={p.onSchedule} disabled={p.locked}>Schedule</button>{writer&&!archived&&<button type="button" className="btn primary" onClick={p.onPrepareCheck} disabled={busy||t.keywordCount===0}>Prepare a rank check</button>}</div>
            <p>{t.domain} (including subdomains) · {t.locationName}, {t.countryIso} · {t.languageName}</p>
            <p className="hint">Create another tracker to change the target or market.</p>
            {!(p.editing && writer) && <p className="dim">Devices: {DEVICE_LABELS[t.devices]} · Requested results: {t.depth} · Maximum billable pages: {t.maxCrawlPages}</p>}
            {writer && (
            <details open={p.editing}>
              <summary>Tracker settings</summary>
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
                {writer && <div className="row">
                  <button type="button" className="btn ghost" onClick={p.onEdit} disabled={p.locked}>Edit settings</button>
                  <button type="button" className="btn ghost" onClick={p.onArchive} disabled={busy}>{archived ? 'Reactivate tracker' : 'Archive tracker'}</button>
                </div>}
              </>
              )}
            </details>
            )}
            <section className="stack">
              <div className="row between"><h3>Keywords</h3><span className="dim">{d.keywords.length} of 1,000 keywords</span>{writer && !archived && !p.adding && <button type="button" className="btn primary" onClick={p.onAdd} disabled={p.locked}>Add keywords</button>}</div>
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
              {writer && <div className="row">
                <span className="dim">{p.selected.length} selected</span>
                <button type="button" className="btn ghost" onClick={() => p.onPin(true)} disabled={busy || p.selected.length === 0}>Pin selected</button>
                <button type="button" className="btn ghost" onClick={() => p.onPin(false)} disabled={busy || p.selected.length === 0}>Unpin selected</button>
                <button type="button" className="btn ghost" onClick={p.onRemove} disabled={busy || p.selected.length === 0}>Remove selected</button>
                {!archived&&<button type="button" className="btn ghost" onClick={p.onPrepareSelected} disabled={busy||p.selected.length===0}>Check selected keywords</button>}
              </div>}
              {d.keywords.length === 0 ? <p className="dim">No keywords yet</p> : (
              <div className="table-wrap" role="region" aria-label="Keywords" tabIndex={0}>
                <table style={{ minWidth: 640 }}>
                  <thead><tr>
                    {writer && <th><label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 'var(--control-touch)', minHeight: 'var(--control-touch)' }}><input type="checkbox" aria-label="Select all keywords" disabled={busy}
                      checked={d.keywords.every((k) => p.selected.includes(k.id))}
                      onChange={(e) => p.onSelectAll(e.target.checked)} /></label></th>}
                    <th>Keyword</th><th>Case</th><th>Pinned</th><th>Created</th>
                  </tr></thead>
                  <tbody>{d.keywords.map((k) => (
                    <tr key={k.id}>
                      {writer && <td><label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 'var(--control-touch)', minHeight: 'var(--control-touch)' }}><input type="checkbox" aria-label={'Select ' + k.keyword} disabled={busy}
                        checked={p.selected.includes(k.id)} onChange={(e) => p.onSelect(k.id, e.target.checked)} /></label></td>}
                      <td>{k.keyword}</td>
                      <td>{k.matchCase ? 'Preserved' : 'Lowercased on add'}</td>
                      <td>{k.pinnedAt === null ? 'Not pinned' : 'Pinned'}</td>
                      <td>{fmt(k.createdAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              )}
            </section>
          </>
          )}
        </section>
      ) : (
        <section className="stack">
          <div className="row between">
            <h2 id={pre + 'list-heading'} tabIndex={-1}>Saved trackers</h2>
            <div className="row">
              <button type="button" className="btn ghost" onClick={p.onRefresh} disabled={p.locked}>Refresh</button>
              {writer && <button type="button" className="btn primary" onClick={p.onNew} disabled={p.locked}>New tracker</button>}
              <div className="field" style={{minWidth:160}}><label htmlFor={pre + 'filter'}>Show trackers</label>
              <select id={pre + 'filter'} value={p.filter} disabled={p.locked} onChange={(e) => p.onFilter(e.target.value as RankFilter)}>
                <option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option>
              </select></div>
            </div>
          </div>
          {p.loaded && p.trackers.length === 0 && <div className="card">
            <p>{p.filter === 'active' ? 'No active trackers' : p.filter === 'archived' ? 'No archived trackers' : 'No trackers'}</p>
            {p.role === 'viewer' && <p className="dim">Ask an editor to create one.</p>}
          </div>}
          {p.trackers.length > 0 && (
          <div className="table-wrap" role="region" aria-labelledby={pre + 'list-heading'} tabIndex={0}>
            <table style={{ minWidth: 640 }}>
              <thead><tr><th>Tracker</th><th>Target</th><th>Devices</th><th>Keywords</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>{p.trackers.map((tr) => (
                <tr key={tr.id}>
                  <td><button type="button" id={pre + 'open-' + tr.id} className="btn ghost" onClick={() => p.onOpen(tr.id)} disabled={p.locked}>{tr.name}</button></td>
                  <td>{tr.domain} · {tr.locationName} · {tr.languageName}</td>
                  <td>{DEVICE_LABELS[tr.devices]}</td>
                  <td>{tr.keywordCount}</td>
                  <td><span className="pill">{tr.archivedAt === null ? 'Active' : 'Archived'}</span></td>
                  <td>{fmt(tr.updatedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          )}
          {p.nextCursor !== null && <p><button type="button" className="btn ghost" onClick={p.onMore} disabled={p.locked || p.reading}>Load more</button></p>}
        </section>
      )}
    </div>
  );
}
