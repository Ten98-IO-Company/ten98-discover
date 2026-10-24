import {AppIcon} from '@ten98/ui/app';
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Checkbox, Text } from '@ten98/ui'
import { api, ApiError, errMsg } from '../lib/api'
import { closureAcknowledgements, closurePrivacyNotice } from './AccountClosurePanel'

type Security = { user: { id: string; twoFactorEnabled: boolean }; hasPassword: boolean }
type Identity = { id: string; providerName: string; enabled: boolean }
type Proof = { id: string; purpose: string; providerName: string; issuer: string; subject: string; expiresAt: string }
type Action = 'set-password' | 'enable-two-factor' | 'disable-two-factor' | 'replace-recovery' | 'close-account'
const actionOptions = (twoFactorEnabled: boolean): [Action, string][] => [['set-password', 'Add a local recovery password'],
  ...(twoFactorEnabled ? [['disable-two-factor', 'Turn off two-factor authentication'], ['replace-recovery', 'Replace recovery codes']] as [Action, string][] : [['enable-two-factor', 'Set up two-factor authentication']] as [Action, string][]),
  ['close-account', 'Close account permanently']]

export function OidcRecoveryPanel({ userId, proofId, onUnauthorized, onProofHandled, onClosed }: {
  userId: string; proofId?: string; onUnauthorized: () => void; onProofHandled: () => void; onClosed: () => void
}) {
  return <RecoveryInner key={userId} userId={userId} proofId={proofId} onUnauthorized={onUnauthorized} onProofHandled={onProofHandled} onClosed={onClosed} />
}

