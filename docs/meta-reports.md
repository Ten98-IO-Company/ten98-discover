# Native Meta advertising report imports

**Implementation contract, reviewed 2026-10-13.** Authorization, account selection, local deletion and manual daily report imports are implemented with synthetic API/worker/browser acceptance. Schema26 adds grant-bound report storage and extends keyless deletion to its payloads. Campaign inventory, schedules, latest-overlap views/export and live-provider validation remain required. This is the next native reporting connector after Google. It covers the Meta/Facebook entry in P76 and contributes to P71, P77 and P81. All81 requirements remain required; this document does not complete those rows or the other platforms.

The accepted [tracking contract](tracking.md#automatic-consolidation-without-misleading-totals) requires accessible advertising accounts/campaigns, daily spend, impressions, clicks and available conversion/value fields. Meta Marketing API advertising reports include supported Instagram placements within those advertising accounts. Facebook Page Insights, organic Instagram insights, publishing, inboxes, audiences, campaign editing and Conversions API uploads are not this accepted reporting family. A Meta Pixel ID neither authorizes reports nor identifies an ad account. Report authorization never installs or enables a browser pixel, changes consent, or signs someone into ten98-monitor.

## Evidence and unresolved provider gates

These are separate kinds of evidence:

| Evidence inspected | What it establishes | What it does not establish |
| --- | --- | --- |
| Meta's [official Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi) | Advertising-account access, user/system-user token families, and distinction between Standard access to own accounts and Advanced access for others' accounts | Approval of any particular self-hosted app, exact token lifetime, or current eligibility of a business |
| Tagged official Python SDK [26.0.2 configuration](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/apiconfig.py) | That SDK's default is `v26.0` | An independently verified current Marketing API support window; an SDK default is not a version lifecycle guarantee |
| Tagged [AdAccount](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py), [User](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/user.py), and [AdReportRun](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adreportrun.py) contracts | Read edges, asynchronous report creation/status/results, account metadata and permission edges | Availability of every generated field for every account, permission tier or report combination |
| Tagged [AdsInsights](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adsinsights.py) | Field names and attribution/report-time parameter vocabulary | Whether legacy enum values still work, current attribution interpretation, or completeness of returned data |

Initial documentation fetches returned HTTP429. Subsequent direct browser inspection on 2026-10-13 reached Meta's current `/documentation/` pages and resolved the version, login, token-exchange, history, async and deletion contracts below. **Pin `v26.0` for this implementation.** The focused review records a material attribution-documentation conflict; imports preserve Meta-reported values without promising a fixed effective attribution profile. Deauthorization notification details and controlled provider acceptance remain gates. No caller-supplied version, silent fallback or unversioned report URL is permitted.

### Subsequent primary-document verification

- The [Marketing API version history](https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions) lists v26.0 released July 29, 2026 with expiration TBD. It lists v24.0 expired October 6, 2026. An unspecified future expiry is not a support guarantee.
- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business) supports `ads_read` and configuration-based consent. A business-type app selects token type, assets and permissions and receives `config_id`. Serving other businesses requires Advanced Access review; external-user login also requires appropriate `public_profile` access. Automated Insights is a documented system-user-token use case, but its separate business-portfolio requirements must not be imposed on the simpler user-token path.
- The [manual login flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow) supports server-side authorization-code exchange with the same redirect URI, followed by token inspection and granted-permission checks. Its reviewed parameter list does not establish PKCE support. Keep the session-bound state/browser defenses below and do not invent PKCE or refresh-token parameters.
- The [Ads Insights guide](https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights) identifies `ads_read` for reports and documents account, campaign, ad-set and ad edges. This application's accepted initial grains remain account/day and campaign/day.

The plan is original. No Meta SDK is installed or copied. Existing [Google reports](google-reports.md) supply the in-repository flow pattern; the pinned OpenSEO source informed that Google implementation, not a nonexistent Meta adapter. Meta's SDK license and debug behavior are not imported into the MIT application.

## Reuse and operator setup

Reuse PostgreSQL, pg-boss, `credential-vault.ts`, instance operators, current session/origin/body/rate guards, actor-bound request receipts and workspace/project lock order. Reuse the Google UI sequence and validation lessons, not its provider-specific token exchange, refresh-token logic or HTTP-under-workspace-lock implementation. `providers.ts` currently models paid OpenRouter/DataForSEO credentials; historical advertising spend must not become a charge in that ledger. No broker, SDK, new runtime dependency or general connector framework is needed.

