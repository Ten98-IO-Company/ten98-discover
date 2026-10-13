# Bounded robots policy evaluation

This is a pure module supporting the future P53 crawler. It does not fetch, schedule, authorize credentials, resolve DNS, or implement a live crawl. No new dependency or third-party implementation code was copied. The earlier robots-parser candidate failed the retained regression cases; this module is original code following the policy semantics below.

## API

`parseRobotsPolicy({robotsUrl, body, productToken})` returns a frozen `RobotsPolicy` with `status: 'ready' | 'unavailable'`. A ready policy contains the normalized origin, explicit product token, applicable rules, sitemap observations and `crawlDelaySeconds`. An unavailable policy supplies a stable reason. Supply the initial authority's `/robots.txt` URL even when a future fetch follows redirects. Never substitute a redirect target's authority.

`body` accepts a string or UTF-8 `Uint8Array`. Bytes are decoded with a fatal decoder. Strings must already be decoded UTF-8 and are additionally checked for malformed UTF-16 with `toUSVString`; the function cannot recover evidence lost by an upstream lossy decoder.

`evaluateRobotsPolicy(policy, targetUrl, {maxCrawlDelaySeconds?})` returns:

- `status`: `allowed`, `disallowed`, or `unavailable`.
- `reason`: the policy/input limit, `origin_mismatch`, `invalid_target_url`, `invalid_target_encoding`, `invalid_delay_capacity`, `crawl_delay_not_supported`, `match_work_limit`, `implicit_robots`, `matched_rule`, or `no_matching_rule`.
- `matchedLine`: a one-based source line for a completed rule decision, otherwise null.
- `crawlDelaySeconds`: the maximum applicable valid observation, or null.
- `work`: deterministic character comparisons/DP cells used by this evaluation.

`unavailable` means **stop this scope without a permission decision**, not the RFC HTTP 4xx status category. Never coerce it to allowed, silently remove a costly rule, or publish the crawl as complete. An `allowed` answer remains only a robots decision: it grants no network, project, provider, credential or rate-limit permission.

## Matching and parsing

[The RFC 9309 group and matching rules](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2.1) establish case-insensitive product-token matching, merging of matching groups, wildcard fallback, longest-rule precedence and allow on equal specificity. The token is an explicit letters/underscore/hyphen identifier, not the complete HTTP User-Agent. An empty matching group still excludes wildcard fallback. Unknown records and observations do not separate adjacent user-agent headers. Rules before any group are ignored.

The implementation strips a leading BOM, comments and ASCII surrounding whitespace; accepts CR, LF and CRLF; and ignores malformed ordinary records while retaining valid rules. Unsupported percent representations in an applicable rule return unavailable. Unreserved percent escapes normalize; encoded reserved slash remains distinct from a path separator. UTF-8 paths compare in normalized ASCII percent form. Raw rule stars and terminal dollar signs retain syntax; encoded literal stars/dollars match those literal URL characters. Specificity is the normalized ASCII rule length, including wildcard/end-marker characters. `/robots.txt` without a query is implicitly allowed. Fragments do not participate in request-path comparison. [RFC 9309 path and special-character semantics](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2.2)

All entry URLs must be absolute, credential-free HTTP(S), without whitespace, controls or backslashes. Input and serialized URL forms are limited to 2,048 UTF-8 bytes. Evaluation compares normalized origin exactly, including scheme and nondefault port. This URL check deliberately does not replace public-address checks or DNS pinning.

Trailing wildcard equivalence concerns the set of matching paths, not necessarily precedence. Google's [pinned matcher at 22b355f, lines 642–649](https://github.com/google/robotstxt/blob/22b355ff855419e6a3ff8ff09c0ad7fdb17116f9/robots.cc#L642) uses the entire pattern length as priority; its [trailing-wildcard tests](https://github.com/google/robotstxt/blob/22b355ff855419e6a3ff8ff09c0ad7fdb17116f9/robots_test.cc#L561) check matching against a shorter root restriction, not an equal-prefix precedence tie. This module preserves full normalized length: `Allow: /foo` loses to `Disallow: /foo*`; `Allow: /foo********` ties the length of `Disallow: /foo/private`, so allow wins. Redundant stars can therefore affect priority. The focused tests make this behavior explicit; the upstream C++ implementation was inspected, not compiled here. This does not import Google's permissive User-Agent extensions: headers such as `TenMonitorBot/1.0` or `TenMonitorBot*` are malformed records, and a caller must supply the strict product token.

## Bounds and observations

The complete body cap is **512 KiB**, exceeding the RFC's 500 KiB minimum; oversized input yields `body_limit` rather than silently truncating a restrictive tail. There is no shorter line limit. The caller's product token is capped at 128 characters. [RFC 9309 limits](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.5)

Non-wildcard rules use bounded literal comparisons. Wildcards use two rows of dynamic programming, with no generated regex or recursive/backtracking matcher. Every evaluation has a cumulative **2,000,000-step** ceiling across all rules. Exhaustion returns unavailable even if an earlier allow matched. This intentionally trades some high-cost valid policies for explicit incomplete coverage. Repeated calls are independent; the future caller must also bound URL count and total run work.

`Sitemap` values are observations only: at most 100 valid credential-free HTTP(S) URLs, each under the common URL cap. Invalid observations are ignored; exceeding the observation count returns `sitemap_limit`. External origins may appear in observations and are never authorized by them. `Host` does not change scope. Do not treat observation output as permission to fetch.

`Crawl-delay` is an optional extension, not a core REP scheduling rule. The selected groups' values must be finite, nonnegative decimal seconds; malformed/unsupported values produce `unsupported_crawl_delay`. The maximum value wins. Positive delays return unavailable by default; a caller must explicitly supply finite `maxCrawlDelaySeconds` capacity at least that large **and actually schedule the wait**. This module performs no waiting. Neither clamping nor ignoring an excessive delay is permitted.

## Remaining live-integration boundary

Parsing and matching must run in an isolated child with parent-enforced wall-clock/heap caps; a timer in a blocked event loop is insufficient. The byte/step limits do not establish process RSS capacity or contain repeated jobs. Bound compressed and expanded input, concurrency, URL count and total run work. Preserve exact unavailable reasons in coverage rather than reporting zero findings.

HTTP status handling, safe redirects, cached-policy age, fetch interruption, public network validation, scoped credentials and queue authorization are separate future work. In particular, a network failure/5xx cannot be treated as an empty allow policy, and redirected robots rules remain attached to the initial authority. This increment does not claim full live RFC access-method conformance or completion of P53.

## Runnable checks

Run `node --test tests/crawl-robots.test.ts` on Node 24. Eleven focused groups cover the dependency's encoding/group failures, empty specific groups, ordinary malformed lines, literal/wildcard/end syntax, longest/tie and trailing-wildcard precedence, initial origin and unsafe URLs, BOM/UTF-8 and exact 512 KiB tails, delay/observation limits, and deterministic cumulative hostile-work exhaustion. No DNS, HTTP, provider, database or queue is used.
