# M01 — Meta connections: saved sources before adding another

Public self-contained Kimi presentation brief. GPT design review, not fresh browser/provider acceptance. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"M1","replacement":"exact replacement text"}]}. One bounded draft, no other files. Supervising GPT applies and tests independently. Only approved Skill tools.

## Scope and traced flow

Only src/components/MetaConnectionView.tsx final known-role return M1 below may change. Everything outside M1 stays byte-identical: types/constants/destructuring/helpers/null-role return/final brace. No import, state, effect, helper, abstraction, CSS, dependency or API change. Reuse existing native row/field/card/stack/btn/hint primitives.

routes/index.tsx mounts MetaConnectionPanel keyed by user/workspace/project. That sole production caller supplies verified secret-free metadata/capabilities and owns heading focus, connection pagination and operator setup navigation. meta-api.ts dispatches to meta-auth.ts current-owner connect, discovery/inspect/select/disconnect. Freeze all callers. Fixtures are test-only callers. All prop names below except loaded are already destructured; existing locals: isOwner = role === 'owner'; writing = writeState !== 'idle'; busy = writing || reading; id = (suffix: string) => prefix + suffix; showConnections = mode === 'connections' || !isOwner. Null role returns before M1 with loading/error/Reload only. Do not add helpers.

Current problems: Add/setup precedes saved connections; source card actions are below secondary details; account review lacks connection context; manual-ID fallback separates the reviewed selection from Confirm.

## Exact design

1. Known-role header: one compact h2 Meta ads (same id/tabIndex) and existing Reload connections in wrapping row, justifyContent space-between, alignItems flex-start. That button remains under showConnections, same callback/disabled. Move existing Back to connections here only under mode === 'account' && isOwner, unchanged. No duplicate actions. Intro stays visible below with hint/margin0. h2 --text-lg, gaps --space-3/4, minWidth0, natural wrapping; no fixed/sticky layout.
2. Keep all error/notice/pending/unknown retry-or-restart blocks above body, outside disclosures, with exact guards/text/roles/callbacks. READONLY_ROLE remains visible.
3. Inside showConnections: owner setup message + existing Open app setup button become a visible compact group BEFORE cards, outside Add. Preserve isOwner, setupMessage !== '', canOpenAppSetup, ID and busy predicates. Connect's aria-describedby still points to setup-message. Next render cards BEFORE owner Add disclosure. Each article uses card stack, minWidth0 and token gap: compact name/status row, accountLabel, original owner action row, then unchanged Connection details. Keep every value/key/action/predicate; never infer success from status text. Add retains open={connections.length === 0}, helper, name field and Connect Meta mounted/exact. No empty-state claim or total.
4. Account body: h3 Choose an ad account; visible Connection: {connectionName}. Preserve selection helper, discovery status/alert, exact radios/labels/reasons, fieldset and paging. Selected-account paragraph remains independent of current page. Group it with selection-note and unchanged Confirm account AFTER account paging, BEFORE Use an account ID. Move, never duplicate Confirm. Manual-ID disclosure/input/check remain unchanged. No auto-discovery/selection/coercion/save.
5. Entire mode === 'disconnect' && isOwner block stays byte-identical: local default, Keep connection, collapsed capability-gated remote revoke/wider consequence. Native markers stay (no display:flex on summary). No truncation, line clamp, invented status/count/color/URL.

## Frozen behavior and measurable acceptance

Every callback body/argument, disabled/readOnly/checked/value/name/type/maxLength/aria association and original role/capability predicate remains exact, including surrounding guards when moved. Reordering is authorized; changing authorization is not. IDs stay strings, status/expiry stay prepared text; selectable is authoritative independently of statusLabel. Settings remain mounted.

