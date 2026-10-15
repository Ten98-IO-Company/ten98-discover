# Native analytics geography contract

The shared types and canonical filter parser are in `src/lib/analytics-geography.ts`; the offline reader is in `src/server/analytics-geography.ts`. Installation and restart commands are in [Docker setup](docker-setup.md#optional-local-country-region-and-city-database). Product decisions and remaining parity work belong in [Docmost](https://wiki.ten98.io/s/ten98-docs/p/cookieless-analytics-and-real-traffic-pilot-N3rljmNeEx).

## Collection and stored evidence

Web loads one immutable, uncompressed DB-IP City Lite file at startup, bounded to 256 MiB. It hashes and validates the opened file and reader metadata. No startup download, watcher, request-time file access, external geolocation request, or worker reader is used. A failed lookup disables that reader while allowing the accepted page view to survive without geography. Restart web after replacing the verified file.

`captureGeography` is an administrator setting. Absent legacy values mean false. Migration 0040 changes only the default for future projects; it does not change existing settings, consent epochs, retained events or identities. The public version-3 tracker configuration keeps its previous keys and does not expose this flag. Location capture requires both the setting and an available public visitor address from the existing network resolver. Consent/refusal, DNT/GPC, origin, bot, epoch and path checks run before lookup. Arbitrary API events and identify calls cannot supply native geography. Duplicate events retain their original observation.

Each recognized observation contains exactly `version`, `databaseBuild`, `databaseSha256`, `country`, `region` and `city`. The version is `dbip-city-lite-v1`; provenance comes from the actual loaded file. Country uses two uppercase letters; region contains a qualified subdivision code and/or an English name; city is an English name. Names are NFC, trimmed, free of control characters, and bounded to 128 Unicode scalars and 512 UTF-8 bytes. A missing country implies null region and city. No raw address, coordinates, postal code or caller-supplied location headers are stored.

The shared validator uses JavaScript Number semantics for build epochs. The SQL projection first bounds the complete JSON object and numeric text, then applies the same finite integer/range check and emits one canonical integer. Malformed, unsupported or incomplete observations become **Not recorded**. A valid completed lookup with no matching country or component becomes **Unknown**. These states are distinct from a literal place named Unknown, zero traffic, and history removed by retention.

## Query boundaries

Country, region and city filters are canonical JSON strings, not display labels. Known region keys include country plus code/name identity; known city keys include country, region identity (or null), and city. This keeps identically named places separate. The parser rejects duplicate/extra members, noncanonical serialization, oversized strings and incompatible ancestors. Row actions update ancestors together. Overview URL fields are `analyticsCountry`, `analyticsRegion` and `analyticsCity`; server query fields are `country`, `region` and `city`.

Analytics, current/prior comparisons, Explore, advanced equality/inequality and recorded/missing predicates, cohort qualification, realtime and session details reuse the validated projection. Existing authorization, parameter slots, date limits and retention boundaries remain in force. Comparison rankings, coverage and export derive from each period's own snapshot; geography does not route a 367-day derived comparison through Explore's 366-day limit.

Country reports return every possible two-letter code plus Unknown and Not recorded, with a limit of 678 groups. Region and city reports return the first 100 groups and explicitly report total groups, returned page views and truncation. Their expanded view searches and exports that same returned snapshot; it is not a complete region/city inventory. Visitor and visit estimates follow [native measurement](analytics-measurement.md) and are not additive across location groups.

Coverage describes retained page views in the actual filtered population. Removed history yields partial coverage or unavailable/null counts, not invented zeros. Provenance reports distinct observed database build/hash pairs and build extrema, separately from current reader readiness. Explore provenance describes report events; a geography-based cohort qualifier does not imply that its qualifying events used the same build. Realtime countries use the complete eligible population, independently of its latest-100 activity sample. Session rows expose only strictly validated observations.

## Presentation and licensing

The country map uses local Natural Earth geometry with accessible country-table alternatives, keyboard zoom/pan controls and explicit unplotted counts. It does not load tiles or transmit visitor data. Country names are localized for display; stored qualified identities remain stable. Country/region/city controls expose readable choices rather than requiring JSON input. Source attribution remains visible on geography reports and related exports.

The app remains MIT. DB-IP City Lite data is separately CC BY 4.0; Natural Earth geometry is public domain. Exact sources, hashes, dependency license and attribution are recorded in [third-party notices](../THIRD_PARTY_NOTICES.md). An optional 1 GiB web profile is provided; any measured synthetic workload is evidence for that workload, not a general production capacity or full V1 parity guarantee.
