import { createHash } from 'node:crypto';
import { clientLimitKey as runtimeClientLimitKey, resolveClientAddress } from '@ten98/runtime';
import { analyticsNetworkMode, extractAnalyticsPeer } from './analytics-network.ts';
import { secret, trustedProxies, trustedProxiesConfigured } from './config.ts';

/** The connecting client for per-client rate limits, or null when unknown. Ephemeral input: never stored, logged or returned. */
export function requestClientAddress(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClientAddress(extractAnalyticsPeer(request), request.headers.get('x-forwarded-for'), trustedProxies(env));
}

/**
 * Per-client limit key `<scope>:client:<hmac>`, from the runtime's clientLimitKey: the address is stored only as a keyed
 * hash, IPv6 clients share one key per /56 and every unresolved client shares `<scope>:client:unresolved`, apart from all
 * resolved clients. The runtime's own scope is the fixed `client`, because Discover scopes contain colons.
 */
export function clientLimitKey(scope: string, address: string | null, key: string): string {
  return `${scope}:${runtimeClientLimitKey('client', address, key)}`;
}

export function clientRateKey(request: Request, scope: string, env: NodeJS.ProcessEnv = process.env): string {
  return clientLimitKey(scope, requestClientAddress(request, env), secret('AUTH_SECRET', env));
}

/**
 * Whether resolved addresses identify individual visitors: a trusted proxy list is configured, or ANALYTICS_NETWORK_MODE=direct
 * asserts that clients connect with no reverse proxy in front. Otherwise a proxy's own address could stand for every visitor.
 * Direct mode behind a proxy is a misconfiguration that makes the proxy address one shared key again.
 */
export function clientAddressesIdentifyVisitors(env: NodeJS.ProcessEnv = process.env): boolean {
  return trustedProxiesConfigured(env) || analyticsNetworkMode(env) === 'direct';
}

/**
 * Per-client key for high-volume public routes, or null when no trustworthy per-client key exists: the installation does not
 * identify visitors by address, or this address is unresolved. Callers then rely on their other limits instead of one shared key.
 */
export function visitorRateKey(request: Request, scope: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!clientAddressesIdentifyVisitors(env)) return null;
  const address = requestClientAddress(request, env);
  return address === null ? null : clientLimitKey(scope, address, secret('AUTH_SECRET', env));
}

/** Per-address limit scopes. Their keys are unkeyed digests anyone holding the address can derive, so account closure deletes them. */
export const emailLimitScopes = ['signin', 'password-recovery:email', 'invitation-email'] as const;
export function emailLimitKey(scope: typeof emailLimitScopes[number], email: string): string {
  return `${scope}:${createHash('sha256').update(email).digest('hex')}`;
}
