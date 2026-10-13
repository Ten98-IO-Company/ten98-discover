# Specialized citation reports

Accepted implementation contract for issue49, 2026-10-13; not implementation or release evidence. Reuses the citation analysis contract after its separate acceptance. The frozen source baseline is Elmo3c673d0253d01ae030fa41519f62ad7e54f2281b.

## Tight increment

One read-only specialized citation service supplies Reddit communities/pages, retained Google Shopping/search-link groups, and citation-domain gap candidates from the existing retained answer population. It includes exact annotation/answer provenance and a selection-bound CSV. No new table, provider call, scraping, wrapper resolution, model generation, scheduling, financial mutation or product catalog.

The increment implements specialized **analysis of captured annotations**, not Google AI Mode collection or proof of rendered product-card exposure. Full P19 provider/capture and independent UI/live acceptance gates remain explicit below.

Implementation allowlist: new `src/server/prompt-citation-specializations.ts`, narrow shared-selector extraction in `src/server/prompt-citations.ts`, read-only route additions in `src/server/api.ts`, and new `tests/prompt-citation-specializations-integration.ts`. A small pure helper may stay inside the new service unless independently testing it requires an exported function; no generic reporting framework, classifier fork or new dependency. Kimi presentation leaves are separate tasks after a reviewed contract.

## Reuse and authority

1. Keep `withContentProject(projectId,userId,false)` as the membership/tenant boundary and repeatable-read snapshot. Every read/export reauthorizes; no vault/provider readiness is required to inspect retained evidence.
2. Reuse `selectPromptInsights(client,p,base,check,false,true)`: all selected current+previous observations, exact current-context identities, eligibility, full result-size preflight, fresh elapsed-24-hour retention cutoff, tombstones and zero expired-payload loading/hashing. It supplies `citationEvidence` without answer matching or raw copied request input.
3. Extract only the existing P18 base preparation loop (`prompt-citations.ts:111–123`) into a named internal export such as `selectCitationEvidence`. Return base observations, all eligible classified `CitationEvidence`, period bounds/local date, current subjects/context hashes and base selection revision. Apply P18's existing source filters **after** this helper in the P18 caller so its current DTO/counts/CSV remain unchanged. Do not call the public paginated report repeatedly or issue one DB request per group.
4. Reuse `createCitationClassifier`, `groupCitationUrl`, the pinned official Google domains snapshot, and `parseGoogleProductName` / `parseGoogleSearchQuery` / `attributeProduct` already in `citation-taxonomy.ts`. Product attribution needs actual current authored competitor names: the ordinary selector's `subjects[].name` substitutes primaryDomain for a null name, which would silently change the source method. Return a bounded internal `productNames` projection from the already fetched context rows, or do one explicit bounded current-context read. Null/blank competitor names are skipped, not replaced with domains. Sort input competitors by UUID before the existing longest-name helper for deterministic ties.
5. Gap and prompt drilldown labels use a bounded project-scoped query for selected immutable version IDs, selecting only `left(v.text,160)` and version identity. It does not read copied system messages or full answer text again. Label a representative as the newest selected execution's prompt version (with stable ID tie); never imply it is today's edited prompt. Versions remain separate in evidence even when a source-compatible prompt-ID aggregate combines them.

## API and query

GET `/api/projects/:projectId/prompt-insights/citation-specializations`

POST `/api/projects/:projectId/prompt-insights/citation-specializations/export`

Both are read-membership operations with existing cookie/session/Origin conventions; exports retain POST Origin checks and are not context mutations. No API-key/provider side channel is added. AbortSignal/deadline propagation matches P18. Reject unknown keys, repeats, invalid enum combinations, foreign IDs and oversized input with fixed errors.

```ts
type Period = 'current'|'previous';
type BaseFilters = {
  from:string; to:string; timeZone:string;
  model:string|null; promptId:string|null; tag:string|null;
  urlGrouping:'retained-fragment-v1'|'elmo-url-v1';
};
type SourceFilters = {
  query:string|null; // literal, trimmed, <=200; URL/title/hostname
  publisherCategory:PublisherCategory|null;
  pageType:PageType|null;
  sourceType:SourceType|null;
  ownership:OwnershipKind|null;
  entityId:string|null;
};
type SpecializedFilters = BaseFilters & SourceFilters & {
  productAttribution:'brand'|'competitor'|'other'|null;
};
type SpecializedNavigation = {
  view:'reddit'|'reddit_pages'|'shopping'|'search'|'gaps'|'prompts'|'evidence';
  period:Period|null;
  groupId:string|null; // server-produced lowercase hex64, never a URL
  gapPromptId:string|null;
  evidenceMode:'matching'|'gap_all'|null;
};
```

