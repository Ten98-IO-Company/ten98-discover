// Every signed-in route that names a workspace or website id, derived from the server's own route table and the OpenAPI
// inventory, so tests/access-order-integration.ts sweeps a new route without anyone adding it by hand.
// The router matches paths with inline regular expressions rather than a data table, so the route patterns are read
// from the server source and expanded into concrete paths. A pattern this expander cannot read fails loudly instead of
// being skipped; tests/workspace-routes.test.ts checks that in the offline suite.
import {readdirSync, readFileSync} from 'node:fs';
import {nativeOpenApi} from '../../src/server/openapi.ts';

const serverDirectory = new URL('../../src/server/', import.meta.url);
/** Placeholders an expanded path carries until the caller substitutes real ids. */
export const routeTokens = {uuid: '{uuid}', visitorKey: '{visitorKey}'} as const;

export interface RoutePattern {file: string; source: string}

/** Route patterns in src/server whose literal prefix is /api/workspaces/ or /api/projects/. */
export function routePatterns(): RoutePattern[] {
  const found: RoutePattern[] = [];
  for (const file of readdirSync(serverDirectory).filter(name => name.endsWith('.ts')).sort()) {
    const text = readFileSync(new URL(file, serverDirectory), 'utf8');
    for (const source of [...constructedPatterns(text), ...literalPatterns(text)]) {
      if (/^\^\/api\/(workspaces|projects)\//.test(source)) found.push({file, source});
    }
  }
  return found;
}

// new RegExp(`^/api/...${id}...`) and new RegExp('^/api/...('+id+')...'): the only id interpolation the router uses.
function constructedPatterns(text: string) {
  const out: string[] = [];
  for (const match of text.matchAll(/new RegExp\(\s*/g)) {
    let at = match.index + match[0].length;
    if (text[at] === '`') {
      const end = text.indexOf('`', at + 1);
      const body = text.slice(at + 1, end);
      if (body.startsWith('^/api/')) out.push(substituteId(body.replaceAll('${id}', '\u0000')));
      continue;
    }
    if (text[at] !== "'") continue;
    let body = '';
    for (;;) {
      const end = text.indexOf("'", at + 1);
      body += text.slice(at + 1, end);
      const rest = /^\s*\+\s*id\s*\+\s*'/.exec(text.slice(end + 1));
      if (!rest) break;
      body += '\u0000';
      at = end + rest[0].length;
    }
    if (body.startsWith('^/api/')) out.push(substituteId(body));
  }
  return out;
}
const substituteId = (body: string) => body.replaceAll('\u0000', '[0-9a-f-]{36}');

// Regular expression literals such as /^\/api\/projects\/([0-9a-f-]{36})\/reports$/ in delegated route handlers.
function literalPatterns(text: string) {
  const out: string[] = [];
  for (const match of text.matchAll(/\/\^\\\/api\\\/(workspaces|projects)\\\//g)) {
    let at = match.index + 1, inClass = false;
    for (; at < text.length; at++) {
      const char = text[at];
      if (char === '\\') { at++; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
    }
    out.push(text.slice(match.index + 1, at).replaceAll('\\/', '/'));
  }
  return out;
}

/** Every concrete path a route pattern accepts, with id slots as routeTokens placeholders. */
export function expandPattern(source: string): string[] {
  let at = 0;
  const fail = (): never => { throw new Error(`Unsupported route pattern syntax at ${at}: ${source}`); };
  const atoms: [string, string][] = [['[0-9a-f-]{36}', routeTokens.uuid], ['[a-f0-9]{64}', routeTokens.visitorKey], ['[^/]+', routeTokens.uuid], ['.*', '']];
  function alternation(): string[] {
    const options = [...sequence()];
    while (source[at] === '|') { at++; options.push(...sequence()); }
    return options;
  }
  function sequence(): string[] {
    let paths = [''];
    while (at < source.length && source[at] !== '|' && source[at] !== ')') {
      let part: string[];
      const atom = atoms.find(([text]) => source.startsWith(text, at));
      if (atom) { at += atom[0].length; part = [atom[1]]; }
      else if (source[at] === '(') {
        at += source.startsWith('(?:', at) ? 3 : 1;
        part = alternation();
        if (source[at++] !== ')') fail();
      } else if (source[at] === '^' || source[at] === '$') { at++; part = ['']; }
      else if (source[at] === '\\') { if (source[at + 1] !== '/') fail(); at += 2; part = ['/']; }
      else if (/[a-z0-9/_-]/i.test(source[at])) part = [source[at++]];
      else return fail();
      if (source[at] === '?') { at++; part = ['', ...part]; }
      paths = paths.flatMap(prefix => part.map(suffix => prefix + suffix));
    }
    return paths;
  }
  const paths = alternation();
  if (at !== source.length) fail();
  // The router drops one trailing slash before matching.
  return [...new Set(paths.map(path => path.replace(/\/$/, '')))];
}

/** OpenAPI bearer paths and browser inventory entries that carry a workspace or website id. */
export function inventoryPaths(): string[] {
  const templates = [...Object.keys(nativeOpenApi.paths), ...Object.keys(nativeOpenApi['x-ten98-browser-operations'])];
  return templates.filter(path => /^\/api\/(workspaces\/\{workspaceId\}|projects\/\{projectId\})(\/|$)/.test(path))
    .map(path => path.replace(/\{(?!visitorKey\})\w+\}/g, routeTokens.uuid));
}

/** Concrete route shapes, each starting /api/workspaces/{uuid} or /api/projects/{uuid}. */
export function workspaceRoutes(): string[] {
  const expanded = routePatterns().flatMap(pattern => expandPattern(pattern.source));
  return [...new Set([...expanded, ...inventoryPaths()])].sort();
}

/** Substitutes the target id into the first slot and fresh values into the rest. */
export function concretePath(route: string, targetId: string, fresh: () => string, visitorKey: string) {
  let first = true;
  return route.replace(/\{(uuid|visitorKey)\}/g, token => {
    if (token === routeTokens.visitorKey) return visitorKey;
    if (first) { first = false; return targetId; }
    return fresh();
  });
}

/**
 * Existing routes that still read their input before resolving access, so a non-member with an invalid input gets a
 * 400 there. The sweep tolerates 400 or 404 only for these exact method and route pairs; remove an entry once its
 * route resolves access first. A route that is not listed must answer a non-member 404 (or 405 for another method).
 */
export const inputBeforeAccess: ReadonlySet<string> = new Set([
  'POST /api/projects/{uuid}/analytics-reset', 'POST /api/projects/{uuid}/analytics-settings',
  'POST /api/projects/{uuid}/analytics/export', 'POST /api/projects/{uuid}/annotations',
  'POST /api/projects/{uuid}/annotations/{uuid}/delete', 'POST /api/projects/{uuid}/annotations/{uuid}/update',
  'POST /api/projects/{uuid}/audits', 'POST /api/projects/{uuid}/audits/{uuid}/pages/export', 'POST /api/projects/{uuid}/cohorts',
  'POST /api/projects/{uuid}/cohorts/{uuid}/delete', 'POST /api/projects/{uuid}/cohorts/{uuid}/update',
  'POST /api/projects/{uuid}/destinations/draft', 'POST /api/projects/{uuid}/destinations/preview',
  'POST /api/projects/{uuid}/destinations/publish', 'POST /api/projects/{uuid}/destinations/rollback', 'POST /api/projects/{uuid}/domains',
  'POST /api/projects/{uuid}/domains/{uuid}/redirect-checks', 'POST /api/projects/{uuid}/domains/{uuid}/update',
  'POST /api/projects/{uuid}/funnels', 'POST /api/projects/{uuid}/funnels/{uuid}/delete', 'GET /api/projects/{uuid}/funnels/{uuid}/result',
  'POST /api/projects/{uuid}/funnels/{uuid}/update', 'GET /api/projects/{uuid}/funnels/{uuid}/witnesses',
  'POST /api/projects/{uuid}/goals', 'POST /api/projects/{uuid}/goals/{uuid}/delete', 'GET /api/projects/{uuid}/goals/{uuid}/result',
  'POST /api/projects/{uuid}/goals/{uuid}/update', 'GET /api/projects/{uuid}/goals/{uuid}/witnesses',
  'GET /api/projects/{uuid}/heatmaps/background', 'POST /api/projects/{uuid}/replays/{uuid}/saved',
  'POST /api/projects/{uuid}/report-templates', 'POST /api/projects/{uuid}/report-templates/{uuid}',
  'POST /api/projects/{uuid}/report-templates/{uuid}/delete', 'POST /api/projects/{uuid}/reports',
  'POST /api/projects/{uuid}/reports/{uuid}', 'POST /api/projects/{uuid}/reports/{uuid}/delete',
  'POST /api/projects/{uuid}/reports/{uuid}/shares', 'GET /api/projects/{uuid}/saved-keywords/refreshes/list',
  'POST /api/projects/{uuid}/website-shares', 'POST /api/projects/{uuid}/website-shares/{uuid}/revoke',
  'POST /api/workspaces/{uuid}/api-keys', 'POST /api/workspaces/{uuid}/boards', 'POST /api/workspaces/{uuid}/boards/preview',
  'GET /api/workspaces/{uuid}/boards/{uuid}/cards/{uuid}', 'POST /api/workspaces/{uuid}/boards/{uuid}/clone',
  'POST /api/workspaces/{uuid}/boards/{uuid}/delete', 'POST /api/workspaces/{uuid}/boards/{uuid}/shares',
  'POST /api/workspaces/{uuid}/boards/{uuid}/shares/{uuid}/publish', 'POST /api/workspaces/{uuid}/boards/{uuid}/shares/{uuid}/revoke',
  'POST /api/workspaces/{uuid}/boards/{uuid}/update', 'POST /api/workspaces/{uuid}/invitations',
  'POST /api/workspaces/{uuid}/members/{uuid}/role', 'POST /api/workspaces/{uuid}/provider-requests/control',
  'POST /api/workspaces/{uuid}/providers', 'POST /api/workspaces/{uuid}/providers/{uuid}/update', 'POST /api/workspaces/{uuid}/rename',
  'POST /api/workspaces/{uuid}/retention/preview', 'POST /api/workspaces/{uuid}/retention/save',
  'GET /api/workspaces/{uuid}/tracked-assets', 'POST /api/workspaces/{uuid}/tracked-assets',
  'POST /api/workspaces/{uuid}/tracked-assets/{uuid}/delete', 'GET /api/workspaces/{uuid}/tracked-assets/{uuid}/report',
  'POST /api/workspaces/{uuid}/tracked-assets/{uuid}/shares', 'POST /api/workspaces/{uuid}/tracked-assets/{uuid}/shares/{uuid}/revoke',
  'POST /api/workspaces/{uuid}/tracked-assets/{uuid}/update', 'POST /api/workspaces/{uuid}/two-factor',
]);
