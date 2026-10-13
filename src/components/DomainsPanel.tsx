import {useEffect, useRef, useState, type FormEvent} from 'react';
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

type Props = {projectId: string; userId: string; onUnauthorized: () => void};

const ROLE_LABEL: Record<Domain['role'], string> = {
  canonical: 'Canonical',
  serving: 'Serving domain',
  redirect_alias: 'Redirect alias',
};

const STATUS_LABEL: Record<Domain['status'], string> = {
  unverified: 'Unverified',
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

function DomainsPanelInner({projectId, onUnauthorized}: Props) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/domains`;

  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
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
      setState(s);
      setError(null);
    } catch (e) {
      if (!current()) return;
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
    if (lockRef.current || denied || !state) return;
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
            setError(`${message} The list has been refreshed.`);
          } catch (refreshError) {
            if (!current()) return;
            if (refreshError instanceof ApiError && [401, 403, 404].includes(refreshError.status)) handleError(refreshError);
            else setError(`${message} Refresh failed: ${errMsg(refreshError)}`);
          }
          return;
        }
        const mapped = mapError ? mapError(e) : null;
        if (mapped) setError(mapped);
        else handleError(e);
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
  const controlsOff = loading || busy;
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
      setState(s);
      replaceProof(null);
      setAddHost('');
      setAddRole('serving');
      setAddTarget('');
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

  const onChallenge = (d: Domain) => {
    if (lockRef.current || denied) return;
    if (d.status === 'pending' || d.status === 'verified') {
      const ok = window.confirm(
        `Replace the DNS proof for ${d.hostname}? Verification is cleared immediately. A serving domain stops accepting new collection until reverified; visitors must renew consent. The canonical project origin remains allowed.`,
      );
      if (!ok) return;
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

  const onRevoke = (d: Domain) => {
    if (lockRef.current || denied) return;
    if (!window.confirm(`Revoke the proof for ${d.hostname}? A serving domain stops accepting collection immediately. The canonical project origin remains allowed. You can create a new proof later.`)) return;
    void runMutation(async (signal, current) => {
      const s = await api<State>(`${base}/${encodeURIComponent(d.id)}/revoke`, {method: 'POST', body: {}, signal});
      if (!current()) return;
      setState(s);
      replaceProof(null);
      setNotice('Proof revoked; verification cleared.');
    });
  };

  const onRemove = (d: Domain) => {
    if (lockRef.current || denied) return;
    if (!window.confirm(`Remove ${d.hostname} from this project? A verified serving domain stops accepting collection immediately. This cannot be undone.`)) return;
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
    <section className="card" aria-labelledby="domains-panel-title">
      <div className="row between">
        <h2 id="domains-panel-title">Domains and aliases</h2>
        <button type="button" className="btn ghost" onClick={onRefresh} disabled={controlsOff}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Verified serving domains can use this project’s snippet at their exact HTTPS origin on port 443. No subdomains,
        HTTP origins or other ports are included. Redirect aliases never enable collection. Verification is a point-in-time
        DNS proof; it does not change DNS, discover backlinks or observe redirects. The canonical project origin remains allowed.
      </p>

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
      {busy && <p className="dim" role="status">Updating domain settings…</p>}

      {state && !denied && (
        <>
          <div className="field">
            <div className="row between">
              <span className="dim">Project origin (fixed)</span>
              <span className="mono">{state.project.origin}</span>
            </div>
            <div className="row between">
              <span className="dim">Canonical hostname</span>
              <span className="mono">{state.project.canonicalHost}</span>
            </div>
            {!state.project.canonicalVerifiable && (
              <p className="hint">
                This origin is local, an IP address, or otherwise ineligible, so the canonical hostname cannot receive
                a DNS proof. You can still add public domain entries below.
              </p>
            )}
          </div>

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

            <label htmlFor="dom-add-role">Role</label>
            <select
              id="dom-add-role"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value === 'redirect_alias' ? 'redirect_alias' : 'serving')}
              disabled={controlsOff || atLimit}
            >
              <option value="serving">Serving domain</option>
              <option value="redirect_alias">Redirect alias</option>
            </select>

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

          {state.domains.length === 0 ? (
            <p className="dim">No domains yet — add one above.</p>
          ) : (
            <div className="table-wrap">
              <table style={{minWidth: 760}}>
                <thead>
                  <tr>
                    <th>Hostname</th>
                    <th>Role</th>
                    <th>Expected target</th>
                    <th>Status</th>
                    <th>Verification</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {state.domains.map((d) => {
                    const isCanon = d.role === 'canonical';
                    const canProve = !(isCanon && !state.project.canonicalVerifiable);
                    const pendingLive =
                      d.status === 'pending' && d.challengeExpiresAt !== null && Date.parse(d.challengeExpiresAt) > Date.now();
                    return (
                      <tr key={d.id}>
                        <td>
                          <span className="mono">{d.hostname}</span>{' '}
                          {isCanon && <span className="pill">Canonical</span>}
                          {isCanon && <div className="hint">Fixed by the project origin.</div>}
                        </td>
                        <td>{ROLE_LABEL[d.role]}</td>
                        <td className="mono">{d.expectedTargetHost ?? '—'}</td>
                        <td style={{whiteSpace: 'nowrap'}}>
                          <span
                            className={
                              d.status === 'verified'
                                ? 'pill good'
                                : d.status === 'expired' || d.status === 'revoked'
                                  ? 'pill bad'
                                  : 'pill'
                            }
                          >
                            {STATUS_LABEL[d.status]}
                          </span>
                        </td>
                        <td>
                          {d.status === 'verified' && d.verifiedAt
                            ? `Control verified on ${fmt(d.verifiedAt)}`
                            : d.status === 'pending'
                              ? `Proof expires ${fmt(d.challengeExpiresAt)}`
                              : d.status === 'expired' && d.challengeExpiresAt
                                ? `Expired ${fmt(d.challengeExpiresAt)}`
                                : '—'}
                        </td>
                        <td>
                          <div className="row">
                            {!isCanon && (
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
                            )}
                            {canProve && (d.status === 'unverified' || d.status === 'expired' || d.status === 'revoked') && (
                              <button type="button" className="btn" disabled={controlsOff} onClick={() => onChallenge(d)}>
                                Create DNS proof
                              </button>
                            )}
                            {canProve && (d.status === 'pending' || d.status === 'verified') && (
                              <button type="button" className="btn" disabled={controlsOff} onClick={() => onChallenge(d)}>
                                Replace DNS proof
                              </button>
                            )}
                            {canProve && pendingLive && (
                              <button type="button" className="btn primary" disabled={controlsOff} onClick={() => onVerify(d)}>
                                Check DNS proof
                              </button>
                            )}
                            {canProve && (d.status === 'pending' || d.status === 'verified') && (
                              <button type="button" className="btn ghost" disabled={controlsOff} onClick={() => onRevoke(d)}>
                                Revoke proof
                              </button>
                            )}
                            {!isCanon && (
                              <button type="button" className="btn ghost" disabled={controlsOff} onClick={() => onRemove(d)}>
                                Remove
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="footnote">
            Expected targets are intended configuration, not observed redirects. “Control verified” records when a DNS
            proof matched — it is not a health check. Serving eligibility changes require visitors to renew consent.
            On narrow screens, scroll the table sideways to see actions.
          </p>

          {edit && editingDomain && (
            <form className="field" onSubmit={onSaveEdit} aria-label={`Edit ${editingDomain.hostname}`}>
              <strong>
                Edit <span className="mono">{editingDomain.hostname}</span>
              </strong>
              <span className="hint">The hostname itself cannot be changed.</span>
              <label htmlFor="dom-edit-role">Role</label>
              <select
                id="dom-edit-role"
                value={edit.role}
                onChange={(e) => setEdit({...edit, role: e.target.value === 'redirect_alias' ? 'redirect_alias' : 'serving'})}
                disabled={controlsOff}
              >
                <option value="serving">Serving domain</option>
                <option value="redirect_alias">Redirect alias</option>
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

          {proof && (
            <div className="field" role="region" aria-label="One-time DNS proof">
              <strong>DNS proof — shown only once</strong>
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
        </>
      )}
    </section>
  );
}
