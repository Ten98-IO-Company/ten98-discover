export type MetaAppChoice = { id: string; label: string };
export type MetaAppSelection = {
  id: string; appId: string; statusLabel: string; revisionLabel: string;
  active: boolean; enabled: boolean; boundOrigin: string;
};
export type MetaAppCallback = {
  kind: 'oauth' | 'deletion'; label: string; url: string; helper: string;
};
export type MetaAppViewProps = {
  prefix: string;
  operator: boolean | null;
  reading: boolean;
  writeState: 'idle' | 'submitting' | 'unknown';
  error: string; notice: string; readiness: string;
  choices: MetaAppChoice[];
  selected: MetaAppSelection | null;
  newRegistration: boolean;
  canPrevious: boolean; canNext: boolean;
  appId: string; configId: string; secret: string;
  enabled: boolean; declaredMode: 'development' | 'live'; activate: boolean;
  canSave: boolean; canDisable: boolean;
  confirmDisable: boolean;
  callbacks: MetaAppCallback[];
  backLabel: string;
  onSelect: (id: string) => void;
  onNew: () => void; onPrevious: () => void; onNext: () => void;
  onAppId: (value: string) => void;
  onConfigId: (value: string) => void;
  onSecret: (value: string) => void;
  onEnabled: (value: boolean) => void;
  onMode: (value: 'development' | 'live') => void;
  onActivate: (value: boolean) => void;
  onSave: () => void;
  onReviewDisable: () => void; onDisable: () => void; onKeepEnabled: () => void;
  onCopy: (kind: 'oauth' | 'deletion') => void;
  onReload: () => void; onBack: () => void;
};

const INTRO = "Configure this installation's Meta app. This does not grant project access.";
const NONOPERATOR = 'Only an instance operator can view or change Meta app setup.';
const SECRET_HELPER = 'Leave blank to keep the stored secret. New registrations require a secret.';
const SECRET_HANDLING = 'The secret is sent once and cleared on submission. It is never shown or retried automatically.';
const REVISION_IMPACT = 'Saving changes requires affected sources to reconnect. Retained reports remain subject to retention and deletion rules.';
const MODE_HELPER = 'This is your declared app mode, not verification or approval by Meta.';
const ACTIVATE_HELPER = 'Activating changes the app used for new connections. It does not delete other registrations.';
const AMBIGUOUS_WRITE = 'The result is not confirmed. Reload app setup before making another change.';
const DISABLE_CONSEQUENCE = 'Disable this registration to stop new access through it. This does not revoke the grant at Meta or delete retained reports.';

const target = { minHeight: 44 };
const fill = { minWidth: 0, margin: 0 };
const layout = { display: 'grid', gap: 10 };

