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
