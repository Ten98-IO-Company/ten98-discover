import {AppIcon} from '@ten98/ui/app';
import { Disclosure, useConfirmDialog } from '@ten98/ui'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errMsg } from '../lib/api';
import { httpUrl } from './OidcSignIn';

interface PublicProvider { id: string; name: string }
interface Identity { id: string; issuer: string; subject: string; createdAt: string; providerId: string; providerName: string; enabled: boolean }
interface Settings { name: string; issuer: string; clientId: string; authentication: 'basic' | 'post'; allowedOrigins: string[]; allowedAddresses: string[]; trustVerifiedEmail: boolean }
interface OpProvider { id: string; revision: number; settings: Settings; enabled: boolean; activeRevision: number | null; testedRevision: number | null; testedAt: string | null }
interface OpData { providers: OpProvider[]; callbackUrl: string; vaultConfigured: boolean }
interface Proof { password: string; code?: string; backupCode?: string }
interface ProofInfo { id: string; purpose: 'test' | 'link' | 'account'; providerId: string; providerName: string; issuer: string; subject: string; email: string | null; emailVerified: boolean; expiresAt: string }
type Mutation = { signal: AbortSignal; current: () => boolean; fail: (error: unknown, setError: (message: string) => void) => void };
type Mutate = <T>(fn: (mutation: Mutation) => Promise<T>) => Promise<T | undefined>;

function lines(s: string): string[] {
  return s.split('\n').map(x => x.trim()).filter(Boolean);
}

// 'account' shows the signed-in user's own sign-in methods; 'operator' shows the installation's identity providers.
export function OidcPanel(props: {userId: string; instanceOperator: boolean; proofId?: string; onUnauthorized: () => void; onProofHandled: () => void; part?: 'all' | 'account' | 'operator'}) {
  // Remount wipes all inner state (including any typed secrets) when the account or role changes.
  return <PanelInner key={props.userId + '|' + String(props.instanceOperator)} {...props} />;
}

