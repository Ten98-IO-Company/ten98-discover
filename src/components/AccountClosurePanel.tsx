import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Field, Input, List, ListItem, ReviewConfirm, SettingsPanel, Stack, Text } from '@ten98/ui'
import { api, ApiError, errMsg } from '../lib/api'

/** First-strong isolation, so a right-to-left workspace name cannot reorder the surrounding label. */
const isolate = (text: string) => String.fromCodePoint(0x2068) + text + String.fromCodePoint(0x2069)

type Closure = { blockers: { workspaces: { id: string; name: string }[]; lastOperator: boolean }; hasPassword: boolean; twoFactorEnabled: boolean }

const consequences = [
  'You are signed out everywhere and can never sign in to this account again.',
  'Every API key you issued is revoked, and MCP clients using those keys stop working.',
  'Your password, authenticator, recovery codes, linked identity providers, preferences and pending invitations are removed.',
  'You leave every workspace. Your name and email are replaced with “Closed account” wherever you are shown as an author.',
  'Workspaces keep their data, reports, share links and usage records. Share links you created keep working.',
]

/** Owner-approved privacy notice (docs/account-closure.md); both closure paths show it verbatim. */
export const closurePrivacyNotice = 'When you close your account we delete your name, email, sign-in methods, sessions and API keys. We keep an anonymous record of actions you took in a workspace, such as paid requests and audit entries, for as long as that workspace exists.'

/** Both closure paths (password and identity provider) require these before submitting. */
export const closureAcknowledgements = [
  { id: 'permanent', label: 'I understand that closing is permanent and cannot be undone.' },
  { id: 'keys', label: 'I understand that every API key I issued stops working immediately.' },
] as const

/** Self-service account closure (docs/account-closure.md). The server re-checks every blocker and the step-up proof. */
export function AccountClosurePanel({ userId, onClosed, onUnauthorized, onOpenTeam, onOpenIdentity }: {
  userId: string; onClosed: () => void; onUnauthorized: () => void; onOpenTeam: (workspaceId: string) => void; onOpenIdentity: () => void
}) {
  const [data, setData] = useState<Closure | null>(null)
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Step-up secrets stay in memory only and are cleared after every attempt.
  const [password, setPassword] = useState('')
  const [factor, setFactor] = useState('')
  const alive = useRef(true), request = useRef<AbortController | null>(null)

  async function load() {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    try {
      const value = await api<Closure>('/api/account/closure', { signal: controller.signal })
      if (alive.current && !controller.signal.aborted) setData(value)
    } catch (e) {
      if (!alive.current || controller.signal.aborted) return
      if (e instanceof ApiError && e.status === 401) { onUnauthorized(); return }
      setError(errMsg(e))
    }
  }
  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; request.current?.abort() }
  }, [userId])

  async function close() {
    if (busy || !data) return
    const code = factor.trim(), body = { password, ...(data.twoFactorEnabled ? /^\d{6}$/.test(code) ? { code } : { backupCode: code } : {}) }
    setBusy(true); setError(''); setPassword(''); setFactor('')
    try {
      await api('/api/account/closure', { method: 'POST', body })
      if (alive.current) onClosed()
    } catch (e) {
      if (!alive.current) return
      if (e instanceof ApiError && e.status === 401) { onUnauthorized(); return }
      setError(errMsg(e))
      // A blocker can appear while the review is open; show the current list.
      if (e instanceof ApiError && e.status === 409) { setReviewing(false); void load() }
    } finally { if (alive.current) setBusy(false) }
  }

  const blocked = !!data && (data.blockers.workspaces.length > 0 || data.blockers.lastOperator)
  const missingProof = !password ? 'Enter your current password.' : data?.twoFactorEnabled && !factor.trim() ? 'Enter an authenticator or recovery code.' : undefined
  return <SettingsPanel title='Close account' description='Permanently close this account. This cannot be undone.' busy={busy} error={reviewing ? undefined : error || undefined}>
    {!data && !error && <Text role='status'>Loading account closure details…</Text>}
    {data && blocked && <Alert tone='warning' title='Closing is not available yet'>
      <Stack gap={2}>
        {data.blockers.workspaces.length > 0 && <>
          <Text>You are the only owner of these workspaces. Transfer ownership to another member, or delete the workspace, before closing your account.</Text>
          <List>{data.blockers.workspaces.map(workspace => <ListItem key={workspace.id}>
            <Button variant='ghost' onClick={() => onOpenTeam(workspace.id)}>{`Open team settings for ${isolate(workspace.name)}`}</Button>
          </ListItem>)}</List>
        </>}
        {data.blockers.lastOperator && <Text>You are the only instance operator. Grant the operator role to another account first.</Text>}
        <Button variant='secondary' onClick={() => void load()}>Check again</Button>
      </Stack>
    </Alert>}
    {data && !blocked && !data.hasPassword && <Stack gap={2}>
      <Text>Your account signs in through an identity provider. Open Identity sign-in, verify with your provider and choose Close account as the security change.</Text>
      <Button variant='danger' onClick={onOpenIdentity}>Open Identity sign-in</Button>
    </Stack>}
    {data && !blocked && data.hasPassword && !reviewing && <Button variant='danger' onClick={() => { setError(''); setReviewing(true) }}>Review account closure</Button>}
    {data && !blocked && data.hasPassword && reviewing && <ReviewConfirm title='Close this account' tone='danger' reviewKey={userId} autoFocus busy={busy}
      acknowledgements={closureAcknowledgements}
      confirmLabel={busy ? 'Closing account…' : 'Close account'} disabledReason={missingProof} error={error || undefined}
      onConfirm={close} onCancel={() => { setReviewing(false); setPassword(''); setFactor(''); setError('') }}>
      <Stack gap={3}>
        <List>{consequences.map(item => <ListItem key={item}>{item}</ListItem>)}</List>
        <Text>{closurePrivacyNotice}</Text>
        <Field label='Current password' htmlFor='account-closure-password'>
          <Input id='account-closure-password' type='password' autoComplete='current-password' maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} />
        </Field>
        {data.twoFactorEnabled && <Field label='Authenticator or recovery code' htmlFor='account-closure-factor' description='Enter the 6-digit code from your authenticator, or one unused recovery code.'>
          <Input id='account-closure-factor' autoComplete='one-time-code' maxLength={21} required value={factor} onChange={event => setFactor(event.target.value)} />
        </Field>}
      </Stack>
    </ReviewConfirm>}
  </SettingsPanel>
}
