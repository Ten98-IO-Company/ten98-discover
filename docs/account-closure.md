# Account closure

Code contract for closing a dashboard account, following the approved owner council decision (ten98-code-system#39): a **tombstone, not full erasure**. Implemented in `src/server/account-closure.ts` (`closeAccount`), `src/server/account-closure-inventory.ts` (the scrub inventory), the closure routes and host step-up in `src/server/account-security.ts`, migration `0070_account_closure.sql`, `src/components/AccountClosurePanel.tsx` and the **Close account permanently** action of `src/components/OidcRecoveryPanel.tsx`.

Closing ends the person's use of the installation. Workspaces keep their data, reports, share links and usage records; rows that name the account only as the actor of workspace work keep pointing at its id, which now shows as **Closed account**.

## Who can close an account

- **Self closure.** Account security → **Close account**. The confirm step lists the consequences (including that every API key the person issued is revoked), shows the [privacy notice](#privacy-notice), requires both acknowledgements and asks for step-up proof: the current password plus an authenticator or recovery code when two-factor authentication is on. Accounts without a local password close from **Identity sign-in**: verify with the linked provider (a fresh `prompt=login`, `max_age=0` sign-in whose `auth_time` is checked), choose **Close account permanently** as the security change, read the same privacy notice, tick the same two acknowledgements and enter a second-factor code when enabled. On success the browser is signed out and the sign-in page shows a neutral confirmation.
- **Operator closure.** An instance operator closes another account with their own step-up proof and a recorded reason (1–500 characters). The reason is stored in the audit row: describe the basis (for example "account holder request, ticket 123") and never include personal data such as names, addresses or the account's email. Operators close their own account through self closure. Do not run it against a real user without that person's request or another documented basis.
  - API: `POST /api/identity/accounts/:userId/close` with strict `{reason, proof: {password, code? | backupCode?}}` JSON, browser session and application origin. Operators without a local password add a recovery password first.
  - CLI: `docker compose run --rm -T web node src/server/cli.ts account close <account-email> --operator <operator-email> --reason "<text>"`, with the operator's step-up secret as one JSON object on standard input, for example from a protected file: `{"password":"…","code":"123456"}` or `{"password":"…","backupCode":"…"}`. The secret never goes in arguments or environment variables. The command signs the operator in through Better Auth inside the closure transaction, deletes that temporary session and prints no personal data.

Routes: `GET /api/account/closure` returns the blockers, whether a local password exists and whether two-factor authentication is on; `POST /api/account/closure` takes the self step-up proof. A refusal answers 409 with `{error, blockers: {workspaces: [{id, name}], lastOperator}}`.

## Refusals

Checked under lock, so a concurrent change cannot slip past them. A refusal rolls the whole transaction back: nothing changes, and a submitted recovery code is not consumed.

- **Last owner.** The account is the only owner of a workspace. Transfer ownership of each listed workspace to another member, or delete the workspace, first. The confirm screen links to each workspace's team settings. The 409 answer lists the id and name of each such workspace, so an operator closing another account also sees the names of the workspaces that account solely owns. (This foundation has no workspace deletion yet, so transfer is the available path.)
- **Last operator.** The account holds the only instance operator role. Grant the role to another account first (`operator grant`).

## One transaction

`closeAccount(client, userId, actor, proof)` runs inside the caller's transaction, after the caller verified `proof` for the actor:

1. Lock the account row, then its workspaces in id order, then its memberships, then the whole operator set (`SELECT … FOR UPDATE`). With the account locked, no new membership, session, credential, key or link can commit for it: the 0070 triggers lock the account row `FOR SHARE` with no condition on `closed_at`, wait for the closure, then read its committed `closed_at` and refuse. The preference save path also locks the account first and then finds its session gone.
   Some paths lock a workspace first and the account second (through the trigger or the foreign-key check on the account): the two-factor requirement toggle, API key creation, sending and accepting invitations, and starting a worker check. If one of them runs for the same account and workspace at the same moment as a closure, PostgreSQL detects the deadlock and aborts one of the two; nothing commits. An aborted closure answers 503 "… Nothing was closed. Try again." and is safe to retry.
2. Apply the refusals above.
3. Cancel the account's queued worker checks, run every inventory statement, audit an operator-role revocation, then tombstone the row.
4. Record one `account_closure_audit` event: target id, actor id, kind (`self` or `operator`) and the operator's reason. It stores no other personal data of the closed account.

## Inventory

`src/server/account-closure-inventory.ts` lists every table and column that can hold an account's personal data, credentials or identity, each with a rule. `tests/account-closure-inventory.test.ts` replays the migrations and fails when a column has no rule if it references the account (including schema-qualified or column-less references), is named like email, IP address, user agent, name, token, user id, actor, `*_by`, image, subject, issuer, password, credential, claims, value or secret, or is a JSON or free-text column of a table that references the account. A delete rule covers the whole row. A new table needs an explicit decision there before it ships.

| Rule | Tables | Why |
|---|---|---|
| Tombstone | `user` | Name `Closed account`; email `closed-<fresh random uuid>@invalid` (no hash of the old address is kept); image removed; email unverified; no second factor; `closed_at` set. A check constraint keeps the tombstone complete and a trigger makes it final. |
| Delete | `account`, `session` (with its IP address and user agent), `twoFactor`, `verification` (challenges, trusted devices, reset tokens, used-code ledger and rows keyed by the old email), `oidc_identity`, `oidc_transaction`, `google_oauth_flow`, `api_key`, `user_preference`, `membership`, `instance_operator`, `workspace_invitation` (sent by the account or addressed to its old email), `request_limit` (keys containing the account or key ids, and the unkeyed email digests `signin:`, `password-recovery:email:`, `invitation-email:`) | Credentials, sign-in state and personal settings. Rate-limit digests are derivable from the address, so they go. |
| Cancel | `import_probe` and its `setup-probe` jobs | Queued worker checks the account started are marked denied and their jobs cancelled. |
| Keep | Paid work and receipts: `provider_request`, every `*_quote`, `*_run`, `prompt_comparison`, `prompt_occurrence`, `prompt_tracker`, `rank_config`, `domain_redirect_check`, `site_audit_run`, `google_import`, `saved_keyword_refresh_plan` | Workspace-billed rows with no personal billing data; they name the account only as actor. Never rewritten. Queued paid work keeps running under its workspace Start (D3); owners can still cancel undispatched reservations. |
| Keep | Authored workspace content and receipts: `project_share`, `tracking_revision`, `analytics_annotation`, `context_*`, `prompt_text_version`, `*_request` actor receipts | Workspace-owned; the author shows as the tombstone. |
| Keep | `instance_operator_audit`, `account_closure_audit` | Security events naming account ids only. No audit table stores an email, IP address or user agent; the only IP and user-agent store is `session`, deleted above. |
| Keep | Workspace labels, hashes and website-visitor measurement (`workspace`, `project`, `event`, `analytics_*`, share token hashes, `google_connection`, …) | Not dashboard account data; workspace retention governs it. |

pg-boss payloads hold workspace record ids only. There is no email outbox: invitation and password-reset emails are sent once in process with no queue.

## After closure

- Sign-in, session lookup, OIDC sign-in and linking, API keys and MCP all refuse the account: its credentials, sessions, links and keys are gone, `authenticateApiKey` also requires an open account, and the 0070 triggers refuse any new session, credential, factor, link, key, membership, preference, invitation or operator role for it.
- Share links stay workspace-owned. Their public reads never resolve through the creator's membership, so links the person created keep working; owner and admin listings show the creator as `Closed account` with no address and a former-member marker.
- The tombstone is final: a trigger (`keep_closed_account`) refuses every update to a closed `user` row, including its `updatedAt`. A future migration that backfills or rewrites `user` columns must skip closed rows (`WHERE closed_at IS NULL`) or set any new column's value for them in a deliberate, reviewed step that disables and re-enables the trigger within the migration.
- The audit events and the tombstone row are kept.

## Retention

Owner decision (ten98-code-system#39): **as long as the workspace exists**. The anonymous rows a closed account leaves behind (its id on kept ledger, receipt, content and audit rows) are kept as long as the workspace they belong to, and go when that workspace is deleted.

- **Workspace-scoped rows.** Kept tables with a `workspace_id` or `project_id` column, or a parent that has one, reach `workspace` through `ON DELETE CASCADE` foreign keys, so deleting a workspace removes them. Discover has no workspace deletion yet, so today these rows persist with their workspace. Known exception: `ai_suggestion_run`, `google_import`, `prompt_comparison`, `prompt_occurrence`, `prompt_tracker`, `rank_config` and `rank_run` reach `project` only through `NO ACTION` foreign keys. Website deletion (`src/server/project-delete.ts`) already deletes them explicitly before the project row; workspace deletion must do the same ([#292](https://github.com/Ten98-IO-Company/ten98-discover/issues/292)).
- **The tombstone and instance-level audits.** The tombstone `user` row, `account_closure_audit` and `instance_operator_audit` are not workspace-scoped. The tombstone remains while any kept row references it, together with the audit rows naming it. Purging tombstones that nothing kept references any more is a follow-up ([#291](https://github.com/Ten98-IO-Company/ten98-discover/issues/291)).
- `tests/account-closure-retention.test.ts` (in `pnpm test`) replays the migrations and fails when a kept, workspace-scoped table loses its cascade to `workspace`, or when a listed exception is no longer deleted by website deletion.

## Privacy notice

Owner-approved wording (ten98-code-system#39), shown verbatim in the self-closure confirm step and the identity-provider **Close account permanently** action (`closurePrivacyNotice` in `src/components/AccountClosurePanel.tsx`):

> When you close your account we delete your name, email, sign-in methods, sessions and API keys. We keep an anonymous record of actions you took in a workspace, such as paid requests and audit entries, for as long as that workspace exists.

## Verification

- `tests/account-closure-inventory.test.ts` (in `pnpm test`): inventory coverage, rule implementation and parser behaviour.
- `tests/account-closure-retention.test.ts` (in `pnpm test`): kept workspace-scoped tables cascade from `workspace`, with the listed exceptions.
- `tests/account-closure-integration.ts` (registered in `tests/integration.ts`, isolated synthetic PostgreSQL only): seeds an account with sessions, two-factor, an API key, a verification row, invitations, a queued job, session IP and user agent, a co-owned workspace and a share link, then checks the refusals roll back fully, operator closure needs authority, step-up and a reason, concurrent membership, session, API key and preference inserts wait for an uncommitted closure and are refused after it commits, the scrub and tombstone, intact financial rows, refused sign-in, sessions, API key and MCP, and the share link.
- `tests/migrations-integration.ts` covers the 0069-to-0070 upgrade: no backfill, every account stays open, the triggers and the tombstone check.
