export type ComparisonCohort = 'current-neutral' | 'all';
export type ComparisonOutcome = 'all' | 'usable' | 'unavailable' | 'mentioned' | 'not_mentioned' | 'cited';
export type AIComparisonViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  reading: boolean; exporting: boolean; dirty: boolean; canApply: boolean;
  error: string | null; notice: string | null;
  filtersLabel: string; cohort: ComparisonCohort;
  report: null | {
    scopeLabel: string; snapshotLabel: string; cohortLabel: string;
    statusLabel: string; basisLabel: string; warnings: string[];
    periods: {id: 'current' | 'previous'; label: string; range: string;
      attempted: string; eligible: string; usable: string; identityUnavailable: string;
      identityInvalid: string; matched: string; details: string}[];
    metrics: {id: string; name: string; current: string; previous: string;
      delta: string; citationsCurrent: string; citationsPrevious: string; citationsDelta: string}[];
    entities: {id: string; name: string}[]; entityId: string;
    view: 'cells' | 'current' | 'previous'; outcome: ComparisonOutcome;
    evidenceLabel: string; pageLabel: string; canPrevious: boolean; canNext: boolean; canExport: boolean;
    cells: {id: string; prompt: string; model: string; identity: string; status: string;
      current: string; previous: string; currentMentions: string; previousMentions: string;
      currentCitations: string; previousCitations: string;
      canCurrent: boolean; canPrevious: boolean}[];
    executions: {id: string; requestedAt: string; model: string; eligibility: string;
      identity: string; matches: string; canOpen: boolean}[];
  };
  onCohortChange: (value: ComparisonCohort) => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onEntityChange: (id: string) => void;
  onView: (value: 'cells' | 'current' | 'previous') => void;
  onOutcome: (value: ComparisonOutcome) => void;
  onCell: (id: string, period: 'current' | 'previous') => void;
  onOpenComparison: (executionId: string) => void;
  onPrevious: () => void; onNext: () => void;
  onExport: () => void; onCancelExport: () => void;
};

const controlStyle = { minHeight: 44, maxWidth: '100%' } as const;
const nowrapStyle = { whiteSpace: 'nowrap' } as const;
const scrollRegionStyle = { overflowX: 'auto' } as const;
const wrapRowStyle = { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' } as const;
const formStyle = { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-3)', width: '100%', minWidth: 0 } as const;
const coverageGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: 'var(--space-3)' } as const;
const coverageCardStyle = { display: 'flex', flexDirection: 'column', minWidth: 0, borderBlockStart: '1px solid var(--color-border)', paddingBlock: 'var(--space-3)' } as const;

