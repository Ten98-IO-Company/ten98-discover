import { OidcProviderButtons } from '@ten98/ui'
import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { authorizationRedirect, navigableHttpUrl } from '../lib/oidc-authorization';

interface Provider { id: string; name: string }

// Kept for the other OIDC panels' imports; sign-in below also pins the provider's origin.
export const httpUrl = navigableHttpUrl;

export function OidcSignIn({invitationToken}: {invitationToken?: string}) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [err, setErr] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingId, setPendingId] = useState('');
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
    setErr(''); setLoadFailed(false);
    api<{providers: Provider[]}>('/api/auth/oidc/providers', {signal: ac.signal})
      .then(r => { if (!dead) setProviders(r.providers); })
      .catch(e => { if (!dead && !ac.signal.aborted) { setErr(errMsg(e)); setLoadFailed(true); } });
    return () => { dead = true; ac.abort(); };
  }, [tick]);

  const start = async (providerId: string) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true); setPendingId(providerId);
    setErr('');
    const controller = new AbortController(); mutationAbort.current = controller;
    const serial = ++generation.current, token = invitationToken;
    const current = () => mounted.current && serial === generation.current && tokenRef.current === token && !controller.signal.aborted;
    try {
      const body = invitationToken ? {providerId, invitationToken} : {providerId};
      const r = await api<{authorizationUrl: string; authorizationOrigin: string}>('/api/auth/oidc/start', {method: 'POST', body, signal: controller.signal});
      if (!current()) return;
      const u = authorizationRedirect(r.authorizationUrl, r.authorizationOrigin);
      if (!u) { setErr('The server returned an invalid sign-in address. Nothing was opened.'); return; }
      window.location.assign(u);
    } catch (e) {
      if (current()) setErr(errMsg(e));
    } finally {
      if (serial === generation.current) { lock.current = false; if (mounted.current) setPending(false); }
    }
  };

  const loading = providers === null && !err;
  // A failed start shows its message in place of the buttons; retry returns to them without refetching.
  const failure = err === '' ? undefined : loadFailed && providers === null ? `Could not load sign-in options: ${err}` : err;
  return (
    <OidcProviderButtons providers={providers} loading={loading} error={failure}
      onStart={id => void start(id)} onRetry={() => { if (providers === null) setTick(t => t + 1); else setErr('') }}
      pending={pending ? pendingId : null} />
  );
}
