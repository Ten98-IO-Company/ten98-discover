# Citation analysis contract

> Code and safety contracts retained from [docs/citation-analysis.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/citation-analysis.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/citation-analysis-contract-implementation-history-VWdxJbWSyj). Qualifications are preserved; this adds no acceptance claim.

## Measurement and source boundary

This is a read-only analysis of retained prompt execution annotations, recomputed using current project identities and category overrides. It never fetches a cited page, unwraps a redirect, verifies a domain, submits provider work, or changes a budget. All accepted retained annotations remain accessible, including Google shopping/search/wrapper evidence. No Google surface is silently removed from the default report.

Eligibility is the accepted `retained-nonempty-stop-v1` rule: nonempty retained supported answers finishing with `stop`, independent of the ledger state. Queued/running/missing/empty/truncated/filtered/expired/invalid answers are exclusions, not negative citation observations. Eligible answers with zero annotations are valid zero observations. The date basis is comparison-request local day, not provider response or publication date. Current prompt/tag selection semantics remain the existing insight semantics; disabled prompts' retained answers are included. No invisible enabled-only filter, carried daily values, market inference, historical context, or matched-cell claim.

Each URL/domain/facet count contains distinct eligible execution count, annotation-occurrence count, and distinct prompt count. Domain/facet execution counts are unions, never sums of URL counts. Applied source filters select annotations consistently across summaries, axes, daily observations, groups, changes and CSV. Full answer eligibility coverage, the manifest and eligibleAnswers denominator remain the complete base date/model/prompt/tag selection; an eligible answer with no matching annotation is a valid zero. All rates are matching execution count/eligibleAnswers; a zero denominator is null. Execution rates across categories/hosts can overlap and need not sum to 100%. Annotation counts are explicitly distinct from upstream extractors that deduplicate URLs before saving.

## Exact shared types