GET uses flat parameter keys and optional cursor. Defaults: grouping retained-fragment-v1, optional filters null, view reddit, all navigation targets null. Entry from P18 copies only base answer filters; optional source filters reset to null visibly. Current range is 1–31 local days with an adjacent equal-length previous range. Validate timezone/local dates using the existing helpers (including DST, year boundaries and skipped local dates).

Navigation combinations are strict: reddit/shopping/search lists have no target or period; gaps has a period (default current) and no target; reddit_pages requires an existing Reddit group and period; prompts requires an existing Reddit/product/query group and period; matching evidence requires groupId+period, optionally a selected gapPromptId only when that prompt belongs to that group; gap_all evidence requires gapPromptId+period and no groupId. An unknown in-scope target returns 404/unavailable, never a cross-project lookup. Cursor binds canonical filter scope, navigation and selection revision; existing 50-row/409 rules apply.

`productAttribution` filters only Shopping groups, their prompt/evidence navigation and that export section. It does not reinterpret domain ownership or reduce Reddit/search/gap totals. The DTO declares this scope; hidden cross-tab filters must remain visibly listed. SourceFilters apply annotation matching consistently across Reddit/Google group totals and displayed evidence. Base eligibility/manifest and gap qualification are never reduced by these annotation filters.

Export body is all SpecializedFilters plus `expectedSelectionRevision` hex64, no navigation/cursor. Fixed filename `prompt-citation-specializations.csv`, `text/csv; charset=utf-8`, attachment, `x-export-row-count`, no-store. The export is explicitly the **whole applied specialized report**, not the current navigation page.

## Response and count semantics

```ts
type Count = {annotations:number; executions:number; prompts:number};
type SpecializedMethods = {
  reddit:'reddit-path-community-v1';
  googleLabels:'google-retained-link-labels-elmo-v1';
  productAttribution:'google-product-name-elmo-v1';
  gaps:'prompt-period-domain-gap-v1';
};
type PeriodState = {
  from:string; to:string; open:boolean; coverage:InsightCoverage;
  eligibleAnswers:number|null;
  reddit:{all:Count; community:Count; ungrouped:Count};
  google:{shopping:Count; labelledShopping:Count; unlabelledShopping:Count; matchingProducts:Count;
    search:Count; labelledSearch:Count; unlabelledSearch:Count; wrappers:Count};
  gaps:{status:'ready'; evaluatedPrompts:number; promptsWithCompetitor:number;
    observedCandidates:number; confirmedCandidates:number; matchingCandidates:number}|
    {status:'brand_identity_unavailable'; evaluatedPrompts:null; promptsWithCompetitor:null;
    observedCandidates:null; confirmedCandidates:null; matchingCandidates:null};
};
type SpecializedReport = {
  role:'owner'|'admin'|'editor'|'viewer'; filters:SpecializedFilters;
  navigation:SpecializedNavigation; asOf:string; contextRevision:number;
  profileHash:string; selectionRevision:string;
  eligibilityVersion:string; classifierVersion:string; ownershipVersion:string;
  googleDomainsVersion:string; methods:SpecializedMethods;
  label:'Specialized retained citation observations using current project context';
  warnings:string[]; entities:{id:string;label:string}[]; // brand first, <=100 competitors
  googleConsumerModule:{status:'not_recorded'; reason:'consumer_surface_not_captured'};
  unresolvedEvidence:{redditCommunityId:string;shoppingLabelId:string;
    searchQueryId:string;googleWrapperId:string};
  current:PeriodState; previous:PeriodState;
  evidenceStates:{id:string;period:Period;eligibility:InsightEligibility}[];
  page:SpecializedPage; totalRows:number; nextCursor:string|null;
};
```

