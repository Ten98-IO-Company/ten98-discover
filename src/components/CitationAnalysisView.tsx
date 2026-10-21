import { useState } from 'react';
import { Alert, Card, DataTable, EvidenceDetail, Sparkline, Stack, Tabs } from '@ten98/ui';
import type {WorkspaceRole} from '@ten98/runtime';

export type CitationPeriod = 'current' | 'previous';
export type CitationGrouping = 'retained-fragment-v1' | 'elmo-url-v1';
export type CitationReportView = 'urls' | 'domains' | 'categories' | 'page-types' | 'daily' | 'changes';
export type CitationPublisherCategory = 'editorial' | 'reviews' | 'ecommerce' | 'social' | 'developer' | 'pr' | 'reference' | 'institutional' | 'other';
export type CitationPageType = 'homepage' | 'article' | 'listicle' | 'howto' | 'comparison' | 'review' | 'product' | 'doc' | 'forum' | 'video' | 'info' | 'search' | 'shopping' | 'other';
export type CitationSourceType = 'publisher' | 'google_shopping' | 'google_search' | 'google_wrapper' | 'unclassified';
export type CitationOwnershipFilter = 'untracked' | 'brand' | 'competitor' | 'ambiguous';
export type CitationChangeKind = 'newly_observed' | 'fewer_citations' | 'not_observed_now' | 'annotation_title_changed';
export type CitationTaskKind = 'brand' | 'existing-competitor' | 'new-competitor' | 'category';
export type CitationOption = { id: string; label: string };
type CitationCountsText = { answers: string; annotations: string; prompts: string };
type CitationPager = { label: string; canPrevious: boolean; canNext: boolean };
export type CitationFilterDraft = {
  grouping: CitationGrouping; query: string;
  ownership: CitationOwnershipFilter | 'all'; entityId: string;
  publisherCategory: CitationPublisherCategory | 'all';
  pageType: CitationPageType | 'all'; sourceType: CitationSourceType | 'all';
};
export type CitationTaskDraft = {
  kind: CitationTaskKind; competitorId: string; competitorName: string;
  publisherCategory: CitationPublisherCategory | 'automatic';
};
export type CitationHeader = {
  scopeLabel: string; snapshotLabel: string; groupingLabel: string;
  appliedFiltersLabel: string; measurementLabel: string; filterScopeLabel: string;
  warnings: string[]; overlapLabel: string;
  periods: { id: CitationPeriod; label: string; range: string; eligibleAnswers: string;
    citingAnswers: string; annotations: string; uniqueUrls: string; uniqueDomains: string;
    coverage: string }[];
};
export type CitationAggregateRow = {
  id: string; label: string; safeHref: string | null; details: string[];
  current: CitationCountsText; previous: CitationCountsText;
  currentFacets: string[]; previousFacets: string[];
  canCurrentEvidence: boolean; canPreviousEvidence: boolean; canTrack: boolean;
};
export type CitationCarriedScreen = {
  dates: string[]; observedDays: number;
  groups: { id: string; label: string; rows: { id: string; label: string; values: number[]; latest: string; average: string }[] }[];
};
export type CitationReportScreen = {
  kind: 'report'; header: CitationHeader; view: CitationReportView;
  draft: CitationFilterDraft; dirty: boolean; canApply: boolean;
  entities: CitationOption[];
  ownershipOptions: { id: CitationOwnershipFilter | 'all'; label: string }[];
  publisherOptions: { id: CitationPublisherCategory | 'all'; label: string }[];
  pageTypeOptions: { id: CitationPageType | 'all'; label: string }[];
  sourceTypeOptions: { id: CitationSourceType | 'all'; label: string }[];
  changeKind: CitationChangeKind | 'all'; changesStatusLabel: string;
  changeOptions: { id: CitationChangeKind | 'all'; label: string }[];
  emptyMessage: string; pager: CitationPager | null;
  rows: CitationAggregateRow[];
  pageTypes: { id: CitationPageType; label: string; current: CitationCountsText;
    previous: CitationCountsText; canExplore: boolean }[];
  /** Elmo-method carried source trends; null when the response lacked a valid carried block. */
  carried?: CitationCarriedScreen | null;
  daily: { id: string; periodLabel: string; dateLabel: string; eligibleAnswers: string;
    citingAnswers: string; annotations: string; coverage: string; facets: string[] }[];
  changes: { id: string; kindLabel: string; targetLabel: string; label: string;
    current: CitationCountsText; previous: CitationCountsText;
    beforeTitle: string | null; afterTitle: string | null;
    provenance: string; availability: string;
    canCurrentEvidence: boolean; canPreviousEvidence: boolean }[];
};
export type CitationEvidenceScreen = {
  kind: 'evidence'; header: CitationHeader; sourceLabel: string;
  period: CitationPeriod; periodLabel: string; evidenceLabel: string;
  emptyMessage: string; pager: CitationPager;
  rows: { id: string; requestedAt: string; model: string; promptLabel: string;
    retainedUrl: string; safeHref: string | null; retainedTitle: string | null;
    retainedOrder: string; groupedUrl: string; provenance: string; availability: string;
    owners: string[]; ambiguityLabel: string | null;
    publisherLabel: string; pageTypeLabel: string; sourceTypeLabel: string;
    canOpenComparison: boolean; canTrack: boolean }[];
};
export type CitationTaskScreen = {
  kind: 'task'; host: string; owners: string[]; ambiguityLabel: string | null;
  classificationLabel: string; automaticCategoryLabel: string;
  trackingScopeLabel: string; overrideScopeLabel: string;
  draft: CitationTaskDraft; dirty: boolean; conflict: boolean;
  actions: { id: CitationTaskKind; label: string; disabled: boolean }[];
  competitors: CitationOption[];
  categories: { id: CitationPublisherCategory | 'automatic'; label: string }[];
  help: string; canSave: boolean; canCancel: boolean; saveLabel: string;
};
export type CitationAnalysisViewProps = {
  prefix: string; role: WorkspaceRole | null;
  reading: boolean; exporting: boolean; writeState: 'idle' | 'saving' | 'unknown';
  error: string | null; notice: string | null;
  backLabel: string; reloadLabel: string; canLeave: boolean; canReload: boolean;
  canExport: boolean; canRetrySameRequest: boolean;
  screen: CitationReportScreen | CitationEvidenceScreen | CitationTaskScreen | null;
  onBack: () => void; onReload: () => void;
  onExport: () => void; onCancelExport: () => void; onRetrySameRequest: () => void;
  onFiltersChange: (next: CitationFilterDraft) => void; onApplyFilters: () => void;
  onViewChange: (view: CitationReportView) => void;
  onChangeKind: (kind: CitationChangeKind | 'all') => void;
  onExplorePageType: (pageType: CitationPageType) => void;
  onOpenEvidence: (rowId: string, period: CitationPeriod) => void;
  onEvidencePeriod: (period: CitationPeriod) => void;
  onPrevious: () => void; onNext: () => void;
  onOpenComparison: (evidenceId: string) => void; onTrack: (rowId: string) => void;
  onTaskChange: (next: CitationTaskDraft) => void;
  onSaveTask: () => void; onCancelTask: () => void;
};

