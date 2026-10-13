# Citation analysis interface

P18 presentation contract for review, not acceptance evidence or V1 parity.
The free/self-hosted app analyzes retained annotations without provider work.

**Analyze citations** opens from AI insights with its applied dates, timezone,
model, prompt and current-tag scope. Back preserves that scope and rereads insights.
Mention matching does not change citation counts. Default **URLs**; other views:
**Domains**, **Publisher categories**, **Page types**, **Daily observations**,
**Period changes**. Show one table. Source → paged evidence → existing comparison
receipt; receipt Back restores citation selection and rereads page one.

Controller owns auth/validation, I/O, calculations/classification, cursors/export,
focus/navigation, CAS and exact-request recovery; it carries expiry across insights/
citations/receipts. Implement only `src/components/CitationAnalysisView.tsx`, semantic
markup and controlled events. Helpers may share that file. No imports/hooks/I/O,
parsing/arithmetic, URL construction, raw HTML, generated IDs, assets or dependencies.
Automatic JSX runtime. Export these types and `CitationAnalysisView(props:
CitationAnalysisViewProps)`.

```tsx
export type CitationPeriod = 'current' | 'previous';
export type CitationGrouping = 'retained-fragment-v1' | 'elmo-url-v1';
export type CitationReportView = 'urls' | 'domains' | 'categories' | 'page-types' | 'daily' | 'changes';
export type CitationPublisherCategory = 'editorial' | 'reviews' | 'ecommerce' | 'social' | 'developer' | 'pr' | 'reference' | 'institutional' | 'other';
export type CitationPageType = 'homepage' | 'article' | 'listicle' | 'howto' | 'comparison' | 'review' | 'product' | 'doc' | 'forum' | 'video' | 'info' | 'search' | 'shopping' | 'other';
export type CitationSourceType = 'publisher' | 'google_shopping' | 'google_search' | 'google_wrapper' | 'unclassified';
export type CitationOwnershipFilter = 'untracked' | 'brand' | 'competitor' | 'ambiguous';
export type CitationChangeKind = 'newly_observed' | 'fewer_citations' | 'not_observed_now' | 'annotation_title_changed';
export type CitationTaskKind = 'brand' | 'existing-competitor' | 'new-competitor' | 'category';
export type CitationOption = {id: string; label: string};
export type CitationCountsText = {answers: string; annotations: string; prompts: string};
export type CitationPager = {label: string; canPrevious: boolean; canNext: boolean};
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
  periods: {id: CitationPeriod; label: string; range: string; eligibleAnswers: string;
    citingAnswers: string; annotations: string; uniqueUrls: string; uniqueDomains: string;
    coverage: string}[];
};
export type CitationAggregateRow = {
  id: string; label: string; safeHref: string | null; details: string[];
  current: CitationCountsText; previous: CitationCountsText;
  currentFacets: string[]; previousFacets: string[];
  canCurrentEvidence: boolean; canPreviousEvidence: boolean; canTrack: boolean;
};
export type CitationReportScreen = {
  kind: 'report'; header: CitationHeader; view: CitationReportView;
  draft: CitationFilterDraft; dirty: boolean; canApply: boolean;
  entities: CitationOption[];
  ownershipOptions: {id: CitationOwnershipFilter | 'all'; label: string}[];
  publisherOptions: {id: CitationPublisherCategory | 'all'; label: string}[];
  pageTypeOptions: {id: CitationPageType | 'all'; label: string}[];
  sourceTypeOptions: {id: CitationSourceType | 'all'; label: string}[];
  changeKind: CitationChangeKind | 'all'; changesStatusLabel: string;
  changeOptions: {id: CitationChangeKind | 'all'; label: string}[];
  emptyMessage: string; pager: CitationPager | null;
  rows: CitationAggregateRow[];
  pageTypes: {id: CitationPageType; label: string; current: CitationCountsText;
    previous: CitationCountsText; canExplore: boolean}[];
  daily: {id: string; periodLabel: string; dateLabel: string; eligibleAnswers: string;
    citingAnswers: string; annotations: string; coverage: string; facets: string[]}[];
  changes: {id: string; kindLabel: string; targetLabel: string; label: string;
    current: CitationCountsText; previous: CitationCountsText;
    beforeTitle: string | null; afterTitle: string | null;
    provenance: string; availability: string;
    canCurrentEvidence: boolean; canPreviousEvidence: boolean}[];
};
export type CitationEvidenceScreen = {
  kind: 'evidence'; header: CitationHeader; sourceLabel: string;
  period: CitationPeriod; periodLabel: string; evidenceLabel: string;
  emptyMessage: string; pager: CitationPager;
  rows: {id: string; requestedAt: string; model: string; promptLabel: string;
    retainedUrl: string; safeHref: string | null; retainedTitle: string | null;
    retainedOrder: string; groupedUrl: string; provenance: string; availability: string;
    owners: string[]; ambiguityLabel: string | null;
    publisherLabel: string; pageTypeLabel: string; sourceTypeLabel: string;
    canOpenComparison: boolean; canTrack: boolean}[];
};
export type CitationTaskScreen = {
  kind: 'task'; host: string; owners: string[]; ambiguityLabel: string | null;
  classificationLabel: string; automaticCategoryLabel: string;
  trackingScopeLabel: string; overrideScopeLabel: string;
  draft: CitationTaskDraft; dirty: boolean; conflict: boolean;
  actions: {id: CitationTaskKind; label: string; disabled: boolean}[];
  competitors: CitationOption[];
  categories: {id: CitationPublisherCategory | 'automatic'; label: string}[];
  help: string; canSave: boolean; canCancel: boolean; saveLabel: string;
};
export type CitationAnalysisViewProps = {
  prefix: string; role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
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
```

