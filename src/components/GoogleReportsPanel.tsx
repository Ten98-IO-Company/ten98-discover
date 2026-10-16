import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import { googleAdsColumnLabel, googleAdsCost, googleGa4ColumnLabel, googleGa4MetricValue, googleDecimalPlain, googleLastCompletedDay, googleOrganicCalendar, googleOrganicChange, googleOrganicChangeValue, organicOverviewMetrics, readOrganicOverview, type OrganicOverview } from '../lib/google-report-display';
import { comparePropertyDecimals, propertyDecimalScale } from '../lib/property-visuals';
import { GoogleInspectionPanel } from './GoogleInspectionPanel';

const BTN = { minHeight: 44 };

type Provider = 'gsc' | 'ga4' | 'ads';
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type ReportKind = 'gsc_daily' | 'gsc_queries' | 'gsc_pages' | 'ga4_traffic' | 'ga4_events' | 'ga4_pages' | 'ga4_acquisition' | 'ga4_key_events' | 'ga4_organic_landing' | 'ga4_organic_daily' | 'ga4_organic_weekly' | 'ads_daily' | 'ads_campaigns' | 'ads_ad_groups';

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
  loginCustomerId?: string | null;
  scopes: string[];
  updatedAt: string;
  imports: ImportDto[];
}

interface Overview {
  role: Role;
  app: { configured: boolean; enabled: boolean; testing: boolean; adsConfigured: boolean };
  connections: Connection[];
}

interface Snapshot {
  import: ImportDto;
  source: { provider: Provider; propertyId: string | null; propertyName: string | null; timeZone: string | null; currencyCode: string | null; loginCustomerId?: string | null; apiVersion?: string };
  dimensions: string[];
  metrics: string[];
  rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, string | null> }>;
  quality: { warnings: string[]; metadata: Record<string, unknown> };
  nextOffset: number | null;
}

const PROVIDER_LABEL: Record<Provider, string> = { gsc: 'Google Search Console', ga4: 'Google Analytics 4', ads: 'Google Ads' };

const REPORT_OPTIONS: Record<Provider, Array<{ kind: ReportKind; label: string }>> = {
  gsc: [
    { kind: 'gsc_daily', label: 'Search traffic by day' },
    { kind: 'gsc_queries', label: 'Search queries' },
    { kind: 'gsc_pages', label: 'Pages' },
  ],
  ga4: [
    { kind: 'ga4_traffic', label: 'Traffic' },
    { kind: 'ga4_events', label: 'Events' },
    { kind: 'ga4_pages', label: 'Pages and screens' },
    { kind: 'ga4_acquisition', label: 'Traffic acquisition' },
    { kind: 'ga4_key_events', label: 'Key events' },
    { kind: 'ga4_organic_landing', label: 'Organic landing pages' },
    { kind: 'ga4_organic_daily', label: 'Organic overview by day' },
    { kind: 'ga4_organic_weekly', label: 'Organic overview by week' },
  ],
  ads: [
    { kind: 'ads_daily', label: 'Ads account by day' },
    { kind: 'ads_campaigns', label: 'Ads campaigns by day' },
    { kind: 'ads_ad_groups', label: 'Ads ad groups by day' },
  ],
};

