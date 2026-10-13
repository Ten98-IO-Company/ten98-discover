# Native Meta advertising report imports

**Implementation contract, reviewed 2026-10-13; not implemented or provider-validated.** This is the next native reporting connector after Google. It covers the Meta/Facebook entry in P76 and contributes to P71, P77 and P81. All 81 requirements remain required; this document does not complete those rows or the other platforms.

The accepted [tracking contract](tracking.md#automatic-consolidation-without-misleading-totals) requires accessible advertising accounts/campaigns, daily spend, impressions, clicks and available conversion/value fields. Meta Marketing API advertising reports include supported Instagram placements within those advertising accounts. Facebook Page Insights, organic Instagram insights, publishing, inboxes, audiences, campaign editing and Conversions API uploads are not this accepted reporting family. A Meta Pixel ID neither authorizes reports nor identifies an ad account. Report authorization never installs or enables a browser pixel, changes consent, or signs someone into ten98-monitor.

## Evidence and unresolved provider gates

These are separate kinds of evidence:

| Evidence inspected | What it establishes | What it does not establish |
| --- | --- | --- |
| Meta's [official Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi) | Advertising-account access, user/system-user token families, and distinction between Standard access to own accounts and Advanced access for others' accounts | Approval of any particular self-hosted app, exact token lifetime, or current eligibility of a business |
| Tagged official Python SDK [26.0.2 configuration](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/apiconfig.py) | That SDK's default is `v26.0` | An independently verified current Marketing API support window; an SDK default is not a version lifecycle guarantee |
| Tagged [AdAccount](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py), [User](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/user.py), and [AdReportRun](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adreportrun.py) contracts | Read edges, asynchronous report creation/status/results, account metadata and permission edges | Availability of every generated field for every account, permission tier or report combination |
| Tagged [AdsInsights](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adsinsights.py) | Field names and attribution/report-time parameter vocabulary | Whether legacy enum values still work, current attribution interpretation, or completeness of returned data |

Direct attempts to read the official [overview](https://developers.facebook.com/docs/marketing-api/overview/), [Insights guide](https://developers.facebook.com/docs/marketing-api/insights/), and [versioning guide](https://developers.facebook.com/docs/marketing-api/overview/versioning/) returned HTTP429 during this review. Do not fill those gaps with third-party tutorials. **`v26.0` is the candidate version, not yet an approved runtime pin.** Before implementation is accepted, record the supported version from current primary documentation, the exact Facebook Login/Business Login configuration and authorization parameters, `ads_read` eligibility, app review/business verification requirements, token renewal contract, reporting history limits, attribution behavior, rate-limit interpretation and required deletion/deauthorization callbacks. Pin the reviewed version in code; no caller-supplied version, silent fallback or unversioned report URL.

The plan is original. No Meta SDK is installed or copied. Existing [Google reports](google-reports.md) supply the in-repository flow pattern; the pinned OpenSEO source informed that Google implementation, not a nonexistent Meta adapter. Meta's SDK license and debug behavior are not imported into the MIT application.

## Reuse and operator setup

Reuse PostgreSQL, pg-boss, `credential-vault.ts`, instance operators, current session/origin/body/rate guards, actor-bound request receipts and workspace/project lock order. Reuse the Google UI sequence and validation lessons, not its provider-specific token exchange, refresh-token logic or HTTP-under-workspace-lock implementation. `providers.ts` currently models paid OpenRouter/DataForSEO credentials; historical advertising spend must not become a charge in that ledger. No broker, SDK, new runtime dependency or general connector framework is needed.

1. An instance operator opens **Workspace settings → Meta app setup**. Show the exact HTTPS `APP_URL/api/meta/callback`, app registration instructions, and privacy/deletion/deauthorization URLs required by the verified Meta app configuration. No shared ten98 developer app or hosted OAuth relay is required.
2. The operator supplies the app ID, write-only app secret, and a login configuration ID only if the verified Facebook Login for Business flow requires it. Keep app mode and approval claims visibly **operator-declared**; a checkbox cannot verify or publish a Meta app. A free selected-asset read is separate evidence of effective permission.
3. Request the reporting permission `ads_read` once confirmed for this exact login setup. Do not request `ads_management`, Page permissions or `business_management` merely to populate a richer selector. If a necessary discovery endpoint requires more access, justify that endpoint and update this contract before widening consent. Allow explicit ad-account selection and direct validation rather than pretending business-wide discovery is mandatory.
4. Saving operator configuration increments its revision. Pending flows and future reads using an older app revision require reconnection; retained reports remain readable. Explain that impact before saving. Disable is always available even if the vault cannot decrypt the prior secret.
5. Normal team deployment uses a stable HTTPS origin. Do not advertise a localhost exception until Meta's current redirect rules have been verified. The native app still runs locally without Meta connected. Docker restore keeps imports paused until the operator validates origin, app revision and credentials.

Current Google permissions provide the initial role model: current workspace owners authorize/select/disconnect/schedule/import; current members read retained reports. Instance-operator status alone grants no workspace report access. A future delegated connection permission must be deliberate, not inferred from an arbitrary role string.

## Connection and security boundary

Use one project-scoped connection for one immutable selected ad account, displayed from the workspace's Connections surface. A source can be connected before selection; choose another source for another account. Reconnecting an existing source must prove access to its original account, not silently replace it. Prevent duplicate active account sources within a project; other projects/workspaces may independently authorize that account without learning about one another.

The server starts a ten-minute, one-use OAuth flow bound to the actual local session ID, user, workspace, project, app revision and optional reconnect revision. Store only digests of 256-bit state/browser bindings; use an HttpOnly, secure-in-HTTPS, SameSite callback cookie. Reject duplicate query parameters, wrong browser/session and replay. The callback claims only the matching flow, performs bounded server-side exchange and token inspection, then rechecks the live session/owner/app/connection before committing credentials. Never grant dashboard identity from reporting consent. Return only a fixed success/failure fragment and authorized workspace/project UUIDs; clear it promptly and respect newer explicit navigation.

Use the provider's supported authorization-code flow. **Do not copy Google's PKCE or refresh-token parameters and claim Meta supports them.** Enable PKCE if the reviewed Meta flow supports it, recording the exact mechanism. Verify the returned token belongs to the configured app, has granted reporting permission, and has usable access/data-access expiry metadata before account selection. Persist the actual granted capabilities and token type, not the requested scopes as proof. Renew only through a verified Meta-specific exchange; otherwise show **Reconnect** before expiry. A zero/missing expiry is not proof that access can never be revoked. Manual system-user-token setup is a possible separately reviewed operator path, not a replacement for the accepted easy OAuth flow.

App secrets and token envelopes use separate vault contexts including installation/workspace, object ID, provider purpose and revision. Tokens, authorization codes, app-secret proofs, raw paging URLs and raw provider errors never reach public destination configuration, browser storage, logs, exports or jobs. Jobs carry local import IDs only. Secret rotation/rekey readiness includes both app and connection envelopes. Keep successful credential renewal in its own committed transaction before dependent report work so later failure cannot restore an obsolete token.

**Disconnect** immediately erases local tokens, increments connection revision, invalidates flows and stops future publication. It succeeds with missing keys and without contacting Meta. **Disconnect and revoke at Meta** is a separately explained choice because app-grant revocation can affect other sources; local removal commits first and remote result is `confirmed` or `unconfirmed`. Any required signed deauthorization/data-deletion callback must verify the current primary contract and signature, bind the app-scoped subject to local connections, be idempotent, and implement the required deletion workflow. Do not invent that removal workflow from a generic unsigned webhook.

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

Freeze an explicit attribution profile rather than silently inheriting an account's changing Ads Manager defaults. The first candidate is `action_report_time=impression` with requested windows `7d_click` and `1d_view`, without account/unified-setting override flags. Those parameter names exist in the tagged SDK; current support and exact semantics still need primary-document and controlled-account verification. If unsupported, block that definition and revise the contract rather than dropping the parameter. Retain provider-returned attribution metadata when present; missing effective metadata is `unknown`, never fabricated. Explain why numbers may differ from an Ads Manager view using another profile. Account-setting/unified profiles can be added as separately versioned definitions when their effective per-row settings can be represented correctly.

Represent source dates as `YYYY-MM-DD` in the ad account timezone, not UTC buckets. Store exact currency and timezone with every report; a change during pagination rejects that publication. Default range ends yesterday in the account timezone; an explicitly selected current day is labelled provisional. Validate against the source's local date. Application chunk size is at most31 days per import; users can request separate bounded historical ranges. Show provider history availability as **unknown until verified**, not a hardcoded lifetime or a promised earliest date.

Preserve integer counts and monetary/action decimals as bounded decimal strings, with null for omitted/restricted/unsupported metrics. No binary floating-point or USD-only money helper for advertising amounts. `actions` and `action_values` remain separate keyed arrays carrying exact `action_type`, total value and any returned window values. Conversion counts may be fractional. Reject duplicate action keys and malformed nested values. Do not add parent/child action categories or overlapping attribution windows. A selected conversion/value metric always names its exact action type and profile; an absent action is unavailable unless the verified provider contract establishes zero for that case.

No cross-platform unique-conversion, reach or person totals. Account and campaign reports are alternative grains, not additive datasets. Source identity includes provider, ad-account ID, definition/version, date, level/entity, attribution profile, timezone and currency; connection UUID is not the provider's account identity. An account linked to two projects must not double its spend in a workspace consolidated view. Cross-currency totals require a separate explicit FX contract; daily aggregates cannot be exactly moved into another timezone. Reports are not attributed to a canonical/alias hostname without provider evidence.

## Durable imports, retries and scheduled refresh

An explicit import binds actor, project, source, current app/connection revision, report definition and date range to a request UUID and canonical hash. Same ID/same request returns the durable receipt, including after expiry; changed body or actor is409. Replay never restarts a provider report. Enqueue and receipt commit together. At most one active import per connection; different snapshots are not added together as fresh events.

Use one Meta queue and a short database lease/generation per import step. Lock workspace → project → connection → import; verify current owner, enabled app, selected account and captured revisions before each outbound operation and again before accepting its result. Release all SQL locks for network, polling and backoff. A late result cannot publish after disable, disconnect, role loss, cancel, lease replacement or expiry. The worker can resume saved report ID/cursor after restart, but cannot create the same logical report repeatedly.

State sequence: `queued → submitting → waiting → reading → completed|partial`; terminal alternatives are `failed|denied|cancelled|submission_unknown`. Persist `submitting` before report-creation POST. A lost response/crash before saving the report ID is `submission_unknown`: no automatic POST retry or invented zero. An explicit new import may supersede it; acknowledge that Meta may still have an uncollected report. Cancel stops local work and fences late responses; do not claim remote report cancellation without a verified endpoint.

Poll a known ID at a bounded cadence, persisting attempt count, next allowed time and deadline. Proposed bounds:30-minute overall import deadline, at most120 status polls,50 result pages of500 rows (25,000 rows), and three transient GET retries with delayed backoff. Reaching a page/deadline bound after verified rows yields labelled partial coverage only if those rows are internally consistent; malformed/contradictory data fails the snapshot. Narrow the date range to continue; no lifetime report-count cap. Never busy-loop or hold a queue handler asleep for the entire deadline.

HTTP status and Graph's structured error must both be checked. Credential/permission failure marks the connection reconnect/access-lost and denies pending work; throttling pauses until the persisted retry time. Parse only reviewed numeric usage/error fields, bounded Retry-After and provider retry hints; unknown error codes are unavailable, not permission grants or zero rows. Coordinate app/account throttling without leaking cross-workspace account existence. Header formulas, rate tiers and special error codes must be frozen from current Meta documentation; do not hardcode an unverified calls-per-hour allowance. Reads require no advertising-spend reservation, but still consume quotas and local resources.

Scheduled imports remain part of P76/P81. After a successful manual import, an owner may enable daily refresh at a displayed IANA wall time, with next occurrence and last successful coverage visible. Default re-fetch is the preceding28 closed account-local days, bounded to the supported attribution/history contract; this is a proposed correction lookback, not a promise of final conversions after28 days. Disable by default, retain the approving actor and immutable definition, recheck current permission, deduplicate each occurrence, skip missed intervals without an unbounded catch-up burst, and pause on changed app/account/definition or lost access. Longer manual historical backfills remain available. Native PostgreSQL calendar logic and the existing non-overlapping worker pattern suffice; no new scheduler service.

Publish a validated snapshot atomically after pagination. A new complete snapshot replaces the displayed values for the same logical daily keys; partial/failed refresh does not erase a prior complete snapshot or turn omitted rows into zero. Reconcile a completed empty query as an explicit successful-empty range, with its coverage receipt, rather than synthesizing rows. Keep old immutable receipts for audit and expose snapshot IDs in drilldown. Selection between overlapping snapshots uses request creation order, not response completion order, so an older slow request cannot overwrite a newer result.

## Storage and returned interface

Use five narrow tables, mirroring existing import storage rather than generalizing it prematurely: `meta_app`, `meta_oauth_flow`, `meta_connection`, `meta_import`, `meta_import_page`. Composite foreign keys bind workspace/project/source; unique actor-bound request receipts and one-active-source constraints are enforced in SQL. Connection fields also hold opt-in schedule/revision/next-due metadata. Import fields include captured source/definition, original actor, schedule occurrence, status, lease/generation, provider report ID, submitted/read timestamps, retry/deadline/cursor, recorded counts, diagnostic code, outcome and irreversible expiry marker. Page rows have stable normalized row keys and hashes; public report pagination is50 rows.

Proposed source DTO (all timestamps ISO strings; no token or provider cursor):

```ts
type MetaSource = {
  provider: 'meta_ads'; accountId: string; accountName: string;
  currency: string; timeZone: string; graphVersion: string;
  report: 'account_daily' | 'campaign_daily'; definitionVersion: number;
  level: 'account' | 'campaign'; breakdowns: [];
  attribution: { mode: 'explicit'; windows: string[];
    actionReportTime: 'impression'; effective: 'verified' | 'unknown' };
};
type MetaReportPage = {
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  import: { id: string; status: string; dataStatus: 'available' | 'pending' | 'unavailable' | 'expired';
    source: MetaSource; from: string; to: string; requestedAt: string;
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

Proposed service seam: `get/saveMetaApp`, `startMetaConnect`, `metaCallback`, `listMetaAccounts`, `selectMetaAccount`, `listMetaCampaigns`, `enqueue/read/listMetaImports`, `cancelMetaImport`, `disconnectMeta`, `runMetaImportStep`, and `expireMetaImportPages`. App settings use `/api/meta/app`; authenticated project routes use `/api/projects/:projectId/meta/...`; import create/cancel are POST with request ID, source revision and strict Origin/body limits. Browser account/asset selection sends an ID plus connection revision; the server verifies it rather than trusting cached options. Discovery/list responses include live role, current revision, completeness and opaque continuation. Public callback routes are explicitly separate from authenticated mutations.

Only extract a shared OAuth cookie/cursor helper from Google if both actual implementations need exactly the same contract. Keep transport/auth/report parsing/jobs independently testable with injected synthetic fetch. GPT owns auth, tenancy, transport, state machine and measurement; appropriate Kimi leaves are a pure controlled account picker and a decimal/action report normalizer supplied with a frozen public schema and adversarial fixtures.

## Retention, usability and release checks

Normalized aggregate rows use workspace derived-history retention (365-day default). Raw provider JSON is not persisted; any deliberately added raw evidence later uses the90-day provider-evidence policy. Preserve connection/account configuration and minimal idempotency/source/outcome/count receipts. Mark a terminal import expired before bounded page deletion; API responses mask residual pages immediately. Once marked, finish physical cleanup despite policy extension. Retrying an expired request returns the expired receipt; an old worker/restart cannot restore payloads. A separately requested fresh report is new evidence, not resurrection of that receipt. Provider-mandated deletion/revocation obligations remain a distinct verified release requirement, including operator backups.

The user flow is **Connections → Meta ads → Connect → Choose account → Confirm source scope → Import report → Review data → Optionally schedule**. Explain missing operator configuration without exposing secret fields. Account cards show name and stable ID, currency/timezone and access result; an empty list offers reconnect/check assigned assets, not “no ad accounts exist.” Report view shows source and last success before the table, distinct failed refresh/last retained snapshot, partial/expired/empty labels, attribution profile and next retry. Cancel/back preserves already authorized durable work; ambiguous acknowledgement offers only same-request retry. A 360px table scrolls horizontally with readable columns, keyboard focus and reachable actions.

Required acceptance before claiming this adapter works:

- Synthetic OAuth/session/browser/replay/cross-tenant tests, missing permission, unexpected app/subject, app revision change, secret-free errors/config/exports, local disconnect with broken vault, and signed callback forgery/replay.
- Actual PostgreSQL receipt+queue rollback; held provider response then demotion/disconnect/account change; duplicate workers; async POST lost acknowledgement; process restart at every checkpoint; cancel/fencing; bounded pagination/throttle/deadline and denied arbitrary URLs/fields/mutations.
- Golden rows for fractional action counts, large exact decimals, null versus zero, duplicate actions/rows/cursors, incompatible metadata, late corrections, overlapping account/campaign snapshots, currency/timezone/DST boundaries, partial versus empty and expiry mid-page. No native event insertion or pixel invocation from reports.
- Production browser setup/import/schedule/reconnect/error/retry flows, live-role purge, no stale cross-project response, keyboard/360px rendering; Docker restart, paused restore, key rewrap and retention cleanup.
- A separately authorized controlled real Meta app/account read, including consent denial, selected asset, report pagination, revocation/expiry and comparison with the same Ads Manager dates/grain/profile. Confirm current API version, app approval and provider-specific semantics. Fixture success cannot substitute for this gate; no such account or provider call was used in this planning work.
