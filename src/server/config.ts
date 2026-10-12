import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE`);
  const value = env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawUrl = env.APP_URL ?? 'http://localhost:3000';
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('APP_URL must be an HTTP(S) origin');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Non-local APP_URL requires HTTPS');
  const databaseUrl = env.DATABASE_URL_FILE ? readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : env.DATABASE_URL;
  if (env.DATABASE_URL_FILE && env.DATABASE_URL) throw new Error('Set only DATABASE_URL or DATABASE_URL_FILE');
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('A PostgreSQL DATABASE_URL is required');
  return { appUrl: url.origin, databaseUrl, authSecret: secret('AUTH_SECRET', env), bootstrapToken: secret('BOOTSTRAP_TOKEN', env), artifactDir: resolve(env.ARTIFACT_DIR ?? './data/artifacts') };
}
