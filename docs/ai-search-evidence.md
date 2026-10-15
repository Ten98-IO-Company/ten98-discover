# P20 — bounded retained-query evidence leaf

Status: bounded leaf and StageA1 adapter implementation; production acceptance remains pending. Public source references and synthetic fixtures only.

## Deliverable and boundary

Kimi output: **only** new `src/server/ai-search-evidence.ts`. No dependency, network, timer, environment, persistence, money or UI work. GPT owns independent `tests/ai-search-evidence.test.ts` and the notice update; neither is in Kimi's allowlist. Do not modify/stub `answer-mentions.ts`.

Normalize one admitted DataForSEO ChatGPT Live Advanced result, then derive one execution's query/word contributions and associated-answer mentions. GPT's later scoped service aggregates them. This dependency alone does not deliver P20 or authorize a paid call.

Caller validates endpoint/profile, cardinality, status, task/request identity and financial outcome, then passes **`tasks[0].result[0]`**. This module establishes no completion, charge, search occurrence, provider identity, retention or authority proof.

Owner requires **both associated-answer mentions and separate website-content coverage**. The leaf below does not inspect a corpus. Native site audits now support explicit opt-in retained static body text (`static-dom-body-v1`, migration0032); availability, complete-page bounds and raw/derived retention apply. No answer, query, citation, snippet or heading substitutes for a scoped body check, and a phrase/token match alone cannot establish semantic content coverage. No guessed win/miss threshold.

## Evidence and reuse

Pinned Elmo: `3c673d0253d01ae030fa41519f62ad7e54f2281b` (MIT, Copyright 2026 Blue Whale Software, LLC).

- `packages/lib/src/providers/registry/dataforseo.ts:58–79,271–284` forces search and reads `fan_out_queries`; `dataforseo-shared.ts:33–52` selects first task/result.
- `packages/lib/src/text-extraction.ts:135–160`: top `markdown`, else trimmed `items[].markdown` joined with blank lines. Native keeps missing/invalid explicit, never diagnostic prose as an answer.
- Same file162–177: `sources`/`items[].sources` are citations; `search_results` are merely results shown. **This leaf reads none of them.** GPT capture handles source provenance separately without implying site coverage.
- `apps/web/src/lib/postgres-read.ts:1110–1234`: trim/lower, one distinct query vote/run, exclude prompt echoes. Brand count comes from associated answer `brand_mentioned`. Source uses current prompt; native deliberately uses immutable captured text.
- `apps/web/src/lib/fanout-analysis.ts:294–330,353–470`: ASCII tokens, cloud occurrence frequency, distinct-token change votes, query-weighted answer rate. Display caps/rounding are separate.
- Stale comments say DataForSEO always unavailable or mention count>=2 Won/Invisible; executable extraction contradicts the former, and no active documented win/miss classifier was found.

