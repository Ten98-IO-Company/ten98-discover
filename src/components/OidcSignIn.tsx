import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api';

interface Provider { id: string; name: string }

// Only http(s) URLs may be navigated to; plain http is limited to loopback for local tests.
function httpUrl(s: string): string | null {
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return u.toString();
    return null;
  } catch {
    return null;
  }
}

export function OidcSignIn({invitationToken}: {invitationToken?: string}) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  const mutationAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const tokenRef = useRef(invitationToken);
  tokenRef.current = invitationToken;
  useEffect(() => {
    mounted.current = true; lock.current = false; setPending(false);
    return () => { mounted.current = false; generation.current++; mutationAbort.current?.abort(); };
  }, [invitationToken]);

  useEffect(() => {
    const ac = new AbortController();
    let dead = false;
    setErr('');
    api<{providers: Provider[]}>('/api/auth/oidc/providers', {signal: ac.signal})
      .then(r => { if (!dead) setProviders(r.providers); })
      .catch(e => { if (!dead && !ac.signal.aborted) setErr(errMsg(e)); });
    return () => { dead = true; ac.abort(); };
  }, [tick]);

  const start = async (providerId: string) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setErr('');
    const controller = new AbortController(); mutationAbort.current = controller;
    const serial = ++generation.current, token = invitationToken;
    const current = () => mounted.current && serial === generation.current && tokenRef.current === token && !controller.signal.aborted;
    try {
      const body = invitationToken ? {providerId, invitationToken} : {providerId};
      const r = await api<{authorizationUrl: string}>('/api/auth/oidc/start', {method: 'POST', body, signal: controller.signal});
      if (!current()) return;
      const u = httpUrl(r.authorizationUrl);
      if (!u) { setErr('The server returned an invalid sign-in address. Nothing was opened.'); return; }
      window.location.assign(u);
    } catch (e) {
      if (current()) setErr(errMsg(e));
    } finally {
      if (serial === generation.current) { lock.current = false; if (mounted.current) setPending(false); }
    }
  };

  if (providers === null && !err) return <p role="status" className="dim">Loading sign-in options…</p>;
  if (providers === null) {
    return (
      <div className="card">
        <p role="alert" className="alert">Could not load sign-in options: {err}</p>
        <button type="button" className="btn ghost" onClick={() => setTick(t => t + 1)}>Try again</button>
      </div>
    );
  }
  if (providers.length === 0) return null;

  return (
    <div>
      {providers.map(p => (
        <button key={p.id} type="button" className="btn ghost" disabled={pending} onClick={() => void start(p.id)}>
          Continue with {p.name}
        </button>
      ))}
      {pending && <p role="status" className="dim">Contacting the provider…</p>}
      {err && <p role="alert" className="alert">{err}</p>}
    </div>
  );
}
