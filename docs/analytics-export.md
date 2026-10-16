# Analytics archive export (P46, export increment)

## Contract

`POST /api/projects/:projectId/analytics/export` uses a current signed-in cookie, the exact application Origin, and a strict JSON body `{ "scope": "from=2026-01-01&to=2026-01-02&timeZone=UTC" }`. Owner, admin, editor and viewer may export their current project. API keys and public/share capabilities do not authorize this route. GET is not an export action. No query-string parameters are accepted. The body is at most 32 KiB; the route rate limit is six attempts per signed-in user per minute. Reset and delete are separate work and are not introduced here.

Scope requires both inclusive local dates and an IANA timezone. It reuses the native Explorer parser/calendar, literal event/path/origin/referrer/language/campaign filters, closed browser/OS/device and geography filters, and one exact typed event-property filter. Empty literal values remain exact. Duplicate, unknown, malformed percent/UTF-8, grouping, cohort, advanced predicate and draft controls are refused. Native skipped days and 23/25-hour days retain their actual calendar bounds. This increment does not add session-property, cohort or arbitrary SQL export.

A successful response is one complete `application/zip` attachment named `analytics.zip`, with a precise Content-Length, `X-Export-As-Of`, current `X-Export-Role`, `Cache-Control: no-store, no-transform`, and `nosniff`. The body contains exactly these seven fixed files, in this order:

| File | Grouping and measurement |
| --- | --- |
| events.csv | Native custom-event name, custom event observations |
| pages.csv | Recorded path, page-view observations and estimated distinct observed visitor keys |
| referrers.csv | Recorded referrer host, page-view observations and estimated distinct observed visitor keys |
| browsers.csv | Recorded browser category, page-view observations and estimated distinct observed visitor keys |
| os.csv | Recorded OS category, page-view observations and estimated distinct observed visitor keys |
| devices.csv | Recorded device category, page-view observations and estimated distinct observed visitor keys |
| countries.csv | Native known/unknown/not-recorded country key, page-view observations and estimated distinct observed visitor keys |

All files contain a CSV header and one `metadata` row even when there are no groups or the requested window is unavailable. Metadata includes the chosen scope, one PostgreSQL as-of timestamp, actual start/end instants, effective retained-from and retention coverage. `coverage` describes retention, not complete collection or the future part of today's requested day. Data rows use `record_type=row`, `value_state`, the exact grouped value and counts. Missing values are `Unavailable`; country keys preserve known, unknown and not-recorded. An anonymous-only group has real pageviews and zero identified pageviews but unavailable estimated visitors. A measured zero remains zero. Custom events do not claim visitor counts.

CSV uses the existing `csvCell` quoting and spreadsheet-formula neutralization, including leading whitespace. Country objects are CSV-escaped JSON. All records use CRLF. The archive contains no per-event rows, raw visitor/visit/user IDs, IP or user-agent columns, credentials, capabilities or newly collected data. Existing recorded labels and the explicitly selected scope are retained as labels; export does not infer or redact the meaning of user-authored path/event/property labels.

## Native semantics and reference comparison

The seven filenames follow pinned Umami `ec0ff50388c264ed8ce46f00967e92f7e71476ae3`, `src/app/api/websites/[websiteId]/export/route.ts`. Its native export uses custom-event counts and distinct sessions for the other datasets, defaulting to 500 grouped entries and excluding blank values/internal referrers. This implementation deliberately exports complete bounded native groups with pageviews plus nullable estimated visitor counts instead of treating rotating project/month keys as persistent sessions/people. It includes native missing values and recorded internal referrer hosts. It does not claim byte-for-byte CSV parity, persistent identity, inferred visits, or silent hostname exclusions. It reuses `analyticsPopulation`, `analyticsDimensionValueSql` and geography projection; there is no second metric engine.

## Consistency, access and retention

One owned PoolClient begins a read transaction, acquires workspace then project SHARE locks, and reads current membership under a materialized fresh PostgreSQL clock after those waits. The existing population applies the project erasure watermark; an additional exact native timestamptz cutoff applies current raw retention and the pinned as-of. One aggregate statement produces all seven datasets at one statement snapshot. Anonymous observations are retained; estimated distinct counts never expose their keys.

The complete archive is built before publication. A final fresh current-role/policy/watermark gate runs while the same workspace/project/membership locks remain held. A changed policy or a rolling retention boundary that has passed any included observation refuses the whole archive, without partial response or automatic retry. All timestamp comparisons retain PostgreSQL microseconds. There is no JavaScript Date cutoff comparison. The transaction commits and releases its sole client; no nested pool helper or network/provider call is used.

Statement timeout is 5 seconds, lock timeout 250 ms, and the export wall budget is 15 seconds checked before and after blocking statements and during CSV/archive work. Existing pool acquisition timeout remains in force. A disconnected/aborted request returns no archive; SQL already in progress remains bounded by its statement timeout. No stream, partial download, retry worker, queue or paid ledger is created.

## Capacity and ZIP format

The complete archive is at most 16 MiB including local/central ZIP headers and end record. Each file is at most 10,000 complete grouped values; all files together at most 25,000 groups. Ranking counts the complete population before selecting one extra sentinel group per file, so exceeding a group cap returns 413 with an explicit request to narrow dates/filters. SQL also refuses excessive selected label bytes before producing aggregate JSON. No file or population is silently truncated. Byte accounting uses UTF-8 bytes and refuses before ZIP allocation/CRC work if the full archive cannot fit.

The minimal archive writer is fixed seven-file stored ZIP32 (method 0, UTF-8 flag, fixed 1980 date), using Node 24 native `zlib.crc32`. Names are closed literals with no paths. There is no compression, ZIP64, arbitrary archive framework or added dependency. The four pure groups independently decode local and central records, verify CRCs, and cover formula/null/strict-wire/capacity/abort boundaries.

## Authored checks and evidence boundary

Four new pure groups and five whole native groups are authored. They have not been parsed, compiled or executed in this private proposal. The native entry requires `TEN98_INTEGRATION_TEST=1`, `TEN98_ANALYTICS_EXPORT_TEST=1`, `ANALYTICS_NETWORK_MODE=off`, an explicit fresh owned local `127.0.0.1:55502/ten98_analytics_export_<12hex>` fixture (or the separately isolated CI name), and actual registered migrations 1–58. It creates five synthetic actors/accounts, two workspaces, one project, one synthetic visitor and six unchanged observations. It checks four cookie roles and ZIP completeness; Origin/key/body/raw scope refusals; exact filters and DST/skipped-day metadata; same-millisecond microsecond erasure and unavailable windows; and real held workspace membership withdrawal. A held read may safely time out with 503 before role removal becomes visible; either refusal is accepted, never a stale archive. Final current-role denial is asserted separately. Provider ledger remains zero, all six event row hashes stay fixed and no idle transaction remains.

Composed onto the reset/deletion tree and executed on 2026-10-17 against a fresh isolated schema61 PostgreSQL18 database and headless Edge: the four pure groups, the five native groups above and the seven-group dialog browser harness (27 contexts) all pass, and the native lane is wired into CI as `ten98_analytics_export_ci`. Per the reset contract, both gate reads now also carry `analytics_epoch` and the final equality check refuses an archive when the project epoch rotated between them. The lane admits only the registered61 prefix. Compiled-App download and full P46 completion remain open.