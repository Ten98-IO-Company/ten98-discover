export type MetaCampaignSummary = {
  id: string; statusLabel: string; coverageLabel: string;
  state: 'pending' | 'available' | 'expired' | 'unavailable';
  sourceLabel: string; requestedAtLabel: string; completedAtLabel: string;
  intervalLabel: string; countsLabel: string; diagnosticLabel: string;
  warnings: string[];
};

export type MetaCampaignTableRow = {
  id: string; nameLabel: string; statusLabel: string; effectiveStatusLabel: string;
};

export type MetaCampaignViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean; exporting: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string; exportError: string; notice: string;
  source: { label: string; accountLabel: string; statusLabel: string; help: string } | null;
  latestAttemptLabel: string; showingLatest: boolean;
  inventories: { id: string; label: string }[]; selectedInventoryId: string;
  summary: MetaCampaignSummary | null; rows: MetaCampaignTableRow[];
  canRefresh: boolean; canCancel: boolean; canRetrySame: boolean;
  canPreviousHistory: boolean; canNextHistory: boolean;
  canPreviousRows: boolean; canNextRows: boolean; canExport: boolean;
  pendingActionLabel: string;
  onBack: () => void; onReload: () => void; onLatest: () => void;
  onRefresh: () => void; onCancel: () => void; onRetrySame: () => void;
  onSelectInventory: (id: string) => void;
  onPreviousHistory: () => void; onNextHistory: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onExport: () => void; onCancelExport: () => void;
};

const controlTarget = { minHeight: 44, minWidth: 44 } as const;
const wrapRow = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const fieldMargin = { margin: 0 } as const;
const wrapAnywhere = { overflowWrap: 'anywhere' } as const;
const columnMin = {
  minWidth: 180, padding: '8px 12px', textAlign: 'left',
  verticalAlign: 'top', overflowWrap: 'anywhere',
} as const;