```ts
type Role = 'owner'|'admin'|'editor'|'viewer';
type Period = 'current'|'previous';
type UrlGrouping = 'retained-fragment-v1'|'elmo-url-v1';
type PublisherCategory = 'editorial'|'reviews'|'ecommerce'|'social'|'developer'|'pr'|'reference'|'institutional'|'other';
type PageType = 'homepage'|'article'|'listicle'|'howto'|'comparison'|'review'|'product'|'doc'|'forum'|'video'|'info'|'search'|'shopping'|'other';
type SourceType = 'publisher'|'google_shopping'|'google_search'|'google_wrapper'|'unclassified';
type OwnershipKind = 'untracked'|'brand'|'competitor'|'ambiguous';
type CitationOwnership = {brand:boolean;competitorIds:string[];ambiguous:boolean};
type CitationFilters = {
  from:string; to:string; timeZone:string;
  model:string|null; promptId:string|null; tag:string|null;
  urlGrouping:UrlGrouping;
  query:string|null;publisherCategory:PublisherCategory|null;pageType:PageType|null;
  sourceType:SourceType|null;ownership:OwnershipKind|null;entityId:string|null;
};
type CitationCount = {executions:number;annotations:number;prompts:number};
type CitationFacet<K extends string> = {key:K;count:CitationCount};
type CitationPeriod = {
  from:string;to:string;coverage:InsightCoverage;eligibleAnswers:number|null;
  citedExecutions:number;annotations:number;uniqueUrls:number;uniqueDomains:number;
  unclassifiedHostAnnotations:number;
};
type CitationAxes = {
  ownership:CitationFacet<OwnershipKind>[];
  publisher:CitationFacet<PublisherCategory>[];
  pageType:CitationFacet<PageType>[];
  sourceType:CitationFacet<SourceType>[];
};
type CitationDaily = {date:string;period:Period;summary:CitationPeriod;axes:CitationAxes};
type CitationEvidenceState = {id:string;period:Period;eligibility:InsightEligibility};
type CitationClassification = {
  ownership:CitationOwnership;
  publisherCategory:PublisherCategory;
  publisherBasis:'override'|'elmo-automatic'|'unclassified';
  automaticPublisherCategory:PublisherCategory;
  pageType:PageType;pageTypeBasis:'elmo-url-title-heuristic-v1';
  sourceType:SourceType;
};
type CitationEvidence = {
  id:string; // canonical SHA256 of projectId + executionId + retainedCitationIndex
  executionId:string;comparisonId:string;promptId:string;versionId:string;
  requestedAt:string;date:string;period:Period;model:string;
  retainedCitationIndex:number; // integer 0..99; saved-array order, NOT rank or text offset
  retainedUrl:string;retainedTitle:string|null;
  urlId:string;groupedUrl:string;hostname:string|null;
  trackable:boolean;classification:CitationClassification;
};
type CitationAggregatePart = {count:CitationCount;axes:CitationAxes};
type CitationRepresentative = {
  executionId:string;comparisonId:string;retainedCitationIndex:number;
  retainedUrl:string;retainedTitle:string|null;requestedAt:string;
};
type CitationUrlRow = {
  id:string;url:string;
  current:CitationAggregatePart;previous:CitationAggregatePart;
  currentRepresentative:CitationRepresentative|null;
  previousRepresentative:CitationRepresentative|null;
};
type CitationDomainRow = {
  id:string;hostname:string|null;trackable:boolean;
  current:CitationAggregatePart;previous:CitationAggregatePart;
  currentUniqueUrls:number;previousUniqueUrls:number;
};
type CitationCategoryRow = {
  id:PublisherCategory;current:CitationAggregatePart;previous:CitationAggregatePart;
};
type CitationChangeKind = 'newly_observed'|'fewer_citations'|'not_observed_now'|'annotation_title_changed';
type CitationChangeRow = {
  id:string;kind:CitationChangeKind;target:'url'|'domain';targetId:string;label:string;
  current:CitationCount;previous:CitationCount;
  before:CitationRepresentative|null;after:CitationRepresentative|null;
};
type CitationChangesStatus = 'no_data'|'no_previous'|'unavailable'|'in_progress'|'incomplete'|'ready';
type CitationNavigation = {
  view:'urls'|'domains'|'categories'|'changes'|'evidence';
  period:Period|null;urlId:string|null;domainId:string|null;
  changeKind:CitationChangeKind|null;
};
type CitationReport = {
  role:Role;filters:CitationFilters;navigation:CitationNavigation;
  asOf:string;contextRevision:number;profileHash:string;selectionRevision:string;
  eligibilityVersion:'retained-nonempty-stop-v1';
  classifierVersion:'elmo-3c673d0-native-axes-v1';
  ownershipVersion:'citation-host-suffix-v1';
  googleDomainsVersion:string; // dated pinned snapshot/hash, never a runtime fetch
  label:'Retained citation observations classified using current project context';
  warnings:string[]; // at most 10 fixed messages; no raw provider errors
  entities:{id:string;label:string}[]; // brand + at most 100 competitors; no whole domain lists
  current:CitationPeriod;previous:CitationPeriod;periodOpen:boolean;
  axes:{current:CitationAxes;previous:CitationAxes};
  daily:CitationDaily[]; // complete adjacent windows, at most 62 days
  evidenceStates:CitationEvidenceState[]; // entire selected population, at most 1000
  changes:{status:CitationChangesStatus;countBasis:'annotation_occurrences';
    counts:Record<CitationChangeKind,number>};
  page:{kind:'urls';rows:CitationUrlRow[]}|{kind:'domains';rows:CitationDomainRow[]}|
    {kind:'categories';rows:CitationCategoryRow[]}|{kind:'changes';rows:CitationChangeRow[]}|
    {kind:'evidence';rows:CitationEvidence[]};
  totalRows:number;nextCursor:string|null;
};
```

`InsightCoverage` and `InsightEligibility` are the existing exported types, including `invalid`. Counts are nonnegative safe integers. Metadata is bounded by the same selected population; evidence is NEVER repeated wholesale in summaries. Axes include their fixed complete enum in canonical order, including zero counts. `CitationDaily.summary.from/to` both equal date. IDs/hashes are lowercase hex64 except execution/project/prompt/competitor UUIDs and literal entity `brand`.

