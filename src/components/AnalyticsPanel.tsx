import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import './analytics.css';

export type AnalyticsPanelProps = {
  projectId: string;
  onUnauthorized: () => void;
};

type Daily = { date: string; pageViews: number; customEvents: number };
type Analytics = {
  range: { from: string; to: string; timeZone: 'UTC' };
  totals: { pageViews: number; customEvents: number };
  measurement: {
    identifiedPageViews: number; unidentifiedPageViews: number;
    visitors: number | null; visits: number | null;
    bounceRate: number | null; averageVisitSeconds: number | null;
  };
  daily: Daily[];
  pages: { path: string; pageViews: number }[];
  events: { name: string; count: number }[];
  lastReceivedAt: string | null;
};
type Range = { from: string; to: string };

type View = {
  key: string; // projectId this state belongs to; stale data is never rendered
  range: Range; // applied range (drives fetching)
  draft: Range; // custom date inputs (applied only via Apply)
  draftErr: string | null;
  data: Analytics | null;
  error: string | null;
  loading: boolean;
  nonce: number; // lets Apply/Retry refetch an unchanged range
};

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Returns ms epoch for a real YYYY-MM-DD date (UTC), or null. */
function parseDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date ? null : t;
}

function lastDays(n: number): Range {
  const to = todayUtc();
  return { from: shiftDays(to, -(n - 1)), to };
}

function fresh(projectId: string): View {
  const range = lastDays(7);
  return { key: projectId, range, draft: range, draftErr: null, data: null, error: null, loading: true, nonce: 0 };
}

function fmtUtc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const fmtNum = (n: number) => n.toLocaleString('en-US');

