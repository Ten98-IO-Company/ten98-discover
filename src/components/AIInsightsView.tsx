import {useState} from 'react';
import type {InsightCoverage, InsightMetric} from '../server/prompt-insights';
export type AIInsightsDraft = {
  from: string; to: string; timeZone: string; model: string;
  promptId: string; tag: string;
  matcher: 'unicode-boundary-v1' | 'elmo-substring-v1';
};

export type AIInsightsViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  reading: boolean; exporting: boolean;
  error: string; notice: string; filterError: string; dirty: boolean;
  draft: AIInsightsDraft;
  promptSearch: string;
  promptOptions: {id: string; label: string}[];
  canPreviousPrompts: boolean; canNextPrompts: boolean;
  canApply: boolean;
  backLabel: string;
  report: null | {
    scopeLabel: string; contextLabel: string; snapshotLabel: string;
    warnings: string[];
    coverageCounts: Pick<InsightCoverage, 'attempted' | 'eligible'>;
    brandCitationDomainCount: number; pooledModels: boolean;
    coverage: {label: string; value: string}[];
    metrics: {id: string; name: string; visibility: string;
      shareOfVoice: string; citations: string; canDrill: boolean; counts: InsightMetric}[];
    dailyEntityId: string;
    dailyEntities: {id: string; label: string}[];
    dailyRows: {date: string; attempted: string; eligible: string;
      visibility: string; shareOfVoice: string; citations: string; counts: InsightMetric;
      coverageCounts: Pick<InsightCoverage, 'attempted' | 'eligible'>}[];
    drilldownLabel: string; rowCountLabel: string;
    executions: {id: string; requestedAt: string; model: string;
      eligibility: string; matches: string}[];
    canPrevious: boolean; canNext: boolean; canExport: boolean;
  };
  onChange: (field: keyof AIInsightsDraft, value: string) => void;
  onPromptSearchChange: (value: string) => void;
  onSearchPrompts: () => void;
  onPreviousPrompts: () => void; onNextPrompts: () => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onDailyEntity: (id: string) => void;
  onDrilldown: (outcome: 'all' | 'eligible' | 'unavailable' |
    'mentioned' | 'not_mentioned' | 'cited', entityId?: string) => void;
  onPrevious: () => void; onNext: () => void;
  onOpenExecution: (id: string) => void;
  onExport: () => void; onCancelExport: () => void;
};

const controlStyle = { minHeight: 44, maxWidth: '100%' };
const wrapStyle = { width: '100%', minWidth: 0, maxWidth: '100%', overflowX: 'auto' } as const;
type TrendMetric = 'visibility' | 'shareOfVoice' | 'citations';
const metricLabels: Record<TrendMetric, string> = {visibility: 'Mention rate', shareOfVoice: 'Share of tracked mentions', citations: 'Citing-answer rate'};
function percentage(counts: InsightMetric, metric: TrendMetric): number | null {
  const denominator = metric === 'visibility' ? counts.eligibleAnswers : metric === 'shareOfVoice' ? counts.shareOfVoiceDenominator : counts.citationDenominator;
  return denominator === null || denominator <= 0 ? null : 100 * (metric === 'citations' ? counts.citations : counts.mentions) / denominator;
}
const percentText = (value: number | null) => value === null ? 'Unavailable' : value.toFixed(1).replace(/\.0$/, '') + '%';
function focusRegion(id: string) { const region = document.getElementById(id); region?.focus(); region?.scrollIntoView({block: 'nearest'}); }

