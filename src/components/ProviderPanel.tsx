import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError, errMsg } from '../lib/api'

type ProviderName = 'openrouter' | 'dataforseo'
type CheckStatus = 'untested' | 'ok' | 'error'

interface ConnectionMeta {
  id: string
  name: string
  provider: ProviderName
  revision: number
  createdAt: string
  updatedAt: string
  lastCheckedAt: string | null
  checkStatus: CheckStatus
  diagnostic: string | null
}

interface BudgetInfo {
  paused: boolean
  month: string
  spentUsd: string
  reservedUsd: string
  uncertainUsd: string
}

interface LedgerEntry {
  id: string
  connectionId: string
  operation: string
  status: string
  estimateUsd: string
  actualUsd: string | null
  createdAt: string
}

interface ProvidersResponse {
  vaultConfigured: boolean
  connections: ConnectionMeta[]
  budget: BudgetInfo
  ledger: LedgerEntry[]
}

export interface ProviderPanelProps {
  workspaceId: string
  onUnauthorized: () => void
}

function providerLabel(provider: ProviderName): string {
  return provider === 'openrouter' ? 'OpenRouter' : 'DataForSEO'
}

export function ProviderPanel({ workspaceId, onUnauthorized }: ProviderPanelProps) {
  // Keyed remount synchronously discards all state (including typed credentials)
  // when the workspace changes, so stale data or secrets can never leak across.
  return <ProviderPanelInner key={workspaceId} workspaceId={workspaceId} onUnauthorized={onUnauthorized} />
}

