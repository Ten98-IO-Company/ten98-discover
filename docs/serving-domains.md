# Serving domains and collection origins

A project has one immutable canonical origin and can collect from additional verified serving hosts. This is separate from a redirect alias: a domain which redirects away cannot run the page tracker before a browser receives a page, and registering or proving that alias does not supply redirect counts.

1. As an owner or administrator, select the project and open **Domains**.
2. Add the exact public hostname with **Serving domain** as its role. Subdomains need their own records and proofs.
3. Create the DNS proof, publish the displayed TXT record at the exact challenge name, and choose **Verify**. Verification uses the current one-use proof and rechecks your permission after the DNS answer.
4. Install the project's existing snippet on that host using HTTPS on port 443. No separate site key is needed. HTTP, other ports and unlisted subdomains remain rejected. A browser serializes an explicit default `:443` to the same HTTPS origin.
5. Grant analytics consent and inspect **Recent events**, or select **Origin** in **Explore** to compare or exactly filter the retained observations. Downloaded Explore CSV uses the same filter and snapshot as the screen.

The canonical origin keeps its existing exact scheme and port, including a development HTTP origin. Its registry proof does not change that original authorization. A verified redirect alias remains excluded. A serving proof for one project does not authorize that hostname for another project.

## Revocation and consent

Revoking, removing, reissuing the proof for, or changing the role of an eligible serving domain stops its collection until it is eligible again. These changes serialize with native ingestion, API-key ingestion and public configuration under the project's database lock. A request already completed before revocation remains a valid historical observation; requests waiting behind the committed revocation recheck eligibility and fail.

Every effective serving-eligibility change also changes the project's consent epoch. The loader refreshes configuration and asks for fresh consent on the next configured interaction; it cannot reuse the old consent epoch to submit new native events. The canonical origin remains eligible but also needs renewed consent. No-op changes and redirect-target edits do not reset consent. Reissuing a proof deliberately suspends a previously verified serving domain while the new proof is pending.

Native collection rejects a revoked host immediately after the transaction commits. Existing browser configurations refresh periodically and expire after at most 60 seconds; a third-party SDK already loaded in a browser cannot be remotely unloaded synchronously by changing a server record. Existing loader withdrawal/expiry controls still apply. Previously sent vendor data is not retracted.

## Provenance and boundaries

The server stores the authorized event URL origin in `event.dimensions.origin`, after checking the page Origin header for native browser requests or the current API-key authority for backend observations. Client dimensions cannot set it. An ordinary property named `origin` remains ordinary event metadata and cannot change provenance. URLs stored by the native tracker omit query strings and fragments. Duplicate event IDs cannot change a stored origin, relabel an observation or return a fresh identity context.

Legacy event rows without this field use the project's immutable canonical origin, because previous native and API ingestion allowed that origin only. Origin is a reporting dimension, not an additional visitor identity key or automatic cross-domain person match. Removing a serving domain does not change the meaning of its retained history.

DNS verification proves a matching response at verification time. It does not edit DNS or continuously prove ownership. Operators must revoke records when control changes. Observed redirect chains, alias access-log imports, backlink consolidation and imported provider attribution remain separate required work; this increment does not fabricate them.

## Verification

Run unit checks with `node --test tests/collection-origins.test.ts`. The synthetic PostgreSQL check, `TEN98_INTEGRATION_TEST=1 node --env-file=<private-local-env> tests/domain-collection-integration.ts`, is also included in the full integration suite. It covers exact origin/project boundaries, canonical development ports, forged dimensions, API/native provenance, duplicates, legacy Explorer/CSV, permissions, consent epochs and a real held-lock revocation race. DNS responses are injected; no public ownership or vendor calls are made.

The optional `tests/domain-collection-browser.ts` runner uses an installed Playwright supplied through `PLAYWRIGHT_MODULE`, a production server and a claimed isolated local database. Synthetic HTTPS documents and collector transport are intercepted and forwarded only to that local server. It exercises the actual tracker, loader, consent controls, Origin grouping/filter/CSV, recent-event columns, mobile layout and UI revocation. This does not establish public DNS, public TLS, real provider delivery or production capacity.

No dependency or migration is needed. The change reuses the existing domain registry, project lock, consent epoch and event JSON column.

Local validation on 2026-10-13 passed TypeScript, the production build, plan checks, 141 unit/VM checks (two platform-specific skips), the complete fresh PostgreSQL production web/worker integration and production Edge acceptance. The original DNS proof/role-race suite also passed separately. An independent reviewer reran the new pure and database boundary checks in another fresh database with real fetch disabled. The 360px Origin-filtered screen was visually inspected. These fixtures do not establish real domain ownership.
