# AI insights from retained answers

> Code and safety contracts retained from [docs/ai-insights.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/ai-insights.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/ai-insights-from-retained-answers-implementation-history-4flwkY6q5i). Qualifications are preserved; this adds no acceptance claim.

## Evidence and measurement

The pinned [Elmo matcher](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/packages/lib/src/mentions.ts#L24)
uses case-insensitive substring matches against names, aliases and bare domains.
The pinned [OpenSEO matcher](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/ai-visibility/services/aiVisibilityMatching.ts#L5)
separates prose mentions from citation domains and excludes URL/email spans from
prose matching. These are different methods. Preserve a labelled Elmo baseline
and a separately versioned original Unicode-boundary method; never merge scores
without identifying the method. A negative statement containing a name is still
a mention, not a sentiment score. Short ambiguous aliases remain the author's
responsibility and the substring baseline can match inside unrelated words.

One prompt-execution child is one observation; a two-model comparison contributes
two observations. Replaying the same execution ID does not add an observation.
Eligible answers are retained, validated, non-whitespace text with finishReason
`stop`, independently of financial status. A charge-only reconciled receipt has
no answer. Show attempted, queued/running, failed/no-answer, empty, truncated
`length`, `content_filter` and expired coverage separately. Never treat those
excluded observations as negative mentions.

For a fixed displayed own-brand/competitor set:

- Visibility: distinct eligible answers mentioning an entity divided by all
  eligible answers. An entity counts at most once in each answer.
- Share of voice: that entity's answer matches divided by the sum of entity-answer
  matches across the displayed set. An answer may match several entities.
- Return integer numerators and denominators. Round only for display. Include
  zero-hit entities. With eligible answers and no mentions, visibility is zero
  and share of voice is unavailable. With no eligible answers both are unavailable.
- Citation-domain hits remain a separate metric, sourced only from actual
  provider citation annotations. A prose URL is not a provider citation.

Existing executions capture prompt versions, rendered input, requested/resolved
models and provider route, but no historical brand/competitor identity snapshot.
Label this view **Recomputed from retained answers using current project context**.
Use current own-brand context and stable competitor IDs; return contextRevision,
profileHash, matcherVersion and asOf. Do not imply current aliases or tags existed
when an older answer ran. Serving/redirect aliases and key-page URLs do not
automatically become brand identities. OpenRouter API output with web search off
is not a consumer ChatGPT/search observation. Unrecorded market/language remains
unrecorded; a resolved model name does not establish its exact underlying version.

Daily trends initially use actual observations only, with null on missing days.
No carry-forward or backward seeding. Source-compatible historical comparisons
remain required and must expose their population/method: Elmo's carried values
and OpenSEO's matched-cell/coverage comparison are not the same formula.
The existing quote input hash includes pricing and selected model lists; it is
not a valid semantic comparison-cell identity.

The [adjacent-period comparison](ai-period-comparison.md) adds a separately
labelled current-context, equal-cell method. It compares equal local-calendar
ranges, requires retained copied settings to identify cells, and exposes changes
only for closed periods with shared cells and sufficient collection coverage.
It does not implement carried values or captured historical identities.

## Workflow and service boundary

All current project members can read/export. AI insights opens without collection.
Choose a date range/timezone, supported model/prompt/current tag filters and a
matcher, then Apply. Show eligibility coverage, entity metrics, daily observations
and exact execution drilldown. Link to existing answer receipts and prompt setup.
Changing unapplied filters does not relabel an already displayed report.

Reuse withContentProject(false), repeatable-read membership and existing raw-answer
retention masks. No new persistent analysis dataset is needed for recomputation.
Raw evidence retention still governs answer availability; the derived365-day
preference does not retain missing answers. Page/export selections bind context,
applied scope, matcher and exact execution/result availability; changes reject
with409, rather than mixing pages or reviving tombstones. CSV preserves provenance
and counts, uses existing formula protection, and requires the displayed revision.

Use explicit31-day/1000-execution/10MiB retained-answer limits. Check count
and byte bounds before loading payloads; reject with **Narrow the date range**,
never silently sample or truncate. The conservative report CPU cap is100million
text-unit/term operations; the actual matcher benchmark at that cap took97ms
for Unicode and7ms for substring on the local acceptance host, not a deployment
performance guarantee. The pure matcher has a20million per-answer work bound.

## Pure Kimi matcher contract

Implement only `src/server/answer-mentions.ts`. Export exactly these declarations:

```ts
export type MentionSubject = {
  id: string; name: string; aliases: string[]; domains: string[];
};
export type MentionMethod = 'elmo-substring-v1' | 'unicode-boundary-v1';
export type AnswerMention = {
  id: string; mentioned: boolean; matchedTerm: string | null;
  cited: boolean; citationIndexes: number[];
};
export class AnswerMentionError extends Error {}
export function matchAnswer(input: {
  text: string; subjects: MentionSubject[]; citationUrls: string[];
  method: MentionMethod;
}): AnswerMention[];
```

No I/O, environment, dependencies, logging, clocks, randomness or mutation.
Standard URL and Unicode regex/string methods are available. Native toUSVString
from node:util may check Unicode. JSON-decoded values are the boundary; arbitrary
JavaScript accessors/prototypes are not a plugin sandbox. Return only the declared
fields, in subject order. All malformed inputs throw AnswerMentionError with the
fixed safe message `The answer matching input is invalid or exceeds its limit.`
Do not echo raw text or subjects in errors. No other files or tests in this draft.

Validation and limits:

1. Require the exact method, a valid-Unicode string text of at most250000 UTF-16
   units (empty is allowed here; GPT owns eligibility), arrays of0–101 subjects
   and0–100 citation URL strings, and no sparse array entries. Text may contain
   line breaks. Every subject requires a unique nonempty id up to100 units, a
   nonempty name up to512 units, and arrays of at most20 aliases/20 domains.
   Each alias is at most512 units. Names/aliases/IDs are valid Unicode, have no ASCII controls, and have no leading
   or trailing whitespace. Aliases must be nonempty. Unknown object fields are
   ignored, never copied. Citation strings are valid Unicode, at most8192 units;
   empty or syntactically invalid URLs yield no citation hit.
2. Domain inputs are nonempty hostnames of at most253 units. Reject schemes,
   credentials, ports, paths (including backslashes), query/fragment, percent
   escapes, whitespace, IP addresses and empty
   labels. Parse using native URL with an https prefix for IDN normalization;
   lowercase, strip one trailing dot and one leading `www.`. The normalized ASCII
   hostname must also be at most253 characters. Require at least
   two ASCII DNS labels, each1–63 characters, letters/digits/hyphens, no leading
   or trailing hyphen. Domain comparison uses the resulting ASCII hostname.
3. Build each subject's terms in deterministic order: name, aliases, then
   normalized domains for the substring method only. Deduplicate case-insensitive
   equal terms within the subject, preserving the first display term. For the
   Unicode method, use NFC+lowercase comparison and collapse whitespace runs to
   a single space for deduplication. Before scanning, require
   `text.length * max(1,totalDeduplicatedTerms) <= 20000000`; reject on overflow.
   This is an application CPU guard, not a measurement sampling rule.

Matching semantics:

- `elmo-substring-v1`: use ordinary JS lowercase, no Unicode normalization, and
  literal substring matching over the original answer. URLs/emails are not
  removed. The first matching term wins; repeated matches/alias overlap do not
  increase counts. Return its supplied display term, or normalized bare domain.
- `unicode-boundary-v1`: use NFC canonical normalization and ordinary lowercase;
  do not remove accents or transliterate. Names/aliases only, not domains.
  Mask URL/email spans with spaces before matching. URL spans begin at
  `http://`, `https://` or `www.` case-insensitively and continue until whitespace
  or an angle bracket; email spans use the bounded ordinary ASCII address pattern
  `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`.
  This lexical exclusion is not an RFC email parser. Literal term whitespace
  runs match one-or-more JS whitespace characters. A hit requires either string
  edge or a character outside Unicode letter/mark/number/underscore on both sides.
  Escape all regex metacharacters in terms; never execute a user-authored regex.
  One-character terms use the same boundary rule. Terms retain meaningful
  punctuation. Return the first matching original name/alias; no guessed offsets.
- Citations for both methods: parse only http/https URLs with no username or
  password. Normalize the hostname as above (ports are allowed on citation URLs,
  but do not affect hostname identity). A target domain matches exact hostname
  or a dot-delimited subdomain. `example.com.evil` and
  `https://example.com@evil.test` never cite example.com. Keep every matching
  original citation index once, in ascending order; do not infer citations from
  answer text. Invalid citation URLs are ignored. Citation detection does not
  imply a prose mention, and prose mention detection does not imply a citation.

GPT owns independent golden tests, performance bounds, eligibility, scoped SQL,
revision/cursor/retention correctness, controller and visual acceptance. Coverage
must include canonical Unicode, literal punctuation, short-name false positives,
negative prose, aliases/repetition, URL-only/citation-only, hostile suffix/userinfo,
IDN/www, null denominators, changed context, actual drilldown reconciliation and
zero unexpected provider traffic. This matcher is not accepted merely because
Kimi generated a file.

## Retention and receipt invariants

Charge reconciliation preserves the original answer completion timestamp, so
settling an old charge cannot restart its raw-evidence retention period; the
nine-group execution suite verifies this regression and existing paid-work gates.
The shared receipt read path also masks expired answers and copied input before
cleanup runs. Pending children protect required input; permanent purge markers
remain unavailable when retention is extended. Both insights and receipt reads
use elapsed24-hour policy days independent of the database session timezone;
explicit DST and exact microsecond-boundary checks cover this distinction.

The receipt controller also remembers expiry learned from a run summary before
loading its detail, so a later stale response cannot redisplay a known-expired answer.

## Closed-corpus semantic content support (C3)

The browser-only `/api/projects/:projectId/ai-content-support` family separates
model judgments from brand mentions and the free literal website-text check.
There is no paid entitlement. The current writer gate is owner-only evaluation;
all current member roles can read retained results and request a fresh export.
Model quality remains unverified, including when every citation has valid provenance.

`GET /` and `GET /runs` return setup/history with one optional cursor;
`GET /runs/:runId` returns the current retained detail. `POST /quote` accepts the
strict `contentSupportQuoteInputSchema` (32 KiB whole body): explicit connection,
model, funded-credit/evaluation acknowledgments, positive `maxSpendUsd`, an exact
capture or current applied project selection, both query/corpus receipts, 1–5
query IDs and 1–20 selected page IDs. It accepts no text bodies, costs, keys or
provider-routing overrides. The server materializes only those complete bodies,
at most64 KiB; messages+schema128 KiB, wire request160 KiB and output2048 tokens.
The complete project population is checked before selecting IDs, including keys
outside presentation cuts. Quotes do not send an inference.

`POST /runs` takes only `{quoteId,requestId}` and atomically reserves the verified
ceiling, creates one run and queues one job with retryLimit0. The quote lasts five
minutes, measured by native SQL time after waits. Current owner/source receipts,
original source clocks, key identity, connection revision, exact model/provider
route and conservative prices are rechecked before dispatch. The editable
connection monthly cap, master pause and any uncertain workspace charge apply;
there is no additional app-wide cap. `POST /runs/:runId/cancel` takes `requestId`
and cancels only unsent work. A dispatched request is never automatically retried.

The existing provider transport persists an actual generation header before body
parsing. Known charges settle even when output is refused, incomplete, too large,
invalid, or current authority changed. An unknown charge stays `actualUsd:null`,
marks the run uncertain and pauses further spending. `POST /runs/:runId/reconcile`
with a stable `requestId` reads only the original generation metadata, requiring
the original key/model/provider/session/actor/time identity. It can reconcile after
source purge, never recreates text and leaves spending paused for owner review.

Inputs/results inherit the earliest original query-quote and audit completion
retention clocks; a new quote/response does not renew them. Policy shortening
atomically latches every due copy under the old/new minimum before commit. Expiry
is irreversible after extension; physical cleanup is at most100 inputs and100
results per project tick. Source deletion/revocation or changed receipts mask
content while financial hashes, route and generation identity remain recoverable.

`POST /runs/:runId/export` takes the actual payload/result/query/corpus hashes.
It rechecks current membership/source twice around CSV generation. The complete
CSV is at most2 MiB, uses existing formula-safe escaping and exposes only selected
query judgments and exact cited spans, never full page bodies. Hash and row-count
headers accompany the exact content length; responses are no-store. Browser POSTs
require the configured application Origin. Bare API keys cannot invoke this
purpose; mixed cookie+Bearer is400 and bare Bearer is403. Request IDs replay only
identical normalized actor/body operations, returning current safe DTOs.

Backend code is not release acceptance: native fake-provider financial/security
tests, broader writer admission, UI, held-out multilingual quality evaluation and
compiled/resource/regression gates are separate required checks. No live API
allowance is implied by this implementation or by a successful synthetic test.
