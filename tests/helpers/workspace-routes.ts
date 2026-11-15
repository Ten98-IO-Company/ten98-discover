// Every signed-in route that names a workspace or website id, derived from the server's own route table and the OpenAPI
// inventory, so tests/access-order-integration.ts sweeps a new route without anyone adding it by hand. The sweep's GET query
// is built here too, from the query parameters the OpenAPI document declares.
// The router matches paths with inline regular expressions rather than a data table, so the route patterns are read
// from the server source and expanded into concrete paths. A pattern this expander cannot read fails loudly instead of
// being skipped; tests/workspace-routes.test.ts checks that in the offline suite.
// Two kinds of pattern hand the rest of the path to another matcher. A catch-all tail, /google(?:/(.*))?, is expanded into
// the sub-routes its handler matches the tail against, read from that handler's source. A prefix ending (/|$), the reports
// delegation, must have its sub-routes among the patterns of the handler it delegates to. Either fails if none are found.
import {readdirSync, readFileSync} from 'node:fs';
import {nativeOpenApi} from '../../src/server/openapi.ts';

const serverDirectory = new URL('../../src/server/', import.meta.url);
/** Placeholders an expanded path carries until the caller substitutes real ids. */
export const routeTokens = {uuid: '{uuid}', visitorKey: '{visitorKey}'} as const;

export interface RoutePattern {file: string; source: string; tails?: string[]}

/** Route patterns in src/server whose literal prefix is /api/workspaces/ or /api/projects/. */
export function routePatterns(): RoutePattern[] {
  const found: RoutePattern[] = [];
  for (const file of readdirSync(serverDirectory).filter(name => name.endsWith('.ts')).sort()) {
    const text = readFileSync(new URL(file, serverDirectory), 'utf8');
    for (const source of [...constructedPatterns(text), ...literalPatterns(text)]) {
      if (!/^\^\/api\/(workspaces|projects)\//.test(source)) continue;
      if (!source.includes('(.*)')) { found.push({file, source}); continue; }
      const tails = catchAllTails(text);
      if (!tails.length) throw new Error(`${file}: no sub-route matchers found for the catch-all route ${source}`);
      found.push({file, source, tails});
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
  return [...text.matchAll(/\/\^\\\/api\\\/(workspaces|projects)\\\//g)].map(match => regexBody(text, match.index));
}

/** The source of the regular expression literal whose opening slash is at `start`, with \/ written as /. */
function regexBody(text: string, start: number) {
  let at = start + 1, inClass = false;
  for (; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') { at++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) break;
  }
  return text.slice(start + 1, at).replaceAll('\\/', '/');
}

// A handler matches a catch-all tail against relative sub-route patterns, tail.match(/^connections\/(…)\/inspect$/i), and
// compares it with literal names, tail === 'connect'. The tail variable is the one those relative patterns are applied to.
function catchAllTails(text: string): string[] {
  const tails = new Set<string>(), names = new Set<string>();
  for (const match of text.matchAll(/\b(\w+)\.match\(\/\^(?!\\\/)/g)) {
    names.add(match[1]);
    for (const tail of expandPattern(regexBody(text, match.index + match[0].length - 2))) tails.add(tail);
  }
  for (const name of names) for (const match of text.matchAll(new RegExp(`\\b${name}\\s*===\\s*'([a-z0-9/_-]*)'`, 'gi'))) tails.add(match[1]);
  return [...tails].sort();
}

/** Every concrete path a route pattern accepts, with id slots as routeTokens placeholders. A catch-all (.*) needs `tails`. */
export function expandPattern(source: string, tails?: string[]): string[] {
  let at = 0;
  const fail = (): never => { throw new Error(`Unsupported route pattern syntax at ${at}: ${source}`); };
  const atoms: [string, string][] = [['[0-9a-f-]{36}', routeTokens.uuid], ['[a-f0-9]{64}', routeTokens.visitorKey], ['[^/]+', routeTokens.uuid]];
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
      else if (source.startsWith('.*', at)) { at += 2; part = tails ?? fail(); }
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
  const patterns = routePatterns().map(pattern => ({...pattern, paths: expandPattern(pattern.source, pattern.tails)}));
  const expanded = patterns.flatMap(pattern => pattern.paths);
  for (const pattern of patterns.filter(item => item.source.endsWith('(/|$)'))) {
    for (const prefix of pattern.paths) {
      if (!expanded.some(path => path.startsWith(`${prefix}/`))) throw new Error(`${pattern.file}: ${pattern.source} delegates ${prefix}/…, but no route pattern under it was found`);
    }
  }
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

// Query parameters that only cookie routes read, so the OpenAPI document does not declare them.
const cookieQueryNames = ['after', 'coverage', 'direction', 'environment', 'mode', 'order', 'resourceKind', 'revision', 'scope', 'searchIn', 'sort'];

/** Every query parameter name the OpenAPI document declares, plus the cookie-only ones. */
export function queryNames(): string[] {
  const names = new Set(cookieQueryNames);
  (function collect(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.in === 'query' && typeof item.name === 'string') names.add(item.name);
    for (const child of Object.values(item)) collect(child);
  })(nativeOpenApi);
  return [...names].sort();
}

/** A query no route accepts: a name no route knows, then every known name with a value no date, number, id, cursor or choice matches. */
export function invalidQuery(): URLSearchParams {
  return new URLSearchParams([['unexpected', '1'], ...queryNames().map(name => [name, '~'])]);
}

/**
 * Routes the sweep does not hold to the non-member refusal, keyed `METHOD route`, each with its reason. Empty: api.ts refuses a
 * non-member on every workspace and website route before any handler runs. An entry must name a current route and give a reason.
 */
export const sweepExceptions: ReadonlyMap<string, string> = new Map();

/**
 * Team routes whose role decision is made by the shared @ten98/runtime team controller. api.ts refuses a non-member before any
 * of them, but a member below the role can still get an input error (400) before the controller's refusal: the controller
 * reads the input first (invitations, role, rename, two-factor), or it takes no input and Discover checks for an empty object
 * before handing over (remove, revoke, resend, new link). Changing that order means moving the role decision out of the
 * controller, which is tracked upstream.
 */
export const sharedControllerRoutes: ReadonlySet<string> = new Set([
  'POST /api/workspaces/{uuid}/invitations', 'POST /api/workspaces/{uuid}/members/{uuid}/role',
  'POST /api/workspaces/{uuid}/rename', 'POST /api/workspaces/{uuid}/two-factor',
  'POST /api/workspaces/{uuid}/members/{uuid}/remove', 'POST /api/workspaces/{uuid}/invitations/{uuid}/revoke',
  'POST /api/workspaces/{uuid}/invitations/{uuid}/resend', 'POST /api/workspaces/{uuid}/invitations/{uuid}/new-link',
]);
