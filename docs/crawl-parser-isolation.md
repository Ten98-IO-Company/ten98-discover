# Disposable crawl parser process

`analyzeCrawlPageIsolated(input, signal?)` is the required entry for live static-HTML parsing. It supervises one disposable Node 24 child per call and returns either `{status:'ok', analysis}` or a status-only failure: `invalid_input`, `timeout`, `aborted`, or `child_error`. Robots evaluation and sitemap parsing use the same fixed child and supervisor through the two entries described below. The [durable static audit worker](site-audit-worker.md) now connects these entries to bounded downloads, cancellation and saved results; its UI and remaining V1 modes are unfinished. Pure rule behavior and evidence retention remain documented in [static page analysis](crawl-analysis.md).

## Lifetime and protocol

The parent validates supported fields and byte limits before creating a child. It builds a fresh plain request instead of stringifying arbitrary caller objects or `toJSON` methods. HTML is limited to 1 MiB and the allowlisted headers to 16 KiB; the JSON transport allows 7 MiB for escaping. The child independently enforces that stdin limit and fatal UTF-8/JSON decoding.

The only executable is the parent's absolute `process.execPath`; the only entry is the fixed reviewed `src/server/crawl-analysis-child.ts`. Spawning uses no shell, hides Windows helper windows and passes `--max-old-space-size=64`. It does not inherit the parent's exec arguments or `NODE_OPTIONS`. The environment whitelist contains `NODE_ENV=production`, `TZ=UTC`, and Windows `SystemRoot` when needed. Application credentials, database URLs, keyrings, home directories, proxy variables, PATH, NODE_PATH and preload hooks are not forwarded.

A 2,000 ms supervisor deadline includes input preparation, startup, pipe activity and process close. The parent terminates only its own child handle on timeout, cancellation, protocol overflow or pipe errors. It never discovers or kills other processes or process groups. It returns after the child closes, removes the abort listener and timer, and destroys its pipes. A pre-aborted signal creates no child. Cancellation of future worker jobs must pass an AbortSignal through to this API.

Stdout is bounded to 12 MiB, enough for expanded bounded URL/text evidence; stderr is drained without retaining, logging or returning its contents, with an 8 KiB limit. Exceeding either output limit fails the operation. Success requires a zero exit code, no termination signal, a complete UTF-8 JSON response and the expected analysis envelope/field shapes. Incomplete output, extra trailing output, malformed JSON, a nonzero exit and unsupported response shapes never become an analysis result. Small runtime warnings on stderr do not replace valid stdout. No failure exposes raw input or child diagnostics.

## Runtime path contract

Call from the **application-root working directory**, the same convention already used by the worker CLI and migration discovery. Never change cwd or select an entry path from project/provider/request data. The supervisor does not search for fallback files and has no caller-supplied executable, script, argument or environment options. A wrong cwd fails closed with `child_error`.

The existing Dockerfile sets `WORKDIR /app`, runs Node 24, and copies `src/server`, package.json and production node_modules into the runtime image. Therefore `/app/src/server/crawl-analysis-child.ts` and its analyzer/parse5/saxes imports exist for the native worker without bundling another executable. No Dockerfile edit is needed. The combined increment built the Linux amd64 runtime image and passed the synthetic HTML, robots, sitemap, hostile-input and cancellation checks as its unprivileged user, with networking disabled, read-only filesystem, one CPU, 256 MiB container memory and 64 PIDs. This checks packaged parser execution; the future durable worker still needs its own integration checks.

## Limits and remaining integration work

The 64 MiB setting limits V8 old-space, **not total RSS**, Buffer/native allocations or all CPU. The wall-clock deadline is enforced by the separate parent process because pathological parse5 inputs can block the child's event loop. This is process lifetime/resource containment, **not an OS security sandbox**: the child retains the operating-system user's filesystem/network permissions even though the reviewed child performs no network calls or application-config reads. It does not execute fetched JavaScript. Container memory/PID limits and least-privilege deployment remain necessary controls.

The caller must bound the number of concurrent parser children; this module deliberately does not add a global pool or generic execution framework. Future crawl cancellation/shutdown must abort active parser calls. No site fetching, browser rendering, provider traffic or crawler-wide request/byte budgets are implemented here.

An earlier contained probe showed a 950,000-byte deep nesting document exceeding two seconds before parse5 returned. The real timeout fixture now verifies that it is terminated and produces only `{status:'timeout'}`. Timeouts are coverage failures for the future caller, never proof of a page's missing SEO content. Do not retry indefinitely or manufacture an empty analysis.

## Robots batches

`evaluateCrawlRobotsIsolated({robotsUrl, body, productToken, targetUrls, maxCrawlDelaySeconds?}, signal?)` accepts the original robots URL, at most 512 KiB of UTF-8 bytes as a `Uint8Array`, an explicit product token, and one to 100 target URLs of at most 2 KiB each. The parent encodes bytes as base64 without a lossy text conversion. The child independently checks the operation, base64 and size bounds, then calls the existing [robots policy parser and matcher](crawl-robots.md). It supports only these reviewed operations and cannot select another executable or source file from input.