export function MetaAppView(props: MetaAppViewProps) {
  const {
    prefix: p, operator, reading, writeState, error, notice, readiness,
    choices, selected, newRegistration, canPrevious, canNext,
    appId, configId, secret, enabled, declaredMode, activate,
    canSave, canDisable, confirmDisable, callbacks, backLabel,
    onSelect, onNew, onPrevious, onNext, onAppId, onConfigId, onSecret,
    onEnabled, onMode, onActivate, onSave, onReviewDisable, onDisable,
    onKeepEnabled, onCopy, onReload, onBack,
  } = props;

  const unknown = writeState === 'unknown';
  const busy = reading || writeState === 'submitting';
  const fieldLocked = busy || unknown || confirmDisable;
  const hasRecord = newRegistration || selected !== null;
  const offPage =
    !newRegistration && selected !== null &&
    !choices.some((choice) => choice.id === selected.id);
  const saveDisabled =
    !canSave || writeState !== 'idle' || reading || confirmDisable || !hasRecord ||
    appId.trim() === '' || configId.trim() === '' ||
    (newRegistration && secret.length === 0);

  const heading = <h2 id={`${p}heading`} tabIndex={-1}>Meta app setup</h2>;

  if (operator === null) {
    return (
      <section className="research-panel stack" style={layout} aria-labelledby={`${p}heading`}>
        {heading}
        <p>{INTRO}</p>
        {error !== '' ? (
          <p className="alert" role="alert">{error}</p>
        ) : reading ? (
          <p role="status">Loading app setup…</p>
        ) : null}
        <div className="row">
          <button type="button" className="btn" style={target} onClick={onReload} disabled={busy}>Reload app setup</button>
          <button type="button" className="btn" style={target} onClick={onBack} disabled={writeState !== 'idle'}>{backLabel}</button>
        </div>
      </section>
    );
  }

  if (operator === false) {
    return (
      <section className="research-panel stack" style={layout} aria-labelledby={`${p}heading`}>
        {heading}
        <p>{INTRO}</p>
        <p>{NONOPERATOR}</p>
        {error !== '' && <p className="alert" role="alert">{error}</p>}
        {notice !== '' && <p role="status">{notice}</p>}
        <div className="row">
          <button type="button" className="btn" style={target} onClick={onReload} disabled={busy}>Reload app setup</button>
          <button type="button" className="btn" style={target} onClick={onBack} disabled={writeState !== 'idle'}>{backLabel}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="research-panel stack" style={layout} aria-labelledby={`${p}heading`}>
      <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        {heading}
        <div className="row">
          <button type="button" className="btn" style={target} onClick={onBack} disabled={writeState === 'submitting' || unknown}>{backLabel}</button>
          <button type="button" className="btn" style={target} onClick={onReload} disabled={busy}>Reload app setup</button>
        </div>
      </div>
      <p className="hint" style={{ margin: 0 }}>{INTRO}</p>
      {error !== '' && <p className="alert" role="alert">{error}</p>}
      {unknown && <p className="alert" role="alert">{AMBIGUOUS_WRITE}</p>}
      {notice !== '' && <p role="status">{notice}</p>}
      {reading && <p role="status">Loading app setup…</p>}
      {readiness !== '' && <p className="hint">{readiness}</p>}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ ...fill, flexGrow: 1 }}>
          <label id={`${p}registration-label`} htmlFor={`${p}registration`}>Registration</label>
          <select
            id={`${p}registration`}
            aria-labelledby={`${p}registration-label`}
            value={newRegistration || selected === null ? '' : selected.id}
            disabled={busy || unknown}
            style={{ ...fill, minHeight: 44 }}
            onChange={(event) => {
              const value = event.target.value;
              if (value === '') onNew(); else onSelect(value);
            }}
          >
            <option value="">New registration</option>
            {offPage && <option value={selected.id}>{selected.appId}</option>}
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </select>
          {choices.length === 0 && <span className="hint">No registrations on this page</span>}
        </div>
        <button type="button" className="btn" style={target} onClick={onNew} disabled={busy || unknown}>New registration</button>
      </div>

      <div className="row">
        <button type="button" className="btn" style={target} onClick={onPrevious} disabled={busy || unknown || !canPrevious}>Previous registrations</button>
        <button type="button" className="btn" style={target} onClick={onNext} disabled={busy || unknown || !canNext}>Next registrations</button>
      </div>

      {!newRegistration && selected !== null && (
        <div className="card stack" style={{ gap: 'var(--space-3)', marginBottom: 0, minWidth: 0 }}>
          <p>App {selected.appId} · {selected.statusLabel}</p>
          {confirmDisable ? (
            <div className="field" style={fill}>
              <p id={`${p}disable-impact`}>{DISABLE_CONSEQUENCE}</p>
              <div className="row">
                <button type="button" className="btn" style={target} onClick={onDisable} disabled={busy || unknown || !canDisable} aria-describedby={`${p}disable-impact`}>Disable registration</button>
                <button type="button" className="btn" style={target} onClick={onKeepEnabled} disabled={busy || unknown}>Keep enabled</button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="btn" style={target} onClick={onReviewDisable} disabled={busy || unknown || !canDisable}>Disable registration</button>
            </div>
          )}
          <details>
            <summary>Registration details</summary>
            <p className="hint">{selected.revisionLabel}</p>
            <p className="hint">{selected.boundOrigin}</p>
          </details>
        </div>
      )}

      {(callbacks.length > 0 || newRegistration) && (
        <details open={newRegistration}>
          <summary>Callback addresses</summary>
          {callbacks.map((callback) => (
            <div className="field" style={fill} key={callback.kind}>
              <label id={`${p}callback-${callback.kind}-label`} htmlFor={`${p}callback-${callback.kind}`}>{callback.label}</label>
              <input
                id={`${p}callback-${callback.kind}`}
                type="text"
                readOnly
                value={callback.url}
                style={{ ...fill, minHeight: 44 }}
                aria-describedby={`${p}callback-${callback.kind}-helper`}
              />
              <span className="hint" id={`${p}callback-${callback.kind}-helper`}>{callback.helper}</span>
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  style={target}
                  disabled={busy || unknown}
                  aria-label={`Copy address: ${callback.label}`}
                  onClick={() => onCopy(callback.kind)}
                >
                  Copy address
                </button>
              </div>
            </div>
          ))}
          {newRegistration && !callbacks.some((callback) => callback.kind === 'deletion') && (
            <p className="hint">Save this registration to get its data-deletion callback</p>
          )}
        </details>
      )}

      <details>
        <summary>Meta prerequisites</summary>
        <ul className="hint">
          <li>Use a stable HTTPS address for this installation.</li>
          <li>Configure Facebook Login for Business with a user-token configuration and reporting permission ads_read.</li>
          <li>Provide your app's privacy policy and the exact data-deletion callback shown here.</li>
          <li>Access to other businesses may require Meta review. Saving these settings does not verify approval.</li>
        </ul>
      </details>

      {hasRecord && (
        <details open={newRegistration}>
          <summary>App settings</summary>
          <div className="stack">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: 14 }}>
              <div className="field" style={fill}>
                <label id={`${p}appid-label`} htmlFor={`${p}appid`}>App ID</label>
                <input
                  id={`${p}appid`}
                  type="text"
                  inputMode="numeric"
                  maxLength={40}
                  value={appId}
                  readOnly={!newRegistration}
                  disabled={fieldLocked}
                  style={{ ...fill, minHeight: 44 }}
                  onChange={(event) => onAppId(event.target.value)}
                />
              </div>

              <div className="field" style={fill}>
                <label id={`${p}configid-label`} htmlFor={`${p}configid`}>Facebook Login configuration ID</label>
                <input
                  id={`${p}configid`}
                  type="text"
                  inputMode="numeric"
                  maxLength={40}
                  value={configId}
                  disabled={fieldLocked}
                  style={{ ...fill, minHeight: 44 }}
                  onChange={(event) => onConfigId(event.target.value)}
                />
              </div>
            </div>

            <div className="field" style={fill}>
              <label id={`${p}secret-label`} htmlFor={`${p}secret`}>App secret</label>
              <input
                id={`${p}secret`}
                type="password"
                autoComplete="new-password"
                maxLength={512}
                value={secret}
                disabled={fieldLocked}
                style={{ ...fill, minHeight: 44 }}
                aria-describedby={`${p}secret-helper ${p}secret-handling`}
                onChange={(event) => onSecret(event.target.value)}
              />
              <p className="hint" id={`${p}secret-helper`}>{SECRET_HELPER}</p>
              <p className="hint" id={`${p}secret-handling`}>{SECRET_HANDLING}</p>
            </div>

            <div className="row">
              <input
                id={`${p}enabled`}
                type="checkbox"
                checked={enabled}
                disabled={fieldLocked}
                onChange={(event) => onEnabled(event.target.checked)}
              />
              <label id={`${p}enabled-label`} htmlFor={`${p}enabled`} style={{ minHeight: 44, display: 'flex', alignItems: 'center', margin: 0 }}>Enable this registration</label>
            </div>

            <div className="field" style={fill}>
              <label id={`${p}mode-label`} htmlFor={`${p}mode`}>Operator-declared app mode</label>
              <select
                id={`${p}mode`}
                value={declaredMode}
                disabled={fieldLocked}
                style={{ ...fill, minHeight: 44 }}
                aria-describedby={`${p}mode-helper`}
                onChange={(event) => onMode(event.target.value === 'live' ? 'live' : 'development')}
              >
                <option value="development">Development</option>
                <option value="live">Live</option>
              </select>
              <span className="hint" id={`${p}mode-helper`}>{MODE_HELPER}</span>
            </div>

            {newRegistration || (selected !== null && !selected.active) ? (
              <div className="field" style={fill}>
                <div className="row">
                  <input
                    id={`${p}activate`}
                    type="checkbox"
                    checked={activate}
                    disabled={fieldLocked}
                    aria-describedby={`${p}activate-helper`}
                    onChange={(event) => onActivate(event.target.checked)}
                  />
                  <label id={`${p}activate-label`} htmlFor={`${p}activate`} style={{ minHeight: 44, display: 'flex', alignItems: 'center', margin: 0 }}>Use this registration for new connections</label>
                </div>
                <span className="hint" id={`${p}activate-helper`}>{ACTIVATE_HELPER}</span>
              </div>
            ) : selected !== null && selected.active ? (
              <p className="hint">Active for new connections</p>
            ) : null}

            <p className="hint" id={`${p}save-impact`}>{REVISION_IMPACT}</p>
            <div className="row">
              <button type="button" className="btn primary" style={target} onClick={onSave} disabled={saveDisabled} aria-describedby={`${p}save-impact`}>Save app settings</button>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
