# Google report imports

> Code and safety contracts retained from [docs/google-reports.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/google-reports.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/google-report-imports-implementation-history-meN6TCsw4E). Qualifications are preserved; this adds no acceptance claim.

This increment imports Search Console, GA4 and Google Ads reports using fixed read requests. It does not install browser tags, create a Google dashboard login, modify ads or campaign budgets, merge identities, or combine imported metrics with native analytics. Other platforms’ reporting imports and the full GA4 report inventory remain required and unfinished.

## Operator setup

1. Configure the credential encryption keyring and an instance operator. Fresh installation claimants are operators; upgraded installations require an explicit host `operator grant <email>` command. Workspace ownership alone does not grant instance configuration rights.
2. In Google Cloud, enable the Search Console API, Google Analytics Admin API and Google Analytics Data API. Configure the consent screen and a **Web application** OAuth client. Add test users while the Google app is in testing mode.
3. Open **Workspace settings → Google app setup**. Add the displayed exact `APP_URL/api/google/callback` redirect URI to that client. Enter its client ID and secret, and enable connections. Google determines any consent verification requirements; changing the testing checkbox here does not publish or verify the Google app.
4. Every save creates a new app revision, including changes to the enabled/testing flags. Pending connections are invalidated and existing sources require reconnection before further provider reads. Stored snapshots remain readable. Re-enter the client secret for a change; saved secrets are never returned to the browser.