Successful protocol completion returns `{status:'ok', evaluation}`. The evaluation contains a SHA-256 digest of the original bytes, `policyStatus`, a fixed policy failure `reason` or null, the policy origin, observed sitemap URLs, crawl delay and decisions in input order. It does not return the raw rules. A protocol success can still contain an unavailable policy or unavailable decisions; it is never implicit permission to fetch. Invalid UTF-8, unsupported delays, origin mismatches and matching-work exhaustion retain their exact reasons. The default delay capacity is zero; a future caller choosing a positive capacity must actually honor that delay.

Every decision retains the pure matcher's cumulative 2,000,000-step bound. The whole batch shares the same two-second parent deadline and 64 MiB old-space limit as HTML parsing; a costly batch may therefore time out before all decisions finish. Timeout, abort, malformed output or wrong decision counts return no decisions. The parent accepts a complete response only after clean child closure. It remains responsive during adversarial matching. No partial prefix is published, no retry occurs and no permission decision is cached by this helper.

Sitemap URLs are untrusted discovery observations, potentially including query values. They neither authorize fetching nor belong in diagnostics. Future persistence must apply raw-evidence retention and trusted domain scope. The digest identifies supplied bytes; it does not prove freshness, authenticity or continuous ownership. The supervisor's resource and OS-permission limitations above also apply to robots.

## Sitemap XML

`parseCrawlSitemapIsolated({documentUrl, body}, signal?)` accepts at most 5 MiB of complete expanded bytes. This operational capacity matches the initial download transport and is smaller than the pure [sitemap format parser's](crawl-sitemap.md) 50 MiB format limit. The parent rejects excess before spawning; the child independently validates canonical base64 and decoded size. The encoded maximum body fits the existing 7 MiB stdin cap. The same two-second deadline and 64 MiB old-space limit apply. Valid but expensive documents may be unavailable at those limits; do not report their unobserved pages as absent.

The result is `{status:'ok', analysis}` with the pure parser's complete, partial or unavailable result, or a status-only protocol failure. The parent validates stable reasons, bounded URLs, input byte receipt, exact count relationships and completeness flags after clean child closure. An unavailable document returns no entries or prefix counts. Queries and foreign/private-looking hosts remain transient discovery evidence; neither parser success nor a listed URL grants permission to fetch. No raw XML or parser diagnostic is returned, persisted or logged. The caller must supply complete transport bodies only, apply current scope and robots decisions to every discovered URL, and interpret transport-capacity failures as unavailable coverage.

## Verification

Run on Node 24 from the application root:

```sh
node --test tests/crawl-robots.test.ts tests/crawl-analysis.test.ts tests/crawl-sitemap.test.ts tests/crawl-analysis-isolated.test.ts tests/crawl-robots-isolated.test.ts tests/crawl-sitemap-isolated.test.ts
```

The eight isolation groups cover ordinary output equivalence, pre-spawn input rejection, real hostile-depth termination, real pre/in-flight cancellation with closed pipes, fixed arguments and environment, simulated malformed/overflow/nonzero/spawn/pipe failure paths, a copied production source layout and wrong cwd, plus the child's own malformed/oversized stdin boundary. Test doubles replace the Node spawn method only inside tests; there is no runtime arbitrary-execution injection option. All fixture data is synthetic. No network, database, live site, paid call or build is needed.

Seven robots-isolation groups cover batched outcomes and digest, fatal UTF-8/origin/delay semantics, exact 512 KiB and 100-target boundaries, pre-spawn rejection, hostile matching with a responsive parent, real cancellation, malformed/mismatched child envelopes and independent child operation/base64 rejection. All eight existing HTML-isolation groups still pass through the shared supervisor.

Seven sitemap-isolation groups cover complete/partial equivalence, failed-document prefix disposal, the exact 5 MiB body boundary, invalid inputs without spawning, unfinished hostile tokens with a responsive parent, cancellation, inconsistent output/count/URL rejection and independent child base64/capacity rejection. The maximum-body fixture completed in 583 ms in one local Windows Node 24.19.0 run; this is fixture evidence, not an arbitrary-document throughput guarantee. All 22 HTML/robots/sitemap isolation groups passed together, including the copied Docker-style source layout.

`pnpm test` bounds concurrent test files to two. The unbounded full run caused the exact 5 MiB acceptance fixture to exceed the unchanged two-second deadline under CPU contention; the focused run and the bounded full run passed. The exact input, success assertion and runtime resource limits remain unchanged. This is test workload control, not production concurrency admission. The combined suite passed 237 checks with two existing platform skips.

The packaged-runtime check is repeatable without credentials, databases or a live site:

```sh
docker build -t ten98-crawl-test .
docker run --rm --network none --read-only --memory 256m --pids-limit 64 --cpus 1 -i ten98-crawl-test node --input-type=module < tests/crawl-container.mjs
```