Controller maps server data to bounded strings/unique opaque IDs. Only the active
report array is populated; never concatenate arrays. Render supplied strings unchanged.
Mapping arrays to markup, capability/enum checks and controlled object spreads are
allowed. No measurement calculation or sorting.

## Rendering and access

Use existing `research-panel stack`, `row between`, `btn`, `btn ghost`, `field`,
`hint`, `alert`, `table`. One wrapping toolbar, compact scope/coverage block and
one table; no tall repeated cards, chart, hero, stylesheet or dependency. Root
minWidth:0/overflowWrap:anywhere; filter auto-fit grid, fields margin:0 and controls
minWidth:0/width:100%. Keep dates, coverage, counts, grouping and overlap visible;
native details may collapse secondary provenance only.

The h2 is **Citations**, **Citation evidence** or **Track or classify domain**,
id prefix+'heading', tabIndex=-1. Controller focuses after explicit navigation.
Null role shows only generic **Citations**, safe Back/Reload, error/status: suppress
all protected content despite stale props. Viewer reads/exports. Writer means
current owner/admin/editor plus capabilities; never infer access from an old role.

Use supplied Back/Reload labels. Error: plain text role=alert; notice/progress:
role=status. Progress labels: **Loading citations…**, **Saving changes…**,
**Preparing full citation CSV…**. Null screen means unresolved read, not no data.
Every supplied count/date/provenance/facet string renders unchanged. No calculated
rates, sorting, classification, client filtering or inferred zero. IDs are opaque
callback keys, not replacement display labels.

Guard disabled attributes AND handlers, including synthetic submit. Native forms
preventDefault. “Idle” means writeState=idle; “ready” means known role, idle,
neither reading nor exporting:

| Action | Guard |
| --- | --- |
| Back | canLeave and idle; may interrupt read/export |
| Reload | canReload, idle, not exporting; may replace held read |
| Cancel export | exporting and idle, independent of reading |
| Edit source filters | ready |
| Apply source filters | ready and report.canApply |
| View/change-kind/page-type shortcut | ready, report not dirty; shortcut also row.canExplore |
| Evidence/paging/receipt | ready, corresponding capability, report not dirty when on report |
| Export | ready, canExport, report/evidence screen, report not dirty |
| Track | ready, writer, row.canTrack, report not dirty |
| Task edit | ready, writer; Action accepts only enabled options, other fields require selected action enabled |
| Save | ready, writer, selected action enabled, task.canSave, not task.conflict |
| Cancel task | task.canCancel, canLeave, idle; may interrupt context read |
| Retry same request | writer, writeState=unknown, canRetrySameRequest, neither reading nor exporting |

Unknown save: **The save may have completed. Retry the same request to recover its
result.** Show **Retry same request**, disable every other action including Back,
Reload, Cancel and edits. Saving has the same locks without Retry. Never offer a
new request, automatic retry or cancellation of server work. Access-loss purge
wins. Router/beforeunload guards belong to controller, not this leaf.
Known conflict: **Project context changed. Reload context and review your changes
before saving.** Preserve draft, block Save, permit capability-approved Reload/
Cancel. No automatic reset/save. Null role hides even unknown-state retry.

## Report and applied filters