GPT runs tests/meta-connection-view-browser.mjs (7 groups) and tests/meta-connection-browser.mjs (13), retaining all assertions. Add checks: saved cards before Add; source name/status/account/actions and owner setup guidance visible with Add closed; no setup action for nonoperator/nonowner. Disclosure close preserves draft and emits no callback. Exactly one applicable header Reload/Back. Account context and selected review/Confirm precede direct-ID fallback. Verify unknown retry vs OAuth restart, read-interruptible/write-locked Back, role purge, keyless local disconnect and explicit remote-revoke warning. Hostile metadata inert.

320/360/768/1440; long120-character source/512-character account names; LTR/RTL;200% CSS layout zoom; forced colors: no document overflow, exact IDs available, controls/radio labels/summaries >=44px, visible focus, intact aria-describedby. Inspect populated/empty/denied/account empty-partial-error/unknown/disconnect. No provider/DB/preserved preview. No claim of approval/import/pixel success. This brief is design-only; acceptance still required.

Source SHA256: B0F6891487EF3C78F50F855EF67377F3933E28791A8C586AE70E176F79435724. M1 SHA256 (UTF-8 exact span, excluding fences/additional newline): 66A98BF1E8BBC7E02B60EF064DE404869E0B94F6ED1294F31C16B5E28EC3569C. Everything outside M1 is frozen.

## Read-only exact types and constants

```tsx
export type MetaConnectionCard = {
  id: string;
  name: string;
  statusLabel: string;
  statusDetail: string;
  accountLabel: string;
  currencyLabel: string;
  timeZoneLabel: string;
  tokenExpiryLabel: string;
  dataExpiryLabel: string;
  canChoose: boolean;
  canReconnect: boolean;
  canDisconnect: boolean;
};

export type MetaAccountOption = {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
  statusLabel: string;
  selectable: boolean;
  unavailableReason: string | null;
};

export type MetaConnectionViewProps = {
  prefix: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loaded: boolean;
  reading: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string;
  notice: string;
  mode: 'connections' | 'account' | 'disconnect';
  setupMessage: string;
  canOpenAppSetup: boolean;
  canConnect: boolean;
  name: string;
  connections: MetaConnectionCard[];
  connectionName: string;
  connectionAccountLabel: string | null;
  accounts: MetaAccountOption[];
  discoveryLabel: string;
  discoveryState: 'not_loaded' | 'loaded' | 'empty' | 'partial' | 'failed';
  canPreviousAccounts: boolean;
  canNextAccounts: boolean;
  selectedAccount: MetaAccountOption | null;
  accountId: string;
  canCheckAccount: boolean;
  canConfirmAccount: boolean;
  canRemoteRevoke: boolean;
  canRetrySame: boolean;
  canRestartConnect: boolean;
  pendingActionLabel: string;
  onName: (value: string) => void;
  onAccountId: (value: string) => void;
  onConnect: () => void;
  onOpenAppSetup: () => void;
  onReload: () => void;
  onChoose: (connectionId: string) => void;
  onReconnect: (connectionId: string) => void;
  onReviewDisconnect: (connectionId: string) => void;
  onPreviousAccounts: () => void;
  onNextAccounts: () => void;
  onReloadAccounts: () => void;
  onPickAccount: (accountId: string) => void;
  onCheckAccount: () => void;
  onConfirmAccount: () => void;
  onDisconnect: (revokeAtMeta: boolean) => void;
  onRetrySame: () => void;
  onRestartConnect: () => void;
  onBack: () => void;
};

const INTRO = 'Read-only advertising account access. This does not install a pixel.';
const ADD_HELPER = 'You will approve access in Meta and return to choose an ad account.';
const SELECTION_HELPER =
  'This account stays attached to this connection. Add another connection to use a different account.';
const SELECTION_NOTE = 'Selecting saves a source; it does not import a report.';
const LOCAL_DISCONNECT =
  'Local credentials will be removed and new work stopped. Retained reports remain subject to retention and verified deletion requests.';
const WIDER_REVOKE =
  'Revoking this app grant can affect other sources, including ones you cannot view.';
const READONLY_ROLE =
  'A workspace owner can connect or change sources. Your access to retained reports follows your current workspace role.';

```

