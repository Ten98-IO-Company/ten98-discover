# Google report imports

> Code and safety contracts retained from [docs/google-reports.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/google-reports.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/google-report-imports-implementation-history-meN6TCsw4E). Qualifications are preserved; this adds no acceptance claim.

This increment imports read-only Search Console and GA4 reports. It does not install browser tags, create a Google dashboard login, merge identities, or combine imported metrics with native analytics. Other platforms’ reporting imports remain required and unfinished.

## Operator setup

1. Configure the credential encryption keyring and an instance operator. Fresh installation claimants are operators; upgraded installations require an explicit host `operator grant <email>` command. Workspace ownership alone does not grant instance configuration rights.
2. In Google Cloud, enable the Search Console API, Google Analytics Admin API and Google Analytics Data API. Configure the consent screen and a **Web application** OAuth client. Add test users while the Google app is in testing mode.
3. Open **Workspace settings → Google app setup**. Add the displayed exact `APP_URL/api/google/callback` redirect URI to that client. Enter its client ID and secret, and enable connections. Google determines any consent verification requirements; changing the testing checkbox here does not publish or verify the Google app.
4. Every save creates a new app revision, including changes to the enabled/testing flags. Pending connections are invalidated and existing sources require reconnection before further provider reads. Stored snapshots remain readable. Re-enter the client secret for a change; saved secrets are never returned to the browser.