function PanelInner({userId, instanceOperator, proofId, onUnauthorized, onProofHandled, part = 'all'}: {userId: string; instanceOperator: boolean; proofId?: string; onUnauthorized: () => void; onProofHandled: () => void; part?: 'all' | 'account' | 'operator'}) {
  const cb = useRef({onUnauthorized, onProofHandled});
  cb.current = {onUnauthorized, onProofHandled};

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState('');
  const [publicProviders, setPublicProviders] = useState<PublicProvider[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [hasPassword, setHasPassword] = useState(false);
  const [opData, setOpData] = useState<OpData | null>(null);
  const [tick, setTick] = useState(0);
  const refreshing = useRef(true);
  const reload = () => { refreshing.current = true; setPhase('loading'); setTick(t => t + 1); };

  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const mutationAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const proofRef = useRef(proofId);
  proofRef.current = proofId;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; mutationAbort.current?.abort(); };
  }, []);

  // Synchronous mutation lock: a second submit while one runs is dropped, not queued.
  async function mutate<T>(fn: (mutation: Mutation) => Promise<T>): Promise<T | undefined> {
    if (lock.current || refreshing.current || !mounted.current) return undefined;
    lock.current = true;
    setBusy(true);
    const controller = new AbortController(); mutationAbort.current = controller;
    const serial = ++generation.current, startingProof = proofRef.current;
    const current = () => mounted.current && serial === generation.current && !controller.signal.aborted && proofRef.current === startingProof;
    try { return await fn({ signal: controller.signal, current, fail(error, setError) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) { cb.current.onUnauthorized(); return; }
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setOpData(null); setIdentities([]); setPublicProviders([]); setProof(null); reload(); return;
      }
      setError(errMsg(error));
    } }); }
    catch (error) { if (current()) { setLoadErr(errMsg(error)); setPhase('error'); } return undefined; }
    finally { if (serial === generation.current) { lock.current = false; if (mounted.current) setBusy(false); } }
  }

  useEffect(() => {
    const ac = new AbortController();
    let dead = false;
    setPhase('loading');
    setLoadErr('');
    setOpData(null);
    (async () => {
      try {
        // Verify the session account first; never mix another account's data with this panel.
        const me = await api<{user: {id: string}}>('/api/me', {signal: ac.signal});
        if (dead || ac.signal.aborted) return;
        if (me.user.id !== userId) { cb.current.onUnauthorized(); return; }
        const [pub, ids, security] = await Promise.all([
          api<{providers: PublicProvider[]}>('/api/auth/oidc/providers', {signal: ac.signal}),
          api<{identities: Identity[]}>('/api/account/oidc/identities', {signal: ac.signal}),
          api<{hasPassword: boolean}>('/api/account/security', {signal: ac.signal}),
        ]);
        let op: OpData | null = null;
        if (instanceOperator) {
          try {
            op = await api<OpData>('/api/identity/oidc/providers', {signal: ac.signal});
          } catch (e) {
            // 403/404: management controls stay cleared (opData null); retry card is shown.
            if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) throw e;
          }
        }
        if (dead) return;
        setPublicProviders(pub.providers);
        setIdentities(ids.identities);
        setHasPassword(security.hasPassword);
        setOpData(op);
        setPhase('ready');
      } catch (e) {
        if (dead || ac.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) { cb.current.onUnauthorized(); return; }
        setLoadErr(errMsg(e));
        setPhase('error');
      } finally {
        if (!dead && !ac.signal.aborted) refreshing.current = false;
      }
    })();
    return () => { dead = true; ac.abort(); };
  }, [userId, instanceOperator, proofId, tick]);

  const [proof, setProof] = useState<ProofInfo | null>(null);
  const [proofState, setProofState] = useState<'idle' | 'loading' | 'ready' | 'expired' | 'error'>('idle');
  const [proofErr, setProofErr] = useState('');
  const [proofTick, setProofTick] = useState(0);

  useEffect(() => {
    if (!proofId || phase !== 'ready') { setProof(null); setProofState('idle'); return; }
    const ac = new AbortController();
    let dead = false;
    setProofState('loading');
    setProofErr('');
    (async () => {
      try {
        const r = await api<{proof: ProofInfo}>('/api/account/oidc/proofs/' + encodeURIComponent(proofId), {signal: ac.signal});
        if (dead) return;
        setProof(r.proof);
        setProofState('ready');
      } catch (e) {
        if (dead || ac.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) { cb.current.onUnauthorized(); return; }
        if (e instanceof ApiError && e.status === 410) { setProofState('expired'); return; }
        setProofErr(errMsg(e));
        setProofState('error');
      }
    })();
    return () => { dead = true; ac.abort(); };
  }, [proofId, phase, proofTick]);

  if (phase === 'loading') return <p role="status" className="dim">Loading sign-in settings…</p>;
  if (phase === 'error') {
    return (
      <section className="panel settings-panel integration-settings-card">
        <p role="alert" className="alert">Could not load sign-in settings: {loadErr}</p>
        <button type="button" className="btn button ghost" onClick={reload}>Try again</button>
      </section>
    );
  }

  return (
    <div className="account-settings identity-settings">
      {proofId && proofState === 'loading' && <p role="status" className="dim">Loading the sign-in result…</p>}
      {proofId && proofState === 'expired' && (
        <section className="panel settings-panel integration-settings-card">
          <h2>Sign-in expired</h2>
          <p role="alert" className="alert">This sign-in took too long and expired. Start the test or linking again.</p>
          <button type="button" className="btn button ghost" onClick={() => cb.current.onProofHandled()}>Dismiss</button>
        </section>
      )}
      {proofId && proofState === 'error' && (
        <section className="panel settings-panel integration-settings-card">
          <h2>Sign-in result</h2>
          <p role="alert" className="alert">Could not load the sign-in result: {proofErr}</p>
          <div className="row button-wrap">
            <button type="button" className="btn button ghost" onClick={() => setProofTick(t => t + 1)}>Try again</button>
            <button type="button" className="btn button ghost" onClick={() => cb.current.onProofHandled()}>Dismiss</button>
          </div>
        </section>
      )}
      {proofId && proofState === 'ready' && proof && proof.purpose !== 'account' && (
        <ProofReview
          key={proof.id}
          proof={proof}
          instanceOperator={instanceOperator}
          vaultOk={opData?.vaultConfigured === true}
          busy={busy}
          mutate={mutate}
          onDone={() => { cb.current.onProofHandled(); reload(); }}
          onCancel={() => cb.current.onProofHandled()}
          onExpire={() => setProofState('expired')}
        />
      )}
      {part !== 'operator' && <AccountSection providers={publicProviders} identities={identities} hasPassword={hasPassword} busy={busy} mutate={mutate} reload={reload} />}
      {part !== 'account' && instanceOperator && (opData
        ? <OperatorSection data={opData} busy={busy} mutate={mutate} reload={reload} />
        : (
          <section className="panel settings-panel integration-settings-card">
            <div className="provider-settings-heading"><span className="provider-initial"><AppIcon name="settings" size={18}/></span><div><h2>Identity providers (operator)</h2><p>Manage your installation’s sign-in providers</p></div></div>
            <p role="alert" className="alert">Your operator access changed or provider management is unavailable here. Operator access is granted explicitly on this host; owning a workspace does not grant it.</p>
            <button type="button" className="btn button ghost" onClick={reload}>Try again</button>
          </section>
        )
      )}
    </div>
  );
}

