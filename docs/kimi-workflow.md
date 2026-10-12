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
