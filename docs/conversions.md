# Saved funnels and goals

> Code and safety contracts retained from [docs/conversions.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/conversions.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/saved-funnels-and-goals-implementation-history-FJSPYC182f). Qualifications are preserved; this adds no acceptance claim.

## Measurement contract

The pinned [Umami collector](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/api/send/route.ts#L156) distinguishes its month-rotating `session_id` from `visit_id`. Its [funnels](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/queries/sql/funnels/getFunnel.ts#L134) count the former, corresponding to ten98's `visitor_id`. The interface says **estimated visitors**, and a funnel can span visits. Monthly keys are never stitched, and unidentified API/legacy observations cannot establish a visitor conversion.

Funnels contain 2–8 ordered steps. **Activity at path** accepts any matching activity; **Page views only** explicitly narrows a path step. Custom-event steps accept event-name and typed property conditions. Match operations are literal exact, prefix, suffix and contains; `%`, `_` and `*` are not SQL wildcards. The 1–1440 minute window applies between adjacent steps. Every reachable endpoint remains eligible, so a failed early attempt does not hide a later valid chain.

Receipt times must strictly increase. Unlike upstream's inclusive PostgreSQL timestamps, one event cannot complete repeated steps and equal-time observations do not prove an order. Shared filters apply to every step, resolving an upstream PostgreSQL/ClickHouse inconsistency explicitly. Negative property conditions require a present value of the selected type; missing is a separate predicate. These semantics use a named ten98 method version rather than promising identical upstream SQL results.

[Goals](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/queries/sql/goals/getGoal.ts#L35) have one **Viewed page** or **Custom event** condition. The denominator is all identified visitors with any event in the shared scope; the target condition narrows only the numerator. Repeated matches count once per estimated visitor. A known population with no matching visitor is zero; no known population is unavailable.

Dates/timezone and common filters apply at evaluation, not to the saved definition. All steps must fall inside that calendar range, with Explorer's IANA/DST handling and retention watermark. Partial retention permits lower-bound observed participant counts, but drop-off counts and rates are unavailable: subtracting two lower bounds does not establish a valid drop-off. Saved definitions survive expired events. Drilldown returns actual matching event chains, never synthetic sessions or exposed visitor keys.

## Authorization and controller invariants

Editors/admins/owners manage; viewers inspect.

No provider connection or background job is needed.

| Screen | Primary action | Recovery and state |
|---|---|---|
| Saved definitions | Create first definition, or View results for an existing row | Loading/empty/error are distinct; Retry reloads the current project only. Tabs retain no cross-project drafts. |
| Definition editor | Save funnel / Save goal | Name and criteria are required; description is optional. Native add/remove/up/down buttons work by keyboard. Invalid JSON stays editable. Conflict reload is deliberate, and dirty exit requires confirmation. Lost responses offer the identical save request. |
| Conversion results | Apply dates and filters | Definition summary collapses; dates/timezone are compact and advanced filters start closed. Zero, unidentified observations and retention gaps have distinct copy. An error clears stale results and offers Retry. |
| Matching activity | Inspect the returned chain | Step paths, names, origins and receipt times are plain text. Back preserves applied scope and restores focus. Pagination is scoped and bounded; fresh reads can observe newly collected events. |

## Evaluator implementation

The final implementation carries the most recent reachable predecessor through ordered SQL windows, preserving all reachable endpoints without pair expansion or relying on estimated join cardinality. Count-only requests omit witness work; witness event IDs use indexed project-bound lookups in the same repeatable-read snapshot.

### Optional local performance regression

Use a **separate PostgreSQL instance and fresh, migrated database** named `ten98_funnels_performance_<suffix>`, with loopback `APP_URL` and `DATABASE_URL` and no connection-string query overrides. Put that test configuration and both `TEN98_PERFORMANCE_TEST=1` and `TEN98_INTEGRATION_TEST=1` in an ignored environment file, then run `node --env-file=.env.funnels-performance tests/funnels-performance.ts`. The runner refuses existing users/projects, exercises 100,000 distributed events and 10,000 dense events through eight-step funnels, and verifies two pages of actual witnesses without exposing visitor hashes. It keeps the application's five-second query deadline and a two-minute runner deadline, prints bounded timings, and leaves synthetic data for inspection. It never clears a database, starts a worker or calls an external provider. This substantial opt-in load is excluded from automatic CI; timings depend on the host and are not a deployment throughput guarantee.
