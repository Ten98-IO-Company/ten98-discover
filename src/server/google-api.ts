import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { disconnectGoogle, getGoogleApp, googleCallback, googleSignedIn, listGoogleProperties, saveGoogleApp, selectGoogleProperty, startGoogleConnect } from './google.ts';
import { enqueueGoogleImport, listGoogleConnections, readGoogleImport } from './google-jobs.ts';
import { readJson } from './validation.ts';

function json(value: unknown, status = 200, additional?: HeadersInit) { return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...additional } }); }
async function limit(key: string, maximum: number) {
  const result = await getDatabase().pool.query(`INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),1)
    ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum]);
  if (result.rows[0].count > maximum) throw new FoundationError(429, 'Too many Google reporting requests. Wait a minute and try again.');
}
export async function handleGoogle(request: Request): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  const project = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/google(?:\/(.*))?$/i);
  if (!project && !path.startsWith('/api/google/')) return null;
  if (path === '/api/google/callback' && request.method === 'GET') return googleCallback(request);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  if (request.method === 'POST' && request.headers.get('origin') !== getConfig().appUrl) throw new FoundationError(403, 'This action must originate from the application.');
  const session = await googleSignedIn(request);
  await limit(`google:${request.method === 'GET' ? 'read' : 'write'}:${session.user.id}`, request.method === 'GET' ? 120 : 30);
  if (path === '/api/google/app') return json(request.method === 'GET' ? await getGoogleApp(session.user.id) : await saveGoogleApp(session.user.id, await readJson(request)));
  if (!project) return json({ error: 'Not found.' }, 404);
  const [, projectId, operation = ''] = project;
  if (operation === '' && request.method === 'GET') return json(await listGoogleConnections(projectId, session.user.id));
  if (operation === 'connect' && request.method === 'POST') {
    const { cookie, ...body } = await startGoogleConnect(projectId, session, await readJson(request));
    return json(body, 200, { 'set-cookie': cookie });
  }
  const connection = operation.match(/^connections\/([0-9a-f-]{36})\/(properties|select|disconnect|imports)$/i);
  if (connection && request.method === 'POST') {
    const body = await readJson(request), [, connectionId, action] = connection;
    if (action === 'properties') return json(await listGoogleProperties(projectId, session.user.id, connectionId, body));
    if (action === 'select') return json(await selectGoogleProperty(projectId, session.user.id, connectionId, body));
    if (action === 'disconnect') return json(await disconnectGoogle(projectId, session.user.id, connectionId, body));
    return json(await enqueueGoogleImport(projectId, session.user.id, connectionId, body), 202);
  }
  const report = operation.match(/^imports\/([0-9a-f-]{36})$/i);
  if (report && request.method === 'GET') return json(await readGoogleImport(projectId, session.user.id, report[1], url.searchParams.get('offset') ?? 0));
  return json({ error: 'Not found.' }, 404);
}