1. An instance operator opens **Workspace settings → Meta app setup**. Show the exact HTTPS `APP_URL/api/meta/callback`, app registration instructions, and privacy/deletion/deauthorization URLs required by the verified Meta app configuration. No shared ten98 developer app or hosted OAuth relay is required.
2. The operator supplies the app ID, write-only app secret and Facebook Login for Business configuration ID. The initial user-token configuration requests reporting access; a separately reviewed system-user configuration can support eligible business integrations. Keep app mode and approval claims visibly **operator-declared**; a checkbox cannot verify or publish a Meta app. A free selected-asset read is separate evidence of effective permission.
3. Configure `ads_read` and invoke consent with `config_id`, explicit code response and the fixed callback/state. Do not add `ads_management`, Page permissions or `business_management` merely to populate a richer selector. If a necessary discovery endpoint requires more access, justify that endpoint before widening consent. Allow explicit ad-account selection and direct validation rather than pretending business-wide discovery is mandatory.
4. Saving operator configuration increments its revision. Pending flows and future reads using an older app revision require reconnection; retained reports remain readable. Explain that impact before saving. Disable is always available even if the vault cannot decrypt the prior secret.
5. Normal team deployment uses a stable HTTPS origin. Do not advertise a localhost exception until Meta's current redirect rules have been verified. The native app still runs locally without Meta connected. Docker restore keeps imports paused until the operator validates origin, app revision and credentials.

Current Google permissions provide the initial role model: current workspace owners authorize/select/disconnect/schedule/import; current members read retained reports. Instance-operator status alone grants no workspace report access. A future delegated connection permission must be deliberate, not inferred from an arbitrary role string.

## Connection and security boundary

Use one project-scoped connection for one immutable selected ad account, displayed from the workspace's Connections surface. A source can be connected before selection; choose another source for another account. Reconnecting an existing source must prove access to its original account, not silently replace it. Prevent duplicate active account sources within a project; other projects/workspaces may independently authorize that account without learning about one another.

The server starts a ten-minute, one-use OAuth flow bound to the actual local session ID, user, workspace, project, app revision and optional reconnect revision. Store only digests of 256-bit state/browser bindings; use an HttpOnly, secure-in-HTTPS, SameSite callback cookie. Reject duplicate query parameters, wrong browser/session and replay. The callback claims only the matching flow, performs bounded server-side exchange and token inspection, then rechecks the live session/owner/app/connection before committing credentials. Never grant dashboard identity from reporting consent. Return only a fixed success/failure fragment and authorized workspace/project UUIDs; clear it promptly and respect newer explicit navigation.

Use the provider's supported authorization-code flow. **Do not copy Google's PKCE or refresh-token parameters and claim Meta supports them.** Enable PKCE if the reviewed Meta flow supports it, recording the exact mechanism. Verify the returned token belongs to the configured app, has granted reporting permission, and has usable access/data-access expiry metadata before account selection. Persist the actual granted capabilities and token type, not the requested scopes as proof. Renew only through a verified Meta-specific exchange; otherwise show **Reconnect** before expiry. A zero/missing expiry is not proof that access can never be revoked. Manual system-user-token setup is a possible separately reviewed operator path, not a replacement for the accepted easy OAuth flow.

App secrets and token envelopes use separate vault contexts including installation/workspace, object ID, provider purpose and revision. Tokens, authorization codes, app-secret proofs, raw paging URLs and raw provider errors never reach public destination configuration, browser storage, logs, exports or jobs. Jobs carry local import IDs only. Secret rotation/rekey readiness includes both app and connection envelopes. Keep successful credential renewal in its own committed transaction before dependent report work so later failure cannot restore an obsolete token.

**Disconnect** immediately erases local tokens, increments connection revision, invalidates flows and stops future publication. It succeeds with missing keys and without contacting Meta. **Disconnect and revoke at Meta** is a separately explained choice because app-grant revocation can affect other sources; local removal commits first and remote result is `confirmed` or `unconfirmed`. The signed data-deletion callback follows the verified contract in the appendix and binds the app-scoped subject to retained provenance. The separate deauthorization notification contract still requires verification. Neither route is a generic unsigned webhook.

## Fixed provider request contract

`{v}` below is the reviewed code constant. `{account}` and `{report}` are server-validated digit strings, never floating-point numbers. Prefix `act_` is added once internally. Browser authorization goes only to the exact reviewed Facebook login origin; credentialed API calls use `https://graph.facebook.com/{v}/` with no redirects, URL overrides, batch-subrequest API, caller fields or caller filters.

