# M02 — Meta app setup: registration review before editing

Public Kimi presentation brief. Use Ponytail and UX Copy Refiner. Return JSON only: {"replacements":[{"id":"M2","replacement":"exact replacement text"}]}. Only M2 below may change in src/components/MetaAppView.tsx. One bounded draft; GPT applies and independently validates. Only approved Skill tools. Static design review, not fresh tested/provider acceptance.

## Scope and flow

Freeze everything outside final operator return M2: types/constants/destructuring/helpers/unknown-and-nonoperator returns/brace. No imports/hooks/state/helpers/abstractions/CSS/dependencies/API. All props are already destructured; prefix is p. Frozen locals follow. Reuse row/field/card/stack/btn/hint/alert and native HTML.

routes/index.tsx mounts MetaAppPanel for instance operators, returning to connections or Account via backLabel. Panel is user-keyed, validates metadata and passes secret-free saved values plus a controlled typed secret. meta-api.ts dispatches GET/POST app and POST apps/:id/disable to meta-auth.ts. Operator permission is separate from workspace ownership. Pure-view and real-controller fixtures cover this flow; no caller changes.

The long edit form precedes callbacks/prerequisites and Back/Reload. Saved registration status and independent Disable should be reviewable first. No implemented test/proof control exists: enabling and operator-declared mode are NOT Meta approval. Never invent a Test button, successful check or verification badge.

## Exact design

1. Wrapping header: existing heading and existing final Back/Reload row, justifyContent space-between, alignItems flex-start. Move those exact buttons once, preserve disabled expressions. Intro below as hint/margin0. Errors, unknown-result alert, notice, loading and readiness stay above body, never inside a disclosure.
2. Compact chooser: retain labelled Registration select, offPage option, New registration option/callback and all options. Place existing New registration button alongside in a wrapping row; Previous/Next directly below. minWidth0; select may flex-grow and wrap. Preserve guards and empty-page hint; empty page does not mean no registrations exist.
3. Selected-registration block becomes card stack, marginBottom0/minWidth0/--space-3 gap. Preserve !newRegistration && selected !== null. Exact App {selected.appId}/statusLabel first. Move COMPLETE existing guarded disable/review/Keep-enabled block into this card, retaining its own guard/branches. Registration details follows actions. Confirmation/consequence remains visible independently of settings/vault/save. No extra confirmation or changed meaning.
4. Move Callback addresses and Meta prerequisites before edit fields, AFTER selected card. Their subtrees stay byte-identical: callbacks.length/newRegistration guard, open={newRegistration}, exact read-only URLs, copy kind/labels/disabled, missing-deletion explanation and prerequisites. No URL reconstruction or invented callback.
5. Replace only fragment immediately inside hasRecord with native details open={newRegistration}, summary App settings, inner div className=stack. All original App ID/config/secret/enabled/mode/activation fields, impact copy and Save row remain mounted inside, original order and exact attrs/callbacks/guards. No onToggle/state/conditional mounting. Existing record defaults closed; new registration open. Only newRegistration controls open: dirty/validation changes must not collapse the form. Selection/paging/reload/new/save remains controller-owned. Closing neither clears nor submits. Disable stays outside. Reuse token gap --space-3/4; no fixed dimensions, sticky UI, truncation or summary display:flex.

## Frozen semantics and acceptance

Keep callback bodies/arguments, original guards/value/checked/readOnly/disabled/maxLength/type/aria associations exact. IDs stay strings; existing App ID read-only. Active/enabled/declared-mode stay separate. Secret remains password/new-password, blank saved value, explicit submission and controller clearing; no readback/copy/retry/storage. Unknown write permits metadata reload only; recovery cannot prove which secret was saved. Back interrupts reads but not unresolved writes. Disable stays keyless/target-specific/distinct from remote revocation/deletion, including revision cap. No text changes except summary App settings.