const controlStyle = { minHeight: 44, minWidth: 0, width: '100%' } as const;
const buttonStyle = { minHeight: 44 } as const;
const blockStyle = { display: 'block' } as const;
const actionColumnStyle = { display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'stretch' } as const;

function CountsTextCell({ counts }: { counts: CitationCountsText }) {
  return (
    <span>
      <span style={blockStyle}>Answers: {counts.answers}</span>
      <span style={blockStyle}>Annotation occurrences: {counts.annotations}</span>
      <span style={blockStyle}>Prompts: {counts.prompts}</span>
    </span>
  );
}

function RetainedTitleText({ title }: { title: string | null }) {
  return <span>{title === null ? 'No retained title' : title === '' ? 'Empty retained title' : title}</span>;
}

function ExternalTextLink({ href, label }: { href: string | null; label: string }) {
  if (href === null) return <span>{label}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
}

function PagerControls({ pager, disabled, onPrevious, onNext }: { pager: CitationPager; disabled: boolean; onPrevious: () => void; onNext: () => void }) {
  return (
    <div className="row between" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
      <button type="button" className="btn ghost" style={buttonStyle} disabled={disabled || !pager.canPrevious} onClick={() => { if (!disabled && pager.canPrevious) onPrevious(); }}>Previous page</button>
      <span>{pager.label}</span>
      <button type="button" className="btn ghost" style={buttonStyle} disabled={disabled || !pager.canNext} onClick={() => { if (!disabled && pager.canNext) onNext(); }}>Next page</button>
    </div>
  );
}