| Method and relative path | Purpose and bounded fields |
| --- | --- |
| `GET me/adaccounts` | Explicit account discovery: `id,account_id,name,currency,timezone_name,account_status`; page size100 |
| `GET act_{account}` | Revalidate selected account and its currency/timezone; no billing, funding-source or audience fields |
| `GET act_{account}/campaigns` | Campaign inventory: stable `id,name,status,effective_status`; page size100, including inactive/archived metadata where the verified API permits it |
| `POST act_{account}/insights` | Create an asynchronous **read report**, not an advertising mutation; fixed report definition described below |
| `GET {report}` | Saved report ID only: `id,account_id,async_status,async_percent_completion,date_start,date_stop`; verify account and range |
| `GET {report}/insights` | Read that saved completed report's pages, fixed fields and page size500 |
| `GET me/permissions` | Verify effective granted permission; no inference from successful OAuth redirect alone |
| Explicit `DELETE me/permissions` | Optional remote app-grant revocation only; never used by a report worker |

The account/report/user edge shapes above are evidenced in the tagged official SDK. Code/token exchange and token-inspection routes belong to a separate fixed authentication allowlist whose exact methods/parameters must be frozen from current primary login documentation. Do not treat every POST as a paid/mutating-ad request, or permit every Graph POST because async Insights uses one.

Build authorization headers server-side. Where app-secret proof is required/supported, derive it per request with the app secret; the official [session implementation](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/session.py) is a reference for that mechanism. Treat any token-bearing query required by an authentication endpoint as secret and disable URL/body logging there. Bound each HTTP request to30s and4MiB decoded JSON, with stream cancellation, strict shape/Unicode/ID validation and sanitized errors. These are proposed application limits, not provider quotas.

Never fetch `paging.next` or `async_report_url` as authority. Keep only a bounded opaque `after` token (maximum4096 bytes), and rebuild the same allowlisted route, account/report ID and parameters. Reject conflicting cursors, repeated cursors, changed source metadata, duplicate row keys or cross-account rows. Public pagination uses an authenticated, scope-bound cursor containing no provider URL or token; never allow a browser to supply an arbitrary Graph continuation.

## Report grain and measurement

Initial fixed definitions are **Account by day** (`level=account`) and **Campaign by day** (`level=campaign`), with `time_increment=1`, explicit `time_range`, no demographic/platform breakdown and `action_breakdowns=action_type`. Both supply `account_id,account_name,account_currency,date_start,date_stop,impressions,clicks,spend,actions,action_values`; campaign reports also supply `campaign_id,campaign_name`. Names are display text, not join keys. Inventory includes campaigns without reported activity; an omitted Insights row is not an invented zero-activity campaign.

The first definition preserves **Meta-reported attribution**. Record requested windows `7d_click` and `1d_view` separately from effective ad-set settings, which remain unknown unless evidenced in the response. Do not send `action_report_time` or account/unified override flags and advertise them as controlling the result: Meta's current best-practices page says report time and unified-setting controls are disregarded, despite conflicting parameter-reference descriptions. The documented mixed policy uses impression time for on-Meta actions and conversion time for off-Meta actions. Preserve totals and each returned window without summing them; show the exact action type and the source policy. Unknown effective settings prevent normalized cross-source conversion totals, CPA or ROAS claims. They do not prevent displaying the provider's labelled rows. The primary-document conflict and controlled-account check are recorded below.

Represent source dates as `YYYY-MM-DD` in the ad account timezone, not UTC buckets. Store exact currency and timezone with every report; a change during pagination rejects that publication. Default range ends yesterday in the account timezone; an explicitly selected current day is labelled provisional. Validate against the source's local date and the documented37-month rolling query limit, using clamped calendar subtraction. That maximum is not a guarantee of availability for every field/account. Application chunk size is at most31 days per import; users can request separate bounded historical ranges. Spend is provider-estimated, not a billing settlement.

Preserve integer counts and monetary/action decimals as bounded decimal strings, with null for omitted/restricted/unsupported metrics. No binary floating-point or USD-only money helper for advertising amounts. `actions` and `action_values` remain separate keyed arrays carrying exact `action_type`, total value and any returned window values. Conversion counts may be fractional. Reject duplicate action keys and malformed nested values. Do not add parent/child action categories or overlapping attribution windows. A selected conversion/value metric always names its exact action type and profile; an absent action is unavailable unless the verified provider contract establishes zero for that case.

No cross-platform unique-conversion, reach or person totals. Account and campaign reports are alternative grains, not additive datasets. Source identity includes provider, ad-account ID, definition/version, date, level/entity, attribution profile, timezone and currency; connection UUID is not the provider's account identity. An account linked to two projects must not double its spend in a workspace consolidated view. Cross-currency totals require a separate explicit FX contract; daily aggregates cannot be exactly moved into another timezone. Reports are not attributed to a canonical/alias hostname without provider evidence.

## Durable imports, retries and scheduled refresh

An explicit import binds actor, project, source, current app/connection revision, report definition and date range to a request UUID and canonical hash. Same ID/same request returns the durable receipt, including after expiry; changed body or actor is409. Replay never restarts a provider report. Enqueue and receipt commit together. At most one active import per connection; different snapshots are not added together as fresh events.

