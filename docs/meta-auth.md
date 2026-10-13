# Meta account connection and deletion lifecycle

This document describes the native Meta Ads authorization boundary and its
schema 26 report-lifecycle hooks. Report execution and scheduling acceptance are
tracked separately in [Meta reports](meta-reports.md); a browser pixel grants no
reporting authority. Provider approval, supported API
version and operational release gates remain in that contract. No provider
approval or live-account acceptance is implied by synthetic tests.

## Registration and access

An instance operator registers the Meta app ID, Login for Business configuration
ID, secret, declared development/live mode and enabled state. Workspace ownership
does not grant operator access. There is one active registration for new consent;
previous registrations remain addressable for signed deletion callbacks and
verifier rotation. Registration IDs are local UUIDs, distinct from Meta app IDs.
App fields cannot select a provider hostname or callback origin.

The configured application origin must use HTTPS. Only isolated local tests can
exercise the transport over a loopback application origin. Redirect and deletion
URLs are generated from `APP_URL`. Moving or restoring an installation disables
consent until the operator re-enables the registration for its current origin.

The encrypted app envelope contains its secret and an independently generated
32-byte subject HMAC key. Same-app secret rotation and vault re-encryption preserve
that key. A separate credential revision binds the envelope; disabling or switching
the registration increments authorization revision without making its deletion
verifier unreadable. A different Meta app has a different registration and key.
The service never stores a plain Meta user ID in its grants or deletion receipts.

The operator can page through retained registrations and select one for revision
review. Saving requires an explicit `activate` boolean: false preserves the
registration's current active/inactive state, while true deliberately switches
the installation's active registration. Rotating an inactive verifier therefore
does not switch new consent to that app. Deleting verifier rows is not exposed: doing so requires a
separate lifecycle decision covering outstanding deletion obligations.

An operator-only exact `appId` lookup can recover a new registration after its
save acknowledgement is lost, without scanning every registration page. It is
mutually exclusive with `registrationId`; a valid missing app ID returns selected
registration `null` in a freshly authorized metadata envelope. This is a snapshot,
not proof that the earlier secret was or was not saved.

## Consent and account selection

Only a current workspace owner may connect, inspect accounts, select an account,
reconnect or disconnect. Current workspace members can read the secret-free list.
The source list is paged in batches of 50 with a project-bound, microsecond-precise
cursor; this is a response bound, not a lifetime source cap.

1. An explicit start records a ten-minute flow bound to local user, live login
   session, project/workspace, app authorization revision, optional connection
   revision, and the current deletion epoch. Random state and an HttpOnly,
   SameSite=Lax callback cookie are stored only as hashes.
2. The returned URL points at the fixed supported Facebook authorization endpoint.
   An acknowledgement lost after start requires an explicit new attempt. Reusing
   that start request ID returns a restart-required conflict; it does not invent a
   replayable URL whose browser secret was discarded.
3. The callback claims the pending flow once, then releases SQL locks before code
   exchange, long-lived token exchange, token inspection and permission checks.
   It requires the correct app, a valid USER token, `ads_read`, and a positive
   response-derived access deadline. A missing or zero data-access deadline is
   unknown rather than unlimited.
4. Publication reacquires the registration, workspace and project gates, then
   rechecks live owner/session, app and connection revisions, flow ownership,
   expiry and deletion fence. An unrelated callback cannot fail an exchange it
   did not claim. Provider errors produce a fixed application redirect without
   returning provider text, codes, tokens or arbitrary navigation.
5. The owner explicitly lists accounts or checks a known account ID. Provider
   paging URLs never become request authority: only an encrypted, actor/source/
   revision-bound cursor is accepted and fixed routes are reconstructed. Each
   response is bounded to 100 accounts. A final page means this discovery stream
   ended; it is not proof that every business asset was discoverable.
6. A direct check returns a preview without saving. Selection requires another
   explicit mutation and validates the account's exact ID, currency, time zone
   and status. The connection captures one account; reconnect must prove access
   to that same account. A different account needs a different source.

When the data-access deadline is unknown, every account operation first performs
a fresh token and permission inspection. For a known positive deadline, the
stored deadline, registration and grant gates apply. This slice does not silently
renew tokens or treat an expired grant as usable. A shorter deadline learned by
fresh inspection also fences the ensuing account response; a slow response cannot
outlive that new bound while relying on the older stored grant deadline.