`eligibleAnswers` is null only when the period has no eligible answer; zero annotation counts alongside a positive denominator are real observed zeros. All base observations, including failed/expired/pending, remain in coverage and the whole-selection manifest. Each count uses Set unions for executions/prompts and separate occurrence sums for annotations. Counts across groups may overlap in answer/prompt populations and must not be summed as unique totals.

The Google aggregate covers retained Google-shaped annotations matching SourceFilters, before productAttribution. Labelled+unlabelled annotation sums equal the relevant shopping/search count. Those two subsets' unique answer/prompt counts can overlap and must be unioned, not added. `matchingProducts` is the labelled subset after productAttribution and supplies the visible product-list summary. Headers explicitly distinguish all matching Shopping links, extracted product-label links and the selected name-attribution subset. This preserves unresolved availability even when selecting Yours/Competitors. Wrapper counts remain inspectable but do not become products, search queries or destination publishers.

The four unresolvedEvidence IDs are canonical opaque hashes for server-owned target buckets, resolved from the same selected evidence map; use ordinary matching-evidence navigation with a period to inspect ungrouped Reddit URLs, unlabelled Shopping/search links or Google wrappers. Empty buckets return zero evidence rows. They are not URLs, new detected identities, or inferred labels, and cannot be used with the prompts/reddit_pages navigation. ProductAttribution does not hide these diagnostic buckets.

Gap summary fields `evaluatedPrompts`, `promptsWithCompetitor`, `observedCandidates`, `confirmedCandidates` are over **all base prompt-period observations/annotations**, before SourceFilters. `matchingCandidates` is the subset with at least one competitor annotation matching optional SourceFilters, and equals the gap list's totalRows for that period. Product-name attribution never filters gaps. Label both base candidates and currently matching candidates; no gap percentage or source-filtered denominator is invented.

`evaluatedPrompts` counts distinct selected prompt IDs with at least one eligible answer in that period; `promptsWithCompetitor` is the subset with C>0; `observedCandidates` is the subset with C>0 and B=0; `confirmedCandidates` is the closed, fully eligible subset. Prompts with only unavailable answers remain in answer coverage but not evaluatedPrompts. Nothing here counts provider slots never attempted.

Gap measurement requires at least one valid current brand citation domain (the public project-origin hostname or an additional authored citation domain). Without one, each period returns `gaps.status='brand_identity_unavailable'`, all five gap counts are null, and no gap rows or gap-proof candidates are created. Reddit/Google positive observations, answer coverage and the complete manifest remain available. The UI requests citation-domain setup instead of presenting absence or zero. This metadata never grants DNS/serving authority. The compact entities roster uses the ordinary display label, which can fall back to a domain for a nameless competitor; product attribution still uses only actual authored names.

## Exact group/page types

```ts
type GroupPart = Count & {groupedPages:number};
type GroupIdentity = {id:string;label:string;current:GroupPart;previous:GroupPart};
type RedditRow = GroupIdentity & {
  kind:'reddit'; communityKey:string; // e.g. 'r/skincare', lowercase
  currentNewPages:number|null; previousNotObservedPages:number|null;
  changeStatus:'no_previous'|'unavailable'|'in_progress'|'incomplete'|'ready';
};
type ProductRow = GroupIdentity & {
  kind:'product'; labelBasis:'retained_title'|'url_product_id'|'mixed';
  attribution:{kind:'brand'|'competitor'|'other';competitorId:string|null};
  currentRepresentative:CitationRepresentative|null;
  previousRepresentative:CitationRepresentative|null;
};
type QueryRow = GroupIdentity & {kind:'query';labelBasis:'retained_url_q'};
type RedditPageRow = {
  id:string;urlId:string;groupedUrl:string;count:Count;
  representative:CitationRepresentative;newlyObserved:boolean|null;
};
type PromptGroupRow = {
  promptId:string;representativeVersionId:string;promptPreview:string;
  versionCount:number;count:Count;
};
type GapRow = {
  promptId:string;representativeVersionId:string;promptPreview:string;versionCount:number;
  period:Period;coverage:InsightCoverage;
  status:'confirmed_observed_gap'|'incomplete_evidence'|'in_progress';
  brandAnnotations:0;competitorCount:Count;competitorIds:string[];
  matchingCompetitorCount:Count;
};
type SpecializedPage =
  {kind:'reddit';rows:RedditRow[]}|
  {kind:'reddit_pages';rows:RedditPageRow[]}|
  {kind:'shopping';rows:ProductRow[]}|
  {kind:'search';rows:QueryRow[]}|
  {kind:'gaps';rows:GapRow[]}|
  {kind:'prompts';rows:PromptGroupRow[]}|
  {kind:'evidence';basis:'matching'|'gap_all';rows:CitationEvidence[]};
```

