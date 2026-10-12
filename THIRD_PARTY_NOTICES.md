# Upstream provenance and reuse gate

The planning commit contains original documentation and a small documentation checker. It does not contain copied upstream application code, logos, fonts, datasets or vendor credentials. References and behavioral research do not grant permission to redistribute every upstream dependency or asset.

| Reference | Pinned commit | Root notice inspected |
|---|---|---|
| Elmo 0.4.4 | `3c673d0253d01ae030fa41519f62ad7e54f2281b` | [MIT; Copyright 2026 Blue Whale Software, LLC](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/LICENSE.md) |
| Umami 3.4.0 | `ec0ff50388c264ed8ce46f00967e92f7e71476ae` | [MIT; Copyright 2022 Umami Software, Inc.](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/LICENSE) |
| OpenSEO 0.1.12 | `89e5a00717cdf049b7c2b4e29646edb3a7d4995b` | [MIT; Copyright 2026 Ben Senescu](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/LICENSE) |

Before each source import, record original repository/commit/path, destination path, changes, author notice and license text. Include required notices in both source and distributed images. Review transitive dependencies, browser bundles, fonts, icons, geolocation data, recorder assets and generated clients. Preserve compatible third-party licenses; the project's MIT license does not relabel dependencies.

Do not adopt all three manifests or all hosted-service SDKs. One example requiring resolution is Umami's declared `ua-parser-js` 2.x dependency; verify its actual resolved license and select a compatible implementation or license strategy before reuse. Generic OIDC must not depend on an unreviewed paid/enterprise auth add-on. This plan makes no claim that the entire reference dependency graph is MIT.

Use original ten98-monitor branding. Upstream names identify references, not endorsement. Provider responses and datasets have separate usage/retention/redistribution terms; do not publish private captured answers or customer analytics as test fixtures. Prefer original synthetic fixtures, or explicitly licensed and sanitized evidence.

The [REA skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) informed source-versus-runtime evidence handling. Its code/tools were not bundled. Other local skills used as working instructions are recorded in the brief; their files are not redistributed here.

Future imported-code ledger: add entries when code is actually adopted. An empty import ledger is intentional at planning stage.

## Foundation dependency inventory