function RecoveryInner({ userId, proofId, onUnauthorized, onProofHandled, onClosed }: {
  userId: string; proofId?: string; onUnauthorized: () => void; onProofHandled: () => void; onClosed: () => void
}) {
  const [security, setSecurity] = useState<Security | null>(null)
  const [identities, setIdentities] = useState<Identity[]>([])
  const [proof, setProof] = useState<Proof | null>(null)
  const [action, setAction] = useState<Action>('set-password')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [factor, setFactor] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [enrollment, setEnrollment] = useState<{ totpURI?: string; backupCodes: string[] } | null>(null)
  const [enrollmentCode, setEnrollmentCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true), locked = useRef(false)
  const read = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null)
  const callbacks = useRef({ onUnauthorized, onProofHandled, onClosed })
  callbacks.current = { onUnauthorized, onProofHandled, onClosed }
  const activeProof = useRef(proofId), consumedProof = useRef<string | null>(null)
  activeProof.current = proofId
  const generation = useRef(0)

  function setupKey(uri?: string): string | null {
    if (!uri) return null
    try {
      const parsed = new URL(uri), secret = parsed.searchParams.get('secret')
      return parsed.protocol === 'otpauth:' && parsed.hostname === 'totp' && secret && /^[A-Z2-7]+=*$/i.test(secret) ? secret : null
    } catch { return null }
  }

  function clearSecrets() { setPassword(''); setRepeat(''); setFactor(''); setEnrollmentCode(''); setEnrollment(null) }
  function failed(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      clearSecrets(); setSecurity(null); setProof(null); setIdentities([]); callbacks.current.onUnauthorized(); return
    }
    if (error instanceof ApiError && [403, 404, 410].includes(error.status)) {
      clearSecrets(); setProof(null); setIdentities([])
      consumedProof.current = activeProof.current ?? null
      setNotice(error.status === 410 ? 'This identity verification expired or was already used. Verify with your provider again.' : 'This identity verification is unavailable. Verify with an enabled provider again.')
      callbacks.current.onProofHandled()
    }
    setError(errMsg(error))
  }
  async function load(requestedProof: string | null = activeProof.current ?? null) {
    read.current?.abort(); const controller = new AbortController(); read.current = controller
    setLoading(true); setError('')
    try {
      const data = await api<Security>('/api/account/security', { signal: controller.signal })
      if (!alive.current || controller.signal.aborted) return
      if (data.user.id !== userId) { clearSecrets(); callbacks.current.onUnauthorized(); return }
      setSecurity(data)
      setAction(previous => data.user.twoFactorEnabled
        ? previous === 'enable-two-factor' ? 'set-password' : previous
        : previous === 'disable-two-factor' || previous === 'replace-recovery' ? 'set-password' : previous)
      if (data.hasPassword) { setProof(null); setIdentities([]); return }
      const connected = await api<{ identities: Identity[] }>('/api/account/oidc/identities', { signal: controller.signal })
      if (!alive.current || controller.signal.aborted) return
      const checked = requestedProof && requestedProof !== consumedProof.current
        ? await api<{ proof: Proof }>(`/api/account/oidc/proofs/${encodeURIComponent(requestedProof)}`, { signal: controller.signal }) : null
      if (!alive.current || controller.signal.aborted) return
      setIdentities(connected.identities.filter(item => item.enabled))
      setProof(checked?.proof.purpose === 'account' ? checked.proof : null)
    } catch (error) { if (alive.current && !controller.signal.aborted) failed(error) }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; generation.current++; read.current?.abort(); mutation.current?.abort() }
  }, [])
  useEffect(() => {
    generation.current++; mutation.current?.abort(); locked.current = false; setBusy(false); setProof(null)
    setPassword(''); setRepeat(''); setFactor(''); setEnrollmentCode('')
    if (proofId && proofId !== consumedProof.current) setEnrollment(null)
    void load(proofId ?? null)
    return () => read.current?.abort()
  }, [userId, proofId])

  async function run<T>(work: (signal: AbortSignal) => Promise<T>, done: (result: T) => void | Promise<void>) {
    if (locked.current || loading) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    const controller = new AbortController(); mutation.current = controller
    const serial = generation.current, startingProof = activeProof.current
    const current = () => alive.current && !controller.signal.aborted && serial === generation.current && startingProof === activeProof.current
    try {
      const result = await work(controller.signal)
      if (current()) await done(result)
    } catch (error) { if (current()) failed(error) }
    finally {
      if (mutation.current === controller) {
        locked.current = false
        if (alive.current && !controller.signal.aborted) { setBusy(false); setPassword(''); setRepeat(''); setFactor('') }
      }
    }
  }
  function start(identityId: string) {
    void run(signal => api<{ authorizationUrl: string }>('/api/account/oidc/reauth/start', { method: 'POST', body: { identityId }, signal }), result => {
      const url = new URL(result.authorizationUrl)
      if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('The identity sign-in address is invalid. Start again.')
      window.location.assign(url.href)
    })
  }
  function confirm(event: FormEvent) {
    event.preventDefault()
    if (!proof || !security) return
    if (action === 'set-password' && password !== repeat) { setError('The new passwords do not match. Enter them again.'); return }
    const body = { proofId: proof.id, action, ...(action === 'set-password' ? { newPassword: password } : {}),
      ...(security.user.twoFactorEnabled ? recovery ? { backupCode: factor.trim() } : { code: factor.trim() } : {}) }
    setPassword(''); setRepeat(''); setFactor('')
    void run(signal => api<{ totpURI?: string; backupCodes?: string[] }>('/api/account/oidc/reauth/confirm', { method: 'POST', body, signal }), async result => {
      consumedProof.current = proof.id
      // Closure ended every session server-side (https://github.com/Ten98-IO-Company/ten98-discover/wiki/Accounts-and-Data#account-closure).
      if (action === 'close-account') { callbacks.current.onClosed(); return }
      setEnrollment(result.backupCodes ? { totpURI: result.totpURI, backupCodes: result.backupCodes } : null)
      setNotice(result.totpURI ? 'Confirm an authenticator code below to finish setup.' : action === 'set-password' ? 'Local recovery password saved. You can now use Security settings for password and authenticator settings.' : 'Account security updated.')
      setProof(null)
      await load(null)
      if (alive.current && activeProof.current === proof.id) callbacks.current.onProofHandled()
    })
  }
  if (loading && !security) return <p className='dim' role='status'>Loading identity recovery settings…</p>
  if (security?.hasPassword && !notice && !enrollment) return null
  return <section className='account-settings identity-recovery panel settings-panel integration-settings-card' aria-label='Identity account security' aria-busy={busy || loading}>
    <div className="provider-settings-heading"><span className="provider-initial"><AppIcon name="shield" size={18}/></span><div><h2>Identity account security</h2><p>Recovery for accounts connected to an identity provider</p></div></div>
    {error && <div className='alert' role='alert'>{error}<button className='btn button' disabled={busy} onClick={() => void load()}>Reload settings</button></div>}
    {notice && <p role='status'>{notice}</p>}
    {security && !security.hasPassword && <>
      <p>Sign in again with your linked provider to change security settings. Adding a local recovery password is optional.</p>
      {!proof && !enrollment && <div className='row button-wrap'>
        {identities.map(identity => <button type='button' className='btn button' disabled={busy || loading} key={identity.id} onClick={() => start(identity.id)}>Verify with {identity.providerName}</button>)}
        {!identities.length && <p>No enabled identity provider is available. Ask the installation operator to restore access to your provider.</p>}
      </div>}
      {proof && <form onSubmit={confirm}>
        <p>Verified with <strong>{proof.providerName}</strong>. This proof expires {new Date(proof.expiresAt).toLocaleString()} and can be used once.</p>
        <p className='mono' style={{ overflowWrap: 'anywhere' }}>{proof.issuer} · {proof.subject}</p>
        <fieldset disabled={busy || loading} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <div className='field'><label htmlFor='oidc-security-action'>Security change</label><select id='oidc-security-action' value={action} onChange={event => { setAction(event.target.value as Action); setPassword(''); setRepeat(''); setFactor('') }}>
            {actionOptions(security.user.twoFactorEnabled).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
          {action === 'close-account' && <p role='note'>Closing is permanent. You are signed out everywhere, every API key you issued is revoked, and your linked identities, authenticator, preferences and memberships are removed. You cannot close the account while you are the only owner of a workspace or the only instance operator.</p>}
          {action === 'close-account' && <Text>{closurePrivacyNotice}</Text>}
          {action === 'close-account' && closureAcknowledgements.map(item => <Checkbox key={item.id} name={`closure-${item.id}`} required label={item.label} />)}
          {action === 'set-password' && <><div className='field'><label htmlFor='oidc-new-password'>New recovery password</label><input id='oidc-new-password' type='password' autoComplete='new-password' minLength={12} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} /></div>
            <div className='field'><label htmlFor='oidc-repeat-password'>Repeat recovery password</label><input id='oidc-repeat-password' type='password' autoComplete='new-password' minLength={12} maxLength={128} required value={repeat} onChange={event => setRepeat(event.target.value)} /></div></>}
          {security.user.twoFactorEnabled && <><div className='field'><label htmlFor='oidc-factor-type'>Existing second factor</label><select id='oidc-factor-type' value={recovery ? 'recovery' : 'totp'} onChange={event => { setRecovery(event.target.value === 'recovery'); setFactor('') }}><option value='totp'>Authenticator code</option><option value='recovery'>Recovery code</option></select></div>
            <div className='field'><label htmlFor='oidc-existing-factor'>{recovery ? 'Recovery code' : 'Authenticator code'}</label><input id='oidc-existing-factor' autoComplete='one-time-code' inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 21 : 6} required value={factor} onChange={event => setFactor(event.target.value)} /></div></>}
          <button className='btn button primary' type='submit'>{action === 'close-account' ? 'Close account permanently' : 'Apply security change'}</button>
          <button className='btn button ghost' type='button' onClick={() => callbacks.current.onProofHandled()}>Cancel</button>
        </fieldset>
      </form>}
    </>}
    {enrollment && <>
      {enrollment.totpURI && (setupKey(enrollment.totpURI) ? <><p>Add this time-based account to your authenticator, then enter its code. Two-factor authentication is not active until verification succeeds.</p><div className='field'><label htmlFor='oidc-setup-key'>Authenticator setup key</label><input id='oidc-setup-key' readOnly value={setupKey(enrollment.totpURI)!} /></div></> : <p className='alert' role='alert'>The authenticator setup address could not be read. Start a fresh provider verification to restart setup.</p>)}
      <div className='field'><label htmlFor='oidc-recovery-codes'>New recovery codes</label><textarea id='oidc-recovery-codes' className='snippet' style={{ width: '100%' }} rows={10} readOnly value={enrollment.backupCodes.join('\n')} /></div>
      <p>Save these codes securely. They are shown once and each works once.</p>
      {enrollment.totpURI && setupKey(enrollment.totpURI) ? <form onSubmit={event => { event.preventDefault(); const code = enrollmentCode; setEnrollmentCode(''); void run(signal => api('/api/account/two-factor/verify', { method: 'POST', body: { code }, signal }), async () => { setEnrollment({ backupCodes: enrollment.backupCodes }); setNotice('Two-factor authentication is now on. Save your recovery codes.'); await load(null) }) }}>
        <div className='field'><label htmlFor='oidc-enrollment-code'>Confirm authenticator code</label><input id='oidc-enrollment-code' autoComplete='one-time-code' inputMode='numeric' minLength={6} maxLength={6} pattern='[0-9]{6}' required disabled={busy} value={enrollmentCode} onChange={event => setEnrollmentCode(event.target.value)} /></div><button className='btn button primary' disabled={busy}>Verify and turn on 2FA</button>
      </form> : <button className='btn button' disabled={busy || loading} onClick={() => setEnrollment(null)}>{enrollment.totpURI ? 'Restart authenticator setup' : 'I saved these codes'}</button>}
    </>}
  </section>
}
