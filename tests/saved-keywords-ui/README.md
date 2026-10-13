# Opt-in saved-keywords browser acceptance

This runner reuses the [Research UI fixture guard, provider transport, generated actors, job executor and browser helpers](../research-ui/README.md). It is not part of the unit suite. Run it against the matching production build; a syntax check is not a browser pass.

Use Node24, installed application dependencies and an externally supplied `PLAYWRIGHT_MODULE`/installed Chromium channel. Provision a **new empty loopback database**, named `ten98_research_ui_` plus a unique lowercase suffix, and migrate it separately. The runner never provisions, drops or discovers databases. Use the dedicated test PostgreSQL port55501 for this increment; do not use a preview database. Check the chosen web port is unused. Run one database/browser acceptance suite at a time.

Follow the existing Research fixture's environment instructions, adding `TEN98_SAVED_KEYWORDS_BROWSER=1`. Supply fresh synthetic secrets through an explicit ignored environment file. `APP_URL` and `BASE_URL` must be equal loopback origins; `DATABASE_URL` cannot contain query parameters or fragments. Keep `TEN98_INTEGRATION_TEST=1`, `TEN98_RESEARCH_BROWSER=1` and `ARTIFACT_DIR=./test-results/research-ui/artifacts`. No production credentials or existing user data are appropriate.

From the repository root, after the reviewed production build is ready:

```sh
node --env-file=.env.saved-keywords-ui-test tests/research-ui/fixtures.mjs seed
node -e "require('node:fs').mkdirSync('test-results/research-ui/artifacts',{recursive:true})"
node --env-file=.env.saved-keywords-ui-test --import=./tests/research-ui/preload.mjs .output/server/index.mjs
```

Keep that contained web process running and **do not start a background worker**. In another terminal:

```sh
node --env-file=.env.saved-keywords-ui-test tests/saved-keywords-ui/browser.mjs first
```

An optional fresh suffix (1–12 lowercase letters/hyphens, beginning with a letter) creates different synthetic actors for a corrected rerun while preserving failed evidence. A reused actor label is rejected. These phases use real routes and SQL receipts; only explicit owned jobs receive synthetic provider responses. The production preload blocks every unknown fetch and refuses paid dispatch from the web process. Browser requests outside the app origin are blocked.

Coverage: save selected research rows with server provenance; manual normalized identities; bulk tags and rename/color; literal search, included/excluded phrases, market and tag filters; numeric filters that distinguish absent metrics from zero; full CSV/TSV formula guards; lost authored-save acknowledgement; refresh lost and structurally valid but mismatched acknowledgements, immutable retry after browser-clock quote expiry and duplicate-click exclusion; held-read cancellation; malformed nested list data; real A→B→A navigation; live viewer demotion/removal and sibling-tab access purge; desktop/360px bounds and actual keyboard table scrolling. The browser clock alone advances in the expiry case; the independent database suite covers actual server-expired replay. No paid provider, public crawl, fixture reset or automatic release is performed.

Generated accounts, receipts, screenshots and redacted diagnostic files remain under ignored `test-results/research-ui/`. Inspect saved screenshots before accepting visual quality; bounds do not establish contrast compliance. Stop only this owned fixture web process after the run. Keep evidence and clean up the owned database separately after confirming no live sessions.