const organicReport = (report: string) => ['ga4_organic_landing', 'ga4_organic_daily', 'ga4_organic_weekly'].includes(report);
// Same bounded fatal UTF-8 reader used for indexed inspection. This is a retained
// native GET only; no provider request or import is triggered by viewing a report.
async function organicSnapshot(path: string, imp: ImportDto, conn: Connection, offset: number, signal: AbortSignal): Promise<Snapshot> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', signal: deadline });
  try {
    if (response.url !== new URL(path, window.location.origin).href || !response.body) { await response.body?.cancel(); throw Error('The organic report response could not be verified.'); }
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); }; deadline.addEventListener('abort', abort, { once: true });
    try { for (;;) { deadline.throwIfAborted(); const part = await reader.read(); deadline.throwIfAborted(); if (part.done) break; size += part.value.byteLength; if (size > (response.ok ? 2097152 : 8192)) throw Error('The complete organic report is too large. Choose a smaller date range.'); parts.push(part.value); } }
    finally { deadline.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if ((!encoding || encoding === 'identity') && length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) throw Error('The organic report response was incomplete.');
    const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok) throw Error(typeof value?.error === 'string' ? value.error : 'Organic report unavailable.');
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw Error('The organic report response type could not be verified.');
    const sameKeys = (v: unknown, keys: readonly string[]) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
    const overview = imp.report !== 'ga4_organic_landing', dimensions = overview ? [imp.report === 'ga4_organic_weekly' ? 'yearWeek' : 'date'] : ['hostName', 'landingPage'];
    const metrics: readonly string[] = overview ? organicOverviewMetrics : ['sessions','activeUsers','engagedSessions','engagementRate','keyEvents','sessionKeyEventRate','transactions','purchaseRevenue'];
    const receipt = value?.import, source = value?.source, quality = value?.quality;
    if (!receipt || receipt.id !== imp.id || receipt.report !== imp.report || receipt.from !== imp.from || receipt.to !== imp.to || !['queued','running','completed','partial','failed','denied'].includes(receipt.status) || !['available','expired'].includes(receipt.dataStatus) || !Number.isSafeInteger(receipt.rowCount) || receipt.rowCount < 0 || receipt.rowCount > 10000 || !Number.isSafeInteger(receipt.pages) || receipt.pages < 0 || receipt.pages > 10 || typeof receipt.createdAt !== 'string' || !Number.isFinite(Date.parse(receipt.createdAt)) || !(receipt.completedAt === null || typeof receipt.completedAt === 'string' && Number.isFinite(Date.parse(receipt.completedAt))) || !(receipt.diagnostic === null || typeof receipt.diagnostic === 'string' && receipt.diagnostic.length <= 2048) || source?.provider !== 'ga4' || source.propertyId !== conn.propertyId || source.timeZone !== conn.timeZone || source.currencyCode !== conn.currencyCode || !(source.propertyName === null || typeof source.propertyName === 'string' && source.propertyName.length <= 512) || JSON.stringify(value.dimensions) !== JSON.stringify(dimensions) || JSON.stringify(value.metrics) !== JSON.stringify(metrics) || !Array.isArray(value.rows) || value.rows.length > (overview ? 366 : 50) || !sameKeys(quality, ['warnings','metadata']) || !Array.isArray(quality.warnings) || quality.warnings.length > 100 || !quality.warnings.every((v: unknown) => typeof v === 'string' && v.length <= 2048) || quality.metadata === null || typeof quality.metadata !== 'object' || Array.isArray(quality.metadata)) throw Error('The organic snapshot does not match this source and request. Refresh status before trying again.');
    const readable = receipt.dataStatus === 'available' && ['completed','partial'].includes(receipt.status);
    if (!readable && (value.rows.length || value.nextOffset !== null || overview && (quality.warnings.length || Object.keys(quality.metadata).length))) throw Error('Unavailable organic data was returned. Refresh status.');
    if (overview && readable) { const observation = readOrganicOverview(quality.metadata.organic, imp.from, imp.to, imp.report === 'ga4_organic_weekly'); if (!sameKeys(quality.metadata, ['organic']) || !observation || receipt.status !== 'completed' || receipt.pages !== 3 || value.nextOffset !== null || value.rows.length !== receipt.rowCount || observation.trend.rowCount !== value.rows.length) throw Error('The complete organic overview could not be verified.'); }
    if (!overview && readable && (offset + value.rows.length > receipt.rowCount || value.nextOffset !== (offset + value.rows.length < receipt.rowCount ? offset + 50 : null))) throw Error('Organic pagination could not be verified.');
    const seen = new Set<string>(),calendarKeys=overview&&readable?new Set(googleOrganicCalendar(imp.from,imp.to,imp.report==='ga4_organic_weekly').map(bucket=>bucket.key)):null;
    for (const row of value.rows) {
      if (!sameKeys(row, ['dimensions','metrics']) || !sameKeys(row.dimensions, dimensions) || !sameKeys(row.metrics, metrics) || !Object.values(row.dimensions).every(v => typeof v === 'string' && v.length <= 4096 && !v.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(v)) === v) || !Object.entries(row.metrics).every(([key,v]) => v === null || googleDecimalPlain(v) !== null && (key === 'purchaseRevenue' || Number(v) >= 0 && (!['engagementRate','sessionKeyEventRate'].includes(key) || Number(v) <= 1)))) throw Error('Organic row values could not be verified.');
      if (calendarKeys&&!calendarKeys.has(row.dimensions[dimensions[0]])) throw Error('Organic calendar labels could not be verified.');
      const key = JSON.stringify(dimensions.map(name => row.dimensions[name])); if (seen.has(key)) throw Error('Organic rows were repeated.'); seen.add(key);
    }
    return value as Snapshot;
  } catch (error) { if (!response.ok) throw Object.assign(new ApiError(error instanceof Error ? error.message : 'Organic report failed.'), { status: response.status }); throw error; }
}

