# Static crawl graph findings

`analyzeCrawlGraph` in [crawl-graph.ts](../src/server/crawl-graph.ts) is a pure, deterministic analysis of one authorized audit's observed pages and edges. It adds exact duplicate groups, observed redirect paths, direct error-target links and scoped orphan candidates. It does not fetch pages, execute HTML, authorize origins, persist results or expose a crawl UI. Live crawler integration remains pending; this increment does not complete technical-audit parity.

The function reuses the existing [static HTML analyzer](../src/server/crawl-analysis.ts) facts. It never reparses content or copies title, description, body, anchor text or URLs into graph output. Maps, sets and an iterative functional-graph traversal provide the bounded implementation; there is no new dependency.

## Caller contract

Call `analyzeCrawlGraph(input: CrawlGraphInput): CrawlGraphResult`. The exported types are defined in the module:

| Input | Required meaning |
|---|---|
| `startPageId` | An existing frontier page ID identifying the selected starting page |
| `pages` | One record per admitted page ID: observed status/fetch state, analyzer version/coverage, the small facts projection, explicit `sitemapOnly` and observed redirect |
| `links` | Distinct or repeated observed `sourceId`/`targetId` edges; both IDs must exist and the source must have fully analyzed HTML |
| `coverage.runComplete` | The declared run finished without cancellation or a processing limit |
| `coverage.discoveryComplete` | Discovery completed for the explicitly declared scope, including its admitted sitemap/frontier work |
| `coverage.linksComplete` | All admitted observed links were processed and stored without truncation |
| `coverage.dataState` | `available` for retained graph facts; `expired` if the graph cannot be reconstructed completely |

IDs are opaque 1–64 character ASCII identifiers containing letters, digits, `_` or `-`. The caller must join records from one authorized exact-origin run only. The function cannot prove authorization, origin equality or discovery completeness from IDs. A false completeness flag is never upgraded to true. A complete sitemap document alone does not establish a complete crawl scope.

Use the analyzer's complete normalized URL for the caller's URL-to-ID mapping: preserve path case, percent escaping, query order and trailing slash; omit fragments. Do not collapse www/subdomains/ports, follow canonical declarations, or mix redirect aliases into scope. The first live crawler's query-free policy belongs in its explicit scope, not in this graph function. Any frontier or edge omitted because of a limit makes the relevant completeness flag false. Out-of-scope links are omitted. Every admitted in-scope target has an ID, including `not_fetched` placeholders.

The facts projection consists of `titleLength`, `titleHash`, `descriptionLength`, `descriptionHash`, `wordCount`, `contentHash`, `indexability`, `canonical` and `unresolvedLinks`. It requires the current analyzer version `static-html-v1` and consistent status, coverage, counts and hash/null values. A positive measured length/count requires its SHA-256 fingerprint; an observed empty value has length/count zero and a null fingerprint. Missing retained facts are not observed empty content. Unavailable/partial analyses carry null facts; shell facts can be retained but cannot qualify for duplicate or orphan findings.

A redirect is either null, `{kind:'page', targetId}`, `{kind:'outside_scope'}` or `{kind:'unresolved'}`. Non-null redirects require an observed 301, 302, 303, 307 or 308 response with `fetchState:'ok'` and analyzer coverage `redirect`. An actual outside-scope Location can be recorded without retaining its URL or granting permission to fetch it. A missing/invalid Location is unresolved. A 304 is not a redirect with an available representation.

`sitemapOnly` means the caller discovered that page through a sitemap and no other seed source. It is not inferred from zero inbound links. Observed inbound edges and redirects independently prevent an orphan finding even if an earlier discovery flag is stale. The start page is always excluded from orphan candidacy.

Structurally invalid input, duplicate page IDs, dangling edges, incompatible versions or invalid fact invariants return `status:'unavailable'`, reason `invalid_input`, no findings and zero accepted counts. Inputs beyond a graph limit return `input_limit`; expired graphs return `data_expired`. These errors contain no submitted values. This is a typed internal function over ordinary data, not a sandbox for executable JavaScript objects or proxies.

## Finding rules

| Code | Evidence required | Interpretation |
|---|---|---|
| `duplicate-title` | Fully analyzed successful HTML, `no_noindex_observed`, canonical `none`/`self`, positive title length and matching complete title fingerprint | One warning per affected page; `groupSize` is the observed eligible group size |
| `duplicate-meta-description` | Same eligibility, positive description length and matching description fingerprint | Exact normalized description matches, not fuzzy similarity |
| `duplicate-content` | Same eligibility, positive word count and matching complete normalized body-text fingerprint | Empty content never forms a duplicate group |
| `redirect-chain` | A zero-redirect-inbound chain head with at least two consecutive observed supported redirect responses | `observedHops` counts responses already seen; `terminalObserved` is 1 only if the final in-scope non-redirect response was actually received with `fetchState:'ok'` and a status |
| `redirect-loop` | A repeated node in an observed redirect path, including a self-loop | One warning per incoming chain head, or one per headless cycle; `cycleLength` and `prefixHops` describe the observed cycle |
| `broken-internal-link` | An observed edge directly to a fetched HTTP 4xx/5xx target with analyzer coverage `http_error`, excluding 401/403/407/429 | Critical diagnostic: “Linked target returned HTTP N during this audit.” A temporary server error is not permanent deletion |
| `orphan-page` | Complete declared scope, fully analyzed eligible sitemap-only HTML, not the start, no nonself inbound edge and not an observed redirect destination | Warning: “Sitemap-only orphan candidate within this audit scope.” No claim about links elsewhere on the internet |

