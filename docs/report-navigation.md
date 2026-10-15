# Sessions and Journeys navigation boundaries

Sessions and Journeys keep their controller mounted within the same user/project. The router's current location can change before its validated `search` prop reaches that controller. A later history entry can also have exactly the same search values as an earlier entry. Query content alone therefore does not identify a report request.

Both controllers reuse `canonicalNavigation(location.searchStr, search)`. Report dispatch waits for that match and for any local navigation to leave its initiating entry. The request scope includes the history entry, normalized report navigation and readiness. A render-time scope reference rejects earlier completions before effect cleanup; effect changes abort the earlier request. No shared API client, server authorization or response schema changes.

The shared canonical check matches the router's wire representation for every validated scalar: a string that itself parses as JSON is JSON-quoted. This includes definition revisions, invalid-link flags and composite location keys. Duplicate parameters, unquoted JSON-looking strings and mismatched values remain noncanonical. Navigation tests compare this behavior with the installed router serializer/parser.

Journeys and the Sessions list also associate their locally applied query with its normalized navigation. They wait for both to agree before dispatching after external navigation. Session detail/identified activity derive their date query directly from navigation and do not update the list-only applied association.

Changing applied dates makes one request for the intended range. Applying unchanged settings deliberately reloads once without creating another history entry. Draft settings and saved-definition revision checks retain their existing behavior. Sessions reference reads use the same route readiness/completion guard; current access errors retain the existing purge/sign-in behavior.

Recovering from an invalid Sessions link associates the fresh list query with its new navigation before it dispatches. A verified Journey card belongs to the entry that accepted it: it remains visible during a same-entry refresh, but is hidden after navigation until that entry accepts its own verified response.

The controller is not remounted on each entry. Sessions keeps its observed/identified source-return, paging and focus maps. The visible response is associated with its navigation context, while visit-continuation map keys retain their existing activity/query identity. These changes do not make rotating visitor keys into persistent people or change which events are authorized or retained.

## Focused browser check

With an installed Playwright module:

```sh
TEN98_REPORT_NAVIGATION_BROWSER=1 PLAYWRIGHT_MODULE=/installed/playwright/index.mjs node tests/report-navigation-browser.mjs
```

The check uses an ephemeral loopback server, the real router/components, in-memory intercepted APIs, exact request counts and held responses. It verifies changed/unchanged Apply, a final A search with a different entry after rapid A→B→A navigation, old-error cancellation and mismatched location/validated-prop blocking in both controllers. It also checks dispatch after invalid-link recovery and same-entry refresh versus new-entry Journey visibility. External requests and API mutations are denied and recorded.

Optional `TEN98_REPORT_NAV_SESSIONS_SQL` supplies an existing synthetic SQL evidence object `{project, visitor, params, detail}`. Optional `TEN98_REPORT_NAV_JOURNEYS_SQL` supplies an existing synthetic SQL evidence object with `report`. The check selects their synthetic project/range props and passes the response objects unchanged through production readers; it verifies that a late old success cannot replace the current response, that a current success is accepted, and that current401 clears the page. These are read-only local evidence files, not live database/provider calls. Never supply customer data.

This is a targeted correction for two reproduced controllers. Analytics/Compare and SiteAudit were inspected during diagnosis but are not changed or declared fully validated by this check. Existing Sessions and Journeys browser suites remain separate checks for their broader paging, source/back focus, saved-filter and access flows. The focused browser check is not a compiled-parent or whole-application acceptance claim.
