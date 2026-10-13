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
    coverage: {label: string; value: string}[];
    metrics: {id: string; name: string; visibility: string;
      shareOfVoice: string; citations: string; canDrill: boolean}[];
    dailyEntityId: string;
    dailyEntities: {id: string; label: string}[];
    dailyRows: {date: string; attempted: string; eligible: string;
      visibility: string; shareOfVoice: string; citations: string}[];
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

export function AIInsightsView(props: AIInsightsViewProps) {
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
          <p><strong>{report.scopeLabel}</strong></p>
          <p className="hint">{report.contextLabel}</p>
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

      {known && report !== null && (
        <div className="card stack">
          <section className="stack">
            <h3 id={prefix + 'metrics'}>Entity metrics</h3>
            <p className="hint" id={prefix + 'metrics-scroll'}>Scroll horizontally to see every column.</p>
            <div className="table-wrap" role="region" aria-label="Entity metrics" aria-describedby={prefix + 'metrics-scroll'} tabIndex={0} style={wrapStyle}>
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
            <div className="field">
              <label htmlFor={prefix + 'daily-entity'}>Daily entity</label>
              <select id={prefix + 'daily-entity'} value={report.dailyEntityId} disabled={reportOff} style={controlStyle}
                onChange={(e) => { if (reportOff) return; onDailyEntity(e.target.value); }}>
                {report.dailyEntities.map((en) => <option key={en.id} value={en.id}>{en.label}</option>)}
              </select>
            </div>
            <p className="hint" id={prefix + 'daily-scroll'}>Scroll horizontally to see every column.</p>
            <div className="table-wrap" role="region" aria-label="Daily observations" aria-describedby={prefix + 'daily-scroll'} tabIndex={0} style={wrapStyle}>
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