Use one Meta queue and a short database lease/generation per import step. Lock registration → workspace → project → connection → import; verify current owner, enabled app, selected account and captured revisions before each outbound operation and again before accepting its result. Release all SQL locks for network, polling and backoff. A late result cannot publish after disable, disconnect, role loss, cancel, lease replacement or expiry. The worker can resume saved report ID/cursor after restart, but cannot create the same logical report repeatedly.

State sequence: `queued → submitting → waiting → reading → completed|partial`; terminal alternatives are `failed|denied|cancelled|submission_unknown`. Persist `submitting` before report-creation POST. A lost response/crash before saving the report ID is `submission_unknown`: no automatic POST retry or invented zero. An explicit new import may supersede it; acknowledge that Meta may still have an uncollected report. Cancel stops local work and fences late responses; do not claim remote report cancellation without a verified endpoint.

Poll a known ID at a bounded cadence, persisting attempt count, next allowed time and deadline. Proposed bounds:30-minute overall import deadline, at most120 status polls,50 result pages of500 rows (25,000 rows), and three transient GET retries with delayed backoff. Reaching a page/deadline bound after verified rows yields labelled partial coverage only if those rows are internally consistent; malformed/contradictory data fails the snapshot. Narrow the date range to continue; no lifetime report-count cap. Never busy-loop or hold a queue handler asleep for the entire deadline.

HTTP status and Graph's structured error must both be checked. Credential/permission failure marks the connection reconnect/access-lost and denies pending work; throttling pauses until the persisted retry time. Parse only the appendix's reviewed numeric usage/error fields, bounded Retry-After and provider retry hints; unknown error codes are unavailable, not permission grants or zero rows. Coordinate app/account throttling without leaking cross-workspace account existence. Do not hardcode an unverified calls-per-hour allowance or infer permissions from an API access-tier label. Reads require no advertising-spend reservation, but still consume quotas and local resources.

Scheduled imports remain part of P76/P81. After a successful manual import, an owner may enable daily refresh at a displayed IANA wall time, with next occurrence and last successful coverage visible. Default re-fetch is the preceding28 closed account-local days, bounded to the supported attribution/history contract; this is a proposed correction lookback, not a promise of final conversions after28 days. Disable by default, retain the approving actor and immutable definition, recheck current permission, deduplicate each occurrence, skip missed intervals without an unbounded catch-up burst, and pause on changed app/account/definition or lost access. Longer manual historical backfills remain available. Native PostgreSQL calendar logic and the existing non-overlapping worker pattern suffice; no new scheduler service.

The current service publishes a validated immutable receipt atomically after pagination, with separate history and row pagination. **Latest-overlap selection remains pending.** That required view will select complete snapshots for the same logical daily keys; a partial/failed refresh must not erase a prior complete snapshot or turn omitted rows into zero. Reconcile a completed empty query as an explicit successful-empty range, with its coverage receipt, rather than synthesizing rows. Keep old immutable receipts for audit and expose snapshot IDs in drilldown. Selection between overlapping snapshots must use request creation order, not response completion order, so an older slow request cannot overwrite a newer result.

## Storage and returned interface

Six narrow tables mirror existing import storage: `meta_app_registration`, `meta_oauth_flow`, `meta_connection`, `meta_deletion_request`, `meta_import`, `meta_import_page`. Retained app registrations and signed deletion receipts are required lifecycle data. Composite foreign keys bind workspace/project/source; unique actor-bound request receipts and one-active-source constraints are enforced in SQL. Import fields include captured source/definition, original actor and app-scoped grant provenance, status, lease/generation, provider report ID, submitted/read timestamps, retry/deadline/cursor, recorded counts, diagnostic code, outcome and irreversible expiry marker. Page rows have stable normalized row keys and hashes; public report pagination is50 rows. Schedule authority, revision/next-due metadata and deduplicated occurrence storage are future required schema; migrations25/26 do not implement them.

Proposed source DTO (all timestamps ISO strings; no token or provider cursor):

