# Observed-key cohort return report

The read-only `/api/projects/:projectId/retention-report` endpoint and **Measure → Retention** view are separate from workspace **Data retention** settings. They do not establish full reference parity or production readiness.

## Request and authority

Use GET with explicit `month=YYYY-MM` and `timeZone=UTC` (or another supported IANA timezone). Months run from1970-01 through9998-12 and cannot start after the report clock's local current month. The selected month's first/last calendar dates are derived internally. `from`, `to`, grouping, unknown or repeated query parameters and request bodies are rejected. The serialized query is bounded at20000characters.

Entry filters reuse Explorer's `kind`, exact event/path/origin/environment/location/campaign filters, typed property triple, validated advanced predicates and optional saved-cohort ID/current revision. The existing limits, literal/regex distinctions, canonical location keys, timezone validation and current retained session-property evidence apply. A saved cohort retains its own qualification dates; it does not replace the report's selected month.

All project read roles can read. API keys require current `analytics:read` scope and workspace membership. Reads hold the existing workspace publication gate, refresh authority after waits and verify natural key expiry against the same raw DB-clock snapshot used by the report. The route is limited to30reads per user per minute. Statement and lock deadlines are5seconds and250milliseconds; timeout returns503 instead of incomplete success. Responses are `no-store`. No provider calls, new identity collection, database migration or settings change occurs.

## Measurement

Each distinct stored project visitor key joins the cohort of its earliest matching retained local calendar date in the selected month. It is not the first-ever visit or a new-user cohort. Returns count any retained project activity for that key on the exact later local date, without reapplying entry event/path/kind/other filters. Repeated events and visits count once per key/day. Offsets are1–7,14,21,28; activity outside the selected month never contributes. Earlier nonmatching activity can have a negative relative date and is not one of these positive cells.

The unchanged `analyticsPopulation(..., false, null)` seam emits one raw `clock_timestamp()` and applies its receipt fence to both entry and saved qualification. The unfiltered return scan uses that same bound. This is an explicit new-report-only event-asOf fence; it does not alter Overview or Explorer. Report generation is a database snapshot, not proof that all earlier in-flight events have committed.

Keys rotate each UTC month and can change with identity inputs or the signing secret. Cookieless/consented namespaces stay separate. A local month can cross a UTC key rotation. Explicit identify links are deliberately not joined. Results describe observed keys, not people, lifetime continuity, new users, churn or absence of customer activity. Unkeyed return-scope events cannot be assigned to cohorts.

## Coverage and states

Saved `analytics_retained_from` is the event watermark. The report does not impose a new policy-now cutoff or claim a retention worker has run. Extending policy cannot restore lost history.

Lost month-prefix history can move a key's first retained match into a later cohort. Assigned daily cohorts are therefore not generally lower bounds. Partial entry-month coverage (or partial saved qualification history) sets assignment to `retained-only`: observed counts remain labelled, and all return percentages are suppressed. Fully unavailable history or unavailable current-property/cohort selection yields null selection counts.

Available current-property selection or saved-cohort membership can also carry known incomplete evidence: lost current properties or unkeyed qualifying activity. Either selection's `countsAreLowerBounds` flag likewise sets `retained-only` assignment and suppresses all rates while preserving observed counts. It does not make per-date assigned cohort sizes or return percentages lower bounds. A `complete` assignment describes the selected observed keys under the available evidence, not complete people or traffic capture.

Completed empty entry dates have known0keys and no percentage denominator. Positive entry activity with no keys has an unavailable cohort size. Mixed activity counts only known observed keys and records unkeyed event coverage. Known zero returns with a positive, available cohort denominator are0%, not unavailable.

Local-calendar boundaries reuse the existing DST/repeated-midnight/gap/skipped-date logic and exact event-date membership. Future, skipped and outside-month cells have null counts. Current-day rates are provisional observations so far. A retained known empty cohort is distinct from an unavailable identity or lost-history cohort. Cell state precedence is calendar absence, unavailable selection/history, missing key identity, incomplete assignment, known empty cohort, then provisional/available.

## DTO and CSV

`src/lib/retention-report.ts` defines the closed `observed-key-cohort-returns-v1` DTO and browser-safe read guard. There are28–31 ordered date rows and exactly10fixed-offset cells per row (at most310). Counts are safe nonnegative integers; available percentages use returned keys divided by the row's observed cohort size. Current/past calendar state, exact dates, null/status constraints and aggregate/row counts are checked. Neither visitor keys nor raw IP/UA values appear.

The JSON envelope is bounded at512KiB and its CSV at256KiB UTF8. Oversize responses fail honestly. CSV is generated from the same assembled report, without a second query. It includes scope, generation time, watermark, assignment, identity caveats and each cell's state/counts once in a fixed table. Metadata appears once. Existing `csvCell` escaping protects formula prefixes. Optional location metadata describes matching entry observations with DB-IP source/build/license attribution, not the current database file. Selected cohort/current-property evidence remains separate from the assigned-cohort denominator.

## Runnable checks

```sh
node --test tests/retention-report.test.ts
```

The opt-in integration runner requires `TEN98_INTEGRATION_TEST=1`, `TEN98_RETENTION_REPORT_TEST=1`, `ANALYTICS_NETWORK_MODE=off`, a newly created empty `ten98_retention_report_<12hex>` database on127.0.0.1:55501 (or the workflow's isolated `ten98_retention_report_ci` database), and private in-memory synthetic configuration. It refuses other databases and creates the existing migrations only in that empty fixture. It retains fixtures and optionally saves synthetic SQL DTOs under the checkout's private directory. Do not run against existing/local-preview/production data.

```sh
node tests/retention-report-integration.ts
```

The check covers month/entry semantics, unfiltered returns, empty/unkeyed/partial/expired states, saved qualification/current properties, no explicit-link merging, DST/skipped/reversed dates, current/future fences, closed HTTP authority, expiry after authorization, membership loss after a lock wait, all310positions, CSV bounds and zero provider ledger.

The component keeps applied month/timezone/entry selection in its own URL fields. Draft changes disable CSV until Apply; an unchanged Apply reloads once. Selected saved cohorts must be verified at the exact revision before reading a report. Scope/access changes cancel pending work and discard its result. The existing canonical navigation check prevents a new router entry from dispatching an old search scope. The report reader limits success to512KiB and errors to8KiB raw UTF8, rejects malformed encoding/type/redirects, and preserves access-denied status for clearing the view. CSV comes from the accepted report, with no second query. All date rows and offsets remain in a bounded keyboard-scrollable table; numeric chronology remains left-to-right in RTL layouts.

The opt-in browser check requires `TEN98_RETENTION_BROWSER=1`, `TEN98_RETENTION_REPORT_DTOS` pointing to the unchanged synthetic SQL snapshot file, and `PLAYWRIGHT_MODULE` pointing to an installed Playwright module. It starts only its own loopback fixture and blocks external requests. Run `node tests/retention-report-browser.mjs`; the fixture is separate from a compiled-application acceptance check.

## Reference

Semantics were inspected in [Umami3.4.0 getRetention](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/queries/sql/retention/getRetention.ts). Native state/coverage corrections are explicit; no upstream code or assets were copied. First/last-click attribution is a separate remaining report inventory, not implemented by this endpoint.
