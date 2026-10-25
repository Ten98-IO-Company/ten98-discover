# Upstream provenance and reuse gate

## Browser performance measurements

`public/performance.js` wraps the unmodified browser IIFE from [GoogleChrome/web-vitals 6.2.3](https://github.com/GoogleChrome/web-vitals) in a private scope and connects its five metric callbacks to the native tracker's collection policy. The upstream 8,991-byte asset has SHA-256 `1e5e9b9af6b8d71cfef508e5a869c53b4cf2bbccad8c9b5ac664c34e93f6151a`; it came from the versioned npm registry archive, whose integrity was verified before copying. The wrapper is a ten98-monitor modification. This optional asset is served locally and starts observers only after the project opts into performance collection and the tracker permits collection. It uses no external CDN or additional Node dependency. The upstream code is Apache-2.0, with its full license distributed at `public/vendor/web-vitals-LICENSE.txt`; the application's MIT license does not relicense that code.

The application includes the attributed Elmo and OpenSEO adaptations recorded below. Statements describing an empty application import ledger refer to the earlier planning/foundation stage.

## OpenSEO domain scope filters

`src/server/domain-research-input.ts` and `src/server/backlink-research-input.ts` adapt the hostname/path LIKE-filter pattern from OpenSEO0.1.12, commit `89e5a00717cdf049b7c2b4e29646edb3a7d4995b`, [researchScopeFilters.ts](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/server/lib/dataforseo/researchScopeFilters.ts). The bounded fixed profiles add query-string variants, independent returned-URL checks and native quote/job accounting; backlink folders retain their explicit scheme and hostname. No upstream cache, billing system, branding or dataset is copied. The source retains MIT copyright2026 Ben Senescu.

```text
MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Transactional SMTP transport

SMTP delivery uses exactly [Nodemailer 10.1.4](https://github.com/nodemailer/nodemailer/tree/v10.1.4), MIT No Attribution (MIT-0), with no runtime dependencies. Its published package integrity is pinned in pnpm-lock.yaml. Node provides sockets and TLS, but does not provide a high-level authenticated SMTP/MIME sender. Cloudflare REST uses native fetch separately; no Cloudflare SDK is added. Configuration alone does not verify sending entitlement or mailbox delivery.

### Nodemailer 10.1.4 — MIT-0

```text
Copyright (c) 2011-2023 Andris Reinman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Local geography reader and separately supplied data

The optional local geography reader uses exactly [mmdb-lib 3.0.3](https://registry.npmjs.org/mmdb-lib/3.0.3), MIT, without runtime dependencies. Its exact published integrity is in pnpm-lock.yaml. No database is bundled in this repository or application image. Operator-supplied [DB-IP City Lite](https://db-ip.com/db/download/ip-to-city-lite) data is separately licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the application's MIT license does not relicense that data. Results carry the linked “IP location data by DB-IP” attribution. Lite data has reduced accuracy and monthly builds; approximate location is not a verified visitor address.

### mmdb-lib 3.0.3 — MIT

```text
The MIT License (MIT)

Copyright (c) 2026 Dmitry Shirokov

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Aggregate country-map geometry

`src/lib/country-paths.json` derives coarse aggregate country outlines from Natural Earth 1:110m Admin 0 Countries v5.1.1, immutable source commit [9380cca83db5f9aef52d5e762765100745f84b27](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_110m_admin_0_countries.geojson). Natural Earth declares its map data [public domain](https://www.naturalearthdata.com/about/terms-of-use/), not CC0. Original GeoJSON SHA-256: `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f`. Derived path asset SHA-256: `4f92b744cbc12cc34d6d3d52f40d2415b2cebcfde2342524c136ab8e00f3281e`.

The native SVG uses a fitted nonpolar Mercator projection, retaining Polygon/MultiPolygon components and the source's polygon hole. Valid ISO_A2_EH supplies the fallback when ISO_A2 is not a two-letter code. Antarctica is omitted, as in the pinned Umami map; unmapped outlines remain neutral. Small or unmapped countries remain in the full country table and explicit unplotted totals. These are aggregate boundaries, with no visitor coordinates, external map tiles or map runtime dependency. Boundary presentation does not assert sovereignty.

## Search-query analysis adaptation

The bounded helper in `src/server/ai-search-evidence.ts`, specified by the [AI search evidence](https://github.com/Ten98-IO-Company/ten98-discover/wiki/AI-Search#chatgpt-answers) wiki page, adapts the ASCII tokenizer, 99-word stopword set and word-frequency/change behavior in [`apps/web/src/lib/fanout-analysis.ts`](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib/fanout-analysis.ts), Elmo commit `3c673d0253d01ae030fa41519f62ad7e54f2281b`, for `src/server/ai-search-evidence.ts`. The complete MIT notice below applies (Copyright 2026 Blue Whale Software, LLC). Native query derivation uses immutable prompt text, typed unavailable evidence and explicit eligible-answer denominators. The pure helper is implemented and independently tested; paid capture, persistence, reporting and live-provider acceptance remain separate work.

## Citation classification adaptation

The following files reuse Elmo commit `3c673d0253d01ae030fa41519f62ad7e54f2281b`, covered by the complete MIT notice below (Copyright 2026 Blue Whale Software, LLC):

| Upstream file under `apps/web/src/lib/` | Destination |
|---|---|
| `domain-categories.ts` | `src/server/citation-taxonomy.ts` |
| `domain-categories.server.ts` | `src/server/citation-domain-categories.ts` |
| `editorial-domains.ts` | `src/server/citation-editorial-domains.ts` |

Source: [pinned Elmo library](https://github.com/elmohq/elmo/tree/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/lib). Imports are renamed and provenance headers added. Google host detection replaces the upstream permissive regular expression with exact/subdomain matching against a factual snapshot of Google's [supported domains](https://www.google.com/supported_domains), retrieved 2026-10-13; its date and SHA-256 identifier are exposed with report provenance. Path/query classification and the optional Elmo URL-grouping behavior remain attributed upstream heuristics. Original `citation-classification.ts` separates publisher, page type, source surface and current tracked identity; it validates retained inputs and adds explicit host overrides without mutating retained evidence. The lists and classification code remain server-only.

Upstream curated-list provenance comments, including Wikipedia seed references, are retained. The pinned repository's root MIT notice covers these files; no separate list license or external dataset/generator attribution was found during source review. This records the available upstream provenance, not an independent reconstruction of every list entry. No upstream logos, fonts, application UI, dependency manifests or private provider responses are imported with this adaptation.

## Project-context classifier adaptation

`src/server/context-input.ts` functions `classificationTerms` and `classifyPrompt` adapt the behavior and structure of [`packages/lib/src/tag-utils.ts`](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/packages/lib/src/tag-utils.ts) from Elmo commit `3c673d0253d01ae030fa41519f62ad7e54f2281b`. The implementation combines substring classification and explicit user-tag overrides, adds a classifier version, and uses stored project profile aliases. Tests are newly authored synthetic fixtures. Other context and prompt storage/API code is original; no upstream dependency manifest or assets were copied.

Elmo notice, retained with this adaptation:

> MIT License
>
> Copyright (c) 2026 Blue Whale Software, LLC
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The planning commit contains original documentation and a small documentation checker. It does not contain copied upstream application code, logos, fonts, datasets or vendor credentials. References and behavioral research do not grant permission to redistribute every upstream dependency or asset.

| Reference | Pinned commit | Root notice inspected |
|---|---|---|
| Elmo 0.4.4 | `3c673d0253d01ae030fa41519f62ad7e54f2281b` | [MIT; Copyright 2026 Blue Whale Software, LLC](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/LICENSE.md) |
| Umami 3.4.0 | `ec0ff50388c264ed8ce46f00967e92f7e71476ae` | [MIT; Copyright 2022 Umami Software, Inc.](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/LICENSE) |
| OpenSEO 0.1.12 | `89e5a00717cdf049b7c2b4e29646edb3a7d4995b` | [MIT; Copyright 2026 Ben Senescu](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/LICENSE) |

Before each source import, record original repository/commit/path, destination path, changes, author notice and license text. Include required notices in both source and distributed images. Review transitive dependencies, browser bundles, fonts, icons, geolocation data, recorder assets and generated clients. Preserve compatible third-party licenses; the project's MIT license does not relabel dependencies.

Do not adopt all three manifests or all hosted-service SDKs. One example requiring resolution is Umami's declared `ua-parser-js` 2.x dependency; verify its actual resolved license and select a compatible implementation or license strategy before reuse. Generic OIDC must not depend on an unreviewed paid/enterprise auth add-on. This plan makes no claim that the entire reference dependency graph is MIT.

Use original ten98 Discover branding. Upstream names identify references, not endorsement. Provider responses and datasets have separate usage/retention/redistribution terms; do not publish private captured answers or customer analytics as test fixtures. Prefer original synthetic fixtures, or explicitly licensed and sanitized evidence.

The [REA skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) informed source-versus-runtime evidence handling. Its code/tools were not bundled. Other local skills used as working instructions are recorded in the brief; their files are not redistributed here.

## Upstream import ledger

Owner decision 2026-10-21: Discover ports the pinned upstream implementations, adapting only the stack glue (ORM to Drizzle/PostgreSQL, Next.js routes to TanStack Start). Upstream markup, CSS, logos and fonts are not copied; UI renders with `@ten98/ui`. Each ported file carries a provenance header.

| Date | Upstream | Commit | Upstream path | Discover path | Kind | Changes | Tests |
|---|---|---|---|---|---|---|---|
| 2026-10-21 | Elmo 0.4.4 (MIT, Blue Whale Software, LLC) | `3c673d0253d01ae030fa41519f62ad7e54f2281b` | `apps/web/src/lib/visibility-stats.ts` | `src/server/visibility-stats.ts` | verbatim + header | none to the algorithms; adapter `carriedInsights` in `src/server/prompt-insights.ts` | upstream `__tests__/visibility-stats.test.ts` ported to `tests/visibility-stats.test.ts` |
| 2026-10-21 | Umami 3.4.0 (MIT, Umami Software, Inc.) | `ec0ff50388c264ed8ce46f00967e92f7e71476ae` | `src/queries/sql/funnels/getFunnel.ts` (relational branch) | `src/server/funnels.ts` (`calculate`) | behaviour + SQL semantics | rewritten against Discover's `event` table and scope CTE; Umami's pairwise level join replaced by a linear window-function carry with identical counts (performance); Discover match modes, typed predicates and every-step shared filters kept | upstream test asserts Prisma SQL strings and was not portable; `tests/funnels-integration.ts` expectations re-derived |
| 2026-10-21 | Umami 3.4.0 (MIT, Umami Software, Inc.) | `ec0ff50388c264ed8ce46f00967e92f7e71476ae` | tracker `data-tag` / track `tag` option; `website_event.tag` grouping | `public/tracker.js`, `src/server/analytics-dimensions.ts` | behaviour + shape | stored in event `dimensions.tag` (no column); owner setting enforced server-side; identifier-rejecting validator and 100-tag project cap added per decision ten98-code-system#24 | `tests/analytics-tag.test.ts`, `tests/tracker.test.ts`; integration block in `tests/native-analytics-integration.ts` |
| 2026-10-21 | Elmo 0.4.4 (MIT, Blue Whale Software, LLC) | `3c673d0253d01ae030fa41519f62ad7e54f2281b` | `apps/web/src/lib/chart-utils.ts` (`carryForward`, `applyPerPromptKeyedLVCF`) | `src/server/citation-carried.ts` | verbatim + header | default cadence fixed at 24h instead of `getDefaultDelayHours()`; adapter `carriedCitations` maps Discover citation axes | upstream has no tests; `tests/citation-carried.test.ts` added |

## Foundation dependency inventory

Optional deployment component: the official `caddy:2.11.7-alpine` image, pinned to manifest `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`, provides reverse proxy and automatic HTTPS. Caddy is Apache-2.0; its separate image includes its own dependencies and notices and is not relicensed MIT. No Caddy source is copied into the app. Verified on 2026-10-13 against the [official image inventory](https://github.com/docker-library/repo-info/blob/master/repos/caddy/remote/2.11.7-alpine.md) and [upstream license](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE). The optional image is pulled directly from the official registry, not republished here.

Audit date: 2026-10-12. Scope: `0.0.0-foundation`, `pnpm@11.19.0`, Node 24, lockfile SHA-256 `6c6777f9d139f3f592bd4a2e1430ebf406b7e9642bc14be8b8ff755f2777b30e`.

The foundation is original application code using library dependencies and the documented architectural patterns above. It does not copy Elmo, Umami or OpenSEO branding or datasets; application code ported since 2026-10-21 is listed in the upstream import ledger above. The upstream application import ledger remains empty. Library dependencies below are separate from that ledger and retain their own licenses; MIT is the license of ten98-monitor's original code.

### Exact direct dependencies

| Package | Version | Declared license | Manifest section |
|---|---|---|---|
| `@tanstack/react-router` | 1.170.42 | MIT | dependencies |
| `@tanstack/react-start` | 1.168.61 | MIT | dependencies |
| `better-auth` | 1.7.7 | MIT | dependencies |
| `drizzle-orm` | 0.45.2 | Apache-2.0 | dependencies |
| `pg` | 8.23.0 | MIT | dependencies |
| `pg-boss` | 12.37.1 | MIT | dependencies |
| `react` | 19.2.8 | MIT | dependencies |
| `react-dom` | 19.2.8 | MIT | dependencies |
| `zod` | 4.6.6 | MIT | dependencies |
| `@types/node` | 24.10.1 | MIT | devDependencies |
| `@types/pg` | 8.15.6 | MIT | devDependencies |
| `@types/react` | 19.2.2 | MIT | devDependencies |
| `@types/react-dom` | 19.2.2 | MIT | devDependencies |
| `@vitejs/plugin-react` | 6.1.1 | MIT | devDependencies |
| `nitro` | 3.0.260903-beta | MIT | devDependencies |
| `typescript` | 7.0.2 | Apache-2.0 | devDependencies |
| `vite` | 8.3.4 | MIT | devDependencies |

The selected `nitro@3.0.260903-beta` is an official **beta**, not a stable release or Elmo's historical nightly alias. The [documented Start Node deployment](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nodejs--docker) uses Nitro. A production build and Node/Docker smoke test are required; an advisory scan does not establish compatibility. Build dependencies can contribute code to server/client output even when excluded by `pnpm prune --prod`.

### Production dependency graph inventory

Generated from `pnpm licenses list --prod --json` after aligning Router with Start. This records the installed Windows x64 graph selected by the lockfile, not stale package-store folders and not a final bundle-level software bill of materials. Counts below are package names; one name may resolve to multiple versions. Linux/ARM optional binaries and the final image/bundles need target-build inspection. Exact resolutions and integrity hashes are in `pnpm-lock.yaml`.

**MIT** (132 package names):

`@babel/code-frame@7.29.7`, `@babel/compat-data@7.29.7`, `@babel/core@7.29.7`, `@babel/generator@7.29.8`, `@babel/helper-compilation-targets@7.29.7`, `@babel/helper-globals@7.29.7`, `@babel/helper-module-imports@7.29.7`, `@babel/helper-module-transforms@7.29.7`, `@babel/helper-string-parser@7.29.7`, `@babel/helper-validator-identifier@7.29.7`, `@babel/helper-validator-option@7.29.7`, `@babel/helpers@7.29.10`, `@babel/parser@7.29.9`, `@babel/template@7.29.7`, `@babel/traverse@7.29.10`, `@babel/types@7.29.8`, `@better-auth/core@1.7.7`, `@better-auth/drizzle-adapter@1.7.7`, `@better-auth/kysely-adapter@1.7.7`, `@better-auth/memory-adapter@1.7.7`, `@better-auth/mongo-adapter@1.7.7`, `@better-auth/prisma-adapter@1.7.7`, `@better-auth/telemetry@1.7.7`, `@better-auth/utils@0.4.2,0.5.0`, `@better-fetch/fetch@1.3.2`, `@jridgewell/gen-mapping@0.3.13`, `@jridgewell/remapping@2.3.5`, `@jridgewell/resolve-uri@3.1.2`, `@jridgewell/sourcemap-codec@1.6.0`, `@jridgewell/trace-mapping@0.3.31`, `@noble/ciphers@2.4.0`, `@noble/hashes@2.4.0`, `@oozcitak/dom@2.0.2`, `@oozcitak/infra@2.0.2`, `@oozcitak/url@3.0.0`, `@oozcitak/util@10.0.0`, `@oxc-project/types@0.153.0`, `@rolldown/binding-win32-x64-msvc@1.2.13`, `@rolldown/pluginutils@1.0.1`, `@standard-schema/spec@1.1.0`, `@tanstack/history@1.162.5`, `@tanstack/react-router@1.170.42`, `@tanstack/react-start@1.168.61`, `@tanstack/react-start-client@1.168.40`, `@tanstack/react-start-rsc@0.1.60`, `@tanstack/react-start-server@1.167.47`, `@tanstack/react-store@0.11.2`, `@tanstack/router-core@1.171.35`, `@tanstack/router-generator@1.167.41`, `@tanstack/router-plugin@1.168.43`, `@tanstack/router-utils@1.162.3`, `@tanstack/start-client-core@1.170.35`, `@tanstack/start-fn-stubs@1.162.0`, `@tanstack/start-plugin-core@1.171.50`, `@tanstack/start-server-core@1.169.40`, `@tanstack/start-storage-context@1.167.37`, `@tanstack/store@0.11.2`, `@tanstack/virtual-file-routes@1.162.0`, `@types/node@24.10.1`, `@types/pg@8.15.6`, `babel-dead-code-elimination@1.0.12`, `better-auth@1.7.7`, `better-call@1.4.0`, `browserslist@4.29.3`, `chokidar@5.0.0`, `convert-source-map@2.0.0`, `cookie-es@3.1.1`, `cron-parser@5.10.2`, `crossws@0.4.15`, `debug@4.4.3`, `defu@6.1.7`, `escalade@3.2.0`, `exsolve@1.1.3`, `fdir@6.5.0`, `fetchdts@0.1.7`, `gensync@1.0.0-beta.2`, `h3@2.0.1-rc.20`, `jiti@2.7.0`, `jose@6.2.12`, `js-tokens@4.0.0`, `js-yaml@4.3.2`, `jsesc@3.1.0`, `json5@2.2.3`, `kysely@0.29.6`, `luxon@3.7.2`, `magic-string@0.30.21`, `ms@2.1.3`, `nanoid@3.3.20`, `nanostores@1.5.5`, `node-releases@2.0.58`, `non-error@0.1.0`, `pathe@2.0.3`, `pg@8.23.0,8.23.1`, `pg-boss@12.37.1`, `pg-cloudflare@1.4.1`, `pg-connection-string@2.14.1`, `pg-pool@3.14.0`, `pg-protocol@1.16.1`, `pg-types@2.2.0`, `pgpass@1.0.5`, `picomatch@4.0.7`, `postcss@8.5.29`, `postgres-array@2.0.0`, `postgres-bytea@1.0.1`, `postgres-date@1.0.7`, `postgres-interval@1.2.0`, `prettier@3.9.10`, `react@19.2.8`, `react-dom@19.2.8`, `readdirp@5.1.1`, `rolldown@1.2.13`, `rou3@0.8.1,0.9.2`, `rrule-temporal@2.2.8`, `scheduler@0.27.0`, `serialize-error@13.0.2`, `seroval@1.6.9`, `seroval-plugins@1.6.9`, `set-cookie-parser@3.1.3`, `srvx@0.11.22,1.0.5`, `tagged-tag@1.0.0`, `tinyglobby@0.2.17`, `ufo@1.6.4`, `undici-types@7.16.0`, `unplugin@3.4.0`, `update-browserslist-db@1.3.4`, `use-sync-external-store@1.7.0`, `vite@8.3.4`, `vitefu@1.1.3`, `webpack-virtual-modules@0.6.2`, `xmlbuilder2@4.0.3`, `xtend@4.0.2`, `zod@4.6.6`.

**Apache-2.0** (6 package names):

`@opentelemetry/api@1.9.1`, `@opentelemetry/semantic-conventions@1.43.0`, `baseline-browser-mapping@2.11.28`, `detect-libc@2.1.2`, `drizzle-orm@0.45.2`, `temporal-spec@1.0.1`.

**ISC** (8 package names):

`ansis@4.4.0`, `electron-to-chromium@1.5.452`, `lru-cache@5.1.1`, `pg-int8@1.0.1`, `picocolors@1.1.1`, `semver@6.3.1`, `split2@4.2.0`, `yallist@3.1.1`.

**Python-2.0** (1 package names):

`argparse@2.0.1`.

**CC-BY-4.0** (1 package names):

`caniuse-lite@1.0.30001815`.

**BSD-3-Clause** (3 package names):

`diff@8.0.4`, `source-map@0.7.6`, `source-map-js@1.2.2`.

**Unlicense** (1 package names):

`isbot@5.2.2`.

**MPL-2.0** (2 package names):

`lightningcss@1.33.0`, `lightningcss-win32-x64-msvc@1.33.0`.

**(MIT OR CC0-1.0)** (1 package names):

`type-fest@5.10.0`.

### Attribution and distribution handling

Preserve dependency LICENSE, NOTICE and README license sections in distributions, including when code is bundled. This inventory does not replace those texts or establish that every final browser bundle/container notice has been verified.

- Drizzle ORM 0.45.2 declares Apache-2.0 but its installed package omits a root license file. Its complete tagged-source license is reproduced below.
- `@better-auth/utils` 0.4.2 and 0.5.0 declare MIT but omit a license file. The repository license is reproduced below from an immutable snapshot checked on the audit date. Published package metadata did not provide a `gitHead`; this snapshot is not asserted to be either release's source commit.
- `pg-types` 2.2.0 includes its full MIT notice in README.md: Copyright (c) 2014 Brian M. Carlson. `pgpass` 1.0.5 includes its full MIT notice in README.md: Copyright (c) 2013-2016 Hannes Hörl. Preserve these README notices when pruning/repackaging.
- `lightningcss` and its native binding are MPL-2.0, unmodified dependencies. Preserve their license and required source-availability information if distributed. Source: [Lightning CSS](https://github.com/parcel-bundler/lightningcss), version 1.33.0. They are not relabeled MIT.
- Unmodified browser compatibility data in `caniuse-lite` 1.0.30001815 is CC-BY-4.0: [caniuse-lite](https://github.com/browserslist/caniuse-lite), [Can I use](https://caniuse.com/), [license](https://creativecommons.org/licenses/by/4.0/).
- `argparse` 2.0.1 retains its bundled Python-2.0 license and historical notices. For dual-licensed `type-fest` 5.10.0, use the MIT option and preserve `license-mit`.
- The Rolldown native binding's notice is supplied with parent Rolldown: Copyright (c) 2024-present VoidZero Inc. & Contributors. Preserve its LICENSE and THIRD-PARTY-LICENSE with redistributed bindings.
- Nitro's notice is Copyright (c) Pooya Parsa <pooya@pi0.io> and Nitro contributors. Its MIT license must accompany redistributed bundled Nitro code as well as normal package distributions.

### Advisory evidence

On 2026-10-12, registry-backed `pnpm audit --prod --json` reported zero advisories across 184 dependency entries; `pnpm audit --json` reported zero across 221 entries including development/optional dependencies. These counts differ from license package-name counts. No advisory suppression or dependency override was added by this audit. These are dated known-advisory results, not proof of absence of vulnerabilities; recheck after dependency changes and before release.

### Drizzle ORM 0.45.2 - Apache-2.0

Source: [tagged upstream license](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/LICENSE).

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### @better-auth/utils 0.4.2 and 0.5.0 - MIT

Source: [upstream license snapshot](https://github.com/better-auth/utils/blob/c0ad05a303467b465c351d42c6465463be38ef78/LICENSE).

```text
MIT License

Copyright (c) 2024 - present, Bereket Engida

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Static report parser dependency addition (2026-10-13)

The report renderer adds direct dependency `parse5@8.0.1` (MIT) and its resolved transitive dependency `entities@8.1.0` (BSD-2-Clause). The foundation graph and lockfile hash above are a historical audit; this addition is recorded separately rather than relabeling that earlier inventory. Exact current integrity hashes are in `pnpm-lock.yaml`. Both installed package license files were inspected. No upstream application source or assets were copied.

Primary package records: [parse5 8.0.1](https://registry.npmjs.org/parse5/8.0.1), [entities 8.1.0](https://registry.npmjs.org/entities/8.1.0). The parser [upstream release](https://github.com/inikulin/parse5/releases/tag/v8.0.1) identifies commit `0d56627fc924d40f560fd260ade0e1a935e2369c`, matching its npm gitHead. An npm provenance attestation was not present in the inspected parse5 metadata; no attestation is claimed. The parser produces an HTML5 tree; ten98-monitor's original allowlist and HTTP sandbox policy determine what renders.

### parse5 8.0.1 — MIT license

```text
Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### entities 8.1.0 — BSD-2-Clause license

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Sitemap XML parser dependencies (2026-10-13)

The original sitemap adapter uses saxes 6.0.0 (ISC) and its sole runtime dependency xmlchars 2.2.0 (MIT), pinned in pnpm-lock.yaml. These licenses permit use in this MIT application while their notices remain intact. No upstream parser code was copied into the adapter. No XML builder or external entity resolver is installed.

Provenance: [official saxes version metadata](https://registry.npmjs.org/saxes/6.0.0), [official xmlchars metadata](https://registry.npmjs.org/xmlchars/2.2.0), and [complete saxes LICENSE at its release commit 211fa0ebec9b628affc09219199639887174bfc3](https://github.com/lddubeau/saxes/blob/211fa0ebec9b628affc09219199639887174bfc3/LICENSE). The saxes npm archive omits LICENSE, so its full upstream release notice is reproduced below, including inherited notices. The xmlchars notice is from its integrity-verified 2.2.0 package archive. Both upstream repositories are archived; upgrades require renewed source and adversarial-test review. The existing portable image copies this notice file.

### saxes 6.0.0 — full upstream license and inherited notices

```text
The ISC License

Copyright (c) Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====

The following license is the one that governed sax, from which saxes
was forked. Isaac Schlueter is not *directly* involved with saxes so
don't go bugging him for saxes issues.

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====

`String.fromCodePoint` by Mathias Bynens is no longer used, but it can
still be found in old commits. It was once used according to terms of
MIT License, as follows:

    Copyright Mathias Bynens <https://mathiasbynens.be/>

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### xmlchars 2.2.0 — MIT license

```text
Copyright Louis-Dominique Dubeau and contributors to xmlchars

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Server analytics environment parser dependencies (2026-10-15)

The original adapter pins detect-browser 5.3.0 and ua-parser-js 1.0.41, both MIT with no runtime dependencies, plus MIT type-only @types/ua-parser-js 0.7.39. The AGPL/commercial ua-parser-js v2 is not installed or copied. Exact integrity hashes remain in pnpm-lock.yaml; the existing dependency graph was preserved. Package license files were inspected; their complete notices follow. The portable image already copies this notice file.

### detect-browser 5.3.0 — MIT

Primary package record: [detect-browser 5.3.0](https://registry.npmjs.org/detect-browser/5.3.0).

```text
The MIT License (MIT)

Copyright (c) 2019 Damon Oehlman <damon.oehlman@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ua-parser-js 1.0.41 — MIT

Primary package record: [ua-parser-js 1.0.41](https://registry.npmjs.org/ua-parser-js/1.0.41).

```text
MIT License

Copyright (c) 2012-2025 Faisal Salman <<f@faisalman.com>>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### @types/ua-parser-js 0.7.39 — MIT

Primary package record: [@types/ua-parser-js 0.7.39](https://registry.npmjs.org/@types/ua-parser-js/0.7.39).

```text
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```


## Official MCP SDK and bundled component notices

The selected native MCP server dependency is exactly [`@modelcontextprotocol/server` 2.3.1](https://registry.npmjs.org/@modelcontextprotocol/server/2.3.1), with exact [`@modelcontextprotocol/core` 2.3.1](https://registry.npmjs.org/@modelcontextprotocol/core/2.3.1) and the existing Zod 4.6.6. No client SDK or v1 SDK is included. This dependency selection does not itself establish a working MCP endpoint or full upstream tool coverage.

The SDK declares Apache-2.0 and retains earlier MIT contributions under its combined transition license below, including its documentation notice. The application's own code remains MIT; this is not an MIT-only dependency distribution. Both selected archives contain the identical combined LICENSE and no separate NOTICE. Their registry integrity values are pinned in pnpm-lock.yaml. Server archive SHA-256: `96bc3fe00cbc9a72093a3f91c531387a5f988ea34d09e6c34a9a6b77dd0dc518`; core: `a48f246b7ba4f428ba6a96249fd0de3dd3b1e396cd8918630c2d4294b7d1db56`.

The published server distribution also bundles the eight components whose complete notices follow, including optional validator and declaration/source-map components. These are bundled contents, not eight added npm dependency nodes. The @cfworker archive omits its license text; its notice is preserved from the package registry gitHead [5409fdc2bd144f68e8b28c61c71fcb16600000a6](https://raw.githubusercontent.com/cfworker/cfworker/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md). The json-schema-typed notice includes its JSON Schema/IETF credits.

### @modelcontextprotocol/server and @modelcontextprotocol/core 2.3.1 — Apache-2.0

```text
The MCP project is undergoing a licensing transition from the MIT License to the Apache License, Version 2.0 ("Apache-2.0"). All new code and specification contributions to the project are licensed under Apache-2.0. Documentation contributions (excluding specifications) are licensed under CC-BY-4.0.

Contributions for which relicensing consent has been obtained are licensed under Apache-2.0. Contributions made by authors who originally licensed their work under the MIT License and who have not yet granted explicit permission to relicense remain licensed under the MIT License.

No rights beyond those granted by the applicable original license are conveyed for such contributions.

---

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright
      owner or by an individual or Legal Entity authorized to submit on behalf
      of the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

---

MIT License

Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Creative Commons Attribution 4.0 International (CC-BY-4.0)

Documentation in this project (excluding specifications) is licensed under
CC-BY-4.0. See https://creativecommons.org/licenses/by/4.0/legalcode for
the full license text.
```

### ajv 8.18.0 — MIT

```text
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ajv-formats 3.0.1 — MIT

```text
MIT License

Copyright (c) 2020 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fast-deep-equal 3.1.3 — MIT

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### json-schema-traverse 1.0.0 — MIT

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fast-uri 3.1.0 — BSD-3-Clause

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team
All rights reserved.

The Fastify team members are listed at https://github.com/fastify/fastify#team.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

### content-type 1.0.5 — MIT

```text
(The MIT License)

Copyright (c) 2015 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### @cfworker/json-schema 4.1.1 — MIT

```text
MIT License

Copyright (c) 2020 Jeremy Danyow

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### json-schema-typed 8.0.2 — BSD-2-Clause

```text
BSD 2-Clause License

Original source code is copyright (c) 2019-2025 Remy Rylan
<https://github.com/RemyRylan>

All JSON Schema documentation and descriptions are copyright (c):

2009 [draft-0] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2009 [draft-1] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-2] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-3] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
Gary Court <gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2013 [draft-4] IETF Trust <https://www.ietf.org/>), Francis Galiegue
<fgaliegue@gmail.com>, Kris Zyp <kris@sitepen.com>, Gary Court
<gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2018 [draft-7] IETF Trust <https://www.ietf.org/>, Austin Wright <aaa@bzfx.net>,
Henry Andrews <henry@cloudflare.com>, Geraint Luff <luffgd@gmail.com>, and
Cloudflare, Inc. <https://www.cloudflare.com/>.

2019 [draft-2019-09] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<bh7@sanger.ac.uk>, and Greg Dennis <gregsdennis@yahoo.com>.

2020 [draft-2020-12] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<ben@jsonschema.dev>, and Greg Dennis <gregsdennis@yahoo.com>.

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Optional browser session replay: rrweb2.1.7 — MIT

`public/replay.js` embeds the unmodified published rrweb2.1.7 UMD browser build and its style sheet inside an application-owned private scope. Upstream commit: a9cb69272522e677522f9a2f2eb8ac43fbf9efcb. Archive SHA-256:13680f81b1df0f7bae04a27e5b373de2b0deb39db1506049d53448c21428ba26. Unmodified UMD SHA-256:a35df0b0bed5ae358683e0a82aa8c1a354bb229f60469e4d269fb3e8b2c77058.

The bundled runtime also includes base64-arraybuffer1.0.2, mitt3.0.1 and @xstate/fsm1.6.5, all MIT. Complete upstream and dependency copyright notices and license texts are retained in `public/vendor/rrweb-LICENSE.txt`. The application's recorder/player adapters remain MIT. No remote CDN or additional Node runtime dependency is required.

## ten98-campaign shared interface

The owner-directed Discover redesign adopts the logo, stroked SVG icons, authentication composition, shell and shared-control CSS from the local ten98-campaign source snapshot inspected on 18 October 2026 (`src/main.tsx`, `src/styles.css`, `public/favicon.svg`). Application-specific data and authentication implementations remain independent.

MIT License

Copyright (c) 2026 ten98-campaign contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Current ten98 shared packages

The current manifest pins `@ten98/ui` 0.26.0 (`vendor/ten98-ui-0.26.0.tgz`, SHA-256 `b661ffbc89b93c56c1aed76d2b0cf58c1ede803958a44569aa1a821e454720fa`) and `@ten98/runtime` 0.15.1 (`vendor/ten98-runtime-0.15.1.tgz`, SHA-256 `0456766e2211690ef4a6220282ac475307c9ae09913158e6421bb9c006f0e682`). Both are MIT, copyright 2026 Ten98, and include their license text. Sources: [design system](https://github.com/Ten98-IO-Company/ten98-design-system), [code system](https://github.com/Ten98-IO-Company/ten98-code-system). The Ten98 MIT notice below remains applicable.

Earlier version sections retain their original attribution and review evidence. Their package bytes are preserved unchanged in the [historical archive release](https://github.com/Ten98-IO-Company/ten98-code-system/releases/tag/archive-2026-10-20); they are no longer installation inputs in this working tree.

### Inter typeface — SIL Open Font License 1.1

`@ten98/ui` 0.26.0 bundles the Inter variable font (`dist/fonts/inter-latin-wght-normal.woff2` and `dist/fonts/inter-latin-ext-wght-normal.woff2`), which the Discover build serves same-origin. The license below is reproduced unchanged from the package's `dist/fonts/OFL.txt`.

```text
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## ten98 shared UI package 0.3.0

`@ten98/ui` is consumed from the immutable local archive `vendor/ten98-ui-0.3.0.tgz`, SHA-256 `f73229fc6b2c7e14348a1dc77709d60e7110756d8ea5b4da30be5047ba05033f`. Source repository: https://github.com/Ten98-IO-Company/ten98-design-system . The archive contains its MIT license and shared Campaign/Discover attribution. It adds no runtime dependency; React and React DOM remain existing peer dependencies. Discover owns data, authorization, request identity, metric interpretation and native interactions. Library catalogue checks do not establish application or production acceptance.

MIT License

Copyright (c) 2026 Ten98

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Shared UI patch 0.3.1

The immutable patch archive is `vendor/ten98-ui-0.3.1.tgz`, SHA-256 `9f41f5e616e525d70767edcf138bf6131bc9bc14d86aea45b8c3a0c3d9c73eb8`. The 0.3.0 batch archive remains unchanged. This MIT patch wraps shared Button labels at enlarged text sizes; its JavaScript, declarations, API, peer dependencies and legacy application stylesheet are unchanged. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.2

The immutable patch archive is `vendor/ten98-ui-0.3.2.tgz`, SHA-256 `a49025981cff0e1bd4dd936a90b644b437b8120852ca9d012b0d12bd14f45069`. Prior archives remain unchanged. This MIT patch uses the existing surface token at 85.1% alpha for the native topbar and the existing disabled-surface token for shared disabled fields. Its JavaScript, declarations, API and peer dependencies are unchanged. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.3

The immutable patch archive is `vendor/ten98-ui-0.3.3.tgz`, SHA-256 `587d396d36e6cd654a6e451f9eb778062267fec2d96af90aed6800f1aa8c3b25`. Prior archives remain unchanged. This MIT patch makes the replay inactivity preference optional and uses the semantic disabled-text role for shared fields. No runtime dependencies, exports or peer requirements change. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.4

The immutable patch archive is `vendor/ten98-ui-0.3.4.tgz`, SHA-256 `e36ab3615fad0bbeb8cf293a45cab62cd92c727163b49e11f95e150ea045d2fa`. Prior archives remain unchanged. This MIT patch constrains form-grid tracks and children and stacks them below 481px. All JavaScript, declarations, exports and peer requirements are unchanged. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.6

The immutable patch archive is `vendor/ten98-ui-0.3.6.tgz`, SHA-256 `3f88760f2a27d46ecfd800c1fa690446155a7a0616d887f54d72efe2ac16a31f`, from Ten98 design-system commit `579cd75aeddc31b495f49bdd1de6609544c3dab0`. Prior archives remain unchanged. This MIT patch includes semantic theme and layout fixes, hidden-detail focus recovery, an optional numeric-evidence list label, and native controlled/uncontrolled multiline field forwarding. Runtime dependencies, exports and peer requirements are unchanged. Packaged review material is limited to Markdown; screenshots are excluded. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.8

The immutable archive is `vendor/ten98-ui-0.3.8.tgz`, SHA-256 `516b3c91749011dc489219ee073e8b2239be2f83ecc05521a41019a6bf74660a`, from Ten98 design-system commit `7e7312956e49ecd5feb0329cad8c57937897206a`. Prior archives remain unchanged. This MIT patch includes the 0.3.7 action/navigation semantic colors and adaptive header minima with wrapping breadcrumbs. All JavaScript, declarations, runtime dependencies, exports and peer requirements are unchanged from 0.3.6. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI patch 0.3.9

The immutable archive is `vendor/ten98-ui-0.3.9.tgz`, SHA-256 `a69d149767871ca2bed463f4d1b0f0528c4d5593ddc6fce33a10700726771135`, from Ten98 design-system commit `6771bc32d889a96a333b45eead7ea52e1365ff99`. Prior archives remain unchanged. This MIT patch restores ReportPanel error alerts, makes ComparisonMetric unavailable values and tracks follow text sizing, and guards Settings grid children against overflow. Only the measurement and reporting JavaScript modules change; declarations, APIs, runtime dependencies, exports and peer requirements are unchanged. Packaged review material is Markdown; screenshots are excluded. The preceding Ten98 copyright and MIT license cover this patch.

### Shared UI candidate 0.3.10

The earlier dependency was the immutable development candidate `vendor/ten98-ui-0.3.10.tgz`, SHA-256 `a356965b7c0e19b718cb8c9334d1aca3f67cb4c2ed97885295e8485c0841f280`, from Ten98 design-system commit `9a94e7f78dc9c2029204f6cd8ccf32c4affdcb13`. Prior archives remain unchanged. This MIT patch adds an optional standard `aria-label` to ReportPanel so its accessible region name can differ from the visible title. Only the reporting JavaScript module and its declaration change; styles, runtime dependencies, exports and peer requirements are unchanged. Packaged review material is Markdown; screenshots are excluded. The preceding Ten98 copyright and MIT license cover this candidate.