function ProofReview({proof, instanceOperator, vaultOk, busy, mutate, onDone, onCancel, onExpire}: {
  proof: ProofInfo; instanceOperator: boolean; vaultOk: boolean; busy: boolean; mutate: Mutate;
  onDone: () => void; onCancel: () => void; onExpire: () => void;
}) {
  const [err, setErr] = useState('');
  const canEnable = proof.purpose === 'test' && instanceOperator;

  const confirm = () => void mutate(async task => {
    setErr('');
    const url = proof.purpose === 'link'
      ? '/api/account/oidc/link/confirm'
      : '/api/identity/oidc/providers/' + encodeURIComponent(proof.providerId) + '/enable';
    try {
      await api(url, {method: 'POST', body: {proofId: proof.id}, signal: task.signal});
      if (!task.current()) return;
      onDone();
    } catch (e) {
      if (!task.current()) return;
      if (e instanceof ApiError && e.status === 410) { onExpire(); return; }
      task.fail(e, setErr);
    }
  });

  return (
    <section className="panel settings-panel integration-settings-card">
      <div className="provider-settings-heading"><span className="provider-initial"><AppIcon name="shield" size={18}/></span><div><h2>{proof.purpose === 'link' ? 'Review identity before linking' : 'Review test sign-in'}</h2><p>{proof.providerName}</p></div></div>
      <p>
        {proof.purpose === 'link'
          ? `Sign-in at ${proof.providerName} returned this identity. It is linked to your account only if you confirm below.`
          : `The test sign-in to ${proof.providerName} returned this identity.`}
        {' '}A matching email address does not mean it belongs to the same account.
      </p>
      <div className="table-wrap">
        <table style={{minWidth: '28rem'}}>
          <tbody>
            <tr><th scope="row">Provider</th><td>{proof.providerName}</td></tr>
            <tr><th scope="row">Issuer</th><td className="mono" style={{overflowWrap: 'anywhere'}}>{proof.issuer}</td></tr>
            <tr><th scope="row">Subject</th><td className="mono" style={{overflowWrap: 'anywhere'}}>{proof.subject}</td></tr>
            <tr><th scope="row">Email</th><td>{proof.email ? `${proof.email} (${proof.emailVerified ? 'verified by provider' : 'not verified'})` : 'None returned'}</td></tr>
            <tr><th scope="row">Expires</th><td>{new Date(proof.expiresAt).toLocaleString()}</td></tr>
          </tbody>
        </table>
      </div>
      {err && <p role="alert" className="alert">{err}</p>}
      <div className="row button-wrap">
        {proof.purpose === 'link' && <button type="button" className="btn button primary" disabled={busy} onClick={confirm}>Link this identity</button>}
        {canEnable && <button type="button" className="btn button primary" disabled={busy || !vaultOk} onClick={confirm}>Enable tested provider</button>}
        <button type="button" className="btn button ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {canEnable && !vaultOk && <p className="hint field-help">Secret storage (vault) is not configured on this host, so the provider cannot be enabled yet.</p>}
      {proof.purpose === 'test' && !instanceOperator && <p className="dim">Only an operator can enable this provider. Nothing else is required from you.</p>}
    </section>
  );
}