function HeaderSummary({ header }: { header: CitationHeader }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--color-text)' }}>{header.scopeLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.appliedFiltersLabel}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1) var(--space-4)' }}>
        <p className="hint" style={{ margin: 0 }}>{header.snapshotLabel}</p>
        <p className="hint" style={{ margin: 0 }}>{header.groupingLabel}</p>
      </div>
      <p className="hint" style={{ margin: 0 }}>{header.measurementLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.filterScopeLabel}</p>
      <p className="hint" style={{ margin: 0 }}>{header.overlapLabel}</p>
      <p className="hint" style={{ margin: 0 }}>Classified using current project context; historical ownership was not captured.</p>
      {header.warnings.map((warning, index) => (
        <p key={index} className="alert" style={{ margin: 0 }}>{warning}</p>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 'var(--space-3)' }}>
        {header.periods.map((period) => (
          <section key={period.id} style={{ minWidth: 0, borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: 'var(--space-3)' }}>
            <h3 style={{ margin: 0 }}>{period.label}</h3>
            <p className="hint" style={{ margin: 0 }}>{period.range}</p>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))', gap: 'var(--space-2)', margin: 0, marginBlockStart: 'var(--space-2)' }}>
              <div style={{ minWidth: 0 }}>
                <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Eligible answers:</dt>
                <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{period.eligibleAnswers}</dd>
              </div>
              <div style={{ minWidth: 0 }}>
                <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Answers with citations:</dt>
                <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{period.citingAnswers}</dd>
              </div>
              <div style={{ minWidth: 0 }}>
                <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Annotation occurrences:</dt>
                <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{period.annotations}</dd>
              </div>
              <div style={{ minWidth: 0 }}>
                <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Unique grouped URLs:</dt>
                <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{period.uniqueUrls}</dd>
              </div>
              <div style={{ minWidth: 0 }}>
                <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>Unique domains:</dt>
                <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{period.uniqueDomains}</dd>
              </div>
            </dl>
            <p style={{ margin: 0, marginBlockStart: 'var(--space-2)' }}>Coverage: {period.coverage}</p>
          </section>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>Answers in selected date/model/prompt/tag scope</p>
    </div>
  );
}

