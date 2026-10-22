/**
 * Account closure inventory (docs/account-closure.md): every table and column that can hold a dashboard account's
 * personal data, credentials or identity, with the rule closure applies. tests/account-closure-inventory.test.ts
 * replays the migrations and fails when a table with a user reference or a personal-data-like column has no entry,
 * so a new table needs an explicit decision here before it can ship.
 *
 * Rules: `delete` removes the rows; `scrub` rewrites only the listed fields and keeps the row; `cancel` stops pending
 * work; `tombstone` is the user row itself; `keep` leaves the row unchanged for the stated reason.
 *
 * Statements run in array order inside the closure transaction, after the account, its workspaces, memberships and the
 * operator set are locked. `params` names each placeholder in order: the account id, its previous email (lowercase) or
 * the request-limit keys derived from that email. Nothing here stores, hashes or returns the previous email.
 */
export type ClosureRule = 'delete' | 'scrub' | 'cancel' | 'tombstone' | 'keep';
export type ClosureParameter = 'userId' | 'email' | 'emailLimitKeys';
export type ClosureInventoryEntry = {
  /** Table name as declared in migrations; pg-boss tables are named with their schema. */
  readonly table: string;
  readonly rule: ClosureRule;
  /** Columns that reference the account or can hold personal data or credentials. */
  readonly columns: readonly string[];
  readonly reason: string;
  /** Applied by the closure transaction; absent for `keep` and for steps account-closure.ts performs in code. */
  readonly sql?: string;
  readonly params?: readonly ClosureParameter[];
};

const keepActor = 'Names the account only as the actor of workspace-billed or audited work; the id now resolves to the "Closed account" tombstone and the row holds no personal data.';
const keepWorkspace = 'Workspace-owned label, setting, hash or visitor measurement, not dashboard account data; workspace retention governs it.';

