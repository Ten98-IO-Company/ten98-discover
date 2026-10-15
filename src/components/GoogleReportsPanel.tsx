import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import { GoogleInspectionPanel } from './GoogleInspectionPanel';

const BTN = { minHeight: 44 };

type Provider = 'gsc' | 'ga4';
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type ReportKind = 'gsc_daily' | 'gsc_queries' | 'gsc_pages' | 'ga4_traffic' | 'ga4_events';

interface ImportDto {
  id: string;
  report: ReportKind;
  from: string;
  to: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'denied';
  dataStatus: 'available' | 'expired';
  pages: number;
  rowCount: number;
  diagnostic: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface Connection {
  id: string;
  name: string;
  provider: Provider;
  revision: number;
  status: 'ready' | 'select_property' | 'reconnect' | 'disconnected';
  propertyId: string | null;
  propertyName: string | null;
  timeZone: string | null;
  currencyCode: string | null;
  scopes: string[];
  updatedAt: string;
  imports: ImportDto[];
}

interface Overview {
  role: Role;
  app: { configured: boolean; enabled: boolean; testing: boolean };
  connections: Connection[];
}

interface Snapshot {
  import: ImportDto;
  source: { provider: Provider; propertyId: string | null; propertyName: string | null; timeZone: string | null; currencyCode: string | null };
  dimensions: string[];
  metrics: string[];
  rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, string | null> }>;
  quality: { warnings: string[]; metadata: unknown };
  nextOffset: number | null;
}

const PROVIDER_LABEL: Record<Provider, string> = { gsc: 'Google Search Console', ga4: 'Google Analytics 4' };

const REPORT_OPTIONS: Record<Provider, Array<{ kind: ReportKind; label: string }>> = {
  gsc: [
    { kind: 'gsc_daily', label: 'Search traffic by day' },
    { kind: 'gsc_queries', label: 'Search queries' },
    { kind: 'gsc_pages', label: 'Pages' },
  ],
  ga4: [
    { kind: 'ga4_traffic', label: 'Traffic' },
    { kind: 'ga4_events', label: 'Events' },
  ],
};

function connStatus(s: Connection['status']): string {
  if (s === 'ready') return 'Ready';
  if (s === 'select_property') return 'Property selection needed';
  if (s === 'reconnect') return 'Reconnect needed';
  return 'Disconnected';
}

function impStatus(s: ImportDto['status']): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function reportLabel(k: ReportKind): string {
  for (const opts of Object.values(REPORT_OPTIONS)) {
    const f = opts.find(o => o.kind === k);
    if (f) return f.label;
  }
  return k;
}

// Only a parsed HTTPS URL on accounts.google.com, without credentials, may be navigated to.
function googleAuthUrl(s: string): string | null {
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.hostname !== 'accounts.google.com' || u.port || u.hash || u.pathname !== '/o/oauth2/v2/auth' || u.username !== '' || u.password !== '') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface GoogleReportOps {
  busy: boolean;
  notify(message: string): void;
  begin(): { serial: number; controller: AbortController } | null;
  end(serial: number): void;
  alive(serial: number, c: AbortController): boolean;
  terminal(serial: number, c: AbortController, e: unknown): boolean;
  refresh(serial: number, c: AbortController): Promise<void>;
}

export function GoogleReportsPanel({ projectId, userId, onUnauthorized }: { projectId: string; userId: string; onUnauthorized: () => void }) {
  return <ReportsInner key={`${projectId}:${userId}`} projectId={projectId} onUnauthorized={onUnauthorized} />;
}

