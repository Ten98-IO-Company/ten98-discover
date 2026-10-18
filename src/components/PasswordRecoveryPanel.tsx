import {Icon} from './CampaignUI'
import { AuthLayout } from './AuthLayout'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'

export type PasswordRecovery = { kind: 'request' } | { kind: 'reset'; token: string | null }
type Props = { value: PasswordRecovery; initialEmail: string; onRequest: () => void; onSignIn: (changed?: boolean) => void }

export function PasswordRecoveryPanel({ value, initialEmail, onRequest, onSignIn }: Props) {
  const [email, setEmail] = useState(initialEmail), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [availability, setAvailability] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading')
  const [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(value.kind === 'reset' && !value.token)
  const alive = useRef(false), operation = useRef<AbortController | null>(null), locked = useRef(false)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    if (value.kind === 'request') void api<unknown>('/api/auth/password-reset-status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }).then(result => {
      if (!alive.current || controller.signal.aborted) return
      if (result === null || typeof result !== 'object' || Object.keys(result).length !== 1 || !('configured' in result) || typeof result.configured !== 'boolean') throw new Error('Invalid recovery status')
      setAvailability(result.configured ? 'enabled' : 'disabled')
    }).catch(() => { if (alive.current && !controller.signal.aborted) setAvailability('error') })
    return () => { alive.current = false; controller.abort(); operation.current?.abort() }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current || value.kind === 'reset' && (invalid || !value.token) || value.kind === 'request' && availability !== 'enabled') return
    if (value.kind === 'reset' && (password.length < 12 || password.length > 128 || password !== confirmation)) { setError('Use 12–128 characters and enter the same password twice.'); return }
    const controller = new AbortController(); operation.current = controller; locked.current = true; setBusy(true); setError('')
    try {
      const result = await api<unknown>(value.kind === 'request' ? '/api/auth/request-password-reset' : '/api/auth/reset-password', { method: 'POST', body: value.kind === 'request' ? { email: email.trim() } : { token: value.token, newPassword: password }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
      if (!alive.current || controller.signal.aborted || operation.current !== controller) return
      if (result === null || typeof result !== 'object' || Object.keys(result).length !== 1 || !('ok' in result) || result.ok !== true) throw new Error('Unverified acknowledgement')
      setPassword(''); setConfirmation('')
      if (value.kind === 'request') setSent(true)
      else onSignIn(true)
    } catch (cause) {
      if (!alive.current || controller.signal.aborted || operation.current !== controller) return
      if (value.kind === 'reset' && cause instanceof ApiError && cause.status === 400) { setInvalid(true); setPassword(''); setConfirmation(''); setError('This link is invalid, expired or already used. Request a new link, or reopen the original email if the address was changed.') }
      else if (cause instanceof ApiError && cause.status === 429) setError('Too many attempts. Wait a minute, then try again.')
      else if (value.kind === 'request') setError('The request could not be confirmed. Try again later, or contact the installation operator.')
      else setError('The password change could not be confirmed. Try signing in with the new password, or request a new reset link. Do not assume the old password still works.')
    } finally {
      if (alive.current && operation.current === controller) { operation.current = null; locked.current = false; setBusy(false) }
    }
  }

  return <AuthLayout><section className='card auth auth-form-inner account-access password-recovery-access' aria-labelledby='recovery-title'>
    <p className='eyebrow'>Your Discover workspace</p><span className="account-access-icon" aria-hidden="true"><Icon name="lock" size={20}/></span><h1 id='recovery-title'>{value.kind === 'request' ? 'Reset your password' : 'Choose a new password'}</h1>
    {value.kind === 'request' && availability === 'loading' && <p role='status'>Checking email recovery…</p>}
    {value.kind === 'request' && availability === 'disabled' && <p role='status'>Email recovery is not configured for this installation. Contact the installation operator, or return to sign-in and use your linked identity provider.</p>}
    {value.kind === 'request' && availability === 'error' && <p role='alert'>Email recovery availability could not be checked. Return to sign-in and try again.</p>}
    {sent ? <p role='status'>If a local password account matches this email, a reset link has been requested. Check your inbox and spam folder. Delivery is not confirmed here. The link expires after one hour.</p> : <>
      {value.kind === 'reset' && <p>The link works once. After a successful reset, existing sessions are signed out. Existing two-factor authentication and recovery codes are unchanged.</p>}
      {value.kind === 'reset' && invalid && !error && <p role='alert'>This reset link is invalid or incomplete. Reopen the original email or request a new link. Reloading this page clears the link from memory.</p>}
      {(value.kind === 'request' && availability === 'enabled' || value.kind === 'reset' && !invalid) && <form className='stack' onSubmit={event => void submit(event)}>
        {value.kind === 'request' ? <div className='field'><label htmlFor='recovery-email'>Account email</label><input id='recovery-email' type='email' autoComplete='email' required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></div> : <>
          <div className='field'><label htmlFor='recovery-password'>New password</label><input id='recovery-password' type='password' autoComplete='new-password' required minLength={12} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><p className='hint field-help'>12–128 characters.</p></div>
          <div className='field'><label htmlFor='recovery-confirm'>Confirm new password</label><input id='recovery-confirm' type='password' autoComplete='new-password' required minLength={12} maxLength={128} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></div>
          <p className='hint field-help'>The reset link is kept only in this open page. If you reload or close it, reopen the email.</p>
        </>}
        <button className='btn button primary full' disabled={busy}>{busy ? value.kind === 'request' ? 'Requesting link…' : 'Changing password…' : value.kind === 'request' ? 'Send reset link' : 'Change password'}</button>
      </form>}
    </>}
    {error && <p role='alert' className='alert'>{error}</p>}
    {value.kind === 'reset' && <button type='button' className='btn button' disabled={busy} onClick={onRequest}>Request a new link</button>}
    <button type='button' className='btn button' disabled={busy} onClick={() => onSignIn()}><span aria-hidden="true"><Icon name="arrow" size={16}/></span>Back to sign in</button>
  </section></AuthLayout>
}
