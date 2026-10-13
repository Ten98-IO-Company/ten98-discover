# Kimi-first development

GPT owns planning, design, complex work, testing after completion, and final signoff. Kimi handles routine, bounded execution wherever useful: implementation against GPT-approved specifications, test implementation, documentation, and evidence extraction. Kimi does not make authoritative planning/design decisions or validate its own work for acceptance. This allocation targets lower Astra usage; savings must be measured, not assumed. V1 still requires the complete agreed feature-parity matrix across Elmo, Umami, and OpenSEO; internal milestones do not reduce public V1 scope.

## Verified baseline — 2026-10-12

- Official latest Kimi Code CLI: **2.1.1**, released 2026-09-24. [Release](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai/kimi-code@2.1.1)
- The Python `kimi-cli` project is archived; do not install its legacy PyPI package. [Legacy changelog](https://moonshotai.github.io/kimi-cli/en/release-notes/changelog.html)
- **Installed and verified:** native 2.1.1, official platform-manifest checksum matched, `kimi --version` confirmed, and `kimi doctor` passed. Git Bash is available. Native installation avoids the machine's older Node version.
- **Authenticated:** individual `managed:kimi-code` OAuth succeeded. `provider list` verified aliases `kimi-code/k3` and `kimi-code/k3-256k`; the default is `kimi-code/k3-256k`. Local defaults use manual permissions, disable telemetry, and set `max_attempts_per_step=2`; `kimi doctor` passes.
- **Smoke task passed:** one short public-text checklist task used the repository's tool-free profile and `kimi-code/k3-256k`; GPT checked its accurate output. No private/provider/customer data was supplied; no application implementation was performed.
- **Quota status:** authenticated individual subscription; exact remaining quota, wider model entitlements, and usage totals still need verification. One successful call does not establish every model entitlement.

## Install and authenticate

Official Windows PowerShell installation, requiring Git for Windows but no preinstalled Node:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

Then open a new terminal in the development repository:

```powershell
kimi --version
kimi doctor
kimi
```

Inside the CLI, run `/login` and complete Kimi Code OAuth in the browser. Kimi Platform API-key login is an alternative. The user completes authentication; keys and tokens never enter this repository or task output. For later updates use `kimi upgrade`, then verify the installed version again. [Official getting-started instructions](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html)

## Select and verify K3

Use the verified alias **`kimi-code/k3-256k`**. On another installation inspect `/model` and `/status` first; CLI `-m` expects a configured alias.

The official IDs are `k3-256k` and `k3`. K3 requires Plus/Moderato or above; 1M context requires Pro/Allegretto or above. The fixed 256K variant is the default for bounded tasks because 1M K3 consumes approximately twice its quota. Keep thinking enabled: disabling it routes K3 requests to K2.8 Preview. The owner requested **maximum effort**, so set the supported process override `KIMI_MODEL_THINKING_EFFORT=max`. Keep effort stable within a session. The currently documented HighSpeed model is **K2.7**, with approximately 6× speed and 3× quota use; it is not a K3 speed switch and was not substituted. Reverify capabilities and entitlements before changing models. [Official model configuration](https://www.kimi.com/code/docs/en/kimi-code/models), [environment overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars)

Retain readiness evidence without credentials:

| Check | Required evidence |
| --- | --- |
| Executable | 2.1.1 installed 2026-10-12; checksum verified |
| Configuration | `kimi doctor` passed; manual permission default, telemetry off |
| Authentication | Individual managed OAuth succeeded; no tokens/device codes retained here |
| Model | Both K3 aliases discovered; K3-256K successful call verified |
| Smoke task | Public text only; tools/delegation disabled; GPT checked result |
| Usage | Totals and remaining allowance unknown; inspect `/usage` |

`/usage` reports usage/context/quota, `/status` reports runtime state, `/new` starts fresh, and `/compact` compresses context. Record only the relevant numeric summaries, not session exports. [Slash-command reference](https://moonshotai.github.io/kimi-code/en/reference/slash-commands.html)

## Work partition

| Work | Primary executor | Review or acceptance |
| --- | --- | --- |
| Product planning, parity decisions, architecture | GPT | GPT decision; function ambiguities go to user |
| UI design, user flows, complex/security-sensitive work | GPT | GPT owns design and implementation decisions |
| Bounded evidence extraction, copy, routine documentation | Kimi | GPT checks source fidelity and accuracy |
| Routine UI/CRUD/integration code from accepted specification | Kimi | GPT-approved files/dependencies; independent GPT review |
| Test implementation and routine local checks | Kimi | GPT owns test strategy and validation after completion |
| Docker/runbook edits from agreed deployment design | Kimi | GPT executes independent deployment/recovery validation |
| Final V1 parity, testing, release signoff | GPT | Every agreed requirement evidenced and checked |

The default repository profile, [`agents/kimi-text-only.md`](../agents/kimi-text-only.md), declares `tools: []` and `subagents: []`. It can transform supplied public text only. Custom agent allowlists are enforced by the CLI; prompts alone are not a sandbox. More capable profiles require the isolated worker described below. No orchestration framework or default background automation is planned. [Agent documentation](https://moonshotai.github.io/kimi-code/en/customization/agents.html)

For Windows skill-assisted drafting, use the [bounded runner](../scripts/kimi-draft.ps1) and [Skill-only profile](../agents/kimi-skill-drafter.md). First copy only reviewed Markdown skills into a separate public task directory, review the prompt, and choose a **new**, empty output path outside any checkout. Do not point it at your whole skills/home directory. The runner rejects project/global instructions, MCP/plugin configuration and hooks that need separate review; it requires explicit thinking enabled in the existing CLI configuration. It does not change global settings or apply drafts.

```powershell
pwsh -NoProfile -File .\scripts\kimi-draft.ps1 `
  -PromptFile C:\public-task\prompt.md `
  -SkillsDirectory C:\public-task\reviewed-skills `
  -OutputDirectory C:\scratch\new-kimi-draft `
  -TimeoutSeconds 600
```

Use actual absolute local paths whose parent directories already exist. The runner pins the reviewed native CLI and model, passes arguments without a shell, drains output privately, and kills only its own process tree at the deadline. Exit 2 means a prerequisite failed; 124 means timeout. Its runnable offline check uses a fake local child and spends no Kimi quota:

```powershell
. ./scripts/kimi-draft.ps1
Test-KimiDraftProcess
```

## Run one bounded task

1. GPT defines the requirement, design, file allowlist, acceptance check, and budget.
2. Supply approved public text to a tool-free or curated Skill-only drafting profile; use an isolated worker before enabling filesystem or shell tools.
3. Kimi produces the bounded patch; no new dependency without GPT review.
4. Kimi may implement/run checks; GPT independently tests completed work and reviews the diff.
5. GPT accepts or requests repair; after two failed repair attempts escalate instead of looping.

The text-only profile was used for the earlier supervised planning tasks recorded below. New drafting tasks use the bounded runner above; launching the CLI directly bypasses its deadline, clean working directory, version check and maximum-effort preflight. Do not reintroduce a direct-launch shortcut when reusing the historical text-only profile.

`-p` uses automatic permissions, regardless of the manual interactive default, and cannot combine with `--plan`, `--auto`, or `--yolo`. The empty tool/delegation allowlists are essential here. A prompt or `explore` profile does not isolate filesystem/network access sufficiently for untrusted code. `kimi doctor` checks configuration without editing it. [CLI reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)

## Task prompt template

```text
Requirement: [parity ID, observable user outcome, internal milestone]
Input: [supplied public text, or isolated checkout and exact read allowlist]
Own: [exact files]; change no other files; bounded patch [size/scope limit].
GPT-approved design: [decision/spec reference; no redesign or scope reduction]
Trace: [entry point and callers, coding tasks only]; fix the shared cause.
Constraints: full agreed V1 parity; MIT-compatible provenance;
Docker deployment; no new dependency without GPT review.
No secrets/private files, production, accounts, pushes, or deployments.
Acceptance: [specific behavior, failure case, runnable check]
Budget: [owner-approved Kimi usage/time allowance; stop checkpoint]
Escalate: unclear behavior, incompatible license, security boundary,
destructive migration, new service/dependency, or two failed repair attempts.
Return: change summary, file paths, checks/results, unresolved decisions,
and usage delta. No full transcript. GPT performs final independent validation.
```

## Budget, boundaries, and escalation

### Foundation swarm ledger — 2026-10-12

CLI 2.1.1; fixed `kimi-code/k3-256k`; `KIMI_MODEL_THINKING_EFFORT=max` requested in each child process. The installed CLI and official reference support that override; no provider wire trace was captured to independently prove the resolved effort. Account allowance, quota deltas and token savings remain unknown. These were parallel Kimi CLI workers coordinated by GPT, not unrestricted native Kimi delegation. UI, packaging and validation had disjoint file ownership; GPT owned the shared contract, auth, database transactions, review and acceptance tests.

| Task | Curated skills observed in tool output | CLI wall time | Checkpoint | Disposition |
|---|---|---:|---:|---|
| M1-UI-01 | Ponytail, frontend design | 650.6 s | 15 min | Drafted UI/CSS; GPT review required repair |
| M1-PACK-01 | Ponytail | 148.2 s | 12 min | Drafted Docker/Compose; GPT corrected commands/notices and pinned tested base images |
| M1-VALIDATION-01 | Ponytail | 608.0 s | 10 min | Drafted validator and 13 tests; completed 8 seconds beyond the supervised checkpoint, before the next poll |
| M1-UI-REPAIR-01 | Ponytail, UX copy refiner | 230.4 s | 10 min | Corrected role gates, stale responses, validation and copy; GPT applied final small fixes |
| M1-DOC-01 | Ponytail | 77.8 s | 10 min | Drafted foundation runbook; GPT updated actual test evidence |
| M1-RUNNER-SMOKE-01 | Ponytail | 21.4 s | 120 s hard deadline | Real CLI check of the hardened runner passed; no application edits |

The draft profile exposed only `Skill`; tool-call logs confirmed the expected skills and no shell, file-edit, network or delegation tools. GPT supplied public task material, validated exact output paths, reviewed and applied JSON drafts, and ran checks independently. CLI credentials stayed outside the repository. Raw outputs and session files are not published.

The supervised time-checkpoint overrun led to a hard-timeout runner for subsequent tasks. Manual launch directories also allowed automatic project discovery; a clean scratch working directory is required in the runner. A restricted tool profile alone must not be described as proof that all implicit CLI context is isolated. File-writing Kimi work remains blocked until the separate operating-system isolation below is verified.

GPT independently ran the runner's offline checks for literal arguments, concurrent stdout/stderr draining, child-only environment overrides, exit propagation, thinking/hooks preflight and process-tree timeout. The subsequent real smoke task completed within its hard deadline and logged only the permitted Ponytail Skill call. This validates the draft runner, not an unrestricted coding sandbox.

Planning task ledger, 2026-10-12: TRK-COPY-01 used Kimi Code 2.1.1 with `kimi-code/k3-256k`, the tools/subagents-disabled text profile and an empty task skills directory for one bounded UI-state wording response. The initial local-storage permission failure happened before a response; one supervised retry completed. GPT revised the copy for the owner's later browser-direct/import/alias scope and performed independent review. Exact elapsed model time and quota/token delta were not measured; no savings claim. No provider calls, file tools, account changes or publication were delegated to Kimi.

ONB-COPY-01, same date: Kimi Code 2.1.1, `kimi-code/k3-256k`, tools/subagents disabled, empty skills directory, supplied public wording only. One response revised eight GPT-defined setup states; 180-second/250-word cap, no repair attempts. Observed CLI wall time was 10.5 seconds; account allowance and quota/token delta were unavailable. GPT revised the pending-import wording and avoided promises of duplicate-free imports in UI copy, then reviewed the resulting design independently. No file tools, private deployment notes, customer data, provider calls or account changes were supplied/delegated. Planning and security decisions remained with GPT.

- Before each batch record task ID, CLI/model/effort, verified available allowance, start usage, and time. Set a numeric ceiling from verified figures when available; otherwise use an explicit task/time cap. No invented quota percentage allocation.
- Afterward record usage delta, elapsed time, accepted/reworked result, and Astra review usage if available. Separate tokens from quota units. Mark missing measurements unknown; do not infer per-task tokens from account-wide percentages.
- Compare accepted requirements per Kimi quota unit and Astra review consumption across milestones. Keep only a compact ledger in issue/PR notes; no telemetry service or budgeting script.
- Checkpoint at the agreed ceiling, two unsuccessful repair attempts, or a material decision. GPT receives the failing check, minimal diff, competing options, and Kimi's recommendation; Kimi does not decide acceptance.
- Never transmit private deployment documents, `.env` files, credentials, tokens, database dumps, raw production logs, customer data, or unrelated workspace content. Use sanitized lessons already approved for the public plan. A working directory is not an isolation guarantee.
- Coding requires a dedicated unprivileged worker with only the approved task checkout mounted, explicit file/command allowlists, and network restrictions appropriate to the task. No host-home/private-repository mounts, Docker socket, `.ssh`, `.env`, production access, publishing credentials, accounts, pushes, or deployments. Keep only necessary Kimi OAuth credentials in a separate protected worker location outside the checkout.
- Do not add private repositories via additional directories, MCP, or copied history. Do not commit CLI config, sessions, debug exports, or logs. Workspace prompts and CLI permissions supplement isolation; they do not replace it. The application runtime has no Kimi dependency.
- Model failure or exhausted quota does not authorize silent fallback to Astra for bulk work. Report the blocked batch and budget decision; other unblocked work can continue. User-visible function ambiguity goes to the user before implementation.

### Workspaces and analytics swarm ledger — 2026-10-13

Three overlapping Kimi CLI jobs drafted routine code against GPT-approved API contracts and the existing design. Each used native CLI **2.1.1**, fixed **`kimi-code/k3-256k`**, the bounded runner, and `KIMI_MODEL_THINKING_EFFORT=max`. The runner required explicit thinking enabled in the existing configuration, capped each turn at eight steps and each failing step at two total attempts, and disabled infinite retries, automatic updates and telemetry for the child process. GPT retained architecture, backend/security implementation, review, application of drafts and acceptance testing. This was GPT coordination of separate CLI processes; native Kimi delegation was disabled.

| Task | Curated skills observed in `Skill` calls | Observed output duration | Hard deadline | Draft ownership and result |
|---|---|---:|---:|---|
| TEAM-UI | Ponytail, UX copy refiner | 431.8 s | 900 s | `TeamPanel.tsx`, `InvitePanel.tsx`; exit 0, reviewed and applied |
| ANALYTICS-UI | Ponytail, frontend design | 212.6 s | 900 s | `AnalyticsPanel.tsx`, `analytics.css`; exit 0, reviewed and applied |
| TRACKER | Ponytail | 413.1 s | 600 s | `public/tracker.js`, `tests/tracker.test.ts`; exit 0, reviewed and applied |

Durations are measured from the captured output file's creation through its final write, including local CLI/output handling. They are **not measured provider latency**. Resolved effort was not independently verified through a provider wire trace. Remaining allowance, per-task tokens, quota deltas, Astra review consumption and monetary/token savings remain **unknown**; no savings are inferred from these durations.

Only reviewed public task specifications, curated Markdown skills and existing public source were supplied. Initial TEAM-UI and TRACKER launch requests were rejected by automatic approval review until payload provenance was established; those rejected requests did not launch a model job. An unauthenticated GitHub check confirmed the repository was public, and the supplied tracker/styles matched [public baseline `4aa3235`](https://github.com/Ten98-IO-Company/ten98-monitor/commit/4aa323540867e4217600356ef6b08fe17a5fb26d). The subsequent retries were approved. Each successful job ran in a new scratch directory outside Git checkouts, with owner-only output files, the fixed Skill-only profile and an enforced process-tree deadline. Observed tool calls were exclusively `Skill`; Kimi had no shell, file-edit, network-tool or delegation access. Existing CLI authentication remained outside the checkout. This is a constrained draft workflow, not proof of operating-system isolation.

GPT validated each response against its exact two-file allowlist before applying it, then made these review corrections:

- **Team and invitations:** reset state and abort requests across workspace/token/account changes; prevent duplicate mutations; retain owner management subject to server authorization; align name/email limits with the backend; clear revoked invitation links and cached management controls after access-denied responses; contain refresh failures; provide sign-in recovery when an invitation acceptance encounters an expired session/existing-account conflict.
- **Analytics:** constrain chart height, improve secondary-series contrast, correct stacked date-field sizing on mobile, clear stale totals when changing ranges, guard stale project responses, and make empty-state/table wording accurately describe the selected range and result limits.
- **Tracker:** suppress the HTTP `Referer` header as well as query/hash data in the payload; reject trailing whitespace in event names; contain failures from the host console; preserve initial/custom tracking when a history method is non-writable. Regression checks cover those failure paths alongside navigation, restoration, duplicate initialization and multiple sites.

Kimi explicitly reported that it had not compiled or executed its drafts. GPT independently ran the TypeScript check and all **17 tracker VM tests**, which passed, and obtained a separate identity-flow review. Browser and Docker acceptance remain the supervising GPT's responsibility; draft completion does not establish a production release or full V1 parity. Raw prompts, outputs, credentials and session files are not included in this ledger.

### Security, identity, destinations and setup swarm — 2026-10-13

The following bounded tasks used native CLI **2.1.1**, fixed **`kimi-code/k3-256k`**, explicit thinking enabled and maximum effort requested through the same runner. K3 speed mode was unavailable; no older-model speed substitution was made. GPT retained account security, protocol/tenant/spending design, encryption, consent decisions, integration, and independent acceptance. Parallel work had separate output folders and file ownership. Only reviewed public source/contracts, synthetic cases and curated Markdown skills were supplied; credentials and private fixture files were not included. The application runtime does not depend on Kimi.

| Task | Skills observed | Observed duration | Hard deadline | Result |
|---|---|---:|---:|---|
| API-key UI | Curated Skill-only profile | 114.7 s | 900 s | Draft accepted with GPT review corrections |
| Provider/spending UI | Curated Skill-only profile | 380.7 s | 900 s | Draft accepted with GPT review corrections |
| Account-security UI | Curated Skill-only profile | 440.0 s | 900 s | Draft accepted with GPT review corrections |
| OIDC UI | Ponytail, UX copy refiner | 515.9 s | 900 s | Two-file draft accepted; GPT fixed stale callbacks, permission loss, account/proof changes and OIDC-only recovery integration |
| Destination UI | Ponytail, UX copy refiner, frontend design | 383.8 s | 900 s | Draft applied after a bounded JSON-envelope repair and GPT review |
| Destination domain code | Ponytail | 670.1 s | 900 s | Draft applied; GPT reviewed roles, locking, public config, mapping and concurrency |
| Destination browser loader | Skill-only profile | 900.2 s | 900 s | Child terminated at deadline; no final code returned |
| Narrowed browser adapter retry | No tool call before failure | 2.0 s | 300 s | Native CLI exited with `-1073740791`; no final code returned |
| DKR-SETUP-01 | Ponytail | 277.6 s | 480 s | Helper/test draft accepted; GPT corrected a false-positive test catch and added failure-path checks |

After the two browser-draft failures, the supervising GPT explicitly took over the security-sensitive consent coordinator and bounded native adapters. This was a checkpoint handoff, not an inferred quota failure or silent bulk-model substitution. No further Kimi retries were launched for that batch.

GPT corrections included live role/account guards, one-time secret clearing, strict monetary and identifier parsing, safe session display on mobile, consent expiry measured from the affirmative choice, pre-navigation consent restoration only, and an explicit loaded-SDK withdrawal policy. Submitted secrets and enrollment values were kept out of screenshots and public logs. SDK invocation remains distinct from a provider receipt.

Independent validation used unit checks, fresh PostgreSQL production-build integration, original-install upgrades, a signed local OIDC issuer, Edge browser flows with intercepted vendor scripts, and isolated Docker images. No real IdP or paid provider request was made by these checks. The implementation runbook records coverage and unresolved release gates. Resolved provider effort, account allowance, quota delta, per-task tokens, GPT review token usage and savings remain unknown; output duration is not provider latency or a savings measurement.

### Native analytics, reports and domains swarm — 2026-10-13

Routine drafts used CLI **2.1.1**, **`kimi-code/k3-256k`**, thinking enabled and maximum effort requested. Each task had a public contract, disjoint output, curated Skill-only access, eight-step ceiling, two internal attempts per failing step and a 900-second process-tree deadline. K3 speed mode was unavailable. Authentication stayed outside the repository; no private fixtures, secrets or customer data were provided. Separate CLI workers were supervised by GPT; native Kimi delegation remained disabled.

| Task | Skills observed | Observed duration | Result |
|---|---|---:|---|
| Typed analytics normalizer | Ponytail | Approximately 6 minutes | Draft reviewed and corrected for strict dates, Unicode, hidden accessors and input boundaries |
| Collection/privacy settings UI | Ponytail, UX copy refiner | Approximately 5 minutes | Draft reviewed and corrected for stale responses, conflicts and confirmation changes |
| Domain registry UI | Ponytail, UX copy refiner | 616.2 seconds | Draft reviewed and corrected for lifecycle, permission and late clipboard results |
| Report editor UI | Ponytail, UX copy refiner | 900-second timeout | No final code returned; child stopped at deadline |

Quota-rejected attempts were stopped. After the owner indicated an imminent reset, GPT continued security/design/testing and resumed bounded Kimi work once available. A separate native CLI crash returned no code. The report deadline triggered an explicit GPT handoff for the access-sensitive editor and capability-sharing flow; no further report drafting retries were launched. GPT also retained database locking, identity/consent, report sanitization, DNS proof security and final acceptance.

Independent checks found and corrected shared report read/write rate-limit accounting, preserved unsaved drafts on conflicts, and verified sensitive state clearing after role/project/session changes. The foundation runbook records actual unit, PostgreSQL and production-browser evidence. Account usage, per-task token counts, resolved provider effort and savings were not measured; approximate elapsed times are not usage estimates. Raw model output, local paths, credentials and private fixture evidence are excluded from this ledger.

### Retention, project content and exploration

The same bounded CLI2.1.1/K3-256K maximum-effort, explicit-thinking and Skill-only workflow produced the retention UI in386.8seconds, Prompts UI in610.4seconds and Explorer UI in389.4seconds. Each successful task loaded only the reviewed Ponytail and UX Copy Refiner skills. Context drafting stopped after900.2seconds and a final300.1-second retry without a final file; an explicit GPT checkpoint handoff completed its design and lifecycle work. See [content evidence](project-context.md) and [Explorer evidence](explorer.md). GPT owned backend/security, integration, corrections and independent database/browser acceptance. These are observed output durations, not token, subscription-use or savings measurements.

### Keyword research UI attempt — 2026-10-13

The approved [public issue20 UI contract](https://github.com/Ten98-IO-Company/ten98-monitor/issues/20#issuecomment-6135229497) was supplied to CLI **2.1.1**, **kimi-code/k3-256k**, with thinking enabled and maximum effort requested. The fixed Skill-only profile, curated Ponytail/frontend-design/UX-copy skills, eight-step ceiling and 900-second process-tree deadline remained in force. No private source, configuration, fixtures, customer data or credentials were included.

The single attempt exited after **3.6 seconds of observed runner wall time** with a provider 403 five-hour usage limit. It returned no usable draft, and no skill invocation or implementation is credited to it. No immediate retry or automatic GPT routine-UI substitution was made. GPT continued the already assigned paid-call security, server architecture and independent synthetic validation. The later resumed attempt is recorded below. Duration is not provider latency; per-task tokens, quota delta, resolved provider effort and savings were not measured.

### Research and audit interface swarm — 2026-10-13

After quota became available, the same bounded CLI **2.1.1**, **kimi-code/k3-256k**, explicit-thinking and maximum-effort workflow received three separate, reviewed public contracts. The Skill-only profile, curated Markdown skills, eight-step ceiling, two attempts per failing step and 900-second process-tree deadline remained in force. K3 speed mode was unavailable; no other model was substituted. Native Kimi delegation remained disabled. GPT coordinated disjoint tasks and retained application of drafts, shared navigation, security, interaction design and independent validation.

| Task | Observable skill calls | Observed result |
|---|---|---|
| Keyword research screen | Ponytail and UX copy refiner | Usable draft returned in 572.8 seconds; GPT corrected lost-acknowledgement recovery, live access checks, interruptible polling and response validation |
| Prompt comparison screen | Ponytail and UX copy refiner | Runner stopped at 900.2 seconds; no draft artifact returned |
| Site Audit screen | None observed; captured output contained only the CLI version event | Runner stopped at the 900-second deadline; no draft artifact returned |

The two deadlines triggered explicit GPT handoffs for the complex execution and evidence-view lifecycle work. No repeated model retry or quota polling was used to infer progress. Only public source/contracts and curated skills were supplied to Kimi; private test environments, credentials, customer data and operational logs were excluded. Browser acceptance is tracked in [research interface evidence](research-ui.md). Per-task tokens, subscription-use deltas, resolved provider effort and savings remain unknown.

### Conversion definition swarm — 2026-10-13

Two smaller, independent tasks used CLI **2.1.1**, **kimi-code/k3-256k**, explicit thinking and maximum effort. The same Skill-only runner, eight-step ceiling, two internal attempts per failing step, private output directories and fixed deadlines applied. GPT coordinated the parallel workers; native Kimi delegation remained disabled. Only reviewed public specifications/source and curated Markdown skills were supplied.

| Task | Observed skills | Observed result |
|---|---|---|
| Definition parser | Ponytail | Successful draft; 325.2 seconds between captured output creation and final write |
| Controlled criteria fields | Ponytail, Design UX Copy | Successful draft; 281.4 seconds of runner wall time within a 600-second deadline |

GPT corrected the parser's disguised sparse-array handling, explicit-undefined optional fields and TypeScript control-flow narrowing. It clarified the fields' null-value copy and added native input limits. Independent parser and controlled-field checks passed. GPT retained the measurement/source contract, PostgreSQL queries, access and revision controls, application lifecycle, migration, performance assessment and final browser testing. See [conversion acceptance](conversions.md). These durations are local observations, not provider latency. Tokens, subscription-use deltas, resolved provider effort and savings remain unknown.

### Saved keyword swarm — 2026-10-13

Two bounded routine leaves used CLI **2.1.1**, **kimi-code/k3-256k**, explicit thinking and maximum effort. The parser loaded Ponytail and returned in **669.6 seconds** within a 900-second deadline. The controlled filter fields loaded Ponytail and Design UX Copy and returned in **142.9 seconds** within a 600-second deadline. Both used the reviewed Skill-only profile, eight-step ceiling, two internal attempts per step and separate private output directories. GPT coordinated the parallel workers; native Kimi delegation remained disabled. Only the approved [public contract](https://github.com/Ten98-IO-Company/ten98-monitor/issues/39) and reviewed public skills were supplied.

GPT corrected the parser's Unicode helper, absolute regex endings, nullable cursor handling, revoked-proxy/null-prototype rejection, normalized tag-length check and TypeScript narrowing. It removed an unnecessary JSX-runtime assumption from the controlled fields. Ten independent parser groups and full TypeScript analysis passed. GPT owns storage, authorization, spending, retention, UI interaction and independent acceptance, recorded in [saved keywords](saved-keywords.md). These are observed local runner times, not provider latency. Tokens, quota deltas, resolved provider effort and savings were not measured. No K3 speed option was available; no model substitution was made.

### Rank parser review checkpoint — 2026-10-13

The first [rank-tracking leaf](https://github.com/Ten98-IO-Company/ten98-monitor/issues/41#issuecomment-6140477088) used CLI **2.1.1**, **kimi-code/k3-256k**, explicit thinking and maximum effort. Only the reviewed public parser contract and Ponytail skill were supplied. The captured output records one Ponytail invocation and a single allowlisted parser file; the eight-step Skill-only profile and 900-second deadline remained in force. Observed output-file duration was **387.7 seconds**. No tests were claimed by Kimi.

GPT applied the draft, moved raw array bounds ahead of property enumeration, and added an explicit UUID length bound. Eight independent parser groups passed. A separate GPT review found and corrected calendar-gap recurrence, public-host versus DNS-proof capacity, and rank-only account-key recovery issues; those are independent security and integration work. Routine UI implementation remains queued for Kimi without automatic GPT substitution. Tokens, quota deltas, provider-resolved effort and savings remain unmeasured; duration is not provider latency. The [rank contract](rank-tracking.md) records the unfinished feature boundary.

### Rank manual-check presentation — 2026-10-13

Two isolated Skill-only Kimi leaves drafted the quote-review and run-results views from reviewed public contracts. Both used CLI2.1.1, `kimi-code/k3-256k`, explicit thinking, maximum effort, the eight-step/two-attempt limits and a900-second deadline. Observed output durations were246.9seconds and354.4seconds respectively; each loaded Ponytail and UX Copy Refiner. No speed-model substitution or unrestricted tools were enabled.

GPT reviewed/applied both drafts and implemented the security-sensitive controller, scoped history services, recovery capability and independent acceptance. Review bound acknowledgements to the captured paid scope, preserved immutable retry intent after408/429 responses, and kept task/run expiry irreversible. Eight new browser groups, twelve management groups, nine PostgreSQL/API history groups, six owner-recovery groups, the production build and339 unit tests passed. Tests used synthetic providers; Kimi did not approve its own output. Token counts, quota deltas, provider-resolved effort and savings remain unmeasured.

### Rank history and recurring schedule presentation — 2026-10-13

Two more isolated Skill-only leaves drafted the controlled history and schedule views from the public [history contract](rank-history-ui.md) and [schedule contract](rank-schedule-ui.md). Both used CLI **2.1.1**, `kimi-code/k3-256k`, explicit thinking and maximum effort, with only Ponytail and UX Copy Refiner skill calls. Observed durations were **264.183 seconds** and **582.7 seconds**; the schedule task completed within its 600-second deadline. The eight-step and two-attempt bounds remained active. No K3 speed mode, model substitution, shell, filesystem or network tool was enabled for the drafter.

Automatic approval review rejected the first history attempt because its unpublished interface contract was classified as internal. That attempt did not launch. GPT reviewed the original contract for private data, published it under the owner's existing public-repository authorization, and verified that the local task input matched the unauthenticated public text before the approved retry. The schedule contract likewise matched its published source before invocation. No private logs, account data, credentials or implementation files were supplied to either leaf.

GPT reviewed the drafts, owns their authorization/retry/navigation controllers and independent acceptance, and corrected schedule consent gating and reading order. Routine leaf authorship does not establish feature completion. Token counts, quota deltas, provider-resolved effort and savings remain unmeasured; runner duration is not provider latency. Detailed capability and test evidence is in [rank tracking](rank-tracking.md).
