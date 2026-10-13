import type { CSSProperties } from 'react';

export type SpecializedView = 'reddit' | 'shopping' | 'search' | 'gaps';
export type SpecializedPeriodId = 'current' | 'previous';
export type SpecializedOption = { id: string; label: string };
export type SpecializedDraft = {
  grouping: 'retained-fragment-v1' | 'elmo-url-v1'; query: string;
  ownership: string; entityId: string; publisherCategory: string; pageType: string; sourceType: string;
  productAttribution: 'all' | 'brand' | 'competitor' | 'other';
};
export type SpecializedCounts = { answers: string; annotations: string; prompts: string; pages?: string };
export type SpecializedGroupActions = { canPages: boolean; canPrompts: boolean; canEvidence: boolean };
export type SpecializedGroupRow = {
  id: string; label: string; details: string[];
  current: SpecializedCounts; previous: SpecializedCounts;
  currentActions: SpecializedGroupActions; previousActions: SpecializedGroupActions;
};
export type SpecializedPromptRowView = {
  id: string; preview: string; details: string[]; counts: SpecializedCounts;
  statusLabel: string | null; coverageLabel: string | null; canEvidence: boolean;
};
export type SpecializedEvidenceRowView = {
  id: string; requestedAt: string; model: string; promptLabel: string;
  retainedUrl: string; safeHref: string | null; retainedTitle: string | null;
  retainedOrder: string; groupedUrl: string; classification: string[]; canOpenComparison: boolean;
};
export type SpecializedScreen =
  | { kind: 'groups'; rows: SpecializedGroupRow[] }
  | {
      kind: 'pages'; rows: {
        id: string; groupedUrl: string; retainedUrl: string; safeHref: string | null;
        retainedTitle: string | null; counts: SpecializedCounts; changeLabel: string;
      }[]; canCommunityEvidence: boolean;
    }
  | { kind: 'prompts' | 'gaps'; rows: SpecializedPromptRowView[] }
  | { kind: 'evidence'; basisLabel: string; rows: SpecializedEvidenceRowView[] };
export type CitationSpecializationsViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  reading: boolean; exporting: boolean; error: string | null; notice: string | null;
  backLabel: string; canReload: boolean; canExport: boolean;
  report: null | {
    view: SpecializedView; title: string; selectionLabel: string; scopeLabel: string; snapshotLabel: string;
    groupingLabel: string; appliedFiltersLabel: string; measurementLabel: string; warnings: string[];
    denominatorLabel: string; overlapLabel: string; googleModuleLabel: string; exportLabel: string;
    periods: {
      id: SpecializedPeriodId; label: string; range: string; stateLabel: string;
      eligibleAnswers: string; coverageLabel: string; values: { label: string; value: string }[];
    }[];
    draft: SpecializedDraft; dirty: boolean; filterError: string | null; canApply: boolean;
    entities: SpecializedOption[]; ownershipOptions: SpecializedOption[]; publisherOptions: SpecializedOption[];
    pageTypeOptions: SpecializedOption[]; sourceTypeOptions: SpecializedOption[];
    canNavigate: boolean; period: SpecializedPeriodId | null; canChangePeriod: boolean;
    unresolved: {
      id: 'reddit' | 'shopping' | 'search' | 'wrapper'; label: string;
      currentLabel: string; previousLabel: string; canCurrent: boolean; canPrevious: boolean;
    }[];
    emptyMessage: string; pager: { label: string; canPrevious: boolean; canNext: boolean }; screen: SpecializedScreen;
  };
  onBack: () => void; onReload: () => void; onExport: () => void; onCancel: () => void;
  onDraftChange: (draft: SpecializedDraft) => void; onApply: () => void;
  onViewChange: (view: SpecializedView) => void; onPeriodChange: (period: SpecializedPeriodId) => void;
  onOpenGroup: (id: string, period: SpecializedPeriodId, target: 'pages' | 'prompts' | 'evidence') => void;
  onOpenPrompt: (id: string) => void; onCommunityEvidence: () => void;
  onUnresolved: (id: 'reddit' | 'shopping' | 'search' | 'wrapper', period: SpecializedPeriodId) => void;
  onPrevious: () => void; onNext: () => void; onOpenComparison: (evidenceId: string) => void;
};

