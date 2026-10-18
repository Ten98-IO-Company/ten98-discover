import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errMsg } from '../lib/api';

const BTN = { minHeight: 44 };

interface AppDto {
  configured: boolean;
  enabled: boolean;
  testing: boolean;
  vaultConfigured: boolean;
  redirectUri: string;
  operator: boolean;
  revision: number;
  clientId?: string;
}

export function GoogleAppPanel({ userId, onUnauthorized }: { userId: string; onUnauthorized: () => void }) {
  return <AppInner key={userId} onUnauthorized={onUnauthorized} />;
}

function AppInner({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [dto, setDto] = useState<AppDto | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [testing, setTesting] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const gen = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gen.current++; active.current?.abort(); }; }, []);

  const alive = (serial: number, c: AbortController) => mounted.current && serial === gen.current && !c.signal.aborted;

  const applyDto = (r: AppDto) => {
    setDto(r);
    setClientId(r.clientId ?? '');
    setEnabled(r.enabled);
    setTesting(r.testing);
    setSecret('');
  };
  const terminal = (e: unknown) => {
    if (!(e instanceof ApiError) || ![401, 403, 404].includes(e.status)) return false;
    setDto(null); setClientId(''); setSecret(''); setEnabled(false); setTesting(false); setNotice(''); setErr(errMsg(e));
    if (e.status === 401) onUnauthorized();
    return true;
  };

  useEffect(() => {
    const ac = new AbortController();
    active.current = ac;
    const serial = ++gen.current;
    lock.current = true; setPending(true);
    setErr('');
    api<AppDto>('/api/google/app', { signal: ac.signal })
      .then(r => { if (alive(serial, ac)) applyDto(r); })
      .catch(e => {
        if (!alive(serial, ac)) return;
        if (terminal(e)) return;
        setErr(errMsg(e));
      }).finally(() => { if (alive(serial, ac)) { lock.current = false; setPending(false); } });
    return () => ac.abort();
  }, [tick]);

  const save = async () => {
    if (lock.current || !dto?.operator || !dto.vaultConfigured) return;
    lock.current = true;
    setPending(true);
    setErr('');
    setNotice('');
    const serial = ++gen.current;
    const controller = new AbortController();
    active.current?.abort(); active.current = controller;
    const sentSecret = secret;
    setSecret(''); // cleared immediately on submission; never retained for retry
    const body = { revision: dto.revision, clientId: clientId.trim(), clientSecret: sentSecret, enabled, testing };
    try {
      const r = await api<AppDto>('/api/google/app', { method: 'POST', body, signal: controller.signal });
      if (!alive(serial, controller)) return;
      applyDto(r);
      setNotice('Google app settings saved.');
    } catch (e) {
      if (!alive(serial, controller)) return;
      if (terminal(e)) return;
      if (e instanceof ApiError && e.status === 409) {
        try {
          const r = await api<AppDto>('/api/google/app', { signal: controller.signal });
          if (alive(serial, controller)) {
            applyDto(r);
            setErr('These settings were changed elsewhere. Current values are loaded; review them and save again.');
          }
        } catch (refreshError) {
          if (alive(serial, controller) && !terminal(refreshError)) setErr('These settings were changed elsewhere, and reloading them failed. Reload settings before saving again.');
        }
        return;
      }
      setErr(e instanceof ApiError && e.status === 0 ? 'The save response was lost. Reload settings to check the result before entering the secret again.' : errMsg(e));
    } finally {
      if (serial === gen.current) {
        lock.current = false;
        if (mounted.current) setPending(false);
      }
    }
  };

  if (!dto && err === '') return <p role="status" className="dim">Loading Google app settings…</p>;
  if (!dto) {
    return (
      <div className="card">
        <p role="alert" className="alert">{err}</p>
        <button type="button" className="btn ghost" style={BTN} onClick={() => setTick(t => t + 1)}>Reload settings</button>
      </div>
    );
  }

  if (!dto.operator) {
    return (
      <div className="card stack">
        <p>Google app: {dto.configured ? 'configured' : 'not configured'} · {dto.enabled ? 'enabled' : 'disabled'}{dto.testing ? ' · testing mode' : ''}</p>
        <p className="hint">Only the instance operator can view or change the Google app setup.</p>
      </div>
    );
  }

  return (
    <div className="card stack">
      <p>Google app: {dto.configured ? 'configured' : 'not configured'} · {dto.enabled ? 'enabled' : 'disabled'}{dto.testing ? ' · testing mode' : ''}</p>
      <div className="field">
        <label htmlFor="g-callback">Callback URI — add this exact address to the Google OAuth client</label>
        <input id="g-callback" type="text" readOnly value={dto.redirectUri} onFocus={e => e.currentTarget.select()} />
      </div>
      <ul className="hint">
        <li>Create a Google web OAuth client in Google Cloud.</li>
        <li>Enable the Search Console API, the Analytics Data API, and the Analytics Admin API.</li>
        <li>Add the exact callback URI above as an authorized redirect URI.</li>
        <li>Configure the consent screen and add test users.</li>
      </ul>
      <p className="hint">In testing mode, Google refresh tokens may expire after seven days. Publishing the consent app is not proof of verification.</p>
      {!dto.vaultConfigured && <p role="alert" className="alert">The credential vault is not configured, so secrets cannot be stored yet.</p>}
      <form className="stack" onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset className="stack" disabled={pending || !dto.vaultConfigured} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field">
          <label htmlFor="g-client-id">Client ID</label>
          <input id="g-client-id" type="text" autoComplete="off" maxLength={512} value={clientId} onChange={e => setClientId(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="g-client-secret">Client secret</label>
          <input id="g-client-secret" type="password" autoComplete="new-password" maxLength={4096} value={secret} onChange={e => setSecret(e.target.value)} required />
        </div>
        <p className="hint">The secret is sent once and cleared immediately; enter it again for every change. It is never shown or retried automatically.</p>
        {dto.configured && <p className="hint">Every save, including changing these flags, requires existing sources to reconnect and cancels pending connections. Imported snapshots remain available.</p>}
        <label className="row" style={{ minHeight: 44 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span>Enable Google connections</span>
        </label>
        <label className="row" style={{ minHeight: 44 }}>
          <input type="checkbox" checked={testing} onChange={e => setTesting(e.target.checked)} />
          <span>Google consent app is in testing mode</span>
        </label>
        <button type="submit" className="btn primary" style={BTN} disabled={pending}>{dto.configured ? 'Save Google app settings' : 'Create Google app settings'}</button>
        </fieldset>
      </form>
      <button type="button" className="btn ghost" style={BTN} disabled={pending} onClick={() => { setSecret(''); setTick(t => t + 1); }}>Reload settings</button>
      {notice !== '' && <p role="status" className="hint">{notice}</p>}
      {err !== '' && <p role="alert" className="alert">{err}</p>}
    </div>
  );
}