For annotations, ownership is exact-host/dot-subdomain matching using existing identity host normalization (including its `www` normalization). Preserve every matching competitor ID in sorted order. `ambiguous` means brand plus any competitor, or more than one competitor. The ownership facet is one of untracked/brand/competitor/ambiguous per annotation; entity-specific drilldown may intentionally overlap. Never turn a tracking match into verified ownership.

Publisher automatic classification reuses pinned classifyUrl(host, retainedUrl, retainedTitle, empty, empty), including its unknown-domain URL/title fallback, with EMPTY own/competitor sets; its ownership priority does not leak into the publisher axis. The pinned heuristic classifies otherwise unlisted `.org` hosts as institutional before trying the URL/title fallback; this is a label inferred from the hostname, not verified organization or page content. A normalized exact-host override replaces this automatic publisher result. `other` is an explicit override value; null means remove override. Page type is the pinned `resolvePageType` result using the AUTOMATIC publisher category, so a manual publisher edit cannot silently change a separate inferred axis. Retain automatic category in evidence to explain/reset override. URL/domain aggregates expose axis counts because constituent annotations can have different titles/page types/categories; never pick a representative title's category for the entire aggregate.

`publisher` sourceType means a structurally valid public hostname that is not a recognized Google surface; it does not prove a publisher organization. `unclassified` preserves annotations whose retained URL has no acceptable public hostname. Their publisherCategory/automaticPublisherCategory are other and publisherBasis is unclassified. Such evidence is plaintext/untrackable, still counted and available. The domain view has one explicit null-host bucket rather than silently dropping it. Its annotations do not increment uniqueDomains. Grouped URL identity is still available for a valid retained HTTPS URL. Page-type output remains a labelled URL/title heuristic, never proof that any page was fetched or organization verified.

## Query, navigation and ordering

GET `/api/projects/:projectId/prompt-insights/citations` accepts exactly base filters `from,to,timeZone,model?,promptId?,tag?,urlGrouping?`, applied source filters `query?,publisherCategory?,pageType?,sourceType?,ownership?,entityId?`, plus the navigation fields above and `cursor?`. Default urlGrouping is retained-fragment-v1, view urls. No matcher query: citation ownership is independent of answer substring/boundary matching. Internal selector may use its existing default method without exposing irrelevant controls. All duplicates/unknown keys reject400, serialized query <=4096 characters. Dates/current range use existing validation: 1..31 local calendar days; previous is equal length immediately before from, with at most 62 combined days. Open current period is allowed and explicitly flagged.

Source filter drafts are separate from the applied report and require explicit Apply. Each optional source filter normalizes to null when omitted; the UI omits empty controls rather than sending an empty enum. query trims leading/trailing whitespace, rejects empty-after-trim/control/NUL/malformed Unicode and values over200 UTF-16 code units, then applies literal case-insensitive substring matching using standard lowercase over retainedUrl, retainedTitle (when non-null), or normalized hostname. No regex, SQL wildcard, query-parameter decoding, fuzzy matching, or token inference; `%`, `_`, `+` and punctuation are literal. Query matching does not use groupedUrl, so switching URL grouping cannot change which original annotations match. Nonempty query is returned trimmed, preserving authored case; empty UI query becomes omitted/null. No Unicode normalization beyond normal lowercase matching is implied.

All source filters combine with AND at annotation level before aggregation. `entityId` is brand or a current scoped competitor UUID; it matches that entity even when ownership ambiguous. Summaries' citedExecutions/annotations/uniqueUrls/uniqueDomains, axes, daily citation counts, groups, representatives, changes and full CSV all describe these matching annotations. Coverage/eligibleAnswers/evidenceStates remain all base selected answers in both periods, including answers with zero matching annotations. Caption: "Citation rates use all eligible answers in the selected dates, model, prompt and tag; source filters limit matching citations." No source filter can turn an unavailable answer into a negative or remove it from coverage.