function OrganicSummary({ overview, rows, currency, timeZone }: { overview: OrganicOverview; rows: Snapshot['rows']; currency: string | null; timeZone: string | null }) {
  const [metric, setMetric] = useState<string>('sessions');
  const calendar=googleOrganicCalendar(overview.current.from,overview.current.to,overview.interval==='weekly'),byKey=new Map(rows.map(row=>[row.dimensions.date??row.dimensions.yearWeek,row]));
  const values=calendar.map(bucket=>googleDecimalPlain(byKey.get(bucket.key)?.metrics[metric])),scale=propertyDecimalScale(values);
  const peak=values.reduce<string>((largest,value)=>{const absolute=value?.replace(/^-/,'')??'0';return comparePropertyDecimals(absolute,largest)>0?absolute:largest;},'0');
  return <section className="stack" aria-label="Organic range comparison">
    <h4>Organic Search · imported period comparison</h4>
    <div className="stack" aria-label="Measurement quality by period">{(['current','previous','trend'] as const).map(stage=><div key={stage} className={overview[stage].quality.warnings.length?'banner':'hint'}><strong>{stage==='current'?'Current period':stage==='previous'?'Previous period':'Trend'}:</strong> {overview[stage].quality.warnings.length?<ul>{overview[stage].quality.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>:'No quality warning reported by Google.'}</div>)}<p className="hint">A completed import does not guarantee complete measurement. Sampling, privacy thresholds and restricted metrics can affect comparisons.</p></div>
    <p className="hint">Current and previous values are separate dimensionless Google reports. Users, rates and revenue are not summed from trend rows. A missing or restricted aggregate is unavailable, never zero. Percent changes use the absolute previous value and are truncated to two decimals; a zero previous value has no percentage change.</p>
    <div className="table-wrap" style={{ overflowX:'auto', maxWidth:'100%' }}><table style={{ minWidth:'36rem' }}><thead><tr><th scope="col">Metric</th><th scope="col">Current: {overview.current.from} to {overview.current.to}</th><th scope="col">Previous: {overview.previous.from} to {overview.previous.to}</th><th scope="col">Change</th><th scope="col">Change %</th></tr></thead><tbody>{organicOverviewMetrics.map(name => { const current = overview.current.values?.[name], previous = overview.previous.values?.[name], change = googleOrganicChange(current, previous); return <tr key={name}><th scope="row">{googleGa4ColumnLabel(name)}</th><td><bdi dir="ltr">{googleGa4MetricValue(name,current,currency)}</bdi></td><td><bdi dir="ltr">{googleGa4MetricValue(name,previous,currency)}</bdi></td><td><bdi dir="ltr">{googleOrganicChangeValue(change.absolute,name === 'purchaseRevenue' ? currency : undefined)}</bdi></td><td><bdi dir="ltr">{change.percent === null ? 'Unavailable' : change.percent + '%'}</bdi></td></tr>; })}</tbody></table></div>
    <label>Trend metric<select aria-label="Trend metric" style={{ minHeight:44 }} value={metric} onChange={e=>setMetric(e.target.value)}>{organicOverviewMetrics.map(name=><option key={name} value={name}>{googleGa4ColumnLabel(name)}</option>)}</select></label>
    <p className="hint">{overview.interval === 'weekly' ? 'Google calendar weeks start Sunday; January 1 is in week 01. Boundary weeks may cover only the selected days. These are not ISO week-years.' : 'Daily values use the property calendar.'} Time zone: {timeZone ?? 'Unavailable'}. The exact retained trend is in the table below; absent dates and restricted values are not filled with zero.</p>
    {scale.some(value=>value!==null) ? <><p className="hint" style={{overflowWrap:'anywhere'}}>Baseline: 0. Height is relative to the largest absolute observation: <bdi dir="ltr">{googleOrganicChangeValue(peak,metric==='purchaseRevenue'?currency:undefined)}</bdi>. {values.filter(value=>value===null).length} calendar intervals have no observed value for this metric; gaps are not zero.</p><svg viewBox="0 0 720 180" role="img" aria-label={`${googleGa4ColumnLabel(metric)} organic ${overview.interval} trend`} style={{ width:'100%', maxWidth:'100%', minWidth:0 }}><title>{googleGa4ColumnLabel(metric)} — calendar intervals with missing values left as gaps; exact values in the following table</title><line x1="10" y1="90" x2="710" y2="90" stroke="currentColor" opacity="0.3"/>{scale.map((value,index)=>value===null?null:<rect key={calendar[index].key} x={10+index*700/scale.length} y={value>=0?90-value*80:90} width={Math.max(.5,700/scale.length-1)} height={Math.max(value===0?1:0,Math.abs(value)*80)} fill="currentColor"><title>{calendar[index].from} to {calendar[index].to}: {googleGa4MetricValue(metric,byKey.get(calendar[index].key)?.metrics[metric],currency)}</title></rect>)}</svg><div className="row between hint" role="group" aria-label="Trend calendar range"><time dateTime={overview.current.from}>From {overview.current.from}</time><time dateTime={overview.current.to}>To {overview.current.to}</time></div></> : <p className="dim">This trend metric is unavailable. No zero-valued chart is inferred.</p>}
    <details><summary>Quality and request provenance for all three stages</summary><p className="hint">Counts below describe successfully committed observations. Failed or retried requests can consume additional quota; this receipt is not a durable attempt counter.</p>{(['current','previous','trend'] as const).map(stage=><section key={stage}><h5>{stage}</h5><p>Committed observation: {overview[stage].reportRequests} report response · {overview[stage].compatibilityRequests} compatibility checks · {overview[stage].from} to {overview[stage].to}</p>{overview[stage].quality.warnings.map((warning,index)=><p className="hint" key={index}>{warning}</p>)}<pre style={{ whiteSpace:'pre-wrap', overflowWrap:'anywhere' }}>{JSON.stringify(overview[stage].quality.metadata,null,2)}</pre></section>)}</details>
  </section>;
}

function retained(imp: ImportDto): boolean {
  return imp.dataStatus === 'available' && (imp.status === 'completed' || imp.status === 'partial');
}

function defaultSource(connections: Connection[]): string {
  const newest = connections.reduce<Connection | undefined>((latest, c) => !latest || Date.parse(c.updatedAt) > Date.parse(latest.updatedAt) ? c : latest, undefined);
  if (newest && (newest.status === 'select_property' || (newest.status === 'ready' && !newest.imports.some(retained)))) return newest.id;
  return (connections.find(c => c.imports.some(retained)) ?? connections[0])?.id ?? '';
}

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
  const [selection, setSelection] = useState('');
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
    setSelection(previous => r.connections.some(c => c.id === previous) ? previous : defaultSource(r.connections));
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

      <div className="row google-source-picker">
        {overview.connections.length > 0 && <div className="field">
          <label htmlFor="google-source">Google source</label>
          <select id="google-source" value={selection} disabled={pending} onChange={e => setSelection(e.target.value)}>
            {overview.connections.map(c => <option key={c.id} value={c.id}>{c.name} · {PROVIDER_LABEL[c.provider]} · {connStatus(c.status)}</option>)}
          </select>
        </div>}
        <button type="button" className="btn ghost" style={BTN} aria-disabled={pending} onClick={manualRefresh}>Refresh status</button>
      </div>
      {notice && <p role="status" className="hint">{notice}</p>}
      {err !== '' && <p role="alert" className="alert">{err}</p>}
      {overview.connections.map(c => (
        <div key={c.id} hidden={selection !== c.id} className="google-source-panel">
        <ConnectionSection
          key={`${c.id}:${c.revision}:${overview.role}`}
          projectId={projectId}
          conn={c}
          owner={owner}
          appOn={appOn}
          ops={ops}
          onReconnect={conn => void connect(conn.provider, conn.name, conn.id)}
        />
        </div>
      ))}

      {owner && appOn && (
        <details className="card google-connect" open={overview.connections.length === 0}>
          <summary>Add a Google connection</summary>
          <div className="stack">
          <div className="field">
            <label htmlFor="g-provider">Provider</label>
            <select id="g-provider" disabled={pending} value={cProvider} onChange={e => setCProvider(e.target.value as Provider)}>
              <option value="gsc">Google Search Console</option>
              <option value="ga4">Google Analytics 4</option>
              <option value="ads" disabled={!overview.app.adsConfigured}>Google Ads</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="g-conn-name">Connection name</label>
            <input id="g-conn-name" type="text" maxLength={120} disabled={pending} value={cName} onChange={e => setCName(e.target.value)} />
          </div>
          <button type="button" className="btn primary" style={BTN} disabled={pending || cBusy || cName.trim() === ''} onClick={() => void connect(cProvider, cName.trim())}>Connect to Google</button>
          <p className="hint">{cProvider === 'ads' ? 'Google uses its broad Ads permission, which can permit account changes. This app only sends fixed reporting queries and never changes campaigns, ads or budgets.' : 'You are sent to Google to approve read-only access and then return here.'}</p>
          {!overview.app.adsConfigured && <p className="hint">For Ads reports, the instance operator must also save a Google Ads developer token in Google app setup.</p>}
          {cErr !== '' && <p role="alert" className="alert">{cErr}</p>}
          </div>
        </details>
      )}

      {overview.connections.length === 0 && (
        <p className="dim">No Google connections yet{owner && appOn ? '; connect a source above to get started.' : '.'}</p>
      )}

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
  const unsuccessful = conn.imports.filter(imp => imp.status === 'failed' || imp.status === 'denied').length;
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || ops.busy;
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [propsData, setPropsData] = useState<{ list: Array<{ id: string; name: string; loginCustomerId?: string | null }>; next: string | null } | null>(null);
  const [managerId, setManagerId] = useState('');
  const [pick, setPick] = useState('');
  const [report, setReport] = useState<ReportKind>(conn.provider === 'gsc' ? 'gsc_daily' : conn.provider === 'ads' ? 'ads_daily' : 'ga4_traffic');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const maxImportDay=organicReport(report)?googleLastCompletedDay(conn.timeZone):new Date().toISOString().slice(0,10);
  const [snapshotChoice, setSnapshotChoice] = useState(() => (conn.imports.find(retained) ?? conn.imports[0])?.id ?? '');
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusResult = useRef(false);
  const attempt = useRef<{ requestId: string; report: ReportKind; from: string; to: string } | null>(null);
  const [snap, setSnap] = useState<{
    id: string;
    imp: ImportDto;
    source: Snapshot['source'];
    dimensions: string[];
    metrics: string[];
    rows: Snapshot['rows'];
    warnings: string[];
    metadata: Record<string, unknown>;
    next: number | null;
  } | null>(null);
  useEffect(() => {
    setSnapshotChoice(previous => conn.imports.some(imp => imp.id === previous) ? previous : (conn.imports.find(retained) ?? conn.imports[0])?.id ?? '');
    setSnap(previous => {
      const receipt = previous && conn.imports.find(item => item.id === previous.id);
      if (previous && !receipt) return null;
      return previous && receipt?.dataStatus === 'expired' && previous.imp.dataStatus !== 'expired'
        ? { ...previous, imp: receipt, rows: [], warnings: [], metadata: {}, next: null } : previous;
    });
  }, [conn.imports]);
  useEffect(() => { if (focusResult.current && snap) { focusResult.current = false; resultHeading.current?.focus(); } }, [snap]);

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
      if (conn.provider === 'ads' && managerId && !/^[1-9]\d{9}$/.test(managerId)) { setErr('Enter the ten-digit manager customer ID without spaces or hyphens.'); return; }
      const r = await api<{ properties: Array<{ id: string; name: string; loginCustomerId?: string | null }>; nextPageToken: string | null }>(`${base}/properties`, {
        method: 'POST',
        body: conn.provider === 'ads' && managerId ? { managerCustomerId: managerId } : pageToken ? { pageToken } : {},
        signal: c.signal,
      });
      if (!ops.alive(serial, c)) return;
      if (!pageToken) setPick('');
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
    if (pick === '') { setErr(conn.provider === 'ads' ? 'Choose an account first.' : 'Choose a property first.'); return; }
    void run(async (serial, c) => {
      try {
        const selected = propsData?.list.find(p=>p.id===pick);
        await api(`${base}/select`, { method: 'POST', body: { propertyId: pick, ...(selected?.loginCustomerId ? { loginCustomerId: selected.loginCustomerId } : {}) }, signal: c.signal });
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
    if(from>to||Date.parse(to)-Date.parse(from)>=366*86400000){setErr('Choose a start on or before the end, covering no more than 366 days.');return;}
    if(organicReport(report)){const lastDay=googleLastCompletedDay(conn.timeZone);if(!lastDay){setErr('The property time zone is unavailable. Reconnect this source before importing.');return;}if(to>lastDay){setErr(`Choose completed days in ${conn.timeZone}; the latest end date is ${lastDay}.`);return;}}
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
      const path = `/api/projects/${projectId}/google/imports/${imp.id}?offset=0`;
      const r = organicReport(imp.report) ? await organicSnapshot(path, imp, conn, 0, c.signal) : await api<Snapshot>(path, { signal: c.signal });
      if (!ops.alive(serial, c)) return;
      focusResult.current = true;
      setSnap({ id: imp.id, imp: r.import, source: r.source, dimensions: r.dimensions, metrics: r.metrics, rows: r.import.dataStatus === 'expired' ? [] : r.rows, warnings: r.quality.warnings, metadata: r.quality.metadata, next: r.import.dataStatus === 'expired' ? null : r.nextOffset });
    } catch (e) {
      if (ops.terminal(serial, c, e)) return;
      if (ops.alive(serial, c)) setErr(errMsg(e));
    }
  });

  const moreSnap = () => run(async (serial, c) => {
    const offset = snap ? snap.next : null;
    if (!snap || offset === null) return;
    try {
      const path = `/api/projects/${projectId}/google/imports/${snap.id}?offset=${offset}`;
      const r = organicReport(snap.imp.report) ? await organicSnapshot(path, snap.imp, conn, offset, c.signal) : await api<Snapshot>(path, { signal: c.signal });
      if (!ops.alive(serial, c)) return;
      setSnap(prev => prev && prev.id === snap.id
        ? { ...prev, imp: r.import, rows: r.import.dataStatus === 'expired' ? [] : [...prev.rows, ...r.rows], warnings: r.quality.warnings, metadata: r.quality.metadata, next: r.import.dataStatus === 'expired' ? null : r.nextOffset }
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
        <span className={conn.status === 'ready' ? 'pill good' : conn.status === 'reconnect' ? 'pill bad' : 'pill'}>{conn.provider === 'ads' && conn.status === 'select_property' ? 'Account selection needed' : connStatus(conn.status)}</span>
      </div>
      {note !== '' && <p role="status" className="hint">{note}</p>}
      {err !== '' && <p role="alert" className="alert">{err}</p>}
      {unsuccessful > 0 && <p className="hint">{unsuccessful} unsuccessful {unsuccessful === 1 ? 'import' : 'imports'}. Open Import history for details.</p>}
      {conn.imports.filter(imp => ['queued', 'running'].includes(imp.status)).map(imp => (
        <p key={imp.id} role="status" className="hint">{reportLabel(imp.report)} · {imp.from} to {imp.to}: {impStatus(imp.status)}. {imp.diagnostic ?? 'Use Refresh status to follow progress.'}</p>
      ))}
      {conn.imports.length > 0 ? (
        <div className="stack google-snapshot-choice">
          <div className="row">
            <div className="field">
              <label htmlFor={'snapshot-' + conn.id}>Snapshot</label>
              <select id={'snapshot-' + conn.id} value={snapshotChoice} disabled={busy} onChange={e => setSnapshotChoice(e.target.value)}>
                {conn.imports.map(imp => <option key={imp.id} value={imp.id}>{reportLabel(imp.report)} · {imp.from} to {imp.to} · {impStatus(imp.status)}{imp.dataStatus === 'expired' ? ' · Expired' : ''}</option>)}
              </select>
            </div>
            <button type="button" className="btn primary" style={BTN} disabled={busy || !conn.imports.some(imp => imp.id === snapshotChoice)} onClick={() => { const imp = conn.imports.find(item => item.id === snapshotChoice); if (imp) void openSnap(imp); }}>View snapshot</button>
          </div>
          {conn.imports.filter(imp => imp.id === snapshotChoice).map(imp => <p key={imp.id} className="hint">Selected: {reportLabel(imp.report)} · {imp.from} to {imp.to} · {impStatus(imp.status)}{(imp.status === 'completed' || imp.status === 'partial') ? ' · ' + imp.rowCount + ' recorded rows' : ''}{imp.dataStatus === 'expired' ? ' · Report data expired' : ''}</p>)}
          {!snap && <p className="dim">Choose View snapshot to load this saved report.</p>}
        </div>
      ) : <p className="dim">No imports yet{owner && conn.status === 'ready' ? '; open Import a snapshot below to get started.' : '.'}</p>}
      {snap && (
        <div className="stack google-snapshot" role="region" aria-labelledby={'snapshot-heading-' + conn.id}>
          <h3 id={'snapshot-heading-' + conn.id} ref={resultHeading} tabIndex={-1}>Snapshot: {reportLabel(snap.imp.report)} · {snap.imp.from} to {snap.imp.to}</h3>
          <p className="hint">Showing snapshot requested {new Date(snap.imp.createdAt).toLocaleString()}{snapshotChoice !== snap.id ? ' · The selection above has changed. Choose View snapshot to replace these results.' : ''}</p>
          {snap.source.provider === 'ga4' && <p className="hint">{organicReport(snap.imp.report) ? 'Organic Search session-channel measurements. Landing-page users and trend users are non-additive; only the separate dimensionless overview reports establish whole-range aggregates.' : 'Daily Google Analytics property measurements. User counts are non-additive; no whole-range user total is calculated from these rows. Engagement time is total seconds, not an average.'} Key events remain separate from advertising conversions and native analytics.</p>}
          <p>Snapshot status: {impStatus(snap.imp.status)}</p>
          {snap.imp.diagnostic && <p role="status" className="hint">{snap.imp.diagnostic}</p>}
          <p className="dim">
            Source: {PROVIDER_LABEL[snap.source.provider]} · {snap.source.provider === 'ads' ? 'Account' : 'Property'}: {snap.source.propertyName ?? 'Unavailable'}{snap.source.propertyId ? ` (${snap.source.propertyId})` : ''} · Range: {snap.imp.from} to {snap.imp.to} · Time zone: {snap.source.timeZone ?? 'Unavailable'} · Currency: {snap.source.currencyCode ?? 'Unavailable'}
          </p>
          {snap.imp.status === 'partial' && <p role="status" className="alert">{snap.source.provider === 'ads' ? 'Partial import: Google returned a continuation after this bounded snapshot. Choose a smaller date range.' : 'Partial import: the page limit was reached, so this snapshot is incomplete.'}</p>}
          {snap.source.provider === 'ads' && <p className="hint">Google Ads {snap.source.apiVersion} · {snap.source.loginCustomerId ? `Manager ${snap.source.loginCustomerId}` : 'Direct access'} · {snap.imp.rowCount.toLocaleString()} stored rows. Provider match count: <bdi dir="ltr">{typeof snap.metadata.totalResultsCount === 'string' ? snap.metadata.totalResultsCount : 'Unavailable'}</bdi>. More provider rows: {snap.metadata.nextPageAvailable === true ? 'yes — not imported' : snap.metadata.nextPageAvailable === false ? 'no continuation returned' : 'Unavailable'}. These rows are not native events.</p>}
          {snap.warnings.length > 0 && (
            <ul className="hint">{snap.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          {snap.imp.dataStatus === 'available' && snap.imp.status === 'completed' && (snap.imp.report === 'ga4_organic_daily' || snap.imp.report === 'ga4_organic_weekly') && (() => { const overview = readOrganicOverview(snap.metadata.organic, snap.imp.from, snap.imp.to, snap.imp.report === 'ga4_organic_weekly'); return overview ? <OrganicSummary key={snap.id} overview={overview} rows={snap.rows} currency={snap.source.currencyCode} timeZone={snap.source.timeZone} /> : <p role="alert">The complete organic overview is unavailable. Import a fresh snapshot.</p>; })()}
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
                    {snap.dimensions.map(d => <th key={d} scope="col" title={d}>{snap.source.provider === 'ads' ? googleAdsColumnLabel(d) : snap.source.provider === 'ga4' ? googleGa4ColumnLabel(d) : d}</th>)}
                    {snap.metrics.map(m => <th key={m} scope="col" title={m}>{snap.source.provider === 'ads' ? googleAdsColumnLabel(m) : snap.source.provider === 'ga4' ? googleGa4ColumnLabel(m) : m}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {snap.rows.map((r, i) => (
                    <tr key={i}>
                      {snap.dimensions.map(d => <td key={d}>{r.dimensions[d] ?? ''}</td>)}
                      {snap.metrics.map(m => <td key={m} title={typeof r.metrics[m] === 'string' ? snap.source.provider === 'ads' && m === 'costMicros' ? `${r.metrics[m]} costMicros` : snap.source.provider === 'ga4' ? r.metrics[m]! : undefined : undefined}>{snap.source.provider === 'ads' && m === 'costMicros' ? <bdi dir="ltr">{googleAdsCost(r.metrics[m], snap.source.currencyCode)}</bdi> : snap.source.provider === 'ga4' ? <bdi dir="ltr">{googleGa4MetricValue(m, r.metrics[m], snap.source.currencyCode)}</bdi> : r.metrics[m] ?? 'Unavailable'}</td>)}
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
      {conn.status === 'select_property' && (
        owner && appOn ? (
          <div className="stack">
            <p className="hint">{conn.provider === 'ads' ? 'Choose the Ads account this connection reports on. The choice is permanent; add another connection for a different account.' : 'Choose the property this connection reports on. The choice is permanent; add another connection for a different property.'}</p>
            {conn.provider === 'ads' && <div className="field"><label htmlFor={`manager-${conn.id}`}>Manager customer ID (optional)</label><input id={`manager-${conn.id}`} inputMode="numeric" maxLength={10} disabled={busy} value={managerId} onChange={e=>{setManagerId(e.target.value);setPick('');setPropsData(null);}}/><p className="hint">Leave blank to list accounts you access directly. To use a manager, enter its ten-digit ID and load its advertising clients.</p></div>}
            {(!propsData || conn.provider === 'ads') && (
              <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void loadProps()}>{conn.provider === 'ads' ? 'Load Ads accounts' : 'Load available properties'}</button>
            )}
            {propsData && propsData.list.length === 0 && (
              <p className="dim">{conn.provider === 'ads' ? 'No accounts were returned for this Google access.' : 'No properties were returned for this Google account.'}</p>
            )}
            {propsData && propsData.list.length > 0 && (
              <>
                <div role="radiogroup" aria-label={`${conn.provider === 'ads' ? 'Choose account' : 'Properties'} for ${conn.name}`} className="stack">
                  {propsData.list.map(p => (
                    <label key={p.id} className="row" style={{ minHeight: 44 }}>
                      <input type="radio" disabled={busy} name={`prop-${conn.id}`} checked={pick === p.id} onChange={() => setPick(p.id)} />
                      <span>{p.name} <span className="dim">({p.id})</span></span>
                    </label>
                  ))}
                </div>
                {propsData.next !== null && conn.provider !== 'ads' && (
                  <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => void loadProps(propsData.next ?? undefined)}>Load more properties</button>
                )}
                <button type="button" className="btn primary" style={BTN} disabled={busy || pick === ''} onClick={chooseProp}>{conn.provider === 'ads' ? 'Use this Ads account' : 'Use this property'}</button>
              </>
            )}
          </div>
        ) : (
          <p className="hint">{conn.provider === 'ads' ? 'A workspace owner still needs to choose an account for this connection.' : 'A workspace owner still needs to choose a property for this connection.'}</p>
        )
      )}

      {owner && appOn && conn.status === 'ready' && (
        <details className="google-tools">
          <summary>Import a snapshot</summary>
        <div className="stack">
          <div className="field">
            <label htmlFor={`report-${conn.id}`}>Report</label>
            <select id={`report-${conn.id}`} disabled={busy} value={report} onChange={e => { setReport(e.target.value as ReportKind); attempt.current = null; }}>
              {REPORT_OPTIONS[conn.provider].map(o => <option key={o.kind} value={o.kind}>{o.label}</option>)}
            </select>
          </div>
          {conn.provider === 'ga4' && <p className="hint">{report === 'ga4_pages' ? 'Daily views and engagement by page path or app screen class.' : report === 'ga4_acquisition' ? 'Daily acquisition by session source, medium and campaign; this is not first-user attribution.' : report === 'ga4_key_events' ? 'Daily events Google marked as key at collection time. Key events are not Google Ads conversions.' : 'Daily property measurements reported by Google Analytics.'} Dates use {conn.timeZone ?? 'the property time zone'}. User counts are specific to each row; do not add them across dates or dimensions.</p>}
          {organicReport(report) && <p className="hint">Organic Search only. Choose completed days in the property timezone; today is excluded. {report === 'ga4_organic_landing' ? 'Landing pages are grouped by hostname and landing path over the whole selected range, up to 10,000 rows. A partial import is explicitly incomplete.' : 'Three report requests capture the current range, an equal-length preceding range, and the selected daily or weekly trend. Nothing is shown until all three finish. Two compatibility checks verify the exact fields; Google quota use and quality remain separate for each stage.'}</p>}
          <div className="row">
            <div className="field">
              <label htmlFor={`from-${conn.id}`}>Start date</label>
              <input id={`from-${conn.id}`} type="date" disabled={busy} max={maxImportDay??undefined} value={from} onChange={e => { setFrom(e.target.value); attempt.current = null; }} />
            </div>
            <div className="field">
              <label htmlFor={`to-${conn.id}`}>End date</label>
              <input id={`to-${conn.id}`} type="date" disabled={busy} min={from || undefined} max={maxImportDay??undefined} value={to} onChange={e => { setTo(e.target.value); attempt.current = null; }} />
            </div>
          </div>
          <p className="hint">Dates are inclusive, up to 366 days, and cannot be in the future. Each import is a separate snapshot.{conn.provider === 'ads' ? ' Ads dates use the account time zone. One provider page is imported, up to 10,000 rows and 2 MiB; continuation means partial. For a size refusal or partial snapshot, choose a smaller range.' : ''}</p>
          <button type="button" className="btn primary" style={BTN} disabled={busy} onClick={queueImport}>Import report snapshot</button>
        </div>
        </details>
      )}

      {conn.imports.length > 0 && (
        <details className="google-tools"><summary>Import history</summary>
        <ul className="google-imports">
          {conn.imports.map(imp => (
            <li key={imp.id} className="stack">
              <div className="row">
                <span>{reportLabel(imp.report)} · {imp.from} to {imp.to} · {impStatus(imp.status)}{(imp.status === 'completed' || imp.status === 'partial') ? ` · ${imp.rowCount} recorded rows` : ''}{imp.dataStatus === 'expired' ? ' · Report data expired' : ''}</span>
                <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => { setSnapshotChoice(imp.id); void openSnap(imp); }}>View snapshot</button>
              </div>
              {(imp.status === 'queued' || imp.status === 'running') && (
                <p className="dim">{imp.status === 'queued' ? 'Queued.' : 'Running.'} Use Refresh status to follow progress.</p>
              )}
              {imp.diagnostic !== null && <p className="hint">{imp.diagnostic}</p>}
            </li>
          ))}
        </ul>
        </details>
      )}
      {owner && appOn && conn.provider === 'gsc' && conn.status === 'ready' && conn.propertyId && <GoogleInspectionPanel key={`${conn.id}:${conn.revision}:${conn.propertyId}`} projectId={projectId} connection={{id:conn.id,revision:conn.revision,propertyId:conn.propertyId}} ops={ops} />}

      {(conn.status === 'reconnect' || conn.status === 'disconnected') && owner && appOn && (
        <div className="row">
          <p className="hint">{conn.status === 'disconnected' ? 'Reconnect to import new reports. Existing snapshots remain available until they expire.' : 'Google access needs renewal for this connection.'}</p>
          <button type="button" className="btn primary" style={BTN} disabled={busy} onClick={() => onReconnect(conn)}>Reconnect to Google</button>
        </div>
      )}

      <details className="google-tools"><summary>Connection details</summary>
        <div className="stack">
      <p className="dim">
        {conn.provider === 'ads' ? 'Account' : 'Property'}: {conn.propertyName ?? 'Not selected'}{conn.propertyId ? ` (${conn.propertyId})` : ''} · Time zone: {conn.timeZone ?? 'Not set'} · Currency: {conn.currencyCode ?? 'Not set'}
      </p>
      {conn.provider === 'ads' && <p className="hint">Ads reporting only · {conn.loginCustomerId ? `Manager ${conn.loginCustomerId}` : 'Direct customer access'}. Costs are account-currency micros; 1,000,000 micros equals one currency unit. Google-defined conversions remain separate from native analytics.</p>}

      {owner && conn.status !== 'disconnected' && (
        <div className="row">
          <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => disconnect(false)}>Disconnect</button>
          <button type="button" className="btn ghost" style={BTN} disabled={busy} onClick={() => disconnect(true)}>Disconnect and revoke at Google</button>
        </div>
      )}

        </div>
      </details>
    </section>
  );
}