All network waits happen outside database transactions. Account responses are
released only after a fresh owner and revision check. Lock order is registration
before workspace, project, connection and flow. Read-only lists use the existing
repeatable-read membership snapshot; they do not promise revalidation after every
concurrent commit.

## Durable acknowledgements and disconnect

Account selection and disconnect use the existing project request receipt. Its
hash includes the actor and exact submitted body. A changed actor, operation or
body with the same request ID conflicts. Selection replay is checked before any
provider lookup or vault decryption and returns an immutable acknowledgement
separately from the current connection state:

```ts
{
  role: 'owner',
  acknowledgement: { requestId, connectionId, selectedAccountId, revision },
  connection: currentConnection,
  replayed: boolean
}
```

The receipt stores only connection ID and acknowledged revision. The account ID
in an acknowledgement comes from the same-input-validated request, so generic
receipts do not retain provider account identifiers after data deletion. A later
disconnect, reconnect or deletion cannot be mistaken for the original saved state.

Disconnect commits local token erasure first. Optional provider revocation happens
once afterward and returns `confirmed`, `unconfirmed` or `not_requested`.
Unreadable credentials and provider failure cannot undo local removal. A fresh
owner check follows the remote response before recording or returning its outcome.
Lost acknowledgement retries return the stored outcome without sending revocation
again. The response includes an exact immutable acknowledgement of request ID,
connection ID, submitted revision and the provider-revocation choice. Local removal
is distinct from a provider-signed data deletion request.

## Four-table provenance and deletion fence

Migration `0025_meta_auth.sql` adds only:

| Table | Purpose |
| --- | --- |
| `meta_app_registration` | Versioned operator registration and encrypted verifier/key |
| `meta_connection` | Current project source, selected account and encrypted user token |
| `meta_oauth_flow` | Pending consent or minimal immutable successful grant receipt |
| `meta_deletion_request` | Signed-payload receipt, monotone fence and local cleanup status |

Completed flows clear browser/state/session hashes and temporary source names.
They retain registration, pseudonymous subject, grant epoch, project, connection
and grant timestamps. Reconnect replaces the connection's current grant pointer
without deleting prior grant provenance. Schema 26 report imports bind their own
immutable grant ID, connection, project and workspace through a composite foreign
key. They never infer historical provenance from the connection's latest pointer.
Expired unsuccessful flows may be deleted in batches of 100; successful receipts
are never ordinary flow-TTL cleanup. Local user deletion is explicitly restricted
until a user lifecycle safely handles pending flows and retained provenance.

Signed deletion admission verifies with the current secret even for an inactive
or disabled registration. Only then does it look up the stable encoded-payload
digest. First admission atomically advances the registration's epoch and stores
the receipt. Re-signed identical payload replay returns that same receipt without
a new fence. Covered old grants are blocked immediately, before physical cleanup.
Pending cleanup also blocks new publication for that subject.

Cleanup takes the registration gate without needing vault keys, then workspace,
project and connection gates. It clears covered grant metadata and only clears a
connection token/account when that covered grant is still its current grant.
It therefore cannot erase a later independently consented grant or another
subject's token. Completion must check remaining covered payloads, rather than
assuming an invalidation timestamp proves cleanup.

After local cleanup, a new consent captures the current epoch. Replaying an old
signed payload cannot invalidate it. Different signed payloads are distinct
requests. Receipt and confirmation capabilities do not disclose user, workspace,
account, project or historical grant identifiers to the public status reader.

Schema 26 extends the same completion predicate to every covered import, including
reports whose grant was already invalidated or whose ordinary retention cleanup
left residual pages. One batch fences one import and removes at most five pages;
it does not declare completion while another covered import still holds data.
The tombstone clears captured source metadata, provider report ID, cursor, warning
payload and lease. Terminal outcome/count receipts and immutable grant links stay
retained. A live import becomes denied; an expired completed import keeps its
original outcome and timestamps. A newer grant under the same or a replacement
app is not erased by the old grant's callback.

`local_deleted` means covered connection and report payloads in this application's
current storage have been cleaned. It does not certify removal from operator
backups or Meta. Backup retention, restores and deletion obligations remain an
operator release gate; this implementation invents no automatic backup deletion
or provider-specific deadline.

## Integration exports

`meta-auth.ts` exports operator `getMetaApp`, `saveMetaApp`, `disableMetaApp`;
project `listMetaConnections`, `getMetaConnection`, `startMetaConnect`,
`listMetaAccounts`, `inspectMetaAccount`, `selectMetaAccount`, `disconnectMeta`;
and the bounded `metaCallback(Request)` redirect handler. HTTP wiring owns exact
Origin checks, body/rate limits, cookie headers and `no-store` responses.