Duplicate matching preserves the analyzer's whitespace normalization and case. Hashes cover complete values before display clipping; long values sharing a clipped prefix do not match unless their complete fingerprints match. Fingerprint equality is not a mathematical guarantee against cryptographic collisions. Each duplicate finding includes at most three other page IDs, chosen in ASCII order.

Noindex and `other`/`conflict`/`invalid` canonicals exclude duplicate and orphan candidates. An invalid canonical is never treated as self-canonical. These pages' observed links still count. Nofollow links also exist in this observed graph and count as inbound; a self-link does not rescue an orphan candidate. A redirect destination is excluded even if the redirect source itself has no inbound links.

Blocked, rate-limited, robots-disallowed, failed and unfetched targets are never called broken. The defensive 401/403/407 exclusion also applies when a fetcher classified the response as `ok`; 429 is unavailable rate-limit evidence. Non-HTML success is not broken. A link to a 301 is not relabelled with a later redirect destination's 404. Redirect path samples contain at most eight page IDs; an unfetched, outside-scope or unresolved endpoint does not erase preceding observed redirects. `terminalObserved:1` establishes receipt of a response, not successful HTTP status or site health.

Cycle detection is local to the current path and memoized across paths. Shared tails do not become false cycles. Multiple heads feeding one cycle each receive a finding; a disconnected headless cycle gets one finding at its smallest ASCII page ID. The module makes no claims about search ranking penalties or canonical selection by a search engine.

## Coverage and expiry

The result includes `ruleVersion:'static-graph-v1'`, overall `status`, fixed `reasons`, per-check coverage, accepted graph counts, exact `counts.findings`, retained findings and `findingsComplete`. Counts include deduplicated links, duplicate-eligible pages and observed eligible error targets, including error targets with no incoming link.

Positive duplicate, redirect and error-target findings can survive a partial run. Their check coverage remains partial and counts refer only to admitted observations. Empty partial findings do not mean that no problems exist. If there are no usable observations, the result is unavailable and `findingsComplete:false`.

Orphan detection requires all three caller completeness flags plus an internal coverage check. It is unavailable if any page is partial, a JavaScript shell, blocked, rate-limited, robots-disallowed, unfetched, unavailable or an unanalyzed HTTP error, or if links/redirects are unresolved. An error status can still support a positive broken-link finding while suppressing orphan absence claims. Known non-HTML responses are outside successful static-HTML link scope and are not candidates. A valid outside-scope redirect grants no extra scope; callers must still mark an incomplete entry-page redirect run incomplete.

Reason codes are `run_incomplete`, `discovery_incomplete`, `links_incomplete`, `page_coverage_incomplete`, `unresolved_links`, `unresolved_redirect`, `findings_limit`, `invalid_input`, `input_limit` and `data_expired`. `checks.orphans:'unavailable'` is not an orphan count of zero.

The future persisted crawler applies the workspace defaults: raw title/description/anchor evidence uses `rawProviderEvidenceDays` (90 days by default); retained graph IDs, normalized facts/fingerprints and derived findings use `derivedHistoryDays` (365 days by default). Fingerprints are not an anonymization guarantee. Raw evidence expiry does not turn known facts into empty values. Derived findings may remain readable with separate evidence-expired labels. Once graph data has expired, do not recompute from remaining rows: pass `dataState:'expired'` and retain an explicit unavailable receipt. This module implements no persistence or deletion worker.

## Bounds, ordering and verification

- At most 10,000 frontier pages and 100,000 input link records. Repeated edges count toward the input bound and are deduplicated for analysis. Each redirect has at most one target.
- At most 10,000 finding records are retained. The bounded scan continues to calculate the exact total; overflow sets `findingsComplete:false`, reason `findings_limit` and overall status partial. Per-check coverage describes the analyzed scope, while `findingsComplete` separately describes output availability. No arbitrary first-page prefix becomes a complete graph.
- Finding order is fixed: title duplicates, description duplicates, content duplicates, chains, loops, broken links, orphans; within each code, ASCII page ID then target ID. Keys are `static-graph-v1:code:pageId:targetId-or-empty`. The containing run supplies the persistence namespace. Counts, sample order and time are not identity inputs.
- Duplicate grouping and iterative redirect classification are linear in admitted pages. Each link is processed once after deduplication; stable sorting costs at most O(P log P + E log E). Samples are bounded rather than copying every long path or duplicate group for every page. There is no recursion, network I/O, random input or locale-dependent sorting.

Run the focused checks with:

```sh
node --test tests/crawl-graph.test.ts
```

The synthetic groups cover actual analyzer fingerprints and case/clipping, canonical/noindex exclusions, merged redirect paths and cycles, observed versus unavailable errors, strict complete-scope orphan gates, invalid/expired inputs, reorder determinism, 10,000-node long paths/large groups, 100,000 edges and exact finding totals after truncation. These checks are algorithmic acceptance, not a live crawler, capacity benchmark or security certification.

## Source basis

This is an original implementation informed by the pinned MIT OpenSEO source at `89e5a00717cdf049b7c2b4e29646edb3a7d4995b`: [multipage checks](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/audit/issues/multipage-checks.ts), [page filtering](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/audit/issues/multipage.ts), [scratchpad joins](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/features/audit/scratchpad-sql.ts) and [issue registry](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/shared/audit-issues.ts). The stricter observed-status, complete-scope, expiry and access-restriction guards above are explicit local behavior. No upstream database runtime or issue-engine code was copied.