const btn44: CSSProperties = { minHeight: 44 };
const ctl: CSSProperties = { minHeight: 44, maxWidth: '100%' };
const wrapAnywhere: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
const summary44: CSSProperties = { minHeight: 44 };
const cellTop: CSSProperties = { verticalAlign: 'top' };
const filterGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))',
  gap: 12,
};
const fieldFlush: CSSProperties = { margin: 0, minWidth: 0 };
const th = (minWidth: number): CSSProperties => ({ minWidth, textAlign: 'left', verticalAlign: 'top' });

const VIEW_TABS: { id: SpecializedView; label: string }[] = [
  { id: 'reddit', label: 'Reddit communities' },
  { id: 'shopping', label: 'Shopping links' },
  { id: 'search', label: 'Search queries' },
  { id: 'gaps', label: 'Citation gaps' },
];

function CountLines({ c }: { c: SpecializedCounts }) {
  return (
    <div className="stack">
      <span>Answers: {c.answers}</span>
      <span>Annotations: {c.annotations}</span>
      <span>Prompts: {c.prompts}</span>
      {c.pages !== undefined && <span>Grouped pages: {c.pages}</span>}
    </div>
  );
}

function RetainedTitleText({ title }: { title: string | null }) {
  if (title === null) return <div className="hint">No retained title</div>;
  if (title === '') return <div className="hint">Empty retained title</div>;
  return <div style={wrapAnywhere}>{title}</div>;
}

function RetainedUrl({ url, safeHref }: { url: string; safeHref: string | null }) {
  if (safeHref === null) return <span style={wrapAnywhere}>{url}</span>;
  return (
    <a href={safeHref} target="_blank" rel="noopener noreferrer" style={wrapAnywhere}>
      {url}
    </a>
  );
}

function GroupPeriodActions({ rowId, label, period, actions, nav, onOpenGroup }: {
  rowId: string; label: string; period: SpecializedPeriodId; actions: SpecializedGroupActions; nav: boolean;
  onOpenGroup: (id: string, period: SpecializedPeriodId, target: 'pages' | 'prompts' | 'evidence') => void;
}) {
  const p = period === 'current' ? 'Current' : 'Previous';
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      {actions.canPages && (
        <button type="button" className="btn ghost" style={btn44}
          aria-label={`${p} pages for ${label} (${rowId}, ${period} period)`}
          disabled={!(nav && actions.canPages)}
          onClick={() => { if (nav && actions.canPages) onOpenGroup(rowId, period, 'pages'); }}>
          {p} pages
        </button>
      )}
      <button type="button" className="btn ghost" style={btn44}
        aria-label={`${p} prompts for ${label} (${rowId}, ${period} period)`}
        disabled={!(nav && actions.canPrompts)}
        onClick={() => { if (nav && actions.canPrompts) onOpenGroup(rowId, period, 'prompts'); }}>
        {p} prompts
      </button>
      <button type="button" className="btn ghost" style={btn44}
        aria-label={`${p} annotations for ${label} (${rowId}, ${period} period)`}
        disabled={!(nav && actions.canEvidence)}
        onClick={() => { if (nav && actions.canEvidence) onOpenGroup(rowId, period, 'evidence'); }}>
        {p} annotations
      </button>
    </div>
  );
}

function GroupsTable({ rows, emptyMessage, nav, onOpenGroup }: {
  rows: SpecializedGroupRow[]; emptyMessage: string; nav: boolean;
  onOpenGroup: (id: string, period: SpecializedPeriodId, target: 'pages' | 'prompts' | 'evidence') => void;
}) {
  return (
    <>
      <div className="table-wrap" role="region" aria-label="Group comparison results" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col" style={th(200)}>Group</th>
              <th scope="col" style={th(140)}>Current</th>
              <th scope="col" style={th(140)}>Previous</th>
              <th scope="col" style={th(240)}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={cellTop}>
                  <div style={wrapAnywhere}>{row.label}</div>
                  {row.details.map((d, i) => (<div key={i} className="hint" style={wrapAnywhere}>{d}</div>))}
                </td>
                <td style={cellTop}><CountLines c={row.current} /></td>
                <td style={cellTop}><CountLines c={row.previous} /></td>
                <td style={cellTop}>
                  <div className="stack">
                    <GroupPeriodActions rowId={row.id} label={row.label} period="current" actions={row.currentActions} nav={nav} onOpenGroup={onOpenGroup} />
                    <GroupPeriodActions rowId={row.id} label={row.label} period="previous" actions={row.previousActions} nav={nav} onOpenGroup={onOpenGroup} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="hint">{emptyMessage}</p>}
    </>
  );
}

