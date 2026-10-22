import { createHmac } from 'node:crypto';
import { resolveClientAddress } from '@ten98/runtime';
import { extractAnalyticsPeer } from './analytics-network.ts';
import { secret, trustedProxies } from './config.ts';

/** The connecting client for per-client rate limits, or null when unknown. Ephemeral input: never stored, logged or returned. */
export function requestClientAddress(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClientAddress(extractAnalyticsPeer(request), request.headers.get('x-forwarded-for'), trustedProxies(env));
}

/** Per-client limit key. The address is stored only as a keyed hash; every unresolvable client shares one conservative key per scope. */
export function clientLimitKey(scope: string, address: string | null, key: string): string {
  return `${scope}:client:${address === null ? 'unknown' : createHmac('sha256', key).update(address).digest('hex')}`;
}

export function clientRateKey(request: Request, scope: string, env: NodeJS.ProcessEnv = process.env): string {
  return clientLimitKey(scope, requestClientAddress(request, env), secret('AUTH_SECRET', env));
}
