import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { disconnectGoogle, getGoogleApp, googleCallback, googleSignedIn, listGoogleProperties, saveGoogleApp, selectGoogleProperty, startGoogleConnect } from './google.ts';
import { enqueueGoogleImport, listGoogleConnections, readGoogleImport } from './google-jobs.ts';
import { readJson } from './validation.ts';
import { inspectGoogleUrls } from './google-inspection.ts';
import { requireWorkspaceFactor } from './teams.ts';

function json(value: unknown, status = 200, additional?: HeadersInit) { return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...additional } }); }
async function limit(key: string, maximum: number) {
  const result = await getDatabase().pool.query(`INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),1)
    ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum]);
  if (result.rows[0].count > maximum) throw new FoundationError(429, 'Too many Google reporting requests. Wait a minute and try again.');
}
// bearer is set only after the api.ts gate admitted a google:read key for one of the two snapshot reads.
export async function handleGoogle(request: Request, bearer?: { userId: string; token: string }): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  const project = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/google(?:\/(.*))?$/i);
  if (!project && !path.startsWith('/api/google/')) return null;
  // Defence in depth: the gate already refuses every other Google route to a key.
  if (bearer && (request.method !== 'GET' || !project)) throw new FoundationError(403, 'This route requires browser sign-in or is outside the API key scope.');
  // Under a key each listed query parameter is accepted once and nothing else, as on every bearer route.
  const strictQuery = (allowed: string[]) => { const names = [...url.searchParams.keys()]; if (bearer && names.some((name, index) => !allowed.includes(name) || names.indexOf(name) !== index)) throw new FoundationError(400, 'Use only the listed query parameters, each at most once.'); };
  if (path === '/api/google/callback' && request.method === 'GET') return googleCallback(request);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  if (request.method === 'POST' && request.headers.get('origin') !== getConfig().appUrl) throw new FoundationError(403, 'This action must originate from the application.');
  const session = bearer ? null : await googleSignedIn(request), userId = bearer?.userId ?? session!.user.id;
  await requireWorkspaceFactor(path, userId);
  await limit(`google:${request.method === 'GET' ? 'read' : 'write'}:${userId}`, request.method === 'GET' ? 120 : 30);
  if (path === '/api/google/app') return json(request.method === 'GET' ? await getGoogleApp(userId) : await saveGoogleApp(userId, await readJson(request)));
  if (!project) return json({ error: 'Not found.' }, 404);
  const [, projectId, operation = ''] = project;
  if (operation === '' && request.method === 'GET') { strictQuery([]); return json(await listGoogleConnections(projectId, userId, bearer?.token)); }
  if (operation === 'connect' && request.method === 'POST') {
    const { cookie, ...body } = await startGoogleConnect(projectId, session!, await readJson(request));
    return json(body, 200, { 'set-cookie': cookie });
  }
  const inspection = operation.match(/^connections\/([0-9a-f-]{36})\/inspect$/i);
  if (inspection && request.method === 'POST') {
    if (url.search) throw new FoundationError(400, 'URL inspection does not accept query parameters.');
    const result = await inspectGoogleUrls(projectId, userId, inspection[1], await readJson(request, 65_536), request.signal);
    const current = await googleSignedIn(request);
    if (current.user.id !== session!.user.id || current.session.id !== session!.session.id) throw new FoundationError(401, 'Sign in to continue.');
    return json(result);
  }
  const connection = operation.match(/^connections\/([0-9a-f-]{36})\/(properties|select|disconnect|imports)$/i);
  if (connection && request.method === 'POST') {
    const body = await readJson(request), [, connectionId, action] = connection;
    if (action === 'properties') return json(await listGoogleProperties(projectId, userId, connectionId, body));
    if (action === 'select') return json(await selectGoogleProperty(projectId, userId, connectionId, body));
    if (action === 'disconnect') return json(await disconnectGoogle(projectId, userId, connectionId, body));
    return json(await enqueueGoogleImport(projectId, userId, connectionId, body), 202);
  }
  const report = operation.match(/^imports\/([0-9a-f-]{36})$/i);
  if (report && request.method === 'GET') { strictQuery(['offset']); return json(await readGoogleImport(projectId, userId, report[1], url.searchParams.get('offset') ?? 0, bearer?.token)); }
  return json({ error: 'Not found.' }, 404);
}