function PagesTable({ rows, canCommunityEvidence, emptyMessage, nav, onCommunityEvidence }: {
  rows: Extract<SpecializedScreen, { kind: 'pages' }>['rows']; canCommunityEvidence: boolean;
  emptyMessage: string; nav: boolean; onCommunityEvidence: () => void;
}) {
  return (
    <>
      {canCommunityEvidence && (
        <div className="row">
          <button type="button" className="btn ghost" style={btn44} disabled={!nav}
            onClick={() => { if (nav && canCommunityEvidence) onCommunityEvidence(); }}>
            View community annotations
          </button>
        </div>
      )}
      <div className="table-wrap" role="region" aria-label="Grouped page results" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col" style={th(200)}>Grouped URL</th>
              <th scope="col" style={th(220)}>Retained representative</th>
              <th scope="col" style={th(140)}>Counts</th>
              <th scope="col" style={th(140)}>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.groupedUrl}</td>
                <td style={cellTop}>
                  <RetainedTitleText title={row.retainedTitle} />
                  <RetainedUrl url={row.retainedUrl} safeHref={row.safeHref} />
                </td>
                <td style={cellTop}><CountLines c={row.counts} /></td>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.changeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="hint">{emptyMessage}</p>}
    </>
  );
}

function PromptsTable({ kind, rows, emptyMessage, nav, onOpenPrompt }: {
  kind: 'prompts' | 'gaps'; rows: SpecializedPromptRowView[]; emptyMessage: string; nav: boolean;
  onOpenPrompt: (id: string) => void;
}) {
  const actionLabel = kind === 'gaps' ? 'Inspect gap evidence' : 'View annotations';
  const regionLabel = kind === 'gaps' ? 'Citation gap results' : 'Prompt results';
  return (
    <>
      <div className="table-wrap" role="region" aria-label={regionLabel} tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col" style={th(240)}>Prompt</th>
              <th scope="col" style={th(150)}>Status</th>
              <th scope="col" style={th(140)}>Counts</th>
              <th scope="col" style={th(190)}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={cellTop}>
                  <div style={wrapAnywhere}>{row.preview}</div>
                  {row.details.map((d, i) => (<div key={i} className="hint" style={wrapAnywhere}>{d}</div>))}
                </td>
                <td style={cellTop}>
                  {row.statusLabel !== null && <div style={wrapAnywhere}>{row.statusLabel}</div>}
                  {row.coverageLabel !== null && <div className="hint" style={wrapAnywhere}>{row.coverageLabel}</div>}
                </td>
                <td style={cellTop}><CountLines c={row.counts} /></td>
                <td style={cellTop}>
                  <button type="button" className="btn ghost" style={btn44}
                    aria-label={`${actionLabel} for prompt ${row.id}`}
                    disabled={!(nav && row.canEvidence)}
                    onClick={() => { if (nav && row.canEvidence) onOpenPrompt(row.id); }}>
                    {actionLabel}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="hint">{emptyMessage}</p>}
    </>
  );
}

