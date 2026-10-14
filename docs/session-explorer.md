# Native session explorer contract

The read-only session explorer groups matching retained events by the existing project-scoped rotating visitor key. A key is an observation estimate, not a persistent customer. Identify-only properties do not create discoverable traffic. Cross-key identified activity remains a separate pending collection feature.

## API and authorization

GET /api/projects/:projectId/sessions accepts explicit from, to and timeZone, the existing exact/typed/advanced/current-session/cohort population, an optional exact visitorKey, pageSize (1–100, default25) and cursor. Report grouping keys are rejected. Unknown or repeated parameters fail closed. Saved definitions stage filters; Apply commits the requested population.

GET /api/projects/:projectId/sessions/:visitorKey accepts only explicit calendar range/timeZone, pageSize (default50) and cursor. Its labelled scope is all retained activity for that base key within the selected dates. List predicates do not silently constrain or expand this timeline. Current properties remain separate from event-time properties.

All workspace members can read; API keys require analytics:read on the exact GET routes. The service holds one workspace SHARE gate in READ COMMITTED, rechecks membership/key/cohort after admission and validates key expiry again inside the final data statement. No public shares, mutation permissions or customer search oracle are added.

## Snapshot and retention

The final statement owns population, calendar bounds, event/profile/candidate evidence, totals, page rows and properties. Event history, identifier coverage and current-property evidence are independent. Unavailable selections return null rows/counts, never empty zeroes. Missing-property selection after known evidence loss remains unavailable even with zero candidates. No read refreshes profile or identity evidence.

List order is latest matching event descending then full visitor key ascending. Activity order is receive time descending then event UUID descending. Strict opaque cursors preserve database microseconds and bind project, route, key, canonical population/range and page size. An initial exclusive event bound prevents later arrivals from displacing the page start; each page still reads current properties and retained evidence. This is not an immutable multi-page snapshot.

Explicit retention saves invalidate paging through the existing workspace revision, including shrink then expand. Automatic marker movement and natural expiry return fresh coverage/evidence instead. Every page enforces current monotonic cutoffs; no cursor can restore expired data. Query and lock deadlines produce retryable503; invalid SQL regex produces400.

## Client and verification

Browser links contain only validated project/workspace, dates/timezone, selected key and definition ID/revision references. Arbitrary property/filter values stay in mounted-page state. Back restores the originating list when available; reloaded links do not claim to recover unsaved filters. Access loss clears displayed data. Typed values render as inert text. Post-render focus restores the originating row or results heading.

Run node --test tests/session-explorer-input.test.ts. The isolated integration runner requires TEN98_INTEGRATION_TEST=1, TEN98_SESSION_EXPLORER_TEST=1 and a fresh owned ten98_session_<12hex> database on loopback55501; CI uses its separate ten98_session_explorer_ci database. TEN98_SESSION_EXPLORER_BROWSER=1 runs the synthetic-transport browser fixture with installed PLAYWRIGHT_MODULE. Production acceptance requires a separately owned built application and fresh fixture; never point these tests at a deployment or preserved preview.

The existing Explorer, cohort, funnel, note and saved-filter assertions remain regression requirements. No schema, dependency or upstream application source is introduced by this read workflow.