export function MetaCampaignView(props: MetaCampaignViewProps) {
  const {
    prefix, role, loaded, reading, exporting, writeState,
    error, exportError, notice, source, latestAttemptLabel, showingLatest,
    inventories, selectedInventoryId, summary, rows,
    canRefresh, canCancel, canRetrySame,
    canPreviousHistory, canNextHistory, canPreviousRows, canNextRows, canExport,
    pendingActionLabel,
    onBack, onReload, onLatest, onRefresh, onCancel, onRetrySame,
    onSelectInventory, onPreviousHistory, onNextHistory,
    onPreviousRows, onNextRows, onExport, onCancelExport,
  } = props;

  const busy = reading || exporting || writeState !== 'idle';
  const known = role !== null;
  const ready = loaded && !reading;

  return (
    <section className="research-panel stack" style={{ minWidth: 0, ...wrapAnywhere }} aria-labelledby={prefix + 'heading'}>
      <h2 id={prefix + 'heading'} tabIndex={-1}>Campaign inventory</h2>
      <p>Read retained campaign metadata, including campaigns without reported activity. This screen does not measure campaign performance.</p>

      {error !== '' && <p className="alert" role="alert">{error}</p>}
      {exportError !== '' && <p className="alert" role="alert">{exportError}</p>}
      {notice !== '' && <p className="hint" role="status">{notice}</p>}

      <div className="row" style={wrapRow}>
        <button type="button" id={prefix + 'back'} className="btn" style={controlTarget} disabled={writeState !== 'idle'} onClick={onBack}>Back to reports</button>
        <button type="button" id={prefix + 'reload'} className="btn" style={controlTarget} disabled={reading || exporting || writeState !== 'idle'} onClick={onReload}>Reload saved inventory</button>
      </div>

      {!ready && <p role="status">Loading inventory…</p>}

      {known && writeState === 'submitting' && <p role="status">{pendingActionLabel}</p>}

      {known && writeState === 'unknown' && (
        <div className="stack">
          <p className="alert" role="alert">The result is not confirmed. Retry the same request to check its saved result.</p>
          {role === 'owner' && (
            <div className="row" style={wrapRow}>
              <button type="button" id={prefix + 'retry'} className="btn" style={controlTarget} disabled={!canRetrySame || reading || exporting} onClick={onRetrySame}>Retry same request</button>
            </div>
          )}
        </div>
      )}

      {known && ready && source !== null && (
        <div className="card stack">
          <p className="field" style={fieldMargin}><strong>Source:</strong> {source.label}</p>
          <p className="field" style={fieldMargin}><strong>Account:</strong> {source.accountLabel}</p>
          <p className="field" style={fieldMargin}><strong>Status:</strong> {source.statusLabel}</p>
          <p className="hint">{source.help}</p>
          <p className="hint">Refreshing requests a new read from Meta. Opening this screen or reloading saved inventory does not.</p>
          {role === 'owner' ? (
            <div className="row" style={wrapRow}>
              <button type="button" id={prefix + 'refresh'} className="btn" style={controlTarget} disabled={!canRefresh || busy} onClick={onRefresh}>Refresh campaign inventory</button>
            </div>
          ) : (
            <p className="hint">A workspace owner can refresh or cancel inventory. You can read and export saved results.</p>
          )}
        </div>
      )}

      {known && ready && latestAttemptLabel !== '' && <p className="hint">{latestAttemptLabel}</p>}

      {known && ready && (
        <div className="card stack">
          <div className="field" style={fieldMargin}>
            <label htmlFor={prefix + 'history'}>Inventory history</label>
            <select
              id={prefix + 'history'}
              style={{ minHeight: 44, minWidth: 0, maxWidth: '100%' }}
              value={selectedInventoryId}
              disabled={source === null || busy}
              onChange={(event) => onSelectInventory(event.target.value)}
            >
              <option value="">Choose an inventory</option>
              {inventories.map((inventory) => (
                <option key={inventory.id} value={inventory.id}>{inventory.label}</option>
              ))}
            </select>
          </div>
          <div className="row" style={wrapRow}>
            <button type="button" id={prefix + 'history-previous'} className="btn" style={controlTarget} disabled={source === null || busy || !canPreviousHistory} onClick={onPreviousHistory}>Previous history page</button>
            <button type="button" id={prefix + 'history-next'} className="btn" style={controlTarget} disabled={source === null || busy || !canNextHistory} onClick={onNextHistory}>Next history page</button>
            <button type="button" id={prefix + 'latest'} className="btn" style={controlTarget} disabled={source === null || busy} onClick={onLatest}>Show latest complete</button>
          </div>
          <p className="hint">{showingLatest ? 'Latest complete inventory' : 'Selected history receipt'}</p>
        </div>
      )}

      {known && ready && role === 'owner' && summary !== null && canCancel && (
        <div className="card stack">
          <div className="row" style={wrapRow}>
            <button type="button" id={prefix + 'cancel'} className="btn" style={controlTarget} disabled={busy} onClick={onCancel}>Cancel local refresh</button>
          </div>
          <p className="hint">Requests already sent to Meta may continue there.</p>
        </div>
      )}

      {known && ready && summary !== null && (
        <div className="card stack">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))', gap: 12, minWidth: 0 }}>
          <p className="field" style={fieldMargin}><strong>Status:</strong> {summary.statusLabel}</p>
          <p className="field" style={fieldMargin}><strong>Coverage:</strong> {summary.coverageLabel}</p>
          <p className="field" style={fieldMargin}><strong>Source:</strong> {summary.sourceLabel}</p>
          <p className="field" style={fieldMargin}><strong>Requested:</strong> {summary.requestedAtLabel}</p>
          <p className="field" style={fieldMargin}><strong>Completed:</strong> {summary.completedAtLabel}</p>
          <p className="field" style={fieldMargin}><strong>Observation interval:</strong> {summary.intervalLabel}</p>
          <p className="field" style={fieldMargin}><strong>Counts:</strong> {summary.countsLabel}</p>
          </div>
          {summary.warnings.map((warning, index) => (
            <p key={index} style={{ ...fieldMargin, ...wrapAnywhere }}>{warning}</p>
          ))}
          {summary.diagnosticLabel !== '' && <p className="hint" style={wrapAnywhere}>{summary.diagnosticLabel}</p>}
          <details id={prefix + 'receipt'}>
            <summary style={{ minHeight: 44, cursor: 'pointer' }}>Receipt details</summary>
            <p style={{ ...fieldMargin, ...wrapAnywhere }}>{summary.id}</p>
          </details>
          <p className="hint">Pages were observed over an interval. Campaigns may change during collection. Missing records do not prove deletion or zero activity.</p>
        </div>
      )}

      {known && ready && summary === null && <p className="hint">No saved inventory selected.</p>}

      {known && ready && summary !== null && summary.state === 'pending' && (
        <p role="status">Refresh is in progress. Reload saved inventory to check its status.</p>
      )}
      {known && ready && summary !== null && summary.state === 'expired' && (
        <p className="hint">This snapshot’s campaign data has expired.</p>
      )}
      {known && ready && summary !== null && summary.state === 'unavailable' && (
        <p className="hint">Campaign data is unavailable for this receipt.</p>
      )}

      {known && ready && summary !== null && summary.state === 'available' && (
        <div className="stack">
          {rows.length === 0 ? (
            <p className="hint">No campaigns returned on this page. Review the snapshot coverage before drawing conclusions.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="Saved campaigns" tabIndex={0} style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
                <caption style={{ textAlign: 'left' }}>Saved campaigns</caption>
                <thead>
                  <tr>
                    <th scope="col" style={columnMin}>Campaign ID</th>
                    <th scope="col" style={columnMin}>Name</th>
                    <th scope="col" style={columnMin}>Configured status</th>
                    <th scope="col" style={columnMin}>Effective status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td style={columnMin}>{row.id}</td>
                      <td style={columnMin}>{row.nameLabel}</td>
                      <td style={columnMin}>{row.statusLabel}</td>
                      <td style={columnMin}>{row.effectiveStatusLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={wrapRow}>
            <button type="button" id={prefix + 'rows-previous'} className="btn" style={controlTarget} disabled={busy || !canPreviousRows} onClick={onPreviousRows}>Previous campaign page</button>
            <button type="button" id={prefix + 'rows-next'} className="btn" style={controlTarget} disabled={busy || !canNextRows} onClick={onNextRows}>Next campaign page</button>
            <button type="button" id={prefix + 'export'} className="btn" style={controlTarget} disabled={busy || !canExport} onClick={onExport}>Export CSV</button>
          </div>
          <p className="hint">Exports this named snapshot with its observation interval and coverage. No campaign activity or performance totals are inferred.</p>
        </div>
      )}
      {known && exporting && (
        <div className="row" style={wrapRow}>
          <p role="status" style={fieldMargin}>Preparing CSV…</p>
          <button type="button" id={prefix + 'export-cancel'} className="btn" style={controlTarget} onClick={onCancelExport}>Cancel export</button>
        </div>
      )}
    </section>
  );
}