function EvidenceTable({ rows, emptyMessage, nav, onOpenComparison }: {
  rows: SpecializedEvidenceRowView[]; emptyMessage: string; nav: boolean;
  onOpenComparison: (evidenceId: string) => void;
}) {
  return (
    <>
      <div className="table-wrap" role="region" aria-label="Retained annotation evidence" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 960 }}>
          <thead>
            <tr>
              <th scope="col" style={th(150)}>Retained title</th>
              <th scope="col" style={th(170)}>Retained URL</th>
              <th scope="col" style={{ ...th(140), whiteSpace: 'nowrap' }}>Requested</th>
              <th scope="col" style={th(110)}>Model</th>
              <th scope="col" style={th(130)}>Prompt</th>
              <th scope="col" style={th(110)}>Annotation order</th>
              <th scope="col" style={th(150)}>Grouped URL</th>
              <th scope="col" style={th(140)}>Classification</th>
              <th scope="col" style={th(150)}>Comparison</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={cellTop}><RetainedTitleText title={row.retainedTitle} /></td>
                <td style={cellTop}><RetainedUrl url={row.retainedUrl} safeHref={row.safeHref} /></td>
                <td style={{ ...cellTop, whiteSpace: 'nowrap' }}>{row.requestedAt}</td>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.model}</td>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.promptLabel}</td>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.retainedOrder}</td>
                <td style={{ ...cellTop, ...wrapAnywhere }}>{row.groupedUrl}</td>
                <td style={cellTop}>
                  {row.classification.map((c, i) => (<div key={i} style={wrapAnywhere}>{c}</div>))}
                </td>
                <td style={cellTop}>
                  <button type="button" className="btn ghost" style={btn44}
                    aria-label={`Open saved comparison for annotation ${row.id}`}
                    disabled={!(nav && row.canOpenComparison)}
                    onClick={() => { if (nav && row.canOpenComparison) onOpenComparison(row.id); }}>
                    Open saved comparison
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="hint">{emptyMessage}</p>}
    </>
  );
}

