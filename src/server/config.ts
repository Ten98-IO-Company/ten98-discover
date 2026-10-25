import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appOrigin, parseTrustedProxies, type TrustedProxies } from '@ten98/runtime';
import { validateAnalyticsNetworkConfig } from './analytics-network.ts';
import { collectorAliases } from './collector-alias.ts';

export function environmentValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE`);
  return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
}

export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = environmentValue(name, env);
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

const trustedProxiesSetting = (env: NodeJS.ProcessEnv) => env.TRUSTED_PROXIES?.trim() ? env.TRUSTED_PROXIES : env.ANALYTICS_TRUSTED_PROXIES;

/** Whether the effective trusted-proxy list (TRUSTED_PROXIES, else ANALYTICS_TRUSTED_PROXIES) names any proxy. */
export function trustedProxiesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!trustedProxiesSetting(env)?.trim();
}

// TRUSTED_PROXIES changes only at restart (or in tests that set process.env), so one parsed copy is kept per value.
let parsedProxies: { raw: unknown; list: TrustedProxies } | null = null;

/**
 * Reverse proxies whose X-Forwarded-For is honoured for per-client rate limits. When unset, the analytics proxy list
 * applies, so one list describes the installation's proxy. Empty: the transport peer is the client.
 */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): TrustedProxies {
  const raw = trustedProxiesSetting(env);
  if (!parsedProxies || parsedProxies.raw !== raw) parsedProxies = { raw, list: parseTrustedProxies(raw) };
  return parsedProxies.list;
}

/** The shared APP_URL rule, reported with Discover's established configuration messages. */
function appUrlOrigin(raw: string): string {
  try {
    return appOrigin(raw);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'APP_URL_INVALID') throw error;
    const plainHttp = /outside localhost/.test((error as Error).message);
    throw new Error(plainHttp ? 'Non-local APP_URL requires HTTPS' : 'APP_URL must be an HTTP(S) origin', { cause: error });
  }
}

export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  // Self-hosted installs send no data to Ten98 or third parties. Better Auth turns telemetry on when this variable is
  // truthy, whatever its own option says, so refuse it here instead of trusting the library default.
  if (env.BETTER_AUTH_TELEMETRY && !['0', 'false'].includes(env.BETTER_AUTH_TELEMETRY.trim().toLowerCase())) throw new Error('BETTER_AUTH_TELEMETRY is not supported; Discover never sends telemetry');
  validateAnalyticsNetworkConfig(env);
  trustedProxies(env);
  const aliases = collectorAliases(env);
  const appUrl = appUrlOrigin(env.APP_URL ?? 'http://localhost:3000');
  const databaseUrl = env.DATABASE_URL_FILE ? readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : env.DATABASE_URL;
  if (env.DATABASE_URL_FILE && env.DATABASE_URL) throw new Error('Set only DATABASE_URL or DATABASE_URL_FILE');
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('A PostgreSQL DATABASE_URL is required');
  return { appUrl, databaseUrl, authSecret: secret('AUTH_SECRET', env), artifactDir: resolve(env.ARTIFACT_DIR ?? './data/artifacts'), collectPathAlias: aliases.collectPath, trackerScriptAlias: aliases.scriptPath };
}