export function AIComparisonView(props: AIComparisonViewProps) {
  const {
    prefix, role, reading, exporting, dirty, canApply, error, notice,
    filtersLabel, cohort, report,
    onCohortChange, onApply, onReload, onBack, onEntityChange, onView,
    onOutcome, onCell, onOpenComparison, onPrevious, onNext, onExport, onCancelExport,
  } = props;
  const busy = reading || exporting;
  const reportLocked = busy || dirty;
  const headingId = prefix + 'heading';
  const filtersId = prefix + 'filters';
  const cohortId = prefix + 'cohort';
  const entitySelectId = prefix + 'entity';
  const outcomeSelectId = prefix + 'outcome';
  const metricsHintId = prefix + 'metrics-scroll-hint';
  const cellsHintId = prefix + 'cells-scroll-hint';
  const executionsHintId = prefix + 'executions-scroll-hint';

  return (
    <section className="research-panel stack" aria-labelledby={headingId} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="row between" style={wrapRowStyle}>
        <h2 id={headingId} tabIndex={-1} style={{ margin: 0, marginInlineEnd: 'auto' }}>Compare AI periods</h2>
        <button type="button" className="btn ghost" style={controlStyle} onClick={onBack}>Back to insights</button>
        <button type="button" className="btn ghost" style={controlStyle} onClick={onReload} disabled={busy}>Reload comparison</button>
        {role !== null && report !== null && (
          <>
            <button type="button" className="btn" style={controlStyle} disabled={reportLocked || !report.canExport} onClick={onExport}>Export comparison CSV</button>
            {exporting && (
              <button type="button" className="btn ghost" style={controlStyle} onClick={onCancelExport}>Cancel export</button>
            )}
          </>
        )}
      </div>
      {role !== null && report !== null && (
        <p className="hint">Exports both periods, all cells and executions in the applied comparison; not only this page.</p>
      )}
      {error !== null && <p className="alert" role="alert">{error}</p>}
      {notice !== null && <p className="hint" role="status">{notice}</p>}
      {reading && <p className="hint" role="status">Loading comparison…</p>}
      {exporting && <p className="hint" role="status">Exporting comparison CSV…</p>}
      {role !== null && (
        <form
          style={formStyle}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && canApply) onApply();
          }}
        >
          <div className="field" style={{ width: '100%', minWidth: 0, margin: 0 }}>
            <strong>Applied filters</strong>
            <p id={filtersId} aria-label="Applied filters" className="hint" style={{ margin: 0 }}>{filtersLabel}</p>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={cohortId}>Prompt cohort</label>
            <select
              id={cohortId}
              style={controlStyle}
              value={cohort}
              disabled={busy}
              onChange={(event) => onCohortChange(event.target.value as ComparisonCohort)}
            >
              <option value="current-neutral">Currently classified neutral prompts</option>
              <option value="all">All prompts</option>
            </select>
          </div>
          <button type="submit" className="btn" style={controlStyle} disabled={busy || !canApply}>Apply cohort</button>
          {dirty && <p className="hint" role="status" style={{ width: '100%', margin: 0 }}>Unapplied cohort change. The report below still uses the applied cohort.</p>}
        </form>
      )}
      {role !== null && report !== null && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <p style={{ margin: 0 }}><strong>{report.scopeLabel}</strong></p>
            <p className="hint" style={{ margin: 0 }}>{report.snapshotLabel}</p>
            <p style={{ margin: 0 }}>{report.cohortLabel}</p>
            <p style={{ margin: 0 }}>{report.statusLabel}</p>
            <p style={{ margin: 0 }}>{report.basisLabel}</p>
            {report.warnings.map((warning, index) => (
              <p className="hint" key={index} style={{ margin: 0 }}>{warning}</p>
            ))}
            <p className="hint" style={{ margin: 0 }}>Recomputed using current project context; historical identities were not captured.</p>
            <p className="hint" style={{ margin: 0 }}>OpenRouter API · web search off</p>
          </div>
          <h3>Equal-cell mention and citation rates</h3>
          <div role="region" aria-label="Equal-cell mention and citation rates" aria-describedby={metricsHintId} tabIndex={0} style={scrollRegionStyle}>
            <p className="hint" id={metricsHintId}>Scroll horizontally to see every column.</p>
            <table className="table" style={{ minWidth: 760 }}>
              <caption>Equal-cell mention and citation rates</caption>
              <thead>
                <tr>
                  <th scope="col" style={nowrapStyle}>Entity</th>
                  <th scope="col" style={nowrapStyle}>Current mentions</th>
                  <th scope="col" style={nowrapStyle}>Previous mentions</th>
                  <th scope="col" style={nowrapStyle}>Change</th>
                  <th scope="col" style={nowrapStyle}>Current citations</th>
                  <th scope="col" style={nowrapStyle}>Previous citations</th>
                  <th scope="col" style={nowrapStyle}>Citation change</th>
                </tr>
              </thead>
              <tbody>
                {report.metrics.map((metric) => (
                  <tr key={metric.id}>
                    <th scope="row">{metric.name}</th>
                    <td>{metric.current}</td>
                    <td>{metric.previous}</td>
                    <td>{metric.delta}</td>
                    <td>{metric.citationsCurrent}</td>
                    <td>{metric.citationsPrevious}</td>
                    <td>{metric.citationsDelta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Period coverage</h3>
          <div style={coverageGridStyle}>
            {report.periods.map((period) => (
              <div key={period.id} style={coverageCardStyle}>
                <p><strong>{period.label}</strong></p>
                <p className="hint">{period.range}</p>
                <div className="row between"><span>Attempted</span><span>{period.attempted}</span></div>
                <div className="row between"><span>Eligible</span><span>{period.eligible}</span></div>
                <div className="row between"><span>Usable</span><span>{period.usable}</span></div>
                <div className="row between"><span>Identity unavailable</span><span>{period.identityUnavailable}</span></div>
                <div className="row between"><span>Identity invalid</span><span>{period.identityInvalid}</span></div>
                <div className="row between"><span>Matched</span><span>{period.matched}</span></div>
                <div className="row between"><span>Details</span><span>{period.details}</span></div>
              </div>
            ))}
          </div>
          <h3>Comparison evidence</h3>
          <div className="row between" style={wrapRowStyle}>
            <div className="field">
              <label htmlFor={entitySelectId}>Evidence entity</label>
              <select
                id={entitySelectId}
                style={controlStyle}
                value={report.entityId}
                disabled={reportLocked}
                onChange={(event) => onEntityChange(event.target.value)}
              >
                {report.entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>{entity.name}</option>
                ))}
              </select>
            </div>
            <div role="group" aria-label="Evidence view" style={wrapRowStyle}>
              <button type="button" className={report.view === 'cells' ? 'btn' : 'btn ghost'} style={controlStyle} aria-pressed={report.view === 'cells'} disabled={reportLocked} onClick={() => onView('cells')}>Show comparison cells</button>
              <button type="button" className={report.view === 'current' ? 'btn' : 'btn ghost'} style={controlStyle} aria-pressed={report.view === 'current'} disabled={reportLocked} onClick={() => onView('current')}>Show current executions</button>
              <button type="button" className={report.view === 'previous' ? 'btn' : 'btn ghost'} style={controlStyle} aria-pressed={report.view === 'previous'} disabled={reportLocked} onClick={() => onView('previous')}>Show previous executions</button>
            </div>
            {report.view !== 'cells' && (
              <div className="field">
                <label htmlFor={outcomeSelectId}>Evidence</label>
                <select
                  id={outcomeSelectId}
                  style={controlStyle}
                  value={report.outcome}
                  disabled={reportLocked}
                  onChange={(event) => onOutcome(event.target.value as ComparisonOutcome)}
                >
                  <option value="all">All executions</option>
                  <option value="usable">Usable answers</option>
                  <option value="unavailable">Unavailable answers</option>
                  <option value="mentioned">Mentions</option>
                  <option value="not_mentioned">Non-mentions</option>
                  <option value="cited">Citations</option>
                </select>
              </div>
            )}
          </div>
          <p className="hint">{report.evidenceLabel}</p>
          <p className="hint">{report.pageLabel}</p>
          {report.view === 'cells' ? (
            <div role="region" aria-label="Comparison cells" aria-describedby={cellsHintId} tabIndex={0} style={scrollRegionStyle}>
              <p className="hint" id={cellsHintId}>Scroll horizontally to see every column.</p>
              <table className="table" style={{ minWidth: 1100 }}>
                <caption>Comparison cells</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 240 }}>Prompt</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 140 }}>Model</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 220 }}>Identity</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 130 }}>Status</th>
                    <th scope="col" style={nowrapStyle}>Current coverage</th>
                    <th scope="col" style={nowrapStyle}>Previous coverage</th>
                    <th scope="col" style={nowrapStyle}>Current mentions</th>
                    <th scope="col" style={nowrapStyle}>Previous mentions</th>
                    <th scope="col" style={nowrapStyle}>Current citations</th>
                    <th scope="col" style={nowrapStyle}>Previous citations</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 220 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cells.length === 0 ? (
                    <tr><td colSpan={11}>No comparison cells match these filters.</td></tr>
                  ) : (
                    report.cells.map((cell) => (
                      <tr key={cell.id}>
                        <td>{cell.prompt}</td>
                        <td>{cell.model}</td>
                        <td>{cell.identity}</td>
                        <td>{cell.status}</td>
                        <td>{cell.current}</td>
                        <td>{cell.previous}</td>
                        <td>{cell.currentMentions}</td>
                        <td>{cell.previousMentions}</td>
                        <td>{cell.currentCitations}</td>
                        <td>{cell.previousCitations}</td>
                        <td>
                          <div style={wrapRowStyle}>
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ ...controlStyle, ...nowrapStyle }}
                              aria-label={'Show current executions for cell ' + cell.id}
                              disabled={reportLocked || !cell.canCurrent}
                              onClick={() => onCell(cell.id, 'current')}
                            >Current executions</button>
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ ...controlStyle, ...nowrapStyle }}
                              aria-label={'Show previous executions for cell ' + cell.id}
                              disabled={reportLocked || !cell.canPrevious}
                              onClick={() => onCell(cell.id, 'previous')}
                            >Previous executions</button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div role="region" aria-label="Comparison executions" aria-describedby={executionsHintId} tabIndex={0} style={scrollRegionStyle}>
              <p className="hint" id={executionsHintId}>Scroll horizontally to see every column.</p>
              <table className="table" style={{ minWidth: 760 }}>
                <caption>Comparison executions</caption>
                <thead>
                  <tr>
                    <th scope="col" style={nowrapStyle}>Requested at</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 150 }}>Model</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 170 }}>Answer eligibility</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 220 }}>Cell identity</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 180 }}>Matches</th>
                    <th scope="col" style={{ ...nowrapStyle, minWidth: 180 }}>Comparison</th>
                  </tr>
                </thead>
                <tbody>
                  {report.executions.length === 0 ? (
                    <tr><td colSpan={6}>No executions match this selection.</td></tr>
                  ) : (
                    report.executions.map((execution) => (
                      <tr key={execution.id}>
                        <td style={{ minWidth: 230 }}>{execution.requestedAt}</td>
                        <td>{execution.model}</td>
                        <td>{execution.eligibility}</td>
                        <td>{execution.identity}</td>
                        <td>{execution.matches}</td>
                        <td>
                          <button
                            type="button"
                            className="btn ghost"
                            style={{ ...controlStyle, ...nowrapStyle }}
                            aria-label={'Open comparison for execution ' + execution.id}
                            disabled={reportLocked || !execution.canOpen}
                            onClick={() => onOpenComparison(execution.id)}
                          >Open comparison</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="row between" style={wrapRowStyle}>
            <button type="button" className="btn ghost" style={controlStyle} disabled={reportLocked || !report.canPrevious} onClick={onPrevious}>Previous page</button>
            <button type="button" className="btn ghost" style={controlStyle} disabled={reportLocked || !report.canNext} onClick={onNext}>Next page</button>
          </div>

        </>
      )}
    </section>
  );
}
