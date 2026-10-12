# V1 provider and deployment choices

Status: planned integration contracts; no providers have been called, accounts configured, or infrastructure deployed.
Primary documentation checked on 2026-10-12. Prices, quotas and beta status must be checked again before release.

## Confirmed scope

V1 ships multiple workspaces, teams and roles, local accounts and generic OIDC. An owner chooses provider connections
and grants workspaces access to them; membership never implies permission to reveal a credential or spend without a budget.

| Capability | V1 operator choice | Requirement |
|---|---|---|
| LLM assistance and model sampling | OpenRouter, using credits or OpenRouter BYOK | User-selected model, spend estimate and captured model/provider identity |
| SEO and answer-engine data | DataForSEO | Independent credentials/budget, endpoint-specific cost and provenance |
| Optional LLM proxy | Direct OpenRouter OR Cloudflare AI Gateway | Same app behavior; no mandatory Cloudflare account |
| JavaScript audits | Bundled browser worker OR Cloudflare Browser Run | Same audit output contract and visible capability differences |
| Email alerts | Any compatible SMTP service OR Cloudflare Email Sending REST | Shared outbox, recipient preferences, delivery diagnostics |
| Centrally managed pixels | Official browser tags for all ten connector entries in [tracking.md](tracking.md) | One installed loader; browser-to-vendor requests; no server event middleware required |
| Marketing report imports | Read-only APIs for connected analytics/ad accounts | Separate authorization, source definitions, historical limits and sync health |
| Core application | Docker with bundled/external PostgreSQL and local/optional object storage | No commercial vendor required for analytics, identity, stored reports, or bundled audits |

Paid SEO/AEO feeds and model inference remain optional external data services. Shipping their adapters does not make that data free.
Direct model responses must be labeled as model samples; they are not evidence of what a consumer search/answer product displayed.
Do not build a generic plugin marketplace or arbitrary endpoint scripting system to support these named choices.

## Credentials and connection UI

All fields below are server-side configuration or encrypted connection records, never browser/tracker build variables.
Secrets are write-only in the UI, redacted in logs/exports, and decryptable only by the relevant server job.
Separate provider tokens by function and environment; allow a connection to be revoked without deleting historical results.

| Connection | Stored fields | Validation and access |
|---|---|---|
| OpenRouter | API key; selected models; maximum output tokens; permitted provider/fallback policy | Free key/account check where supported; paid test is separately labeled |
| DataForSEO | API login and API password | Build Basic authentication server-side; do not ask users to maintain a separate Base64 secret |
| AI Gateway | Account ID, gateway ID, Run token, provider-key mode, optional BYOK alias | Owner-controlled connection; authentication required; gateway IDs are not tenant security boundaries |
| Cloudflare browser | Account ID and separate API token with Browser Rendering - Edit | Enforce local quota/concurrency budget before requesting browser time |
| SMTP | Host, port, TLS mode, username/password as required, sender, reply-to, optional trusted CA | Verify connection/auth without sending; separately authorized test email |
| Cloudflare email REST | Account ID, Email Sending Edit token, onboarded sender, reply-to | Separate sending token, no DNS-management permission required at runtime |
| OIDC | Issuer, client ID/secret, callback URL, explicit claim/group mapping | Verify discovery, issuer/audience, state/nonce/PKCE and tenant role boundaries |

Do not accept arbitrary provider base URLs from ordinary workspace members. Use fixed adapter endpoints;
administrator-only SMTP/OIDC endpoints may be private by intent, but require separate configuration and validation.
Encryption keys belong in the operator's secret store and recovery inventory; changing a provider never changes the app key implicitly.

## Browser tags and imported analytics

