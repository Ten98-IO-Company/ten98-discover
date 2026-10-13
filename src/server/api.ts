import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { getConfig } from './config.ts';
import { assertSchema, getDatabase } from './db.ts';
import { claimInstallation, FoundationError, getAuth } from './auth.ts';
import { enqueueProbe, reconcileProbes } from './jobs.ts';
import { eventInput, InputError, projectInput, readJson } from './validation.ts';
import { analyticsSettings, collectNative, insertApiObservation, saveAnalyticsSettings } from './native-analytics.ts';
import { extractAnalyticsPeer } from './analytics-network.ts';
import { projectAnalytics } from './analytics.ts';
import { exploreAnalytics } from './explorer.ts';
import { getRetention, previewRetention, saveRetention } from './retention.ts';
import {getProjectContext,getContextResearch,updateProjectContext} from './project-context.ts';
import {getPrompt,listPrompts,createPrompts,updatePrompt,setPromptArchived,promptVersions} from './prompts.ts';
import { acceptInvitation, changeRole, createWorkspace, getTeam, inspectInvitation, inviteMember, removeMember, renameWorkspace, revokeInvitation } from './teams.ts';
import { handleAccountSecurity } from './account-security.ts';
import { authenticateApiKey, authorizeApiKey, createApiKey, listApiKeys, parseApiKeyHeaders, revokeApiKey } from './api-keys.ts';
import { assertCredentialKeys, checkProvider, listProviders, revokeProvider, saveBudget, saveProvider } from './providers.ts';
import { assertOidcCredentialsReadable, handleOidc } from './oidc.ts';
import { isInstanceOperator } from './instance-operators.ts';
import { handleReports } from './reports.ts';
import { handleGoogle } from './google-api.ts';
import { assertGoogleCredentialsReadable } from './google.ts';
import {getKeywordResearch,getKeywordRun,refreshKeywordMarkets,quoteKeywordResearch,startKeywordResearch,cancelKeywordResearch,reconcileKeywordResearch} from './keyword-research.ts';
import { addDomain, getDomains, issueDomainChallenge, removeDomain, revokeDomain, updateDomain, verifyDomain } from './domains.ts';
import { getDestinations, getPublicDestinations, previewDestinations, publishDestinations, rollbackDestinations, saveDestinationsDraft } from './destinations.ts';

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
    const apiToken = parseApiKeyHeaders(request.headers);
    const principal = apiToken ? await authenticateApiKey(apiToken) : null;
    if (principal) {
      const workspaceRoute = path.match(new RegExp(`^/api/workspaces/(${id})/(projects|team)$`, 'i'));
      const projectRoute = path.match(new RegExp(`^/api/projects/(${id})/(events|analytics|explore)$`, 'i'));
      if (workspaceRoute && (request.method === 'GET' || (request.method === 'POST' && workspaceRoute[2] === 'projects'))) {
        await authorizeApiKey(apiToken!, workspaceRoute[1], workspaceRoute[2] === 'team' ? 'team:read' : request.method === 'GET' ? 'projects:read' : 'projects:write');
      } else if (projectRoute && (request.method === 'GET' || (request.method === 'POST' && projectRoute[2] === 'events'))) {
        const target = await getDatabase().pool.query('SELECT workspace_id FROM project WHERE id=$1 AND workspace_id=$2', [projectRoute[1], principal.workspaceId]);
        if (!target.rowCount) throw new FoundationError(404, 'Project not found or unavailable.');
        await authorizeApiKey(apiToken!, target.rows[0].workspace_id, request.method === 'GET' ? 'analytics:read' : 'events:write');
      } else throw new FoundationError(403, 'This route requires browser sign-in or is outside the API key scope.');
      await limit(`api-key:${principal.id}`, 120);
    }
    if (path === '/api/health/ready' && request.method === 'GET') {
      await assertCredentialKeys();
      await assertOidcCredentialsReadable();
      await assertGoogleCredentialsReadable();
      await access(config.artifactDir, constants.W_OK);
      return json({ status: 'ready' });
    }
    if (path === '/api/status' && request.method === 'GET') {
      const { rows } = await getDatabase().pool.query("SELECT claimed FROM installation WHERE id='instance'");
      return json({ configured: rows[0]?.claimed === true, appUrl: config.appUrl });
    }
    if (path === '/api/collect' || path === '/api/tracking-config') {
      const origin = request.headers.get('origin');
      if (!origin) throw new FoundationError(403, 'A configured website origin is required.');
      await limit('collector:global', 6000);
      const allowed = await getDatabase().pool.query('SELECT 1 FROM project WHERE origin=$1 LIMIT 1', [origin]);
      if (!allowed.rowCount) throw new FoundationError(403, 'Website origin is not configured.');
      cors = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '300' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);
      if (path === '/api/tracking-config') {
        const input = z.object({ siteKey: z.uuid(), environment: z.enum(['live', 'test']) }).strict().parse(await readJson(request));
        await limit(`tracking-config:${input.siteKey}`, 600);
        return json(await getPublicDestinations(input.siteKey, input.environment, origin), 200, cors);
      }
      const event = eventInput.parse(await readJson(request, 16384));
      const { rows } = await getDatabase().pool.query('SELECT id,origin FROM project WHERE public_key=$1', [event.siteKey]);
      const project = rows[0];
      if (!project || project.origin !== origin || new URL(event.url).origin !== project.origin) throw new FoundationError(403, 'Event does not match the configured website.');
      await limit(`collector:${project.id}`, 3000);
      // Origin and a site key are public routing values, never visitor identity proof.
      return json(await collectNative(request, event.siteKey, event, extractAnalyticsPeer(request)), 202, cors);
    }
    if (!principal && request.method === 'POST' && request.headers.get('origin') !== config.appUrl) throw new FoundationError(403, 'This action must originate from the application.');
    const googleResponse = await handleGoogle(request);
    if (googleResponse) return googleResponse;
    const oidcResponse = await handleOidc(request);
    if (oidcResponse) return oidcResponse;
    const accountResponse = await handleAccountSecurity(request);
    if (accountResponse) return accountResponse;
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
      if (request.method === 'POST' && path === '/api/auth/sign-out') {
        const body = z.object({}).strict().parse(await readJson(request));
        return getAuth().handler(authRequest(request, JSON.stringify(body)));
      }
      return json({ error: 'Authentication route unavailable.' }, 404);
    }
    const user = principal ? { id: principal.userId, name: '', email: '' } : await signedIn(request);
    if (/^\/api\/projects\/[^/]+\/(reports|report-templates)(\/|$)/.test(path)) {
      await limit(`reports:${user.id}:${request.method === 'GET' ? 'read' : 'write'}`, request.method === 'GET' ? 120 : 30);
      const response = await handleReports(request, user.id);
      if (response) return response;
    }
    const keywordRoute=path.match(new RegExp(`^/api/projects/(${id})/keyword-research(?:/(catalog|quote|runs)(?:/(${id})(?:/(cancel|reconcile))?)?)?$`,'i'));
    if(keywordRoute){
      const [,projectId,action,runId,runAction]=keywordRoute;
      await projectAccess(projectId,user.id,request.method!=='GET');
      await limit(`keyword:${user.id}`,120);
      if(request.method==='GET'&&!action)return json(await getKeywordResearch(projectId,user.id));
      if(request.method==='GET'&&action==='runs'&&runId&&!runAction)return json(await getKeywordRun(projectId,user.id,runId));
      if(request.method==='POST'){
        await limit(`keyword-write:${user.id}`,10);
        const input=await readJson(request);
        if(!runId&&action==='catalog')return json(await refreshKeywordMarkets(projectId,user.id,input));
        if(!runId&&action==='quote')return json(await quoteKeywordResearch(projectId,user.id,input));
        if(!runId&&action==='runs')return json(await startKeywordResearch(projectId,user.id,input),202);
        if(action==='runs'&&runId&&runAction==='cancel')return json(await cancelKeywordResearch(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&runAction==='reconcile'){
          await limit(`keyword-reconcile:${projectId}`,3);
          return json(await reconcileKeywordResearch(projectId,user.id,runId,input));
        }
      }
      return json({error:'Method not allowed.'},405);
    }
    const domainRoute = path.match(new RegExp(`^/api/projects/(${id})/domains(?:/(${id})/(update|challenge|verify|revoke|remove))?$`, 'i'));
    if (domainRoute) {
      if (url.search) throw new FoundationError(400, 'Domain settings do not accept query parameters.');
      await limit(`domain-settings:${user.id}`, 60);
      if (request.method === 'GET' && !domainRoute[2]) return json(await getDomains(domainRoute[1], user.id));
      if (request.method === 'POST') {
        const input = await readJson(request, 4096);
        if (!domainRoute[2]) return json(await addDomain(domainRoute[1], user.id, input), 201);
        const args = [domainRoute[1], user.id, domainRoute[2], input] as const;
        if (domainRoute[3] === 'update') return json(await updateDomain(...args));
        if (domainRoute[3] === 'challenge') return json(await issueDomainChallenge(...args));
        if (domainRoute[3] === 'verify') {
          await limit(`domain-dns:${user.id}`, 6);
          return json(await verifyDomain(...args));
        }
        if (domainRoute[3] === 'revoke') return json(await revokeDomain(...args));
        if (domainRoute[3] === 'remove') return json(await removeDomain(...args));
      }
      return json({ error: 'Method not allowed.' }, 405);
    }
    const contextRoute=path.match(new RegExp(`^/api/projects/(${id})/context(?:/(update|research-log))?$`,'i'));
    if(contextRoute) {
      await limit(`project-content:${user.id}`,120);
      if(request.method==='GET'&&!contextRoute[2]&&!url.search) return json(await getProjectContext(contextRoute[1],user.id));
      if(request.method==='GET'&&contextRoute[2]==='research-log') return json(await getContextResearch(contextRoute[1],user.id,url.searchParams));
      if(request.method==='POST'&&contextRoute[2]==='update'&&!url.search) return json(await updateProjectContext(contextRoute[1],user.id,await readJson(request,262144)));
      return json({error:'Method or parameters not allowed.'},405);
    }
    const promptRoute=path.match(new RegExp(`^/api/projects/(${id})/prompts(?:/(bulk|(${id})(?:/(update|archive|restore|versions))?))?$`,'i'));
    if(promptRoute) {
      await limit(`project-content:${user.id}`,120);
      const pid=promptRoute[1],promptId=promptRoute[3],action=promptRoute[4];
      if(request.method==='GET'&&!promptRoute[2]) return json(await listPrompts(pid,user.id,url.searchParams));
      if(request.method==='GET'&&promptId&&!action&&!url.search) return json(await getPrompt(pid,user.id,promptId));
      if(request.method==='GET'&&action==='versions') return json(await promptVersions(pid,user.id,promptId,url.searchParams));
      if(request.method==='POST'&&!url.search) {
        const input=await readJson(request,262144);
        if(promptRoute[2]==='bulk') return json(await createPrompts(pid,user.id,input),201);
        if(action==='update') return json(await updatePrompt(pid,user.id,promptId,input));
        if(action==='archive'||action==='restore') return json(await setPromptArchived(pid,user.id,promptId,action==='archive',input));
      }
      return json({error:'Method or parameters not allowed.'},405);
    }
    const analyticsSettingsRoute = path.match(new RegExp(`^/api/projects/(${id})/analytics-settings$`, 'i'));
    if (analyticsSettingsRoute) {
      await limit(`analytics-settings:${user.id}`, 60);
      if (request.method === 'GET') return json(await analyticsSettings(analyticsSettingsRoute[1], user.id));
      if (request.method === 'POST') return json(await saveAnalyticsSettings(analyticsSettingsRoute[1], user.id, await readJson(request, 65536)));
    }
    const destinationRoute = path.match(new RegExp(`^/api/projects/(${id})/destinations(?:/(draft|preview|publish|rollback))?$`, 'i'));
    if (destinationRoute) {
      if ([...url.searchParams.keys()].some(key => key !== 'environment') || url.searchParams.getAll('environment').length > 1) throw new FoundationError(400, 'Choose one tracking environment.');
      const environment = z.enum(['live', 'test']).parse(url.searchParams.get('environment') ?? 'live');
      await limit(`tracking-settings:${user.id}`, 60);
      if (request.method === 'GET' && !destinationRoute[2]) return json(await getDestinations(destinationRoute[1], user.id, environment));
      if (request.method === 'POST') {
        const input = await readJson(request, 16_384);
        if (destinationRoute[2] === 'draft') return json(await saveDestinationsDraft(destinationRoute[1], user.id, environment, input));
        if (destinationRoute[2] === 'preview') return json(await previewDestinations(destinationRoute[1], user.id, environment, input));
        if (destinationRoute[2] === 'publish') return json(await publishDestinations(destinationRoute[1], user.id, environment, input));
        if (destinationRoute[2] === 'rollback') return json(await rollbackDestinations(destinationRoute[1], user.id, environment, input));
      }
      return json({ error: 'Method not allowed.' }, 405);
    }
    const retentionRoute = path.match(new RegExp(`^/api/workspaces/(${id})/retention(?:/(preview|save))?$`, 'i'));
    if (retentionRoute) {
      await limit(`retention:${user.id}`, 20);
      if (request.method === 'GET' && !retentionRoute[2]) return json(await getRetention(retentionRoute[1], user.id));
      if (request.method === 'POST' && retentionRoute[2]) {
        const input = await readJson(request);
        return json(await (retentionRoute[2] === 'preview' ? previewRetention : saveRetention)(retentionRoute[1], user.id, input));
      }
      return json({ error: 'Method not allowed.' }, 405);
    }
    let management = path.match(new RegExp(`^/api/workspaces/(${id})/(api-keys|providers|budget)$`, 'i'));
    if (management) {
      const workspaceId = management[1];
      await limit(`settings:${user.id}`, 60);
      if (request.method === 'GET' && management[2] === 'api-keys') return json(await listApiKeys(workspaceId, user.id));
      if (request.method === 'GET' && management[2] === 'providers') return json(await listProviders(workspaceId, user.id));
      if (request.method === 'POST') {
        const input = await readJson(request);
        if (management[2] === 'api-keys') return json(await createApiKey(workspaceId, user.id, input), 201);
        if (management[2] === 'providers') return json(await saveProvider(workspaceId, user.id, input), 201);
        if (management[2] === 'budget') { await saveBudget(workspaceId, user.id, input); return json({ ok: true }); }
      }
    }
    management = path.match(new RegExp(`^/api/workspaces/(${id})/(api-keys|providers)/(${id})/(revoke|update|check)$`, 'i'));
    if (management && request.method === 'POST') {
      await limit(`settings:${user.id}`, 60);
      const input = await readJson(request);
      if (management[2] === 'providers' && management[4] === 'update') return json(await saveProvider(management[1], user.id, input, management[3]));
      z.object({}).strict().parse(input);
      if (management[2] === 'api-keys' && management[4] === 'revoke') { await revokeApiKey(management[1], user.id, management[3]); return json({ ok: true }); }
      if (management[2] === 'providers' && management[4] === 'revoke') { await revokeProvider(management[1], user.id, management[3]); return json({ ok: true }); }
      if (management[2] === 'providers' && management[4] === 'check') {
        await limit(`provider-check:${management[3]}`, 3);
        return json(await checkProvider(management[1], user.id, management[3]));
      }
    }
    if (path === '/api/workspaces' && request.method === 'POST') {
      await limit(`workspaces:${user.id}`, 10);
      const result = await createWorkspace(user.id, await readJson(request));
      return json({ workspace: { ...result.workspace, role: result.role } }, 201);
    }
    if (path === '/api/me' && request.method === 'GET') {
      const { rows } = await getDatabase().pool.query('SELECT w.id,w.name,m.role FROM workspace w JOIN membership m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at,w.id', [user.id]);
      return json({ user: { id: user.id, name: user.name, email: user.email }, instanceOperator: await isInstanceOperator(user.id), workspaces: rows });
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
        const { rows } = await getDatabase().pool.query(`SELECT p.id,p.name,p.origin,p.public_key AS "publicKey",p.analytics_retained_from AS "retainedFrom",(SELECT count(*) FROM event e WHERE e.project_id=p.id AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)) AS "eventCount",(SELECT max(received_at) FROM event e WHERE e.project_id=p.id AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)) AS "lastEventAt" FROM project p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC`, [match[1]]);
        return json({ projects: rows.map(row => ({ ...row, eventCount: Number(row.eventCount) })) });
      }
      if (request.method === 'POST') {
        const input = projectInput.parse(await readJson(request));
        const client = await getDatabase().pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [match[1]]);
          if (apiToken) await authorizeApiKey(apiToken, match[1], 'projects:write', client);
          const access = await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [match[1], user.id]);
          if (!['owner', 'admin', 'editor'].includes(access.rows[0]?.role)) throw new FoundationError(404, 'Workspace not found or unavailable.');
          const { rows } = await client.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5) RETURNING id,name,origin,public_key AS "publicKey"', [randomUUID(), match[1], input.name, input.origin, randomUUID()]);
          await client.query('COMMIT');
          return json({ project: rows[0] }, 201);
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }
    }
    match = path.match(new RegExp(`^/api/projects/(${id})/(events|analytics|explore|jobs|check-worker)$`, 'i'));
    if (match) {
      const target = await projectAccess(match[1], user.id, request.method !== 'GET');
      if (principal && request.method === 'POST' && match[2] === 'events') {
        const input = eventInput.omit({ siteKey: true, consent: true, context: true }).parse(await readJson(request, 16384));
        if (new URL(input.url).origin !== target.origin) throw new FoundationError(400, 'Event URL must use the project origin.');
        const client = await getDatabase().pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [target.workspace_id]);
          await authorizeApiKey(apiToken!, target.workspace_id, 'events:write', client);
          const result = await insertApiObservation(client, target.id, input);
          await client.query('COMMIT');
          return json(result, 202);
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }
      if (request.method === 'GET' && match[2] === 'analytics') return json(await projectAnalytics(match[1], user.id, url.searchParams));
      if (request.method === 'GET' && match[2] === 'explore') {
        await limit(`explore:${user.id}`,30);
        return json(await exploreAnalytics(match[1],user.id,url.searchParams));
      }
      if (request.method === 'GET' && match[2] === 'events') {
        const { rows } = await getDatabase().pool.query(`WITH retained AS MATERIALIZED (
          SELECT e.* FROM event e JOIN project p ON p.id=e.project_id WHERE p.id=$1
            AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        ), recent AS (SELECT id,event_name AS "eventName",path,received_at AS "receivedAt" FROM retained ORDER BY received_at DESC,id DESC LIMIT 50)
        SELECT (SELECT analytics_retained_from FROM project WHERE id=$1) AS "retainedFrom",(SELECT count(*) FROM retained) AS total,
          COALESCE((SELECT json_agg(recent ORDER BY "receivedAt" DESC,id DESC) FROM recent),'[]'::json) AS events`, [match[1]]);
        return json({ ...rows[0], total: Number(rows[0].total) });
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
    if (['SCHEMA_MISMATCH', 'ANALYTICS_NETWORK_CONFIG', '42P01', '42703', 'ECONNREFUSED', 'ENOTFOUND', 'ENOENT', 'EACCES'].includes(code ?? '')) return json({ error: 'The installation is not ready. Check configuration, database migrations and storage.' }, 503, cors);
    console.error('Application request failed; inspect configuration and database availability.');
    return json({ error: 'The request could not be completed. Try again or contact your operator.' }, 500, cors);
  }
}