Navigation fields are optional and normalize to null. `urlId`/`domainId` are mutually exclusive and only legal for evidence; period is only legal for evidence and defaults current. changeKind is only legal for changes. Navigation filters only the returned page and never the applied summary/axes/daily/changes counts or export. Categories accept no target IDs. Each paginated view exposes exact filtered `totalRows` and rows<=50, replacing the page, not appending snapshots. Page-types and daily-observation UI modes use the complete bounded axes/daily arrays; no extra server page variant is needed. A page-type shortcut must explicitly apply that filter before showing matching URLs, not secretly change navigation alone.

For URL/domain/category views, aggregate each period after the applied source filters; report summaries remain independent of navigation. Default sort current executions descending, current annotations descending, previous executions descending, then stable row ID ascending. Evidence sort requestedAt DESC, executionId ASC, retainedCitationIndex ASC. Changes sort kind in enum order, then previous annotation count DESC (newly observed uses current count DESC), then target ID ASC. Category canonical enum order is preferred over count sorting. Scope hashes bind project/all applied filters and navigation; cursor additionally binds selectionRevision + integer offset. Invalid scope400; changed evidence/context/classifier revision409. No frozen-asOf cursor that hides a later deletion.

Each current/previous representative is the latest nonempty retained title if available, otherwise latest annotation; order requestedAt DESC, executionId ASC, retainedCitationIndex ASC. It is a selected observed annotation, not a document title claim. Null and empty retained titles remain distinguishable in evidence. Representative determinism and selectionRevision include underlying retained result hashes, not only aggregate counts.

## URL identity, classifier provenance and surfaces

Default grouping is `retained-fragment-v1`: start from validated retained HTTPS URL, remove fragment only, serialize using WHATWG URL. Preserve query parameters/order, path case/escaping, www and trailing slash. The existing captured URL was already serialized by the provider adapter; no claim to recover original provider bytes. `elmo-url-v1` is the attributed pinned normalizeUrl behavior: first utm_source=openai triggers deletion of all utm_source values; URLSearchParams serialization; remove text-fragment portion; force HTTPS; remove www; remove one non-root trailing slash. It intentionally preserves the upstream empty-fragment serialization quirk: `https://www.acme.org/#:~:text=quote` groups as `https://acme.org/#`. The default fragment-only mode removes that fragment completely. Both groupings keep original retained URL/title/index in evidence. No identity transform is a safety validator.

Classifier adaptation sources (pin `3c673d0253d01ae030fa41519f62ad7e54f2281b`): `apps/web/src/lib/domain-categories.ts`, `domain-categories.server.ts`, `editorial-domains.ts`, with focused relevant source tests. Root MIT copyright2026 Blue Whale Software LLC; retain full notice and provenance comments in THIRD_PARTY_NOTICES. No separate list license was found. Wikipedia seed comments in curated lists stay intact. Server-only lists must not enter the client bundle.

Google predicates retain pinned path/query semantics but use root-reviewed factual snapshot of `https://www.google.com/supported_domains` (retrieved2026-10-13), normalized exact/dot-suffix matching. Root will provide the reviewed list/version. No regex accepting google.evil.com. Shopping/search/wrapper recognition forms a SOURCE TYPE axis; all rows stay in overall counts and evidence. Wrappers are never dereferenced or assigned destination ownership. A user can explicitly filter sourceType=publisher for external-source-only counts. Specialized product/query attribution/grouping remains P19 and must not be claimed by merely exposing surface labels.

## Changes and coverage gates

Changes are descriptive occurrence comparisons, not matched-cell/causal outcomes. `changes.status` precedence: no_data if current attempted0; no_previous if previous attempted0; unavailable if either eligible0; in_progress if current to>=asOf local date; incomplete if either eligible*10<attempted*9; otherwise ready. 90% is an explicit application coverage policy, not a statistical confidence claim. When not ready, every change count is0 and changes view is empty with status explanation, while ordinary period counts remain readable. No claim of disappearance from missing/expired/open evidence.