Optional deployment component: the official `caddy:2.11.7-alpine` image, pinned to manifest `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`, provides reverse proxy and automatic HTTPS. Caddy is Apache-2.0; its separate image includes its own dependencies and notices and is not relicensed MIT. No Caddy source is copied into the app. Verified on 2026-10-13 against the [official image inventory](https://github.com/docker-library/repo-info/blob/master/repos/caddy/remote/2.11.7-alpine.md) and [upstream license](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE). The optional image is pulled directly from the official registry, not republished here.

Audit date: 2026-10-12. Scope: `0.0.0-foundation`, `pnpm@11.19.0`, Node 24, lockfile SHA-256 `6c6777f9d139f3f592bd4a2e1430ebf406b7e9642bc14be8b8ff755f2777b30e`.

The foundation is original application code using library dependencies and the documented architectural patterns above. It does not copy Elmo, Umami or OpenSEO application files, branding or datasets. The upstream application import ledger remains empty. Library dependencies below are separate from that ledger and retain their own licenses; MIT is the license of ten98-monitor's original code.

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
| `zod` | 4.5.4 | MIT | dependencies |
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

`@babel/code-frame@7.29.7`, `@babel/compat-data@7.29.7`, `@babel/core@7.29.7`, `@babel/generator@7.29.8`, `@babel/helper-compilation-targets@7.29.7`, `@babel/helper-globals@7.29.7`, `@babel/helper-module-imports@7.29.7`, `@babel/helper-module-transforms@7.29.7`, `@babel/helper-string-parser@7.29.7`, `@babel/helper-validator-identifier@7.29.7`, `@babel/helper-validator-option@7.29.7`, `@babel/helpers@7.29.10`, `@babel/parser@7.29.9`, `@babel/template@7.29.7`, `@babel/traverse@7.29.10`, `@babel/types@7.29.8`, `@better-auth/core@1.7.7`, `@better-auth/drizzle-adapter@1.7.7`, `@better-auth/kysely-adapter@1.7.7`, `@better-auth/memory-adapter@1.7.7`, `@better-auth/mongo-adapter@1.7.7`, `@better-auth/prisma-adapter@1.7.7`, `@better-auth/telemetry@1.7.7`, `@better-auth/utils@0.4.2,0.5.0`, `@better-fetch/fetch@1.3.2`, `@jridgewell/gen-mapping@0.3.13`, `@jridgewell/remapping@2.3.5`, `@jridgewell/resolve-uri@3.1.2`, `@jridgewell/sourcemap-codec@1.6.0`, `@jridgewell/trace-mapping@0.3.31`, `@noble/ciphers@2.4.0`, `@noble/hashes@2.4.0`, `@oozcitak/dom@2.0.2`, `@oozcitak/infra@2.0.2`, `@oozcitak/url@3.0.0`, `@oozcitak/util@10.0.0`, `@oxc-project/types@0.153.0`, `@rolldown/binding-win32-x64-msvc@1.2.13`, `@rolldown/pluginutils@1.0.1`, `@standard-schema/spec@1.1.0`, `@tanstack/history@1.162.5`, `@tanstack/react-router@1.170.42`, `@tanstack/react-start@1.168.61`, `@tanstack/react-start-client@1.168.40`, `@tanstack/react-start-rsc@0.1.60`, `@tanstack/react-start-server@1.167.47`, `@tanstack/react-store@0.11.2`, `@tanstack/router-core@1.171.35`, `@tanstack/router-generator@1.167.41`, `@tanstack/router-plugin@1.168.43`, `@tanstack/router-utils@1.162.3`, `@tanstack/start-client-core@1.170.35`, `@tanstack/start-fn-stubs@1.162.0`, `@tanstack/start-plugin-core@1.171.50`, `@tanstack/start-server-core@1.169.40`, `@tanstack/start-storage-context@1.167.37`, `@tanstack/store@0.11.2`, `@tanstack/virtual-file-routes@1.162.0`, `@types/node@24.10.1`, `@types/pg@8.15.6`, `babel-dead-code-elimination@1.0.12`, `better-auth@1.7.7`, `better-call@1.4.0`, `browserslist@4.29.3`, `chokidar@5.0.0`, `convert-source-map@2.0.0`, `cookie-es@3.1.1`, `cron-parser@5.10.2`, `crossws@0.4.15`, `debug@4.4.3`, `defu@6.1.7`, `escalade@3.2.0`, `exsolve@1.1.3`, `fdir@6.5.0`, `fetchdts@0.1.7`, `gensync@1.0.0-beta.2`, `h3@2.0.1-rc.20`, `jiti@2.7.0`, `jose@6.2.12`, `js-tokens@4.0.0`, `js-yaml@4.3.2`, `jsesc@3.1.0`, `json5@2.2.3`, `kysely@0.29.6`, `luxon@3.7.2`, `magic-string@0.30.21`, `ms@2.1.3`, `nanoid@3.3.20`, `nanostores@1.5.5`, `node-releases@2.0.58`, `non-error@0.1.0`, `pathe@2.0.3`, `pg@8.23.0,8.23.1`, `pg-boss@12.37.1`, `pg-cloudflare@1.4.1`, `pg-connection-string@2.14.1`, `pg-pool@3.14.0`, `pg-protocol@1.16.1`, `pg-types@2.2.0`, `pgpass@1.0.5`, `picomatch@4.0.7`, `postcss@8.5.29`, `postgres-array@2.0.0`, `postgres-bytea@1.0.1`, `postgres-date@1.0.7`, `postgres-interval@1.2.0`, `prettier@3.9.10`, `react@19.2.8`, `react-dom@19.2.8`, `readdirp@5.1.1`, `rolldown@1.2.13`, `rou3@0.8.1,0.9.2`, `rrule-temporal@2.2.8`, `scheduler@0.27.0`, `serialize-error@13.0.2`, `seroval@1.6.9`, `seroval-plugins@1.6.9`, `set-cookie-parser@3.1.3`, `srvx@0.11.22,1.0.5`, `tagged-tag@1.0.0`, `tinyglobby@0.2.17`, `ufo@1.6.4`, `undici-types@7.16.0`, `unplugin@3.4.0`, `update-browserslist-db@1.3.4`, `use-sync-external-store@1.7.0`, `vite@8.3.4`, `vitefu@1.1.3`, `webpack-virtual-modules@0.6.2`, `xmlbuilder2@4.0.3`, `xtend@4.0.2`, `zod@4.5.4`.

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
