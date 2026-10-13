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

export function MetaConnectionView(props: MetaConnectionViewProps) {
  const {
    prefix,
    role,
    reading,
    writeState,
    error,
    notice,
    mode,
    setupMessage,
    canOpenAppSetup,
    canConnect,
    name,
    connections,
    connectionName,
    connectionAccountLabel,
    accounts,
    discoveryLabel,
    discoveryState,
    canPreviousAccounts,
    canNextAccounts,
    selectedAccount,
    accountId,
    canCheckAccount,
    canConfirmAccount,
    canRemoteRevoke,
    canRetrySame,
    canRestartConnect,
    pendingActionLabel,
    onName,
    onAccountId,
    onConnect,
    onOpenAppSetup,
    onReload,
    onChoose,
    onReconnect,
    onReviewDisconnect,
    onPreviousAccounts,
    onNextAccounts,
    onReloadAccounts,
    onPickAccount,
    onCheckAccount,
    onConfirmAccount,
    onDisconnect,
    onRetrySame,
    onRestartConnect,
    onBack,
  } = props;

  const isOwner = role === 'owner';
  const writing = writeState !== 'idle';
  const busy = writing || reading;
  const id = (suffix: string) => prefix + suffix;

  if (role === null) {
    return (
      <section className='research-panel stack' style={{ display: 'grid', gap: 14 }} aria-labelledby={id('heading')}>
        <h2 id={id('heading')} tabIndex={-1}>
          Meta ads
        </h2>
        <p>{INTRO}</p>
        {error !== '' ? (
          <p role='alert'>{error}</p>
        ) : (
          <p role='status'>Loading connections…</p>
        )}
        <button className="btn" style={{ minHeight: 44, justifySelf: 'start' }} type='button' onClick={onReload} disabled={busy}>
          Reload connections
        </button>
      </section>
    );
  }

  const showConnections = mode === 'connections' || !isOwner;

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
}
