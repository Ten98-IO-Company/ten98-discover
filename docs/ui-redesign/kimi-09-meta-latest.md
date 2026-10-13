Return bare JSON only: {"replacements":[{"id":"L1","new":"the exact replacement JSX return block"}]}. No Markdown fences or explanation. Skill-only profile: no shell, filesystem, network, subagents, provider, database, publishing or deployment tools. Initial draft deadline420seconds; at most one120-second repair, total540seconds maximum, then stop and hand off to GPT. Do not claim checks you cannot run. Load the supplied Ponytail and UX Copy Refiner skills before drafting.
# M03b — Meta saved coverage: results before secondary provenance

Public bounded Kimi presentation draft. GPT owns design and independent acceptance. Apply Ponytail and UX Copy Refiner if supplied. Use verified K3 maximum thinking under the supervising profile. Time cap9 minutes; at most one repair, then stop and hand off. No requirement changes to force a pass.

Allowlist: `src/components/MetaLatestView.tsx` only. No CSS files, controller, tests, routes, dependencies or public type changes. No imports, helpers, components, hooks, state, effects, network, URL generation, storage, formatting or derived totals.

Return ONE replacement JSX block L1 in the supervisor's output envelope. L1 is the final `  return (` through its `  );`, excluding the final function brace. Everything before and after stays byte-equivalent. Exact hashes and original public source are appended below. No private environment/customer/provider data is supplied.

The actual flow: MetaImportPanel opens MetaLatestPanel for one source/reference report. Saved reads and CSV do not request a new Meta import. Draft dates differ from applied result.rangeLabel; controller capabilities already disable export/paging when dates are dirty. Do not parse rangeLabel or infer dirty state. Back can interrupt reads/exports. Authority/revision/expiry/export validation stays in the unchanged controller.

Required reading order:
1. Compact wrapping header: existing h2/focus ID, Back to imports, Reload coverage. Keep the short read-only intro. Errors, exportError, notice, Loading coverage and Preparing CSV/Cancel export remain outside disclosures under their original conditions. All callbacks, arguments and disabled expressions stay byte-for-byte.
2. Source context becomes a plain compact stack instead of a second card frame. Keep all four dl values (account, report, currency, time zone) and attributionLabel visibly. No new readiness status or inferred count.
3. Keep From/To and Apply date range visible. Only two fields exist and the props have no safe dirty-state flag. Use `repeat(auto-fit,minmax(min(100%,8rem),1fr))`, gap `var(--space-3)`, minWidth0, and controls constrained to their grid area. Keep controlled values, type=date, IDs, aria-describedby, callbacks, capabilities and account-local31-day help exact. No automatic apply or new date computation.
4. With result present, one card contains applied range, asOf and retained-row count in a compact summary beside the existing Export CSV action. Move that action from below Selection details to this header. Keep aria-describedby and the exact CSV warning immediately below. One export control only.
5. Show the existing Latest daily Meta rows table (or exact empty text), row pager and spend/attribution overlap warning, then the existing Daily coverage table (or exact coverage-empty text). Daily coverage MUST remain expanded, including every date's state/count/help and exact Open import callback. Do not collapse it into details or a badge. Before the rows show the existing sentence “Completed imports replace earlier values for each covered day. Missing values are not zero.” Move this sentence from profile to here, rendering it once; if result is null but profile exists it stays in the profile context. No data inference.
6. Move Selection details to the end of the result card after both tables. Preserve exact selectionRevision, native marker and44px summary. Do not change h2, IDs, captions, named regions, columns or row mappings.

Use existing research-panel/stack/card/row/field/btn/hint/alert/table-wrap classes, system font and semantic tokens. Inline styles suffice. Compact by removing redundant card framing and moving secondary selection identity, not smaller text or targets. minWidth0 and overflowWrap:anywhere for long account/provenance labels. Tables retain720/960px minima and independently focusable named scroll regions. Controls >=44px. Native focus, forced colors and reduced motion remain; no animation or assets.

Immutable behavior:
- All exported types/helpers/pre-return calculations and control callbacks/arguments/disabled expressions stay exact. A moved subtree stays under the same original authorization/state conditions. Back/Cancel recovery must remain usable as before.
- Unknown role hides stale profile/result/controls even if supplied. Preserve all six coverage states, counts, zero/null/empty/unavailable distinctions, exact large decimal strings and inert provider labels. No invented totals, inferred zero days or advertising-spend/budget changes.
- Preserve separate read/export errors, cancellation, no-result copy and explicit date validation. Disclosure interaction invokes no callback. No conditional mounting tied to disclosure state.