function DailyTrend({report, metric, prefix}: {report: NonNullable<AIInsightsViewProps['report']>; metric: TrendMetric; prefix: string}) {
  const points = report.dailyRows.map((row, index) => ({row, value: percentage(row.counts, metric), x: report.dailyRows.length === 1 ? 300 : 4 + index * 592 / (report.dailyRows.length - 1)}));
  const segments: typeof points[] = []; let segment: typeof points = [];
  for (const point of points) { if (point.value === null) segment = []; else { if (!segment.length) segments.push(segment); segment.push(point); } }
  const name = report.dailyEntities.find(entity => entity.id === report.dailyEntityId)?.label ?? 'Selected entity';
  return <div className="ai-daily-trend">
    {segments.length ? <><div className="ai-trend-plot" dir="ltr"><div className="ai-trend-y" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label={`${metricLabels[metric]} for ${name} by requested day. Exact counts are in Daily observations.`} aria-describedby={`${prefix}scope ${prefix}trend-help`}>
      {[10,90,170].map(y => <line className="ai-trend-grid" key={y} x1="0" x2="600" y1={y} y2={y}/>)}
      {points.filter(point => point.value === null).map(point => <line className="ai-trend-missing" data-date={point.row.date} key={point.row.date} x1={point.x} x2={point.x} y1="10" y2="170"><title>{point.row.date}: Unavailable</title></line>)}
      {segments.filter(points => points.length > 1).map((points, index) => <polyline className="ai-trend-line" key={index} points={points.map(point => `${point.x},${170 - point.value! * 1.6}`).join(' ')}/>)}
      {points.filter(point => point.value !== null).map(point => <circle className="ai-trend-point" data-date={point.row.date} data-rate={point.value} key={point.row.date} cx={point.x} cy={170 - point.value! * 1.6} r="3"><title>{point.row.date}: {percentText(point.value)} · {point.row.coverageCounts.eligible} eligible of {point.row.coverageCounts.attempted} attempted</title></circle>)}
    </svg></div><div className="ai-trend-axis" dir="ltr"><bdi>{report.dailyRows[0]?.date}</bdi>{report.dailyRows.length > 1 && <bdi>{report.dailyRows.at(-1)?.date}</bdi>}</div></> : <p className="dim">{!report.coverageCounts.attempted ? 'No executions in the applied range.' : !report.coverageCounts.eligible ? 'No eligible retained answers. See Answer coverage below.' : 'Eligible answers are available, but no tracked entity was mentioned on these days.'}</p>}
    <p className="hint" id={prefix + 'trend-help'}>By requested day in the applied timezone. Dotted columns mark unavailable days; gaps are not filled or carried forward. The numerical table below includes every day.</p>
  </div>;
}

