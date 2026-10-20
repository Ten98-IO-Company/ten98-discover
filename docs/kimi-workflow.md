# Kimi-first development

> Code and safety contracts retained from [docs/kimi-workflow.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/kimi-workflow.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/kimi-first-development-implementation-history-72DK8lZMWu). Qualifications are preserved; this adds no acceptance claim.

GPT owns planning, design, complex work, testing after completion, and final signoff. Kimi handles routine, bounded execution wherever useful: implementation against GPT-approved specifications, test implementation, documentation, and evidence extraction. Kimi does not make authoritative planning/design decisions or validate its own work for acceptance. This allocation targets lower Astra usage; savings must be measured, not assumed. V1 still requires the complete agreed feature-parity matrix across Elmo, Umami, and OpenSEO; internal milestones do not reduce public V1 scope.

## CLI installation guardrail

- The Python `kimi-cli` project is archived; do not install its legacy PyPI package. [Legacy changelog](https://moonshotai.github.io/kimi-cli/en/release-notes/changelog.html)

## Install and authenticate

Install the native CLI using the [official instructions for your environment](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html). The application has no Kimi runtime dependency. Verify the installation before use:

```sh
kimi --version
kimi doctor
```

Inside the CLI, run `/login` and complete Kimi Code OAuth in the browser. Kimi Platform API-key login is an alternative. The user completes authentication; keys and tokens never enter this repository or task output. For later updates use `kimi upgrade`, then verify the installed version again. [Official getting-started instructions](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html)

## Select and verify K3

Use the verified alias **`kimi-code/k3-256k`**. On another installation inspect `/model` and `/status` first; CLI `-m` expects a configured alias.

The official IDs are `k3-256k` and `k3`. K3 requires Plus/Moderato or above; 1M context requires Pro/Allegretto or above. The fixed 256K variant is the default for bounded tasks because 1M K3 consumes approximately twice its quota. Keep thinking enabled: disabling it routes K3 requests to K2.8 Preview. The owner requested **maximum effort**, so set the supported process override `KIMI_MODEL_THINKING_EFFORT=max`. Keep effort stable within a session. The currently documented HighSpeed model is **K2.7**, with approximately 6× speed and 3× quota use; it is not a K3 speed switch and was not substituted. Reverify capabilities and entitlements before changing models. [Official model configuration](https://www.kimi.com/code/docs/en/kimi-code/models), [environment overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars)

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

The default repository profile, [`agents/kimi-text-only.md`](../agents/kimi-text-only.md), declares `tools: []` and `subagents: []`. It can transform supplied public text only. Custom agent allowlists are enforced by the CLI; prompts alone are not a sandbox. Filesystem or shell tools require the isolated worker specified under [Budget, boundaries, and escalation](#budget-boundaries-and-escalation). No orchestration framework or default background automation is planned. [Agent documentation](https://moonshotai.github.io/kimi-code/en/customization/agents.html)

The [Skill-only profile](../agents/kimi-skill-drafter.md) permits only reviewed Markdown skills and approved public inputs. Tool profiles supplement isolation; they do not provide it. The repository provides no automated drafting launcher. Automated text-only or Skill-only drafting requires a reviewed platform-neutral runner that verifies the CLI/model, thinking and maximum effort, rejects unreviewed instructions/configuration/hooks, creates a clean task directory, captures output privately, and enforces a numeric deadline by stopping only its own process tree. Do not bypass these checks with a direct print-mode command. Use fresh native workers for coding under the contributor gates.

## Run one bounded task

1. GPT defines the requirement, design, file allowlist, acceptance checks, verified model/effort, numeric deadline, and available usage allowance. Missing usage counters do not remove the deadline.
2. For text-only or Skill-only drafting, supply only approved public inputs through a reviewed bounded runner. Kimi returns draft text; GPT applies it after review.
3. Filesystem writes and command execution require the separately verified isolated worker below. Only that worker may implement files or run its allowed checks; no new dependency without GPT review.
4. GPT independently tests completed work and reviews the diff.
5. GPT accepts or requests repair. After two failed repair attempts, stop and return the minimal diff, failing check and unresolved decisions to GPT.

The text-only profile was used for the earlier supervised planning tasks recorded in the [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/kimi-first-development-implementation-history-72DK8lZMWu). Those records do not authorize an unbounded launcher or tool access.

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

A restricted tool profile alone must not be described as proof that all implicit CLI context is isolated. File-writing Kimi work remains blocked until the separate operating-system isolation below is verified.

- Before each batch record task ID, CLI/model/effort, verified available allowance, start usage, and time. Set a numeric ceiling from verified figures when available; otherwise use an explicit task/time cap. No invented quota percentage allocation.
- Afterward record usage delta, elapsed time, accepted/reworked result, and Astra review usage if available. Separate tokens from quota units. Mark missing measurements unknown; do not infer per-task tokens from account-wide percentages.
- Compare accepted requirements per Kimi quota unit and Astra review consumption across milestones. Keep only a compact ledger in issue/PR notes; no telemetry service or budgeting script.
- Checkpoint at the agreed ceiling, two unsuccessful repair attempts, or a material decision. GPT receives the failing check, minimal diff, competing options, and Kimi's recommendation; Kimi does not decide acceptance.
- Never transmit private deployment documents, `.env` files, credentials, tokens, database dumps, raw production logs, customer data, or unrelated workspace content. Use sanitized lessons already approved for the public plan. A working directory is not an isolation guarantee.
- Coding requires a dedicated unprivileged worker with only the approved task checkout mounted, explicit file/command allowlists, and network restrictions appropriate to the task. No host-home/private-repository mounts, Docker socket, `.ssh`, `.env`, production access, publishing credentials, accounts, pushes, or deployments. Keep only necessary Kimi OAuth credentials in a separate protected worker location outside the checkout.
- Do not add private repositories via additional directories, MCP, or copied history. Do not commit CLI config, sessions, debug exports, or logs. Workspace prompts and CLI permissions supplement isolation; they do not replace it. The application runtime has no Kimi dependency.
- Owner authorization, 2026-10-14: exhausted Kimi seven-day quota triggers automatic GPT6 takeover of bounded routine implementation. Do not wait for the reset or ask for confirmation again. Report the handoff and retain the approved design, scope, file allowlist, public-input/publication restrictions, security boundaries and independent validation. Do not purchase usage or retry around the quota denial. Account-wide usage reports are not verified per-task measurements. Other model failures still follow the existing bounded checkpoint/handoff rule; user-visible function ambiguity goes to the user before implementation.