function AggregateTable({ screen, props, steady, writer }: { screen: CitationReportScreen; props: CitationAnalysisViewProps; steady: boolean; writer: boolean }) {
  if (screen.rows.length === 0) return <p>{screen.emptyMessage}</p>;
  const caption = screen.view === 'domains' ? 'Citations by domain' : screen.view === 'categories' ? 'Citations by publisher category' : 'Citations by grouped URL';
  return (
    <div role="region" aria-label="Citation sources" tabIndex={0} style={{ overflowX: 'auto' }}>
      <table className="table" style={{ minWidth: 1000 }}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col" style={{ minWidth: 260 }}>Source</th>
            <th scope="col" style={{ minWidth: 160 }}>Current period</th>
            <th scope="col" style={{ minWidth: 160 }}>Previous period</th>
            <th scope="col" style={{ minWidth: 220 }}>Classification and ownership</th>
            <th scope="col" style={{ minWidth: 190 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {screen.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <ExternalTextLink href={row.safeHref} label={row.label} />
                {row.details.map((detail, index) => (
                  <span key={index} className="hint" style={blockStyle}>{detail}</span>
                ))}
              </td>
              <td><CountsTextCell counts={row.current} /></td>
              <td><CountsTextCell counts={row.previous} /></td>
              <td>
                <span className="hint" style={blockStyle}>Current period facets</span>
                {row.currentFacets.map((facet, index) => (
                  <span key={index} style={blockStyle}>{facet}</span>
                ))}
                <span className="hint" style={blockStyle}>Previous period facets</span>
                {row.previousFacets.map((facet, index) => (
                  <span key={index} style={blockStyle}>{facet}</span>
                ))}
              </td>
              <td>
                <div style={actionColumnStyle}>
                  <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Current evidence for ' + row.label} disabled={!steady || !row.canCurrentEvidence} onClick={() => { if (steady && row.canCurrentEvidence) props.onOpenEvidence(row.id, 'current'); }}>Current evidence</button>
                  <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Previous evidence for ' + row.label} disabled={!steady || !row.canPreviousEvidence} onClick={() => { if (steady && row.canPreviousEvidence) props.onOpenEvidence(row.id, 'previous'); }}>Previous evidence</button>
                  {writer && (
                    <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Track or classify ' + row.label} disabled={!steady || !row.canTrack} onClick={() => { if (steady && writer && row.canTrack) props.onTrack(row.id); }}>Track or classify</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PageTypeTable({ screen, props, steady }: { screen: CitationReportScreen; props: CitationAnalysisViewProps; steady: boolean }) {
  if (screen.pageTypes.length === 0) return <p>{screen.emptyMessage}</p>;
  return (
    <div role="region" aria-label="Citations by page type" tabIndex={0} style={{ overflowX: 'auto' }}>
      <table className="table" style={{ minWidth: 760 }}>
        <caption>Citations by page type</caption>
        <thead>
          <tr>
            <th scope="col" style={{ minWidth: 260 }}>Page type</th>
            <th scope="col" style={{ minWidth: 160 }}>Current period</th>
            <th scope="col" style={{ minWidth: 160 }}>Previous period</th>
            <th scope="col" style={{ minWidth: 190 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {screen.pageTypes.map((row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td><CountsTextCell counts={row.current} /></td>
              <td><CountsTextCell counts={row.previous} /></td>
              <td>
                <div style={actionColumnStyle}>
                  <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Apply page type ' + row.label + ' and open URLs'} disabled={!steady || !row.canExplore} onClick={() => { if (steady && row.canExplore) props.onExplorePageType(row.id); }}>Apply page type and open URLs</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Elmo-method carried values: presentation only, composed from shared UI components. */
function CarriedPanel({ carried }: { carried: CitationCarriedScreen | null }) {
  if (carried === null) return <Alert title="Carried trends unavailable" tone="warning">This report did not include carried source trends. Reload citations.</Alert>;
  const last = carried.dates.at(-1);
  return <>
    <Alert title="Carried values (Elmo method)" tone="info">Each prompt's last eligible citation counts are carried across days it did not run, and its earliest answer seeds earlier days. {carried.observedDays} of {carried.dates.length} days have an actual eligible answer. Carried values are estimates, not observations; Observed days shows only what ran.</Alert>
    {carried.groups.map((group) => (
      <Card key={group.id} title={group.label} description={`Carried citation annotations per day, ${carried.dates[0]} to ${last}.`}>
        <DataTable<CitationCarriedScreen['groups'][number]['rows'][number]> caption={`Carried ${group.label.toLowerCase()}`} rowKey={(row) => row.id} pageSize={10}
          columns={[{ key: 'label', header: 'Source' }, { key: 'values', header: 'Trend', render: (row) => <Sparkline values={row.values} label={`Carried ${row.label} from ${carried.dates[0]} to ${last}`} /> }, { key: 'latest', header: 'Last day' }, { key: 'average', header: 'Daily average' }]}
          rows={group.rows} />
      </Card>
    ))}
  </>;
}

/** Only the selected basis mounts, and the switch is locked while a read or export is busy. */
function DailyBasis({ screen, steady }: { screen: CitationReportScreen; steady: boolean }) {
  const [basis, setBasis] = useState<'observed' | 'carried'>('observed');
  return (
    <Stack as="fieldset" {...{ disabled: !steady }}>
      <Tabs label="Daily citation basis" value={basis} onValueChange={(value) => { if (steady && (value === 'observed' || value === 'carried')) setBasis(value); }} items={[
        { value: 'observed', label: 'Observed days', content: basis !== 'observed' ? null : <DailyTable screen={screen} /> },
        { value: 'carried', label: 'Carried values (Elmo)', content: basis !== 'carried' ? null : <CarriedPanel carried={screen.carried ?? null} /> },
      ]} />
    </Stack>
  );
}

function DailyTable({ screen }: { screen: CitationReportScreen }) {
  if (screen.daily.length === 0) return <p>{screen.emptyMessage}</p>;
  return (
    <div role="region" aria-label="Daily citation observations" tabIndex={0} style={{ overflowX: 'auto' }}>
      <table className="table" style={{ minWidth: 900 }}>
        <caption>Daily observations</caption>
        <thead>
          <tr>
            <th scope="col" style={{ minWidth: 150 }}>Period</th>
            <th scope="col" style={{ minWidth: 120 }}>Date</th>
            <th scope="col" style={{ minWidth: 150 }}>Eligible answers</th>
            <th scope="col" style={{ minWidth: 150 }}>Answers with citations</th>
            <th scope="col" style={{ minWidth: 150 }}>Annotation occurrences</th>
            <th scope="col" style={{ minWidth: 220 }}>Coverage / facets</th>
          </tr>
        </thead>
        <tbody>
          {screen.daily.map((row) => (
            <tr key={row.id}>
              <td>{row.periodLabel}</td>
              <td>{row.dateLabel}</td>
              <td>{row.eligibleAnswers}</td>
              <td>{row.citingAnswers}</td>
              <td>{row.annotations}</td>
              <td>
                <span style={blockStyle}>{row.coverage}</span>
                {row.facets.map((facet, index) => (
                  <span key={index} className="hint" style={blockStyle}>{facet}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangesTable({ screen, props, steady }: { screen: CitationReportScreen; props: CitationAnalysisViewProps; steady: boolean }) {
  if (screen.changes.length === 0) return <p>{screen.emptyMessage}</p>;
  return (
    <div role="region" aria-label="Citation changes" tabIndex={0} style={{ overflowX: 'auto' }}>
      <table className="table" style={{ minWidth: 1000 }}>
        <caption>Period changes</caption>
        <thead>
          <tr>
            <th scope="col" style={{ minWidth: 260 }}>Source</th>
            <th scope="col" style={{ minWidth: 160 }}>Current period</th>
            <th scope="col" style={{ minWidth: 160 }}>Previous period</th>
            <th scope="col" style={{ minWidth: 220 }}>Classification and ownership</th>
            <th scope="col" style={{ minWidth: 190 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {screen.changes.map((row) => (
            <tr key={row.id}>
              <td>
                <span style={blockStyle}>{row.kindLabel}</span>
                <span style={blockStyle}>{row.targetLabel}</span>
                <span style={blockStyle}>{row.label}</span>
                <span style={blockStyle}>Previously retained title: <RetainedTitleText title={row.beforeTitle} /></span>
                <span style={blockStyle}>Currently retained title: <RetainedTitleText title={row.afterTitle} /></span>
              </td>
              <td><CountsTextCell counts={row.current} /></td>
              <td><CountsTextCell counts={row.previous} /></td>
              <td>
                <span style={blockStyle}>{row.availability}</span>
                <details>
                  <summary>Provenance</summary>
                  {row.provenance}
                </details>
              </td>
              <td>
                <div style={actionColumnStyle}>
                  <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Current evidence for ' + row.label} disabled={!steady || !row.canCurrentEvidence} onClick={() => { if (steady && row.canCurrentEvidence) props.onOpenEvidence(row.id, 'current'); }}>Current evidence</button>
                  <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Previous evidence for ' + row.label} disabled={!steady || !row.canPreviousEvidence} onClick={() => { if (steady && row.canPreviousEvidence) props.onOpenEvidence(row.id, 'previous'); }}>Previous evidence</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportSection({ screen, props, ready, writer }: { screen: CitationReportScreen; props: CitationAnalysisViewProps; ready: boolean; writer: boolean }) {
  const steady = ready && !screen.dirty;
  const draft = screen.draft;
  const applyAllowed = ready && screen.canApply;
  return (
    <>
      <HeaderSummary header={screen.header} />
      <div className="row between" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>View</span>
          <select style={controlStyle} value={screen.view} disabled={!steady} onChange={(event) => { if (steady) props.onViewChange(event.currentTarget.value as CitationReportView); }}>
            <option value="urls">URLs</option>
            <option value="domains">Domains</option>
            <option value="categories">Publisher categories</option>
            <option value="page-types">Page types</option>
            <option value="daily">Daily observations</option>
            <option value="changes">Period changes</option>
          </select>
        </label>
        {screen.view === 'changes' && (
          <label className="field" style={{ margin: 0 }}>
            <span>Change</span>
            <select style={controlStyle} value={screen.changeKind} disabled={!steady} onChange={(event) => { if (steady) props.onChangeKind(event.currentTarget.value as CitationChangeKind | 'all'); }}>
              {screen.changeOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {screen.view === 'changes' && <p className="hint">{screen.changesStatusLabel}</p>}
      <details open={screen.dirty}>
        <summary>Source filters</summary>
        <form onSubmit={(event) => { event.preventDefault(); if (applyAllowed) props.onApplyFilters(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 'var(--space-3)', alignItems: 'start', marginBlockStart: 'var(--space-3)' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>URL grouping</span>
          <select style={controlStyle} value={draft.grouping} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, grouping: event.currentTarget.value as CitationGrouping }); }}>
            <option value="retained-fragment-v1">Retained URLs (ignore fragments)</option>
            <option value="elmo-url-v1">Elmo URL grouping</option>
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>Source query</span>
          <input style={controlStyle} value={draft.query} maxLength={200} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, query: event.currentTarget.value }); }} />
          <span className="hint">Search retained URLs, hosts and titles.</span>
        </label>
        <details>
          <summary>More source filters</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 'var(--space-3)' }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Ownership</span>
              <select style={controlStyle} value={draft.ownership} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, ownership: event.currentTarget.value as CitationOwnershipFilter | 'all' }); }}>
                {screen.ownershipOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Tracked entity</span>
              <select style={controlStyle} value={draft.entityId} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, entityId: event.currentTarget.value }); }}>
                {screen.entities.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Publisher category</span>
              <select style={controlStyle} value={draft.publisherCategory} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, publisherCategory: event.currentTarget.value as CitationPublisherCategory | 'all' }); }}>
                {screen.publisherOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Page type</span>
              <select style={controlStyle} value={draft.pageType} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, pageType: event.currentTarget.value as CitationPageType | 'all' }); }}>
                {screen.pageTypeOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Source type</span>
              <select style={controlStyle} value={draft.sourceType} disabled={!ready} onChange={(event) => { if (ready) props.onFiltersChange({ ...draft, sourceType: event.currentTarget.value as CitationSourceType | 'all' }); }}>
                {screen.sourceTypeOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <button type="submit" className="btn" style={buttonStyle} disabled={!applyAllowed}>Apply source filters</button>
        </form>
      </details>
      <p className="hint">Grouping changes which retained URLs are counted together. Evidence preserves the retained URL and title. Neither mode fetches a page.</p>
      {screen.dirty && <p className="hint">Unapplied source filters. The report still uses the applied selection.</p>}
      {screen.view === 'daily' ? (
        <DailyBasis screen={screen} steady={steady} />
      ) : screen.view === 'page-types' ? (
        <PageTypeTable screen={screen} props={props} steady={steady} />
      ) : screen.view === 'changes' ? (
        <ChangesTable screen={screen} props={props} steady={steady} />
      ) : (
        <AggregateTable screen={screen} props={props} steady={steady} writer={writer} />
      )}
      {screen.pager !== null && (
        <PagerControls pager={screen.pager} disabled={!steady} onPrevious={props.onPrevious} onNext={props.onNext} />
      )}
    </>
  );
}

function EvidenceSection({ screen, props, ready, writer }: { screen: CitationEvidenceScreen; props: CitationAnalysisViewProps; ready: boolean; writer: boolean }) {
  return (
    <>
      <HeaderSummary header={screen.header} />
      <div className="row between" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end' }}>
        <div style={{ minWidth: 0 }}>
          <p className="hint" style={{ margin: 0 }}>{screen.sourceLabel}</p>
          <p className="hint" style={{ margin: 0 }}>{screen.evidenceLabel}</p>
          <p className="hint" style={{ margin: 0 }}>{screen.periodLabel}</p>
        </div>
        <label className="field" style={{ margin: 0 }}>
          <span>Evidence period</span>
          <select style={controlStyle} value={screen.period} disabled={!ready} onChange={(event) => { if (ready) props.onEvidencePeriod(event.currentTarget.value as CitationPeriod); }}>
            {screen.header.periods.map((period) => (
              <option key={period.id} value={period.id}>{period.label}</option>
            ))}
          </select>
        </label>
      </div>
      <EvidenceDetail
        label="Retained citation annotations"
        scope={<span>{screen.sourceLabel} · {screen.periodLabel}</span>}
        provenance="Verified retained annotation metadata. Answer content loads only when you explicitly open a comparison; row availability describes each retained answer receipt."
        availability={screen.rows.length === 0 ? 'empty' : 'ready'}
        message={screen.rows.length === 0 ? screen.emptyMessage : 'Retained annotations are available below. This does not mean answer content is loaded or that every answer receipt is still available.'}
      >
        <div role="region" aria-label="Citation evidence rows" tabIndex={0} style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 1040 }}>
            <caption>Citation evidence</caption>
            <thead>
              <tr>
                <th scope="col" style={{ minWidth: 210 }}>Answer</th>
                <th scope="col" style={{ minWidth: 260 }}>Retained citation</th>
                <th scope="col" style={{ minWidth: 220 }}>Classification</th>
                <th scope="col" style={{ minWidth: 190 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {screen.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span style={blockStyle}>{row.requestedAt}</span>
                    <span style={blockStyle}>{row.model}</span>
                    <span style={blockStyle}>{row.promptLabel}</span>
                    <span className="hint" style={blockStyle}>{row.availability}</span>
                  </td>
                  <td>
                    <ExternalTextLink href={row.safeHref} label={row.retainedUrl} />
                    <span style={blockStyle}><RetainedTitleText title={row.retainedTitle} /></span>
                    <span style={blockStyle}>Retained annotation order: {row.retainedOrder}</span>
                    <span style={blockStyle}>{row.groupedUrl}</span>
                    <details>
                      <summary>Provenance</summary>
                      {row.provenance}
                    </details>
                  </td>
                  <td>
                    <span style={blockStyle}>{row.publisherLabel}</span>
                    <span style={blockStyle}>{row.pageTypeLabel}</span>
                    <span style={blockStyle}>{row.sourceTypeLabel}</span>
                    {row.owners.length === 0 ? (
                      <span style={blockStyle}>Not tracked</span>
                    ) : (
                      row.owners.map((owner, index) => (
                        <span key={index} style={blockStyle}>{owner}</span>
                      ))
                    )}
                    {row.ambiguityLabel !== null && <span className="hint" style={blockStyle}>{row.ambiguityLabel}</span>}
                  </td>
                  <td>
                    <div style={actionColumnStyle}>
                      <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Open comparison for ' + row.model + ' answer at ' + row.requestedAt} disabled={!ready || !row.canOpenComparison} onClick={() => { if (ready && row.canOpenComparison) props.onOpenComparison(row.id); }}>Open comparison</button>
                      {writer && (
                        <button type="button" className="btn ghost" style={buttonStyle} aria-label={'Track or classify ' + row.retainedUrl} disabled={!ready || !row.canTrack} onClick={() => { if (ready && writer && row.canTrack) props.onTrack(row.id); }}>Track or classify</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </EvidenceDetail>
      <PagerControls pager={screen.pager} disabled={!ready} onPrevious={props.onPrevious} onNext={props.onNext} />
    </>
  );
}

function TaskSection({ screen, props, ready, writer, idle, canLeave }: { screen: CitationTaskScreen; props: CitationAnalysisViewProps; ready: boolean; writer: boolean; idle: boolean; canLeave: boolean }) {
  const draft = screen.draft;
  const editAllowed = ready && writer;
  const selectedActionEnabled = screen.actions.some(action => action.id === draft.kind && !action.disabled);
  const fieldEditAllowed = editAllowed && selectedActionEnabled;
  const saveAllowed = fieldEditAllowed && screen.canSave && !screen.conflict;
  const cancelAllowed = screen.canCancel && canLeave && idle;
  return (
    <>
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0 }}>{screen.host}</p>
        {screen.owners.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>Not tracked</p>
        ) : (
          screen.owners.map((owner, index) => (
            <p key={index} className="hint" style={{ margin: 0 }}>{owner}</p>
          ))
        )}
        {screen.ambiguityLabel !== null && <p className="hint" style={{ margin: 0 }}>{screen.ambiguityLabel}</p>}
        <p className="hint" style={{ margin: 0 }}>{screen.classificationLabel}</p>
        <p className="hint" style={{ margin: 0 }}>{screen.automaticCategoryLabel}</p>
      </div>
      <p>Tracking changes current-context attribution of retained answers. It does not verify ownership, fetch the domain or configure serving domains.</p>
      {!writer ? (
        <p>Your current role can view citations. Editing project context requires an editor, admin or owner.</p>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); if (saveAllowed) props.onSaveTask(); }} style={{ display: 'grid', gap: '0.75rem', maxWidth: 560 }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Action</span>
            <select style={controlStyle} value={draft.kind} disabled={!editAllowed} onChange={(event) => { if (editAllowed && screen.actions.some(action => action.id === event.currentTarget.value && !action.disabled)) props.onTaskChange({ ...draft, kind: event.currentTarget.value as CitationTaskKind }); }}>
              {screen.actions.map((action) => (
                <option key={action.id} value={action.id} disabled={action.disabled}>{action.label}</option>
              ))}
            </select>
          </label>
          {draft.kind === 'brand' && <p className="hint" style={{ margin: 0 }}>{screen.trackingScopeLabel}</p>}
          {draft.kind === 'existing-competitor' && (
            <>
              <label className="field" style={{ margin: 0 }}>
                <span>Competitor</span>
                <select style={controlStyle} required value={draft.competitorId} disabled={!fieldEditAllowed} onChange={(event) => { if (fieldEditAllowed) props.onTaskChange({ ...draft, competitorId: event.currentTarget.value }); }}>
                  <option value="">Choose a competitor</option>
                  {screen.competitors.map((competitor) => (
                    <option key={competitor.id} value={competitor.id}>{competitor.label}</option>
                  ))}
                </select>
              </label>
              <p className="hint" style={{ margin: 0 }}>{screen.trackingScopeLabel}</p>
            </>
          )}
          {draft.kind === 'new-competitor' && (
            <>
              <label className="field" style={{ margin: 0 }}>
                <span>Competitor name</span>
                <input style={controlStyle} required maxLength={120} value={draft.competitorName} disabled={!fieldEditAllowed} onChange={(event) => { if (fieldEditAllowed) props.onTaskChange({ ...draft, competitorName: event.currentTarget.value }); }} />
              </label>
              <p className="hint" style={{ margin: 0 }}>{screen.trackingScopeLabel}</p>
            </>
          )}
          {draft.kind === 'category' && (
            <>
              <label className="field" style={{ margin: 0 }}>
                <span>Publisher category</span>
                <select style={controlStyle} required value={draft.publisherCategory} disabled={!fieldEditAllowed} onChange={(event) => { if (fieldEditAllowed) props.onTaskChange({ ...draft, publisherCategory: event.currentTarget.value as CitationPublisherCategory | 'automatic' }); }}>
                  {screen.categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.label}</option>
                  ))}
                </select>
              </label>
              <p className="hint" style={{ margin: 0 }}>{screen.overrideScopeLabel}</p>
              <p className="hint" style={{ margin: 0 }}>{screen.automaticCategoryLabel}</p>
            </>
          )}
          <p className="hint" style={{ margin: 0 }}>{screen.help}</p>
          {screen.conflict && (
            <p role="alert" className="alert" style={{ margin: 0 }}>Project context changed. Reload context and review your changes before saving.</p>
          )}
          {screen.dirty && <p className="hint" style={{ margin: 0 }}>Unsaved domain changes.</p>}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn" style={buttonStyle} disabled={!saveAllowed}>{screen.saveLabel}</button>
            <button type="button" className="btn ghost" style={buttonStyle} disabled={!cancelAllowed} onClick={() => { if (cancelAllowed) props.onCancelTask(); }}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

export function CitationAnalysisView(props: CitationAnalysisViewProps) {
  const idle = props.writeState === 'idle';
  const known = props.role !== null;
  const writer = props.role === 'owner' || props.role === 'admin' || props.role === 'editor';
  const ready = known && idle && !props.reading && !props.exporting;
  const screen = known ? props.screen : null;
  const reportDirty = screen !== null && screen.kind === 'report' && screen.dirty;
  const steady = ready && !reportDirty;
  const backAllowed = props.canLeave && idle;
  const reloadAllowed = props.canReload && idle && !props.exporting;
  const cancelExportAllowed = props.exporting && idle;
  const exportVisible = screen !== null && screen.kind !== 'task';
  const exportAllowed = steady && props.canExport && exportVisible;
  const retryAllowed = writer && props.writeState === 'unknown' && props.canRetrySameRequest && !props.reading && !props.exporting;
  const heading = screen === null || screen.kind === 'report' ? 'Citations' : screen.kind === 'evidence' ? 'Citation evidence' : 'Track or classify domain';
  return (
    <section className="research-panel stack" aria-labelledby={props.prefix + 'heading'} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
        <h2 id={props.prefix + 'heading'} tabIndex={-1} style={{ margin: 0, marginInlineEnd: 'auto' }}>{heading}</h2>
        <button type="button" className="btn ghost" style={buttonStyle} disabled={!backAllowed} onClick={() => { if (backAllowed) props.onBack(); }}>{props.backLabel}</button>
        <button type="button" className="btn ghost" style={buttonStyle} disabled={!reloadAllowed} onClick={() => { if (reloadAllowed) props.onReload(); }}>{props.reloadLabel}</button>
        {exportVisible && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {props.exporting ? (
              <button type="button" className="btn ghost" style={buttonStyle} disabled={!cancelExportAllowed} onClick={() => { if (cancelExportAllowed) props.onCancelExport(); }}>Cancel export</button>
            ) : (
              <button type="button" className="btn" style={buttonStyle} disabled={!exportAllowed} onClick={() => { if (exportAllowed) props.onExport(); }}>Export full analysis CSV</button>
            )}
          </div>
        )}
      </div>
      {exportVisible && (
        <p className="hint">Exports the full applied analysis, including both periods. Table pages and evidence selection do not limit the CSV.</p>
      )}
      {props.error !== null && <p role="alert" className="alert">{props.error}</p>}
      {props.notice !== null && <p role="status">{props.notice}</p>}
      {props.reading && <p role="status">Loading citations…</p>}
      {props.writeState === 'saving' && <p role="status">Saving changes…</p>}
      {props.exporting && <p role="status">Preparing full citation CSV…</p>}
      {writer && props.writeState === 'unknown' && (
        <div className="alert">
          <p>The save may have completed. Retry the same request to recover its result.</p>
          <button type="button" className="btn" style={buttonStyle} disabled={!retryAllowed} onClick={() => { if (retryAllowed) props.onRetrySameRequest(); }}>Retry same request</button>
        </div>
      )}
      {screen !== null && screen.kind === 'report' && (
        <ReportSection screen={screen} props={props} ready={ready} writer={writer} />
      )}
      {screen !== null && screen.kind === 'evidence' && (
        <EvidenceSection screen={screen} props={props} ready={ready} writer={writer} />
      )}
      {screen !== null && screen.kind === 'task' && (
        <TaskSection screen={screen} props={props} ready={ready} writer={writer} idle={idle} canLeave={props.canLeave} />
      )}
    </section>
  );
}