For gaps choose period explicitly (default current); group lists can show both period parts. List groups are the current/previous union, including previous-only groups. Stable group IDs hash method+kind+normalized group key, never a truncated display label. Sort source-compatible occurrence counts descending, current then previous, then full group key/ID. Prompt and gap ties use prompt UUID. Evidence preserves P18's deterministic request/ID/index order. Representatives choose newest requestedAt, then execution/index ties, without changing identity/counts.

No unbounded nested `prompts[]`, `urls[]`, competitor names, raw answers or system inputs in group rows. Prompt grouping and evidence are separate paged navigation. Every evidence row already includes execution/comparison/prompt/version IDs and retainedCitationIndex, retained URL/title and classification. Its raw URL is not a lookup key that could trigger a network request. Gap evidence can include nonmatching source rows by explicit `basis:'gap_all'`; UI says “All base citations used to evaluate this gap,” so the proof is not mistaken for a changed applied report.

## Reddit parsing — corrected native method

Method ID `reddit-path-community-v1`, distinct from the upstream raw-string regex.

- Require classifier-admitted public hostname exactly reddit.com or a dot-suffix subdomain. Parse the retained HTTPS URL with the platform URL parser already used for P18; no navigation/network.
- Only a pathname beginning `/r/` (case-insensitive for the two-character routing prefix) supplies a community. Take the immediately following segment up to the next `/`; query and fragment never supply a name. No recursive search inside later path segments.
- Decode that one segment once using `decodeURIComponent` under try/catch. Reject decoded slash/backslash, C0/C1 controls, malformed UTF-8/percent, empty, or non-ASCII identifier characters. Accept `[A-Za-z0-9_]{1,64}` as a bounded extraction grammar, not a claim that Reddit has created/accepts every such name. Keep all rejected/unrecognized URLs in `ungrouped` evidence, not a fake community. Lowercase the group key, preserve the original retained URL/title.
- Query-contained `https://reddit.com/r/fake`, `%2F` path separators, `redd.it`, user profiles and raw page slugs cannot fabricate communities. Source regex casing quirks are not silently called source-compatible; the method name/export records the correction.
- New/missing page membership uses the selected URL grouping method and both periods. Reuse P18's evidence coverage/open-period change gating (closed, >=90% eligible both periods and prior attempts) for novelty badges; otherwise novelty fields are null/unavailable, not proof of newly created/deleted pages. This is observed selection change, never Reddit activity/engagement.

## Google admission, labels and attribution

Methods: `google-retained-link-labels-elmo-v1` plus existing Google domains snapshot; `google-product-name-elmo-v1` for exclusive current-name attribution. Keep the source's `/search*` recognition, Shopping priority, encoded-colon ID handling and first `q` behavior. Existing host hardening to exact/dot-suffix entries in the official snapshot remains a documented native security correction; never restore the permissive upstream google.* regex.

Shopping label priority and lowercase grouping reuse the current helper exactly. Fallback `Product <id>` is explicitly `url_product_id`, not a known product title. IDs stay strings, including values beyond 2^53. One physical ID with different titles can form different groups; different IDs with the same case-folded title can share a group. Do not promise unique products/SKUs. Any group containing both title and fallback-derived entries reports mixed basis, with all raw evidence available.

Use current authored brand name, and actual nonblank current competitor names only. Brand substring wins, longest competitor name next, equal-length matches in stable UUID input order, then other. This is deliberately exclusive and source compatible; aliases and primary-domain fallbacks are not added silently. A separate P18 hostname ownership record can be ambiguous and disagree with the product-name heuristic. Copy says “Name-based attribution using current context,” never verified manufacturer/merchant/ownership. The source method sorts competitors per invocation; prepare/cache attribution by distinct lowercase group label and use a bounded work check so 100,000 repeated annotations do not repeat name matching.

