# Native analytics measurement contract

This is the measurement contract for native collection and its remaining analytics extensions, not evidence of full V1 completion. P28–P40 remain subject to the [parity acceptance gates](https://wiki.ten98.io/s/ten98-docs/p/parity-1fPLxG5kX5). The [foundation runbook](foundation.md#native-collection-and-measurement) identifies implemented behavior and checks. This contract keeps native observations, estimated visitor identity and imported provider measurements distinct.

## Identity and visits

An analytics visitor is a project-scoped pseudonymous estimate, never an application login or a unique person. The server derives its key from a trusted client IP, User-Agent, UTC calendar month and optional client distinct ID using a domain-separated keyed hash. Neither the IP, raw User-Agent nor raw distinct ID belongs in the event or visitor record. Hashing does not make these measurements anonymous.

Changing project, network address, browser identifier, distinct ID, month or server signing secret changes the visitor key. Shared network/browser characteristics may combine visitors; changed characteristics may split one visitor. Distinct IDs are untrusted observations: they cannot authorize access or merge application accounts. A later explicit identification does not rewrite earlier anonymous events.

The metric version `umami-3.4-hour-cache-v1` preserves the pinned reference's hourly-derived visit behavior:

- Without a valid context, derive the visit from the visitor key and current UTC hour.
- A signed browser context binds project, visitor, visit and its original issuance time. It can carry a visit across an hour for at most 30 minutes from issuance; accepted events do not slide that timer.
- At exactly 30 minutes the context remains valid; after that it is replaced. Replacing it within the same hour can yield the same visit key.
- Monthly visitor rotation overrides even a younger context. Future, malformed, tampered, foreign-project and mismatched-visitor contexts are ignored.
- Missing trustworthy network identity or usable User-Agent yields no visitor/visit key. A previously valid context cannot bypass that requirement.

For example, a visit beginning at 09:50 can continue at 10:15 with its original visit key. It expires after 10:20. A context beginning at 10:00 and replaced at 10:31 can retain the same hourly visit key. These are not conventional sliding inactivity sessions. Browser context stays scoped to one project/endpoint/environment; no alias or workspace grouping creates cross-site identity.

The pinned source is [Umami 3.4.0 collection](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/api/send/route.ts#L154). Ten98 uses explicit UTC periods and a separate native metric version rather than promising numerically identical reports across every upstream deployment configuration.

## Network boundary

`ANALYTICS_NETWORK_MODE` defaults to `off`. In `direct` mode, identity uses only the original Node transport's socket peer. In `proxy` mode, the socket peer must be in the explicitly configured `ANALYTICS_TRUSTED_PROXIES` IP/CIDR allowlist. The bounded `X-Forwarded-For` chain is examined from right to left, stopping at the first untrusted address. Missing, malformed or entirely trusted chains remain unknown.

Only bare IP literals are accepted. Ports, quoted addresses, zone identifiers and hostnames are rejected. IPv4-mapped IPv6 forms normalize to the same IPv4 address. A plain or cloned Fetch `Request` may lack transport metadata; client headers must never substitute for it.

Direct mode behind a shared gateway can collapse visitor estimates, so it must not be selected automatically. Proxy mode needs a verified deployment topology and an edge that overwrites/appends forwarding headers correctly. Development proxy behavior does not establish production Nitro, Docker or Caddy behavior. Those paths require real transport tests before documentation claims support.

## Collection and privacy

Native analytics has its own consent and exclusion gate, independent of which vendor destinations are enabled. Unknown or denied analytics consent produces no native event transmission; a later grant never replays earlier activity. Withdrawal clears pending collection and browser context. Previously accepted records remain subject to the documented retention/erasure policy; withdrawal alone does not erase stored history or guarantee a different future cookieless visitor key.

The server checks the current combined native/destination consent epoch before accepting browser events. Policy publication and collection must share a project lock, with the effective destination revision read in a fresh statement after acquiring that lock. This prevents a waiting request from accepting an old policy snapshot after publication commits.

Referrer, campaign and screen capture are separately configurable and default off. Referrer capture stores the hostname only. Query strings and fragments remain excluded from the native event path. Language is normalized. The explicit custom-property API must not scrape personal data from forms; it is not a guarantee that arbitrary caller-supplied properties contain no personal information.

Property input is bounded, typed and validated before persistence. Missing, null, empty string, number and numeric-looking string remain distinguishable. Dotted and backslash-containing keys cannot collide with nested paths. Invalid date-looking strings remain strings. NUL and malformed Unicode are rejected because PostgreSQL JSONB cannot preserve them.

API-key ingestion remains authorized per workspace and project and respects collection disablement/path exclusions. An API observation cannot claim browser consent or acquire a browser visitor merely by submitting a context or distinct ID. It is retained with its own source and identity coverage.

## Native identify and session properties

The browser SDK supports `ten98.identify(properties, siteOptions)` and `ten98.identify(identifier, properties, siteOptions)`. Options select exactly one configured site key, collector origin and live environment; an ambiguous selection fails without fanout. A top-level properties `id` is a compatibility shortcut consumed as the identifier and omitted from stored properties. An explicit identifier and shortcut must match. Nested `id` remains ordinary caller metadata, which may contain personal data.

Identify applies a typed patch to current session properties under the existing rotating visitor key. It creates no event, pageview, visit or event-based visitor first/last-seen record. Omitted keys keep their values and update times; null is a stored typed null. Each call and the accumulated retained profile are bounded to 50 keys. No raw identifier argument, IP or User-Agent is stored in the profile or identify receipt. A usable trusted network identity is still required, even with an identifier.

Consent, current configuration, native enablement, privacy signals and path exclusions apply before local identity assignment or dispatch. Pre-consent calls are discarded entirely. Identify does not invoke vendor pixels or their queues. A permitted explicit identity change takes effect synchronously for subsequent native events, clears context and aborts older native work. Both event and identify responses check the captured identity generation after response-body parsing. Identity remains only in memory. `ten98.resetIdentity(siteOptions)` clears that site's local identity and pending native work; it neither erases server data nor changes vendor identity. Withdrawal/configuration expiry also clears identity; regrant requires a new identify call.

The strict identify variant of `/api/collect` has an immutable UUID `requestId` and millisecond RFC3339 `sentAt`. A request is admissible for 24 hours from that timestamp and at most five minutes into the future. Exact normalized-body and visitor-key replay is a no-op, with no context refresh; changed operation/key reuse conflicts. An expired request returns a stable `request_expired` reason even after its receipt is cleaned up. Latest means server acceptance order, not timestamp or call order across tabs. The SDK has no automatic retry or retained replay queue: another identify call is a new update, and an unknown outcome does not prove rejection.

Session properties follow raw-analytics retention from each key's own latest accepted update; new traffic or sibling updates do not extend it. They have a separate monotonic cutoff and sticky evidence-loss marker. Saving a shorter policy immediately excludes expired values; later extension cannot restore them. Current session-property reporting, session predicates and persistent-person continuity are separate remaining acceptance work. Future readers must coordinate policy and snapshot time and distinguish expired evidence from a property never observed under a rotating key; missing-property totals cannot be called lower bounds after evidence loss.

## Reports and coverage

All accepted events retain their server receipt time. Public client timestamps cannot move observations into another reporting period. Event IDs remain idempotent per project; a duplicate cannot rewrite data, advance visitor timestamps or mint a replacement context.

Overview pageviews and custom-event counts remain available for legacy observations. Identity metrics describe only observations with valid visitor/visit keys; reports expose their coverage rather than inventing identity for historical rows. Unavailable measurements and rates with zero denominators are null, while a measured empty count is zero.

Overview visitors count distinct visitor keys and visits count distinct visit keys among qualifying pageviews. A bounce has one pageview and no custom event in that visit within the selected window. Observed visit duration is the interval between first and last pageviews; one-page visits contribute zero. Average duration divides the summed observed duration by qualifying visits. It does not measure active engagement or time after the last pageview. Daily distinct visitors cannot be summed to obtain period visitors. [Pinned overview calculation](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/queries/sql/getWebsiteStats.ts#L42)

Cards, series, breakdowns and exports must use one explicit filter population. Event-property exploration must not silently present custom events as pageviews. Legacy page rankings retain the label pageviews; a distinct-visitor ranking must use a different explicit column label. Filtered bounce semantics require fixtures covering custom events outside a matching page filter.

Store UTC instants and use a named IANA timezone for calendar date ranges. Ranges are half-open: the start local midnight is included and midnight after the final local date is excluded. Generate local calendar buckets; daylight-saving days are not necessarily 24 hours. Comparisons must state whether they compare calendar periods or elapsed durations.

Future revenue and performance observations retain separate measurement rules. Revenue requires explicit currency and financial precision; generic numeric properties are not the authoritative revenue ledger. RUM samples do not become pageviews or custom-event bounce suppression. Each performance metric needs its own sample count and percentile calculation, with missing metrics remaining unavailable.

## Remaining acceptance evidence

Browser consent/withdrawal, encoded path exclusions, production Node transport, transactional policy-publication races, duplicate handling and tenant/API-key boundaries have local acceptance checks. The full release still requires actual proxy deployment tests, typed-property queries, DST boundaries, filtered metric reconciliation, identity links, advanced reports and the remaining parity rows. A conservative bot-name heuristic is not comprehensive bot detection. Imported provider visitors, reach and attributed conversions cannot be added to native distinct visitors as though they were one population.
