Return bare JSON only: {"replacements":[{"id":"C1","new":"exact JSX return block"}]}. Draft420seconds, one repair120seconds, total540seconds maximum then GPT handoff. Skill-only: no shell/filesystem/network/subagents.

# M03c — Retained campaign inventory: read the snapshot first

Public bounded Kimi presentation draft. GPT owns visual design and independent acceptance. Apply supplied Ponytail/UX Copy Refiner. Verified K3 maximum thinking under the supervisor's profile;9-minute cap, at most one repair then stop and hand off. No requirement weakening.

Allowlist: `src/components/MetaCampaignView.tsx` only. Output one exact replacement C1: the function's final `  return (` through its `  );`, excluding the function's final brace. Preserve all bytes outside C1, including exported types, constants, destructuring, busy/known/ready derivation. Hashes and full original public source follow. No CSS file, controller, props, helpers, imports, hooks, state, network, numeric parsing, URL/storage or dependencies.

Actual flow: the import parent opens MetaCampaignPanel for the current connection. This loads the latest COMPLETE inventory and separately the most recent attempt. Explicit history can select partial/pending/expired receipts. A disconnected member can read/export retained records. Only an owner may request a fresh Meta read or local cancellation. Refresh is not a read of saved rows. Same-request retry, role/scope/revision checks, irreversible masking and bounded CSV belong to the unchanged controller. Inventory measures metadata, never activity/spend/performance.

Required presentation:
1. Existing h2/focus ID and Back to reports/Reload saved inventory form a compact wrapping header; keep intro and separate errors/notice/loading/submitting/unknown recovery visible. All callback attributes and disabled expressions remain byte-for-byte on the same controls. Back works during read/export, not non-idle writes. Do not move Retry same request into details.
2. Flatten the source card into a compact labelled context strip using existing stack/row plus inline token spacing. Keep source.label, accountLabel, statusLabel, source.help and the full “Refreshing requests a new read from Meta…” sentence visibly. Keep owner Refresh campaign inventory with its exact gate; nonowner explanation stays. Use Source status as the visible label so current connection status is distinct from the saved snapshot status. No colored health inference.
3. Keep latestAttemptLabel visibly above the selected snapshot. A failed recent attempt must not look like the selected complete snapshot. Keep Latest complete inventory / Selected history receipt visibly near the snapshot, even when the history chooser is closed.
4. The saved snapshot card appears BEFORE its history chooser. Visible summary: Status, Coverage, Source (captured snapshot sourceLabel), Observation interval and Counts. Render every warning and diagnostic visibly next to this summary. Keep the full pages-observed/missing-records caveat. Requested/Completed timestamps and exact ID move into the EXISTING Receipt details disclosure, after results. They are still mounted and available; nothing is deleted.
5. Move the existing available-state Saved campaigns table, precise empty state and row pager into this single snapshot card directly after the visible summary/caveats. Retain Campaign ID, Name, Configured status and Effective status independently. Preserve exact values including unavailable/empty names and unknown provider status labels. No links, merged statuses or inferred activity.
6. Move the existing available-state Export CSV action to a compact summary toolbar inside the SAME original known/ready/summary/available gates. Keep its disabled expression and callback exact, and place its existing export-scope help beside/below it. Leave only row paging below the table. Preparing CSV/Cancel export remains outside summary/history disclosures so a concurrent read or cleared summary cannot hide cancellation. Preserve complete-empty export eligibility.
7. Put Inventory history into native details AFTER the snapshot/result block, with summary “Inventory history” and `open={summary === null || !showingLatest}`. Retain the existing labelled select, blank option, every choice, Previous/Next history page, and Show latest complete. Inner content stays mounted while closed; no conditional render tied to open state. Preserve known&&ready and every source/busy/capability condition. A manually selected receipt keeps its chooser open, and no selected inventory opens it for discovery. Opening/closing never invokes a callback. Use the existing history field ID/label, and prefix+'history-options' only if an ID for the new details is needed. Do not hide this return path for empty/expired/deleted/partial snapshots.
8. Preserve Cancel local refresh and its remote-work caveat in the visible pending/owner area, with its exact existing conditions; do not put a needed cancellation behind history or receipt details. Pending, expired, unavailable and null-summary messages remain distinct and unchanged. No rows/exports appear for inaccessible states even if stale rows are supplied.

Use existing primitives and inline semantic-token spacing: space-3 between rows, space-4 within existing cards, border token only for a local separator if useful. No new stylesheet, abstraction, icon, chart or color. Heading IDs/focus targets and button IDs remain. Natural wrapping, minWidth0, overflowWrap:anywhere. The Saved campaigns region retains role=region, exact aria-label, tabIndex0, table min-width760 and four columns >=180. All controls/summary targets >=44px; native markers/focus/forced colors retained. No motion.

Immutable: role-null purge and known/ready masks; submitting/unknown lock; canRefresh/canCancel/canRetrySame/canExport; independent history/row paging; exact raw strings and notices; source versus captured snapshot identity; current-attempt versus selected-receipt distinction. No change to callbacks or invocation arguments, no new request when a disclosure opens, no cost/budget/provider scheduler changes. Moved JSX stays under the same original branch gates.

GPT independent acceptance after application: existing tests/meta-campaign-view-browser.mjs (8 groups), tests/meta-campaign-browser.mjs (11 groups), typecheck and required combined build. Retain all existing assertions; only explicitly open the new native history disclosure before operating controls intentionally hidden by it. Add order/visibility assertions for snapshot before history, visible recent-attempt/coverage/observation caveats, export next to summary, Receipt details below results, no repeated export, and no callbacks from either disclosure. Test summary-null chooser open; latest complete chooser initially closed; selected historical receipt chooser open; unknown/submitting/read/export locks unchanged; complete-empty CSV, separate statuses, deletion/expiry masking and same-body retry unchanged.320/360/768/1440px, long names, RTL, CSS200% layout zoom, forced colors,44px controls and keyboard table scrolling. No DB/provider/live-preview requests. This document is design only, not a pass claim.


C1 SHA256: 9EE2BA72AFDD33345B5F3F9214B267CED4687E3AB9DE76D9DC66E56FCA0EFC60

Whole-file SHA256: 9A2DD445526273374530E5AFF7CA96350E5C9DEFF997AC7DB3D0E161567C4A86

Original public source (read-only outside C1):

```tsx
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
```