function ProviderPanelInner({ workspaceId, onUnauthorized }: ProviderPanelProps) {
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [permissionLost, setPermissionLost] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [mutating, setBusy] = useState(false)
  const busy = loading || mutating

  const [cName, setCName] = useState('')
  const [cProvider, setCProvider] = useState<ProviderName>('openrouter')
  const [cApiKey, setCApiKey] = useState('')
  const [cLogin, setCLogin] = useState('')
  const [cPassword, setCPassword] = useState('')

  const [rotateId, setRotateId] = useState<string | null>(null)
  const [rName, setRName] = useState('')
  const [rApiKey, setRApiKey] = useState('')
  const [rLogin, setRLogin] = useState('')
  const [rPassword, setRPassword] = useState('')

  const [bPaused, setBPaused] = useState(true)

  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const reqIdRef = useRef(0)
  const mutLockRef = useRef(false)
  const unauthorizedRef = useRef(onUnauthorized)
  unauthorizedRef.current = onUnauthorized

  const clearSecrets = useCallback(() => {
    setCApiKey('')
    setCLogin('')
    setCPassword('')
    setRApiKey('')
    setRLogin('')
    setRPassword('')
  }, [])

  const closeRotate = useCallback(() => {
    setRotateId(null)
    setRName('')
    setRApiKey('')
    setRLogin('')
    setRPassword('')
  }, [])

  // 401/403/404 handling for the still-current request only; callers check
  // currency before invoking. Returns true when the failure was handled.
  // 403/404 drops cached privileged data, both drafts and all secrets.
  const handleAuthFailure = useCallback((e: ApiError): boolean => {
    if (e.status === 401) {
      clearSecrets()
      closeRotate()
      setData(null)
      unauthorizedRef.current()
      return true
    }
    if (e.status === 403 || e.status === 404) {
      clearSecrets()
      closeRotate()
      setData(null)
      setError(null)
      setSuccess(null)
      setPermissionLost(true)
      setLoadError('Access to this workspace was lost or it no longer exists. Retry to reload.')
      return true
    }
    return false
  }, [clearSecrets, closeRotate])

  const load = useCallback(async () => {
    const id = ++reqIdRef.current
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const current = () => mountedRef.current && !ctrl.signal.aborted && reqIdRef.current === id
    setLoading(true)
    setLoadError(null)
    setPermissionLost(false)
    try {
      const d = await api<ProvidersResponse>(`/api/workspaces/${workspaceId}/providers`, { signal: ctrl.signal })
      if (!current()) return
      if (typeof d?.budget?.paused !== 'boolean' || !Array.isArray(d.connections) || d.connections.some(c =>
        !c || typeof c.id !== 'string' || !Number.isInteger(c.revision) || c.revision < 1 || c.revision > 2147483647)) {
        throw new Error('Provider settings could not be confirmed. Reload to try again.')
      }
      setData(d)
      setBPaused(d.budget.paused)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError' && ctrl.signal.aborted) return
      if (!current()) return
      if (e instanceof ApiError && handleAuthFailure(e)) return
      setLoadError(errMsg(e))
    } finally {
      if (current()) setLoading(false)
    }
  }, [workspaceId, handleAuthFailure])

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [load, clearSecrets])

  // Synchronous ref lock: repeat submits fired before React re-renders are dropped.
  // Each request aborts the previous one; a response only lands while still current,
  // so a slow mutation/refresh can never overwrite another workspace's state.
  const runMutation = async (
    fn: (signal: AbortSignal) => Promise<unknown>,
    successMsg: string,
    afterSuccess?: () => void,
  ): Promise<void> => {
    if (mutLockRef.current || loading || !data) return
    mutLockRef.current = true
    const id = ++reqIdRef.current
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const current = () => mountedRef.current && !ctrl.signal.aborted && reqIdRef.current === id
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await fn(ctrl.signal)
      if (!current()) return
      afterSuccess?.()
      setSuccess(successMsg)
      await load()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError' && ctrl.signal.aborted) return
      if (!current()) return
      if (e instanceof ApiError && handleAuthFailure(e)) return
      setError(errMsg(e))
    } finally {
      mutLockRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  const base = `/api/workspaces/${workspaceId}/providers`
  const vaultOk = data !== null && data.vaultConfigured
  const rotateConn = data !== null ? data.connections.find(c => c.id === rotateId) ?? null : null

  const connName = (id: string): string =>
    data?.connections.find(c => c.id === id)?.name ?? 'Removed connection'

  const submitCreate = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    if (mutLockRef.current || busy || !vaultOk || data === null) return
    const name = cName.trim()
    if (name.length === 0 || name.length > 120) {
      setError('Name must be between 1 and 120 characters.')
      return
    }
    if (cProvider === 'openrouter' && cApiKey === '') {
      setError('Enter the OpenRouter API key.')
      return
    }
    if (cProvider === 'dataforseo' && (cLogin.trim() === '' || cPassword === '')) {
      setError('Enter the DataForSEO API login email and API password.')
      return
    }
    const credentials = cProvider === 'openrouter' ? { apiKey: cApiKey } : { login: cLogin.trim(), password: cPassword }
    clearSecrets()
    void runMutation(
      signal => api<unknown>(base, { method: 'POST', body: { name, provider: cProvider, credentials }, signal }),
      'Connection saved. It stays untested until you run a check.',
      () => {
        setCName('')
        clearSecrets()
      },
    )
  }

  const openRotate = (c: ConnectionMeta) => {
    if (mutLockRef.current || busy || !vaultOk) return
    clearSecrets()
    // Prefill metadata only; credentials are always blank.
    setRotateId(c.id)
    setRName(c.name)
    setRApiKey('')
    setRLogin('')
    setRPassword('')
    setError(null)
    setSuccess(null)
  }

  const submitRotate = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    if (mutLockRef.current || busy || rotateConn === null || !vaultOk) return
    const name = rName.trim()
    if (name.length === 0 || name.length > 120) {
      setError('Name must be between 1 and 120 characters.')
      return
    }
    if (rotateConn.provider === 'openrouter' && rApiKey === '') {
      setError('Enter the full new OpenRouter API key.')
      return
    }
    if (rotateConn.provider === 'dataforseo' && (rLogin.trim() === '' || rPassword === '')) {
      setError('Enter the full new DataForSEO API login email and API password.')
      return
    }
    const credentials = rotateConn.provider === 'openrouter' ? { apiKey: rApiKey } : { login: rLogin.trim(), password: rPassword }
    const id = rotateConn.id
    clearSecrets()
    void runMutation(
      signal => api<unknown>(`${base}/${id}/update`, { method: 'POST', body: { name, credentials }, signal }),
      'Credentials rotated. The connection stays untested until you run a check.',
      closeRotate,
    )
  }

  const revokeConn = (c: ConnectionMeta) => {
    if (mutLockRef.current || busy || !data) return
    if (!window.confirm(`Permanently disconnect "${c.name}"? This cannot be undone.`)) return
    void runMutation(
      signal => api<unknown>(`${base}/${c.id}/revoke`, { method: 'POST', body: {}, signal }),
      'Connection disconnected.',
      () => {
        if (rotateId === c.id) closeRotate()
      },
    )
  }

  const checkConn = (c: ConnectionMeta) => {
    if (mutLockRef.current || busy || !vaultOk) return
    // Explicit, read-only account check. Never fired automatically.
    void runMutation(
      signal => api<unknown>(`${base}/${c.id}/check`, { method: 'POST', body: {}, signal }),
      'Account check finished. See the status column for the result.',
    )
  }

  const submitBudget = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault()
    if (mutLockRef.current || busy || !data) return
    if (!bPaused && !vaultOk) {
      setError('Pause provider work until credential storage is configured.')
      return
    }
    void runMutation(
      signal => api<unknown>(`/api/workspaces/${workspaceId}/budget`, { method: 'POST', body: { paused: bPaused }, signal }),
      'Paid-work setting saved. No work was started.',
    )
  }

  const retry = (
    <button type="button" className="btn" onClick={() => { if (!mutLockRef.current) void load() }} disabled={loading || busy}>Retry</button>
  )

  return (
    <section aria-label="Providers" aria-busy={loading || busy}>
      {permissionLost ? (
        <div className="alert" role="alert">
          <p>{loadError ?? 'Access to this workspace was lost.'}</p>
          {retry}
        </div>
      ) : data === null ? (
        loadError !== null ? (
          <div className="alert" role="alert">
            <p>{loadError}</p>
            {retry}
          </div>
        ) : (
          <div className="card">
            <p className="dim" role="status">Loading provider settings…</p>
          </div>
        )
      ) : (
        <>
          {!data.vaultConfigured && (
            <div className="banner">
              Credential storage is not configured on this server. Ask the installation operator to enable it before saving, rotating or checking connections. You can still pause paid work.
            </div>
          )}
          {loadError !== null && (
            <div className="alert" role="alert">
              <p>{loadError}</p>
              {retry}
            </div>
          )}
          {error !== null && (
            <div className="alert" role="alert">{error}</div>
          )}
          {success !== null && (
            <div role="status" style={{ margin: '10px 0', padding: '10px 14px', background: 'var(--green-tint)', border: '1px solid var(--green)', borderRadius: 10, fontSize: '13.5px' }}>{success}</div>
          )}

          <div className="card">
            <h2>Connections</h2>
            <p className="hint">ten98-monitor is free and MIT licensed. These controls only manage charges from your external API providers.</p>
            <p className="hint">OpenRouter supplies AI model answers. DataForSEO supplies keyword research and search rankings. These credentials are separate from ten98 API access keys.</p>
            <p className="hint">Run check contacts the provider's read-only account endpoint. It does not start paid work and never runs automatically.</p>
            <p>Paid provider work is {data.budget.paused ? 'paused' : 'not paused'}. <button type="button" className="btn ghost" onClick={() => document.getElementById('provider-budget')?.focus()}>Review spending</button></p>
            <p className="hint">A passed check does not start paid work; each paid run needs its own quote and Start. ten98 sets no spending limit; set budgets and add credits at OpenRouter or DataForSEO.</p>
            {data.connections.length === 0 ? (
              <div className="empty">
                <p><strong>No provider connections yet.</strong></p>
                <p>Save a connection below. It stays untested until you run a check.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table style={{ minWidth: '52rem' }}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Last checked</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.connections.map(c => (
                      <tr key={c.id}>
                        <td style={{ minWidth: '10rem', maxWidth: '18rem', overflowWrap: 'anywhere' }}>{c.name}</td>
                        <td>{providerLabel(c.provider)}</td>
                        <td style={{ minWidth: '12rem' }}>
                          {c.checkStatus === 'ok' && <span className="pill good">Check passed</span>}
                          {c.checkStatus === 'error' && <span className="pill bad">Check failed</span>}
                          {c.checkStatus === 'untested' && <span className="pill">Saved — untested</span>}
                          {c.diagnostic !== null && c.diagnostic !== '' && <p className="hint">{c.diagnostic}</p>}
                        </td>
                        <td>{c.lastCheckedAt === null ? 'Never' : new Date(c.lastCheckedAt).toLocaleString()}</td>
                        <td>
                          <div className="row">
                            <button type="button" className="btn ghost" disabled={busy || !data.vaultConfigured} onClick={() => checkConn(c)}>Run check</button>
                            <button type="button" className="btn ghost" disabled={busy || !data.vaultConfigured} onClick={() => openRotate(c)}>Rotate credentials</button>
                            <button type="button" className="btn ghost" disabled={busy} onClick={() => revokeConn(c)}>Disconnect</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {rotateConn !== null && (
            <div className="card">
              <h2>Rotate credentials</h2>
              <p className="hint">
                Rotating replaces the stored credentials for <strong>{rotateConn.name}</strong> ({providerLabel(rotateConn.provider)}). The provider cannot be changed. Full new credentials are required and are never displayed again. Saving also updates the name.
              </p>
              <form onSubmit={submitRotate}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="field" style={{ minWidth: 0, flex: '1 1 240px' }}>
                    <label htmlFor="rot-name">Name</label>
                    <input id="rot-name" value={rName} onChange={e => setRName(e.target.value)} maxLength={120} autoComplete="off" disabled={busy || !data.vaultConfigured} />
                  </div>
                </div>
                {rotateConn.provider === 'openrouter' ? (
                  <div className="field">
                    <label htmlFor="rot-apikey">New OpenRouter API key</label>
                    <input id="rot-apikey" type="password" autoComplete="off" maxLength={4096} value={rApiKey} onChange={e => setRApiKey(e.target.value)} disabled={busy || !data.vaultConfigured} />
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <label htmlFor="rot-login">New DataForSEO API login email</label>
                      <input id="rot-login" autoComplete="off" maxLength={254} value={rLogin} onChange={e => setRLogin(e.target.value)} disabled={busy || !data.vaultConfigured} />
                    </div>
                    <div className="field">
                      <label htmlFor="rot-password">New DataForSEO API password</label>
                      <input id="rot-password" type="password" autoComplete="off" maxLength={4096} value={rPassword} onChange={e => setRPassword(e.target.value)} disabled={busy || !data.vaultConfigured} />
                    </div>
                  </>
                )}
                <div className="row">
                  <button type="submit" className="btn primary" disabled={busy || !data.vaultConfigured}>Rotate credentials</button>
                  <button type="button" className="btn" onClick={closeRotate} disabled={busy}>Cancel</button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            <h2>Add connection</h2>
            <form onSubmit={submitCreate}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="field" style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <label htmlFor="pc-name">Name</label>
                  <input id="pc-name" value={cName} onChange={e => setCName(e.target.value)} maxLength={120} autoComplete="off" disabled={busy || !data.vaultConfigured} />
                </div>
                <div className="field" style={{ minWidth: 0, flex: '1 1 200px' }}>
                  <label htmlFor="pc-provider">Provider</label>
                  <select id="pc-provider" value={cProvider} onChange={e => { setCProvider(e.target.value === 'dataforseo' ? 'dataforseo' : 'openrouter'); setCApiKey(''); setCLogin(''); setCPassword('') }} disabled={busy || !data.vaultConfigured}>
                    <option value="openrouter">OpenRouter</option>
                    <option value="dataforseo">DataForSEO</option>
                  </select>
                </div>
              </div>
              {cProvider === 'openrouter' ? (
                <div className="field">
                  <label htmlFor="pc-apikey">OpenRouter API key</label>
                  <input id="pc-apikey" type="password" autoComplete="off" maxLength={4096} value={cApiKey} onChange={e => setCApiKey(e.target.value)} disabled={busy || !data.vaultConfigured} />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="pc-login">DataForSEO API login email</label>
                    <input id="pc-login" autoComplete="off" maxLength={254} value={cLogin} onChange={e => setCLogin(e.target.value)} disabled={busy || !data.vaultConfigured} />
                  </div>
                  <div className="field">
                    <label htmlFor="pc-password">DataForSEO API password</label>
                    <input id="pc-password" type="password" autoComplete="off" maxLength={4096} value={cPassword} onChange={e => setCPassword(e.target.value)} disabled={busy || !data.vaultConfigured} />
                  </div>
                </>
              )}
              <button type="submit" className="btn primary" disabled={busy || !data.vaultConfigured}>Save connection</button>
              {!data.vaultConfigured && <p className="hint">Saving is disabled until credential storage is configured.</p>}
            </form>
          </div>

          <div className="card">
            <h2 id="provider-budget" tabIndex={-1}>External API spending</h2>
            <p className="hint">
              Usage month: {data.budget.month}. Totals of this app's own requests this month (UTC); there is no app spending limit. Uncertain: requests whose charge is unknown; while any exists, new paid work is blocked until an owner reconciles it.
            </p>
            <div className="row" style={{ gap: 32, alignItems: 'baseline' }}>
              <div style={{ minWidth: 0 }}>
                <span className="dim">Spent</span>
                <div className="big-num">${data.budget.spentUsd}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="dim">Reserved</span>
                <div className="big-num">${data.budget.reservedUsd}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <span className="dim">Uncertain</span>
                <div className="big-num">${data.budget.uncertainUsd}</div>
              </div>
            </div>
            <form onSubmit={submitBudget}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="field" style={{ minWidth: 0 }}>
                  <label htmlFor="bl-paused">
                    <input id="bl-paused" type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={bPaused} disabled={busy || (!data.vaultConfigured && bPaused)} onChange={e => setBPaused(e.target.checked)} />
                    Pause paid provider work
                  </label>
                  <p className="hint">Stops new paid work immediately; off for new workspaces.</p>
                  {!data.vaultConfigured && <p className="hint">Unpausing requires credential storage to be configured.</p>}
                </div>
              </div>
              <button type="submit" className="btn primary" disabled={busy}>Save pause setting</button>
            </form>
          </div>

          <div className="card">
            <h2>Recent activity</h2>
            {data.ledger.length === 0 ? (
              <div className="empty">
                <p>No provider activity yet.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table style={{ minWidth: '48rem' }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Connection</th>
                      <th>Operation</th>
                      <th>Status</th>
                      <th>Estimate</th>
                      <th>Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ledger.map(l => (
                      <tr key={l.id}>
                        <td className="dim">{new Date(l.createdAt).toLocaleString()}</td>
                        <td style={{ minWidth: '10rem', maxWidth: '18rem', overflowWrap: 'anywhere' }}>{connName(l.connectionId)}</td>
                        <td style={{ minWidth: '10rem', maxWidth: '20rem', overflowWrap: 'anywhere' }}>{l.operation}</td>
                        <td><span className="pill">{l.status}</span></td>
                        <td className="mono">${l.estimateUsd}</td>
                        <td className="mono">{l.actualUsd === null ? 'Pending' : `$${l.actualUsd}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">Amounts are this app's own usage accounting, not provider billing.</p>
          </div>
        </>
      )}
    </section>
  )
}
