# Supplied sitemap XML analysis

This internal P53 component parses supplied XML. It does not itself fetch, decompress, schedule or crawl URLs, or authorize domains. The [durable static audit worker](site-audit-worker.md) now integrates its isolated entry with bounded discovery. Text, RSS and Atom sitemap formats remain unsupported here and remain in the V1 scope.

`parseSitemap({documentUrl, chunks})` in `src/server/crawl-sitemap.ts` accepts a document URL and a synchronous iterable of UTF-8 byte chunks. It returns `status`, `reasons`, `kind`, `entries`, `counts`, `bytesRead` and `entriesComplete`. It uses namespace-aware `saxes@6.0.0` with `xmlchars@2.2.0`; the dependency lock and [full license notices](../THIRD_PARTY_NOTICES.md) pin their provenance. The MIT application retains their ISC/MIT notices. Both dependency repositories are archived, so upgrades require explicit review.

## Results and trust

- `complete`: the supplied XML completed and all acceptable observations were retained. This says nothing about a site's overall coverage or whether a URL is authorized for crawling.
- `partial`: valid XML with invalid individual entries, unexpected sitemap structure, foreign origins, URLs above the document directory, or omitted observations at the retained-output limit. `reasons` and `counts` explain the difference.
- `unavailable`: an invalid document, unsupported root/declaration, forbidden DTD, incomplete/invalid UTF-8, failed iterator or exceeded safety limit. **All entries and counts are cleared**, including observations before a malformed tail. `kind` is null. No raw XML, URL, parser error or iterator exception appears in reasons.

`counts.seen` counts recognized direct sitemap entries; `accepted` counts those with one valid direct `loc`, including retained and omitted observations. `invalid` counts recognized entries without one acceptable `loc`. `foreignOrigin` counts accepted observations whose normalized origin differs from the document origin, whether retained or omitted. Duplicate URLs remain separate observations. `entriesComplete` means no accepted entries were omitted, no individual entry was invalid and no unexpected sitemap structure was observed; it can be true for a partial result whose only warnings concern origin/location.

Entries contain only normalized absolute credential-free HTTP(S) URLs. Queries remain evidence and must not be logged or treated as safe display markup. Relative URLs, fragments, control/space characters within the URL, backslashes, malformed percent escapes, userinfo (including empty userinfo), invalid Unicode and oversized serialized URLs are rejected. Surrounding XML whitespace in `loc` is removed. Private-address-looking URLs may remain observations: this parser performs no DNS or public-address check. **Every future fetch must independently intersect trusted project scope, current robots policy and public-network transport rules.** Neither a sitemap's host, namespace nor listed origin expands scope. No `xml:base`, stylesheet, XInclude, DTD, schema or extension URL is fetched.

The exact sitemap namespace is `http://www.sitemaps.org/schemas/sitemap/0.9`; the prefix is irrelevant. Only direct `urlset/url/loc` and `sitemapindex/sitemap/loc` contribute targets. Duplicate/missing locs and nested element content inside loc invalidate the entry. Other namespaces cannot inject targets. Extensions are ignored but still count against element/depth/attribute limits. `lastmod`, `changefreq`, `priority` and extension metadata are not interpreted as freshness, scheduling or authorization. Standard and numeric XML entities and CDATA are supported. DTDs and custom entities are forbidden; XML declarations must specify version 1.0 and, if present, UTF-8 encoding.

## Bounds and unfinished tokens

| Boundary | Limit and result |
|---|---|
| Expanded input | 52,428,800 bytes (50 MiB), equality accepted; excess is `body_limit` |
| Recognized entries | 50,000, equality accepted; excess is `entry_limit` |
| Retained URL text | 8 MiB aggregate UTF-8 serialized URL bytes; accepted excess is counted as omitted and `retained_url_limit`, then the remaining XML is still validated |
| Parser writes | At most 16 KiB of bytes per decode/write |
| XML nesting / elements | Depth 32 / 1,000,000 elements; `depth_limit` / `element_limit` |
| Attributes | 32 per element including namespace declarations; `attribute_limit` |
| Qualified names / attribute values | 256 UTF-16 code units / 8,192 UTF-8 bytes; `name_limit` / `attribute_value_limit` |
| loc | Fewer than 2,048 Unicode characters; raw and normalized URL at most 2,048 UTF-8 bytes; violation is an invalid individual entry |

Event limits cannot bound an unfinished attribute, name, comment, CDATA, DTD or text token inside saxes. Small parser writes do not change that. **Live untrusted input must use [`parseCrawlSitemapIsolated`](crawl-parser-isolation.md#sitemap-xml)** with parent wall-clock, heap, stdin/stdout and cleanup bounds. The pure parser is not safe to call on live XML in a web/worker request process. It also cannot interrupt an iterator that never returns.

The [single-hop transport](crawl-network.md) and isolated parser have a separate **5 MiB download/expanded-body capacity**. The future crawler must report `unavailable_capacity` when the transport's byte-limit outcome prevents obtaining a complete document. It must not pass a truncated body off as a complete sitemap or claim full-site coverage. This operational ceiling does not change the pure format parser's 50 MiB limit. Likewise, an 8 MiB retained URL ceiling can make a format-valid document partial. A future bounded frontier/spool can remove this retention ceiling after validation; no generic streaming persistence layer is added now.

`bytesRead` counts byte slices actually presented to the decoder. When an incoming chunk would exceed the remaining input allowance, that whole chunk is rejected before decoding and is not included. It is diagnostic progress, not total wire size or a valid-prefix receipt. `invalid_chunk` and `input_error` distinguish the supplied-input failures; `invalid_utf8`, `invalid_xml`, `doctype_forbidden`, `unsupported_format`, `unsupported_xml_declaration` and `invalid_document_url` describe the other unavailable outcomes. Only literal stable reason codes leave the parser.

## Runnable checks and evidence

Run with Node 24:

```sh
node --test tests/crawl-sitemap.test.ts
```

Ordinary small fixtures cover byte-split UTF-8/entities/CDATA, namespaces, direct loc structure, URL validation, origin/location warnings, malformed tails, DTD/declaration rejection and failed iteration. Every large or resource-hostile fixture runs in a disposable process with a 15-second hard timeout, 256 MiB V8 old-space limit, 16 KiB output cap, restricted environment and hidden Windows window. The heap limit is not an RSS or OS memory limit. No network or filesystem entity resolver is supplied.

On the local Windows Node 24.19.0 test host (2026-10-13), one exact 50 MiB comment-padded valid document took 3,545 ms and 75,836 KiB maxRSS; a 50,000-entry document took 374 ms and 91,732 KiB maxRSS. These are individual fixture measurements, not throughput/RSS guarantees for arbitrary valid documents. The child checks also cover byte/entry excess, an 8 MiB retained-output boundary plus invalid tail, a million-element boundary and 16 MiB unfinished comment/attribute/DTD/text/CDATA/name tokens. Different machines and XML structures can require the isolated runner to return unavailable on its deadline or memory boundary.

Primary references: [Sitemaps protocol](https://www.sitemaps.org/protocol.html), [pinned saxes implementation and documentation](https://github.com/lddubeau/saxes/tree/211fa0ebec9b628affc09219199639887174bfc3), [saxes 6.0.0 registry metadata](https://registry.npmjs.org/saxes/6.0.0), [xmlchars 2.2.0 metadata](https://registry.npmjs.org/xmlchars/2.2.0). The exact-version advisory query on 2026-10-13 returned no entries; this is not a security guarantee. No public deployment, live fetch or full parity claim follows from these checks.
