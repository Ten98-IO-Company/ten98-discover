Return bare JSON only: {"replacements":[{"id":"I1","new":"exact replacement"},{"id":"I2","new":"exact replacement"},{"id":"I3","new":"exact replacement"}]}. Draft420seconds, one repair120seconds, total540seconds maximum then GPT handoff. Skill-only: no shell/filesystem/network/subagents.

# M03a — Saved reports first; explicit new-import disclosure

Public bounded Kimi presentation draft. GPT owns design and independent acceptance. Use supplied Ponytail/UX Copy Refiner and verified K3 maximum thinking.9-minute cap, at most one repair then stop and hand off. No changed acceptance or silent scope expansion.

Allowlist: `src/components/MetaImportView.tsx` only. Return replacements for the exact three blocks I1/I2/I3 below, using the supervisor's output envelope. Never replace the whole file. Exported types, constants, helpers, all pre-return logic, loading/error/retry/reload/manage toolbar, selected report summary/table/receipt details and cancellation branch are read-only. No CSS, controller, prop, hook, state, handler, import, abstraction or dependency change.

Actual flow: the controller reads source pages, selected-source history and individual retained receipts separately. Owner-only Import report explicitly enqueues one request; selection, history, reloading and disclosure toggles do not contact Meta. Returned amounts/dates/counts/labels are already formatted; no math or date conversion. Unknown writes retain one immutable request and allow only exact retry. Deleted/expired source masking and source/role revalidation stay in the controller. Existing sibling entry buttons for Latest complete coverage/Campaign inventory are moved separately by an exact parent-render task; do not duplicate them here.

I1: rename the local h2 from Meta reports to Saved imports, retaining prefix+'heading', tabIndex=-1 and element semantics. The shell already provides the Meta reports h1. No embedded-heading prop.

I2: replace only the source-card subtree, still within the original `props.role !== null` gate.
- Flatten its outer card to a compact stack; keep every existing Source select/control/value/label callback. Preserve option values, duplicated display labels, native select and all disabled expressions.
- One narrowly permitted empty-state branch: when `props.loaded && !props.reading && props.error === '' && props.sources.length === 0 && props.selectedSourceId === '' && props.source === null && !props.canPreviousSources && !props.canNextSources`, replace the unusable empty select and two pager buttons with the existing exact sentence “No sources on this page.” and a short role-aware next step. Owner: “Use Manage connections to connect a reporting source.” Other known members: “Use Manage connections to review access, or ask a workspace owner to connect a reporting source.” Reuse the existing Manage connections action above; no new callback/control. This describes the observed page, never claims no accounts exist globally.
- Otherwise retain the source selector and BOTH source-page buttons with their original gates, even if disabled. An empty later page with a previous/next capability keeps navigation. Show the existing empty-page sentence only after a successful settled read (`props.loaded && !props.reading && props.error === '' && props.sources.length === 0`); loading/error is never presented as confirmed emptiness. Do not infer source availability from statusLabel.
- Keep `props.source !== null` and all five source values visibly: Name, Account ID, Currency, Time zone, Status, followed by source.help. Compact the description-list grid with minWidth0 and `repeat(auto-fit,minmax(min(100%,8rem),1fr))`; use token gaps. No clipping, abbreviating IDs or hiding currency/time zone/status/help.
- Within the EXISTING owner branch, wrap the exact Report/From/To fields,31-day/account-local/provisional help and Import report action in native `<details open={summary === null || submitting || unknown}>` with summary “Import a report”. The content remains mounted when closed; do not use new state or conditional children. This opens first-use and unconfirmed-request context, while retained report review starts compact. The summary toggles presentation only and makes no request. Native marker,44px summary target and keyboard behavior remain. Give an optional details ID only from prefix+'new-import'; retain all existing field IDs.
- Every existing form callback, value, disabled expression and Import report primary class stays byte-for-byte. Keep Report options exact; keep canStartImport and canRetry derivation untouched. It is an explicit form behind one disclosure, not a new wizard or second confirmation. Keep the existing nonowner read-only explanation outside any owner-only disclosure.
- Spacing uses existing stack/row/field/btn classes and inline semantic-token values. Keep source context outside the import disclosure. No extra outer card, metric tiles, badges or introduction paragraphs.

I3: flatten only the Import history card to a compact stack with existing selector and its two page controls. Keep the entire `props.selectedSourceId !== ''` condition, every label/value/option/handler/disabled gate and settled-empty message as written. Retain its existing wrapping desktop row. It stays immediately before the unchanged selected report summary/table; do not hide history behind another disclosure or unmount its control.

Everything else remains unchanged. Especially do not touch all three independent pagers' callbacks, exact large numeric strings, action-null versus empty arrays, partial status, all receipt metadata/attribution/warnings/diagnostics, pending/expired/unavailable/available rows, local-only cancellation or role-null purge. No data, provider, advertising-spend or budget semantics change. No request can result from opening/closing the import form.

Layout: keep >=44px controls, visible focus and native details marker. Use minWidth0/overflowWrap:anywhere and existing token spacing, not new global selectors. The source/history rows wrap at narrow widths; desktop Report/From/To remain in one row when the form is open. Table minimum960px and exact focusable Daily Meta report rows region remain outside the replacement boundary. No document overflow320/360/768/1440px or RTL; only the existing region scrolls.

Independent GPT checks after exact application: existing tests/meta-import-view-browser.mjs (7 groups) and tests/meta-import-browser.mjs (11 groups), plus relevant import-parent handoff groups of latest/campaign tests. Keep all behavior/value/capability assertions. Update only approved presentation locators: heading Saved imports, open Import a report before interacting/measuring its fields, use Receipt and import details by name instead of every-summary locator. Existing44px measurements still run for every form control AFTER opening; no skipping hidden fields as a substitute. New checks: selected receipt closes new-import form by default; no receipt and submitting/unknown expose it; closing never unmounts fields or invokes callbacks; source metadata stays visible; source-less success hides only the unusable controls, whereas loading/error and empty later-page recovery do not claim global emptiness. Preserve disabled pager expectations for nonempty sources. Preserve unknown-role purge, durable same-body retry, role change, deletion/expiry, source resets and fresh return checks. Typecheck/build as required; contained loopback tests only. This is a design brief, not implementation/test-pass evidence.


Whole-file SHA256: 774E9CFEA90060FB9B707728A2F53E65A98BE03FACC6496CFB86DADF97792D63

Read-only public types/helpers/pre-return logic:

```tsx
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

```

## Original exact block I1

SHA256: 374938C4A7ABA06F5D2C181A2E7DB75A8A0873A1471168726269D6CDEAF2954F

```tsx
      <h2 id={props.prefix + 'heading'} tabIndex={-1}>
        Meta reports
      </h2>```

## Original exact block I2

SHA256: E9C8382E2308EB6516FCC98212749E97728C2B9B0B28205C2D4C37E7A7139C16

```tsx
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
```

## Original exact block I3

SHA256: 3236DDCBDE54CA2ACBC7CB83F0A969403E41B4F5F2CA2D98C623876900EA90B9

```tsx
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
```
