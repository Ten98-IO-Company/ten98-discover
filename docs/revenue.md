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