Toolbar: native **View** selector, Back/Reload, **Export full analysis CSV** (during
export replace with **Cancel export**). Caption: **Exports the full applied analysis,
including both periods. Table pages and evidence selection do not limit the CSV.**
Applied source filters DO affect export; controller owns snapshot validation,
spreadsheet safety and download URLs.

Show scopeLabel, snapshotLabel, appliedFiltersLabel, groupingLabel,
measurementLabel, warnings. State **Classified using current project context;
historical ownership was not captured.** Two compact responsive period blocks show
label/range, **Eligible answers**, **Answers with citations**, **Annotation
occurrences**, **Unique grouped URLs**, **Unique domains**, **Coverage**.
Eligible caption: **Answers in selected date/model/prompt/tag scope**.
Show overlapLabel/filterScopeLabel beside counts. Source filters change annotations,
not that full answer denominator/eligibility. Row/facet counts may overlap; never sum.

One filters form in EVERY report mode:
- **URL grouping**: retained-fragment-v1 → **Retained URLs (ignore fragments)**;
  elmo-url-v1 → **Elmo URL grouping**.
- **Source query**: draft.query, maxLength=200; hint **Search retained URLs, hosts
  and titles.**
- Native **More source filters** details: **Ownership**, **Tracked entity**,
  **Publisher category**, **Page type**, **Source type**, using supplied option
  labels/counts. entityId='' means All entities and is already in entities.
  Other all-options use 'all'; never duplicate/add options.
- **Apply source filters** explicitly invokes onApplyFilters. onFiltersChange gets
  the complete next draft. Do not relabel old results while editing.

Grouping hint: **Grouping changes which retained URLs are counted together.
Evidence preserves the retained URL and title. Neither mode fetches a page.**
Dirty notice: **Unapplied source filters. The report still uses the applied selection.**
Dirty disables navigation/export. Applied query/grouping/facets affect citation
totals, axes, days, changes and full CSV consistently. Full answer coverage remains,
even with zero matching annotations. Leaf must not clear/apply inputs automatically.

URLs/Domains/Publisher categories table: **Source**, **Current period**,
**Previous period**, **Classification and ownership**, **Actions**.
Count cells label **Answers**, **Annotation occurrences**, **Prompts**. Source shows
label/details; current/prior facets include supplied ownership-kind counts, not a
made-up list of named owners. Aggregates can contain mixed classifications: never
infer one from representative title. Exact identities belong in evidence/task.
**Current evidence** / **Previous evidence** call onOpenEvidence(row.id,period).
Writer **Track or classify** calls onTrack(row.id) if allowed. Controller resolves
host; category/unclassified rows are untrackable. URL canTrack is false unless a
representative retained host is explicitly labelled; grouping may merge hosts.
Never construct a host from the grouped label.

Page types table: **Page type**, **Current period**, **Previous period**, **Actions**.
**Apply page type and open URLs** calls onExplorePageType(id): controller applies
that type to applied filters, resets cursor and rereads URLs; never consumes an
unrelated dirty draft. Daily table: **Period**, **Date**, **Eligible answers**,
**Answers with citations**, **Annotation occurrences**, **Coverage / facets**.
Render supplied order/zero/unavailable days. No gap filling, carried values or
invented trends. These bounded arrays (page-type enum, at most62 days) use pager=null.

Source type is separate from publisher category/ownership. Keep Google shopping/
search/wrapper and unclassified rows by default; only explicit applied filters
narrow them. Publisher is a structural bucket, not verified ownership. No Google
unwrapping, favicon fetch, merchant/product inference or specialized Shopping/Reddit
parity claim. Unclassified remains readable/countable, sometimes untrackable.

## Changes and evidence

Period changes: **Change** select from changeOptions, changesStatusLabel, ranges/
coverage and changes rows. Labels distinguish **Newly observed**, **Fewer citations**,
**Not observed now**, **Annotation title changed**. Display targetLabel (URL/domain),
source, labelled current/prior counts, availability/provenance. Thresholds and
availability are server decisions; do not infer disappearance from missing/expired
evidence. Title changes show **Previously retained title** / **Currently retained
title**: null = **No retained title**, empty string = **Empty retained title**.
These describe annotations, not fetched page edits. Evidence callbacks use ID/period.

Evidence shows sourceLabel, periodLabel, evidenceLabel, shared scope/coverage and
native **Evidence period** (current/previous) calling onEvidencePeriod. Table:
- **Answer**: requestedAt, model, promptLabel, availability. promptLabel may identify
  the prompt/version; no prompt text is promised by this analysis response.