function AccountSection({providers, identities, hasPassword, busy, mutate, reload}: {
  providers: PublicProvider[]; identities: Identity[]; hasPassword: boolean; busy: boolean; mutate: Mutate; reload: () => void;
}) {
  const selId = useId();
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState('');
  const chosen = picked || providers[0]?.id || '';

  const startLink = (p: Proof) => mutate(async task => {
    setErr('');
    try {
      const r = await api<{authorizationUrl: string}>('/api/account/oidc/link/start', {method: 'POST', body: {providerId: chosen, proof: p}, signal: task.signal});
      if (!task.current()) return false;
      const u = httpUrl(r.authorizationUrl);
      if (!u) { setErr('The server returned an invalid sign-in address. Nothing was opened.'); return false; }
      window.location.assign(u);
      return true;
    } catch (e) {
      task.fail(e, setErr);
      return false;
    }
  });

  const remove = (id: string) => (p: Proof) => mutate(async task => {
    setErr('');
    try {
      await api('/api/account/oidc/identities/' + encodeURIComponent(id) + '/remove', {method: 'POST', body: {proof: p}, signal: task.signal});
      if (!task.current()) return false;
      reload();
      return true;
    } catch (e) {
      task.fail(e, setErr);
      return false;
    }
  });

  return (
    <section className="panel settings-panel integration-settings-card">
      <div className="provider-settings-heading"><span className="provider-initial"><AppIcon name="key" size={18}/></span><div><h2>Your sign-in methods</h2><p>Connect the identities you use to sign in</p></div></div>
      <p className="provider-source">{identities.length} linked {identities.length === 1 ? 'identity' : 'identities'}</p>
      {err && <p role="alert" className="alert">{err}</p>}
      {identities.length === 0 ? (
        <p className="dim">No external identities are linked to your account yet.</p>
      ) : (
        <div className="identity-provider-grid">
          {identities.map(i => (
            <section className="panel integration-settings-card identity-provider-card" key={i.id}>
              <div className="provider-settings-heading"><span className="provider-initial">{Array.from(i.providerName.trim())[0]?.toUpperCase() || 'I'}</span><div><h3>{i.providerName}</h3><p>Linked sign-in method</p></div>{i.enabled ? <span className="pill badge good configured">Enabled</span> : <span className="pill badge bad not-connected">Disabled</span>}</div>
              <dl className="identity-details"><dt>Issuer</dt><dd className="mono">{i.issuer}</dd><dt>Subject</dt><dd className="mono">{i.subject}</dd></dl>
              {hasPassword && <Disclosure summary="Remove…" variant="plain"><p className="hint field-help">Confirm with your password to remove this sign-in method.</p><ProofFields busy={busy} submit="Remove identity" onProof={remove(i.id)} /></Disclosure>}
            </section>
          ))}
        </div>
      )}
      <h3 className="settings-subheading">Link a new sign-in method</h3>
      <p className="hint field-help">You sign in at the provider, then review the returned identity here before anything is linked. Accounts are never merged by email alone.</p>
      {!hasPassword ? <p className="hint field-help">Use the Identity account security section on this page to verify with your linked provider and add a local recovery password before linking or removing sign-in methods.</p> : providers.length === 0 ? (
        <p className="dim">No external providers are enabled on this server yet.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={selId}>Provider</label>
            <select id={selId} value={chosen} disabled={busy} onChange={e => setPicked(e.target.value)}>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <ProofFields busy={busy} submit="Start linking" onProof={startLink} />
        </>
      )}
    </section>
  );
}