GPT acceptance after application (not claimed by this draft): existing tests/meta-latest-view-browser.mjs (7 groups) and tests/meta-latest-browser.mjs (8 groups), preserving all assertions; typecheck and required combined build. Add DOM-order checks: rows before coverage, Selection details after both, Export beside applied summary, dates and all source/attribution qualifications visible. Retain dirty-date, role purge, current-access loss, receipt/Back revalidation, exact values, bounded/cancelled CSV and zero-provider-request cases. Check320/360/768/1440px, long strings, RTL, CSS200% layout zoom, forced colors,44px targets and keyboard scrolling of BOTH named regions. No live server or provider acceptance claim.


L1 SHA256: DCB265F1146508FCA2866F89C2D18716E110E0441ACB4712497D51B95CCA0730

Whole-file SHA256: 6DDAC62667143CB7FB89C8F43793ACA263880E399C83F80DFCCF50EE5E29BEAC

Original public source (read-only outside L1):

```tsx
export type MetaLatestProfile = {
  accountLabel: string; reportLabel: string; currency: string;
  timeZone: string; attributionLabel: string;
};
export type MetaLatestCoverage = {
  date: string;
  state: 'rows' | 'empty' | 'missing' | 'expired' | 'deleted' | 'incompatible';
  stateLabel: string; countsLabel: string; help: string;
  receiptId: string | null;
};
export type MetaLatestRow = {
  key: string; date: string; campaignLabel: string;
  impressions: string; clicks: string; spend: string;
  actions: {label: string; value: string}[] | null;
  actionValues: {label: string; value: string}[] | null;
};
export type MetaLatestResult = {
  rangeLabel: string; asOfLabel: string; countLabel: string;
  selectionRevision: string;
  coverage: MetaLatestCoverage[];
};
export type MetaLatestViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean; reading: boolean; exporting: boolean;
  error: string; exportError: string; notice: string;
  profile: MetaLatestProfile | null;
  from: string; to: string;
  result: MetaLatestResult | null; rows: MetaLatestRow[];
  canApply: boolean; canExport: boolean;
  canPreviousRows: boolean; canNextRows: boolean;
  onFrom: (value: string) => void; onTo: (value: string) => void;
  onApply: () => void; onReload: () => void; onBack: () => void;
  onPreviousRows: () => void; onNextRows: () => void;
  onOpenImport: (id: string) => void;
  onExport: () => void; onCancelExport: () => void;
};

const btnStyle = { minHeight: 44, whiteSpace: 'normal' } as const;

function entryContent(entries: { label: string; value: string }[] | null) {
  if (entries === null) return 'Unavailable';
  if (entries.length === 0) return 'No entries returned';
  return entries.map((entry, index) => (
    <span key={index} style={{ display: 'block', overflowWrap: 'break-word' }}>
      {entry.label}: {entry.value}
    </span>
  ));
}

export function MetaLatestView(props: MetaLatestViewProps) {
  const known = props.role !== null;
  const busy = props.reading || props.exporting;
  const showLoading = !props.loaded || props.reading;
  const profile = known ? props.profile : null;
  const result = known ? props.result : null;
  const headingId = props.prefix + 'heading';
  const fromId = props.prefix + 'from';
  const toId = props.prefix + 'to';
  const rangeHelpId = props.prefix + 'range-help';
  const exportHelpId = props.prefix + 'export-help';

  return (
    <section className="research-panel stack" aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1}>Latest complete coverage</h2>
      <p>Read the latest completed imports for this report definition. This view does not request data from Meta.</p>
      {props.error !== '' && <p className="alert" role="alert">{props.error}</p>}
      {props.exportError !== '' && <p className="alert" role="alert">{props.exportError}</p>}
      {props.notice !== '' && <p className="hint" role="status">{props.notice}</p>}
      <div className="row">
        <button type="button" className="btn" style={btnStyle} onClick={props.onBack}>Back to imports</button>
        <button type="button" className="btn" style={btnStyle} onClick={props.onReload} disabled={busy}>Reload coverage</button>
      </div>
      {showLoading && <p>Loading coverage…</p>}
      {known && props.exporting && (
        <div className="row">
          <p style={{ margin: 0 }}>Preparing CSV…</p>
          <button type="button" className="btn" style={btnStyle} onClick={props.onCancelExport}>Cancel export</button>
        </div>
      )}
      {profile !== null && (
        <div className="card stack">
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '0.75rem', margin: 0 }}>
            <div style={{ minWidth: 0 }}>
              <dt>Account</dt>
              <dd style={{ margin: 0, overflowWrap: 'break-word' }}>{profile.accountLabel}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt>Report</dt>
              <dd style={{ margin: 0, overflowWrap: 'break-word' }}>{profile.reportLabel}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt>Currency</dt>
              <dd style={{ margin: 0, overflowWrap: 'break-word' }}>{profile.currency}</dd>
            </div>
            <div style={{ minWidth: 0 }}>
              <dt>Time zone</dt>
              <dd style={{ margin: 0, overflowWrap: 'break-word' }}>{profile.timeZone}</dd>
            </div>
          </dl>
          <p style={{ overflowWrap: 'break-word' }}>{profile.attributionLabel}</p>
          <p className="hint">Completed imports replace earlier values for each covered day. Missing values are not zero.</p>
        </div>
      )}
      {known && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <div className="field" style={{ minWidth: 0, margin: 0 }}>
            <label htmlFor={fromId}>From</label>
            <input id={fromId} type="date" value={props.from} disabled={busy} aria-describedby={rangeHelpId} style={{ minHeight: 44 }} onChange={(event) => props.onFrom(event.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 0, margin: 0 }}>
            <label htmlFor={toId}>To</label>
            <input id={toId} type="date" value={props.to} disabled={busy} aria-describedby={rangeHelpId} style={{ minHeight: 44 }} onChange={(event) => props.onTo(event.target.value)} />
          </div>
          <div style={{ minWidth: 0 }}>
            <button type="button" className="btn" style={btnStyle} onClick={props.onApply} disabled={busy || !props.canApply || props.from === '' || props.to === ''}>Apply date range</button>
          </div>
          <p className="hint" id={rangeHelpId} style={{ gridColumn: '1 / -1', margin: 0 }}>Use at most 31 account-local days. Changing dates does not request a new import.</p>
        </div>
      )}
      {known && result === null && !showLoading && (
        <p>Apply a date range to read saved coverage.</p>
      )}
      {result !== null && (
        <div className="card stack">
          <p style={{ margin: 0 }}>
            <span style={{ display: 'block', overflowWrap: 'break-word' }}>{result.rangeLabel}</span>
            <span style={{ display: 'block', overflowWrap: 'break-word' }}>{result.asOfLabel}</span>
            <span style={{ display: 'block', overflowWrap: 'break-word' }}>{result.countLabel}</span>
          </p>
          <details>
            <summary style={{ minHeight: 44 }}>Selection details</summary>
            <p style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{result.selectionRevision}</p>
          </details>
          <div className="row">
            <button type="button" className="btn" style={btnStyle} aria-describedby={exportHelpId} onClick={props.onExport} disabled={busy || !props.canExport}>Export CSV</button>
          </div>
          <p className="hint" id={exportHelpId} style={{ margin: 0 }}>Includes coverage and receipt metadata. Decimal values are preserved in the file; spreadsheet software may convert them when opened.</p>
          {result.coverage.length === 0 ? (
            <p>No coverage entries returned.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="Daily coverage" tabIndex={0} style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 720 }}>
                <caption>Daily coverage</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ minWidth: 110 }}>Date</th>
                    <th scope="col" style={{ minWidth: 170 }}>Coverage</th>
                    <th scope="col" style={{ minWidth: 110 }}>Rows</th>
                    <th scope="col" style={{ minWidth: 220 }}>Details</th>
                    <th scope="col" style={{ minWidth: 130 }}>Import</th>
                  </tr>
                </thead>
                <tbody>
                  {result.coverage.map((day) => {
                    const receiptId = day.receiptId;
                    return (
                      <tr key={day.date}>
                        <td style={{ whiteSpace: 'nowrap' }}>{day.date}</td>
                        <td>{day.stateLabel}</td>
                        <td>{day.countsLabel}</td>
                        <td>{day.help}</td>
                        <td>
                          {receiptId === null ? 'No receipt' : (
                            <button type="button" className="btn" style={btnStyle} aria-label={'Open import for ' + day.date} disabled={busy} onClick={() => props.onOpenImport(receiptId)}>Open import</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {props.rows.length === 0 ? (
            <p>No readable rows on this page. Review daily coverage for empty, missing or unavailable dates.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="Latest daily Meta rows" tabIndex={0} style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 960 }}>
                <caption>Latest daily Meta rows</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ minWidth: 110 }}>Date</th>
                    <th scope="col" style={{ minWidth: 180 }}>Campaign</th>
                    <th scope="col" style={{ minWidth: 140 }}>Impressions</th>
                    <th scope="col" style={{ minWidth: 110 }}>Clicks</th>
                    <th scope="col" style={{ minWidth: 160 }}>Spend</th>
                    <th scope="col" style={{ minWidth: 180 }}>Actions</th>
                    <th scope="col" style={{ minWidth: 180 }}>Action values</th>
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
                      <td>{entryContent(row.actions)}</td>
                      <td>{entryContent(row.actionValues)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row">
            <button type="button" className="btn" style={btnStyle} onClick={props.onPreviousRows} disabled={busy || !props.canPreviousRows}>Previous row page</button>
            <button type="button" className="btn" style={btnStyle} onClick={props.onNextRows} disabled={busy || !props.canNextRows}>Next row page</button>
          </div>
          <p className="hint" style={{ margin: 0 }}>Spend is provider-estimated. Action types and attribution windows can overlap; they are not additive totals.</p>
        </div>
      )}
    </section>
  );
}
```
