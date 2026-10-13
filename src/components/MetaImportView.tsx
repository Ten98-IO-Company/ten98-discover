export type MetaImportSourceOption = { id: string; label: string };
export type MetaImportChoice = { id: string; label: string };
export type MetaImportSourceSummary = {
  name: string; accountId: string; currency: string; timeZone: string;
  statusLabel: string; help: string;
};
export type MetaImportSummary = {
  id: string; statusLabel: string; dataStateLabel: string; rangeLabel: string;
  requestedAtLabel: string; completedAtLabel: string; sourceLabel: string;
  currencyLabel: string; timeZoneLabel: string; attributionLabel: string;
  countsLabel: string; diagnosticLabel: string; warnings: string[];
  state: 'pending' | 'available' | 'unavailable' | 'expired';
  coverage: 'complete' | 'partial' | 'unavailable';
};
export type MetaImportTableRow = {
  key: string; date: string; campaignLabel: string;
  impressions: string; clicks: string; spend: string;
  actions: { label: string; value: string }[] | null;
  actionValues: { label: string; value: string }[] | null;
};
export type MetaImportViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string; notice: string;
  sources: MetaImportSourceOption[]; selectedSourceId: string;
  source: MetaImportSourceSummary | null;
  canPreviousSources: boolean; canNextSources: boolean;
  report: 'account_daily' | 'campaign_daily'; from: string; to: string;
  canImport: boolean; canCancel: boolean; canRetrySame: boolean;
  pendingActionLabel: string;
  imports: MetaImportChoice[]; selectedImportId: string;
  canPreviousImports: boolean; canNextImports: boolean;
  summary: MetaImportSummary | null;
  rows: MetaImportTableRow[];
  canPreviousRows: boolean; canNextRows: boolean;
  onSource: (id: string) => void;
  onPreviousSources: () => void; onNextSources: () => void;
  onReport: (report: 'account_daily' | 'campaign_daily') => void;
  onFrom: (value: string) => void; onTo: (value: string) => void;
  onImport: () => void; onSelectImport: (id: string) => void;
  onPreviousImports: () => void; onNextImports: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onCancel: () => void; onRetrySame: () => void;
  onReload: () => void; onConnections: () => void;
};

const controlStyle = { minHeight: 44 } as const;
const wrapStyle = { minWidth: 0, overflowWrap: 'anywhere' } as const;
const ddStyle = { margin: 0, overflowWrap: 'anywhere' } as const;
const metadataStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '8px 16px', margin: 0 } as const;
const fieldStyle = { minWidth: 0, margin: 0 } as const;
const toolbarFieldStyle = { ...fieldStyle, flex: '1 1 240px' } as const;