function DailyChart({ daily }: { daily: Daily[] }) {
  if (daily.length === 0) return <p className="dim">No daily breakdown available for this range.</p>;
  const max = Math.max(1, ...daily.flatMap((d) => [d.pageViews, d.customEvents]));
  const slot = 12;
  const height = 160;
  const base = 170;
  const width = daily.length * slot;
  const first = daily[0].date;
  const last = daily[daily.length - 1].date;
  return (
    <>
      <svg
        className="analytics-chart"
        viewBox={`0 0 ${width} 180`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bar chart of daily page views and custom events in UTC, from ${first} to ${last}. Full numbers in the daily data table below.`}
      >
        {daily.map((d, i) => {
          const pvH = (d.pageViews / max) * height;
          const ceH = (d.customEvents / max) * height;
          const x = i * slot;
          return (
            <g key={d.date}>
              <rect className="analytics-bar-pv" x={x + 1} y={base - pvH} width={4.5} height={pvH}>
                <title>{`${d.date}: ${d.pageViews} page views`}</title>
              </rect>
              <rect className="analytics-bar-ce" x={x + 6.5} y={base - ceH} width={4.5} height={ceH}>
                <title>{`${d.date}: ${d.customEvents} custom events`}</title>
              </rect>
            </g>
          );
        })}
        <line className="analytics-baseline" x1={0} y1={base} x2={width} y2={base} />
      </svg>
      <div className="analytics-axis" aria-hidden="true">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <p className="analytics-legend">
        <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-pv" aria-hidden="true" /> Page views
        </span>
        <span className="analytics-key">
          <span className="analytics-swatch analytics-swatch-ce" aria-hidden="true" /> Custom events
        </span>
      </p>
    </>
  );
}

export function AnalyticsPanel({ projectId, onUnauthorized }: AnalyticsPanelProps) {
  const uid = useId();
  const [view, setView] = useState<View>(() => fresh(projectId));
  // Synchronous reset on project switch: never render another project's data.
  if (view.key !== projectId) setView(fresh(projectId));

  const reqRef = useRef(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  const { from, to } = view.range;
  const nonce = view.nonce;
  useEffect(() => {
    const id = ++reqRef.current;
    const ctrl = new AbortController();
    api<Analytics>(
      `/api/projects/${encodeURIComponent(projectId)}/analytics?from=${from}&to=${to}`,
      { signal: ctrl.signal },
    ).then(
      (data) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId) return;
        setView((v) => (v.key === projectId ? { ...v, data, loading: false, error: null } : v));
      },
      (err: unknown) => {
        if (id !== reqRef.current || ctrl.signal.aborted || projectRef.current !== projectId) return;
        if (err instanceof ApiError && err.status === 401) {
          unauthRef.current();
          return;
        }
        setView((v) => (v.key === projectId ? { ...v, loading: false, error: errMsg(err) } : v));
      },
    );
    return () => ctrl.abort();
  }, [projectId, from, to, nonce]);

  const applyRange = (range: Range) =>
    setView((v) => ({ ...v, range, draft: range, draftErr: null, data: null, loading: true, error: null, nonce: v.nonce + 1 }));

  const retry = () => setView((v) => ({ ...v, loading: true, error: null, nonce: v.nonce + 1 }));

  const applyDraft = (e: FormEvent) => {
    e.preventDefault();
    const f = parseDay(view.draft.from);
    const t = parseDay(view.draft.to);
    let msg: string | null = null;
    if (f === null || t === null) msg = 'Enter valid dates in YYYY-MM-DD format.';
    else if (f > t) msg = 'The start date must be on or before the end date.';
    else if (view.draft.to > todayUtc()) msg = 'Dates cannot be in the future.';
    else if ((t - f) / DAY_MS >= MAX_DAYS) msg = `The range can span at most ${MAX_DAYS} days.`;
    if (msg) {
      setView((v) => ({ ...v, draftErr: msg }));
      return;
    }
    applyRange({ from: view.draft.from, to: view.draft.to });
  };

  const busy = view.loading;
  const data = view.data;
  const today = todayUtc();
  const hasData = data !== null && data.totals.pageViews + data.totals.customEvents > 0;

  return (
    <div className="analytics" aria-busy={busy}>
      <section className="card">
        <h2>Analytics</h2>
        <form onSubmit={applyDraft}>
          <fieldset className="analytics-fieldset" disabled={busy}>
            <legend>Time range (UTC)</legend>
            <div className="analytics-presets">
              {PRESETS.map((p) => {
                const active = view.range.from === shiftDays(today, -(p.days - 1)) && view.range.to === today;
                return (
                  <button
                    key={p.days}
                    type="button"
                    className={active ? 'btn analytics-preset active' : 'btn analytics-preset'}
                    aria-pressed={active}
                    onClick={() => applyRange(lastDays(p.days))}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="analytics-dates">
              <div className="analytics-date">
                <label htmlFor={`${uid}-from`}>From (UTC)</label>
                <input
                  id={`${uid}-from`}
                  type="date"
                  value={view.draft.from}
                  max={today}
                  onChange={(e) => setView((v) => ({ ...v, draft: { ...v.draft, from: e.target.value } }))}
                />
              </div>
              <div className="analytics-date">
                <label htmlFor={`${uid}-to`}>To (UTC)</label>
                <input
                  id={`${uid}-to`}
                  type="date"
                  value={view.draft.to}
                  max={today}
                  onChange={(e) => setView((v) => ({ ...v, draft: { ...v.draft, to: e.target.value } }))}
                />
              </div>
              <button type="submit" className="btn primary analytics-apply">
                Apply
              </button>
            </div>
          </fieldset>
          {view.draftErr && (
            <p className="err-text analytics-draft-err" role="alert">
              {view.draftErr}
            </p>
          )}
          <p className="hint">All dates and times are in UTC. The range includes both endpoints, up to 366 days.</p>
        </form>
      </section>

      {view.error && (
        <div className="alert" role="alert">
          <p>Could not load analytics for this range: {view.error}</p>
          <button type="button" className="btn" onClick={retry} disabled={busy}>
            Retry
          </button>
        </div>
      )}

      {busy && !data && !view.error && (
        <section className="card">
          <p className="dim" role="status">
            Loading analytics…
          </p>
        </section>
      )}

      {data && (
        <>
          <section className="card">
            <div className="row between">
              <h2>Overview</h2>
              <span className="dim analytics-range-label">
                {data.range.from} to {data.range.to} (UTC)
              </span>
            </div>
            <div className="analytics-stats">
              <div className="analytics-stat">
                <span className="analytics-stat-label">Page views</span>
                <p className="big-num">{fmtNum(data.totals.pageViews)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Custom events</span>
                <p className="big-num">{fmtNum(data.totals.customEvents)}</p>
              </div>
            </div>
            <div className="analytics-stats">
              <div className="analytics-stat">
                <span className="analytics-stat-label">Estimated visitors</span>
                <p className={data.measurement.visitors === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.visitors === null ? 'Unavailable' : fmtNum(data.measurement.visitors)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Visits</span>
                <p className={data.measurement.visits === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.visits === null ? 'Unavailable' : fmtNum(data.measurement.visits)}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Bounce rate</span>
                <p className={data.measurement.bounceRate === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.bounceRate === null ? 'Unavailable' : `${data.measurement.bounceRate.toFixed(1)}%`}</p>
              </div>
              <div className="analytics-stat">
                <span className="analytics-stat-label">Average observed visit</span>
                <p className={data.measurement.averageVisitSeconds === null ? 'analytics-unavailable' : 'big-num'}>{data.measurement.averageVisitSeconds === null ? 'Unavailable' : `${data.measurement.averageVisitSeconds.toFixed(1)} s`}</p>
              </div>
            </div>
            <p className="hint">Visitor and visit estimates cover {fmtNum(data.measurement.identifiedPageViews)} of {fmtNum(data.totals.pageViews)} page views. Page views without a visitor estimate remain in traffic totals.</p>
            <details className="analytics-details">
              <summary>How these estimates work</summary>
              <p>Visitors use a monthly, project-specific estimate. They are not a count of unique people. Network measurement must be configured by the installation operator; otherwise visitor and visit estimates are unavailable.</p>
              <p>Visits use hourly keys, with an existing page context retained for up to 30 minutes. A bounce has one page view and no custom events within this date range. Duration runs from the first to the last page view; it does not measure active engagement or time after the last page view.</p>
            </details>
            <p className="footnote dim">
              {data.lastReceivedAt
                ? `Last event received ${fmtUtc(data.lastReceivedAt)}.`
                : 'No events in this date range.'}
            </p>
          </section>

          <section className="card">
            <h2>Daily activity (UTC)</h2>
            {!hasData ? (
              <div className="empty">
                <p>
                  <strong>No events in this range.</strong>
                </p>
                <p>Try a wider range, or check back after the project receives traffic.</p>
              </div>
            ) : (
              <>
                <DailyChart daily={data.daily} />
                <details className="analytics-details">
                  <summary>Daily data table</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Date (UTC)</th>
                          <th scope="col" className="analytics-num">
                            Page views
                          </th>
                          <th scope="col" className="analytics-num">
                            Custom events
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.daily.map((d) => (
                          <tr key={d.date}>
                            <td className="mono">{d.date}</td>
                            <td className="analytics-num">{fmtNum(d.pageViews)}</td>
                            <td className="analytics-num">{fmtNum(d.customEvents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          <section className="card">
            <h2>Top pages</h2>
            <p className="hint">Up to 20 paths in this date range.</p>
            {data.pages.length === 0 ? (
              <p className="dim">No page views in this range.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col" className="analytics-num">
                        Page views
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.slice(0, 20).map((p) => (
                      <tr key={p.path}>
                        <td className="mono analytics-path">{p.path}</td>
                        <td className="analytics-num">{fmtNum(p.pageViews)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Top custom events</h2>
            <p className="hint">Up to 20 event names in this date range.</p>
            {data.events.length === 0 ? (
              <p className="dim">No custom events in this range.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Event name</th>
                      <th scope="col" className="analytics-num">
                        Count
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.slice(0, 20).map((ev) => (
                      <tr key={ev.name}>
                        <td className="mono analytics-path">{ev.name}</td>
                        <td className="analytics-num">{fmtNum(ev.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