function ReportsInner({ projectId, onUnauthorized }: { projectId: string; onUnauthorized: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const [cProvider, setCProvider] = useState<Provider>('gsc');
  const [cName, setCName] = useState('');
  const [cErr, setCErr] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const gen = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gen.current++; active.current?.abort(); }; }, []);

  const alive = (serial: number, c: AbortController) => mounted.current && serial === gen.current && !c.signal.aborted;
  const begin = () => {
    if (lock.current) return null;
    lock.current = true; setPending(true);
    active.current?.abort(); active.current = new AbortController();
    return { serial: ++gen.current, controller: active.current };
  };
  const end = (serial: number) => { if (serial === gen.current) { lock.current = false; if (mounted.current) setPending(false); } };
  const terminal = (serial: number, c: AbortController, e: unknown): boolean => {
    if (!alive(serial, c)) return true;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      setOverview(null);
      setCName(''); setCErr(''); setNotice('');
      setErr(errMsg(e));
      if (e.status === 401) onUnauthorized();
      return true;
    }
    return false;
  };
  const applyOverview = (serial: number, c: AbortController, r: Overview) => {
    if (!alive(serial, c)) return;
    if (r.role !== 'owner') { setCName(''); setCErr(''); }
    setOverview(r);
  };
  const refresh = async (serial: number, c: AbortController) => {
    try {
      const r = await api<Overview>(`/api/projects/${projectId}/google`, { signal: c.signal });
      applyOverview(serial, c, r);
    } catch (e) { terminal(serial, c, e); throw e; }
  };
  const ops: GoogleReportOps = { begin, end, alive, terminal, refresh, busy: pending, notify: setNotice };

  useEffect(() => {
    const ac = new AbortController();
    active.current = ac; lock.current = true; setPending(true);
    const serial = ++gen.current;
    setErr('');
    api<Overview>(`/api/projects/${projectId}/google`, { signal: ac.signal })
      .then(r => applyOverview(serial, ac, r))
      .catch(e => { if (!terminal(serial, ac, e)) setErr(errMsg(e)); })
      .finally(() => { if (alive(serial, ac)) end(serial); });
    return () => ac.abort();
  }, [tick, projectId]);

  const manualRefresh = () => {
    const op = begin();
    if (!op) return;
    setErr('');
    api<Overview>(`/api/projects/${projectId}/google`, { signal: op.controller.signal })
      .then(r => applyOverview(op.serial, op.controller, r))
      .catch(e => { if (!terminal(op.serial, op.controller, e)) setErr(errMsg(e)); })
      .finally(() => end(op.serial));
  };

  const connect = async (provider: Provider, name: string, connectionId?: string) => {
    const op = begin();
    if (!op) return;
    setCBusy(true);
    setCErr('');
    try {
      const r = await api<{ authorizationUrl: string }>(`/api/projects/${projectId}/google/connect`, {
        method: 'POST',
        body: connectionId ? { provider, name, connectionId } : { provider, name },
        signal: op.controller.signal,
      });
      if (!alive(op.serial, op.controller)) return;
      const u = googleAuthUrl(r.authorizationUrl);
      if (!u) {
        setCErr('The server returned an address that is not a valid Google authorization URL. Nothing was opened.');
        return;
      }
      window.location.assign(u);
    } catch (e) {
      if (!terminal(op.serial, op.controller, e)) {
        if (e instanceof ApiError && e.status === 409) {
          try { await refresh(op.serial, op.controller); } catch { /* refresh handles lost access */ }
        }
        if (alive(op.serial, op.controller)) setCErr(errMsg(e));
      }
    } finally {
      end(op.serial);
      if (mounted.current) setCBusy(false);
    }
  };

  if (!overview && err === '') return <p role="status" className="dim">Loading Google connections…</p>;
  if (!overview) {
    return (
      <div className="card">
        <p role="alert" className="alert">{err}</p>
        <button type="button" className="btn ghost" style={BTN} onClick={() => setTick(t => t + 1)}>Reload connections</button>
      </div>
    );
  }

  const owner = overview.role === 'owner';
  const appOn = overview.app.configured && overview.app.enabled;

  return (
    <div className="google-reports stack">
      {!overview.app.configured && <p className="hint">The instance operator has not configured the Google OAuth app yet.</p>}
      {overview.app.configured && !overview.app.enabled && <p className="hint">Google connections are disabled by the instance operator.</p>}
      {overview.app.configured && overview.app.testing && <p className="hint">The Google consent app is in testing mode; refresh tokens may expire after seven days.</p>}
      {!owner && <p className="hint">Only workspace owners can connect Google sources, choose properties, inspect indexed URLs, or queue imports. You can view existing connections and reports.</p>}

      {owner && appOn && (
        <details className="card google-connect" open={overview.connections.length === 0}>
          <summary>Add a Google connection</summary>
          <div className="stack">
          <div className="field">
            <label htmlFor="g-provider">Provider</label>
            <select id="g-provider" disabled={pending} value={cProvider} onChange={e => setCProvider(e.target.value as Provider)}>
              <option value="gsc">Google Search Console</option>
              <option value="ga4">Google Analytics 4</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="g-conn-name">Connection name</label>
            <input id="g-conn-name" type="text" maxLength={120} disabled={pending} value={cName} onChange={e => setCName(e.target.value)} />
          </div>
          <button type="button" className="btn primary" style={BTN} disabled={pending || cBusy || cName.trim() === ''} onClick={() => void connect(cProvider, cName.trim())}>Connect to Google</button>
          <p className="hint">You are sent to Google to approve read-only access and then return here.</p>
          {cErr !== '' && <p role="alert" className="alert">{cErr}</p>}
          </div>
        </details>
      )}

      {overview.connections.length === 0 && (
        <p className="dim">No Google connections yet{owner && appOn ? '; connect a source above to get started.' : '.'}</p>
      )}

      {overview.connections.map(c => (
        <ConnectionSection
          key={`${c.id}:${c.revision}:${overview.role}`}
          projectId={projectId}
          conn={c}
          owner={owner}
          appOn={appOn}
          ops={ops}
          onReconnect={conn => void connect(conn.provider, conn.name, conn.id)}
        />
      ))}

      <div className="row">
        <button type="button" className="btn ghost" style={BTN} disabled={pending} onClick={manualRefresh}>Refresh status</button>
      </div>
      {notice && <p role="status" className="hint">{notice}</p>}
      {err !== '' && <p role="alert" className="alert">{err}</p>}
    </div>
  );
}