export function CitationSpecializationsView(props: CitationSpecializationsViewProps) {
  const {
    prefix, role, reading, exporting, error, notice, backLabel, canReload, canExport, report,
    onBack, onReload, onExport, onCancel, onDraftChange, onApply, onViewChange, onPeriodChange,
    onOpenGroup, onOpenPrompt, onCommunityEvidence, onUnresolved, onPrevious, onNext, onOpenComparison,
  } = props;
  const rep = role === null ? null : report;
  const idle = !reading && !exporting;
  const canDraft = rep !== null && idle;
  const nav = rep !== null && idle && rep.canNavigate && !rep.dirty;

  return (
    <section className="research-panel stack" aria-labelledby={`${prefix}-title`} style={{ minWidth: 0 }}>
      <div className="stack" style={{ minWidth: 0 }}>
        <h2 id={`${prefix}-title`}>Specialized citation reports</h2>
        {rep !== null && <p className="hint" style={wrapAnywhere}>{rep.scopeLabel}</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" className="btn ghost" style={btn44} onClick={() => onBack()}>
            {backLabel}
          </button>
          <button type="button" className="btn ghost" style={btn44} disabled={!canReload || exporting}
            onClick={() => { if (canReload && !exporting) onReload(); }}>
            Reload report
          </button>
          {rep !== null && (
            <>
              <button type="button" className="btn" style={btn44}
                disabled={!(idle && canExport && !rep.dirty)}
                onClick={() => { if (idle && canExport && !rep.dirty) onExport(); }}>
                Export full report
              </button>
              <span className="hint" style={wrapAnywhere}>{rep.exportLabel}</span>
            </>
          )}
          {reading && (
            <button type="button" className="btn ghost" style={btn44}
              onClick={() => { if (reading || exporting) onCancel(); }}>
              Cancel loading
            </button>
          )}
          {exporting && (
            <button type="button" className="btn ghost" style={btn44}
              onClick={() => { if (reading || exporting) onCancel(); }}>
              Cancel export
            </button>
          )}
        </div>
        {error !== null && <p role="alert" style={wrapAnywhere}>{error}</p>}
        {reading && !exporting && <p role="status">Loading retained citations…</p>}
        {exporting && <p role="status">Preparing CSV…</p>}
        {notice !== null && <p role="status" style={wrapAnywhere}>{notice}</p>}
      </div>

      {rep !== null && (
        <>
          <div className="row" role="group" aria-label="Specialized report views" style={{ flexWrap: 'wrap', gap: 8 }}>
            {VIEW_TABS.map((tab) => (
              <button key={tab.id} type="button" className="btn ghost" style={btn44}
                aria-pressed={rep.view === tab.id} disabled={!nav}
                onClick={() => { if (nav) onViewChange(tab.id); }}>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="stack" style={{ minWidth: 0 }}>
            <h3>{rep.title}</h3>
            {rep.selectionLabel !== '' && <p className="hint" style={wrapAnywhere}>{rep.selectionLabel}</p>}
          </div>

          {rep.period !== null && (
            <div className="field" style={fieldFlush}>
              <label htmlFor={`${prefix}-period`}>Period</label>
              <select id={`${prefix}-period`} style={ctl} value={rep.period}
                disabled={!(nav && rep.canChangePeriod)}
                onChange={(e) => { if (nav && rep.canChangePeriod) onPeriodChange(e.target.value as SpecializedPeriodId); }}>
                {rep.periods.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
              </select>
            </div>
          )}

          <details style={{ minWidth: 0 }}>
            <summary style={summary44}>Source filters</summary>
            <div style={{ ...filterGrid, marginTop: 8 }}>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-grouping`}>Grouping</label>
                <select id={`${prefix}-f-grouping`} style={ctl} value={rep.draft.grouping} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, grouping: e.target.value as SpecializedDraft['grouping'] }); }}>
                  <option value="retained-fragment-v1">Retained URL without fragment</option>
                  <option value="elmo-url-v1">Elmo URL grouping</option>
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-query`}>Search</label>
                <input id={`${prefix}-f-query`} type="search" maxLength={200} style={ctl} value={rep.draft.query} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, query: e.target.value }); }} />
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-entity`}>Entity</label>
                <select id={`${prefix}-f-entity`} style={ctl} value={rep.draft.entityId} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, entityId: e.target.value }); }}>
                  {rep.entities.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-ownership`}>Ownership</label>
                <select id={`${prefix}-f-ownership`} style={ctl} value={rep.draft.ownership} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, ownership: e.target.value }); }}>
                  {rep.ownershipOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-publisher`}>Publisher category</label>
                <select id={`${prefix}-f-publisher`} style={ctl} value={rep.draft.publisherCategory} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, publisherCategory: e.target.value }); }}>
                  {rep.publisherOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-pagetype`}>Page type</label>
                <select id={`${prefix}-f-pagetype`} style={ctl} value={rep.draft.pageType} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, pageType: e.target.value }); }}>
                  {rep.pageTypeOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-sourcetype`}>Source type</label>
                <select id={`${prefix}-f-sourcetype`} style={ctl} value={rep.draft.sourceType} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, sourceType: e.target.value }); }}>
                  {rep.sourceTypeOptions.map((o) => (<option key={o.id} value={o.id}>{o.label}</option>))}
                </select>
              </div>
              <div className="field" style={fieldFlush}>
                <label htmlFor={`${prefix}-f-product`}>Product attribution</label>
                <select id={`${prefix}-f-product`} style={ctl} value={rep.draft.productAttribution} disabled={!canDraft}
                  onChange={(e) => { if (canDraft) onDraftChange({ ...rep.draft, productAttribution: e.target.value as SpecializedDraft['productAttribution'] }); }}>
                  <option value="all">All products</option>
                  <option value="brand">Brand</option>
                  <option value="competitor">Competitor</option>
                  <option value="other">Other</option>
                </select>
                <span className="hint">Product attribution filters labelled shopping products only.</span>
              </div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <button type="button" className="btn" style={btn44} disabled={!(canDraft && rep.canApply)}
                onClick={() => { if (canDraft && rep.canApply) onApply(); }}>
                Apply source filters
              </button>
            </div>
            {rep.dirty && <p className="hint">Filters changed. Apply to update results.</p>}
            {rep.filterError !== null && <p role="alert" style={wrapAnywhere}>{rep.filterError}</p>}
            <p className="hint">Dates/base scope are changed by returning to Insights.</p>
          </details>

          <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
            {rep.periods.map((p) => (
              <div key={p.id} className="field" style={{ ...fieldFlush, flex: '1 1 260px' }}>
                <div style={wrapAnywhere}><strong>{p.label}</strong> <span className="hint">{p.range}</span></div>
                <div className="hint" style={wrapAnywhere}>{p.stateLabel}</div>
                <div style={wrapAnywhere}>Eligible retained answers: {p.eligibleAnswers}</div>
                {p.values.map((v, i) => (<div key={i} style={wrapAnywhere}>{v.label}: {v.value}</div>))}
                <details>
                  <summary style={summary44}>Answer coverage</summary>
                  <p className="hint" style={wrapAnywhere}>{p.coverageLabel}</p>
                </details>
              </div>
            ))}
          </div>
          <p className="hint" style={wrapAnywhere}>{rep.denominatorLabel}</p>
          <p className="hint" style={wrapAnywhere}>{rep.overlapLabel}</p>
          {(rep.view === 'shopping' || rep.view === 'search') && (
            <p className="hint" style={wrapAnywhere}>{rep.googleModuleLabel}</p>
          )}
          {rep.warnings.length > 0 && (
            <ul className="stack">
              {rep.warnings.map((w, i) => (<li key={i} style={wrapAnywhere}>{w}</li>))}
            </ul>
          )}

          <div className="stack" style={{ minWidth: 0 }}>
            {rep.screen.kind === 'evidence' && <p style={wrapAnywhere}>{rep.screen.basisLabel}</p>}
            {rep.screen.kind === 'groups' && (
              <GroupsTable rows={rep.screen.rows} emptyMessage={rep.emptyMessage} nav={nav} onOpenGroup={onOpenGroup} />
            )}
            {rep.screen.kind === 'pages' && (
              <PagesTable rows={rep.screen.rows} canCommunityEvidence={rep.screen.canCommunityEvidence}
                emptyMessage={rep.emptyMessage} nav={nav} onCommunityEvidence={onCommunityEvidence} />
            )}
            {(rep.screen.kind === 'prompts' || rep.screen.kind === 'gaps') && (
              <PromptsTable kind={rep.screen.kind} rows={rep.screen.rows} emptyMessage={rep.emptyMessage}
                nav={nav} onOpenPrompt={onOpenPrompt} />
            )}
            {rep.screen.kind === 'evidence' && (
              <EvidenceTable rows={rep.screen.rows} emptyMessage={rep.emptyMessage} nav={nav} onOpenComparison={onOpenComparison} />
            )}
          </div>

          {rep.unresolved.length > 0 && (
            <details style={{ minWidth: 0 }}>
              <summary style={summary44}>Other retained annotations</summary>
              <ul className="stack">
                {rep.unresolved.map((u) => (
                  <li key={u.id} className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}>
                    <span style={wrapAnywhere}>{u.label}</span>
                    <span className="hint" style={wrapAnywhere}>{u.currentLabel}</span>
                    <span className="hint" style={wrapAnywhere}>{u.previousLabel}</span>
                    <button type="button" className="btn ghost" style={btn44}
                      aria-label={`Inspect current ${u.label} (${u.id}, current period)`}
                      disabled={!(nav && u.canCurrent)}
                      onClick={() => { if (nav && u.canCurrent) onUnresolved(u.id, 'current'); }}>
                      Inspect current
                    </button>
                    <button type="button" className="btn ghost" style={btn44}
                      aria-label={`Inspect previous ${u.label} (${u.id}, previous period)`}
                      disabled={!(nav && u.canPrevious)}
                      onClick={() => { if (nav && u.canPrevious) onUnresolved(u.id, 'previous'); }}>
                      Inspect previous
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn ghost" style={btn44} disabled={!(nav && rep.pager.canPrevious)}
              onClick={() => { if (nav && rep.pager.canPrevious) onPrevious(); }}>
              Previous page
            </button>
            <span className="hint" style={wrapAnywhere}>{rep.pager.label}</span>
            <button type="button" className="btn ghost" style={btn44} disabled={!(nav && rep.pager.canNext)}
              onClick={() => { if (nav && rep.pager.canNext) onNext(); }}>
              Next page
            </button>
          </div>

          <details style={{ minWidth: 0 }}>
            <summary style={summary44}>Selection details</summary>
            <div className="stack" style={{ minWidth: 0 }}>
              <span className="hint" style={wrapAnywhere}>{rep.snapshotLabel}</span>
              <span className="hint" style={wrapAnywhere}>{rep.groupingLabel}</span>
              <span className="hint" style={wrapAnywhere}>{rep.appliedFiltersLabel}</span>
              <span className="hint" style={wrapAnywhere}>{rep.measurementLabel}</span>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