The [tracking capability matrix](tracking.md#provider-capability-matrix) is the source of truth for Meta, GA4, Google Ads, Cloudflare, TikTok, LinkedIn, Microsoft Ads, Pinterest, Snapchat and X. Public pixel/measurement identifiers intentionally reach the browser; OAuth secrets and report API tokens do not. The server-side credential table above remains private.

Configure browser tags and report imports independently. API/app approval for reporting may be more restrictive than pixel installation. Report imports follow provider quotas, timezones, currencies, available history and attribution definitions. Lack of API approval is an explicit setup state and cannot be counted as a verified reporting adapter.

Cloudflare Web Analytics requires its official beacon and does not support arbitrary custom events. Edge request datasets are a different measurement from beacon visits. Zaraz can coexist under explicit tag ownership but is not required for Docker deployment. Alias-domain observations can use Cloudflare or standard server logs; no Cloudflare account is required for the native domain registry.

## OpenRouter, BYOK, and optional AI Gateway

Direct OpenRouter uses its authenticated chat API with explicit model selection. Normalize successful responses, streaming failures,
token usage and provider errors in one adapter. Persist the actual model/provider and billed usage with each run.
The API remains model/provider-dependent; validate tool, structured-output and search capabilities before offering them in the UI.
Source: [OpenRouter API](https://openrouter.ai/docs/api_reference/overview).

OpenRouter BYOK is configured in the operator's OpenRouter workspace; ten98-monitor still uses an OpenRouter API key.
Its current free allowance is measured by list-price inference cost, not request count: pay-as-you-go includes $25,000/month,
with a 5% BYOK fee beyond the allowance; provider inference is billed separately by that provider.
Default BYOK failure can fall back to shared OpenRouter capacity. The setup guide must make the selected fallback/billing policy explicit;
use the strict shared-capacity setting when the operator wants provider-key-only usage.
Sources: [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok), [current pricing](https://openrouter.ai/pricing/).

Optional Cloudflare AI Gateway sits between the Docker worker and OpenRouter; it does not replace DataForSEO.
For provider-native proxy requests, the OpenRouter key uses `Authorization` and the Cloudflare token uses `cf-aig-authorization`.
For gateway-stored BYOK, omit the upstream authorization header entirely; a dummy key would override the stored key.
The optional alias uses `cf-aig-byok-alias` on direct provider passthrough.
Sources: [OpenRouter adapter](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/),
[stored keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

The provider page currently differs between its prose and cURL example about an extra `/v1` path segment.
Resolve the exact route with a pinned contract check before implementation is accepted; do not ship an assumed URL.
Use provider passthrough for this integration; Cloudflare recommends its newer REST API generally, but adopting Unified Billing is a separate billing choice.
Gateway Run credentials are account-scoped and can reach other gateways/stored keys in that account. Keep them server-side;
separate Cloudflare accounts are needed if provider-level tenant isolation is required.
Source: [authentication and token scope](https://developers.cloudflare.com/ai-gateway/configuration/authentication/).

Require provider credentials and disable implicit Unified Billing fallback. Cloudflare offers `byok_only` and the per-request
`cf-aig-no-wholesale` control; neither is a substitute for app budget enforcement.
Source: [Gateway change introducing the control](https://developers.cloudflare.com/ai-gateway/changelog/#2026-09-14).
Disable caching and model/provider substitution for measurement samples, which must remain independent observations.
Keep AI Gateway prompt/response logging off unless the operator deliberately enables it; explain the additional data recipient.
Do not automatically bypass a failed gateway: that can bypass its controls or violate the selected billing/data-handling policy.

## DataForSEO contract and spending

Accept the API login/password, use TLS and server-side Basic authentication, and validate with the free user-data endpoint.
That endpoint provides base prices and account usage, but excludes additional paid-parameter costs.
Sources: [user-data API](https://docs.dataforseo.com/v3/appendix-user-data/).

Treat HTTP success separately from API/task success: parse the top-level and every task's `status_code`, task ID and cost.
Batch responses can contain mixed outcomes. Authentication/payment failures pause affected work; a retryable failure must not
repost a charged task when a saved task ID can retrieve or reconcile it. Apply endpoint-specific concurrency and polling limits.
Source: [DataForSEO errors](https://docs.dataforseo.com/v3/appendix-errors/).

Estimates include endpoint, result depth, location/language, live/queued priority, paid parameters, engine count and sample count.
Show estimate time/source and an upper allowance; reserve against connection and workspace budgets before dispatch.
Use decimal currency or integer micro-units, settle actual response costs, and retain unknown charges until reconciled.
Provider balances cover all apps using the account; ten98-monitor cannot promise a hard cap on spending outside its control.

## Browser execution: two complete V1 choices

Bundled mode adds an isolated browser container built from the same repository, with pinned Playwright/Chromium versions.
Do not expand the ordinary web image with browsers. The browser process gets no app database password, model keys, Docker socket,
host mounts, or general-purpose job payload that can execute arbitrary code; accept only a narrow audit request from the trusted worker.
Give each run a fresh context, a wall-clock/page/request/byte limit, capped concurrency, and bounded output to the artifact store.

Playwright's published image is intended for testing/development and is not recommended as-is for untrusted sites.
Running Chromium as root disables its sandbox; the production browser image must use a dedicated user and tested sandbox/seccomp settings.
Do not solve startup failures with `--no-sandbox`, privileged mode, or SYS_ADMIN in production.
Use a sized private shared-memory mount and init process; verify this on each supported architecture.
Source: [Playwright Docker guidance](https://playwright.dev/docs/docker).

Enforce egress outside browser JavaScript interception as well as validating URLs: public HTTP(S) only; no private, loopback,
link-local, metadata, Unix/file URLs or userinfo. Check DNS results, redirects and subresources, including IPv6 and DNS rebinding.
Use an egress proxy/firewall that cannot be bypassed by browser child processes; separate its network from app/database networks.
If an importer drops sandbox/network controls, bundled mode is unsupported there until those controls are applied and verified;
select the Cloudflare backend or deploy the browser service with standard Docker controls. Fail closed rather than silently weaken it.

Cloudflare now calls Browser Rendering **Browser Run**. Docker can use REST Quick Actions for content/screenshots without a deployed Worker,
or connect a browser session over CDP when the audit needs scripted interactions. Both use the same audited output contract.
Store account ID and a separate Browser Rendering - Edit token. Always close sessions and record timeout/resource failures explicitly.
Source: [Browser Run integration methods](https://developers.cloudflare.com/browser-run/get-started/).

As of review, Free provides 10 browser minutes/day and one Quick Action per 10 seconds; Paid defaults include 30 Quick Actions/sec,
200 concurrent browser sessions and three new sessions/sec. The 60-second default session timeout is inactivity, not a job budget.
The app imposes its own lower concurrency, spend and wall-clock limits. Rate/usage exhaustion pauses the queue with a clear next action.
Source: [current limits](https://developers.cloudflare.com/browser-run/limits/).
Cloud execution sends target URLs/content to Cloudflare; local mode remains available for operators who do not choose that transfer.
Cloud mode still applies public-target restrictions and must prove subresource/redirect restrictions in integration tests.
Do not claim REST screenshot/content endpoints alone match an interactive audit without that capability check.

## Email delivery: SMTP or Cloudflare REST

Use a shared PostgreSQL outbox for security messages, threshold alerts and user-subscribed reports.
Each message stores workspace, rule/event version, recipient, transport, attempt state, and a unique deduplication key.
Apply workspace recipient permissions, verified destinations, quiet hours/digests where configured, and unsubscribe/preferences for recurring reports.

SMTP supports the operator's existing server. Require implicit TLS on 465 or STARTTLS on the configured submission port;
verify certificates and forbid silent plaintext downgrade. A successful connection check does not prove sender permission or delivery.
Use the provider's authorized sender and SPF/DKIM/DMARC setup. Send both text and HTML; link to protected reports instead of attaching large data.
Source: [SMTP/TLS transport behavior](https://nodemailer.com/smtp).

Cloudflare Email Sending remains beta and accepts REST calls from Docker; no Cloudflare Worker is required.
Sending to arbitrary recipients requires Workers Paid. The sender domain must use Cloudflare DNS and be onboarded for Email Sending.
Onboarding adds bounce-subdomain records and sender authentication; review existing DMARC policy and preserve the operator's normal mailbox MX records.
Email Routing is a distinct inbound feature and is not required for the alert transport.
Sources: [setup](https://developers.cloudflare.com/email-service/get-started/send-emails/),
[sending versus routing DNS](https://developers.cloudflare.com/email-service/configuration/domains/),
[beta announcement](https://developers.cloudflare.com/changelog/product/email-service/).

REST sends to `POST /accounts/{account_id}/email/sending/send` with a Bearer token scoped for Email Sending Edit.
Use the REST schema (`reply_to`, and `address` for a named-address object), not the Workers binding's field names.
Parse `success`, numeric errors, `message_id` when returned, and recipient outcomes: delivered, queued, permanent bounces and suppressed recipients.
Queued means accepted for later delivery, not a request to resubmit. The formal schema is newer than the abbreviated response example in the guide.
Sources: [REST guide](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/),
[formal send API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/),
[recipient fields](https://developers.cloudflare.com/email-service/examples/email-sending/recipients/).

Current general limits are 50 combined recipients and 5 MiB/message; account daily quotas vary with account history.
Before domain onboarding, only verified account destinations are permitted; verified-destination exceptions are not a production-wide entitlement.
Source: [email limits](https://developers.cloudflare.com/email-service/platform/limits/).
Prefer one logical message per recipient for independent permission and retry decisions; suppress permanent bounces and rejected recipients.
Sender setup includes a controlled test to a real operator-owned address, checking delivery and sender authentication.
Never send an actual test email during setup without the operator's explicit send action.

Retry only definitively rejected transient sends with bounded backoff/jitter and Retry-After where supplied; pause on credentials,
entitlement, sender configuration, or quota problems. Do not retry all 5xx blindly: Cloudflare also uses 500 for not-implemented.
Source: [REST error table](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/#error-handling).
No request-idempotency guarantee is documented in the cited send API. The outbox prevents duplicate claims but cannot make SMTP/REST exactly-once.
After a timeout following submission, record an unknown outcome, reconcile provider logs/message ID where possible, and expose an explicit retry decision.
A stable Message-ID helps diagnosis; it does not guarantee recipient-side deduplication. Never silently switch email transports after an ambiguous send.

## Cost display and release checks

Show estimates independently for model tokens, SEO/AEO tasks, browser time/concurrency, email, and operator infrastructure.
Example arithmetic is illustrative, not a price promise: 10 prompts × 5 engines × 3 samples/day = 150 paid samples/day;
multiply by the selected endpoint's current price, then add model analysis and any paid search extras.

| Service | Current documented cost basis | Example/display rule |
|---|---|---|
| OpenRouter | Model/provider token pricing; BYOK allowance/fee depends on plan | Input/output tokens and extras × selected rates, plus relevant BYOK fee |
| DataForSEO | Endpoint/task/results/parameters | Quote current endpoint settings; reconcile response costs |
| Browser Run Quick Actions | Paid includes 10 hours/month, then $0.09/hour | 20 hours implies $0.90 incremental browser time, plus plan/other usage |
| Browser Run sessions | Browser time plus monthly average daily peak concurrency above 10 at $2/browser | Include concurrency; do not use Quick Actions pricing alone |
| Cloudflare Email Sending | Paid includes 3,000/month, then $0.35/1,000 | 10,000 ordinary outbound emails implies $2.45 incremental email cost, plus plan |
| AI Gateway | Core features free; logs/paid features can cost extra | New gateways from 2026-09-24 follow Workers Logs pricing; inference remains payable |

Sources: [browser pricing](https://developers.cloudflare.com/browser-run/pricing/),
[email pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
[Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).
Account allowances may already be consumed by other applications; estimates must not subtract a full allowance unconditionally.

V1 release gates supplement [deployment acceptance](deployment.md):

- Direct OpenRouter, OpenRouter BYOK policy, and optional AI Gateway produce equivalent labeled results; cache/fallback cannot falsify repeated samples.
- DataForSEO partial failures, empty balance, endpoint surcharge, saved-task reconciliation and unknown charges behave predictably.
- Both browser backends pass one shared JS audit fixture and blocked-target/redirect cases; sandbox failure cannot fall back to unsafe local execution.
- SMTP and Cloudflare REST pass dry configuration checks, controlled send, per-recipient results, quota/auth errors, timeout ambiguity and restart recovery.
- Multiworkspace credentials, budget reservations, browser artifacts and email recipients stay isolated under local auth and OIDC.
- A credential-free installation still supports local identity, analytics, stored reports and bundled audits; absent providers never block onboarding.

Mocks cover normal CI; explicitly enabled integration checks use limited credentials and an operator-approved budget/recipient list.
Track provider contract versions and recheck the linked primary docs before changing an adapter or promising a quota.
