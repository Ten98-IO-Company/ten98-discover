# Native revenue event contract

This is the P39 collection core. Revenue totals, trends, breakdowns and revenue-session reports are not implemented by this increment. Generic purchase/revenue/value properties are not automatically revenue; no history is inferred or imported.

Send an explicit custom event through the existing tracker:

```js
ten98.track('revenue.sale', {
  ten98_revenue_version: '1',
  ten98_revenue_kind: 'sale',
  ten98_revenue_amount: '49.5000',
  ten98_revenue_currency: 'USD',
  plan: 'team'
});
```

Any valid custom event name may be used; page_view cannot carry a revenue tuple. `revenue.sale` and `revenue.refund` are recommended native-only names. Kind is exactly sale or refund; the amount stays positive for both. No automatic purchase matching or order/customer identifier is added. Ordinary additional developer properties keep their existing limits; do not supply personal or payment details.

If any `ten98_revenue_` property is present, all four reserved fields must be strings, version must be1, and unknown keys under that prefix are rejected. Other properties are unchanged. Amount is positive plain decimal text with at most15 integer and4 fractional digits, no signs, exponents, whitespace or leading zeroes. Integers and1–4 fractional places are padded to exactly4 without rounding; maximum999999999999999.9999. Zero and negatives are invalid. Four places are the analytics storage scale, not a promise about a currency’s legal minor units. No JavaScript floating-point arithmetic or FX conversion is performed.

Currency is exact uppercase from the pinned `node24.19.0-icu78.3-currency-v1` catalog in [revenue.ts](../src/lib/revenue.ts), captured from Node24.19.0/ICU78.3 `Intl.supportedValuesOf('currency')`, excludingXXX/XTS. Browser runtime catalogs are not consulted. Changing the accepted catalog requires an explicit versioned code change; no missing/invalid code falls back toUSD.

The shared writer validates after the existing browser/API collection policy and generic property normalizer, then stores the canonical tuple in the same atomic event row. No new table, job, SDK method, public collection envelope, identity or policy setting is introduced. Refusal/DNT/GPC, bot/path exclusions, allowed origins, consent epochs, cookieless identity boundaries and raw-event retention stay unchanged. API events still have sourceAPI and no browser visitor/visit keys or collection basis.

Existing `(project_id,eventId)` deduplication is the only idempotency rule: the first accepted event wins; a duplicate cannot rewrite money, currency, properties, basis or identity. The browser generates a new event ID for each track call, so repeated calls can count separately. This is not business-order deduplication or a financial ledger. For server retries, persist the same event UUID.

The current vendor purchase/refund parser is a separate feature with its own restricted properties and consent. Do not add the reserved tuple to an existing vendor purchase event and assume it still fans out: additional reserved keys are not in that parser. Send a separate native revenue event; no vendor parser or advertising purpose is changed here. Lowercase HTML attributes may carry the same four explicit string properties through the existing declared-event tracker. No form values, text, query strings, raw click IDs or purchase identity are collected automatically.

Implementation is original native code informed by the pinned MIT Umami3.4.0 flow (`ec0ff50388c264ed8ce46f00967e92f7e71476ae`). Its collector recognizes generic top-level revenue/currency and stores Decimal(19,4); native instead requires explicit versioned intent, exact strings and the existing atomic event row. Later report code must use guarded PostgreSQL numeric/BigInt, separate currencies and sales/refunds, preserve unavailable versus zero, and reconcile complete populations before top-N display. Tests: [pure checks](../tests/revenue.test.ts), [isolated integration](../tests/revenue-integration.ts).


## Current-period reports

GET /api/projects/:projectId/revenue returns one complete current-period report and first50 observed-key rows. /revenue/sessions accepts the returned cursor; /revenue/sessions/:visitorKey returns a scope-bound full monetary summary and bounded revenue observations. Every route requires explicit from/to/timeZone/currency; existing exact/advanced/cohort/current-property qualification is reused. pageSize is1..100; literal search (200 characters) narrows only the key table. Duplicate/unknown parameters, request bodies and compare are rejected400. API keys need analytics:read; browser owner/admin/editor/viewer roles read under the existing workspace gate.

One analyticsPopulation context captures the raw database clock, current-property cutoff and receipt bound. All qualifying/native-key expansion/direct unkeyed revenue, unfiltered first-source observations, cards, daily/series/ranks and first key page share that statement. Matching native keys qualify all their valid selected-currency revenue in dates; unkeyed/API observations qualify only by direct event match. Rotating keys never merge across devices/months or explicit identity profiles. Later pages are current-per-page with the fixed receipt bound, not a persisted transaction snapshot; canonical closed base64url JSON cursors are not signed authority. Scope/page size and retention policy/evidence are revalidated; drift409 requires reload. API credentials and membership are rechecked after actual query waits, using the raw database clock for expiry. Statements/locks have5-second bounds; oversized complete JSON or numeric overflow returns503, never successful truncation. Response ceiling is2MiB.

All money is exact signed fixed4-place strings, backed by SQL numeric and BigInt; no FX/Number/parseFloat/implicitUSD. Positive sales and positive refunds are separate; net=sales-refunds. Average sale uses sales/sale observation count; keyed net per qualified key excludes unkeyed money from its numerator. Division rounds half away fromzero to4 places; zero denominator is null. Available empty selection has zero amounts; unavailable qualification/history masks money/counts null. Unkeyed known money remains available with unavailable/partial identity estimates. Historical generic purchase/value/revenue properties are not revenue tuples. Stored explicit tuples are validated before any numeric cast; malformed declared tuples are excluded and counted.

Each revenue-bearing native key uses exactly its earliest retained unfiltered native observation in the window (received_at/id order) for referrer, geography and recorded channel tags. It is not first-ever attribution or purchase location. Ties, retention loss, missing keys, malformed declared tuples and provisional current/future calendar windows mark evidence incomplete; none are monetary/category lower-bound claims. Unkeyed amounts use Not recorded key dimensions. Country/region keys preserve Unknown versus Not recorded. Provenance is for selected first-dimension observations for revenue-bearing keys, not conversion/customer locations. DB-IP City Lite source attribution remains required on result pages.

All countries(up to678) and top100 referrer/region groups include full-population displayed/omitted exact money, group counts and honest truncation. First10 event-name net series plus Other reconcile daily totals. Sale shares use the full sale denominator and are null for incomplete/zero evidence; no net-money share is claimed. Channels use recorded-channel-tags-v1 over existing recorded medium/source/referrer only; tagged_paid means Tagged paid, unverified and paidVerification remains unavailable. No Direct inference, source-family taxonomy, raw click IDs or new collection occurs.

Stored source metadata retains the collection bounds in UTF-16 code units: campaign strings0–200 and nonempty referrer strings1–2048. Malformed types and overlong strings become Not recorded; empty campaign strings remain distinct. Equal-money geography groups use the shared canonical key order (country before region) under C collation, including the top100 cutoff. Revenue identity eligibility remains source browser plus present visitor/visit keys, independent of the stored metric-version label; valid retained keys are not excluded by a new version allowlist.

Required follow-ups remain previous-period/year comparison with a reviewed shared-clock seam, full source-family channel classification, source-shaped searchable currency/event controls/date presets/cohort discovery and independently validated UI/compiled flows. This current-period backend does not complete P39.