```ts
type MetaSource = {
  provider: 'meta_ads'; accountId: string; accountName: string;
  currency: string; timeZone: string; graphVersion: string;
  report: 'account_daily' | 'campaign_daily'; definitionVersion: number;
  level: 'account' | 'campaign'; breakdowns: [];
  attribution: { mode: 'meta_reported'; requestedWindows: string[];
    reportingPolicy: 'meta_mixed'; effectiveAdSetSettings: 'unknown' };
};
type MetaReportPage = {
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  import: { id: string; status: string; dataStatus: 'available' | 'pending' | 'unavailable' | 'expired';
    source: MetaSource | null; from: string; to: string; requestedAt: string;
    completedAt: string | null; recordedRows: number; readableRows: number | null;
    coverage: 'complete' | 'partial' | 'unavailable'; warnings: string[];
    nextRetryAt: string | null; diagnosticCode: string | null };
  rows: MetaDailyRow[]; nextCursor: string | null;
};
type MetaDailyRow = {
  date: string; accountId: string; campaignId: string | null; campaignName: string | null;
  impressions: string | null; clicks: string | null; spend: string | null;
  actions: { type: string; value: string | null; windows: Record<string, string | null> }[] | null;
  actionValues: { type: string; value: string | null; windows: Record<string, string | null> }[] | null;
};
```

Keep status values closed to the sequence above in implementation. Available empty reports return rows`[]`, readableRows`0`; failed/pending/expired reports return rows`[]`, readableRows`null`. Dates, names and IDs remain data rendered as text. Any CSV export uses the existing formula-injection protection and preserves exact decimals/source definitions.

Signed deletion additionally returns a null source and unavailable payload at its
grant fence, before cleanup reaches that particular import. Ordinary retention
expiry preserves the captured source label and minimal receipt; it never exposes
residual rows. Neither state is a successful empty report.

Implemented service seams are `get/saveMetaApp`, `startMetaConnect`, `metaCallback`, `listMetaAccounts`, `selectMetaAccount`, `enqueue/read/listMetaImports`, `cancelMetaImport`, `disconnectMeta`, `runMetaImportStep`, and `expireMetaImportPages`. Campaign inventory (`listMetaCampaigns` and the campaigns transport row above) remains pending. App settings use `/api/meta/app`; authenticated project routes use `/api/projects/:projectId/meta/...`; import create/cancel are POST with request ID and strict Origin/body limits. Create also requires the source revision. Browser account selection sends an ID plus connection revision; the server verifies it rather than trusting cached options. Public callback routes are explicitly separate from authenticated mutations.

Only extract a shared OAuth cookie/cursor helper from Google if both actual implementations need exactly the same contract. Keep transport/auth/report parsing/jobs independently testable with injected synthetic fetch. GPT owns auth, tenancy, transport, state machine and measurement; appropriate Kimi leaves are a pure controlled account picker and a decimal/action report normalizer supplied with a frozen public schema and adversarial fixtures.

## Retention, usability and release checks

Normalized aggregate rows use workspace derived-history retention (365-day default). Raw provider JSON is not persisted; any deliberately added raw evidence later uses the90-day provider-evidence policy. Preserve connection/account configuration and minimal idempotency/source/outcome/count receipts. Mark a terminal import expired before bounded page deletion; API responses mask residual pages immediately. Once marked, finish physical cleanup despite policy extension. Retrying an expired request returns the expired receipt; an old worker/restart cannot restore payloads. A separately requested fresh report is new evidence, not resurrection of that receipt. Provider-mandated deletion/revocation obligations remain a distinct verified release requirement, including operator backups.

The required end-to-end flow is **Meta ads → Connect → Choose account → Meta reports → Import report → Review data → Optionally schedule**. The schedule and latest-success/overlap workflows remain pending. Explain missing operator configuration without exposing secret fields. Account cards show name and stable ID, currency/timezone and access result; an empty list offers reconnect/check assigned assets, not “no ad accounts exist.” The manual report view selects one retained receipt, preserving partial/expired/empty labels and attribution. Cancel/back preserves already authorized durable work; ambiguous acknowledgement offers only same-request retry. A 360px table scrolls horizontally with readable columns, keyboard focus and reachable actions.

Required acceptance before claiming this adapter works:

- Synthetic OAuth/session/browser/replay/cross-tenant tests, missing permission, unexpected app/subject, app revision change, secret-free errors/config/exports, local disconnect with broken vault, and signed callback forgery/replay.
- Actual PostgreSQL receipt+queue rollback; held provider response then demotion/disconnect/account change; duplicate workers; async POST lost acknowledgement; process restart at every checkpoint; cancel/fencing; bounded pagination/throttle/deadline and denied arbitrary URLs/fields/mutations.
- Golden rows for fractional action counts, large exact decimals, null versus zero, duplicate actions/rows/cursors, incompatible metadata, late corrections, overlapping account/campaign snapshots, currency/timezone/DST boundaries, partial versus empty and expiry mid-page. No native event insertion or pixel invocation from reports.
- Production browser setup/import/schedule/reconnect/error/retry flows, live-role purge, no stale cross-project response, keyboard/360px rendering; Docker restart, paused restore, key rewrap and retention cleanup.
- A separately authorized controlled real Meta app/account read, including consent denial, selected asset, report pagination, revocation/expiry and comparison with the same Ads Manager dates/grain/profile. Confirm current API version, app approval and provider-specific semantics. Fixture success cannot substitute for this gate; no such account or provider call was used in this planning work.

