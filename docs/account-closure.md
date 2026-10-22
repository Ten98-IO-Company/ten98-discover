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

- **Last owner.** The account is the only owner of a workspace. Transfer ownership of each listed workspace to another member first (workspace deletion is not yet available; see #292). The confirm screen links to each workspace's team settings. The 409 answer lists the id and name of each such workspace, so an operator closing another account also sees the names of the workspaces that account solely owns. (This foundation has no workspace deletion yet, so transfer is the available path.)
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

Owner decisions (ten98-code-system#39): financial rows are kept **7 years**; audit rows **7 years or until workspace deletion, whichever ends first**. Every kept table that names an account has a retention class in `src/server/account-closure-inventory.ts` (`retention`), with its account columns and a reason:

| Class | Tables | Rule for rows that name a closed account |
|---|---|---|
| Financial | Receipts and the paid-work and uncertain-charge ledgers: `provider_request`, every `*_quote` and paid `*_run`, `prompt_comparison`, `prompt_occurrence`, `saved_keyword_refresh_plan`, `rank_run`; ledger dependents without an account column (`prompt_execution`, `prompt_comparison_item`, `rank_dispatch`, `rank_task`) go with their parent | Kept 7 years from `created_at`, then deleted. They hold no personal data and must survive workspace deletion. A receipt that is still reserved, dispatched or uncertain never ages out, and neither does the work that references it, so reconciliation evidence stays. |
| Audit | `account_closure_audit`, `instance_operator_audit` | Kept 7 years from `created_at`, or until workspace deletion if earlier. The closed subject (`user_id`) alone decides, even when the actor is an open account. These two tables are instance-level, so only the 7 years applies to them today. |
| Workspace | Authored content (`project_share`, `tracking_revision`, `analytics_annotation`, `context_*`, `prompt_text_version`), live schedules (`prompt_tracker`, `rank_config`), non-paid work (`domain_redirect_check`, `site_audit_run`, `google_import`) and edit receipts (`board_share_request`, `custom_board_request`, `tracked_asset_request`, `project_deletion_request`) | Kept as long as the workspace; not aged out. The edit receipts are idempotency records of non-paid workspace edits, not paid-work receipts, and have no `created_at` to count 7 years from. |

- **Daily job.** The worker schedules the pg-boss job `account-closure-retention` at 03:17 UTC (`src/server/account-closure-retention.ts`). It deletes rows older than 7 years: a financial row when every account column names a closed account (a row that also names an open account stays), an audit row when its subject is closed, even if an open operator performed the action. Rows are picked oldest first, 1,000 per table per batch and at most 20,000 rows per run, each batch in one transaction under a 30-second statement timeout; the rest waits for the next run. Rows of the same ledger entry are deleted together, and a row that any retained row still references (for example a keyword run used as a saved keyword's metric source) stays. The foreign-key graph is read from the database catalog, so a new reference keeps rows rather than failing.
- **Tombstones.** After the ledger pass, the job deletes closed `user` rows that no row references any more: no foreign key and no declared account column (including the account's own `account_closure_audit` row until it ages out). The `keep_closed_account` trigger refuses updates only, so deletion needs no migration. A tombstone named by workspace content stays with that content.
- **Run record.** Each run's per-table counts, tombstone count and whether the cap was reached are the job's output in `pgboss.job` (no account ids or personal data), and the worker logs one summary line.
- **Workspace deletion.** Discover has no workspace deletion yet ([#292](https://github.com/Ten98-IO-Company/ten98-discover/issues/292)). Kept workspace-scoped rows reach `workspace` through `ON DELETE CASCADE`, except `ai_suggestion_run`, `google_import`, `prompt_comparison`, `prompt_occurrence`, `prompt_tracker`, `rank_config` and `rank_run`, which website deletion (`src/server/project-delete.ts`) deletes explicitly. Financial rows must survive workspace deletion, so when it is built it must **tombstone the workspace** (keep its id, scrub its name and other personal fields) instead of deleting the row they cascade from, and keep the explicitly deleted financial tables. Audit and workspace-class rows may go with the workspace.
- **Known gap.** Website deletion (`src/server/project-delete.ts`) currently deletes the financial tables `ai_suggestion_run`, `prompt_comparison`, `prompt_occurrence` and `rank_run`. The fix is planned with the workspace tombstone of [#292](https://github.com/Ten98-IO-Company/ten98-discover/issues/292).
- **Checks.** `tests/closed-account-retention.test.ts` (in `pnpm test`) fails when a kept table that names an account has no class, an account column is missing, a financial or audit table lacks `created_at`, or a new table references an aged-out table without review; it also checks the batch SQL builder. `tests/account-closure-retention.test.ts` checks the workspace cascades and lists the financial tables a workspace tombstone must preserve. `tests/closed-account-retention-integration.ts` (registered in `tests/integration.ts`, isolated synthetic PostgreSQL only) seeds backdated rows and checks that only a closed account's aged ledger and audit rows go (including an operator closure audit whose actor is open), receipts under reconciliation, recent rows and open accounts' rows stay, a tombstone goes only once unreferenced, and capped runs stay within the cap.

## Privacy notice

Owner-approved wording (ten98-code-system#39), shown verbatim in the self-closure confirm step and the identity-provider **Close account permanently** action (`closurePrivacyNotice` in `src/components/AccountClosurePanel.tsx`):

> Closing your account. When you close your account, we delete your password, sign-in methods, two-factor settings, sessions and API keys, and remove your name, email address and picture. You are removed from every workspace. What you created in a workspace stays with that workspace and shows 'Closed account' as its author. We keep some records without your personal details: receipts and records of paid work and charges for 7 years from when each was created, even if the workspace is later deleted, because we must keep them for accounting and tax; and audit and security records for 7 years from when each was created or until the workspace is deleted, whichever comes first. We do not currently keep backups of account data. You can sign up again with the same email address as a new account; a closed account cannot be restored.

**Revisit:** update the backup sentence ("We do not currently keep backups of account data.") before backups are enabled for real users. Add passkeys back to this sentence when passkey sign-in ships.

## Verification

- `tests/account-closure-inventory.test.ts` (in `pnpm test`): inventory coverage, rule implementation and parser behaviour.
- `tests/account-closure-retention.test.ts` (in `pnpm test`): kept workspace-scoped tables cascade from `workspace`, with the listed exceptions.
- `tests/account-closure-integration.ts` (registered in `tests/integration.ts`, isolated synthetic PostgreSQL only): seeds an account with sessions, two-factor, an API key, a verification row, invitations, a queued job, session IP and user agent, a co-owned workspace and a share link, then checks the refusals roll back fully, operator closure needs authority, step-up and a reason, concurrent membership, session, API key and preference inserts wait for an uncommitted closure and are refused after it commits, the scrub and tombstone, intact financial rows, refused sign-in, sessions, API key and MCP, and the share link.
- `tests/migrations-integration.ts` covers the 0069-to-0070 upgrade: no backfill, every account stays open, the triggers and the tombstone check.