Callback-only helpers are `withMetaRegistration`, `metaSubjectHash`,
`metaDeletionContext` and `assertMetaGrantAllowed`. They are not public endpoints.
Report workers reuse `prepareMetaReportSource`, `withMetaReportSource` and
`inspectMetaReportSource`. The private snapshot holds credentials in worker memory,
never in a job or browser DTO. Every publication gate locks registration → workspace
→ project → connection before the import lease, and checks current owner, ready
account, app/connection revisions, original grant and signed-deletion fences.
Unknown data-access expiry triggers fresh inspection, with the caller's lease and
deadline check before each request. All network waits occur outside SQL locks.
Historical reads instead require current project membership and the immutable
grant's deletion fence; disconnect or unavailable vault keys do not alone erase
retained reports. Signed deletion masks source metadata and rows before physical
cleanup. A keyless local gate can terminate unusable durable work without reviving
provider authority.
`expireMetaFlows` performs bounded unsuccessful-flow cleanup.
`assertMetaCredentialsReadable`, `rotateMetaCredentials` and
`quarantineMetaConnections` integrate readiness, offline vault rotation and
offline restore. Rotation/restore require all writers stopped. Worker startup
must still allow already-admitted keyless deletion cleanup when credentials are
unreadable; new authenticated provider activity fails closed independently.

The independent synthetic auth suite is `tests/meta-auth-integration.ts` with
`TEN98_INTEGRATION_TEST=1` and `TEN98_META_AUTH_TEST=1`, an empty migrated owned
loopback database named `ten98_meta_auth_*` on port 55501, configured test vault
and application origin. Hosted CI requires its explicit isolated-database guard.
It replaces every provider operation with a contained transport and rejects
unexpected global fetch. This document does not claim an unexecuted test passed.

## Local acceptance, 2026-10-13

Eight auth/API groups pass on a fresh PostgreSQL 18 database, including current
owner/session changes, deleted and newer grants, explicit inactive registration
rotation, exact durable acknowledgements and a held account response that
outlives a shorter newly inspected deadline. Eight separate callback/API/CLI
groups pass, including bounded 50-plus-4-grant cleanup, re-signed payload replay,
maximum revision cleanup, same-account/different-subject isolation and keyless
cleanup. All provider requests were contained synthetic responses.

The API exposes registration setup, owner connection/account operations and the
signed deletion/status routes. Session-bound writes require the exact application
Origin; API keys cannot access these routes. Public signed deletion is admitted
before browser CSRF checks and has its own strict form/body/rate bounds.
Readiness and diagnostics check Meta vault readability. Offline rekey preserves
subject keys and confirmation capabilities; restore quarantine disables apps and
pending flows. The worker performs bounded local deletion and unsuccessful-flow
expiry without overlapping those tasks. `cli.ts meta-cleanup` remains available
without vault keys for already-admitted deletion receipts.

Protected connection and operator setup are available through the application
navigation. The connection controller passes 13 browser groups and its pure view
passes seven; the operator controller and pure view each pass seven. Production
build, typecheck and all 12 application navigation groups pass, including exact
callback-family routing, held-response scope changes and forbidden operator views.
Real empty-source and operator-readiness screens pass desktop/mobile checks
against an isolated database without outbound requests. App-ID metadata recovery
also passes the auth/API suite. These results describe the auth checkpoint;
the later [manual import implementation](meta-reports.md) has separate acceptance.

Seven independent report-authorization PostgreSQL groups pass for ready-source,
role, account, revision, expiry and deletion gates. Migration 26 and the extended
cleanup pass the existing eight callback/API/keyless-CLI groups and six additional
report-deletion groups on separate fresh databases. These cover composite scope
constraints, late-transaction rollback, eleven-page bounded erasure, expired
residual pages, stale leases, prior invalidation, old callback replay and a
replacement app's preserved source. No provider requests were made. Import
execution and its interface require their separate acceptance; these checks are
not a live Meta report or provider compliance certification.

The original-install upgrade test also passes through migration 26 on a fresh
isolated database. Original credentials, sessions and project data, existing
feature records and the encrypted provider identity capsule survive; repeated
migration is idempotent. Invalid migration histories and a failing SQL batch
still reject or roll back without admitting partial schema changes.
