import {Icon} from './CampaignUI'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { useAccountPresentation } from '../lib/account-presentation'
import { accountLocaleMapping, accountPreferencesDefaults } from '../lib/account-preferences'

type SessionInfo = {
  id: string
  createdAt: string
  expiresAt: string
  userAgent: string | null
  current: boolean
}

type SecurityData = {
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean }
  sessions: SessionInfo[]
  hasPassword: boolean
}

type Op = 'password' | 'enable' | 'verify' | 'disable' | 'recovery' | 'revoke' | 'others'

const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'

export function AccountSecurityPanel({ expectedUserId, onUnauthorized }: { expectedUserId: string; onUnauthorized: () => void }) {
  const presentation=useAccountPresentation(),preferences=presentation?.data?.user.id===expectedUserId?presentation.data.preferences:accountPreferencesDefaults
  const fmt=(iso:string)=>{const date=new Date(iso);if(Number.isNaN(date.getTime()))return iso;try{return new Intl.DateTimeFormat(accountLocaleMapping(preferences.locale).formatLocale,{timeZone:preferences.timeZone,dateStyle:'medium',timeStyle:'short'}).format(date)}catch{return `${iso} (saved time zone unavailable in this browser)`}}
  const [data, setData] = useState<SecurityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState<Op | null>(null)
  const [errs, setErrs] = useState<Partial<Record<Op, string>>>({})
  const [pwOk, setPwOk] = useState('')
  const [copyNote, setCopyNote] = useState<Record<string, string>>({})

  // Sensitive values: memory only, never logged/persisted, never rendered from GET metadata.
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [enablePw, setEnablePw] = useState('')
  const [disablePw, setDisablePw] = useState('')
  const [recoveryPw, setRecoveryPw] = useState('')
  const [proof, setProof] = useState('')
  const [setupUri, setSetupUriState] = useState<string | null>(null)
  const [codes, setCodesState] = useState<string[] | null>(null)

  const mountedRef = useRef(true)
  const busyRef = useRef<Op | null>(null) // synchronous lock, set before React state
  const loadCtrlRef = useRef<AbortController | null>(null)
  const mutCtrlRef = useRef<AbortController | null>(null)
  const onUnauthRef = useRef(onUnauthorized)
  const secretVersion = useRef(0)
  const blocked = loading || busy !== null

  const setSetupUri = (uri: string | null) => {
    ++secretVersion.current
    setCopyNote({})
    setSetupUriState(uri)
  }
  const setCodes = (value: string[] | null) => {
    ++secretVersion.current
    setCopyNote({})
    setCodesState(value)
  }

  useEffect(() => {
    onUnauthRef.current = onUnauthorized
  }, [onUnauthorized])

  const clearSensitive = () => {
    setSetupUri(null)
    setCodes(null)
    setProof('')
    setCurPw('')
    setNewPw('')
    setNewPw2('')
    setEnablePw('')
    setDisablePw('')
    setRecoveryPw('')
    setCopyNote({})
    setPwOk('')
  }

  const load = async (afterMutation = false): Promise<void> => {
    if (busyRef.current !== null && !afterMutation) return
    loadCtrlRef.current?.abort()
    const ctrl = new AbortController()
    loadCtrlRef.current = ctrl
    setLoading(true)
    setLoadErr('')
    try {
      const d = await api<SecurityData>('/api/account/security', { signal: ctrl.signal })
      if (!mountedRef.current || ctrl.signal.aborted || loadCtrlRef.current !== ctrl) return
      if (d.user.id !== expectedUserId) {
        clearSensitive()
        setData(null)
        onUnauthRef.current()
        return
      }
      setData(d)
    } catch (e) {
      if (isAbort(e) || !mountedRef.current || ctrl.signal.aborted || loadCtrlRef.current !== ctrl) return
      if (e instanceof ApiError && e.status === 401) {
        clearSensitive()
        setData(null)
        onUnauthRef.current()
        return
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        clearSensitive()
        setData(null)
        setLoadErr('Your access to this page changed. Reload your security settings to continue.')
        return
      }
      setLoadErr(errMsg(e))
    } finally {
      if (mountedRef.current && !ctrl.signal.aborted && loadCtrlRef.current === ctrl) {
        setLoading(false)
        loadCtrlRef.current = null
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      loadCtrlRef.current?.abort()
      mutCtrlRef.current?.abort()
    }
  }, [])

  const mutate = async <T,>(op: Op, path: string, body: unknown, commit?: (value: T) => void | false): Promise<void> => {
    if (busyRef.current !== null || loadCtrlRef.current !== null || loading || !data) return
    busyRef.current = op
    setBusy(op)
    setErrs(prev => ({ ...prev, [op]: '' }))
    const ctrl = new AbortController()
    mutCtrlRef.current = ctrl
    // Clear submitted passwords immediately; a failed request requires re-entry.
    setCurPw(''); setNewPw(''); setNewPw2(''); setEnablePw(''); setDisablePw(''); setRecoveryPw('')
    if (op === 'verify') setProof('')
    if (op === 'enable' || op === 'recovery') setCodes(null)
    try {
      const value = await api<T>(path, { method: 'POST', body, signal: ctrl.signal })
      if (!mountedRef.current || ctrl.signal.aborted || mutCtrlRef.current !== ctrl) return
      if (commit?.(value) === false) return
      await load(true)
    } catch (e) {
      if (isAbort(e) || !mountedRef.current || ctrl.signal.aborted || mutCtrlRef.current !== ctrl) return
      if (e instanceof ApiError && e.status === 401) {
        clearSensitive()
        setData(null)
        onUnauthRef.current()
        return
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        clearSensitive()
        setData(null)
        setLoadErr('Your access to this page changed. Reload your security settings to continue.')
        return
      }
      setErrs(prev => ({ ...prev, [op]: errMsg(e) }))
    } finally {
      if (mutCtrlRef.current === ctrl) {
        mutCtrlRef.current = null
        busyRef.current = null
        if (mountedRef.current && !ctrl.signal.aborted) setBusy(null)
      }
    }
  }

  const opErr = (op: Op, msg: string) => setErrs(prev => ({ ...prev, [op]: msg }))

  const copy = async (key: string, text: string): Promise<void> => {
    const version = secretVersion.current
    let note = 'Copy failed. Select the text and copy it yourself.'
    try {
      if (navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text)
        note = 'Copied.'
      }
    } catch {
      note = 'Copy failed. Select the text and copy it yourself.'
    }
    if (mountedRef.current && version === secretVersion.current) setCopyNote(m => ({ ...m, [key]: note }))
  }

  const submitPassword = async (): Promise<void> => {
    setPwOk('')
    if (curPw === '') { opErr('password', 'Enter your current password.'); return }
    if (newPw.length < 12 || newPw.length > 128) { opErr('password', 'Choose a new password between 12 and 128 characters.'); return }
    if (newPw !== newPw2) { opErr('password', 'The new passwords do not match. Re-enter them.'); return }
    await mutate<unknown>('password', '/api/account/password', { currentPassword: curPw, newPassword: newPw }, () => {
      setPwOk('Password changed. Your other sessions were signed out.')
    })
  }

  const startEnable = async (): Promise<void> => {
    if (enablePw === '') { opErr('enable', 'Enter your current password to start setup.'); return }
    await mutate<{ totpURI: string; backupCodes: string[] }>('enable', '/api/account/two-factor/enable', { password: enablePw }, value => {
      setSetupUri(value.totpURI)
      setCodes(value.backupCodes)
      setProof('')
    })
  }

  const submitVerify = async (): Promise<void> => {
    if (proof.length !== 6 || !/^\d{6}$/.test(proof)) { opErr('verify', 'Enter the 6-digit code from your authenticator app, including any leading zeros.'); return }
    await mutate<unknown>('verify', '/api/account/two-factor/verify', { code: proof }, () => {
      setData(previous => previous ? { ...previous, user: { ...previous.user, twoFactorEnabled: true } } : previous)
      setSetupUri(null)
      setProof('')
    })
  }

  const submitDisable = async (): Promise<void> => {
    if (!window.confirm('Turning off two-factor authentication removes this layer of sign-in protection. Workspaces that require it will block your access, and API keys you created there will stop working, until you turn it on again. Continue?')) return
    if (disablePw === '') { opErr('disable', 'Enter your current password to turn off 2FA.'); return }
    await mutate<unknown>('disable', '/api/account/two-factor/disable', { password: disablePw }, () => {
      setData(previous => previous ? { ...previous, user: { ...previous.user, twoFactorEnabled: false } } : previous)
      setSetupUri(null)
      setCodes(null)
      setProof('')
    })
  }

  const submitRecovery = async (): Promise<void> => {
    if (recoveryPw === '') { opErr('recovery', 'Enter your current password to generate recovery codes.'); return }
    if (!window.confirm('Replace your recovery codes? The previous codes will stop working and your other sessions will be signed out.')) return
    await mutate<{ backupCodes: string[] }>('recovery', '/api/account/two-factor/recovery-codes', { password: recoveryPw }, value => {
      setCodes(value.backupCodes)
    })
  }

  const revokeSession = async (s: SessionInfo): Promise<void> => {
    if (s.current && !window.confirm('This signs you out of this browser session. Continue?')) return
    await mutate<unknown>('revoke', '/api/account/sessions/revoke', { sessionId: s.id }, () => {
      if (s.current) {
        clearSensitive()
        setData(null)
        onUnauthRef.current()
        return false
      }
    })
  }

  const revokeOthers = async (): Promise<void> => {
    await mutate<unknown>('others', '/api/account/sessions/revoke-others', {})
  }

  if (data === null) {
    return (
      <section className="account-settings panel settings-panel" aria-busy={loading} aria-label="Account security">
        <h2>Account security</h2>
        {loadErr !== '' ? (
          <>
            <div className="alert" role="alert">{loadErr}</div>
            <button type="button" className="btn button" disabled={blocked} onClick={() => void load()}>Reload security settings</button>
          </>
        ) : (
          <p className="dim" role="status">Loading your security settings…</p>
        )}
      </section>
    )
  }

  const others = data.sessions.filter(s => !s.current)
  const twoFaOn = data.user.twoFactorEnabled
  let setupKey: string | null = null
  if (setupUri) { try { setupKey = new URL(setupUri).searchParams.get('secret') } catch { /* The full URI remains available below. */ } }

  return (
    <div className="account-settings account-security">
      <section className="panel settings-panel account-summary-card" aria-label="Account">
        <div className="provider-settings-heading">
          <span className="provider-initial"><Icon name="user" size={18}/></span>
          <div><h2>Account</h2><p>{data.user.name} · <bdi dir="ltr">{data.user.email}</bdi></p></div>
          {twoFaOn ? <span className="pill badge good configured">2FA on</span> : <span className="pill badge">2FA off</span>}
        </div>
        <p className="provider-source">{data.sessions.length} active sessions · {data.hasPassword ? 'Local password configured' : 'Identity provider sign-in'}</p>
        {loadErr !== '' && <div className="alert" role="alert">{loadErr}</div>}
      </section>

      <section className="panel settings-panel" aria-busy={busy === 'password'} aria-label="Password">
        <div className="provider-settings-heading"><span className="provider-initial"><Icon name="lock" size={18}/></span><div><h2>Password</h2><p>Keep your account secure</p></div></div>
        {data.hasPassword ? (
          <form onSubmit={e => { e.preventDefault(); void submitPassword() }}>
            <p className="hint field-help">Changing your password signs out all other sessions.</p>
            <div className="field">
              <label htmlFor="pw-current">Current password</label>
              <input id="pw-current" type="password" autoComplete="current-password" maxLength={128} required disabled={blocked} value={curPw} onChange={e => setCurPw(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pw-new">New password</label>
              <input id="pw-new" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={blocked} value={newPw} onChange={e => setNewPw(e.target.value)} />
              <p className="hint field-help">Use 12 to 128 characters.</p>
            </div>
            <div className="field">
              <label htmlFor="pw-new2">Repeat new password</label>
              <input id="pw-new2" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={blocked} value={newPw2} onChange={e => setNewPw2(e.target.value)} />
            </div>
            {errs.password ? <div className="alert" role="alert">{errs.password}</div> : null}
            {pwOk !== '' ? <p className="hint field-help" role="status">{pwOk}</p> : null}
            <button type="submit" className="btn button primary" disabled={blocked}>
              {busy === 'password' ? 'Changing…' : 'Change password'}
            </button>
          </form>
        ) : (
          <div className="empty">
            <p><strong>No local password</strong></p>
            <p>This account has no local password, so password and two-factor settings are unavailable here.</p>
          </div>
        )}
      </section>

      <section className="panel settings-panel" aria-busy={busy === 'enable' || busy === 'verify' || busy === 'disable' || busy === 'recovery'} aria-label="Two-factor authentication">
        <div className="provider-settings-heading"><span className="provider-initial"><Icon name="shield" size={18}/></span><div><h2>Two-factor authentication</h2><p>An extra layer of account protection</p></div>{twoFaOn ? <span className="pill badge good configured">On</span> : <span className="pill badge">Off</span>}</div>
        {!data.hasPassword ? (
          <p className="hint field-help">A local password is required to manage two-factor authentication.</p>
        ) : (
          <>
            {codes !== null && (
              <div>
                <p><strong>Recovery codes</strong></p>
                <p className="hint field-help">Save these codes securely. They are shown only once.</p>
                <div className="field">
                  <label htmlFor="tfa-codes">Recovery codes</label>
                  <textarea id="tfa-codes" className="snippet" readOnly rows={Math.max(1, Math.min(codes.length, 12))} style={{ width: '100%' }} value={codes.join('\n')} onFocus={e => e.currentTarget.select()} />
                </div>
                <div className="row button-wrap">
                  <button type="button" className="btn button" disabled={blocked} onClick={() => void copy('codes', codes.join('\n'))}>Copy codes</button>
                  <button type="button" className="btn button ghost" disabled={blocked} onClick={() => setCodes(null)}>I saved these codes</button>
                </div>
                {copyNote.codes ? <p className="hint field-help" role="status">{copyNote.codes}</p> : null}
              </div>
            )}

            {!twoFaOn && setupUri === null && (
              <form onSubmit={e => { e.preventDefault(); void startEnable() }}>
                <p className="hint field-help">2FA turns on only after you verify a code. Completing setup signs out all other sessions.</p>
                <div className="field">
                  <label htmlFor="tfa-enable-pw">Current password</label>
                  <input id="tfa-enable-pw" type="password" autoComplete="current-password" maxLength={128} required disabled={blocked} value={enablePw} onChange={e => setEnablePw(e.target.value)} />
                </div>
                {errs.enable ? <div className="alert" role="alert">{errs.enable}</div> : null}
                <button type="submit" className="btn button primary" disabled={blocked}>
                  {busy === 'enable' ? 'Starting…' : 'Start 2FA setup'}
                </button>
              </form>
            )}

            {!twoFaOn && setupUri !== null && (
              <>
                <p><strong>Finish setup — 2FA is not on yet</strong></p>
                <p className="hint field-help">In your authenticator app, add a time-based account using the setup key or import the setup URI. Then enter the 6-digit code it shows.</p>
                {setupKey && <div className="field">
                  <label htmlFor="tfa-key">Setup key</label>
                  <input id="tfa-key" readOnly value={setupKey} onFocus={e => e.currentTarget.select()} />
                  <button type="button" className="btn button" disabled={blocked} onClick={() => void copy('key', setupKey)}>Copy setup key</button>
                  {copyNote.key && <p className="hint field-help" role="status">{copyNote.key}</p>}
                </div>}
                <div className="field">
                  <label htmlFor="tfa-uri">Setup URI</label>
                  <textarea id="tfa-uri" className="snippet" readOnly rows={3} style={{ width: '100%' }} value={setupUri} onFocus={e => e.currentTarget.select()} />
                </div>
                <div className="row button-wrap">
                  <button type="button" className="btn button" disabled={blocked} onClick={() => void copy('uri', setupUri)}>Copy setup URI</button>
                  <button type="button" className="btn button ghost" disabled={blocked} onClick={() => { setSetupUri(null); setCodes(null); setProof('') }}>Hide setup details</button>
                </div>
                {copyNote.uri ? <p className="hint field-help" role="status">{copyNote.uri}</p> : null}
                <form onSubmit={e => { e.preventDefault(); void submitVerify() }}>
                  <div className="field">
                    <label htmlFor="tfa-code">6-digit code</label>
                    <input id="tfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" required disabled={blocked} value={proof} onChange={e => setProof(e.target.value)} />
                    <p className="hint field-help">Enter the code exactly as shown, including leading zeros.</p>
                  </div>
                  {errs.verify ? <div className="alert" role="alert">{errs.verify}</div> : null}
                  <button type="submit" className="btn button primary" disabled={blocked}>
                    {busy === 'verify' ? 'Verifying…' : 'Verify and turn on 2FA'}
                  </button>
                </form>
              </>
            )}

            {twoFaOn && (
              <>
                <form onSubmit={e => { e.preventDefault(); void submitRecovery() }}>
                  <p><strong>Recovery codes</strong></p>
                  <p className="hint field-help">New codes replace your old recovery codes and sign out all other sessions. Save the new codes securely — they are shown only once.</p>
                  <div className="field">
                    <label htmlFor="tfa-recovery-pw">Current password</label>
                    <input id="tfa-recovery-pw" type="password" autoComplete="current-password" maxLength={128} required disabled={blocked} value={recoveryPw} onChange={e => setRecoveryPw(e.target.value)} />
                  </div>
                  {errs.recovery ? <div className="alert" role="alert">{errs.recovery}</div> : null}
                  <button type="submit" className="btn button" disabled={blocked}>
                    {busy === 'recovery' ? 'Generating…' : 'Generate new recovery codes'}
                  </button>
                </form>
                <form onSubmit={e => { e.preventDefault(); void submitDisable() }}>
                  <p><strong>Turn off 2FA</strong></p>
                  <div className="field">
                    <label htmlFor="tfa-disable-pw">Current password</label>
                    <input id="tfa-disable-pw" type="password" autoComplete="current-password" maxLength={128} required disabled={blocked} value={disablePw} onChange={e => setDisablePw(e.target.value)} />
                  </div>
                  {errs.disable ? <div className="alert" role="alert">{errs.disable}</div> : null}
                  <button type="submit" className="btn button" disabled={blocked}>
                    {busy === 'disable' ? 'Turning off…' : 'Turn off 2FA'}
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </section>

      <section className="panel settings-panel account-sessions-card" aria-busy={busy === 'revoke' || busy === 'others'} aria-label="Sessions">
        <div className="row between">
          <div className="provider-settings-heading"><span className="provider-initial"><Icon name="monitor" size={18}/></span><div><h2>Sessions</h2><p>Devices signed in to your account</p></div></div>
          <div className="row button-wrap">
            <button type="button" className="btn button ghost" disabled={blocked} onClick={() => void load()}>Refresh</button>
            {others.length > 0 && (
              <button type="button" className="btn button" disabled={blocked} onClick={() => void revokeOthers()}>
                {busy === 'others' ? 'Signing out…' : 'Sign out all other sessions'}
              </button>
            )}
          </div>
        </div>
        {errs.revoke ? <div className="alert" role="alert">{errs.revoke}</div> : null}
        {errs.others ? <div className="alert" role="alert">{errs.others}</div> : null}
        <div className="table-wrap">
          <table style={{ minWidth: '44rem' }}>
            <thead>
              <tr><th>Device</th><th>Created</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {data.sessions.map(s => (
                <tr key={s.id}>
                  <td style={{ minWidth: '18rem', maxWidth: '30rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                    {s.userAgent ?? 'Unknown device'}
                    {s.current && <> <span className="pill good">This session</span></>}
                  </td>
                  <td className="mono">{fmt(s.createdAt)}</td>
                  <td className="mono">{fmt(s.expiresAt)}</td>
                  <td>
                    <button type="button" className="btn button ghost" disabled={blocked} onClick={() => void revokeSession(s)}>
                      {s.current ? 'Sign out' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
