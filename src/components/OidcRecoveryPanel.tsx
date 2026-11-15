import {AppIcon} from '@ten98/ui/app';
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Button, Card, Checkbox, Field, Inline, Input, Option, Select, Stack, Text, Textarea } from '@ten98/ui'
import { api, ApiError, errMsg } from '../lib/api'
import { authorizationRedirect } from '../lib/oidc-authorization'
import { closureAcknowledgements, closurePrivacyNotice } from './AccountClosurePanel'

// twoFactorRequirement is present while a workspace this user belongs to requires two-factor, so turning it off is refused.
type Security = { user: { id: string; twoFactorEnabled: boolean }; hasPassword: boolean; twoFactorRequirement: { message: string; workspaces: { id: string; name: string; owner: boolean }[] } | null }
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
        ? previous === 'enable-two-factor' || (previous === 'disable-two-factor' && data.twoFactorRequirement) ? 'set-password' : previous
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
    void run(signal => api<{ authorizationUrl: string; authorizationOrigin: string }>('/api/account/oidc/reauth/start', { method: 'POST', body: { identityId }, signal }), result => {
      const href = authorizationRedirect(result.authorizationUrl, result.authorizationOrigin)
      if (href === null) throw new Error('The identity sign-in address is invalid. Start again.')
      window.location.assign(href)
    })
  }
  function confirm(event: FormEvent) {
    event.preventDefault()
    if (!proof || !security) return
    if (action === 'disable-two-factor' && security.twoFactorRequirement) return
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
  if (loading && !security) return <Text tone='muted' role='status'>Loading identity recovery settings…</Text>
  const requirement = security?.user.twoFactorEnabled ? security.twoFactorRequirement ?? null : null
  if (security?.hasPassword && !notice && !enrollment) return null
  return <Card as='section' headingLevel={2} aria-label='Identity account security' aria-busy={busy || loading}
    title={<><AppIcon name='shield' size={18} />{' '}Identity account security</>} description='Recovery for accounts connected to an identity provider'>
    <Stack>
      {/* The live region holds only the message; Reload sits beside it so the alert never wraps a control. */}
      {error && <Stack gap={2}><Alert tone='danger'>{error}</Alert><Inline><Button variant='secondary' disabled={busy} onClick={() => void load()}>Reload settings</Button></Inline></Stack>}
      {notice && <Text role='status'>{notice}</Text>}
      {security && !security.hasPassword && <>
        <Text>Sign in again with your linked provider to change security settings. Adding a local recovery password is optional.</Text>
        {requirement && <Alert id='oidc-disable-required' tone='info' variant='inline' title='Two-factor authentication is required'>{requirement.message}</Alert>}
        {!proof && !enrollment && <Inline>
          {identities.map(identity => <Button variant='secondary' type='button' disabled={busy || loading} key={identity.id} onClick={() => start(identity.id)}>Verify with {identity.providerName}</Button>)}
          {!identities.length && <Text>No enabled identity provider is available. Ask the installation operator to restore access to your provider.</Text>}
        </Inline>}
        {proof && <Stack as='form' onSubmit={confirm}>
          <Text>Verified with <Text as='strong' weight='semibold'>{proof.providerName}</Text>. This proof expires {new Date(proof.expiresAt).toLocaleString()} and can be used once.</Text>
          <Text mono>{proof.issuer} · {proof.subject}</Text>
          <Stack as='fieldset' disabled={busy || loading}>
            <Field label='Security change' htmlFor='oidc-security-action'><Select id='oidc-security-action' aria-describedby={requirement ? 'oidc-disable-required' : undefined} value={action} onChange={event => { setAction(event.target.value as Action); setPassword(''); setRepeat(''); setFactor('') }}>
              {actionOptions(security.user.twoFactorEnabled).map(([value, label]) => <Option key={value} value={value} disabled={value === 'disable-two-factor' && requirement !== null}>{label}</Option>)}
            </Select></Field>
            {action === 'close-account' && <Text role='note'>Closing is permanent. You are signed out everywhere, every API key you issued is revoked, and your linked identities, authenticator, preferences and memberships are removed. You cannot close the account while you are the only owner of a workspace or the only instance operator.</Text>}
            {action === 'close-account' && <Text>{closurePrivacyNotice}</Text>}
            {action === 'close-account' && closureAcknowledgements.map(item => <Checkbox key={item.id} name={`closure-${item.id}`} required label={item.label} />)}
            {action === 'set-password' && <><Field label='New recovery password' htmlFor='oidc-new-password'><Input id='oidc-new-password' type='password' autoComplete='new-password' minLength={12} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} /></Field>
              <Field label='Repeat recovery password' htmlFor='oidc-repeat-password'><Input id='oidc-repeat-password' type='password' autoComplete='new-password' minLength={12} maxLength={128} required value={repeat} onChange={event => setRepeat(event.target.value)} /></Field></>}
            {security.user.twoFactorEnabled && <><Field label='Existing second factor' htmlFor='oidc-factor-type'><Select id='oidc-factor-type' value={recovery ? 'recovery' : 'totp'} onChange={event => { setRecovery(event.target.value === 'recovery'); setFactor('') }}><Option value='totp'>Authenticator code</Option><Option value='recovery'>Recovery code</Option></Select></Field>
              <Field label={recovery ? 'Recovery code' : 'Authenticator code'} htmlFor='oidc-existing-factor'><Input id='oidc-existing-factor' autoComplete='one-time-code' inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 21 : 6} required value={factor} onChange={event => setFactor(event.target.value)} /></Field></>}
            <Inline>
              <Button variant='primary' type='submit' disabled={action === 'disable-two-factor' && requirement !== null}>{action === 'close-account' ? 'Close account permanently' : 'Apply security change'}</Button>
              <Button variant='ghost' type='button' onClick={() => callbacks.current.onProofHandled()}>Cancel</Button>
            </Inline>
          </Stack>
        </Stack>}
      </>}
      {enrollment && <>
        {enrollment.totpURI && (setupKey(enrollment.totpURI) ? <><Text>Add this time-based account to your authenticator, then enter its code. Two-factor authentication is not active until verification succeeds.</Text><Field label='Authenticator setup key' htmlFor='oidc-setup-key'><Input id='oidc-setup-key' readOnly value={setupKey(enrollment.totpURI)!} /></Field></> : <Alert tone='danger'>The authenticator setup address could not be read. Start a fresh provider verification to restart setup.</Alert>)}
        <Field label='New recovery codes' htmlFor='oidc-recovery-codes'><Textarea id='oidc-recovery-codes' rows={10} readOnly value={enrollment.backupCodes.join('\n')} /></Field>
        <Text>Save these codes securely. They are shown once and each works once.</Text>
        {/* Button defaults to type="button"; the enrollment confirmation must keep submitting its form. */}
        {enrollment.totpURI && setupKey(enrollment.totpURI) ? <Stack as='form' onSubmit={event => { event.preventDefault(); const code = enrollmentCode; setEnrollmentCode(''); void run(signal => api('/api/account/two-factor/verify', { method: 'POST', body: { code }, signal }), async () => { setEnrollment({ backupCodes: enrollment.backupCodes }); setNotice('Two-factor authentication is now on. Save your recovery codes.'); await load(null) }) }}>
          <Field label='Confirm authenticator code' htmlFor='oidc-enrollment-code'><Input id='oidc-enrollment-code' autoComplete='one-time-code' inputMode='numeric' minLength={6} maxLength={6} pattern='[0-9]{6}' required disabled={busy} value={enrollmentCode} onChange={event => setEnrollmentCode(event.target.value)} /></Field><Inline><Button variant='primary' type='submit' disabled={busy}>Verify and turn on 2FA</Button></Inline>
        </Stack> : <Inline><Button variant='secondary' disabled={busy || loading} onClick={() => setEnrollment(null)}>{enrollment.totpURI ? 'Restart authenticator setup' : 'I saved these codes'}</Button></Inline>}
      </>}
    </Stack>
  </Card>
}