## Focused implementation review: remaining gates

This appendix separates the reviewed request vocabulary from behavior that still needs current documentation or controlled provider acceptance. It does not record a connected Meta account or a successful provider import.

**Token exchange is now specified.** The current [access-token guide](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens) describes typical short and long lifetimes, while allowing earlier expiry; neither a guessed60-day deadline nor a missing time expiry establishes permanent access. The [long-lived user-token guide](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived), updated June30,2026 and inspected in the browser during this review, documents `GET /v26.0/oauth/access_token` with `grant_type=fb_exchange_token`, `client_id`, `client_secret` and a valid short-lived `fb_exchange_token`. Its response carries `access_token`, `token_type` and `expires_in`. Exchange and inspect on the server, commit the replacement vault envelope before later reads, and reconnect when the token has already expired. This establishes no generic OAuth refresh-token loop; SDK-managed renewal is not evidence that a server-only integration can renew indefinitely. Keep token and data-access expiry distinct, validate the configured app and required permission, and sanitize the entire secret-bearing authentication URL.

**Keep discovery and reporting separate.** The tagged [User read edges](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/user.py) support ad-account discovery and permission inspection without introducing business-wide asset enumeration. The tagged [AdAccount read contract](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py) distinguishes campaign inventory from Insights. An inaccessible or absent campaign in today's inventory must not discard a valid historical campaign report row. Conversely, completing account discovery is not proof that every business asset was returned. Preserve discovery completeness and direct selected-account validation; do not widen permissions to conceal an incomplete selector.

**Use explicit asynchronous success.** Account Insights creation uses POST, then a saved report node and its Insights GET edge. The tagged [AdReportRun fields](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adreportrun.py) include status, progress, account and date metadata, error codes, and report-definition metadata. Require `Job Completed` and100-percent progress before reading results. Unknown status, failed status and contradictory account/range remain unavailable. Compare effective definition metadata when returned; absence remains unknown. Verify which optional metadata fields are readable during controlled acceptance. Never follow the returned export URL or email/scheduling fields.

**Action values retain their shape.** The tagged [AdsActionStats schema](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adsactionstats.py) represents totals and attribution-window values as strings. Preserve reviewed window keys and exact decimals; do not flatten `actions` and `action_values` into a fabricated universal conversion total. The generated [Insights vocabulary](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adsinsights.py) includes many historical and specialized window values. Enum presence alone does not establish current account eligibility or justify enabling every value.

**Deletion needs retained author provenance.** As an application design requirement, store the immutable Meta app identity and verified app-scoped user subject on connections and the provenance of imports collected through that grant. A later reconnect, app configuration revision or local disconnect must not destroy the mapping needed to process a legitimate signed request. Do not treat the shared advertising account ID as the requesting person: independently authorized sources can use the same account. Subject-scoped deletion must fence matching flows, connections and jobs first, then purge covered retained payloads in bounded transactions. It must work without a local login, current workspace-owner role, or a decryptable user token once the provider signature is verified. The durable deletion receipt/status record supports idempotency and truthful acknowledgement. The callback mechanism is verified below; operator backup obligations and actual completion remain release checks. No deletion completion should be claimed while required cleanup remains pending.

The remaining provider gates are precise: separate deauthorization notification verification; account-specific effective attribution and returned metadata; controlled permission/token-revocation and report acceptance; deletion completion including operator backups. The resolved history, asynchronous and rate vocabularies below do not establish unlimited availability. App limits of31days,25,000rows and30minutes are capacity choices. The smallest implementation remains one native user-token connection, direct account selection, account/day and campaign/day imports, then optional daily refresh after the first successful manual import. Reuse the existing vault, session-bound consent, durable receipt and retention patterns; keep a Meta-specific bounded transport and state machine rather than importing Google's token or network-under-lock behavior.

### Signed deletion callback verified after the focused review

The primary [data-deletion callback guide](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback), updated November7,2025 and inspected directly in the browser, specifies an HTTPS POST carrying form field `signed_request` and an app-scoped `user_id`. Verify its signature over the original encoded payload using the app secret and HMAC-SHA256, then return JSON containing `url` and `confirmation_code` for the actual deletion-status page. The guide permits an instructions URL instead; this native connector deliberately chooses the callback flow. Delete covered Facebook data, not only the access token.

Application safeguards are original: select one known app-registration verifier from the configured callback route; bound the form and both base64url segments; enforce the declared algorithm, a32-byte signature and strict decoding; use Node's constant-time comparison before trusting subject fields. Keep a durable request digest and opaque confirmation receipt so redelivery resumes or reports the same cleanup. Do not expose the subject, account, token or workspace at the public status URL, and do not reuse an OAuth flow's ten-minute timeout as an invented deletion delivery rule. Distinguish this verified deletion contract from the still-unverified deauthorization notification contract.