Within ready periods, apply separately to URL and domain groups after the same applied source filters. All source types are included by default; an explicit sourceType filter limits them consistently:

- Newly observed: previous annotations0 and current annotations>=2.
- Fewer citations: previous annotations>=2, current annotations>0 and current*2<=previous.
- Not observed now: previous annotations>=2, current annotations0. Disjoint from fewer.
- Annotation title changes: URL groups only, both representatives have nonempty retained titles and those exact titles differ. Preserve both annotation references. This does not assert that the cited page was edited.

Return all qualifying changes through page50, not a silently truncated top10. Source >=2/50% behavior is retained, with truthful wording and gated coverage. These remain counted occurrences; the adjacent current/previous distinct-execution counts are visible alongside them. A URL grouping switch recomputes the entire selection and invalidates cursors/export.

## Context ops, schema and idempotency

Propose a single migration adding to project_context: `brand_citation_domains jsonb NOT NULL DEFAULT '[]'` and `citation_category_overrides jsonb NOT NULL DEFAULT '[]'`, with array type and max19/max100 checks. No citation fact/materialized-result table and no mutation of saved answers. Additional domains19 plus at most one valid project-origin hostname fit the existing20-domain matcher bound; deduplicate. Domain metadata never enters project_domain/verified serving registries. Stored authored context has existing context retention semantics.

Extend current contextPatch operations, current DTO and shared updateProjectContext transaction, with:

```ts
{kind:'citation-brand-domain';domain:string;action:'add'|'remove'}
{kind:'citation-category';domain:string;category:PublisherCategory|null}
```

Normalize domain via contextHost, strict unknown-field rejection, sort persisted arrays for deterministic hashes. Keep implicit project-origin hostname separate/read-only; duplicate add is a harmless accepted no-op. Return profile.citationDomains (additional only) plus citationCategoryOverrides at top level of existing context DTO. Shared profile construction unions valid project-origin + extras for ordinary insights/comparison/citation ownership, so cited-domain action has consistent effects across views; classificationTerms for branded prompt text stays unchanged unless separately approved. Publisher overrides affect P18 only but contextRevision invalidates all context-derived snapshots conservatively.

Add to existing competitor or create competitor uses the existing `kind:'competitor'` op with primaryDomain/name/full merged domains, current revision and requestId. Existing20 domains/100 competitors/normalized exact competitor-domain conflicts remain. CAS prevents erasing concurrent edits. Parent/subdomain overlaps and brand/competitor overlaps are permitted but visibly ambiguous, not silently reassigned.

Every action requires existing owner/admin/editor write gate before receipt replay; viewers read/export. Existing content receipt is project+requestId+normalized-body bound (not actor-bound); reuse that documented behavior rather than quietly claiming a new guarantee. Current request UUID and body remain frozen across unknown/malformed acknowledgement. Existing revision+requestId envelope and trusted request-correlated updateProjectContext response apply;409 demands a fresh read/review, no autosave. Validate the returned current context then reread the classification. Do not claim that the response is an immutable applied snapshot: later edits may already be reflected. No shared acknowledgement schema expansion or copied evidence in the receipt. Trace every contentProfile/context DTO caller before extension, preserve all unrelated fields and bulk operations exactly, and retain idempotent replay before revision CAS as implemented.

## Bounds, retention and export

Reuse withContentProject(false) repeatable read and current role admission. Select current+previous once: <=1000 total candidate executions, <=10MiB retained answer JSON, <=100 annotations/answer and <=100,000 occurrences combined. Expired payload is neither loaded nor hashed. Classification occurs only after these gates; check abort/deadline during loops. Existing 5s SQL timeout/30s service deadline; report limit error413, timeout503; neither returns partial report. Citation-only selection does not require copied input/messages (input expiry is irrelevant here). Avoid rerunning answer-text matching if the narrow selector extension can reuse validation/eligibility without it; do not loosen existing insight work caps for its current callers.

