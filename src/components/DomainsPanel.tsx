import {useEffect, useRef, useState, type FormEvent} from 'react';
import { DataTable, useConfirmDialog } from '@ten98/ui'
import {api, ApiError, errMsg} from '../lib/api';

type Domain = {
  id: string;
  hostname: string;
  role: 'canonical' | 'serving' | 'redirect_alias';
  expectedTargetHost: string | null;
  status: 'unverified' | 'pending' | 'verified' | 'expired' | 'revoked';
  createdAt: string;
  verifiedAt: string | null;
  challengeExpiresAt: string | null;
};

type State = {
  project: {id: string; origin: string; canonicalHost: string; canonicalVerifiable: boolean};
  domains: Domain[];
  limit: 50;
};

type Challenge = {domainId: string; name: string; type: 'TXT'; value: string; expiresAt: string};

type Props = {projectId: string; userId: string; onUnauthorized: () => void; onInstallTracker: () => void};

const ROLE_LABEL: Record<Domain['role'], string> = {
  canonical: 'Project website',
  serving: 'Website pages',
  redirect_alias: 'Redirect only',
};

const STATUS_LABEL: Record<Domain['status'], string> = {
  unverified: 'Not verified',
  pending: 'Proof pending',
  verified: 'Verified',
  expired: 'Expired',
  revoked: 'Revoked',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function DomainsPanel(props: Props) {
  // Keyed inner component: any identity change remounts it, aborting in-flight
  // requests and dropping every one-time proof value held in memory.
  return <DomainsPanelInner key={`${props.projectId}:${props.userId}`} {...props} />;
}

function DomainsPanelInner({projectId, onUnauthorized, onInstallTracker}: Props) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/domains`;
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true });

  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proof, setProof] = useState<Challenge | null>(null);
  const [addHost, setAddHost] = useState('');
  const [addRole, setAddRole] = useState<'serving' | 'redirect_alias'>('serving');
  const [addTarget, setAddTarget] = useState('');
  const [edit, setEdit] = useState<{id: string; role: 'serving' | 'redirect_alias'; target: string} | null>(null);

  const aliveRef = useRef(true);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lockRef = useRef(false);
  const proofVersion = useRef(0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  const nameRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef<HTMLTextAreaElement | null>(null);
  const proofRef = useRef<HTMLHeadingElement | null>(null);
  const editRef = useRef<HTMLHeadingElement | null>(null);
  const addRef = useRef<HTMLDetailsElement | null>(null);
  const addedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!proof) return;
    proofRef.current?.focus();
    proofRef.current?.scrollIntoView({block: 'nearest'});
  }, [proof]);

  useEffect(() => {
    if (!edit) return;
    editRef.current?.focus();
    editRef.current?.scrollIntoView({block: 'nearest'});
  }, [edit?.id]);

  useEffect(() => {
    if (!addedRef.current) return;
    const row = document.getElementById(`domain-${addedRef.current}`);
    row?.focus();
    row?.scrollIntoView({block: 'nearest'});
    addedRef.current = null;
  }, [state]);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  function replaceProof(value: Challenge | null) {
    proofVersion.current += 1;
    setProof(value);
  }

  async function load() {
    if (lockRef.current) return;
    lockRef.current = true;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const gen = ++genRef.current;
    const current = () => aliveRef.current && gen === genRef.current && !ctrl.signal.aborted;
    setLoading(true);
    setError(null);
    try {
      const s = await api<State>(base, {signal: ctrl.signal});
      if (!current()) return;
      setDenied(false);
      setRefreshRequired(false);
      setState(s);
      setError(null);
    } catch (e) {
      if (!current()) return;
      setRefreshRequired(true);
      handleError(e);
    } finally {
      if (current()) {
        lockRef.current = false;
        setLoading(false);
      }
    }
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        setState(null);
        replaceProof(null);
        setEdit(null);
        setDenied(true);
        onUnauthorizedRef.current();
        return;
      }
      if (e.status === 403 || e.status === 404) {
        setState(null);
        replaceProof(null);
        setEdit(null);
        setDenied(true);
        setError('This project is unavailable or you no longer have access to it. Domain management is hidden.');
        return;
      }
    }
    setError(errMsg(e));
  }

  useEffect(() => {
    aliveRef.current = true;
    lockRef.current = false;
    void load();
    return () => {
      aliveRef.current = false;
      genRef.current += 1;
      proofVersion.current += 1;
      abortRef.current?.abort();
    };
    // Mount-once: identity changes remount this component via the keyed wrapper.
  }, []);

  async function runMutation(fn: (signal: AbortSignal, current: () => boolean) => Promise<void>, mapError?: (e: unknown) => string | null) {
    if (lockRef.current || denied || !state || refreshRequired) return;
    lockRef.current = true;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const gen = ++genRef.current;
    const current = () => aliveRef.current && gen === genRef.current && !ctrl.signal.aborted;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn(ctrl.signal, current);
    } catch (e) {
      if (current()) {
        if (e instanceof ApiError && e.status === 409) {
          replaceProof(null);
          setEdit(null);
          const message = errMsg(e);
          try {
            const fresh = await api<State>(base, {signal: ctrl.signal});
            if (!current()) return;
            setState(fresh);
            setRefreshRequired(false);
            setError(`${message} The list has been refreshed.`);
          } catch (refreshError) {
            if (!current()) return;
            if (refreshError instanceof ApiError && [401, 403, 404].includes(refreshError.status)) handleError(refreshError);
            else {
              setRefreshRequired(true);
              setError(`${message} Refresh failed: ${errMsg(refreshError)}`);
            }
          }
          return;
        }
        const mapped = mapError ? mapError(e) : null;
        if (mapped) setError(mapped);
        else {
          if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
            setRefreshRequired(true);
            replaceProof(null);
          }
          handleError(e);
        }
      }
    } finally {
      if (current()) {
        lockRef.current = false;
        setBusy(false);
      }
    }
  }

  const onRefresh = () => {
    if (lockRef.current) return;
    replaceProof(null); // a refresh can never retrieve a proof value
    setEdit(null);
    setNotice(null);
    void load();
  };

  const canonicalOk = state?.project.canonicalVerifiable ?? false;
  const atLimit = state ? state.domains.length >= state.limit : false;
  const controlsOff = loading || busy || refreshRequired;
  const canonical = state?.domains.find(d => d.role === 'canonical');
  const editingDomain = edit && state ? state.domains.find((d) => d.id === edit.id) ?? null : null;

  const onAdd = (ev: FormEvent) => {
    ev.preventDefault();
    if (!state || lockRef.current || denied) return;
    const hostname = addHost.trim();
    if (!hostname) {
      setError('Enter a hostname, for example old.example.com.');
      return;
    }
    const target = addTarget.trim();
    if (addRole === 'redirect_alias' && !target && !canonicalOk) {
      setError('Enter the expected target hostname for this alias — this project origin cannot be used as the default target.');
      return;
    }
    void runMutation(async (signal, current) => {
      const body: {hostname: string; role: string; expectedTargetHost?: string} = {hostname, role: addRole};
      if (addRole === 'redirect_alias' && target) body.expectedTargetHost = target;
      const s = await api<State>(base, {method: 'POST', body, signal});
      if (!current()) return;
      addedRef.current = s.domains.find(row => !state.domains.some(old => old.id === row.id))?.id ?? null;
      setState(s);
      replaceProof(null);
      setAddHost('');
      setAddRole('serving');
      setAddTarget('');
      if (addRef.current) addRef.current.open = false;
      setNotice(`Added ${hostname}.`);
    });
  };

  const onSaveEdit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!edit || !state || lockRef.current || denied) return;
    const current = edit;
    const target = current.target.trim();
    if (current.role === 'redirect_alias' && !target && !canonicalOk) {
      setError('Enter the expected target hostname for this alias.');
      return;
    }
    void runMutation(async (signal, isCurrent) => {
      const body: {role: string; expectedTargetHost?: string} = {role: current.role};
      if (current.role === 'redirect_alias' && target) body.expectedTargetHost = target;
      const s = await api<State>(`${base}/${encodeURIComponent(current.id)}/update`, {method: 'POST', body, signal});
      if (!isCurrent()) return;
      setState(s);
      replaceProof(null);
      setEdit(null);
      setNotice('Changes saved.');
    });
  };

  const onChallenge = async (d: Domain) => {
    if (lockRef.current || denied) return;
    if (d.status === 'pending' || d.status === 'verified') {
      const ok = await confirm({
        title: `Replace the DNS proof for ${d.hostname}?`,
        description: 'Verification is cleared immediately. A serving domain stops accepting new collection until reverified; visitors must renew consent. The canonical project origin remains allowed.',
        confirmLabel: 'Replace DNS proof',
      });
      if (!ok || lockRef.current) return;
    }
    replaceProof(null);
    void runMutation(async (signal, current) => {
      const r = await api<{state: State; challenge: Challenge}>(`${base}/${encodeURIComponent(d.id)}/challenge`, {method: 'POST', body: {}, signal});
      if (!current()) return;
      setState(r.state);
      replaceProof(r.challenge);
      setNotice('DNS proof created. Add the TXT record below at your DNS provider — the value is shown only once.');
    });
  };

  const onVerify = (d: Domain) => {
    void runMutation(
      async (signal, current) => {
        const s = await api<State>(`${base}/${encodeURIComponent(d.id)}/verify`, {method: 'POST', body: {}, signal});
        if (!current()) return;
        setState(s);
        replaceProof(null);
        const verifiedAt = s.domains.find((x) => x.id === d.id)?.verifiedAt;
        setNotice(verifiedAt ? `Control verified on ${fmt(verifiedAt)}.` : 'Control verified.');
      },
      (e) => {
        if (e instanceof ApiError && e.status === 422)
          return 'No matching TXT record is visible in DNS yet. Propagation can take time — confirm the record at your DNS provider and try again.';
        if (e instanceof ApiError && e.status === 503) return 'The DNS lookup failed temporarily. Try again shortly.';
        return null;
      },
    );
  };

  const onRevoke = async (d: Domain) => {
    if (lockRef.current || denied) return;
    if (!await confirm({title: `Revoke the proof for ${d.hostname}?`, description: 'A serving domain stops accepting collection immediately. The canonical project origin remains allowed. You can create a new proof later.', confirmLabel: 'Revoke proof'})) return;
    if (lockRef.current) return;
    void runMutation(async (signal, current) => {
      const s = await api<State>(`${base}/${encodeURIComponent(d.id)}/revoke`, {method: 'POST', body: {}, signal});
      if (!current()) return;
      setState(s);
      replaceProof(null);
      setNotice('Proof revoked; verification cleared.');
    });
  };

  const onRemove = async (d: Domain) => {
    if (lockRef.current || denied) return;
    if (!await confirm({title: `Remove ${d.hostname} from this project?`, description: 'A verified serving domain stops accepting collection immediately. This cannot be undone.', confirmLabel: 'Remove domain'})) return;
    if (lockRef.current) return;
    void runMutation(async (signal, current) => {
      const s = await api<State>(`${base}/${encodeURIComponent(d.id)}/remove`, {method: 'POST', body: {}, signal});
      if (!current()) return;
      setState(s);
      replaceProof(null);
      setEdit((cur) => (cur && cur.id === d.id ? null : cur));
      setNotice('Domain removed.');
    });
  };

  const copy = async (text: string, which: 'name' | 'value') => {
    const version = proofVersion.current;
    const current = () => aliveRef.current && version === proofVersion.current;
    try {
      await navigator.clipboard.writeText(text);
      if (!current()) return;
      setNotice('Copied to clipboard.');
    } catch {
      if (!current()) return;
      const el = which === 'name' ? nameRef.current : valueRef.current;
      if (el) {
        el.focus();
        el.select();
      }
      setError('Automatic copy failed. The field is selected — copy it with your keyboard shortcut.');
    }
  };

  const onDismissProof = () => {
    replaceProof(null);
    setError(null);
    setNotice('Proof value dismissed. It cannot be shown again — a new proof would replace it.');
  };

  return (
    <section className="card domains-panel" aria-labelledby="domains-panel-title">
      <div className="row between">
        <h2 id="domains-panel-title">Domains and aliases</h2>
        <button type="button" className="btn ghost" onClick={onRefresh} disabled={loading || busy}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="banner alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}

      {loading && !state && !denied && <p className="dim">Loading domains…</p>}
      {loading && state && <p className="dim" role="status">Refreshing domains. The last loaded settings are shown below.</p>}
      {refreshRequired && state && <p className="alert" role="status">These are the last loaded settings. Refresh before making further changes.</p>}
      {busy && <p className="dim" role="status">Updating domain settings…</p>}

      {state && !denied && (
        <>
          <section className="field domain-website" aria-labelledby="domain-website-title">
            <h3 id="domain-website-title">Your website</h3>
            <p className="domain-origin"><bdi dir="ltr">{state.project.origin}</bdi> <span className="pill">Project origin</span></p>
            <dl className="domain-facts">
              <div><dt>Collection origin</dt><dd>Origin allowed</dd></div>
              <div><dt>DNS ownership</dt><dd>{!canonicalOk ? 'Not available for this origin' : canonical ? <>{STATUS_LABEL[canonical.status]}{canonical.status === 'verified' && canonical.verifiedAt ? ` on ${fmt(canonical.verifiedAt)}` : ' — optional for the canonical origin'}</> : 'Not verified — optional for the canonical origin'}</dd></div>
            </dl>
            <p className="hint">This allows the exact project origin. Collection settings, privacy choices and browser privacy signals still determine what is recorded.</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={controlsOff} onClick={onInstallTracker}>Install tracker</button>
              {canonical && canonicalOk && canonical.status !== 'verified' && canonical.status !== 'pending' && <button type="button" className="btn" disabled={controlsOff} onClick={() => void onChallenge(canonical)}>Verify DNS ownership</button>}
              {canonical && canonical.status === 'pending' && <button type="button" className="btn" disabled={controlsOff || !canonical.challengeExpiresAt || Date.parse(canonical.challengeExpiresAt) <= Date.now()} onClick={() => onVerify(canonical)}>Check DNS proof</button>}
            </div>
            {canonical && ['pending', 'verified'].includes(canonical.status) && <details className="domain-manage"><summary>Manage DNS ownership</summary><div className="row"><button type="button" className="btn" disabled={controlsOff} onClick={() => void onChallenge(canonical)}>Replace DNS proof</button><button type="button" className="btn ghost" disabled={controlsOff} onClick={() => void onRevoke(canonical)}>Revoke proof</button></div></details>}
            {!state.project.canonicalVerifiable && (
              <p className="hint">
                DNS ownership verification is unavailable for this local, IP or otherwise ineligible hostname.
                You can still add public domain entries below.
              </p>
            )}
            <details><summary>Technical details</summary><p className="hint">The project origin is fixed. DNS ownership is a point-in-time proof and is not required to use the tracker at that exact origin. Verifying it does not change DNS, discover backlinks or confirm that the tracker is installed.</p></details>
          </section>

          {proof && (
            <div className="field" role="region" aria-label="One-time DNS proof">
              <h3 ref={proofRef} tabIndex={-1}>DNS proof for <bdi dir="ltr">{state.domains.find(d => d.id === proof.domainId)?.hostname}</bdi> — shown only once</h3>
              <p className="hint">
                Add this exact TXT record at your DNS provider, then choose “Check DNS proof”. Providers differ in
                whether they expect a relative or a full record name — follow your provider’s format. We never change
                your DNS for you.
              </p>
              <label htmlFor="dom-proof-name">Record name</label>
              <textarea
                id="dom-proof-name"
                ref={nameRef}
                className="snippet mono"
                readOnly
                rows={1}
                value={proof.name}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="row">
                <span className="pill">Type: {proof.type}</span>
                <span className="hint">Expires {fmt(proof.expiresAt)}</span>
              </div>
              <label htmlFor="dom-proof-value">Record value</label>
              <textarea
                id="dom-proof-value"
                ref={valueRef}
                className="snippet mono"
                readOnly
                rows={3}
                value={proof.value}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="row">
                <button type="button" className="btn" disabled={controlsOff} onClick={() => void copy(proof.name, 'name')}>
                  Copy name
                </button>
                <button type="button" className="btn" disabled={controlsOff} onClick={() => void copy(proof.value, 'value')}>
                  Copy value
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={controlsOff || Date.parse(proof.expiresAt) <= Date.now()}
                  onClick={() => {
                    const d = state.domains.find((x) => x.id === proof.domainId);
                    if (d) onVerify(d);
                  }}
                >
                  Check DNS proof
                </button>
                <button type="button" className="btn ghost" onClick={onDismissProof}>
                  Dismiss proof value
                </button>
              </div>
              <p className="footnote">Save the record before dismissing — the value cannot be retrieved again.</p>
            </div>
          )}

          <h3>Other domains and redirect aliases</h3>
          <p className="hint">Verified serving domains can use this project’s snippet at their exact HTTPS origin on port 443. Add each subdomain separately. Additional domains cannot use other ports. Redirect aliases never enable collection.</p>
          <details className="domain-add" ref={addRef}>
            <summary>Add another domain</summary>
          <form className="field" onSubmit={onAdd} aria-label="Add a domain">
            <label htmlFor="dom-add-host">Hostname</label>
            <input
              id="dom-add-host"
              value={addHost}
              onChange={(e) => setAddHost(e.target.value)}
              placeholder="old.example.com"
              required
              maxLength={1024}
              autoComplete="off"
              disabled={controlsOff || atLimit}
            />
            <span className="hint">Hostname only — no scheme, path, port, wildcard, or credentials.</span>

            <label htmlFor="dom-add-role">Purpose</label>
            <select
              id="dom-add-role"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value === 'redirect_alias' ? 'redirect_alias' : 'serving')}
              disabled={controlsOff || atLimit}
            >
              <option value="serving">Website pages — use this project’s tracker</option>
              <option value="redirect_alias">Redirect only — does not enable collection</option>
            </select>
            <p className="hint">{addRole === 'serving' ? 'Verify DNS ownership before this additional HTTPS origin can use the tracker.' : 'Record an alias and, after verifying ownership, check its HTTP redirect manually.'}</p>

            {addRole === 'redirect_alias' && (
              <>
                <label htmlFor="dom-add-target">Expected target hostname</label>
                <input
                  id="dom-add-target"
                  value={addTarget}
                  onChange={(e) => setAddTarget(e.target.value)}
                  placeholder={canonicalOk ? state.project.canonicalHost : 'target.example.com'}
                  maxLength={1024}
                  autoComplete="off"
                  disabled={controlsOff || atLimit}
                />
                <span className="hint">
                  Intended configuration, not a detected redirect.
                  {canonicalOk ? ' Leave empty to target the canonical hostname.' : ''}
                </span>
              </>
            )}

            <div className="row">
              <button type="submit" className="btn primary" disabled={controlsOff || atLimit}>
                Add domain
              </button>
              {atLimit && (
                <span className="hint">Limit reached: {state.limit} domains per project, including the canonical entry.</span>
              )}
            </div>
          </form>
          </details>

          {state.domains.every(d => d.role === 'canonical') ? (
            <p className="dim">Your project website is already listed. Add another domain only if you serve pages or keep redirect aliases elsewhere.</p>
          ) : (
            <div className="domain-table">
              <DataTable caption="Additional domains" captionHidden responsive="stack" searchable={false} sortable={false} pagination={false} rows={state.domains.filter(d => d.role !== 'canonical')} rowKey={d => d.id}
                columns={[
                  { key: 'hostname', header: 'Hostname', rowHeader: true, wrap: true, render: d => <bdi dir="ltr" className="mono" id={`domain-${d.id}`} tabIndex={-1}>{d.hostname}</bdi> },
                  { key: 'purpose', header: 'Purpose', wrap: true, render: d => <>{ROLE_LABEL[d.role]}{d.expectedTargetHost && <p className="hint">Expected target: <bdi dir="ltr">{d.expectedTargetHost}</bdi></p>}</> },
                  { key: 'origin', header: 'Collection origin', wrap: true, render: d => d.role === 'redirect_alias' ? 'Not allowed by this alias' : d.status === 'verified' ? <><strong>Origin allowed</strong><p className="hint"><bdi dir="ltr">https://{d.hostname}</bdi></p></> : 'Verify ownership first' },
                  { key: 'dns', header: 'DNS ownership', wrap: true, render: d => <>
                    <span className={d.status === 'verified' ? 'pill good' : d.status === 'expired' || d.status === 'revoked' ? 'pill bad' : 'pill'}>{STATUS_LABEL[d.status]}</span>
                    <div className="hint">{d.status === 'verified' && d.verifiedAt ? `Control verified on ${fmt(d.verifiedAt)}` : d.status === 'pending' ? `Proof expires ${fmt(d.challengeExpiresAt)}` : d.status === 'expired' && d.challengeExpiresAt ? `Expired ${fmt(d.challengeExpiresAt)}` : null}</div></> },
                  { key: 'actions', header: 'Actions', wrap: true, render: d => { const pendingLive = d.status === 'pending' && d.challengeExpiresAt !== null && Date.parse(d.challengeExpiresAt) > Date.now(); return (
                          <div className="row">
                              <button
                                type="button"
                                className="btn ghost"
                                disabled={controlsOff}
                                onClick={() => {
                                  setEdit({
                                    id: d.id,
                                    role: d.role === 'redirect_alias' ? 'redirect_alias' : 'serving',
                                    target: d.expectedTargetHost ?? '',
                                  });
                                  setError(null);
                                }}
                              >
                                Edit
                              </button>
                            {(d.status === 'unverified' || d.status === 'expired' || d.status === 'revoked') && (
                              <button type="button" className="btn" disabled={controlsOff} onClick={() => void onChallenge(d)}>
                                Create DNS proof
                              </button>
                            )}
                            {(d.status === 'pending' || d.status === 'verified') && (
                              <button type="button" className="btn" disabled={controlsOff} onClick={() => void onChallenge(d)}>
                                Replace DNS proof
                              </button>
                            )}
                            {pendingLive && (
                              <button type="button" className="btn primary" disabled={controlsOff} onClick={() => onVerify(d)}>
                                Check DNS proof
                              </button>
                            )}
                            {(d.status === 'pending' || d.status === 'verified') && (
                              <button type="button" className="btn ghost" disabled={controlsOff} onClick={() => void onRevoke(d)}>
                                Revoke proof
                              </button>
                            )}
                              <button type="button" className="btn ghost" disabled={controlsOff} onClick={() => void onRemove(d)}>
                                Remove
                              </button>
                            {d.role==='redirect_alias' && <RedirectChecks key={`${d.id}:${d.expectedTargetHost}:${d.verifiedAt}:${d.status}`} base={`${base}/${d.id}/redirect-checks`} domain={d} parentBusy={controlsOff} onAccessLoss={handleError} />}
                          </div> ); } },
                ]} />
            </div>
          )}
          <details><summary>About ownership and redirect checks</summary><p className="footnote">
            Expected targets are intended configuration. A manual HTTP check observes only that moment’s redirect chain,
            never visitor counts, backlinks or JavaScript/meta-refresh navigation. “Control verified” records when a DNS
            proof matched. Serving eligibility changes require visitors to renew consent.
          </p></details>

          {edit && editingDomain && (
            <form className="field" onSubmit={onSaveEdit} aria-label={`Edit ${editingDomain.hostname}`}>
              <h3 ref={editRef} tabIndex={-1}>
                Edit <span className="mono">{editingDomain.hostname}</span>
              </h3>
              <span className="hint">The hostname itself cannot be changed.</span>
              <label htmlFor="dom-edit-role">Purpose</label>
              <select
                id="dom-edit-role"
                value={edit.role}
                onChange={(e) => setEdit({...edit, role: e.target.value === 'redirect_alias' ? 'redirect_alias' : 'serving'})}
                disabled={controlsOff}
              >
                <option value="serving">Website pages</option>
                <option value="redirect_alias">Redirect only</option>
              </select>
              {edit.role === 'redirect_alias' && (
                <>
                  <label htmlFor="dom-edit-target">Expected target hostname</label>
                  <input
                    id="dom-edit-target"
                    value={edit.target}
                    onChange={(e) => setEdit({...edit, target: e.target.value})}
                    placeholder={canonicalOk ? state.project.canonicalHost : 'target.example.com'}
                    maxLength={1024}
                    autoComplete="off"
                    disabled={controlsOff}
                  />
                  <span className="hint">
                    Intended configuration, not a detected redirect.
                    {canonicalOk ? ' Leave empty to target the canonical hostname.' : ''}
                  </span>
                </>
              )}
              <div className="row">
                <button type="submit" className="btn primary" disabled={controlsOff}>
                  Save changes
                </button>
                <button type="button" className="btn ghost" disabled={controlsOff} onClick={() => setEdit(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}


        </>
      )}
      {confirmDialog}
    </section>
  );
}

type RedirectCheck={id:string;status:'queued'|'running'|'completed'|'stale'|'failed';createdAt:string;startedAt:string|null;completedAt:string|null;
  expected:{hostname:string;targetHostname:string;verifiedAt:string;revision:string};currentConfiguration:boolean;evidenceExpired:boolean;diagnostic:string|null;
  observation:{outcome:'response'|'blocked'|'unavailable'|'timeout'|'loop'|'hop_limit';finalUrl:string|null;targetMatches:boolean|null;durationMs:number;
    hops:{url:string;status:number;durationMs:number;location:string|null}[]}|null};
type RedirectState={domainId:string;eligible:boolean;checks:RedirectCheck[];nextAllowedAt:string|null};
const outcomeLabel={response:'Final HTTP response',blocked:'Blocked by network safety rules',unavailable:'Response unavailable',timeout:'Check timed out',loop:'Redirect loop',hop_limit:'Eight-redirect limit reached'};
function RedirectChecks({base,domain,parentBusy,onAccessLoss}:{base:string;domain:Domain;parentBusy:boolean;onAccessLoss:(error:unknown)=>void}){
  const [state,setState]=useState<RedirectState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[denied,setDenied]=useState(false);
  const [retry,setRetry]=useState(false);
  const alive=useRef(true),generation=useRef(0),lock=useRef(false),abort=useRef<AbortController|null>(null),requestId=useRef<string|null>(null),access=useRef(onAccessLoss);
  access.current=onAccessLoss;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;abort.current?.abort();};},[]);
  async function run(start=false){
    if(lock.current||denied||parentBusy)return;
    lock.current=true;abort.current?.abort();const controller=new AbortController();abort.current=controller;
    const epoch=++generation.current,current=()=>alive.current&&generation.current===epoch&&!controller.signal.aborted;
    setBusy(true);setError(null);
    try{
      if(start){
        requestId.current??=crypto.randomUUID();
        const result=await api<{state:RedirectState}>(base,{method:'POST',body:{requestId:requestId.current},signal:controller.signal});
        if(!current())return;requestId.current=null;setRetry(false);setState(result.state);
      }else{
        const result=await api<RedirectState>(base,{signal:controller.signal});if(!current())return;setState(result);
      }
    }catch(failure){
      if(!current())return;
      if(failure instanceof ApiError&&[401,403,404].includes(failure.status)){
        setState(null);setDenied(true);requestId.current=null;setRetry(false);access.current(failure);return;
      }
      if(start){
        const ambiguous=!(failure instanceof ApiError)||failure.status===0||failure.status>=500;
        if(!ambiguous)requestId.current=null;setRetry(ambiguous);
      }
      // A failed refresh keeps the last observation, explicitly labelled as not refreshed.
      setError(`${start?'The check request was not confirmed.':'History was not refreshed; the last loaded result remains below.'} ${errMsg(failure)}`);
    }finally{if(current()){lock.current=false;setBusy(false);}}
  }
  const active=state?.checks.some(check=>check.status==='queued'||check.status==='running')??false;
  const cooldown=!!state?.nextAllowedAt&&Date.parse(state.nextAllowedAt)>Date.now();
  return <details className="field" onToggle={event=>{if(event.currentTarget.open&&!state&&!busy&&!denied)void run();}} style={{minWidth:220,maxWidth:460,whiteSpace:'normal'}}>
    <summary>HTTP redirect checks</summary>
    <p className="hint">Manual, headers-only observation. Up to eight redirects; no JavaScript, visitor counting or automatic polling. Query strings and fragments are never saved.</p>
    {error&&<p role="alert" className="alert">{error}</p>}
    {busy&&<p role="status">Updating redirect history…</p>}
    {!denied&&<div className="row">
      <button type="button" className="btn" onClick={()=>void run(true)} disabled={busy||parentBusy||domain.status!=='verified'||(!retry&&(active||cooldown))}>{retry?'Retry check request':'Check redirect'}</button>
      <button type="button" className="btn ghost" onClick={()=>void run()} disabled={busy||parentBusy}>Refresh checks</button>
    </div>}
    {domain.status!=='verified'&&<p className="hint">Verify this alias with its DNS proof before checking redirects.</p>}
    {active&&<p className="hint">A check is queued or running. Refresh to see its outcome.</p>}
    {!active&&cooldown&&<p className="hint">Next check after {fmt(state!.nextAllowedAt)}. Refresh when ready.</p>}
    {state&&!state.checks.length&&<p className="hint">No redirect checks have been run.</p>}
    {state?.checks.map(check=><article className="field" key={check.id} aria-label={`Redirect check ${fmt(check.createdAt)}`} style={{overflowWrap:'anywhere'}}>
      <strong>{check.status==='completed'?'Check finished':check.status==='stale'?'Configuration or access changed':check.status==='failed'?'Check unavailable':check.status==='queued'?'Queued':'Running'}</strong>
      <p className="hint">Started {fmt(check.startedAt??check.createdAt)} · Expected {check.expected.targetHostname}</p>
      {!check.currentConfiguration&&<p className="hint">Historical configuration; this check does not describe the current alias settings.</p>}
      {check.diagnostic&&<p>{check.diagnostic}</p>}
      {check.evidenceExpired&&<p>Observation expired under workspace retention. Only this check receipt remains.</p>}
      {check.observation&&<>
        <p>{outcomeLabel[check.observation.outcome]} · {check.observation.durationMs} ms</p>
        {check.observation.targetMatches!==null&&<p>{check.observation.targetMatches?'Final hostname matched the expected hostname.':'Final hostname did not match the expected hostname.'} This is a point-in-time observation, not a health guarantee.</p>}
        {check.observation.finalUrl&&<p className="mono">{check.observation.finalUrl}</p>}
        <ol>{check.observation.hops.map((hop,index)=><li key={index}><span className="mono">{hop.url}</span> — HTTP {hop.status}, {hop.durationMs} ms{hop.location&&<span> → <span className="mono">{hop.location}</span></span>}</li>)}</ol>
      </>}
    </article>)}
    {state&&state.checks.length===20&&<p className="hint">Showing the most recent 20 checks for this alias.</p>}
  </details>;
}