GPT runs tests/meta-app-view-browser.mjs (7 groups) and tests/meta-app-browser.mjs (7), preserving all assertions. Harness may open App settings before field interaction; retain controller heading-focus checks BEFORE disclosure clicks. Verify closed settings retain mounted fields, new settings open, no callback/API on disclosure; invalid edits/activation/typed synthetic secret survive close/reopen. Exact selected status/Disable precede callbacks/settings, including off-page selection; confirmation visible with settings closed. One header Back/Reload; readiness/unknown alerts visible. Retain denial, dirty-discard, secret clear/no-replay, target recovery, keyless disable, callback integrity and clipboard fallback cases.

320/360/768/1440, long40-digit IDs/origins/callbacks, LTR/RTL,200% CSS layout zoom, forced colors: no page overflow; fields/selectable URLs exact; controls/checkbox labels/summaries >=44px; visible focus/intact helper IDs. Inspect existing/new/unknown/nonoperator/disable. Synthetic loopback fixtures only; no provider/DB/live preview. Product edits and fresh execution are outside this design deliverable.

Source SHA256: 6CE9EBC05C147F4CE81D73565EA7EBD8927FC969AB87B7ABA857D36D29B65992. M2 SHA256 (UTF-8 exact original span, excluding fences/additional newline): 9ACCA57935616A7F2009E046186C47CED34E3C23C89DAE884C4798348FEA29D4. Everything outside M2 frozen.

## Read-only exact types and constants

```tsx
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

```

## Read-only exact derived locals and heading

```tsx
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
```

## M2 — only allowed exact original span

```tsx
  return (
    <section className="research-panel stack" style={layout} aria-labelledby={`${p}heading`}>
      {heading}
      <p>{INTRO}</p>
      {error !== '' && <p className="alert" role="alert">{error}</p>}
      {unknown && <p className="alert" role="alert">{AMBIGUOUS_WRITE}</p>}
      {notice !== '' && <p role="status">{notice}</p>}
      {reading && <p role="status">Loading app setup…</p>}
      {readiness !== '' && <p className="hint">{readiness}</p>}

      <div className="field" style={fill}>
        <label id={`${p}registration-label`} htmlFor={`${p}registration`}>Registration</label>
        <select
          id={`${p}registration`}
          aria-labelledby={`${p}registration-label`}
          value={newRegistration || selected === null ? '' : selected.id}
          disabled={busy || unknown}
          style={fill}
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

      <div className="row">
        <button type="button" className="btn" style={target} onClick={onNew} disabled={busy || unknown}>New registration</button>
        <button type="button" className="btn" style={target} onClick={onPrevious} disabled={busy || unknown || !canPrevious}>Previous registrations</button>
        <button type="button" className="btn" style={target} onClick={onNext} disabled={busy || unknown || !canNext}>Next registrations</button>
      </div>

      {!newRegistration && selected !== null && (
        <div className="field" style={fill}>
          <p>App {selected.appId} · {selected.statusLabel}</p>
          <details>
            <summary>Registration details</summary>
            <p className="hint">{selected.revisionLabel}</p>
            <p className="hint">{selected.boundOrigin}</p>
          </details>
        </div>
      )}

      {hasRecord && (
        <>
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
              style={fill}
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
              style={fill}
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
              style={fill}
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
              style={fill}
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
        </>
      )}

      {!newRegistration && selected !== null && (
        confirmDisable ? (
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
        )
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
                style={fill}
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

      <div className="row">
        <button type="button" className="btn" style={target} onClick={onBack} disabled={writeState === 'submitting' || unknown}>{backLabel}</button>
        <button type="button" className="btn" style={target} onClick={onReload} disabled={busy}>Reload app setup</button>
      </div>
    </section>
  );
```


## Execution budget

One initial K3 maximum-thinking draft, 420-second wall-clock cap; at most one separately authorized repair capped at 120 seconds. Stop at the deadline or any ambiguity and return the unresolved issue. No automatic continuation, model substitution or source application. Return only the requested JSON. Do not claim to have run tests.
