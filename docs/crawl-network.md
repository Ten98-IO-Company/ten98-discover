# Bounded crawler download transport

`fetchCrawlDocument(rawUrl, kind, signal?)` in `src/server/crawl-network.ts` performs one native HTTP(S) GET for `html`, `robots`, or `sitemap`. It returns a complete `Buffer` only after the entire HTTP message and every decoder finish. Otherwise `complete:false`, `body:null`, and a fixed reason describe unavailable coverage. Status, safe headers, observed byte counts and timings survive body failures when available. No partial bytes, raw exceptions, request URL or resolved IP are returned.

This is a transport building block, not a running crawler or a parity completion claim. It does not approve scope, check robots policy, follow redirects, retry, wait for Retry-After, decode UTF-8, parse documents, make paid calls, or write to a database. Future workers must authorize the exact origin, apply robots and per-run budgets, and validate every next redirect URL separately. The existing redirect-check transport remains header-only and unchanged.

## Network boundary

The existing `redirectUrl` and `resolveRedirectHost` enforce URL syntax and per-call DNS resolution. URLs are at most 2 KiB; credentials, nondefault ports, local/special addresses and ambiguous numeric hosts fail closed. Both A and AAAA answers must resolve successfully (an absent family may return ENODATA), with 1–32 combined answers, all public and of the declared address family. An unavailable family is not silently ignored.

The first vetted address is pinned to a dedicated native HTTP(S) agent, with environment proxies disabled, no connection reuse or fallback. Lookup checks the exact original hostname; the connected remote peer must match the pinned address. HTTPS retains certificate validation and the original DNS TLS name. The fixed request identifies `TenMonitorBot/1.0` and asks for `gzip, identity`; no cookies, authentication, referer or caller-supplied headers are sent. URL queries are transient request inputs, never durable evidence by this function.

One 15-second deadline covers DNS, connection, headers, body and asynchronous decoding. The shared resolver additionally bounds its DNS attempts. Caller cancellation cancels that resolver and destroys owned native request/response streams, decoder streams and agent. Pipeline completion/error is awaited before returning; no decoded body is returned after cancellation. Timers and caller abort listeners are removed. These are process-level resource controls, not an OS sandbox or an absolute wall-clock guarantee during unrelated event-loop starvation.

## Response and compression policy

Native HTTP header parsing is strict and limited to 16 KiB. The returned allowlist is Content-Type, Content-Encoding, Location, Retry-After, Link and X-Robots-Tag. Duplicate singleton fields, including internal Content-Length/Transfer-Encoding, fail closed; Link and X-Robots-Tag may repeat and retain their separate values. Location is at most 2 KiB and is **untrusted transient data**: it may include a query or a private address. A caller must validate it before following it and remove sensitive parts before storing evidence. No other response header is retained.

Redirects, errors, 204/205/304 and partial 206 responses retain headers without consuming arbitrary bodies. HTML additionally requires `text/html` or `application/xhtml+xml`. Other MIME types, including a missing HTML Content-Type, produce `unsupported_mime`. Robots and sitemap document-format validity is left to their separate parsers; status and headers are not proof of a valid policy/XML document.

Native HTTP transfer framing must be absent or chunked; other transfer-encoding chains are unsupported. Only absent/identity and gzip HTTP content encodings are supported in this increment. Brotli, deflate, empty and stacked encodings produce `unsupported_encoding`; they never become a valid empty document. Limits are operational capacity, not evidence that a page or sitemap is invalid:

| Kind | HTTP payload bytes | Each decoded stage |
| --- | ---: | ---: |
| HTML | 1 MiB | 1 MiB |
| Robots | 512 KiB | 512 KiB |
| Sitemap | 5 MiB | 5 MiB |

`wireBytes` counts actual HTTP payload bytes after HTTP framing removal, before content decoding; it is not total TCP/TLS bandwidth. `httpDecodedBytes` counts output from the HTTP content-decoding stage, and `decodedBytes` counts final document output. With identity encoding they initially match. Failure counters can include the final rejected stream chunk and are incomplete observations, never claimed complete content lengths. A declared Content-Length cannot bypass the counters; an observed length mismatch or premature HTTP termination fails closed.

Gzip uses asynchronous, destroyable Node zlib streams, never synchronous inflation. Every stage counts before retaining bytes. CRC/truncation/invalid streams and any unconsumed trailing input (including zero padding accepted by zlib itself) produce `invalid_compression`. Valid concatenated gzip members are accepted within the same output limit.

After HTTP decoding, sitemap bytes starting with gzip magic may pass through **one** additional bounded file decoder. A `.gz` suffix alone does not trigger decoding: ordinary HTTP-gzipped XML at `sitemap.xml.gz` is decoded once, while a gzip HTTP representation containing a gzip file is decoded twice. Any still-gzipped result is unsupported. HTML and robots with remaining gzip magic are unsupported rather than silently treated as replacement-character text. Charset/UTF-8 validation remains the parser's responsibility.

Each output stage preallocates one zero-filled buffer at its fixed kind capacity (1 MiB, 512 KiB or 5 MiB), copies only after checking the byte count, and returns the written subarray. It never retains one object per incoming chunk: fragmented responses otherwise amplify small byte counts into large heaps. The optional sitemap file stage retains the bounded HTTP intermediate plus a second 5 MiB output buffer transiently; native stream/zlib buffers and runtime objects add overhead. These are bounded body buffers, not a full-process RSS limit. No full downloaded page text or headers should be copied into long-lived evidence: the future analyzer/retention pipeline owns bounded snippets and expiry.

## Verification

Run `node --test tests/crawl-network.test.ts`. Nine test groups cover URL/all-answer DNS/peer guards, native request settings, no automatic follow/retry, MIME/status/header decisions, exact wire and expanded limits, Content-Length lies, nested/concatenated/truncated/trailing/checksum-invalid gzip, total deadlines and caller cancellation at DNS/headers/body/decoder stages.

The contained child fixture blocks every external socket. It first proves proxy bypass and header-stall cancellation, then routes only fixture requests to its owned loopback server with an explicit **test-only** peer override. Real Node HTTP parsing exercises completed, truncated Content-Length/chunked, truncated gzip, duplicate and oversized headers; removing that test-only override confirms connected-peer rejection. Production code has no loopback bypass or injectable transport. A separate fragmented-input child uses a 192 MiB V8 old-space limit and 20-second parent deadline for 1 MiB of fresh one-byte HTTP chunks; it checks complete output without retaining a million Buffer objects. This ceiling is a regression check, not an RSS guarantee. No live site, paid provider, database, browser, Docker build or scheduler was exercised.
