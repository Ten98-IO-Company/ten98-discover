import { BlockList, isIP, Socket, SocketAddress } from 'node:net';

function configError(): never {
  throw Object.assign(new Error('Invalid analytics network configuration.'), { code: 'ANALYTICS_NETWORK_CONFIG' });
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || /[%\s\[\]"']/.test(value)) return null;
  const version = isIP(value);
  if (!version) return null;
  try {
    const address = new SocketAddress({ address: value, family: version === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
    return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  } catch {
    return null;
  }
}

function readConfig(env: NodeJS.ProcessEnv) {
  if (!env || typeof env !== 'object') configError();
  for (const key of ['ANALYTICS_NETWORK_MODE', 'ANALYTICS_TRUSTED_PROXIES']) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (descriptor && (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string'))) configError();
  }
  const mode = ownValue(env, 'ANALYTICS_NETWORK_MODE') ?? 'off';
  const raw = ownValue(env, 'ANALYTICS_TRUSTED_PROXIES') ?? '';
  if (!['off', 'direct', 'proxy'].includes(mode as string) || typeof raw !== 'string' || raw.length > 4096) configError();
  const entries = raw.trim() ? raw.split(',').map(value => value.trim()) : [];
  if (entries.length > 32 || (mode === 'proxy' && entries.length === 0)) configError();
  const trusted = new BlockList();
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.length > 2) configError();
    const address = normalizeIp(parts[0]);
    if (address === null) configError();
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    try {
      if (parts.length === 1) trusted.addAddress(address, family);
      else {
        if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) configError();
        let prefix = Number(parts[1]);
        const originalFamily = isIP(parts[0]);
        if (prefix > (originalFamily === 4 ? 32 : 128)) configError();
        // A mapped IPv6 subnet describes IPv4 only within its 96-bit mapped prefix.
        if (originalFamily === 6 && family === 'ipv4') {
          if (prefix < 96) configError();
          prefix -= 96;
        }
        trusted.addSubnet(address, prefix, family);
      }
    } catch {
      configError();
    }
  }
  return { mode, trusted };
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
    return normalizeIp(socket.remoteAddress) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The result is ephemeral input for a keyed analytics hash, never a stored/logged IP. */
export function resolveAnalyticsNetwork(request: Request, peerAddress?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const { mode, trusted } = readConfig(env);
  if (mode === 'off') return null;
  const peer = normalizeIp(peerAddress);
  if (peer === null) return null;
  if (mode === 'direct') return peer;
  const isTrusted = (address: string) => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  if (!isTrusted(peer)) return null;
  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded || Buffer.byteLength(forwarded, 'utf8') > 4096) return null;
  const parts = forwarded.split(',');
  if (parts.length > 20) return null;
  const chain = parts.map(value => normalizeIp(value.replace(/^[ \t]+|[ \t]+$/g, '')));
  if (chain.some(value => value === null)) return null;
  for (let index = chain.length - 1; index >= 0; index--) {
    const address = chain[index]!;
    if (!isTrusted(address)) return address;
  }
  return null;
}