Use a stable HTTPS `APP_URL` for a team deployment. Google permits appropriate localhost web-client redirects for local development. External consent apps in testing generally receive refresh tokens that expire after seven days for these scopes. See Google’s [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [token expiration rules](https://developers.google.com/identity/protocols/oauth2).

## Workspace connection and import

A workspace owner opens a project’s **Google reports**, selects Search Console or GA4, names the source, and grants the requested read-only scope at Google. The callback returns to that authorized workspace/project. The server checks current ownership, the dashboard session, one-use browser-bound state, app revision and PKCE before storing encrypted tokens. Reporting consent never creates or changes a dashboard user.

Choose **Load available properties**, select an authorized property and confirm. A source’s property is fixed after selection; add another source for another property. GA4 discovery is paginated. Search Console lists only properties with verified read permissions. Domain-registry aliases do not automatically grant property access or merge their measurements.

Choose a report and inclusive calendar dates, then **Import report snapshot**. The current date guard disallows dates later than the current UTC day; it does not convert source dates to UTC. Ranges span at most 366 dates. The worker must be running. There is no import scheduler or background account polling; **Refresh status** retrieves the current receipt. An uncertain request retry reuses the same request ID and payload instead of creating duplicate work.

Supported reports:

| Source | Reports | Measurement rules |
| --- | --- | --- |
| Search Console | Daily search traffic, queries, pages | Final web-search data, provider dates in America/Los_Angeles; clicks, impressions, CTR and average position remain distinct. Top-row and anonymized-query omissions are stated. |
| GA4 | Traffic by default channel, events by event name | Property-local dates/time zone and currency; exact decimal strings preserve numeric precision. User counts are report-specific and must not be added across rows or blended with native visitors. |

Each import stores normalized rows and source provenance, up to ten pages of 1,000 rows. Hitting 10,000 without reaching the end produces an explicit **partial** snapshot. Google may impose smaller/top-row results, sampling, thresholds, metric restrictions or truncation; whitelisted quality information is retained for each page. Restricted or absent values are unavailable, not zero. A legitimate empty report is different from a failed, queued or expired import. Raw provider response bodies are not retained.

Google publishes the authoritative contracts for [Search Console query semantics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [property access](https://developers.google.com/webmaster-tools/v1/sites/list), [GA4 report requests](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport), [quality metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData), and [quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas).

## Permissions, removal and retention

Current project members can read imports. Only a current workspace owner can connect, select properties, enqueue, reconnect or disconnect. Authorization and revisions are checked again for every provider page. Removed owners cannot continue queued imports. Provider request URLs are fixed Google endpoints, redirects are rejected, and each response is time/size bounded. Successful refresh-token rotation is committed before a downstream report request, so report failure cannot restore an invalid old grant.

**Disconnect** removes local credentials, invalidates pending authorization flows and denies active imports. It does not contact Google. **Disconnect and revoke at Google** first performs that local removal, then requests remote revocation; Google may revoke a wider app grant and affect other connections. The outcome distinguishes confirmed from unconfirmed remote revocation. Missing encryption keys cannot prevent local removal. Existing snapshots remain available until their retention period ends.

Workspace **derived history** retention (default 365 days) removes rows and quality metadata from terminal imports older than their completion-time cutoff. Cleanup preserves the request ID, original outcome, recorded counts and source receipt. A retry returns that expired receipt; it does not re-import data. Active imports, credentials and all financial/request ledgers are preserved. The UI identifies expired snapshots and clears previously displayed rows on refresh. See [retention](retention.md) for bounded cleanup, backups and policy changes.

## Validation and remaining gates

Run Node24 commands against a fresh, migrated, loopback-only synthetic PostgreSQL database with `TEN98_INTEGRATION_TEST=1`. Do not run another worker against the Google fixture database: the fixture runner owns its queue worker and routes Google requests to an in-process, loopback HTTP provider.

```sh
node --test tests/google-reports.test.ts
node --env-file=.env tests/google-integration.ts
node --env-file=.env tests/google-retention-integration.ts
# Build first; supply an installed Playwright module URL and an available Edge channel.
node --env-file=.env tests/google-browser.ts
```

The optional browser runner requires `PLAYWRIGHT_MODULE`, defaults to the `msedge` channel, and uses `APP_URL`’s local port plus the next port for production SSR assets (`GOOGLE_BROWSER_SSR_PORT` overrides the latter). It runs the production client, actual API handlers, PostgreSQL and a queue worker through a test-only loopback front server. Google authorization and provider HTTP are synthetic; external browser requests are blocked. It checks callback workspace selection, newer navigation, import publication, expiry, disconnect and 360px overflow. Artifacts are private under `private/google-browser`.

These tests do not establish live Google consent/verification, account-specific permissions, quotas or production capacity. Those require a separately authorized real-account acceptance exercise. Full V1 and the other platform imports remain unfinished.

## Inspect indexed Search Console URLs

A current owner can expand **Inspect indexed URLs** on a ready Search Console source, enter 1–10 different HTTP(S) URLs and an optional BCP47 result language, then explicitly choose **Inspect URLs**. The default language is `en-US`. This queries Google's indexed version; it does not crawl a live page, request indexing, queue work or persist inspection history. Editing the form leaves any previous result labelled with its actual submitted URLs, property, language and check time. The control is unavailable to other roles, including administrators; existing imported-report reads remain available to current members.

The cookie-only `POST /api/projects/:projectId/google/connections/:connectionId/inspect` accepts strict `{urls, languageCode?}` JSON, at most 64 KiB, and no query parameters. Every normalized URL must fit 4,096 UTF-16 units and belong to the saved property before token refresh or inspection: domain properties admit that host and its subdomains; URL-prefix properties require the same scheme/host/port and normalized path prefix. Callers cannot supply a property, endpoint, token or alternate connection binding. API-key and MCP exposure remains a separate required P06 mapping.

The service reuses current owner/workspace, connection and active app locks. A preflight binding is rechecked before the separately committed refresh, each URL and final publication. A fresh cookie-session read follows external work. A 401 grant failure commits the reconnect state and discards the complete batch; Google 403 or changed native authority also discards it and prevents later dispatch. Ordinary quota/temporary/malformed-provider failures are sanitized per URL. Already dispatched requests cannot be retracted. The current lock strategy serializes the workspace during each request (up to the existing 15-second Google timeout); high-volume inspection would require a separately reviewed revocable lease, not removal of these authority checks.

A 30-second provider-work signal includes refresh and combines with caller cancellation and the existing 15-second individual request limit. Database lock waits are **not** a total HTTP-request deadline. An interrupted URL is marked attempted without a confirmed result; later URLs are explicitly not attempted. No retry is automatic. Each Google body and the complete returned JSON are bounded to 2 MiB; an oversized combined report returns a whole 503 error instead of silently dropping rows. The browser separately bounds and validates its complete response and clears it on access loss, connection/property changes or app disablement. The shared Google JSON decoder now rejects malformed UTF-8 for all callers; valid astral text is preserved. Earlier Google Ads validation does not cover this later shared-decoder change.

Returned fields are a bounded projection of Google's index/crawl/canonical, known sitemap/referral, AMP, deprecated mobile usability and rich-results modules. Missing modules/fields mean unavailable, not pass, failure or zero. Unknown Google state strings are preserved. Only Google's validated Search Console inspection link is clickable; source canonicals and other URLs are displayed as text. See the official [inspect request](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect) and [result contract](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult). The source-flow reference is OpenSEO 89e5a007 `inspect_urls`/`GscService.inspectUrls`; this implementation adds native current-authority/property bounds and makes no complete P57 or upstream MCP-parity claim.

Focused input/response/UTF-8 checks: `node --test tests/google-inspection-input.test.ts`. The new isolated native suite is `tests/google-inspection-integration.ts`; it requires an explicitly claimed, otherwise empty owned `ten98_gsc_inspection_<12hex>` database on 127.0.0.1:55501 and an in-process synthetic Google transport, with no jobs or paid calls. Its 30-second deadline case uses the real unchanged time limits. The component browser runner requires `TEN98_GOOGLE_INSPECTION_BROWSER=1`, `TEN98_GOOGLE_INSPECTION_DTOS` pointing to the unchanged native capture and `PLAYWRIGHT_MODULE`. Its genuine response replay is separate from live Google/compiled-App acceptance. Native, browser, integrated Google regressions and operational gates must be reviewed and run before an acceptance claim.