function ConnectionSection({ projectId, conn, owner, appOn, ops, onReconnect }: {
  projectId: string;
  conn: Connection;
  owner: boolean;
  appOn: boolean;
  ops: GoogleReportOps;
  onReconnect: (conn: Connection) => void;
}) {
  const base = `/api/projects/${projectId}/google/connections/${conn.id}`;
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || ops.busy;
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [propsData, setPropsData] = useState<{ list: Array<{ id: string; name: string }>; next: string | null } | null>(null);
  const [pick, setPick] = useState('');
  const [report, setReport] = useState<ReportKind>(conn.provider === 'gsc' ? 'gsc_daily' : 'ga4_traffic');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const attempt = useRef<{ requestId: string; report: ReportKind; from: string; to: string } | null>(null);
  const [snap, setSnap] = useState<{
    id: string;
    imp: ImportDto;
    source: Snapshot['source'];
    dimensions: string[];
    metrics: string[];
    rows: Snapshot['rows'];
    warnings: string[];
    next: number | null;
  } | null>(null);
  useEffect(() => {
    setSnap(previous => {
      const receipt = previous && conn.imports.find(item => item.id === previous.id);
      return previous && receipt?.dataStatus === 'expired' && previous.imp.dataStatus !== 'expired'
        ? { ...previous, imp: receipt, rows: [], warnings: [], next: null } : previous;
    });
  }, [conn.imports]);

  const run = async (fn: (serial: number, c: AbortController) => Promise<void>) => {
    const op = ops.begin();
    if (!op) return;
    setBusy(true);
    setErr('');
    setNote('');
    try {
      await fn(op.serial, op.controller);
    } finally {
      ops.end(op.serial);
      if (ops.alive(op.serial, op.controller)) setBusy(false);
    }
  };

  const loadProps = (pageToken?: string) => run(async (serial, c) => {
    try {
      const r = await api<{ properties: Array<{ id: string; name: string }>; nextPageToken: string | null }>(`${base}/properties`, {
        method: 'POST',
        body: pageToken ? { pageToken } : {},
        signal: c.signal,
      });
      if (!ops.alive(serial, c)) return;
      setPropsData(prev => pageToken && prev
        ? { list: [...prev.list, ...r.properties], next: r.nextPageToken }
        : { list: r.properties, next: r.nextPageToken });
    } catch (e) {
      if (ops.terminal(serial, c, e)) return;
      if (e instanceof ApiError && e.status === 409) {
        setPropsData(null);
        try { await ops.refresh(serial, c); } catch { /* panel retry remains available */ }
        if (ops.alive(serial, c)) setErr('This connection changed. Load the properties again.');
        return;
      }
      if (ops.alive(serial, c)) setErr(errMsg(e));
    }
  });

  const chooseProp = () => {
    if (pick === '') { setErr('Choose a property first.'); return; }
    void run(async (serial, c) => {
      try {
        await api(`${base}/select`, { method: 'POST', body: { propertyId: pick }, signal: c.signal });
        if (!ops.alive(serial, c)) return;
        await ops.refresh(serial, c);
      } catch (e) {
        if (ops.terminal(serial, c, e)) return;
        if (!ops.alive(serial, c)) return;
        if (e instanceof ApiError && e.status === 409) {
          try { await ops.refresh(serial, c); } catch { /* ignore */ }
          setErr('This connection changed. Current state was reloaded; review it before trying again.');
          return;
        }
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
          setErr('The result could not be confirmed. The selection may have been saved — use Refresh status to check before trying again.');
          return;
        }
        setErr(errMsg(e));
      }
    });
  };

  const disconnect = (revoke: boolean) => {
    const ok = window.confirm(revoke
      ? `Disconnect "${conn.name}" and revoke access at Google? Google may revoke the wider app grant, which can affect other connections.`
      : `Disconnect "${conn.name}"? Imported reports stay available, and you can reconnect later.`);
    if (!ok) return;
    void run(async (serial, c) => {
      try {
        const r = await api<{ disconnected: true; remoteRevocation: 'not_requested' | 'confirmed' | 'unconfirmed' }>(`${base}/disconnect`, {
          method: 'POST',
          body: { revokeAtGoogle: revoke },
          signal: c.signal,
        });
        if (!ops.alive(serial, c)) return;
        ops.notify(!revoke
          ? 'Disconnected. Google access was not revoked.'
          : r.remoteRevocation === 'confirmed'
            ? 'Disconnected, and Google confirmed the revocation.'
            : 'Disconnected locally. Google did not confirm the revocation; the grant may still be active in the Google account.');
        await ops.refresh(serial, c);
      } catch (e) {
        if (ops.terminal(serial, c, e)) return;
        if (!ops.alive(serial, c)) return;
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
          setErr('The result could not be confirmed. The disconnect may have completed — use Refresh status to check the current state.');
          return;
        }
        if (e instanceof ApiError && e.status === 409) {
          try { await ops.refresh(serial, c); } catch { /* ignore */ }
          setErr('This connection changed. Current state was reloaded.');
          return;
        }
        setErr(errMsg(e));
      }
    });
  };

  const queueImport = () => {
    if (from === '' || to === '') { setErr('Choose a start and an end date.'); return; }
    void run(async (serial, c) => {
      let accepted = false;
      try {
        let a = attempt.current;
        if (!a || a.report !== report || a.from !== from || a.to !== to) {
          a = { requestId: crypto.randomUUID(), report, from, to };
          attempt.current = a;
        }
        await api<{ import: ImportDto }>(`${base}/imports`, {
          method: 'POST',
          body: { requestId: a.requestId, report: a.report, from: a.from, to: a.to },
          signal: c.signal,
        });
        if (!ops.alive(serial, c)) return;
        accepted = true;
        attempt.current = null;
        setNote('Import queued. Use Refresh status to follow progress.');
        await ops.refresh(serial, c);
      } catch (e) {
        if (ops.terminal(serial, c, e)) return;
        if (!ops.alive(serial, c)) return;
        if (accepted) { setErr('The import was queued, but the status refresh failed. Use Refresh status to check progress.'); return; }
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
          // Network-uncertain: keep the identical requestId/body for an explicit retry; never resend automatically.
          setErr('The result could not be confirmed. The import may have been queued — use Refresh status to check. Pressing Import again reuses the same request.');
          return;
        }
        attempt.current = null;
        if (e instanceof ApiError && e.status === 409) {
          try { await ops.refresh(serial, c); } catch { /* ignore */ }
          setErr('This connection changed. Current state was reloaded; review it before queueing again.');
          return;
        }
        setErr(errMsg(e));
      }
    });
  };

  const openSnap = (imp: ImportDto) => run(async (serial, c) => {
    try {
      const r = await api<Snapshot>(`/api/projects/${projectId}/google/imports/${imp.id}?offset=0`, { signal: c.signal });
      if (!ops.alive(serial, c)) return;
      setSnap({ id: imp.id, imp: r.import, source: r.source, dimensions: r.dimensions, metrics: r.metrics, rows: r.import.dataStatus === 'expired' ? [] : r.rows, warnings: r.quality.warnings, next: r.import.dataStatus === 'expired' ? null : r.nextOffset });
    } catch (e) {
      if (ops.terminal(serial, c, e)) return;
      if (ops.alive(serial, c)) setErr(errMsg(e));
    }
  });

  const moreSnap = () => run(async (serial, c) => {
    const offset = snap ? snap.next : null;
    if (!snap || offset === null) return;
    try {
      const r = await api<Snapshot>(`/api/projects/${projectId}/google/imports/${snap.id}?offset=${offset}`, { signal: c.signal });
      if (!ops.alive(serial, c)) return;
      setSnap(prev => prev && prev.id === snap.id
        ? { ...prev, imp: r.import, rows: r.import.dataStatus === 'expired' ? [] : [...prev.rows, ...r.rows], warnings: r.quality.warnings, next: r.import.dataStatus === 'expired' ? null : r.nextOffset }
        : prev);
    } catch (e) {
      if (ops.terminal(serial, c, e)) return;
      if (ops.alive(serial, c)) setErr(errMsg(e));
    }
  });

  return (
    <section className="card stack google-connection">
      <div className="row between">
        <div><h2>{conn.name}</h2><p className="dim">{PROVIDER_LABEL[conn.provider]}</p></div>
        <span className={conn.status === 'ready' ? 'pill good' : conn.status === 'reconnect' ? 'pill bad' : 'pill'}>{connStatus(conn.status)}</span>
      </div>
      <p className="dim">
        Property: {conn.propertyName ?? 'Not selected'}{conn.propertyId ? ` (${conn.propertyId})` : ''} · Time zone: {conn.timeZone ?? 'Not set'} · Currency: {conn.currencyCode ?? 'Not set'}
      </p>

      {owner && appOn && conn.provider === 'gsc' && conn.status === 'ready' && conn.propertyId && <GoogleInspectionPanel key={`${conn.id}:${conn.revision}:${conn.propertyId}`} projectId={projectId} connection={{id:conn.id,revision:conn.revision,propertyId:conn.propertyId}} ops={ops} />}

      {(conn.status === 'reconnect' || conn.status === 'disconnected') && owner && appOn && (
        <div className="row">
          <p className="hint">{conn.status === 'disconnected' ? 'Reconnect to import new reports. Existing snapshots remain available until they expire.' : 'Google access needs renewal for this connection.'}</p>
          <button type="button" className="btn primary" style={BTN} disabled={busy} onClick={() => onReconnect(conn)}>Reconnect to Google</button>
        </div>
      )}

      {conn.status === 'select_property' && (
        owner && appOn ? (
          <div className="stack">
            <p className="hint">Choose the property this connection reports on. The choice is permanent; add another connection for a different property.</p>
            {!propsData && (
              <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void loadProps()}>Load available properties</button>
            )}
            {propsData && propsData.list.length === 0 && (
              <p className="dim">No properties were returned for this Google account.</p>
            )}
            {propsData && propsData.list.length > 0 && (
              <>
                <div role="radiogroup" aria-label={`Properties for ${conn.name}`} className="stack">
                  {propsData.list.map(p => (
                    <label key={p.id} className="row" style={{ minHeight: 44 }}>
                      <input type="radio" disabled={busy} name={`prop-${conn.id}`} checked={pick === p.id} onChange={() => setPick(p.id)} />
                      <span>{p.name} <span className="dim">({p.id})</span></span>
                    </label>
                  ))}
                </div>
                {propsData.next !== null && (
                  <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void loadProps(propsData.next ?? undefined)}>Load more properties</button>
                )}
                <button type="button" className="btn primary" style={BTN} disabled={busy || pick === ''} onClick={chooseProp}>Use this property</button>
              </>
            )}
          </div>
        ) : (
          <p className="hint">A workspace owner still needs to choose a property for this connection.</p>
        )
      )}

      {owner && appOn && conn.status === 'ready' && (
        <div className="stack">
          <div className="field">
            <label htmlFor={`report-${conn.id}`}>Report</label>
            <select id={`report-${conn.id}`} disabled={busy} value={report} onChange={e => { setReport(e.target.value as ReportKind); attempt.current = null; }}>
              {REPORT_OPTIONS[conn.provider].map(o => <option key={o.kind} value={o.kind}>{o.label}</option>)}
            </select>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor={`from-${conn.id}`}>Start date</label>
              <input id={`from-${conn.id}`} type="date" disabled={busy} max={new Date().toISOString().slice(0, 10)} value={from} onChange={e => { setFrom(e.target.value); attempt.current = null; }} />
            </div>
            <div className="field">
              <label htmlFor={`to-${conn.id}`}>End date</label>
              <input id={`to-${conn.id}`} type="date" disabled={busy} min={from || undefined} max={new Date().toISOString().slice(0, 10)} value={to} onChange={e => { setTo(e.target.value); attempt.current = null; }} />
            </div>
          </div>
          <p className="hint">Dates are inclusive, up to 366 days, and cannot be in the future. Each import is a separate snapshot.</p>
          <button type="button" className="btn primary" style={BTN} disabled={busy} onClick={queueImport}>Import report snapshot</button>
        </div>
      )}

      {owner && conn.status !== 'disconnected' && (
        <div className="row">
          <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => disconnect(false)}>Disconnect</button>
          <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => disconnect(true)}>Disconnect and revoke at Google</button>
        </div>
      )}

      {conn.imports.length === 0 ? (
        <p className="dim">No imports yet{owner && conn.status === 'ready' ? '; queue one above to get started.' : '.'}</p>
      ) : (
        <ul className="google-imports">
          {conn.imports.map(imp => (
            <li key={imp.id} className="stack">
              <div className="row">
                <span>{reportLabel(imp.report)} · {imp.from} to {imp.to} · {impStatus(imp.status)}{(imp.status === 'completed' || imp.status === 'partial') ? ` · ${imp.rowCount} recorded rows` : ''}{imp.dataStatus === 'expired' ? ' · Report data expired' : ''}</span>
                <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void openSnap(imp)}>View snapshot</button>
              </div>
              {(imp.status === 'queued' || imp.status === 'running') && (
                <p className="dim">{imp.status === 'queued' ? 'Queued.' : 'Running.'} Use Refresh status to follow progress.</p>
              )}
              {imp.diagnostic !== null && <p className="hint">{imp.diagnostic}</p>}
            </li>
          ))}
        </ul>
      )}

      {note !== '' && <p role="status" className="hint">{note}</p>}
      {err !== '' && <p role="alert" className="alert">{err}</p>}

      {snap && (
        <div className="stack">
          <p>Snapshot status: {impStatus(snap.imp.status)}</p>
          {snap.imp.diagnostic && <p role="status" className="hint">{snap.imp.diagnostic}</p>}
          <p className="dim">
            Source: {PROVIDER_LABEL[snap.source.provider]} · Property: {snap.source.propertyName ?? 'Unavailable'}{snap.source.propertyId ? ` (${snap.source.propertyId})` : ''} · Range: {snap.imp.from} to {snap.imp.to} · Time zone: {snap.source.timeZone ?? 'Unavailable'} · Currency: {snap.source.currencyCode ?? 'Unavailable'}
          </p>
          {snap.imp.status === 'partial' && <p role="status" className="alert">Partial import: the page limit was reached, so this snapshot is incomplete.</p>}
          {snap.warnings.length > 0 && (
            <ul className="hint">{snap.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          {snap.imp.dataStatus === 'expired' ? (
            <p role="status" className="alert">Report data expired under this workspace’s retention policy. The import outcome and recorded row count remain as a receipt; the original report rows are unavailable.</p>
          ) : snap.rows.length === 0 ? (
            <p className="dim">{snap.imp.status === 'completed' || snap.imp.status === 'partial'
              ? 'No rows were returned for this report and date range.'
              : snap.imp.status === 'failed' || snap.imp.status === 'denied'
                ? 'This snapshot is unavailable. It does not represent zero traffic.'
                : 'This import has no rows yet.'}</p>
          ) : (
            <div className="table-wrap" style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <table style={{ minWidth: '36rem' }}>
                <thead>
                  <tr>
                    {snap.dimensions.map(d => <th key={d} scope="col">{d}</th>)}
                    {snap.metrics.map(m => <th key={m} scope="col">{m}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {snap.rows.map((r, i) => (
                    <tr key={i}>
                      {snap.dimensions.map(d => <td key={d}>{r.dimensions[d] ?? ''}</td>)}
                      {snap.metrics.map(m => <td key={m}>{r.metrics[m] ?? 'Unavailable'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {snap.next !== null && (
            <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void moreSnap()}>Load more rows</button>
          )}
        </div>
      )}
    </section>
  );
}