- **Retained citation**: exact retainedUrl/title (null/empty distinction above),
  retainedOrder labelled **Retained annotation order**, groupedUrl, provenance.
- **Classification**: publisherLabel, pageTypeLabel, sourceTypeLabel, owners,
  ambiguityLabel.
- **Actions**: **Open comparison** → onOpenComparison(evidence.id); writer
  **Track or classify** → onTrack(evidence.id), subject to capabilities.
Repeated buttons get distinct accessible names using row source/model context.

Saved order is not search rank, confidence or text offset. Do not invent original
provider bytes, missing snippets/offsets or page titles. Controller maps verified
comparison/prompt IDs, carries expiry and restores source selection on receipt Back;
leaf constructs no receipt IDs/URLs.

Pager: supplied label, **Previous page** / **Next page** with capabilities.
Each response replaces whole page/header, never appends to an older snapshot.
EmptyMessage is a paragraph, not a fake zero row: it distinguishes no retained
eligible answers, answers without annotations, no matching sources, expired
evidence and unavailable changes. Null screen never asserts a loaded empty state.

## Inline domain task

Task replaces table in same panel, no modal/new route. Show plain host, owners,
ambiguityLabel, classificationLabel, automaticCategoryLabel. Explain **Tracking
changes current-context attribution of retained answers. It does not verify
ownership, fetch the domain or configure serving domains.** Keep all matches;
no exclusive winner or ownership transfer.

**Action** select uses supplied actions/disabled flags: **Add to brand**, **Add to
existing competitor**, **Create competitor**, **Set publisher category**.
Viewer with stale task props sees no inputs/save/retry; show **Your current role can
view citations. Editing project context requires an editor, admin or owner.**
and safe navigation.
- Brand: read-only host, trackingScopeLabel.
- Existing competitor: required **Competitor**; competitors contains real choices
  only. Add competitorId='' placeholder **Choose a competitor**, no auto-selection.
  Show trackingScopeLabel.
- New competitor: required **Competitor name**, maxLength=120; read-only host,
  trackingScopeLabel. Do not rewrite Unicode or generate name.
- Category: required **Publisher category** from categories, automatic labelled
  **Use automatic classification**; show overrideScopeLabel/automaticCategoryLabel.
  'other' is authored category; 'automatic' removes override. Never offer brand/
  competitor here. Page type stays a separate heuristic.

Tracking follows supplied domain/subdomain scope; publisher override is exact-host.
Show help/conflict and **Unsaved domain changes.** when dirty. Submit uses saveLabel;
**Cancel** → onCancelTask. onTaskChange gets complete next draft. Changing action
does not clear fields/save; controller supplies next state. Durable request/CAS
recovery is not an optimistic UI success. Gate every action by current role/caps.

## Safety, layout and independent checks

No img/iframe/script/raw HTML. Only supplied non-null safeHref forms a deliberate
external anchor, target=_blank, rel="noopener noreferrer"; controller validates
credential-free HTTPS. Labels/grouped/retained URLs alone are not href authority.
Null safeHref stays text. No fetch/prefetch/favicon/Markdown/automatic navigation.

All controls: explicit labels, visible focus, at least44px height. Tables: caption,
column headers, independent focusable horizontal region with descriptive aria-label.
Readable column minima: source/citation260px, period counts160px, classification220px,
actions190px; daily date120px/count150px; evidence answer210px. Long text wraps within
columns. At360px table may scroll, document must not. Action buttons may wrap, never
be clipped by a flex child. Secondary provenance uses native labelled details.

Independent browser checks: null-role purge/viewer/writer; every callback and
disabled synthetic submit; dirty labels and read/export/write guards including
unknown exact retry/conflict/role loss; exact counts/mixed facets/Google/unclassified/
daily zero versus unavailable; changes/null-empty titles/retained provenance/nested
receipt; tracking scope/category reset/no auto-select; hostile Unicode/long URLs
inert with no outbound traffic. Inspect1440/360 screenshots, keyboard/Enter,44px
targets, readable columns/independent table scroll and no document overflow.

Controller/service acceptance separately proves current auth/stale responses,
same-request replay/CAS, full-population irreversible expiry, nested Back and
same-snapshot CSV. Pure view acceptance proves neither those nor live providers.

Original design, no copied component code: Elmo3c673d0253d01ae030fa41519f62ad7e54f2281b
source tables/changes/tracking; OpenSEO89e5a00717cdf049b7c2b4e29646edb3a7d4995b
distinct-observation rollups. Classifier notices are separate; curated lists stay server-side.
