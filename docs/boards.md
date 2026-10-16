# Native custom board backend

This is the persistent backend and data contract for P43, not acceptance of the full board UI or mixed-entity parity. The closed17-family registry follows the pinned Umami3.4 registry at `ec0ff50388c264ed8ce46f00967e92f7e71476ae3`, `src/app/(main)/boards/boardComponentRegistry.tsx`. Its compatible entity families are retained, but native links/pixels require the separate P44 implementation. No paid provider/import is called by a board read or save.

## Configuration and writes

`src/lib/boards.ts` defines the browser-safe strict schemas and types. Version1 has a name, description, optional default entity, canonical applied scope, and ordered rows. Rows contain a stable UUID, a minimum height150–600 and one to four nullable card slots. Up to40 actual cards and40 rows are allowed; this is a per-document bound, not a lifetime board count. Row/card IDs are unique within one board. Order and minimum height are stored as authored; no arbitrary CSS, component props, HTML or remote embeds are accepted. TextBlock is literal text. Entity overrides may be website, link or pixel; `entity:null` inherits the default. A data card needs an effective entity. Website-only families and link/pixel metric restrictions are validated.

Migration0057 adds only `custom_board` and `custom_board_request`. Boards belong to a workspace because a mixed board has no required website. The latter table retains actor, request UUID, operation, canonical input hash and result ID/revision, never authored content. It survives board deletion until its workspace is deleted. New table timestamps have millisecond precision, so the existing scoped content cursor loses no native precision and survives a deleted page anchor. No project receipt is repurposed with a fake anchor, and no card table or separate ACL exists.

All routes require the current signed-in cookie. All four workspace roles read; owner/admin/editor write. POST retains the application's exact Origin and strict JSON guards. API keys, share links and replay capabilities grant no board access. Workspace locks serialize changes and recheck membership after waits. An unchanged reference to a deleted website/analysis can remain authored; reading it cannot recover its old data. New website/analysis references must belong to the current workspace and use the current saved analysis revision.

| Route under `/api/workspaces/{workspaceId}/boards` | Contract |
| --- | --- |
| GET collection | One optional scoped cursor,20 rows plus nextCursor. No implicit lifetime cap. |
| POST collection | `{requestId,definition}` |
| GET `/{boardId}` | Current saved document, no query. |
| POST `/{boardId}/update` | `{requestId,revision,definition}` whole-document CAS. |
| POST `/{boardId}/clone` | `{requestId,revision,name}` atomic clone of that exact source revision in the same workspace. |
| POST `/{boardId}/delete` | `{requestId,revision}`; deletion remains possible at the revision ceiling. |
| GET `/{boardId}/cards/{cardId}` | Required saved `revision`, optional one nested `scope` override. No request body. |

Writes return `{workspaceId,role,ack,item,deleted,replayed}`. The ACK's requestId/operation/boardId/appliedRevision identify the committed operation, independently of the current item. An exact actor/body retry returns that ACK even after subsequent edits or deletion. A clone retry cannot create another clone. Reusing a UUID for another actor, operation or canonical body is409. CAS mismatches and revision exhaustion are409. Never infer a write ACK from a similar GET or clear an unknown write's exact body/key during a refresh.

JSON writes are bounded to196608 UTF-8 bytes; complete responses to2097152 bytes. Read/write rates are120/30 per signed-in user per minute. Per-statement/lock timeouts are5seconds, not a whole-request deadline. Existing native readers own their own connections and authority. Board admission releases its client before those readers run, then a fresh workspace gate checks the same board revision, current entity/membership and exact retention-watermark/policy binding before publishing. This avoids pool starvation from nested client borrowing. The three new SQL readers use the gate's existing client. No background worker, automatic import or outbound network call is introduced.

## Scope and data