export function AIInsightsView(props: AIInsightsViewProps) {
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('visibility');
  const {
    prefix, role, reading, exporting, error, notice, filterError, dirty,
    draft, promptSearch, promptOptions, canPreviousPrompts, canNextPrompts,
    canApply, backLabel, report,
    onChange, onPromptSearchChange, onSearchPrompts, onPreviousPrompts,
    onNextPrompts, onApply, onReload, onBack, onDailyEntity, onDrilldown,
    onPrevious, onNext, onOpenExecution, onExport, onCancelExport,
  } = props;
  const busy = reading || exporting;
  const known = role !== null;
  const draftOff = !known || busy;
  const applyOff = !known || !canApply || busy;
  const prevPromptsOff = !known || busy || !canPreviousPrompts;
  const nextPromptsOff = !known || busy || !canNextPrompts;
  const reportOff = !known || report === null || dirty || busy;
  const prevOff = !known || report === null || dirty || busy || !report.canPrevious;
  const nextOff = !known || report === null || dirty || busy || !report.canNext;
  const exportOff = !known || report === null || dirty || busy || !report.canExport;
  const brand = report?.metrics.find(entity => entity.id === 'brand');
  const leaders = report ? [...report.metrics].sort((a,b) => b.counts.mentions - a.counts.mentions).slice(0,5) : [];

  return (
    <div className="research-panel stack" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <h2 id={prefix + 'heading'} tabIndex={-1} style={{ marginRight: 'auto' }}>AI insights</h2>
        <button type="button" className="btn btn-secondary" style={controlStyle} onClick={onBack}>{backLabel}</button>
        <button type="button" className="btn btn-secondary" style={controlStyle} disabled={busy}
          onClick={() => { if (busy) return; onReload(); }}>Reload insights</button>
        {known && report !== null && (
          <>
            <button type="button" className="btn" style={controlStyle} disabled={exportOff}
              onClick={() => { if (exportOff) return; onExport(); }}>Export report CSV</button>
            {exporting && (
              <button type="button" className="btn btn-secondary" style={controlStyle}
                onClick={() => { if (!exporting) return; onCancelExport(); }}>Cancel export</button>
            )}
          </>
        )}
      </div>

      {known && report !== null && (
        <p className="hint">Exports all executions in the applied report, including coverage and entity metrics; not only this drilldown.</p>
      )}

      {reading && <p className="hint" role="status">Reading insights…</p>}
      {exporting && <p className="hint" role="status">Exporting report CSV…</p>}
      {error !== '' && <div className="alert" role="alert">{error}</div>}
      {notice !== '' && <p className="hint" role="status">{notice}</p>}

      {known && report !== null && (
        <div className="stack">
          <p id={prefix + 'scope'}><strong>{report.scopeLabel}</strong></p>
          <p className="hint">{report.contextLabel}</p>
          <p className="hint">Source: OpenRouter API · web search off. Not consumer ChatGPT or search observations. Market and language not recorded.</p>
          {report.pooledModels && <p className="hint">The All models view pools retained answers. Each model answer counts separately; these rates are not a balanced model comparison.</p>}
          <p className="hint">{report.snapshotLabel}</p>
          {report.warnings.length > 0 && (
            <ul className="stack">
              {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {known && (
        <details open={!report || dirty || filterError !== ''}>
          <summary>Report filters</summary>
          <form className="stack" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (applyOff) return; onApply(); }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))', gap: 12 }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'from'}>From</label>
                <input id={prefix + 'from'} type="date" value={draft.from} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('from', e.target.value); }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'to'}>To</label>
                <input id={prefix + 'to'} type="date" value={draft.to} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('to', e.target.value); }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'timezone'}>Timezone</label>
                <input id={prefix + 'timezone'} type="text" value={draft.timeZone} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('timeZone', e.target.value); }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'model'}>Model</label>
                <select id={prefix + 'model'} value={draft.model} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('model', e.target.value); }}>
                  <option value="">All models</option>
                  <option value="openai/gpt-4o-mini">GPT-4o mini</option>
                  <option value="openai/gpt-4o">GPT-4o</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'prompt'}>Prompt</label>
                <select id={prefix + 'prompt'} value={draft.promptId} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('promptId', e.target.value); }}>
                  <option value="">All prompts</option>
                  {promptOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'tag'}>Current tag</label>
                <input id={prefix + 'tag'} type="text" value={draft.tag} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('tag', e.target.value); }} />
                <p className="hint">Matches current user tags; historical tags were not recorded.</p>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'matcher'}>Matching method</label>
                <select id={prefix + 'matcher'} value={draft.matcher} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onChange('matcher', e.target.value); }}>
                  <option value="unicode-boundary-v1">Unicode word boundaries</option>
                  <option value="elmo-substring-v1">Elmo substring baseline</option>
                </select>
                <p className="hint">Substring matching can include parts of unrelated words.</p>
              </div>
            </div>

            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={prefix + 'prompt-search'}>Find prompt</label>
                <input id={prefix + 'prompt-search'} type="search" value={promptSearch} disabled={draftOff} style={controlStyle}
                  onChange={(e) => { if (draftOff) return; onPromptSearchChange(e.target.value); }} />
              </div>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={draftOff}
                onClick={() => { if (draftOff) return; onSearchPrompts(); }}>Search prompts</button>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={prevPromptsOff}
                onClick={() => { if (prevPromptsOff) return; onPreviousPrompts(); }}>Previous prompts</button>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={nextPromptsOff}
                onClick={() => { if (nextPromptsOff) return; onNextPrompts(); }}>Next prompts</button>
            </div>

            {filterError !== '' && <div className="alert" role="alert">{filterError}</div>}

            <div className="row">
              <button type="submit" className="btn" style={controlStyle} disabled={applyOff}>Apply filters</button>
            </div>
          </form>
        </details>
      )}
      {known && dirty && <p className="hint">Unapplied filter changes. The report below still uses the applied filters.</p>}

      {known && report !== null && brand && <section className="ai-insights-overview stack" aria-labelledby={prefix + 'overview'}>
        <div className="row between"><h3 id={prefix + 'overview'}><bdi>{brand.name}</bdi> <span className="pill">You</span></h3><button type="button" className="btn" style={controlStyle} disabled={reportOff || !brand.canDrill} onClick={() => { if (!reportOff && brand.canDrill) onDrilldown('mentioned', 'brand'); }}>View brand mentions</button></div>
        <div className="ai-overview-cards">{(['visibility','shareOfVoice','citations'] as const).map(metric => <section className="card" key={metric} aria-label={metric === 'visibility' ? 'Brand mention rate' : metric === 'shareOfVoice' ? 'Brand share of tracked mentions' : 'Answers citing brand domains'}><h4>{metric === 'visibility' ? 'Brand mention rate' : metric === 'shareOfVoice' ? metricLabels[metric] : 'Answers citing brand domains'}</h4><p className="ai-overview-value">{percentText(percentage(brand.counts,metric))}</p><p className="hint"><bdi dir="ltr">{brand[metric]}</bdi></p><p className="hint">{metric === 'shareOfVoice' ? 'Share of entity-answer matches across the full current tracked set.' : metric === 'citations' ? `Eligible answers with provider citation hits · ${report.brandCitationDomainCount} configured brand citation domains.` : 'Eligible answers mentioning your current brand name or aliases.'}</p></section>)}</div>
        <p className="hint">{report.coverageCounts.eligible} eligible of {report.coverageCounts.attempted} attempted answers. Mentions and provider citation hits are separate; website-content coverage is not measured here.{report.metrics.length === 1 ? ' Only your brand is configured, so share is not a competitor comparison.' : ''}</p>
        <section className="card stack" aria-labelledby={prefix + 'trend'}>
          <div className="row between"><h3 id={prefix + 'trend'}>Daily trend</h3><button type="button" className="btn ghost" style={controlStyle} disabled={reportOff} onClick={() => { if (!reportOff) focusRegion(prefix + 'daily-data'); }}>View exact daily values</button></div>
          <div className="ai-trend-controls"><div className="field"><label htmlFor={prefix + 'daily-entity'}>Daily entity</label><select id={prefix + 'daily-entity'} value={report.dailyEntityId} disabled={reportOff} style={controlStyle} onChange={e => { if (!reportOff) onDailyEntity(e.target.value); }}>{report.dailyEntities.map(entity => <option key={entity.id} value={entity.id}>{entity.label}</option>)}</select></div><div className="field"><label htmlFor={prefix + 'trend-metric'}>Trend metric</label><select id={prefix + 'trend-metric'} value={trendMetric} disabled={reportOff} style={controlStyle} onChange={e => { if (!reportOff && Object.hasOwn(metricLabels,e.target.value)) setTrendMetric(e.target.value as TrendMetric); }}>{Object.entries(metricLabels).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></div></div>
          <DailyTrend report={report} metric={trendMetric} prefix={prefix}/>
        </section>
        <section className="card stack" aria-labelledby={prefix + 'leaderboard'}>
          <div className="row between"><h3 id={prefix + 'leaderboard'}>Brand and competitors</h3><button type="button" className="btn ghost" style={controlStyle} disabled={reportOff} onClick={() => { if (!reportOff) focusRegion(prefix + 'metrics-data'); }}>View all entity metrics</button></div>
          <p className="hint">{report.metrics.length > 5 ? `Top 5 of ${report.metrics.length}` : `All ${report.metrics.length}`} current tracked entities, ordered by mentions. Shares use all tracked entity-answer matches, not only this list. This is not market share.</p>
          {report.coverageCounts.eligible > 0 && !brand.counts.shareOfVoiceDenominator && <p className="dim">No tracked entity was mentioned in the eligible answers.</p>}
          <ul className="ai-leaderboard">{leaders.map(entity => <li key={entity.id}><div className="ai-leaderboard-heading"><strong><bdi>{entity.name}</bdi> {entity.id === 'brand' && <span className="pill">You</span>}</strong><button type="button" className="btn ghost" style={controlStyle} aria-label={'View mentioned answers for ' + entity.name} disabled={reportOff || !entity.canDrill} onClick={() => { if (!reportOff && entity.canDrill) onDrilldown('mentioned',entity.id); }}>View answers</button></div><p>Mentions: <bdi dir="ltr">{entity.visibility}</bdi></p><div className="ai-leaderboard-share">{percentage(entity.counts,'shareOfVoice') === null ? <span className="hint" aria-hidden="true">—</span> : <meter min="0" max="100" value={percentage(entity.counts,'shareOfVoice')!} aria-hidden="true"/>}<span>Share: <bdi dir="ltr">{entity.shareOfVoice}</bdi></span></div></li>)}</ul>
        </section>
      </section>}

      {known && report !== null && (
        <div className="card stack">
          <section className="stack">
            <h3 id={prefix + 'metrics'}>Entity metrics</h3>
            <p className="hint" id={prefix + 'metrics-scroll'}>Scroll horizontally to see every column.</p>
            <div id={prefix + 'metrics-data'} className="table-wrap" role="region" aria-label="Entity metrics" aria-describedby={prefix + 'metrics-scroll'} tabIndex={0} style={wrapStyle}>
              <table style={{ minWidth: 800 }}>
                <caption>Entity metrics</caption>
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col">Visibility</th>
                    <th scope="col">Share of voice</th>
                    <th scope="col">Citations</th>
                    <th scope="col">Drilldown</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metrics.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td>{m.visibility}</td>
                      <td>{m.shareOfVoice}</td>
                      <td>{m.citations}</td>
                      <td>
                        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                          <button type="button" className="btn btn-secondary" style={controlStyle}
                            aria-label={'Show mentions for ' + m.name}
                            disabled={reportOff || !m.canDrill}
                            onClick={() => { if (reportOff || !m.canDrill) return; onDrilldown('mentioned', m.id); }}>Mentions</button>
                          <button type="button" className="btn btn-secondary" style={controlStyle}
                            aria-label={'Show non-mentions for ' + m.name}
                            disabled={reportOff || !m.canDrill}
                            onClick={() => { if (reportOff || !m.canDrill) return; onDrilldown('not_mentioned', m.id); }}>Non-mentions</button>
                          <button type="button" className="btn btn-secondary" style={controlStyle}
                            aria-label={'Show citations for ' + m.name}
                            disabled={reportOff || !m.canDrill}
                            onClick={() => { if (reportOff || !m.canDrill) return; onDrilldown('cited', m.id); }}>Citations</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stack">
            <h3 id={prefix + 'coverage'}>Answer coverage</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
              {report.coverage.map((c) => (
                <div key={c.label}><strong>{c.label}:</strong> {c.value}</div>
              ))}
            </div>
          </section>

          <details>
            <summary>Selection details</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <p className="hint">{report.snapshotLabel}</p>
              <ul className="stack hint">
                <li>Recomputed from retained answers using current project context.</li>
                <li>OpenRouter API · web search off. No consumer ChatGPT/search inference.</li>
                <li>Daily dates use the comparison's requested day in the applied timezone.</li>
                <li>Provider citation annotations are separate from prose mentions.</li>
              </ul>
            </div>
          </details>

          <section className="stack">
            <h3 id={prefix + 'daily'}>Daily observations</h3>
            <p className="hint" id={prefix + 'daily-scroll'}>Scroll horizontally to see every column.</p>
            <div id={prefix + 'daily-data'} className="table-wrap" role="region" aria-label="Daily observations" aria-describedby={prefix + 'daily-scroll'} tabIndex={0} style={wrapStyle}>
              <table style={{ minWidth: 900 }}>
                <caption>Daily observations</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Attempted</th>
                    <th scope="col">Eligible</th>
                    <th scope="col">Visibility</th>
                    <th scope="col">Share of voice</th>
                    <th scope="col">Citations</th>
                  </tr>
                </thead>
                <tbody>
                  {report.dailyRows.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      <td>{r.attempted}</td>
                      <td>{r.eligible}</td>
                      <td>{r.visibility}</td>
                      <td>{r.shareOfVoice}</td>
                      <td>{r.citations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stack">
            <h3 id={prefix + 'executions'}>Execution evidence</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={reportOff}
                onClick={() => { if (reportOff) return; onDrilldown('all'); }}>All executions</button>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={reportOff}
                onClick={() => { if (reportOff) return; onDrilldown('eligible'); }}>Eligible answers</button>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={reportOff}
                onClick={() => { if (reportOff) return; onDrilldown('unavailable'); }}>Unavailable answers</button>
            </div>
            <p className="hint">{report.drilldownLabel} · {report.rowCountLabel}</p>
            {report.executions.length === 0 ? (
              <p>No executions match this drilldown.</p>
            ) : (
              <div className="stack">
                <p className="hint" id={prefix + 'executions-scroll'}>Scroll horizontally to see every column.</p>
                <div className="table-wrap" role="region" aria-label="Execution evidence" aria-describedby={prefix + 'executions-scroll'} tabIndex={0} style={wrapStyle}>
                  <table style={{ minWidth: 1000 }}>
                    <caption>Execution evidence</caption>
                    <thead>
                      <tr>
                        <th scope="col">Requested at</th>
                        <th scope="col">Model</th>
                        <th scope="col" style={{ whiteSpace: 'nowrap' }}>Eligibility</th>
                        <th scope="col">Matches</th>
                        <th scope="col">Comparison</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.executions.map((ex) => (
                        <tr key={ex.id}>
                          <td>{ex.requestedAt}</td>
                          <td>{ex.model}</td>
                          <td>{ex.eligibility}</td>
                          <td>{ex.matches}</td>
                          <td style={{ minWidth: 150 }}>
                            <button type="button" className="btn btn-secondary" style={{ ...controlStyle, whiteSpace: 'nowrap' }}
                              aria-label={'Open comparison for execution ' + ex.id}
                              disabled={reportOff}
                              onClick={() => { if (reportOff) return; onOpenExecution(ex.id); }}>Open comparison</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={prevOff}
                onClick={() => { if (prevOff) return; onPrevious(); }}>Previous executions</button>
              <button type="button" className="btn btn-secondary" style={controlStyle} disabled={nextOff}
                onClick={() => { if (nextOff) return; onNext(); }}>Next executions</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
