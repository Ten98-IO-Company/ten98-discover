// Identity sign-in failures return to the app as #oidc-error=<CODE>. The callback chooses a code from this closed set and
// never forwards claims or upstream text; the browser shows only the sentence a known code selects. The sentences match
// Campaign's table so both apps explain the same failure the same way.
const oidcReturnMessages = {
  OIDC_INVITE_EMAIL_MISMATCH: 'This invitation is for a different email address. Sign in with the identity that uses the invited email.',
  OIDC_NOT_PROVISIONED: 'This identity does not have access yet. Ask the instance operator for access or a workspace invitation.',
  OIDC_EMAIL_UNVERIFIED: 'Your identity provider has not verified this email address. Verify it there, then sign in again.',
  OIDC_ACCOUNT_EXISTS: 'An account already uses this email address, and single sign-on is not linked to it automatically. Sign in with your email and password.',
  OIDC_RATE_LIMITED: 'Too many sign-in attempts. Wait a few minutes, then try again.',
  OIDC_SIGN_IN_FAILED: 'Single sign-on could not be completed. It may have expired or already been used. Start again.',
} as const

export type OidcReturnCode = keyof typeof oidcReturnMessages
export const oidcReturnCodes = Object.keys(oidcReturnMessages) as readonly OidcReturnCode[]
export const isOidcReturnCode = (value: unknown): value is OidcReturnCode => typeof value === 'string' && Object.hasOwn(oidcReturnMessages, value)
export const oidcReturnMessage = (code: OidcReturnCode): string => oidcReturnMessages[code]

export type AuthNoticeKind = 'info' | 'warning' | 'error'
export interface AuthNotice { kind: AuthNoticeKind; message: string }
// Shown after a request finds the session gone (expiry or revocation elsewhere), never after an explicit sign-out.
export const sessionEndedNotice: AuthNotice = { kind: 'warning', message: 'Your session ended. Sign in again.' }
export const authNoticeTone = (kind: AuthNoticeKind): 'info' | 'warning' | 'danger' => kind === 'error' ? 'danger' : kind
