# Static page analysis

This is a pure analysis module for the future crawler, not a runnable crawl or completion of P53–P56. It performs no network, database, browser, provider, queue or file operations. No HTML is rendered. `analyzeCrawlPage` uses the already installed parse5 8.0.1 and Node's SHA-256 implementation.

## Input and result

The caller supplies the observed URL, status, fetch classification, MIME type, fully decoded HTML, explicit `bodyComplete`, response time, link depth, and only the `Link`/`X-Robots-Tag` header values. Transport authorization, charset decoding, byte/decompression limits and challenge detection belong to the future caller. The function does not infer a WAF challenge from arbitrary page text. URL normalization here is extraction, never permission to fetch a host.

Results contain:

- `coverage`: analyzed, shell, partial, unavailable, blocked, rate_limited, robots_disallowed, not_fetched, http_error, redirect or non_html.
- `facts`: measured counts, lengths, hashes and declaration states, or null when complete content analysis is unavailable. Zero length means observed missing/empty; null facts do not mean empty content.
- `evidence`: bounded extracted text and URLs, or null. This is **raw short-lived evidence**, not a durable public DTO. Never persist or serialize the whole result into long-lived reports without applying retention and authorization.
- `findings`: fixed codes/severity with numeric details only. They contain neither copied body text nor raw URLs.

No body text or original markup is returned. `contentHash` covers whitespace-normalized text extracted from the body. Scripts, styles, noscript, templates, SVG/MathML subtrees and explicitly hidden/aria-hidden text are excluded. CSS layout/visibility, browser-generated content and computed accessibility are not evaluated. Inline text remains adjacent; block boundaries separate words. This is static text extraction, not a browser's visual page measurement.

`indexability` deliberately means `noindex_observed`, `no_noindex_observed` or `unknown`, never “indexed by Google.” Generic and Googlebot meta/header directives combine conservatively; another bot's scoped directive is not applied to Googlebot. The observations do not evaluate unavailable_after deadlines, actual search indexing or robots.txt. A suspected shell remains unknown unless an explicit noindex was observed.

## Rules and completeness

The module implements the pinned OpenSEO per-page baseline: blocked/rate-limited/server/broken pages; slow response; noindex; conflicting and other-URL canonical declarations; deep page; suspected JavaScript rendering; title/description missing/length hints; missing/multiple H1; skipped heading level; thin content; absent image alt; and no outgoing HTTP(S) links.

Length boundaries follow the source's JavaScript UTF-16 lengths: title below 10 or above 60, description below 70 or above 160. Thin content is below 150 extracted words; slow response is strictly over 1,500 ms; deep means link depth at least 5. These are versioned review heuristics, not ranking penalties. The caller must label what its `responseTimeMs` measures; this module does not call it TTFB or Lighthouse performance.

Partial/oversized/invalid HTML has no content facts or missing-content findings; an independently observed slow response can remain. HTTP 204/205 has no document; 206 is partial; 304 without cached representation is unavailable. Unsupported MIME, including XHTML requiring XML semantics, is not analyzed as HTML. A fully read empty 200 HTML document is different: its missing fields were observed.

A shell requires a known app-root ID, executable script, fewer than 20 extracted words, and no headings/images/HTTP links. Head and body scripts are considered; JSON-LD alone is not executable-script evidence. Shells can retain declared canonical/noindex and depth observations but suppress title/description/headings/thin/alt/outgoing findings. This heuristic identifies suspected shells, not every JavaScript application.

Canonical extraction retains distinct HTML/header declarations, resolves HTML against the first document base and HTTP Link against the response URL, and handles quoted header delimiters. Header links with another `anchor` context are ignored. Multiple distinct valid declarations conflict; malformed canonical evidence is invalid rather than silently self-canonical. Query order, pathname case and trailing slash are preserved; fragments are removed. External canonical declarations grant no network authority. Empty alt is allowed for decorative images. Invalid/unsafe HTTP link targets increment `unresolvedLinks`, suppress a false no-outgoing result and must prevent later claims of a complete link graph.

## Resource and storage contract

Input HTML is at most 1 MiB, allowlisted headers at most 16 KiB/100 values, and URL values at most 2 KiB. The DOM walk permits 20,000 nodes and depth 128. Extraction permits 1,000 distinct link targets, images and headings, plus 100 head meta/link annotations. Exceeding a cap returns partial, with no content facts, rather than treating a truncated collection as complete. parse5 builds its DOM **before** the node/depth walk. The byte cap limits input, while the extraction caps do not bound parser CPU or DOM allocation. Before live worker integration, parsing must run in a disposable child/worker with enforced deadline and heap/resource limits; never call this module on the web or main job event loop with live untrusted HTML. This is an open integration gate, not delivered isolation.

Evidence strings are clipped on Unicode codepoint boundaries (2,048 characters, anchor 200, hreflang label 100); facts use the original complete values. Directive evaluation occurs before clipping. Images and Open Graph URLs are not fetched. Structured-data presence is not JSON/schema validation; hreflang presence is not a language/reciprocity audit.

Future persistence must expire `evidence` using rawProviderEvidenceDays (90-day default), including title/description, headings, anchors, robots strings and query-bearing URLs. Preserve an explicit evidence-expired marker instead of replacing the original with apparently genuine empty strings. Counts/hashes/declaration categories and numeric findings can use derivedHistoryDays (365-day default). No retention worker or storage schema is supplied in this increment. Hashes are comparison evidence, not an anonymization guarantee. Consumers must render extracted strings as text and must not use evidence URLs as authorization to fetch or execute content.

## Source and verification

This is original code implementing source-observed semantics, not copied upstream application code. The source baseline is MIT OpenSEO `89e5a00717cdf049b7c2b4e29646edb3a7d4995b`: [page reporters](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/audit/issues/page-reporters.ts), [HTML analyzer](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/audit/page-analyzer.ts), [issue descriptors](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/shared/audit-issues.ts). Existing dependency notices remain unchanged.

Run `node --test tests/crawl-analysis.test.ts` on Node 24. Ten fixture groups cover all per-page codes and equality thresholds, actual parse5 extraction, canonical/header contexts, scoped directives, shell/error/partial suppression, unsafe URLs, Unicode and cap boundaries. TypeScript also passes. No live crawling, browser/provider validation, graph analysis, robots discovery, scheduling, performance scores, capacity claim or UI is included.

A contained Node 24 probe used separate children, `--max-old-space-size=64`, a 2,000 ms deadline and 16 KiB output cap. Flat `<i></i>` tags (980,000 bytes) and adoption-formatting `<b><i></b></i>` (980,000 bytes) returned `partial:tree_limit` in about 299/301 ms. Deep unclosed `<div>` nesting (950,000 bytes) exceeded the deadline and its child was terminated at about 2,026 ms. These observed local times establish the need for isolation; they are not general capacity guarantees. No live input or network was used.