The accepted app lifecycle uses retained app-registration rows, with exactly one active for new OAuth. A new Meta app ID creates a new registration; the previous registration remains addressable for callbacks and covered-data provenance. Rotation for the same Meta app updates that registration's current encrypted verifier and increments its revision; never try every historical secret. Signed callback URLs bind the public registration UUID: `/api/meta/apps/:id/deauthorize` and `/api/meta/apps/:id/delete-data`. OAuth keeps the fixed `/api/meta/callback` and resolves the captured registration through its state. Retire an old registration only after its covered-data cleanup obligations are satisfied; changing apps does not require deleting retained reports immediately.

### Insights documentation conflict, history and async limits

The [ad-account Insights reference](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights), updated August6,2026, describes `7d_click`/`1d_view`, impression-time controls and attribution-setting flags. It also specifies date-only `time_range`, integer `time_increment` from1 to90, and `time_ranges` overriding both. The first definition sends only the explicit range and increment1. The reference limits history to37 months with error3018 for earlier starts. Use clamped calendar subtraction without promising that every field/account has that history. Spend is estimated; actions are broader than conversions, and certain non-inline iOS14.5 combinations may return no data.

The [Insights best-practices guide](https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/best-practices), updated May5,2026, conflicts with that reference: its June10,2025 change notice says `use_unified_attribution_setting` and `action_report_time` are disregarded, with ad-set attribution and mixed reporting time. A later paragraph still advises an override. Therefore the application records Meta-reported values and requested windows separately, with unknown effective ad-set settings; it never promises fixed impression-time attribution. This is a deliberate response to conflicting primary evidence, pending controlled verification.

That guide documents async states `Job Not Started`, `Job Started`, `Job Running`, `Job Completed`, `Job Failed` and `Job Skipped`; only Completed plus100-percent progress permits result reading. Reports may take an hour and saved report IDs expire after30 days. The application's30-minute deadline is stricter capacity, not a provider guarantee. It describes `x-fb-ads-insights-throttle` fields `app_id_util_pct`, `acc_id_util_pct`, `ads_api_access_tier`, and `x-ad-account-usage`; persist bounded backoff near saturation. Reviewed errors include4 for load,4/1504022 globally, and100/1487534 for oversized data. Do not confuse API access-tier labels Limited/Full with OAuth permission Advanced Access or infer a fixed hourly quota. All rate values are internal scheduling hints, not cross-workspace disclosures.

### First auth implementation boundary

The first security increment creates only app-registration, OAuth-flow, connection and deletion-receipt storage. `meta-auth.ts` owns operator configuration, current-role consent/account selection, credential lifecycle and readiness/rewrap; `meta-http.ts` owns fixed request builders, bounded transport and lossless response decoding; `meta-callbacks.ts` owns signed provider notifications and deletion fencing; `meta-api.ts` owns the narrow routes. Import/page storage and the report worker follow separately. Existing vault, instance-operator, session, `readJson` and workspace/project transaction helpers can be reused. Do not share Google's provider-specific token exchange or hold its workspace transaction across Meta network calls. Add explicit readiness/rekey and restore-quarantine integration before enabling connections; migration numbering and exact exports are assigned during implementation ownership review.

The primary asynchronous example returns `report_run_id` as a JSON number. Native `JSON.parse` without a reviver can round large integer IDs before validation. Use Node24's reviver source text for reviewed ID fields, accepting only bounded decimal integer lexemes and returning exact strings; ordinary documented safe integer IDs must also work. Do not reconstruct an unsafe ID from the rounded JavaScript number, accept exponent/fraction ID syntax, or add a dependency for this native capability. Auth and reporting parsers remain separate strict schemas even when they share that small transport decoder. Synthetic checks must cover an ID beyond JavaScript's safe-integer range, ordinary numeric report IDs, malformed/fractional IDs, permission/expiry mismatch and sanitized failures.

### Transport and signed-request primitives accepted locally