Current and previous summaries/axes/daily arrays + full eligibility manifest stay compact; do not send URL dictionaries,100k evidence rows, large curated sets, or all competitor domains on every page. Keep response serialized cap2MiB (whole response fails413 with narrower-range instruction); strings use current limits: URL2048, newly captured title<=300 code points; existing permitted retained titles remain exact within the10MiB whole-selection cap, public host253, entity labels120. Invalid stored citation metadata follows existing answer-invalid coverage; no silent per-answer sampling. A measured fixture is required before claiming operational capacity.

Fresh raw-evidence cutoff and irreversible result_purged_at apply exactly as existing selector/receipt. Whole-selection manifest is mandatory on every view, even category/cell-like aggregates, so client known expiry blocks revival after policy extension or a new unrelated revision. Carry known answer expiry through receipt, ordinary insights, comparison and citation navigation; an absent out-of-scope ID must not poison a report. Context changes reclassify only currently retained annotations and never extend their lifetime.

POST `/api/projects/:projectId/prompt-insights/citations/export` accepts ONLY CitationFilters plus `expectedSelectionRevision:string64hex`; full APPLIED-report export includes every applied source filter and ignores navigation explicitly. It must never export edited-but-unapplied filter drafts. It recomputes authorization/selection in one fresh read snapshot, rejects changed revision409, returns no partial CSV, and honors AbortSignal. Response `text/csv; charset=utf-8`, fixed attachment `prompt-citations.csv`, x-export-row-count, no-store/nosniff. Fixed rectangular columns; existing csvCell guards formulas; null vs zero preserved with explicit statuses.16MiB total UTF8 cap, actual bytes counted; no provider URLs fetched.

Export record contract: one metadata row, two period rows, one daily row for every day, and one evidence row per matching eligible retained annotation from BOTH periods (no separate aggregate row duplication). Summary/daily rows include their full base answer coverage/denominator and fixed filtered axes as JSON cells. Evidence rows contain all provenance/classification plus current profile/method identifiers. Expected data row count is `3 + daily.length + current.annotations + previous.annotations`; CSV header excluded. Thus a 100k-annotation report can read paginated but its full evidence CSV can correctly exceed16MiB and fail with a narrower-range instruction. Full distinct URL/domain/category summaries are reproducible from exact evidence rows; metadata labels export as full applied report. No answer text/system input/credentials/financial evidence exported.

## Regression and compatibility requirements

Acceptance: duplicates/unions/zero vs unavailable; exact both-period cap; title variants/representative stability; fragments/query/utm/www/trailing-slash modes; literal query max200 and AND source filters consistently changing charts/groups/changes/export but not answer coverage/denominator/manifest; edited-unapplied drafts never exported; inherited ownership ambiguity and exact override/reset; all Google surface counts and spoofed hosts; closed/90%/2-occurrence/50% boundaries; DST/skipped dates; full selected manifest across page/navigation; expired result never loaded or revived; context CAS, bulk field preservation and conflicting replay; foreign/viewer write denial; formula-safe rectangular export/count/cap/abort; no network hooks; old7 insight and8 comparison regressions remain green. Preserve source LVCF trend and specialized P19 gaps explicitly until separately implemented; no full-parity completion claim from this contract alone.

## Pinned source references

- [Elmo MIT license](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/LICENSE.md), copyright2026 Blue Whale Software LLC.
- [Category precedence and publisher fallback](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/domain-categories.server.ts#L774), [editorial dataset](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/editorial-domains.ts#L1).
- [URL grouping, Google predicates and page-type rules](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/domain-categories.ts#L131).
- [Occurrence counts and extracted citation order](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/postgres-read.ts#L539), [OpenRouter extraction-order counter](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/packages/lib/src/providers/registry/openrouter.ts#L48).
- [Changes thresholds](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/server/citations.ts#L203), [tracking context actions](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/server/brands.ts#L464).
- [Carried source trends](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/chart-utils.ts#L183) are distinguished from actual native daily observations.
- [Google factual supported-domain source](https://www.google.com/supported_domains), root verified2026-10-13; reviewed static snapshot only, not fetched by report requests.