export const accountClosureInventory: readonly ClosureInventoryEntry[] = [
  // Credentials and sign-in state.
  { table: 'verification', rule: 'delete', columns: ['identifier', 'value'],
    reason: 'Sign-in challenges, trusted devices, reset tokens, used-code ledger rows and any row keyed by the previous email; dependent attempt counters and identity challenge bindings go with them.',
    sql: `WITH own AS (DELETE FROM verification WHERE value=$1::text OR identifier LIKE 'totp-used:' || $1::text || ':%'
        OR lower(identifier)=$2::text OR right(lower(identifier),length($2::text)+1)=':' || $2::text OR lower(value)=$2::text RETURNING identifier)
      DELETE FROM verification WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM own)
        OR identifier IN (SELECT 'oidc-challenge:' || identifier FROM own)`, params: ['userId', 'email'] },
  { table: 'request_limit', rule: 'delete', columns: ['key'],
    reason: 'Rate-limit counters keyed by the account id, its API key ids or an unkeyed digest of the previous email (derivable from the address). Shared and client-address keys are not tied to the account.',
    sql: `DELETE FROM request_limit WHERE position($1::text IN key)>0 OR key=ANY($2::text[])
      OR key IN (SELECT 'api-key:' || id FROM api_key WHERE issuer_user_id=$1)`, params: ['userId', 'emailLimitKeys'] },
  { table: 'oidc_transaction', rule: 'delete', columns: ['user_id'], reason: 'Pending identity link, test or re-verification flows started by the account.',
    sql: 'DELETE FROM oidc_transaction WHERE user_id=$1', params: ['userId'] },
  { table: 'google_oauth_flow', rule: 'delete', columns: ['user_id', 'name'], reason: 'Pending reporting-connection authorizations started by the account.',
    sql: 'DELETE FROM google_oauth_flow WHERE user_id=$1', params: ['userId'] },
  { table: 'workspace_invitation', rule: 'delete', columns: ['inviter_id', 'email', 'token_hash'],
    reason: 'Pending invitations sent by the account (their grant ends with its memberships) or addressed to its previous email.',
    sql: 'DELETE FROM workspace_invitation WHERE inviter_id=$1 OR email=$2', params: ['userId', 'email'] },
  { table: 'api_key', rule: 'delete', columns: ['issuer_user_id', 'name', 'token_hash'], reason: 'Every API key the account issued is revoked by deletion; MCP sessions use the same keys.',
    sql: 'DELETE FROM api_key WHERE issuer_user_id=$1', params: ['userId'] },
  { table: 'session', rule: 'delete', columns: ['token', 'userId', 'ipAddress', 'userAgent'], reason: 'All sessions, with their IP address and user agent.',
    sql: 'DELETE FROM session WHERE "userId"=$1', params: ['userId'] },
  { table: 'account', rule: 'delete', columns: ['userId', 'accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'],
    reason: 'Password hash and any provider tokens.', sql: 'DELETE FROM account WHERE "userId"=$1', params: ['userId'] },
  { table: 'twoFactor', rule: 'delete', columns: ['userId'], reason: 'Authenticator secret and recovery codes.', sql: 'DELETE FROM "twoFactor" WHERE "userId"=$1', params: ['userId'] },
  { table: 'oidc_identity', rule: 'delete', columns: ['user_id'], reason: 'Identity provider links (issuer and subject).', sql: 'DELETE FROM oidc_identity WHERE user_id=$1', params: ['userId'] },
  { table: 'user_preference', rule: 'delete', columns: ['user_id'], reason: 'Time zone, language and theme.', sql: 'DELETE FROM user_preference WHERE user_id=$1', params: ['userId'] },
  { table: 'import_probe', rule: 'cancel', columns: ['user_id'],
    reason: 'Queued worker checks the account started are marked denied and their queue jobs cancelled (account-closure.ts); finished rows stay as actor history.' },
  { table: 'pgboss.job', rule: 'cancel', columns: ['data'],
    reason: 'Only setup-probe jobs belong to the account and are cancelled with their probe. Other job payloads hold workspace record ids only; paid work keeps running under its workspace Start (D3), and owners can still cancel undispatched reservations. No email outbox exists: invitation and reset emails are sent once in process.' },
  { table: 'membership', rule: 'delete', columns: ['user_id'], reason: 'Every workspace membership; the last-owner rule is checked first.',
    sql: 'DELETE FROM membership WHERE user_id=$1', params: ['userId'] },
  { table: 'instance_operator', rule: 'delete', columns: ['user_id'], reason: 'Instance operator role; refused for the last operator, and the revocation is audited.',
    sql: 'DELETE FROM instance_operator WHERE user_id=$1', params: ['userId'] },
  { table: 'rateLimit', rule: 'keep', columns: [], reason: 'Unused: the library limiter is disabled and the table holds no account key.' },
  { table: 'user', rule: 'tombstone', columns: ['name', 'email', 'emailVerified', 'image', 'twoFactorEnabled', 'closed_at'],
    reason: 'The row stays so actor references remain valid: name "Closed account", email closed-<random uuid>@invalid with no hash of the old address, no image, unverified, no second factor, closed_at set. Triggers keep it final.' },
  { table: 'instance_operator_audit', rule: 'keep', columns: ['user_id'], reason: 'Role audit names only the account id; no email, IP address or user agent is stored.' },
  { table: 'account_closure_audit', rule: 'keep', columns: ['user_id', 'actor_user_id'], reason: 'The closure security event: account ids, kind and an operator reason only.' },

  // Shares and authored workspace content stay with the workspace; the creator id shows as "Closed account".
  { table: 'project_share', rule: 'keep', columns: ['token_hash', 'created_by'], reason: 'Workspace-owned share; access never resolves through the creator, and listings show the tombstone name.' },
  { table: 'tracking_revision', rule: 'keep', columns: ['created_by'], reason: keepActor },
  { table: 'analytics_annotation', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'context_competitor', rule: 'keep', columns: ['name', 'updated_by'], reason: keepActor },
  { table: 'context_key_page', rule: 'keep', columns: ['updated_by'], reason: keepActor },
  { table: 'context_research', rule: 'keep', columns: ['created_by'], reason: keepActor },
  { table: 'context_section', rule: 'keep', columns: ['updated_by'], reason: keepActor },
  { table: 'prompt_text_version', rule: 'keep', columns: ['created_by'], reason: keepActor },
  { table: 'board_share_request', rule: 'keep', columns: ['actor_id'], reason: keepActor },
  { table: 'custom_board_request', rule: 'keep', columns: ['actor_id'], reason: keepActor },
  { table: 'tracked_asset_request', rule: 'keep', columns: ['actor_id'], reason: keepActor },
  { table: 'project_deletion_request', rule: 'keep', columns: ['actor_id'], reason: keepActor },

  // Financial and paid-work rows: kept unchanged (workspace-billed, no personal billing data).
  { table: 'provider_request', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'keyword_quote', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'keyword_research_run', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'saved_keyword_refresh_plan', rule: 'keep', columns: ['user_id', 'connection_name'], reason: keepActor },
  { table: 'prompt_execution_quote', rule: 'keep', columns: ['user_id', 'request_actor'], reason: keepActor },
  { table: 'prompt_comparison', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'prompt_occurrence', rule: 'keep', columns: ['user_id', 'requested_by'], reason: keepActor },
  { table: 'prompt_tracker', rule: 'keep', columns: ['name', 'approval_user_id'], reason: keepActor },
  { table: 'rank_config', rule: 'keep', columns: ['name', 'location_name', 'language_name', 'approval_user_id'], reason: keepActor },
  { table: 'rank_run', rule: 'keep', columns: ['user_id', 'connection_name'], reason: keepActor },
  { table: 'ai_suggestion_quote', rule: 'keep', columns: ['user_id', 'request_actor'], reason: keepActor },
  { table: 'ai_suggestion_run', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'ai_search_quote', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'ai_search_run', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'ai_content_support_quote', rule: 'keep', columns: ['user_id', 'request_actor'], reason: keepActor },
  { table: 'ai_content_support_run', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'domain_research_quote', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'domain_research_run', rule: 'keep', columns: ['user_id'], reason: keepActor },
  { table: 'domain_redirect_check', rule: 'keep', columns: ['user_id', 'hostname'], reason: keepActor },
  { table: 'site_audit_run', rule: 'keep', columns: ['user_id', 'domain_hostname'], reason: keepActor },
  { table: 'google_import', rule: 'keep', columns: ['user_id'], reason: keepActor },

  // Workspace labels, hashes and website-visitor measurement: not dashboard account data.
  { table: 'workspace', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'project', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'project_context', rule: 'keep', columns: ['brand_name'], reason: keepWorkspace },
  { table: 'project_domain', rule: 'keep', columns: ['hostname'], reason: keepWorkspace },
  { table: 'provider_connection', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'google_connection', rule: 'keep', columns: ['name', 'encrypted_tokens', 'property_name'],
    reason: 'Workspace-owned reporting connection; owners disconnect it. Member removal and closure leave it in service.' },
  { table: 'report_template', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'saved_keyword_tag', rule: 'keep', columns: ['name', 'normalized_name'], reason: keepWorkspace },
  { table: 'tracked_asset', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'analytics_cohort', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'analytics_segment', rule: 'keep', columns: ['name'], reason: keepWorkspace },
  { table: 'session_recording', rule: 'keep', columns: ['saved_name'], reason: keepWorkspace },
  { table: 'event', rule: 'keep', columns: ['event_name'], reason: keepWorkspace },
  { table: 'analytics_identity_link', rule: 'keep', columns: ['identity_token'], reason: keepWorkspace },
  { table: 'report_share', rule: 'keep', columns: ['token_hash'], reason: keepWorkspace },
  { table: 'board_share', rule: 'keep', columns: ['token_hash'], reason: keepWorkspace },
  { table: 'tracked_asset_share', rule: 'keep', columns: ['token_hash'], reason: keepWorkspace },
];