The stored canonical scope requires explicit `from`, `to`, `timeZone`, with1–366 inclusive days. It accepts the existing Explorer exact fields and typed event-property filter. Kind and grouping belong to the family and cannot be injected by global scope. Advanced predicates, session properties and cohorts are currently refused rather than dropped. Both the outer wire and nested scope undergo strict percent/UTF-8 validation before URLSearchParams; literal `%25` and actual replacement-character text remain valid. Empty literal fields and typed zero/false/null/missing keep their native meaning. Dates are explicit; no default calendar can drift on reload.

Each card response echoes workspace, board ID/revision, card ID/type, effective entity, current role, canonical scope and historical/fixed-live/none window. A ready response has a source discriminator and native payload. An unsupported response has one of `entity_dependency`, `scope`, `not_collected`, `reader_unavailable`, with no substituted data. Expiry/partial history and unknown identity remain native metadata; unavailable never becomes an invented zero.

| Family | Data source and boundaries |
| --- | --- |
| WebsiteMetricsBar | Existing Analytics: UTC and native literal selection/environment/geography filters. Event-property/origin/non-UTC scope is explicitly unsupported. Observed visit/bounce semantics and estimated visitor labels remain unchanged. |
| EventsMetricsBar | Explorer custom-event totals plus exact distinct name count, including names beyond the returned rows. |
| Goal / Funnel | Existing saved analysis ID+revision and native ordered result; stale/deleted definitions refuse. |
| WebsiteChart | New real daily distinct pageview visitor estimates and pageviews. Never distribute a range total over days or sum nonadditive visitors. |
| UTM | Existing pageview Explorer grouping, one of five campaign parameters, top5/10/20 with returned-group denominator/truncation. |
| RealtimeHeader / RealtimeChart / RealtimeActiveUsers | Existing native snapshot, fixed30-minute window /5-minute active estimate. Board filters are refused. Historical dates do not rebase a live window. UI must share a single verified live snapshot/refresh. |
| RevenueMetricsBar / RevenueChart / RevenueMetricsTable | Existing exact four-decimal native revenue report, isolated currency, refunds/negative values, first retained source attribution and recorded-channel method. No verified order/customer/ARPU claim. Table chooses referrer/channel/country/region. |
| MetricsTable | Native Explorer15 direct dimensions plus width/height screen tuple. Top5/10/20; counts, missing keys and coverage preserved. Entry/exit/channel/hostname remain explicit reader gaps. Full URL/query/title are not collected by the current privacy contract. |
| WorldMap | Existing pageview country grouping and geographic provenance; reuse CountryMap and country-paths asset. Native top100 truncation must remain visible; do not imply every country is returned. |
| WeeklyTraffic | New168 ISO-weekday/hour bins of distinct pageview visitor estimates, in the applied timezone. Repeated local hours combine into the labelled bin; counts across bins are nonadditive. Partial range evidence is reported on each bin. |
| EventsChart | New top5/10/20 custom event names ranked by whole filtered retained range count, then name. Daily series and explicit omitted-name count/Other daily counts preserve the total. Partial history can change rank; unavailable history has no ranked names. |
| TextBlock | Saved literal text, no entity or data query. |

The three new aggregations reuse `analyticsPopulation`, native calendar SQL and retentionCoverage. They operate on retained raw observations with a5second SQL bound; no rollups or new capture data are invented. Empty or entirely unidentified visitor estimates remain null. Event counts with complete evidence can be genuine zero. New report count values must be safe integers. Explorer card snapshots omit its original wider CSV when applying the card row limit; boards do not yet expose an export action.

## Authored validation, not execution evidence

`tests/boards.test.ts` checks all17 closed variants, layout/Unicode/bounds, exact scope normalization, malformed nested wire and browser-only inventory. `tests/boards-integration.ts` is a fresh isolated PostgreSQL workload with7 groups: persistence/current roles; CAS/clone/lost ACK; rollback/post-lock authority; real three-profile aggregation/DST/retention; native dispatch/gaps/stale publication; lossless paging; actual API guards. It refuses to run without the real complete57 migration prefix. Migration0057 is intentionally unregistered while0056 is pending integration. No runtime, dependency installation, browser/UI acceptance or full P43 completion is implied by these authored checks.