export function MetaImportView(props: MetaImportViewProps) {
  const idle = props.writeState === 'idle';
  const submitting = props.writeState === 'submitting';
  const unknown = props.writeState === 'unknown';
  const locked = submitting || unknown;
  const busy = locked || props.reading;
  const isOwner = props.role === 'owner';
  const summary = props.summary;

  const canStartImport =
    isOwner &&
    props.canImport &&
    props.source !== null &&
    props.from !== '' &&
    props.to !== '' &&
    idle &&
    !props.reading;
  const canRetry = unknown && isOwner && props.canRetrySame && !props.reading;

  const renderPairs = (items: { label: string; value: string }[] | null) => {
    if (items === null) return 'Unavailable';
    if (items.length === 0) return 'No entries returned';
    return items.map((item, index) => (
      <div key={index}>
        {item.label}
        {': '}
        {item.value}
      </div>
    ));
  };

  return (
    <section
      className="research-panel stack"
      aria-labelledby={props.prefix + 'heading'}
      style={wrapStyle}
    >
      <h2 id={props.prefix + 'heading'} tabIndex={-1}>
        Meta reports
      </h2>
      <p className="hint">
        Import read-only advertising reports. Browser pixels and native analytics remain separate sources.
      </p>
      {!props.loaded && <p role="status">Loading reports…</p>}
      {props.error !== '' && (
        <div className="alert" role="alert">
          {props.error}
        </div>
      )}
      {props.notice !== '' && <div role="status">{props.notice}</div>}
      {submitting && <p role="status">{props.pendingActionLabel}</p>}
      {unknown && (
        <div className="alert" role="alert">
          <p>
            The result is not confirmed. Retry the same request to check its saved result.
          </p>
          {isOwner && (
            <button
              type="button"
              className="btn"
              style={controlStyle}
              disabled={!canRetry}
              onClick={props.onRetrySame}
            >
              Retry same request
            </button>
          )}
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="btn"
          style={controlStyle}
          disabled={locked || props.reading}
          onClick={props.onReload}
        >
          Reload reports
        </button>
        <button
          type="button"
          className="btn"
          style={controlStyle}
          disabled={locked}
          onClick={props.onConnections}
        >
          Manage connections
        </button>
      </div>
      {props.role !== null && (
        <>
          <div className="card stack">
            <div className="row" style={{ alignItems: 'end' }}>
            <div className="field" style={toolbarFieldStyle}>
              <label htmlFor={props.prefix + 'source'}>Source</label>
              <select
                id={props.prefix + 'source'}
                value={props.selectedSourceId}
                disabled={busy}
                onChange={(event) => props.onSource(event.target.value)}
                style={controlStyle}
              >
                <option value="">Choose a source</option>
                {props.sources.map((sourceOption) => (
                  <option key={sourceOption.id} value={sourceOption.id}>
                    {sourceOption.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                style={controlStyle}
                disabled={busy || !props.canPreviousSources}
                onClick={props.onPreviousSources}
              >
                Previous source page
              </button>
              <button
                type="button"
                className="btn"
                style={controlStyle}
                disabled={busy || !props.canNextSources}
                onClick={props.onNextSources}
              >
                Next source page
              </button>
            </div>
            </div>
            {props.loaded && props.sources.length === 0 && (
              <p className="hint">No sources on this page.</p>
            )}
          {props.source !== null && (
            <>
              <dl style={metadataStyle}>
                <div style={wrapStyle}>
                  <dt>Name</dt>
                  <dd style={ddStyle}>{props.source.name}</dd>
                </div>
                <div style={wrapStyle}>
                  <dt>Account ID</dt>
                  <dd style={ddStyle}>{props.source.accountId}</dd>
                </div>
                <div style={wrapStyle}>
                  <dt>Currency</dt>
                  <dd style={ddStyle}>{props.source.currency}</dd>
                </div>
                <div style={wrapStyle}>
                  <dt>Time zone</dt>
                  <dd style={ddStyle}>{props.source.timeZone}</dd>
                </div>
                <div style={wrapStyle}>
                  <dt>Status</dt>
                  <dd style={ddStyle}>{props.source.statusLabel}</dd>
                </div>
              </dl>
              <p className="hint">{props.source.help}</p>
              {isOwner ? (
                <>
                  <div style={metadataStyle}>
                  <div className="field" style={fieldStyle}>
                    <label htmlFor={props.prefix + 'report'}>Report</label>
                    <select
                      id={props.prefix + 'report'}
                      value={props.report}
                      disabled={busy}
                      onChange={(event) =>
                        props.onReport(event.target.value as 'account_daily' | 'campaign_daily')
                      }
                      style={controlStyle}
                    >
                      <option value="account_daily">Account by day</option>
                      <option value="campaign_daily">Campaign by day</option>
                    </select>
                  </div>
                    <div className="field" style={fieldStyle}>
                      <label htmlFor={props.prefix + 'from'}>From</label>
                      <input
                        id={props.prefix + 'from'}
                        type="date"
                        value={props.from}
                        disabled={busy}
                        onChange={(event) => props.onFrom(event.target.value)}
                        style={controlStyle}
                      />
                    </div>
                    <div className="field" style={fieldStyle}>
                      <label htmlFor={props.prefix + 'to'}>To</label>
                      <input
                        id={props.prefix + 'to'}
                        type="date"
                        value={props.to}
                        disabled={busy}
                        onChange={(event) => props.onTo(event.target.value)}
                        style={controlStyle}
                      />
                    </div>
                  </div>
                  <p className="hint">
                    Dates follow the account time zone. Import at most 31 days at a time. Today's data can still change.
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn primary"
                      style={controlStyle}
                      disabled={!canStartImport}
                      onClick={props.onImport}
                    >
                      Import report
                    </button>
                  </div>
                </>
              ) : (
                <p className="hint">
                  A workspace owner can start or cancel imports. You can read retained reports.
                </p>
              )}
            </>
          )}
          </div>
          {props.selectedSourceId !== '' && (
            <div className="card stack">
              <div className="row" style={{ alignItems: 'end' }}>
              <div className="field" style={toolbarFieldStyle}>
                <label htmlFor={props.prefix + 'import'}>Import history</label>
                <select
                  id={props.prefix + 'import'}
                  value={props.selectedImportId}
                  disabled={busy}
                  onChange={(event) => props.onSelectImport(event.target.value)}
                  style={controlStyle}
                >
                  <option value="">Choose an import</option>
                  {props.imports.map((importChoice) => (
                    <option key={importChoice.id} value={importChoice.id}>
                      {importChoice.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  style={controlStyle}
                  disabled={busy || !props.canPreviousImports}
                  onClick={props.onPreviousImports}
                >
                  Previous import page
                </button>
                <button
                  type="button"
                  className="btn"
                  style={controlStyle}
                  disabled={busy || !props.canNextImports}
                  onClick={props.onNextImports}
                >
                  Next import page
                </button>
              </div>
              </div>
              {props.loaded && !props.reading && props.imports.length === 0 && (
                <p className="hint">No imports on this page.</p>
              )}
            </div>
          )}
          {summary !== null && (
            <div className="card stack">
              <p style={wrapStyle}>
                <strong>{summary.statusLabel}</strong>
              </p>
              <p style={wrapStyle}>{summary.dataStateLabel}</p>
              {summary.coverage === 'partial' && (
                <p>
                  <strong>Partial coverage</strong>
                </p>
              )}
                <dl style={metadataStyle}>
                  <div style={wrapStyle}>
                    <dt>Source</dt>
                    <dd style={ddStyle}>{summary.sourceLabel}</dd>
                  </div>
                  <div style={wrapStyle}>
                    <dt>Range</dt>
                    <dd style={ddStyle}>{summary.rangeLabel}</dd>
                  </div>
                  <div style={wrapStyle}>
                    <dt>Currency</dt>
                    <dd style={ddStyle}>{summary.currencyLabel}</dd>
                  </div>
                  <div style={wrapStyle}>
                    <dt>Time zone</dt>
                    <dd style={ddStyle}>{summary.timeZoneLabel}</dd>
                  </div>
                  <div style={wrapStyle}>
                    <dt>Counts</dt>
                    <dd style={ddStyle}>{summary.countsLabel}</dd>
                  </div>
                </dl>
              <details>
                <summary>Receipt and import details</summary>
                <dl style={metadataStyle}>
                  <div className="row" style={wrapStyle}>
                    <dt>Requested</dt>
                    <dd style={ddStyle}>{summary.requestedAtLabel}</dd>
                  </div>
                  <div className="row" style={wrapStyle}>
                    <dt>Completed</dt>
                    <dd style={ddStyle}>{summary.completedAtLabel}</dd>
                  </div>
                  <div className="row" style={wrapStyle}>
                    <dt>Receipt ID</dt>
                    <dd style={ddStyle}>{summary.id}</dd>
                  </div>
                </dl>
              </details>
              <p style={wrapStyle}>{summary.attributionLabel}</p>
              <p className="hint">
                Spend is provider-estimated. Action types and attribution windows can overlap; they are not additive totals.
              </p>
              {summary.warnings.length > 0 && (
                <ul>
                  {summary.warnings.map((warning, index) => (
                    <li key={index} style={wrapStyle}>
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
              {summary.diagnosticLabel !== '' && (
                <p style={wrapStyle}>{summary.diagnosticLabel}</p>
              )}
              {summary.state === 'pending' && (
                <p role="status">
                  Report in progress. Reload to check its latest saved state.
                </p>
              )}
              {summary.state === 'unavailable' && (
                <p>
                  No report data is available for this attempt. Earlier completed reports remain in import history.
                </p>
              )}
              {summary.state === 'expired' && (
                <p>
                  Report rows expired under the workspace retention policy. The import receipt is retained.
                </p>
              )}
              {summary.state === 'available' && (
                <>
                  {props.rows.length === 0 ? (
                    props.canPreviousRows || props.canNextRows ? (
                      <p>This page has no returned rows.</p>
                    ) : (
                      <p>
                        This report completed with no returned rows. Missing rows are not measured zero activity.
                      </p>
                    )
                  ) : (
                    <div
                      className="table-wrap"
                      role="region"
                      aria-label="Daily Meta report rows"
                      tabIndex={0}
                      style={{ overflowX: 'auto' }}
                    >
                      <table style={{ minWidth: 960 }}>
                        <caption>Daily Meta report rows</caption>
                        <thead>
                          <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Campaign</th>
                            <th scope="col">Impressions</th>
                            <th scope="col" style={{ minWidth: 110 }}>Clicks</th>
                            <th scope="col">Spend</th>
                            <th scope="col">Actions</th>
                            <th scope="col">Action values</th>
                          </tr>
                        </thead>
                        <tbody>
                          {props.rows.map((row) => (
                            <tr key={row.key}>
                              <td style={{ whiteSpace: 'nowrap' }}>{row.date}</td>
                              <td>{row.campaignLabel}</td>
                              <td>{row.impressions}</td>
                              <td>{row.clicks}</td>
                              <td>{row.spend}</td>
                              <td>{renderPairs(row.actions)}</td>
                              <td>{renderPairs(row.actionValues)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      style={controlStyle}
                      disabled={busy || !props.canPreviousRows}
                      onClick={props.onPreviousRows}
                    >
                      Previous report page
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={controlStyle}
                      disabled={busy || !props.canNextRows}
                      onClick={props.onNextRows}
                    >
                      Next report page
                    </button>
                  </div>
                </>
              )}
              {isOwner && summary.state === 'pending' && (
                <div className="stack">
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      style={controlStyle}
                      disabled={busy || !props.canCancel}
                      onClick={props.onCancel}
                    >
                      Cancel local import
                    </button>
                  </div>
                  <p className="hint">
                    Stops local work. It does not cancel a report at Meta.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
