import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { authNoticeTone, oidcReturnCodes, oidcReturnMessage, sessionEndedNotice } from '../src/lib/auth-messages.ts'

const route = readFileSync(new URL('../src/routes/index.tsx', import.meta.url), 'utf8')
const body = (name: string) => {
  const start = route.search(new RegExp(`(function ${name}\\(|const ${name} = )`))
  assert.notEqual(start, -1, `${name} exists`)
  // A one-line arrow ends at its line; a function ends at its closing brace.
  const rest = route.slice(start)
  return rest.slice(0, rest.startsWith('const') ? rest.indexOf('\n') : rest.search(/\r?\n {2}\}\r?\n/) + 4)
}

test('SSO return failures use one closed code-to-message table with Campaign copy', () => {
  assert.deepEqual([...oidcReturnCodes].sort(), ['OIDC_ACCOUNT_EXISTS', 'OIDC_EMAIL_UNVERIFIED', 'OIDC_INVITE_EMAIL_MISMATCH', 'OIDC_NOT_PROVISIONED', 'OIDC_RATE_LIMITED', 'OIDC_SIGN_IN_FAILED'])
  assert.equal(oidcReturnMessage('OIDC_NOT_PROVISIONED'), 'This identity does not have access yet. Ask the instance operator for access or a workspace invitation.')
  assert.equal(oidcReturnMessage('OIDC_INVITE_EMAIL_MISMATCH'), 'This invitation is for a different email address. Sign in with the identity that uses the invited email.')
  assert.equal(oidcReturnMessage('OIDC_EMAIL_UNVERIFIED'), 'Your identity provider has not verified this email address. Verify it there, then sign in again.')
  assert.equal(oidcReturnMessage('OIDC_ACCOUNT_EXISTS'), 'An account already uses this email address, and single sign-on is not linked to it automatically. Sign in with your email and password.')
  assert.equal(oidcReturnMessage('OIDC_RATE_LIMITED'), 'Too many sign-in attempts. Wait a few minutes, then try again.')
  assert.equal(oidcReturnMessage('OIDC_SIGN_IN_FAILED'), 'Single sign-on could not be completed. It may have expired or already been used. Start again.')
  assert.match(route, /value\.kind === 'oidc-error'\) setSsoError\(oidcReturnMessage\(value\.code\)\)/, 'The SSO failure becomes the sign-in error, not a notice.')
})

test('A shown SSO failure never outlives the session or recovery that displayed it', () => {
  assert.match(body('resetSession'), /setSsoError\(''\)/)
  assert.match(body('beginRecovery'), /setSsoError\(''\)/)
})

test('An installation that does not trust provider emails gets the generic failure, not a blame on the provider', () => {
  const oidc = readFileSync(new URL('../src/server/oidc.ts', import.meta.url), 'utf8')
  assert.match(oidc, /if \(!provider\.active\?\.trustVerifiedEmail\) throw new OidcReturnError\([^)]*'OIDC_SIGN_IN_FAILED'\)/)
  assert.match(oidc, /if \(!claims\.emailVerified \|\| !claims\.email\) throw new OidcReturnError\([^)]*'OIDC_EMAIL_UNVERIFIED'\)/)
})

test('An expired session warns on the sign-in screen; an explicit sign-out does not', () => {
  assert.deepEqual(sessionEndedNotice, { kind: 'warning', message: 'Your session ended. Sign in again.' })
  assert.equal(authNoticeTone('warning'), 'warning')
  assert.equal(authNoticeTone('error'), 'danger')
  assert.equal(authNoticeTone('info'), 'info')
  assert.match(body('guardAuth'), /resetSession\('expired'\)/)
  assert.match(body('unauthorized'), /resetSession\('expired'\)/)
  assert.doesNotMatch(body('signOut'), /'expired'/)
  assert.match(body('resetSession'), /if \(reason === 'expired'\) setAuthNotice\(sessionEndedNotice\)/)
  assert.equal([...route.matchAll(/tone=\{authNoticeTone\(authNotice\.kind\)\}/g)].length, 1, 'The shell Alert maps the kind through the shared tone table.')
  assert.match(route, /tone: authNoticeTone\(notice\.kind\)/, 'SignInForm maps the kind through the shared tone table.')
})

test('The sign-in screen offers single sign-on only when the installation enables it', () => {
  assert.match(route, /providers=\{oidcEnabled \? <OidcSignIn \/> : undefined\}/)
  assert.match(route, /oidcEnabled=\{status\?\.oidcEnabled === true\}/)
})
