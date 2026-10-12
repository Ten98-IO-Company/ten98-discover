import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { getConfig } from './config.ts';
import { assertSchema, getDatabase } from './db.ts';
import { claimInstallation, FoundationError, getAuth } from './auth.ts';
import { enqueueProbe, reconcileProbes } from './jobs.ts';
import { eventInput, eventPath, InputError, projectInput, readJson } from './validation.ts';
import { projectAnalytics } from './analytics.ts';
import { acceptInvitation, changeRole, createWorkspace, getTeam, inspectInvitation, inviteMember, removeMember, renameWorkspace, revokeInvitation } from './teams.ts';

const id = '[0-9a-f-]{36}';
function json(body: unknown, status = 200, additional?: HeadersInit) {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const extra = new Headers(additional);
  for (const [key, value] of extra) if (key !== 'set-cookie') headers.set(key, value);
  for (const value of extra.getSetCookie()) headers.append('set-cookie', value);
  return Response.json(body, { status, headers });
}

async function limit(key: string, maximum: number) {
  const { rows } = await getDatabase().pool.query(
    `WITH expired AS (DELETE FROM request_limit WHERE minute < floor(extract(epoch FROM now()) / 60) - 60)
     INSERT INTO request_limit(key,minute,count) VALUES ($1,floor(extract(epoch FROM now()) / 60),1)
     ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum],
  );
  if (rows[0].count > maximum) throw new FoundationError(429, 'Too many requests. Wait a minute and try again.');
}

async function signedIn(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) throw new FoundationError(401, 'Sign in to continue.');
  return session.user;
}

async function workspaceAccess(workspaceId: string, userId: string, write = false) {
  const { rows } = await getDatabase().pool.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
  if (!rows[0] || (write && !['owner', 'admin', 'editor'].includes(rows[0].role))) throw new FoundationError(404, 'Workspace not found or unavailable.');
}

async function projectAccess(projectId: string, userId: string, write = false) {
  const { rows } = await getDatabase().pool.query(
    `SELECT p.*,m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id
     WHERE p.id=$1 AND m.user_id=$2`, [projectId, userId],
  );
  if (!rows[0] || (write && !['owner', 'admin', 'editor'].includes(rows[0].role))) throw new FoundationError(404, 'Project not found or unavailable.');
  return rows[0];
}

function authRequest(request: Request, body?: string) {
  const headers = new Headers(request.headers);
  // The initial recipe has no trusted proxy identity configuration.
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip']) headers.delete(header);
  return new Request(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }) });
}

export async function handleApi(request: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/health/live' && request.method === 'GET') return json({ status: 'alive' });
    const config = getConfig();
    await assertSchema();
    if (path === '/api/health/ready' && request.method === 'GET') {
      await access(config.artifactDir, constants.W_OK);
      return json({ status: 'ready' });
    }
    if (path === '/api/status' && request.method === 'GET') {
      const { rows } = await getDatabase().pool.query("SELECT claimed FROM installation WHERE id='instance'");
      return json({ configured: rows[0]?.claimed === true, appUrl: config.appUrl });
    }
    if (path === '/api/collect') {
      const origin = request.headers.get('origin');
      if (!origin) throw new FoundationError(403, 'A configured website origin is required.');
      await limit('collector:global', 6000);
      const allowed = await getDatabase().pool.query('SELECT 1 FROM project WHERE origin=$1 LIMIT 1', [origin]);
      if (!allowed.rowCount) throw new FoundationError(403, 'Website origin is not configured.');
      cors = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '300' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);
      const event = eventInput.parse(await readJson(request));
      const { rows } = await getDatabase().pool.query('SELECT id,origin FROM project WHERE public_key=$1', [event.siteKey]);
      const project = rows[0];
      if (!project || project.origin !== origin || new URL(event.url).origin !== project.origin) throw new FoundationError(403, 'Event does not match the configured website.');
      await limit(`collector:${project.id}`, 3000);
      // Public keys and Origin are not identity proof. Store observations, not unique visitors.
      await getDatabase().pool.query('INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,id) DO NOTHING', [event.eventId, project.id, event.name, eventPath(event.url)]);
      return json({ accepted: true }, 202, cors);
    }
    if (request.method === 'POST' && request.headers.get('origin') !== config.appUrl) throw new FoundationError(403, 'This action must originate from the application.');
    if (request.method === 'POST' && ['/api/invitations/inspect', '/api/invitations/accept'].includes(path)) {
      await limit('invitations:public', 60);
      const input = await readJson(request);
      const token = (input as { token?: unknown } | null)?.token;
      if (typeof token === 'string') await limit(`invitation:${createHash('sha256').update(token).digest('hex')}`, 10);
      if (path.endsWith('/inspect')) {
        const invitation = await inspectInvitation(input);
        return json({ workspaceName: invitation.workspace.name, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt });
      }
      const session = await getAuth().api.getSession({ headers: request.headers });
      const accepted = await acceptInvitation(input, session ? { id: session.user.id, email: session.user.email } : undefined);
      if (!accepted.created) return json({ ...accepted, signedIn: true });
      try {
        const signIn = await getAuth().handler(new Request(`${config.appUrl}/api/auth/sign-in/email`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin: config.appUrl },
          body: JSON.stringify({ email: accepted.email, password: (input as { password: string }).password }),
        }));
        const headers = new Headers();
        for (const cookie of signIn.headers.getSetCookie()) headers.append('set-cookie', cookie);
        return json({ ...accepted, signedIn: signIn.ok }, 200, headers);
      } catch {
        // Membership remains committed if starting a session fails; the person can sign in normally.
        return json({ ...accepted, signedIn: false });
      }
    }
    if (path === '/api/setup' && request.method === 'POST') {
      await limit('setup', 10);
      const body = await readJson(request) as Parameters<typeof claimInstallation>[0];
      await claimInstallation(body);
      const signIn = await getAuth().handler(new Request(`${config.appUrl}/api/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: config.appUrl },
        body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password }),
      }));
      if (!signIn.ok) return json({ error: 'Your owner account was created. Sign in to continue.' }, 409);
      const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      for (const cookie of signIn.headers.getSetCookie()) headers.append('set-cookie', cookie);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    if (path.startsWith('/api/auth/')) {
      if (request.method === 'GET' && path === '/api/auth/get-session') return getAuth().handler(authRequest(request));
      if (request.method === 'POST' && ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)) {
        const body = await readJson(request);
        if (path.endsWith('/sign-in/email')) {
          await limit('signin:global', 60);
          const input = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128) }).strict().parse(body);
          await limit(`signin:${createHash('sha256').update(input.email).digest('hex')}`, 5);
          return getAuth().handler(authRequest(request, JSON.stringify(input)));
        }
        return getAuth().handler(authRequest(request, JSON.stringify(body)));
      }
      return json({ error: 'Authentication route unavailable.' }, 404);
    }
    const user = await signedIn(request);
    if (path === '/api/workspaces' && request.method === 'POST') {
      await limit(`workspaces:${user.id}`, 10);
      const result = await createWorkspace(user.id, await readJson(request));
      return json({ workspace: { ...result.workspace, role: result.role } }, 201);
    }
    if (path === '/api/me' && request.method === 'GET') {
      const { rows } = await getDatabase().pool.query('SELECT w.id,w.name,m.role FROM workspace w JOIN membership m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at,w.id', [user.id]);
      return json({ user: { id: user.id, name: user.name, email: user.email }, workspaces: rows });
    }
    let match = path.match(new RegExp(`^/api/workspaces/(${id})/(team|rename|invitations)$`, 'i'));
    if (match) {
      if (request.method === 'GET' && match[2] === 'team') return json(await getTeam(match[1], user.id));
      if (request.method === 'POST') {
        await limit(`team:${user.id}`, 60);
        if (match[2] === 'rename') return json(await renameWorkspace(match[1], user.id, await readJson(request)));
        if (match[2] === 'invitations') {
          const result = await inviteMember(match[1], user.id, await readJson(request));
          return json({ invitation: result.invitation, inviteUrl: `${config.appUrl}/#invite=${result.token}` }, 201);
        }
      }
    }
    match = path.match(new RegExp(`^/api/workspaces/(${id})/(members|invitations)/(${id})/(role|remove|revoke)$`, 'i'));
    if (match && request.method === 'POST') {
      await limit(`team:${user.id}`, 60);
      const input = await readJson(request);
      if (match[2] === 'members' && match[4] === 'role') { await changeRole(match[1], user.id, match[3], input); return json({ ok: true }); }
      if (match[2] === 'members' && match[4] === 'remove') { z.object({}).strict().parse(input); await removeMember(match[1], user.id, match[3]); return json({ ok: true }); }
      if (match[2] === 'invitations' && match[4] === 'revoke') { z.object({}).strict().parse(input); await revokeInvitation(match[1], user.id, match[3]); return json({ ok: true }); }
    }
    match = path.match(new RegExp(`^/api/workspaces/(${id})/projects$`, 'i'));
    if (match) {
      if (request.method === 'GET') {
        await workspaceAccess(match[1], user.id);
        const { rows } = await getDatabase().pool.query(`SELECT p.id,p.name,p.origin,p.public_key AS "publicKey",(SELECT count(*) FROM event e WHERE e.project_id=p.id) AS "eventCount",(SELECT max(received_at) FROM event e WHERE e.project_id=p.id) AS "lastEventAt" FROM project p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC`, [match[1]]);
        return json({ projects: rows.map(row => ({ ...row, eventCount: Number(row.eventCount) })) });
      }
      if (request.method === 'POST') {
        const input = projectInput.parse(await readJson(request));
        const client = await getDatabase().pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [match[1]]);
          const access = await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [match[1], user.id]);
          if (!['owner', 'admin', 'editor'].includes(access.rows[0]?.role)) throw new FoundationError(404, 'Workspace not found or unavailable.');
          const { rows } = await client.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5) RETURNING id,name,origin,public_key AS "publicKey"', [randomUUID(), match[1], input.name, input.origin, randomUUID()]);
          await client.query('COMMIT');
          return json({ project: rows[0] }, 201);
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }
    }
    match = path.match(new RegExp(`^/api/projects/(${id})/(events|analytics|jobs|check-worker)$`, 'i'));
    if (match) {
      await projectAccess(match[1], user.id, request.method !== 'GET');
      if (request.method === 'GET' && match[2] === 'analytics') return json(await projectAnalytics(match[1], user.id, url.searchParams));
      if (request.method === 'GET' && match[2] === 'events') {
        const [events, total] = await Promise.all([
          getDatabase().pool.query('SELECT id,event_name AS "eventName",path,received_at AS "receivedAt" FROM event WHERE project_id=$1 ORDER BY received_at DESC,id DESC LIMIT 50', [match[1]]),
          getDatabase().pool.query('SELECT count(*) AS total FROM event WHERE project_id=$1', [match[1]]),
        ]);
        return json({ events: events.rows, total: Number(total.rows[0].total) });
      }
      if (request.method === 'GET' && match[2] === 'jobs') {
        await reconcileProbes(match[1]);
        const { rows } = await getDatabase().pool.query('SELECT id,status,created_at AS "createdAt",completed_at AS "completedAt",error FROM import_probe WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20', [match[1]]);
        return json({ jobs: rows });
      }
      if (request.method === 'POST' && match[2] === 'check-worker') {
        const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(await readJson(request));
        await limit(`probe:${match[1]}`, 10);
        return json({ job: await enqueueProbe(match[1], user.id, requestId) }, 202);
      }
    }
    return json({ error: 'Route unavailable.' }, 404);
  } catch (error) {
    if (error instanceof FoundationError || error instanceof InputError) return json({ error: error.message }, error.status, cors);
    if (error instanceof z.ZodError) return json({ error: 'Check the submitted fields and try again.' }, 400, cors);
    const code = (error as { code?: string })?.code;
    if (code === '23505') return json({ error: 'This item already exists in the workspace.' }, 409, cors);
    if (['SCHEMA_MISMATCH', '42P01', '42703', 'ECONNREFUSED', 'ENOTFOUND', 'ENOENT', 'EACCES'].includes(code ?? '')) return json({ error: 'The installation is not ready. Check database migrations and storage.' }, 503, cors);
    console.error('Application request failed; inspect configuration and database availability.');
    return json({ error: 'The request could not be completed. Try again or contact your operator.' }, 500, cors);
  }
}
