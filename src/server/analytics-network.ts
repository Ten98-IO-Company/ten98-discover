import { isIP, Socket } from 'node:net';
import { normalizeClientAddress, parseTrustedProxies, resolveClientAddress, type TrustedProxies } from '@ten98/runtime';

function configError(): never {
  throw Object.assign(new Error('Invalid analytics network configuration.'), { code: 'ANALYTICS_NETWORK_CONFIG' });
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

// Address parsing and the X-Forwarded-For walk are the shared runtime's; this module keeps the analytics mode and exclusion policy.
function addressList(raw: unknown): TrustedProxies {
  try {
    return parseTrustedProxies(raw);
  } catch {
    configError();
  }
}

// The values change only at restart (or in tests that set process.env), so one parsed copy is kept per value set.
let parsed: { key: string; config: { mode: unknown; trusted: TrustedProxies; excluded: TrustedProxies } } | null = null;
function readConfig(env: NodeJS.ProcessEnv) {
  if (!env || typeof env !== 'object') configError();
  for (const key of ['ANALYTICS_NETWORK_MODE', 'ANALYTICS_TRUSTED_PROXIES', 'ANALYTICS_EXCLUDED_IPS']) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (descriptor && (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string'))) configError();
  }
  const mode = ownValue(env, 'ANALYTICS_NETWORK_MODE') ?? 'off';
  const trustedRaw = ownValue(env, 'ANALYTICS_TRUSTED_PROXIES') ?? '', excludedRaw = ownValue(env, 'ANALYTICS_EXCLUDED_IPS') ?? '';
  const key = JSON.stringify([mode, trustedRaw, excludedRaw]);
  if (parsed?.key === key) return parsed.config;
  if (!['off', 'direct', 'proxy'].includes(mode as string)) configError();
  const trusted = addressList(trustedRaw), excluded = addressList(excludedRaw);
  // Neither list may run silently inert: proxy needs trusted peers, and off resolves no address to exclude.
  if (mode === 'proxy' && !(trustedRaw as string).trim() || mode === 'off' && (excludedRaw as string).trim()) configError();
  parsed = { key, config: { mode, trusted, excluded } };
  return parsed.config;
}

/** Explicit CLI validation; invalid settings never include addresses in errors. */
export function validateAnalyticsNetworkConfig(env: NodeJS.ProcessEnv = process.env): void {
  readConfig(env);
}

/** Read the original srvx Node transport only; a cloned/plain Request has no peer. */
export function extractAnalyticsPeer(request: Request): string | undefined {
  const runtime = ownValue(request, 'runtime');
  if (ownValue(runtime, 'name') !== 'node') return undefined;
  const incoming = ownValue(ownValue(runtime, 'node'), 'req');
  const socket = ownValue(incoming, 'socket');
  if (!(socket instanceof Socket)) return undefined;
  try {
    return normalizeClientAddress(socket.remoteAddress) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The result is ephemeral input for a keyed analytics hash, never a stored/logged IP. */
export function resolveAnalyticsNetwork(request: Request, peerAddress?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const { mode, trusted } = readConfig(env);
  if (mode === 'off') return null;
  const peer = normalizeClientAddress(peerAddress);
  if (peer === null) return null;
  if (mode === 'direct') return peer;
  // Unlike a rate-limit key, proxy mode leaves an untrusted peer unknown rather than treating it as the client.
  if (!trusted.check(peer, isIP(peer) === 4 ? 'ipv4' : 'ipv6')) return null;
  return resolveClientAddress(peer, request.headers.get('x-forwarded-for'), trusted);
}

/** Umami IGNORE_IP equivalent over the trust-mode address only: headers never trigger it, and an unknown address is never excluded,
 * so behind an edge that appends to a client-supplied X-Forwarded-For a malformed or over-long chain opts that client back in. */
export function analyticsAddressExcluded(request: Request, peerAddress = extractAnalyticsPeer(request), env: NodeJS.ProcessEnv = process.env): boolean {
  const address = resolveAnalyticsNetwork(request, peerAddress, env);
  return address !== null && readConfig(env).excluded.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}