## M1 — only allowed exact original span

```tsx
  return (
    <section className='research-panel stack' style={{ display: 'grid', gap: 14 }} aria-labelledby={id('heading')}>
      <h2 id={id('heading')} tabIndex={-1}>
        Meta ads
      </h2>
      <p>{INTRO}</p>

      {error !== '' && <p role='alert'>{error}</p>}
      {notice !== '' && <p role='status'>{notice}</p>}
      {writing && pendingActionLabel !== '' && <p role='status'>{pendingActionLabel}</p>}

      {writeState === 'unknown' && isOwner && canRetrySame && (
        <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onRetrySame} disabled={reading}>
          Retry same request
        </button>
      )}
      {writeState === 'unknown' && isOwner && canRestartConnect && (
        <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onRestartConnect} disabled={reading}>
          Start authorization again
        </button>
      )}

      {!isOwner && <p>{READONLY_ROLE}</p>}

      {showConnections && (
        <>
          <div className='row'>
            <button className='btn' style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onReload} disabled={busy}>
              Reload connections
            </button>
          </div>
          {isOwner && (
            <details open={connections.length === 0}>
              <summary>Add a connection</summary>
              <p id={id('connect-helper')}>{ADD_HELPER}</p>
              <div className='field'>
                <label htmlFor={id('name')}>Connection name</label>
                <input
                  id={id('name')}
                  value={name}
                  maxLength={120}
                  disabled={writing}
                  onChange={(event) => onName(event.target.value)}
                  aria-describedby={id('connect-helper')}
                />
              </div>
              {setupMessage !== '' && <p id={id('setup-message')}>{setupMessage}</p>}
              <button className="btn primary" style={{ minHeight: 44, justifySelf: 'start' }}
                type='button'
                onClick={onConnect}
                disabled={!canConnect || name.trim() === '' || busy}
                aria-describedby={setupMessage !== '' ? id('setup-message') : undefined}
              >
                Connect Meta
              </button>
              {canOpenAppSetup && (
                <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onOpenAppSetup} disabled={busy}>
                  Open app setup
                </button>
              )}
            </details>
          )}

          {connections.map((connection) => (
            <article key={connection.id}>
              <h3>{connection.name}</h3>
              <p>{connection.statusLabel}</p>
              <p>{connection.accountLabel}</p>
              <details>
                <summary>Connection details</summary>
                <p>{connection.statusDetail}</p>
                <p>{connection.currencyLabel}</p>
                <p>{connection.timeZoneLabel}</p>
                <p>{connection.tokenExpiryLabel}</p>
                <p>{connection.dataExpiryLabel}</p>
              </details>
              {isOwner && (
                <div className='row'>
                  {connection.canChoose && (
                    <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={() => onChoose(connection.id)} disabled={busy}>
                      Choose account
                    </button>
                  )}
                  {connection.canReconnect && (
                    <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={() => onReconnect(connection.id)} disabled={busy}>
                      Reconnect
                    </button>
                  )}
                  {connection.canDisconnect && (
                    <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }}
                      type='button'
                      onClick={() => onReviewDisconnect(connection.id)}
                      disabled={busy}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
        </>
      )}

      {mode === 'account' && isOwner && (
        <>
          <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onBack} disabled={writing}>
            Back to connections
          </button>

          <p id={id('selection-helper')}>{SELECTION_HELPER}</p>

          {discoveryLabel !== '' && (
            <p role={discoveryState === 'failed' ? 'alert' : 'status'}>{discoveryLabel}</p>
          )}

          <fieldset style={{ minWidth: 0 }} aria-describedby={id('selection-helper')}>
            <legend>Ad account</legend>
            {accounts.map((account) => {
              const optionId = id('account-' + account.id);
              const reasonId = optionId + '-reason';
              const showReason = !account.selectable && account.unavailableReason !== null;
              return (
                <div key={account.id} className='field'>
                  <input
                    type='radio'
                    id={optionId}
                    name={id('account')}
                    value={account.id}
                    checked={selectedAccount !== null && selectedAccount.id === account.id}
                    disabled={!account.selectable || busy}
                    onChange={() => onPickAccount(account.id)}
                    aria-describedby={showReason ? reasonId : undefined}
                  />
                  <label htmlFor={optionId} style={{ minHeight: 44, cursor: account.selectable ? 'pointer' : undefined }}>
                    {account.name} · ID {account.id} · {account.currency} · {account.timeZone}
                  </label>
                  <p>{account.statusLabel}</p>
                  {showReason && <p id={reasonId}>{account.unavailableReason}</p>}
                </div>
              );
            })}
          </fieldset>

          <div className='row'>
            <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }}
              type='button'
              onClick={onPreviousAccounts}
              disabled={!canPreviousAccounts || busy}
            >
              Previous accounts
            </button>
            <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onNextAccounts} disabled={!canNextAccounts || busy}>
              Next accounts
            </button>
            <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onReloadAccounts} disabled={busy}>
              Reload accounts
            </button>
          </div>

          {selectedAccount !== null && (
            <p>
              Selected account: {selectedAccount.name} · ID {selectedAccount.id} ·{' '}
              {selectedAccount.currency} · {selectedAccount.timeZone}
            </p>
          )}

          <details>
            <summary>Use an account ID</summary>
          <div className='field'>
            <label htmlFor={id('account-id')}>Ad account ID</label>
            <input
              id={id('account-id')}
              value={accountId}
              inputMode='numeric'
              maxLength={40}
              disabled={writing}
              onChange={(event) => onAccountId(event.target.value)}
              aria-describedby={id('account-id-helper')}
            />
            <p id={id('account-id-helper')}>
              Enter the account ID digits exactly as Meta shows them.
            </p>
          </div>
          <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onCheckAccount} disabled={!canCheckAccount || busy}>
            Check account
          </button>
          </details>

          <p id={id('selection-note')}>{SELECTION_NOTE}</p>
          <button className="btn primary" style={{ minHeight: 44, justifySelf: 'start' }}
            type='button'
            onClick={onConfirmAccount}
            disabled={
              !canConfirmAccount || selectedAccount === null || !selectedAccount.selectable || busy
            }
            aria-describedby={id('selection-note')}
          >
            Confirm account
          </button>
        </>
      )}

      {mode === 'disconnect' && isOwner && (
        <>
          <h3>Disconnect {connectionName}?</h3>
          {connectionAccountLabel !== null && <p>{connectionAccountLabel}</p>}
          <p id={id('disconnect-local')}>{LOCAL_DISCONNECT}</p>
          <div className='row'>
            <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }}
              type='button'
              onClick={() => onDisconnect(false)}
              disabled={busy}
              aria-describedby={id('disconnect-local')}
            >
              Disconnect locally
            </button>
            <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onBack} disabled={writing}>
              Keep connection
            </button>
          </div>
          {canRemoteRevoke && (
            <details>
              <summary>Revoke access at Meta</summary>
              <p id={id('disconnect-remote')}>{WIDER_REVOKE}</p>
              <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }}
                type='button'
                onClick={() => onDisconnect(true)}
                disabled={busy}
                aria-describedby={id('disconnect-remote')}
              >
                Revoke Meta access and disconnect
              </button>
            </details>
          )}
        </>
      )}
    </section>
  );
```


## Execution budget

One initial K3 maximum-thinking draft, 420-second wall-clock cap; at most one separately authorized repair capped at 120 seconds. Stop at the deadline or any ambiguity and return the unresolved issue. No automatic continuation, model substitution or source application. Return only the requested JSON. Do not claim to have run tests.