The first code checkpoint implements only `meta-http.ts` and `meta-signed-request.ts`, with 17 synthetic test groups. Fixed Graph v26.0 auth/account operations enforce bounded streaming, strict UTF-8, lossless decimal IDs, cancellation, sanitized failures and no redirects. Current primary [token-error guidance](https://developers.facebook.com/docs/facebook-login/access-tokens/debugging-and-error-handling) documents code 190 for expired, invalidated and deauthorized tokens; these errors request reconnect without automatic retry. Other unmapped provider errors remain explicit failures.

The signed deletion verifier validates canonical encoding and current-secret HMAC before reading the subject. Exact IDs and timestamps cannot be rounded by JSON parsing, duplicate root fields are rejected, and the receipt digest identifies the original encoded payload rather than its signature. Legitimate redelivery signed after secret rotation therefore has the same identity. Optional timestamps are metadata; this primitive does not invent a delivery-age rule or delete any records. This paragraph records the first primitives checkpoint; the later [auth implementation and browser acceptance](meta-auth.md) supersede its scope. Neither synthetic checkpoint establishes a connected live Meta account.

### Schema 26 authorization and deletion acceptance

The later [auth implementation](meta-auth.md) supplies the ready-source gate used
by report work. It rechecks current owner, immutable account, app/connection
revision, grant and deletion state before local publication; unknown data-access
expiry is inspected freshly, without SQL locks across network. Seven independent
PostgreSQL gate groups passed with synthetic responses.

`0026_meta_imports.sql` adds only `meta_import` and `meta_import_page`. Scoped
foreign keys bind each retained import to its original grant/connection/project/
workspace and bind each page to its import. A partial unique index permits one
active import per connection. The existing actor-bound content receipt stores the
request hash and import ID; the import row keeps immutable request identity,
captured source, bounded lease/progress fields and separate expiry/deletion markers.
No new scheduling authority is introduced by this migration.

The deletion worker includes these tables in its covered-data completion test,
fences late publication and removes at most five pages from one import per batch.
It requires no vault access after signed admission and preserves minimal outcome
receipts, later reconsent and replacement-app sources. Eight existing callback
groups and six new report-deletion groups passed on separate fresh PostgreSQL 18
databases through migration 26. The checks include rollback after payload writes,
residual pages under an earlier expiry marker, old grants already invalidated and
cross-app provenance. They establish local synthetic behavior, not report-worker,
scheduled-refresh, live-account or backup-deletion acceptance.

The separate original-record upgrade suite passes through migration 26, including
prior feature and identity-capsule preservation, migration rollback and repeat-run
idempotence. CI assigns report authorization, report deletion, import service and
import worker suites separate fresh databases; hosted execution is a separate
result from these local checks.

### Manual report acceptance, 2026-10-13

Owners can explicitly request **Account by day** or **Campaign by day**, inspect
the durable receipt, cancel local work and read retained report history. Members
can read existing reports. The **Meta reports** screen separates source, import
history and row pagination and links back to connection management. It preserves
exact decimal strings and distinguishes unavailable, zero, empty, partial,
expired and deleted data. Known active imports explain why a second request is
disabled. A lost or malformed acknowledgement retains the exact original request;
a deletion-masked replay still proves that request's identity without exposing
its former source.

The following local checks passed with contained synthetic provider responses:

- Ten pure normalizer groups cover dates, exact IDs/decimals, nested actions,
  duplicate/foreign rows, strict grain shape and input immutability. The complete
  Node test run recorded377 passes and two existing skips.
- Ten PostgreSQL service/API groups cover owner/member scope, atomic queue and
  receipt rollback, identical replay, concurrent admission, account-local dates,
  staged and terminal rows, history cursors, expiry, signed deletion and the
  current session/Origin/method boundary. Retention preview checks include
  workspace isolation, irreversible markers,10000-candidate caps and a real lock
  timeout that returns unavailable rather than zero.
- Twelve PostgreSQL worker groups cover submission ambiguity, leases, late
  responses, revoked authority, invalid pages, quotas, retry limits and cleanup.
  Two use actual `startWorker`/pg-boss dispatch and graceful **in-process**
  stop/start recovery from a saved report ID and cursor without a second POST.
  They do not establish OS-process kill/restart acceptance at every checkpoint.
- Eleven controller browser groups and seven independent Kimi-view groups cover
  immutable retry identity, live-role purge, stale scope responses, immediate
  hiding of deleted source metadata, off-page selection and nested DTO validation.
  Desktop1440/mobile360 visual checks verify readable horizontal table scrolling,
 44px controls and keyboard/disclosure access.
- Production build/typecheck, all13 application navigation groups and the actual
  retention browser suite pass against an isolated local database. The new view
  works through real application routes for owner/viewer empty states without
  starting an import. The shared cleanup confirmation names Meta rows and shows
  unavailable estimates explicitly. Plan and diff checks pass.

The normalizer and pure report view were drafted by the existing verified Kimi
K3 CLI with thinking/maximum effort, public contracts and reviewed skills under
the bounded draft profile. GPT reviewed and repaired confirmed compatibility,
design and security issues, and ran independent acceptance. No customer data or
provider credentials were supplied to the draft. No live provider calls, real
Ads Manager reconciliation or provider-approval claims follow from these checks.