For search labels, preserve first-q URL decoding semantics, trim and skip empty/literal product. Decoded controls/NUL or malformed percent/UTF-8 must yield an unlabelled observation rather than unsafe JSON/text or invented normalized query. Validate the bounded raw selected query component before trusting replacement decoding; decode exactly once. A literal replacement character in a valid encoded query is not automatically malformed. No stemming/tokenization/query rewriting or inferred fan-out.

Current capture is API-only and has no immutable Google consumer-module readiness flag. Therefore `googleConsumerModule.status` is always `not_recorded` for this increment, even if a retained URL looks like Shopping. Positive retained-link groups are valid observations, and zero retained-link matches is a valid zero only relative to eligible answers. The corresponding Google AI Mode product-card exposure statistic is unavailable, never zero. Do not accept a client-selected provider/module flag, infer support from a model's name or retrofit historical capture claims. Future adapters need an explicit versioned captured capability before this literal status is expanded; known-module answers could then truthfully distinguish supported empty capture, unsupported capture, mixed coverage and failed/expired capture. That future rule must come from the actual adapter contract, not a guessed enum implemented now.

Wrappers remain wrappers; never decode their payload into destination ownership, open images, fetch favicon/merchant pages or perform a background redirect resolution. Query-only reports render independently of products; unresolved labels are visible/countable instead of silently skipped upstream.

## Gap qualification and denominator — fixed before source filtering

Build one map per period and prompt ID from **all base selected observations**, then attach all eligible classified annotations. Compute coverage on every selected attempt, even an answer with zero annotations or an unavailable result. Domain identities come from current semantic brand/competitor domains, never publisherCategory overrides or product-name matches.

For prompt p and period t:

- B = count of annotations with ownership.brand true.
- C = count of annotations with competitorIds nonempty; each annotation increments once even if two competitor IDs match.
- U = union of those competitor IDs; unique competitor count is |U|.
- candidate = C > 0 and B = 0 over the **whole base prompt-period**.
- confirmed observed candidate = candidate, closed period and eligible = attempted > 0. This stricter absence condition is intentional: P18's 90% trend threshold does not prove zero brand citations in missing answers.
- candidate with any ineligible attempt is `incomplete_evidence`; otherwise candidate in open period is `in_progress`. Positive competitor evidence stays visible, but copy says “Brand absence cannot be confirmed from the incomplete/open selection.” No definitive missing-content recommendation or no-brand result is inferred.
- SourceFilters are applied only after the predicate. They compute matchingCompetitorCount and whether the candidate appears in a filtered list. They cannot make B zero, change U/base competitor counts, make a candidate confirmed, or change base coverage.

Example: prompt has competitor citation in execution A and brand citation in execution B. Filtering ownership=competitor/query=the competitor title does not produce a gap. Example: A is eligible with competitor citation and B expired. Show incomplete evidence with the observed positive count, not “brand cited zero across all answers.” Example: one annotation matches both brand and competitor suffix identities: B=1 and C=1, so not a gap.

This reproduces the source's prompt-level “ever brand in selected period” predicate while correcting exclusive domain precedence into the existing native multi-owner truth. Grouping combines selected versions under prompt ID for source parity and exposes versionCount/evidence; it is not a matched-cell causal comparison. No answer-text mention gap or generated opportunity is added (P16/P22 stay distinct).

## Snapshot, privacy, bounds and export

