# Manual alias redirect checks

Owners and administrators can open **Domains**, expand **HTTP redirect checks** on a verified redirect alias, and choose **Check redirect**. The worker observes HTTP responses from the alias HTTPS root and compares the final hostname with the expected target. Choose **Refresh checks** to read the outcome; the page does not poll or schedule repeated requests. The disclosure shows the latest 20 receipts, their configuration snapshot, observation time, status codes and sanitized chain.

This is a point-in-time HTTP observation. A matching hostname, including one returning an error status, is not a health guarantee. It does not execute JavaScript or meta refreshes, prove continuous ownership, count visitors, import access logs, consolidate backlinks or change DNS. Those remain separate required V1 work. Redirect aliases never become collection origins. Serving-domain collection follows the separate [origin rules](serving-domains.md).

## Authority and durable execution

Only a currently verified, unrevoked `redirect_alias` can start a check. The browser submits a random request ID, not an arbitrary target URL. An ambiguous network/server failure retains that ID for an explicit retry. The server atomically inserts the receipt and queue job, accepts only one queued/running check per domain, and enforces a five-minute start cooldown. Paid APIs and provider credentials are not involved.

The receipt copies the exact hostname, expected target, verification time and domain revision. Configuration/proof changes increment that revision. Current owner/admin membership and the same live proof/configuration are checked under workspace then project locks before execution and before publication. A change while the request is in flight marks its receipt stale and discards its observation. Duplicate workers do not repeat a dispatched check. Missing/terminal queue jobs and overdue starts/runs are reconciled to explicit failure; a late completion cannot resurrect one. These are best-effort manual observations, not guaranteed remote delivery or automatic retries.

## Network boundary

The initial request is `https://<alias>/`. Later hops may use HTTPS port 443 or HTTP port 80, with normal TLS certificate/hostname verification for HTTPS. There are at most eight redirects and nine responses, a 2 KiB URL limit, 16 KiB response-header limit, five seconds per DNS/request hop and 30 seconds overall. The worker issues GET requests and destroys response bodies after headers; it sends no workspace cookies, authorization, referrer or provider credentials.

Each hop validates all returned A/AAAA addresses before selecting one. Mixed public/private answers, mapped IPv4, scoped IPv6, noncanonical numeric authorities, private/reserved/special-purpose addresses, credentials, other schemes and nondefault ports are rejected. DNS is resolved again for every hop, then the selected address is pinned through a dedicated agent with proxy inheritance disabled; the connected peer is checked. The strict public-address helper has no private-host exceptions. OIDC retains its separate, explicit operator-approved exception mechanism.

The address policy deliberately rejects some globally reachable special-purpose ranges. It is a conservative SSRF policy, not a complete classifier of global routing. Its exclusions were checked against the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/) registries. Native agent proxy suppression uses the documented Node 24 [`proxyEnv` option](https://nodejs.org/docs/latest-v24.x/api/http.html#new-agentoptions).

Queries may be used transiently to follow redirects. Stored evidence and fixed diagnostics contain only origins and paths, never query strings or fragments. Observed URLs render as plain text. Bodies, raw DNS answers, raw headers and exception messages are not persisted.

## Retention and upgrade

Migration `0018` follows `0017` and preserves existing domain proofs; it does not start network checks. Observation payloads expire strictly before the workspace's **Raw provider evidence** cutoff (90 days by default), using completion time. Cleanup processes at most 100 payloads per shared retention transaction and retains receipt IDs, original check status, configuration snapshot and idempotency. Queued/running checks are excluded. The UI labels an expired receipt as unavailable evidence, never a healthy or empty chain. Deleting a registry record does not turn its retained receipt into another domain's history; workspace/project deletion still cascades.

## Local verification

`node --test tests/domain-redirect-network.test.ts tests/oidc.test.ts` covers URL/address rules, mixed/rebinding DNS, pinning, TLS options, duplicate Location headers, loop/hop limits, sanitized evidence, timeouts and the existing OIDC override boundary. A contained child exercises real native HTTP agents with proxy environment settings: all external sockets are intercepted before connection, the loopback proxy receives nothing, and a stalled request is aborted.

With `TEN98_INTEGRATION_TEST=1` and a private local environment, run `node --env-file=<env> tests/domain-redirects-integration.ts`. Its seven groups cover live roles/tenants/proofs, atomic queue rollback, idempotency/cooldown, held-request revocation, stale crash reconciliation, retention/rollback and an actual pg-boss worker with synthetic DNS/HTTP responses. No public DNS or customer/provider request is made. `tests/migrations-integration.ts` requires its own empty local database and checks upgrade preservation, rollback and repeated migration.

The optional `tests/domain-redirect-browser.ts` uses an installed Playwright module supplied through `PLAYWRIGHT_MODULE` and a production local server. It covers actual API/UI behavior, keyboard disclosure, dropped committed POST response retry, failed refresh, expired evidence, proof revocation, project isolation, permission loss and desktop/360px layout. All browser traffic outside the local app is blocked; worker DNS/HTTP answers are synthetic.

On 2026-10-13, all seven database groups, the upgrade suite and six production Edge groups passed. TypeScript, production build, plan checks and 167 unit checks passed, with two pre-existing platform skips. No real-domain TLS/DNS, production capacity, public deployment or full P79/P80 parity is claimed.

The combined branch independently repeated TypeScript, production build, plan checks,167 passing unit checks (two existing skips), migration preservation/rollback, all seven database groups and all six Edge browser groups. All observed network evidence in these checks is synthetic.
