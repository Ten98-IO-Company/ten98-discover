# Durable static audit worker

The [manual audit API](site-audits.md) now connects the reviewed download, robots, sitemap, HTML and graph components through PostgreSQL and the existing pg-boss worker. This implements manual public, query-free static audits. The Site Audit screen, scheduled runs, rendered/protected audits and Lighthouse remain unfinished V1 requirements.

## Execution and recovery

The queue payload contains only the saved run ID. Its actual job ID must match the receipt. Claiming uses a short installation advisory lock, then workspace → project → run locks. One run is logically active per installation and one is queued/running/cancelling per workspace. The oldest eligible queued run gets the slot. This initial deployment supports one worker process; these bounds are not a claim of distributed throughput or full process isolation.

Each invocation owns a UUID and a generation. Its 45-second lease renews every ten seconds and is renewed again at actual request dispatch. Requests reserve their attempt, counters and entire maximum body capacity before leaving the database transaction. Network I/O, child parsers and pacing waits occur outside transactions. Every dispatch and publication rechecks current initiating membership, exact origin/domain proof, generation, lease and the absolute 30-minute deadline, including queue time. Page settlement also matches the exact attempt UUID.

At most two attempts are allowed for a resource. Safe GET retries cover bounded transient transport errors, selected transient 5xx statuses and 429; they do not repeat paid provider work. A persisted minimum one-second interval and any larger robots crawl delay or valid Retry-After apply before the next request. Missing or malformed Retry-After uses the ordinary floor; an excessive valid delay stops work rather than being shortened. Waiting does not authorize dispatch: the gates run again after waiting.

Only a complete download can release unused reserved capacity. Failed, cancelled and unknown attempts retain the full charge. Observed wire, HTTP-decoded and final-decoded byte counts are reported separately. The allowance is body capacity, not a precise TCP-bandwidth quota; a transport chunk crossing its limit can produce a larger observed counter and an explicit coverage failure.

The existing worker heartbeat repairs missing/terminal queue wakeups and expired leases. Recovery fences the previous generation, settles abandoned attempts as unknown and resumes saved progress within the original budgets and deadline. There is no automatic pg-boss retry for this queue. Shutdown stops new local claims, aborts and joins owned downloads/parsers, and returns unfinished work to the queue while the database is still available.

Cancellation increments the generation before an old response can publish. The old owner remains only while its work drains; its matching owner token can acknowledge cancellation without regaining permission to write results. An expired owner cannot replace a newer run's outcome. Revoked permission or changed serving-domain proof also prevents new requests and publication.

## Discovery and results

The original origin's robots policy is fetched first. Public robots redirects may cross origins, with at most five hops; the policy always applies to the original origin. Only a genuine 404/410 permits an absent policy. Challenge, access restriction, rate limiting, invalid text, parser limits and transport failure never mean allow-all. Saved policy bytes and their digest let recovery repeat policy decisions. Positive crawl delays are enforced or the run stops when they cannot fit.

Robots-declared sitemaps and the conventional `/sitemap.xml` are considered. Sitemap and HTML discovery stays on the exact HTTPS origin; URL queries are excluded without being stripped into a different resource. Redirects consume their own requests and stop at eight hops. Unknown, excluded or capacity-omitted targets remain unknown. External links may be recorded as query-free observations but do not grant fetch authority. Redirect aliases are not eligible audit origins.

HTML uses the fixed isolated parser. Unsupported/conflicting charset declarations, invalid UTF-8, explicit challenges and narrowly suspected interstitials cannot manufacture missing titles or other missing-content findings. 429 takes precedence over challenge classification. Normal background JavaScript and Turnstile embeds are not automatically challenges.

Copied page evidence is bounded to 64 KiB of PostgreSQL JSON text. Title/description take priority; other arrays keep whole items and report truncation. Links live in the edge table rather than being duplicated in evidence. Whole HTML is never retained. Graph analysis consumes a bounded projection of IDs, facts and relationships, outside its database transaction; raw evidence is not loaded for graph computation. Results are published only after rechecking ownership, authority and the frozen finalization phase.

Run completeness is explicit. Unfetched/blocked/shell/partial pages, query exclusions, missing sitemap coverage and exhausted ceilings prevent completeness-dependent findings. Duplicate and broken-link observations can still be useful with partial coverage. Detected totals and retained finding counts remain distinct. A failed or cancelled run may have no summary; that does not mean it found zero issues.

## Retention

Audit evidence uses the workspace's raw-provider retention (default 90 days); derived pages, edges and issues use derived history (default 365 days). Cleanup marks a category expired before deleting payloads, so a partially cleaned run never presents the surviving prefix as a complete report. Each pass handles one terminal run and at most 1,000 rows per child category. Edges and issues are explicitly removed before pages to avoid an unbounded cascade. Deleted histories retain only their repeat-request receipt after cleanup.

Every pass uses freshly read cutoffs. Extending retention stops further not-yet-due deletion; already hidden evidence is not restored. Active runs are excluded. Retention previews return a bounded lower bound or an explicit unavailable estimate, never an invented zero.

## Validation and remaining gates

`TEN98_INTEGRATION_TEST=1 node --env-file=<fresh-worker-fixture> tests/site-audit-worker-integration.ts` requires a fresh loopback database named `ten98_site_worker_*`. Native DNS/HTTP are replaced only inside the test; production code has no loopback bypass or transport-injection option. Real parser children, PostgreSQL gates and pg-boss worker startup are exercised. All eleven worker groups passed, including post-wait authorization, live stale-response fencing, hard budgets, cancellation and actual queue recovery. The separate API and retention fixtures passed five and eight groups respectively. The original-install migration suite passed through 0019 with existing data preserved. The complete unit run passed 262 checks with two existing platform skips; TypeScript, native production build and plan checks passed.

The updated Linux Docker image built successfully and passed the checked-in `tests/crawl-container.mjs` stdin fixture as its unprivileged user, with no network or mounted data, a read-only filesystem, one CPU, 256 MiB memory and 64 PIDs. That verifies native worker imports, packaged migration, isolated parser behavior and cancellation. It does not certify a database-backed Docker worker deployment, live crawling or sustained load.

During development the shared local test PostgreSQL container exhausted its 512 MiB ceiling and recovered automatically. The limit was raised in place to 1 GiB before retrying; successful subsequent database checks do not certify 512 MiB deployment capacity. Production capacity, live public crawling, real provider calls, user-facing browser acceptance and all remaining V1 modes require their own evidence. No live crawl or paid request is claimed here.