For Google Ads, enable the Google Ads API and save a developer token in the same operator form. Its Google-approved access level and account permissions determine which accounts are accessible. The token is encrypted with the OAuth client secret, is never returned or logged, survives credential rekey, and is retained when the token field is omitted; an explicit removal clears it. Changes use the same revision/reconnect boundary. Google Ads uses the broad `adwords` OAuth scope, which can permit account changes. The app discloses that scope and restricts its implementation to fixed reporting queries; it does not claim that Google offers a read-only Ads scope. See [Google's authentication and headers contract](https://developers.google.com/google-ads/api/rest/auth).

Use a stable HTTPS `APP_URL` for a team deployment. Google permits appropriate localhost web-client redirects for local development. External consent apps in testing generally receive refresh tokens that expire after seven days for these scopes. See Google’s [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [token expiration rules](https://developers.google.com/identity/protocols/oauth2).

## Workspace connection and import

A workspace owner opens a project’s **Google reports**, selects Search Console, GA4 or Google Ads, names the source, and approves the disclosed Google permission. The callback returns to that authorized workspace/project. The server checks current ownership, the dashboard session, one-use browser-bound state, app revision and PKCE before storing encrypted tokens. Reporting consent never creates or changes a dashboard user.

Choose **Load available properties**, select an authorized property and confirm. A source’s property is fixed after selection; add another source for another property. GA4 discovery is paginated. Search Console lists only properties with verified read permissions. Domain-registry aliases do not automatically grant property access or merge their measurements.

Ads first lists directly accessible customer IDs. To select a managed client, enter a directly accessible manager customer ID without hyphens and choose **Load Ads accounts**. The fixed `customer_client` query lists its non-manager descendants. If that one bounded page has a continuation, discovery refuses rather than hiding accounts; choose an accessible sub-manager. Selection performs a fresh customer query and fixes the client ID, optional login-manager ID, time zone and currency. A manager itself is not an advertising report source. Google's [direct-account discovery](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts) and [hierarchy semantics](https://developers.google.com/google-ads/api/docs/account-management/get-account-hierarchy) explain the difference.

Choose a report and inclusive calendar dates, then **Import report snapshot**. The current date guard disallows dates later than the current UTC day; it does not convert source dates to UTC. Ranges span at most 366 dates. The worker must be running. There is no import scheduler or background account polling; **Refresh status** retrieves the current receipt. An uncertain request retry reuses the same request ID and payload instead of creating duplicate work.

Supported reports:

| Source | Reports | Measurement rules |
| --- | --- | --- |
| Search Console | Daily search traffic, queries, pages | Final web-search data, provider dates in America/Los_Angeles; clicks, impressions, CTR and average position remain distinct. Top-row and anonymized-query omissions are stated. |
| GA4 | Traffic by default channel, events by event name | Property-local dates/time zone and currency; exact decimal strings preserve numeric precision. User counts are report-specific and must not be added across rows or blended with native visitors. |
| Google Ads | Account, campaigns and ad groups by day | Account-local dates/currency; integer impressions/clicks/costMicros remain exact strings; conversions/value retain Google's numeric representation. One currency unit is 1,000,000 costMicros. Conversion attribution/settings and later restatements belong to Google, not native analytics. |

Each import stores normalized rows and source provenance, up to ten pages of 1,000 rows. Hitting 10,000 without reaching the end produces an explicit **partial** snapshot. Google may impose smaller/top-row results, sampling, thresholds, metric restrictions or truncation; whitelisted quality information is retained for each page. Restricted or absent values are unavailable, not zero. A legitimate empty report is different from a failed, queued or expired import. Raw provider response bodies are not retained.

Ads pins API v26 and uses `GoogleAdsService.Search` with fixed fields and no user-provided GAQL, URL, mutation, page size or continuation. Google's [fixed provider page size is 10,000](https://developers.google.com/google-ads/api/docs/reporting/paging). A single provider response is bounded by 15 seconds and 2 MiB, then normalized and published atomically as up to ten native storage pages. An unconsumed continuation means **partial** even when fewer rows were returned. Its presence, returned count and provider total count are separate metadata; the opaque token is not stored. A provider count beyond the storage integer range stays an exact metadata string. Oversized, malformed, foreign-customer or duplicate rows are refused as unavailable, never accepted as truncated success. Choose a smaller range after a size refusal or partial import. Missing zero-metric date segments are not generated locally. Imported account/campaign/ad-group reports overlap and must not be added together.

Google publishes the authoritative contracts for [Search Console query semantics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [property access](https://developers.google.com/webmaster-tools/v1/sites/list), [GA4 report requests](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport), [quality metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData), and [quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas).

## Permissions, removal and retention

Current project members can read imports. Only a current workspace owner can connect, select properties, enqueue, reconnect or disconnect. Authorization and revisions are checked again for every provider page. Removed owners cannot continue queued imports. Provider request URLs are fixed Google endpoints, redirects are rejected, and each response is time/size bounded. Successful refresh-token rotation is committed before a downstream report request, so report failure cannot restore an invalid old grant.

**Disconnect** removes local credentials, invalidates pending authorization flows and denies active imports. It does not contact Google. **Disconnect and revoke at Google** first performs that local removal, then requests remote revocation; Google may revoke a wider app grant and affect other connections. The outcome distinguishes confirmed from unconfirmed remote revocation. Missing encryption keys cannot prevent local removal. Existing snapshots remain available until their retention period ends.

Workspace **derived history** retention (default 365 days) removes rows and quality metadata from terminal imports older than their completion-time cutoff. Cleanup preserves the request ID, original outcome, recorded counts and source receipt. A retry returns that expired receipt; it does not re-import data. Active imports, credentials and all financial/request ledgers are preserved. The UI identifies expired snapshots and clears previously displayed rows on refresh. See [retention](retention.md) for bounded cleanup, backups and policy changes.

## Validation and remaining gates

Run Node24 commands against a fresh, migrated, loopback-only synthetic PostgreSQL database with `TEN98_INTEGRATION_TEST=1`. Do not run another worker against the Google fixture database: the fixture runner owns its queue worker and routes Google requests to an in-process, loopback HTTP provider.

```sh
node --test tests/google-reports.test.ts
node --test tests/google-ads.test.ts
node --env-file=.env tests/google-integration.ts
node --env-file=.env tests/google-retention-integration.ts
# Separate fresh ten98_google_ads_<12hex> fixture, loopback PostgreSQL 55501 only:
node tests/google-ads-integration.ts
# Build first; supply an installed Playwright module URL and an available Edge channel.
node --env-file=.env tests/google-browser.ts
```

The optional browser runner requires `PLAYWRIGHT_MODULE`, defaults to the `msedge` channel, and uses `APP_URL`’s local port plus the next port for production SSR assets (`GOOGLE_BROWSER_SSR_PORT` overrides the latter). It runs the production client, actual API handlers, PostgreSQL and a queue worker through a test-only loopback front server. Google authorization and provider HTTP are synthetic; external browser requests are blocked. It checks callback workspace selection, newer navigation, import publication, expiry, disconnect and 360px overflow. Artifacts are private under `private/google-browser`.

These tests do not establish live Google consent/verification, account-specific permissions, quotas or production capacity. Those require a separately authorized real-account acceptance exercise. Full V1 and the other platform imports remain unfinished.

The new Ads native test uses real dashboard sessions, OAuth/PKCE, queue and PostgreSQL snapshot paths with only Google's transport injected in-process. Its eight groups cover four-role/foreign access, encrypted developer-token save/removal/rekey, direct/manager selection, exact metrics, atomic 10,000-row partial storage, true empty results, refusal/recovery, current role/app-revision denial, disconnect and retention/idempotent expired receipts with an unchanged empty financial ledger. It is prepared for independent execution; pure/type checks alone do not establish its native, browser or production acceptance. Original GSC/GA4 and refresh-rotation tests are preserved.
