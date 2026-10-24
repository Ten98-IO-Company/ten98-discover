import { FoundationError } from './auth.ts';
import type { OidcReturnCode } from '../lib/auth-messages.ts';

/** A sign-in refusal whose fixed reason code the OIDC callback may put in its return fragment. */
export class OidcReturnError extends FoundationError {
  readonly code: OidcReturnCode;
  constructor(status: number, message: string, code: OidcReturnCode) {
    super(status, message);
    this.code = code;
  }
}

/** Selects the return code for a failed callback. Unclassified failures, including upstream errors, stay generic. */
export function oidcReturnCode(error: unknown): OidcReturnCode {
  if (error instanceof OidcReturnError) return error.code;
  // Only the local request limiter raises 429 in the callback.
  if (error instanceof FoundationError && error.status === 429) return 'OIDC_RATE_LIMITED';
  return 'OIDC_SIGN_IN_FAILED';
}
