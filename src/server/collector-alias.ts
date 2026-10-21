import { createHash } from 'node:crypto';

// Optional first-party aliases, like Umami's COLLECT_API_ENDPOINT/TRACKER_SCRIPT_NAME.
// /api/collect and /tracker.js always keep working; an alias only adds a second name.
export const COLLECT_PATH = '/api/collect';
const collectPattern = /^\/[a-z0-9][a-z0-9/_-]{0,63}$/i;
const scriptPattern = /^\/[a-z0-9][a-z0-9/_-]{0,60}\.js$/i;
// Application, framework and public-asset names an alias must never shadow.
const reservedPrefixes = ['/api', '/share', '/assets', '/vendor', '/src', '/node_modules'];
const reservedFiles = ['/tracker.js', '/destinations.js', '/replay.js', '/performance.js', '/favicon.svg', '/tracking-consent.css'];

let scriptTag: { script: string; etag: string } | undefined;

export type CollectorAliases = { collectPath: string | null; scriptPath: string | null };

function alias(name: string, pattern: RegExp, env: NodeJS.ProcessEnv): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (!pattern.test(value) || value.endsWith('/') || value.includes('//')) throw new Error(`${name} must be a single absolute path such as ${pattern === scriptPattern ? '/stats.js' : '/stats/event'}`);
  if (reservedFiles.includes(lower) || reservedPrefixes.some(prefix => lower === prefix || lower.startsWith(prefix + '/'))) throw new Error(`${name} collides with an existing application route`);
  return value;
}

export function collectorAliases(env: NodeJS.ProcessEnv = process.env): CollectorAliases {
  // The collect pattern has no dot and the script pattern requires .js, so the two can never collide.
  return { collectPath: alias('COLLECT_PATH_ALIAS', collectPattern, env), scriptPath: alias('TRACKER_SCRIPT_ALIAS', scriptPattern, env) };
}

/** Map the configured collector alias onto the one native collect route; every other path is unchanged. */
export function collectorRoutePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.startsWith('/api/')) return path; // aliases never live under /api
  const { collectPath } = collectorAliases(env);
  return collectPath !== null && path === collectPath ? COLLECT_PATH : path;
}

/**
 * Serve the aliases outside /api. The original Request is handed to the API handler unchanged so the
 * alias keeps the transport peer and passes the identical origin, consent and rate-limit admission.
 */
export function collectorAliasResponse(request: Request, script: string, handle: (request: Request) => Promise<Response>, env: NodeJS.ProcessEnv = process.env): Promise<Response> | Response | undefined {
  const { collectPath, scriptPath } = collectorAliases(env);
  if (collectPath === null && scriptPath === null) return undefined;
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (path === collectPath) return handle(request);
  if (path !== scriptPath) return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  if (scriptTag?.script !== script) scriptTag = { script, etag: `"${createHash('sha256').update(script).digest('base64url').slice(0, 27)}"` };
  const { etag } = scriptTag;
  const headers = { 'content-type': 'text/javascript; charset=utf-8', etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : script, { headers });
}