- Full selection manifest includes all base current+previous executions, <=1,000, regardless of group/list/evidence filtering. It must match coverage partitions. Learned answer expiry from nested receipts rejects revival on every response and aggregate page; unrelated prior IDs absent from a new base scope cannot poison it.
- Revision hashes base observation hashes/status/retention, source filters, current context including actual product names, classification/grouping/method versions and source-filter results. Navigation belongs only in cursor scope, not the underlying population revision. No asOf-only pin that permits later deletion/expiry to return old payload.
- Current range1–31 plus adjacent previous, <=1,000 executions, 10 MiB retained answer payload preflight, <=100 annotations per eligible execution /100,000 total. Preserve existing 5-second SQL statements and bounded operation checks. New attribution term work capped at100,000,000 UTF-16 character×nonempty name comparisons, checked before matching; cache repeated group labels. No silent sampling or partial report on overflow.
- Metadata (manifest, coverage, methods, small summaries) remains bounded; page50 and total JSON<=2 MiB, fail413 with narrowing guidance. Paged rows can retain existing safe titles; do not truncate labels for identity/counts. Use a shortened display preview separately if needed. Optional immutable prompt previews<=160 code points, <=1,000 unique selected versions, project-bound and never copied execution payload.
- Export is rectangular fixed-header CSV, uses existing csvCell formula escaping, actual 16 MiB cap before completion, deadline/abort checks and a stable complete row count. Recommended records: one metadata, two period summaries, all Reddit/product/query group summaries, per-period gap candidate summaries (base plus filtered counts), then each applicable retained annotation once with optional community/product/query group IDs and gap-candidate flags. Include base gap proof annotations even when source filters do not match, with `matchesSourceFilters=false` and explicit `basis=gap_proof`; do not pretend the whole report's annotations share one filtered population. Every record has the same column count. Header does not count toward x-export-row-count.
- The export includes all base gap-proof annotations with an explicit basis, even when they do not match source filters; its UI/export copy must state this. No raw answer text, copied input, secrets or provider account data is exported. No context change during export is applied silently: expectedSelectionRevision mismatch409.
- There is no mutation acknowledgement, queue, idempotent paid request or new schema. Read failure can be retried normally. Current roles/Origin, no-store, exact MIME/filename/count, decoded byte cap and stale-abort no-download rules match P18.

## Acceptance gate for the increment

1. All existing P18 eight, ordinary insights seven and historical comparison eight integration groups still pass after selector extraction; identical preexisting P18 fixtures/DTO/CSV results, no changed classification methods.
2. Reddit path vs query/fragment/adversarial host; case, one decode, malformed UTF-8, empty/long segment, %2F/%5C, non-community evidence, current/previous union, incomplete novelty suppression.
3. Google admitted hosts/all source forms, title/ID fallback beyond2^53, lowercase groups and deterministic tie, literal plus/percent/repeated-q, empty/product/unsafe decoded query, unresolved counts, wrapper no destination, query-only results; no invented module support.
4. Brand-first/longest-name attribution vs hostname ownership/alias conflicts; actual null competitor name is not replaced with a domain; deterministic revised names invalidate cursors/export; meaningful capacity case for unique long labels and100competitors, no unbounded repeated per-annotation sort/match.
5. Domain gap examples above, two executions/versions, zero citations, overlapping owners, publisher override, filters applied only after predicate; all raw coverage and base denominators reconcile. Incomplete/open candidates never get confirmed absence. All selected answer states remain in manifest on every page.
6. Groups→prompts/pages→exact annotations→existing saved answer receipt, fresh Back/current role/read expiry; IDs scoped by project and selected report; foreign/forged cursor and changed source/context/retention reject; zero outbound hooks.
7. Formula-safe CSV, rectangular rows, null vs zero/empty/unavailable, exact revision/count, proof vs matching basis, 16 MiB fail-whole and abort; 1440/360 keyboard/table/focus, provider module unavailable copy, all-member read/export and proper context-write handoff.

## Exact remaining full-parity gates

- All three specialized customer workflows and evidence/export navigation must be implemented and independently accepted; a Reddit-only leaf or Google label helper does not close P19.
- Real Google consumer-surface/provider adapters and immutable capture capability (source sources/citationPills vs relatedLinks/retrieved links) remain unimplemented for current prompt execution. Validate supported synthetic payloads first and later deliberately authorized real-provider behavior. Do not convert this gate into a paid call in this read-only increment.
- Broader provider/model/access-mode/market parity remains in P11–P14. URL q groups do not complete P20 reported query fan-out. Citation gap observations do not complete P22 opportunity generation/history, fetched-content analysis or sentiment. Source carried trends remain P16/P18 work as already recorded.
- Source-substring product attribution and corrected native community parsing must be labelled/versioned and covered by fixtures; no hidden change to the frozen P18 Google/source totals, publisher categories, ownership or raw evidence retention.
- Provenance notices for any additional copied/adapted Google module code, full operational/privacy/export/retention acceptance and release register updates are still needed at implementation time. No completion/publication claim is made here.