function OperatorSection({data, busy, mutate, reload}: {
  data: OpData; busy: boolean; mutate: Mutate; reload: () => void;
}) {
  const fid = useId();
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [auth, setAuth] = useState<'basic' | 'post'>('basic');
  const [origins, setOrigins] = useState('');
  const [addresses, setAddresses] = useState('');
  const [trustEmail, setTrustEmail] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const vaultMissing = !data.vaultConfigured;

  const reset = () => {
    setEditingId(null); setName(''); setIssuer(''); setClientId(''); setSecret('');
    setAuth('basic'); setOrigins(''); setAddresses(''); setTrustEmail(false);
    setErr(''); setSaved(false);
  };

  const edit = (p: OpProvider) => {
    setEditingId(p.id);
    setName(p.settings.name);
    setIssuer(p.settings.issuer);
    setClientId(p.settings.clientId);
    setSecret('');
    setAuth(p.settings.authentication);
    setOrigins(p.settings.allowedOrigins.join('\n'));
    setAddresses(p.settings.allowedAddresses.join('\n'));
    setTrustEmail(p.settings.trustVerifiedEmail);
    setErr('');
    setSaved(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.callbackUrl);
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current) setCopied(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setSaved(false);
    const o = lines(origins);
    const a = lines(addresses);
    if (o.length > 8) { setErr('At most 8 additional origins are allowed.'); return; }
    if (a.length > 16) { setErr('At most 16 address exceptions are allowed.'); return; }
    if (o.some(x => !x.startsWith('https://'))) { setErr('Additional origins must be HTTPS origins, one per line.'); return; }
    void mutate(async task => {
      const settings: Settings = {name, issuer, clientId, authentication: auth, allowedOrigins: o, allowedAddresses: a, trustVerifiedEmail: trustEmail};
      const body: {id?: string; settings: Settings; clientSecret: string} = editingId ? {id: editingId, settings, clientSecret: secret} : {settings, clientSecret: secret};
      setSecret('');
      try {
        await api('/api/identity/oidc/providers', {method: 'POST', body, signal: task.signal});
        if (!task.current()) return;
        setSaved(true);
        reload();
      } catch (e2) {
        task.fail(e2, setErr);
      }
    });
  };

  const test = (id: string) => (p: Proof) => mutate(async task => {
    setErr('');
    try {
      const r = await api<{authorizationUrl: string}>('/api/identity/oidc/providers/' + encodeURIComponent(id) + '/test', {method: 'POST', body: {proof: p}, signal: task.signal});
      if (!task.current()) return false;
      const u = httpUrl(r.authorizationUrl);
      if (!u) { setErr('The server returned an invalid sign-in address. Nothing was opened.'); return false; }
      window.location.assign(u);
      return true;
    } catch (e) {
      task.fail(e, setErr);
      return false;
    }
  });

  const disable = async (p: OpProvider) => {
    if (!await confirm({title: `Disable ${p.settings.name}?`, description: 'Its sessions are revoked. Accounts using only this provider lose access until it is re-enabled. Configured local recovery passwords remain usable.', confirmLabel: 'Disable provider'})) return;
    void mutate(async task => {
      setErr('');
      try {
        await api('/api/identity/oidc/providers/' + encodeURIComponent(p.id) + '/disable', {method: 'POST', body: {}, signal: task.signal});
        if (!task.current()) return;
        reload();
      } catch (e) {
        task.fail(e, setErr);
      }
    });
  };

  return (
    <section className="panel settings-panel integration-settings-card">
      <div className="provider-settings-heading"><span className="provider-initial"><AppIcon name="settings" size={18}/></span><div><h2>Identity providers (operator)</h2><p>Manage your installation’s sign-in providers</p></div></div>
      <p className="hint field-help">Operator access is granted explicitly on this host; owning a workspace does not grant it.</p>
      <div className="field">
        <label htmlFor={fid + '-cb'}>Callback URL — register this exact address with your identity provider</label>
        <div className="row button-wrap">
          <input id={fid + '-cb'} readOnly value={data.callbackUrl} className="mono" onFocus={e => e.target.select()} />
          <button type="button" className="btn button ghost" onClick={() => void copy()}>Copy</button>
        </div>
        {copied && <p role="status" className="hint field-help">Copied to clipboard.</p>}
      </div>
      {vaultMissing && <p role="alert" className="alert">Secret storage (vault) is not configured on this host. An operator must finish the host setup before drafts can be saved, tested, or enabled.</p>}
      {err && <p role="alert" className="alert">{err}</p>}
      {data.providers.length === 0 ? (
        <p className="dim">No providers configured yet. Create a draft below.</p>
      ) : (
        <>
          <p className="hint field-help">Saving a draft does not change the live provider; enabling requires a successful test sign-in. Disabling revokes its sessions. Users with only this provider lose access until it is re-enabled; configured local recovery passwords remain usable.</p>
          {data.providers.map(p => (
            <div className="panel integration-settings-card identity-provider-card" key={p.id}>
              <div className="provider-settings-heading"><span className="provider-initial">{Array.from(p.settings.name.trim())[0]?.toUpperCase() || 'I'}</span><div><h3>{p.settings.name}</h3><p>{p.settings.issuer}</p></div>{p.enabled ? <span className="pill badge good configured">Enabled</span> : <span className="pill badge bad not-connected">Disabled</span>}</div>
              <p className="provider-source">Draft revision {p.revision} · Live revision {p.activeRevision ?? 'none'}{p.testedRevision != null && ` · Tested revision ${p.testedRevision}`}{p.testedAt && ` (${new Date(p.testedAt).toLocaleString()})`}</p>
              <div className="button-wrap"><button type="button" className="btn button ghost" disabled={busy} onClick={() => edit(p)}>Edit draft</button>{p.enabled && <button type="button" className="btn button ghost" disabled={busy} onClick={() => void disable(p)}>Disable</button>}</div>
              <Disclosure summary="Test sign-in" variant="plain">
                <p className="hint field-help">Confirm with your password to start a test sign-in at the provider.</p>
                <ProofFields busy={busy || vaultMissing} submit="Start test sign-in" onProof={test(p.id)} />
              </Disclosure>
            </div>
          ))}
        </>
      )}
      <h3 className="settings-subheading">{editingId ? 'Edit draft' : 'New draft'}</h3>
      <form onSubmit={save}>
        <fieldset disabled={busy || vaultMissing} style={{border: 0, margin: 0, padding: 0, minWidth: 0}}>
        <div className="field">
          <label htmlFor={fid + '-n'}>Display name</label>
          <input id={fid + '-n'} required maxLength={120} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-i'}>Issuer URL</label>
          <input id={fid + '-i'} type="url" required maxLength={2048} value={issuer} onChange={e => setIssuer(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-c'}>Client ID</label>
          <input id={fid + '-c'} required maxLength={512} value={clientId} onChange={e => setClientId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={fid + '-s'}>Client secret</label>
          <input id={fid + '-s'} type="password" autoComplete="new-password" maxLength={4096} value={secret} onChange={e => setSecret(e.target.value)} />
          <p className="hint field-help">Saving replaces the stored secret; it cannot be viewed afterwards. Public clients use the form-body option with an empty secret.</p>
        </div>
        <div className="field">
          <label htmlFor={fid + '-a'}>Client authentication</label>
          <select id={fid + '-a'} value={auth} onChange={e => setAuth(e.target.value as 'basic' | 'post')}>
            <option value="basic">HTTP Basic</option>
            <option value="post">Form body / public client</option>
          </select>
        </div>
        <Disclosure summary="Advanced network options" variant="plain">
          <div className="field">
            <label htmlFor={fid + '-o'}>Additional allowed origins — HTTPS, one per line, max 8</label>
            <textarea id={fid + '-o'} rows={3} value={origins} onChange={e => setOrigins(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={fid + '-d'}>Private provider addresses — IPs, one per line, max 16</label>
            <textarea id={fid + '-d'} rows={3} value={addresses} onChange={e => setAddresses(e.target.value)} />
            <p className="hint field-help">Only list addresses here when you deliberately run the identity provider inside a private network.</p>
          </div>
          <div className="field">
            <label htmlFor={fid + '-t'}>
              <input id={fid + '-t'} type="checkbox" checked={trustEmail} onChange={e => setTrustEmail(e.target.checked)} /> Trust verified email
            </label>
            <p className="hint field-help">Uses the provider's verified email to confirm invited users only. It never merges existing accounts.</p>
          </div>
        </Disclosure>
        {saved && <p role="status" className="hint field-help">Draft saved. It does not change the live provider until it is enabled after a successful test sign-in.</p>}
        <div className="row button-wrap">
          <button type="submit" className="btn button primary" disabled={busy || vaultMissing}>{editingId ? 'Save draft' : 'Create draft'}</button>
          {editingId && <button type="button" className="btn button ghost" onClick={reset}>Cancel editing</button>}
        </div>
        </fieldset>
      </form>
      {confirmDialog}
    </section>
  );
}

function ProofFields({busy, submit, onProof}: {busy: boolean; submit: string; onProof: (p: Proof) => Promise<boolean | undefined>}) {
  const id = useId();
  const [password, setPassword] = useState('');
  const [factor, setFactor] = useState<'none' | 'code' | 'backup'>('none');
  const [code, setCode] = useState('');
  return (
    <form onSubmit={e => {
      e.preventDefault();
      const p: Proof = {password};
      if (factor === 'code') p.code = code;
      else if (factor === 'backup') p.backupCode = code;
      setPassword(''); setCode(''); setFactor('none');
      void onProof(p).catch(() => undefined);
    }}>
      <fieldset disabled={busy} style={{border: 0, margin: 0, padding: 0, minWidth: 0}}>
      <div className="field">
        <label htmlFor={id + '-pw'}>Current password</label>
        <input id={id + '-pw'} type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={id + '-fa'}>Second factor</label>
        <select id={id + '-fa'} value={factor} onChange={e => setFactor(e.target.value as 'none' | 'code' | 'backup')}>
          <option value="none">None</option>
          <option value="code">Authenticator code</option>
          <option value="backup">Recovery code</option>
        </select>
      </div>
      {factor !== 'none' && (
        <div className="field">
          <label htmlFor={id + '-co'}>{factor === 'code' ? 'Authenticator code' : 'Recovery code'}</label>
          <input id={id + '-co'} type="text" inputMode={factor === 'code' ? 'numeric' : 'text'} autoComplete="one-time-code" required maxLength={factor === 'code' ? 6 : 21} value={code} onChange={e => setCode(e.target.value)} />
        </div>
      )}
      <button type="submit" className="btn button primary" disabled={busy}>{submit}</button>
      </fieldset>
    </form>
  );
}