Previously inspected official [ChatGPT Live Advanced](https://docs.dataforseo.com/v3/ai_optimization-chat_gpt-llm_scraper-live-advanced/) and [query reporting guide](https://dataforseo.com/help-center/how-to-access-search-queries-data-from-chatgpt) identify result-level `markdown/items/sources/search_results/model/fan_out_queries`. Forced search does not guarantee query reporting. No new retrieval here. LLM Responses, Gemini and Google SERP are distinct contracts, not fallbacks.

`answer-mentions.ts` exports the types/helper below; `prompt-insights.ts:75–82,123–134` builds current-context subjects and matches eligible retained answers. Comparison delegates through that selector. Do not widen its OpenRouter-only answer schema or invent scraper `finishReason:'stop'`; GPT owns separate eligibility/profile.

Add a header attributing pinned `fanout-analysis.ts` behavior/stopwords to the MIT notice in `THIRD_PARTY_NOTICES.md`; root updates its destination ledger before publication. No unrelated source copy.

## Exact imports and public declarations

Only Node `node:util` (`toUSVString`) and `./answer-mentions.ts` are allowed imports. Standard globals/collections are sufficient. Use current helpers rather than a second matcher:

```ts
// Existing exports: import these, do not redeclare their implementation.
type MentionSubject = {id:string;name:string;aliases:string[];domains:string[]};
type MentionMethod = 'elmo-substring-v1'|'unicode-boundary-v1';
type AnswerMention = {id:string;mentioned:boolean;matchedTerm:string|null;cited:boolean;citationIndexes:number[]};
// matchAnswer({text,subjects,citationUrls,method}): AnswerMention[]
```

Export exactly this new seam (internal helpers/constants may remain private):

```ts
export const searchEvidenceVersion = 'dfs-chatgpt-reported-fields-v1' as const;
export const queryDerivationVersion = 'immutable-prompt-trim-lower-v1' as const;
export const queryWordsVersion = 'elmo-ascii-words-3c673d0-v1' as const;
export class SearchEvidenceError extends Error {}
export type QueryField =
 | {state:'reported'|'reported_empty'; values:string[]}
 | {state:'not_recorded'|'invalid'; values:null};
export type SearchAnswer =
 | {state:'available'|'empty';text:string;basis:'markdown'|'items'}
 | {state:'not_recorded'|'invalid';text:null;basis:null};
export type SearchEvidence = {
 version:typeof searchEvidenceVersion;
 answer:SearchAnswer;
 queries:QueryField;
};
export type DerivedQuery = {key:string;firstIndex:number;indexes:number[]};
export type QueryWord = {word:string;count:number;isStop:boolean};
export type SearchDerivation = {
 version:typeof queryDerivationVersion;
 wordsVersion:typeof queryWordsVersion;
 matcher:MentionMethod;
 queryState:QueryField['state'];
 rawQueryCount:number|null;
 blankIndexes:number[]|null;
 echoIndexes:number[]|null;
 queries:DerivedQuery[]|null;
 // Full bounded lists, not a top-N sample. Zero query population gives [].
 words:{cloud:QueryWord[];added:QueryWord[];dropped:QueryWord[];preserved:QueryWord[]}|null;
 answerState:SearchAnswer['state'];
 answerMentions:Pick<AnswerMention,'id'|'mentioned'|'matchedTerm'>[]|null;
 websiteContentCoverage:{state:'unavailable';reason:'body_corpus_not_recorded'};
};
export function normalizeDfsChatgptSearchEvidence(result:unknown):SearchEvidence;
export function deriveSearchQueries(input:{
 evidence:SearchEvidence;
 capturedPrompt:string;
 subjects:MentionSubject[];
 method:MentionMethod;
}):SearchDerivation;
```

SearchEvidence is the nested normalized evidence only, not a full stored provider-profile/provenance wrapper or completion proof. No aggregate/date/page/percentage/insight/site-match/price/registry functions; scoped selection later sums these contributions.

## Input boundary, caps and errors

Inputs are JSON-decoded/plain records, not executable plugins. Own-field/dense-own rules apply to provider, normalized evidence and argument records/arrays. MentionSubject validation delegates unchanged to matchAnswer; do not widen its arbitrary-object trust model. Reject null/non-record/array top-level input/result. No proxy/accessor/toJSON sandbox, stringify, unknown-property copy, logging, raw errors, rendering or URL calls.

Fixed `SearchEvidenceError`: **`The search evidence is invalid or exceeds its limit.`** Field malformation => field invalid; capacity => exception. No truncation/sampling. Sparse arrays invalid; lone surrogates invalid via `toUSVString`, literal U+FFFD valid. Fresh output arrays/objects, no input mutation/aliasing.

Bounds (application limits, not invented provider maximums):

- Raw queries <=100, each <=2000 Unicode codepoints and <=4000 UTF-16 units; check length before entries. Retain blank strings for explicit later exclusion.
- Answer <=250000 UTF-16 units; fallback items<=1000. Check running joined size before allocation. Transport separately bounds the entire response; do not traverse unknown fields.
- Captured prompt nonblank, <=2000 UTF-16 units, well-formed Unicode and no NUL, matching existing context-input text(2000,1). Preserve other authored controls/text; no new500-codepoint limit. Validate even without queries; do not widen authoring storage.
- Provider answer permits tab, CR and LF; reject other C0 and DEL/C1 (`U+0000–0008`, `000B–000C`, `000E–001F`, `007F–009F`). Queries reject every C0 and DEL/C1, including newline/tab. Keep ordinary Unicode whitespace until derived edge trim. These provider rules do not narrow captured authored text.
- Derived <=100 queries/400000 query units. Keep `matchAnswer` caps:101 subjects,20 aliases/domains,512 name/alias,250000 text,20M text×unique-term work. Validate subjects/method with empty text even without an answer; one real answer match, never per query. Map `AnswerMentionError` to fixed error, never silently drop matching.
- Total word entries across four lists<=20000 (sum of Map sizes, not union of keys); check before sorting. No adjustable caps or silent truncation.

Derivation validates retained normalized JSON: exact version, bounded values and coherent discriminants. Reject reported_empty/nonempty, reported/[], available/blank, empty/nonblank, or not_recorded/invalid with values. Reject unknown own keys in normalized records/derivation argument; ignore provider extras. Reuse validators, no serialize/reparse. Do not swallow programming errors.

## Normalization semantics

**Queries:** read only own `result.fan_out_queries`. Missing or null => `not_recorded`. A dense [] => `reported_empty`; a dense nonempty all-valid-string array => `reported`, preserving every original string, order, case, whitespace and duplicate. Wrong type, a nonstring/hole/invalid Unicode/control entry => whole query field `invalid` (no partial list). Exceeding limits throws. No sentinel is read from or written to the evidence field. The real provider string `unavailable` is a literal reported query; the old Elmo storage sentinel is not applicable to a new typed DFS field.

**Answer:** own `markdown` with valid non-whitespace text => available exact original markdown, basis markdown; do not trim it or consult items. Invalid non-null markdown shape/text => invalid, without masking it through a fallback. For absent/null/blank valid markdown, inspect own `items` if present. Missing/null items => empty original markdown if valid blank markdown was present, otherwise not_recorded. A dense valid item array contributes only own non-null `markdown` fields: validate every present value; trim each valid block, discard blank blocks, join nonblank blocks with `\n\n`, basis items. Ignore absent/null item markdown and unrelated keys; null-only item markdown is not_recorded unless valid blank top markdown was supplied. Any invalid item/markdown => answer invalid; capacity throws. If at least one string markdown exists but every one is blank, return empty text `''`, basis items. An empty/items-with-no-markdown array does not prove an empty answer: return empty original top markdown only if one was supplied, otherwise not_recorded. No manufactured diagnostic prose.

Field failure is independent: malformed query strings do not erase a usable answer, and malformed/missing answer does not erase actual reported queries. No `finishReason`, provider-completion flag or search-occurrence proof is fabricated.

Sources, `search_results`, model labels, costs, timestamps, task IDs, suggested follow-ups, answer prose, URL `q=` parameters and undocumented field aliases never contribute query strings. This leaf does not parse them. GPT capture retains actual source provenance separately, without dereferencing wrappers or converting search results to citations.

## Derivation and the two evidence axes

Query key: JavaScript `trim().toLowerCase()` only. No internal-space collapse, Unicode normalization, URI decoding, stemming or punctuation removal. The version explicitly records native casing/edge-whitespace behavior, not universal PostgreSQL collation/btrim equivalence.

Normalize **capturedPrompt**, never current prompt text, for echo exclusion. Blank/echo indexes remain explicit. Group other keys, retain every ascending raw index/firstIndex, order groups by first occurrence. Each group is **one execution/query vote**. Nonempty raw input with only echoes/blanks remains reported; reported_empty has count0 and [] lists; invalid/not_recorded has null count/index/query/word values. Keep raw strings only in evidence.

Run `matchAnswer` once on the available answer, supplied subjects/method and **`citationUrls:[]`**. Return only id/mentioned/matchedTerm in subject order; do not expose its false citation fields. Missing/invalid/empty answer => null, independent of queries. GPT service admits completed retained scraper answers with explicit eligibility, not ledger-status shortcuts.

Website coverage always has the exact unavailable object. Body-corpus coverage/version/provenance/retention remains a separate required feature, never inferred from these fields.

## Word algorithm, version and ordering

Match pinned Elmo's intentionally English/ASCII tokenizer: `(text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => token.length >= 2)`. Keep years and `vs`, no Unicode-aware substitution or stemming. For example `café` yields `caf`, non-Latin-only text may yield no words while its query remains real. Describe this limitation in the future UI; do not call it language-independent understanding.

For each distinct derived query in this execution:

1. Cloud increments for **every occurrence** of a non-stop token in the query, including repeated words.
2. Build distinct token sets for captured prompt and query. Added=query minus prompt; dropped=prompt minus query; preserved=intersection. Each relevant token increments once per query. These lists include stopwords with `isStop:true`; only cloud excludes them.
3. Return the full bounded lists sorted descending count, then ASCII lexical word order (`<`/`>` comparator); no locale-dependent sorting. Cloud rows always isStop=false. Counts are integers, not percentages. A later display may take top48/60 after full report totals are computed, with a declared display limit.

Exact pinned stopword set (space-separated; duplicates unnecessary):

```text
the a an and or but of to in on for with by at from as is are was were be been being do does did has have had will would can could should may might must shall what which who whom whose how when where why that this these those it its you your yours i me my we our ours they them their he she his her about into over than then there here if so not no up out off all any some more most such own too very s t re ll ve d m
```

## Later service arithmetic — required meaning, not additional leaf functions

Show query-reporting coverage separately from brand rates. Attempted includes eligible and unavailable selected attempts. Reported-array coverage counts reported + reported_empty, while genuine fan-out execution count requires at least one derived query. Missing/invalid/expired evidence is not an empty list. Average fan-out denominator is genuine-fan-out executions; zero denominator => null, not invented zero.

For query q: observations = distinct selected executions reporting q; eligibleAnswers = those with an eligible available answer; mentions = their associated answer matches. Brand rate=mentions/eligibleAnswers, null when no eligible answer. Global query-weighted rate=sum(query mentions)/sum(query eligibleAnswers). Also expose the unweighted answer rate with its different denominator. Do not describe either as website coverage. Query observations can remain positive when their answer denominator is unavailable. No ratio is rounded or calculated in this leaf.

Golden aggregation example: A mentions brand and reports q1,q1,q2; B misses brand and reports q1; C has no usable answer and reports q1. Distinct query observations q1=3, q2=1; eligible denominators q1=2,q2=1; hits=1,1. Query-weighted rate=2/3; available-answer rate=1/2. All three runs have genuine fan-out; total execution/query instances=4, average=4/3. C is not a false brand miss. Include a fourth missing-query answer in reporting/answer coverage, but not in any query denominator.

## Independent acceptance (GPT-owned synthetic Node tests)

GPT tests use Node builtins, no framework/network or weakened checks.

1. **Wire/no inference:** result markdown `Acme answer`, fan_out_queries `['best speakers']`, irrelevant search_results/URL q/follow-ups => that query only. Full tasks envelope => not_recorded, no recursive discovery. Missing/null=>not_recorded; []=>reported_empty; ['']=>reported/blank index0. Malformed query field does not erase valid answer.
2. **Raw evidence vs derivation:** prompt ` Best speakers `, queries `[' Best Speakers ',' C++ %20 + ','c++ %20 +','  ','unavailable','C++  %20 +']`. Echo[0], blank[3]; groups keys `c++ %20 +` indexes[1,2], `unavailable`[4], `c++  %20 +`[5]. Raw strings unchanged. No URI decoding, sentinel stripping or interior-space collapse. Edit a separate current prompt variable: results unchanged.
3. **Answer axis:** Acme query/different-company answer=>false; Acme answer/unbranded query=>true; empty answer=>null. Missing queries retain answer match. `Acmeology` and URL/email cases distinguish existing substring/boundary methods.
4. **Word weighting:** captured prompt `best red red shoes`; reported `['red red boots','red red boots','best shoes reviews']`. Two derived queries. Cloud red2/boots1/best1/shoes1/reviews1. Added boots1/reviews1; dropped best1/red1/shoes1; preserved best1/red1/shoes1. Stable lexical tie order. Repeated red produces one preserved vote but two cloud tokens. Separate prompt `the red shoes` with query `red boots` proves dropped the isStop=true and cloud excludes stopwords. Empty/non-Latin-only queries have truthful counts, no fabricated tokens.
5. **Markdown:** top valid wins unchanged; missing/blank top falls back to trimmed blocks joined by blank line. Absent/null/no-markdown items remain not_recorded unless top blank exists. Wrong type/Unicode/control=>invalid, not fallback. Inert `<script>` remains text.
6. **Bounds/JSON trust:** raw101 queries reject before entries;100 pass. Query2000 codepoints pass/2001 reject (ASCII/astral); prompt2000 UTF-16 pass/2001 reject, including astral pairs, all authored non-NUL controls retained. Items1000 pass/1001 reject; answer250000 pass/250001 reject. Sparse arrays, malformed records, inherited provider/normalized fields, lone surrogates and provider controls follow stated invalid/error rules; literal U+FFFD passes. Unknown provider keys omitted; retained unknown keys/incoherent discriminants reject. Errors never echo input.
7. **Determinism/no mutation/caps:** deep-freeze original synthetic JSON and subjects, run twice, compare exact outputs and inputs; mutate returned query/word arrays and confirm originals unaffected. Explicit 20M matcher overflow throws fixed error; many distinct two-plus-character words hit20k output ceiling without truncating. Runtime child timeout may bound adversarial max input if needed, following answer-mentions tests.
8. **Honest axes and future summation:** above three-execution example independently sums derived query/word contributions and answerMentions; asserts4 instances,3 eligible query votes,2 hits and distinct unweighted2answer/1hit population. Every output has body_corpus_not_recorded; source/query/answer brand occurrences do not change it. Test empty cohort is the later service responsibility, not this single-execution API.

Run tests only after the exact draft exists. Pure acceptance does not establish capture, scoped service/export, price/spending, retention, UI, other providers, body-corpus coverage or specified win/miss presentation; those remain P20 gates.

## StageA1 — fixed ChatGPT Live Advanced adapter

`src/lib/ai-search.ts` and `src/server/dataforseo-ai-search.ts` add a pure, closed `dfs-chatgpt-live-advanced-v1` profile and bounded fake-transport adapter. No service, endpoint, quote, worker, database schema, UI or paid operation is enabled by this increment. New request helpers require an explicit injected `send`; the adapter itself grants no permission to spend. Runnable check: `node --test tests/ai-search.test.ts tests/ai-search-evidence.test.ts`.

The immutable internal request contains only profileId/capturedPrompt/locationCode/languageCode. It does not accept a provider URL, model, estimate, credential, tool or payload override. Prompts are nonblank well-formed Unicode, no C0/DEL/C1 controls, at most2000 UTF-16 units including the once-escaped transport representation. Literal `%` becomes `%25`, then `+` becomes `%2B`; no other rewriting or truncation. The task has one keyword, explicit location/language, `force_web_search:true` and a server run-UUID tag. The reported model is an optional bounded consumer-interface label, never a claim of a pinned API model.

The adapter admits the exact fixed Live Advanced endpoint, one own task/result, matching endpoint path/tag/transmitted payload, decoded original result keyword and market. Charge admission is independent: matching final task identity/status and equal microUSD costs can prove a charge even when result shape, echo, field capacity or content fails. Unknown costs/statuses/bindings stay unknown; a known overrun is returned unchanged for later settlement/pause. A malformed query field does not erase a valid answer and missing/empty/invalid query states are preserved by the original leaf. No source, search_results, URL parameter or prose is mined for queries; this stage adds no citation projection. Provider timestamps and model labels remain nullable rather than replaced by local assumptions.

The new free product catalogs are distinct from SERP/Labs. Country projection validates the entire bounded returned location population (≤250,000), then returns≤300 unique country IDs/ISO codes; language rows≤1000 with unique codes. Country/language selections must be returned entries. Account identity delegates to the existing keyed v2 helper; no account login, wallet or price tree is returned. No AI account-price JSON path is invented.

Price evidence is explicitly versioned `dfs-chatgpt-live-published-2026-10-15-v1`, mode `published-tariff`, source [official LLM Scraper tariff](https://dataforseo.com/pricing/ai-optimization/llm-scraper), checked2026-10-15. Its one-result estimate is4000microUSD /0.004000USD. This is a published estimate, **not an account-enforced maximum**. StageA2 must revalidate/show this basis in an explicit quote, enforce the selected per-request and saved connection ceilings, reserve before dispatch, settle actual costs and pause on unknown/overrun. No overall app monetary cap is introduced and no remaining live-test allowance is assumed.

Transport additions are exact AI paths only: Live Advanced, locations, languages and free ai_optimization/id_list. AI POSTs≤32KiB; Live timeout150seconds/complete JSON≤4MiB; location catalog≤64MiB and other AI replies≤4MiB/30seconds. AI requests require identity encoding; nonidentity replies and declared-length mismatches fail closed. Fatal UTF-8, chunk/byte bounds, error/cancel cleanup and redirect rejection apply. Existing non-AI paths, headers, timeouts and request/response ceilings remain unchanged. No retries. Reconciliation admits a unique matching own tag/payload/endpoint and final charge; StageA2 must additionally bind the saved account and dispatch-time window and must never regenerate an answer or renew retention.

StageA2 below implements the separate quote/start/cancel/reconcile service, reservation/dispatch/settlement and raw evidence retention. Full scoped fan-out/word/brand reporting, native UI, scoped retained-body evidence, separately quoted semantic assessment with validated source spans, additional provider capability contracts and independent production/live validation remain required. Current OpenRouter executions remain the existing text/no-search profile and cannot be backfilled into recorded fan-out. Neither this adapter nor its test count completes P20 or the81-feature release.

## StageA2 schema and recovery boundary

Migration0042 adds dedicated `ai_search_quote` and `ai_search_run` records. Quote input and result are bounded JSON; the keyed v2 account identity and final run-tagged payload hash remain after raw evidence is purged. The ledger remains the sole charge source. One unfinished run per project, composite tenant/prompt/connection/ledger references, coherent leases and purge-state checks are database constraints. No previous migration or saved provider cap is changed. This schema/recovery stage alone does not enable an API, worker or paid request.

The existing reconciliation parser retains its raw-request compatibility form. Its new two-argument receipt-binding form accepts only profile/run ID/final payload hash/dispatch and observation times/optional known provider task ID. It requires a complete first ID-list page for dispatch−60seconds through dispatch+150seconds and at least150seconds of dispatch age, with a maximum28-day age. Every same-tag row counts toward ambiguity, including contradictory metadata. The single match must have a final charge, exact endpoint, bounded UTC `datetime_posted`, canonical transmitted payload hash and matching known receipt. Only this profile's percent/plus escapes are reversed; no general URI decoding or paid option is admitted. The parser returns financial metadata only, never the ephemeral prompt or an answer, and does not change retention. Account verification and actual metadata retrieval remain the future service's responsibility; unsupported provider metadata shape is inconclusive.

Provider account-key initialization, readiness and encryption rotation share the AI-aware recovery-state guard. Historical fixtures before0042 may lack the new relation. If0042 is recorded but its relation is absent, recovery fails503; an AI-only immutable fingerprint cannot cause a missing capsule to be regenerated. Focused pure checks are in `tests/ai-search.test.ts`; the separately guarded `tests/ai-search-integration.ts` covers a fresh isolated schema and AI-only recovery/constraints. Integration execution and the full service/retention/authority gates remain separate acceptance work.

## StageA2 service code contract

The dedicated browser-session service lives in `src/server/ai-search.ts`. Its source-level PostgreSQL/HTTP regression suite uses fake providers; passing it does not establish compiled-container capacity, deployment or release readiness. All paid calls still require an explicit Start. GET setup/history/detail, boot, health and recovery sweeps perform no provider request. Refresh explicitly reads the free product account/location/language catalogues. Quote repeats that free verification; no invented account-price path or automatic market fallback is used. The captured fixed published-tariff estimate remains4000microUSD and is explicitly not a remotely enforced maximum.

Under `/api/projects/:projectId/ai-search`, GET root accepts only one bounded cursor; GET `/runs/:id` accepts no query/body. POST `/catalog/refresh`, `/quote`, `/runs`, `/runs/:id/cancel` and `/runs/:id/reconcile` have strict4096-byte action bodies. All four workspace roles read; owner/admin/editor quote/start, with cancel restricted to the initiating writer or owner. Only owners reconcile. These routes are excluded from bearer scope/OpenAPI inventory. Same-origin browser mutation rules, bounded response/error shapes and fresh workspace/project authority apply. Busy preflight/deadline503 responses include Retry-After5. Setup/history returns connection metadata and50 summaries without decrypting credentials or loading raw results. Detail remains an explicit bounded retained-evidence read.

An immutable selected prompt version supplies captured text; archived/missing/moved versions are refused, and an older explicit version never advances silently. Refresh returns an opaque account/connection/catalogue scope revision; Quote must match it. Captured request, selected country/language, catalogue hashes/time, request ceiling and price evidence are closed stored JSON. Connection credentials remain AAD encrypted and server-only. Request receipts retain actor/action/result identifiers only, never duplicate prompts or answers; replay reads the current retained DTO instead of returning a cached raw payload.

Start atomically reserves the existing per-connection allowance, inserts one run and queues one retryLimit0 job. The workspace master pause and uncertain-charge controls remain; there is no aggregate app monetary cap. A fresh worker claim has120seconds for free preflight. Dispatch repeats live cap/credentials/actor/archive/input/quote/lease checks, persists before HTTP and renews the lease to180seconds for the150-second one-shot request. Only this service opts into the new closed5-second provider transaction deadline before the first workspace lock; all older provider callers keep their exact default query sequence. No SQL lock is held during a provider request. Known invalid content still settles its known cost; unknown cost pauses spending and requires owner recovery. Actual overruns are recorded and pause spending. Completion uses lease fencing independently of later actor membership.

SQL-only recovery handles at most50 queued/running candidates per pass. It never automatically replays paid work or calls metadata endpoints. Reconciliation is a separate explicit owner action using a freshly checked same account, a complete dispatch-window receipt binding and final mutable-authority checks. Inconclusive metadata is not a zero charge. Matching recovery settles charge without restoring raw output, advancing completion/expiry or clearing the spending pause.

Both raw quote input and result use the quote's creation time, including the result's duplicate captured prompt. Reads/dispatch/completion latch logical expiry; retention save atomically applies the stricter old/new raw policy with a precise SQL timestamp, so extension cannot revive expired evidence before cleanup. Cleanup clears100 results/inputs per pass; pending queued/running input is physically protected but remains hidden after logical expiry and cannot dispatch. Protected rows count as pending. Unstarted quotes older than24hours can be removed without deleting their replay receipt or any incurred ledger reference. Current-profile quotes have immutable keyed account identity even after raw purge.

Runnable checks: focused `tests/ai-search.test.ts` includes exact old/default versus opted-in provider transaction ordering. `tests/ai-search-integration.ts` preserves its three schema/account/constraint groups, then adds fake-only service groups for explicit catalogue/quote, roles, replay/concurrent one-shot execution, cancellation, known invalid charged result, uncertain charge/owner recovery and irreversible raw retention. Its synthetic ledger is explicitly3settled/1cancelled, not live spend. `tests/ai-search-boundaries-integration.mjs` adds eight actual source/HTTP groups for fresh authority after real SQL waits, deadline recovery, cap/revision/archive changes, queue rollback, raw expiry, crash fencing and owner recovery; see `docs/ai-search-boundaries.md` for its isolated execution guard. Both use synthetic credentials and fixed in-memory provider replies; actual external provider calls remain0. Compiled resource/UI/production acceptance is separate. There is no claim that the cumulativeUS$1 live test allowance is unused.

The single preflight lease is per process, not distributed, and worker batch size1 does not prove a512MiB deployment profile. Complete64MiB location JSON, parsed objects and optional geography memory still require compiled-container measurements. Native search reporting/word/brand UI, retained-body phrase evidence, separately quoted semantic coverage, other provider profiles and the remaining full81 scope are not completed by this service.

## Draft protocol

Load the supplied ponytail skill. Return only JSON {"files":[{"path":"src/server/ai-search-evidence.ts","content":"complete TypeScript source"}]}. No markdown wrapper, other paths or test claims. You have only Skill access. GPT applies and independently tests. Deadline600seconds; stop on ambiguity.
