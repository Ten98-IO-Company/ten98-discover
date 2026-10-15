import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseCookies } from 'better-auth/cookies';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError, getAuth } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { credentialKeys, decryptCredentials, encryptCredentials } from './credential-vault.ts';
import { isInstanceOperator, requireInstanceOperator } from './instance-operators.ts';
import { googleInput, googleScopes, googleAdsCustomerId, googleAdsVersion, safeGoogleString, type GoogleProvider } from './google-reports.ts';
import { googleRequest, GoogleRequestError } from './google-http.ts';

export type GoogleConnection = { id: string; project_id: string; workspace_id: string; provider: GoogleProvider; name: string; revision: number; app_revision: number; encrypted_tokens: unknown; scopes: string[]; status: string; property_id: string | null; property_name: string | null; time_zone: string | null; currency_code: string | null; login_customer_id: string | null; updated_at: Date };
type App = { revision: number; client_id: string; encrypted_secret: unknown; enabled: boolean; testing: boolean };
type Session = NonNullable<Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>>;
const token = safeGoogleString(4096).min(1).regex(/^[^\s]+$/);
const tokensInput = z.object({ accessToken: token, refreshToken: token, expiresAt: z.number().finite() }).strict();
const responseTokens = z.object({ access_token: token, refresh_token: token.optional(), expires_in: z.number().int().min(1).max(86400), token_type: z.string().refine(value => value.toLowerCase() === 'bearer'), scope: safeGoogleString(4096).optional() });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const appContext = (revision: number) => ({ workspaceId: 'instance', id: 'google-app', provider: 'google-app', revision });
const flowContext = (flow: { workspace_id: string; id: string; app_revision: number }) => ({ workspaceId: flow.workspace_id, id: flow.id, provider: 'google-oauth', revision: flow.app_revision });
export const googleConnectionContext = (row: GoogleConnection) => ({ workspaceId: row.workspace_id, id: row.id, provider: `google-${row.provider}`, revision: row.revision });
const redirectUri = () => `${getConfig().appUrl}/api/google/callback`;
function providerInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FoundationError(502, 'Google returned an unusable property response. Retry later.');
  return parsed.data;
}
function absent(): never { throw new FoundationError(404, 'Google report source not found or unavailable.'); }
export function googleConnectionDto(row: GoogleConnection, revision?: number) {
  return { id: row.id, name: row.name, provider: row.provider, revision: row.revision, status: revision !== undefined && row.status !== 'disconnected' && row.app_revision !== revision ? 'reconnect' : row.status,
    propertyId: row.property_id, propertyName: row.property_name, timeZone: row.time_zone, currencyCode: row.currency_code, ...(row.provider === 'ads' ? { loginCustomerId: row.login_customer_id } : {}), scopes: row.scopes, updatedAt: row.updated_at, imports: [] };
}

export async function googleProjectTransaction<T>(projectId: string, userId: string, owner: boolean, action: (client: PoolClient, workspaceId: string, role: string) => Promise<T>): Promise<T> {
  googleInput(z.uuid(), projectId); googleInput(z.uuid(), userId);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query('SELECT p.workspace_id FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.id=$1 FOR UPDATE OF w', [projectId]);
    if (!project.rowCount) absent();
    const workspaceId = project.rows[0].workspace_id as string;
    const access = await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    if (!access.rowCount || (owner && access.rows[0].role !== 'owner')) absent();
    const result = await action(client, workspaceId, access.rows[0].role);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function googleConnection(client: PoolClient, projectId: string, connectionId: string): Promise<GoogleConnection> {
  googleInput(z.uuid(), connectionId);
  const result = await client.query<GoogleConnection>('SELECT * FROM google_connection WHERE id=$1 AND project_id=$2 FOR UPDATE', [connectionId, projectId]);
  if (!result.rowCount) absent();
  return result.rows[0];
}
export async function activeGoogleApp(client: PoolClient): Promise<App> {
  const app = (await client.query<App>("SELECT * FROM google_app WHERE id='instance' FOR SHARE")).rows[0];
  if (!app?.enabled) throw new FoundationError(409, 'Ask the instance operator to enable the Google reporting application.');
  return app;
}
function appCredentials(app: App) {
  const parsed = z.object({ clientSecret: token, adsDeveloperToken: token.optional() }).safeParse(decryptCredentials(app.encrypted_secret, appContext(app.revision)));
  if (!parsed.success) throw new FoundationError(503, 'Google app credentials cannot be opened. Ask the operator to restore the keyring.');
  return parsed.data;
}
function appSecret(app: App): string { return appCredentials(app).clientSecret; }
export function googleAdsConfigured(app: App): boolean { try { return !!appCredentials(app).adsDeveloperToken; } catch { return false; } }
export function googleAdsHeaders(app: App, loginCustomerId?: string) {
  const developerToken = appCredentials(app).adsDeveloperToken;
  if (!developerToken) throw new FoundationError(409, 'Ask the instance operator to configure a Google Ads developer token.');
  return { developerToken, ...(loginCustomerId ? { loginCustomerId: googleInput(googleAdsCustomerId, loginCustomerId) } : {}) };
}
export async function googleAdsCustomer(accessToken: string, app: App, customerId: string, loginCustomerId?: string) {
  googleInput(googleAdsCustomerId, customerId);
  const raw = await googleRequest(`https://googleads.googleapis.com/${googleAdsVersion}/customers/${customerId}/googleAds:search`, accessToken,
    { query: 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.time_zone, customer.currency_code FROM customer LIMIT 1' }, googleAdsHeaders(app, loginCustomerId));
  const result = providerInput(z.object({ results: z.array(z.object({ customer: z.object({ id: googleAdsCustomerId, descriptiveName: safeGoogleString(512).optional(), manager: z.boolean().default(false), timeZone: safeGoogleString(120).min(1), currencyCode: z.string().regex(/^[A-Z]{3}$/) }) })).length(1) }), raw).results[0].customer;
  if (result.id !== customerId) throw new FoundationError(502, 'Google returned a different Ads customer.');
  return result;
}
async function exchange(app: App, params: Record<string, string>) {
  const raw = await googleRequest('https://oauth2.googleapis.com/token', undefined, new URLSearchParams({ client_id: app.client_id, client_secret: appSecret(app), ...params }));
  const data = responseTokens.safeParse(raw);
  if (!data.success) throw new FoundationError(502, 'Google did not return a usable grant. Connect again and grant read access.');
  return data.data;
}

/** Must run under the workspace/connection lock. Refresh never touches dashboard credentials. */
export async function googleAccessToken(client: PoolClient, row: GoogleConnection, app: App, refresh = false): Promise<string> {
  if (row.status === 'disconnected' || row.status === 'reconnect' || row.app_revision !== app.revision) throw new FoundationError(409, 'Reconnect this Google report source.');
  const stored = tokensInput.safeParse(decryptCredentials(row.encrypted_tokens, googleConnectionContext(row)));
  if (!stored.success) throw new FoundationError(503, 'Google report credentials cannot be opened.');
  if (stored.data.expiresAt > Date.now() + (refresh ? 30_000 : 0)) return stored.data.accessToken;
  if (!refresh) throw new FoundationError(409, 'Google access expired before this request. Retry the operation.');
  const refreshed = await exchange(app, { grant_type: 'refresh_token', refresh_token: stored.data.refreshToken });
  if (refreshed.scope !== undefined && !refreshed.scope.split(/\s+/).includes(googleScopes[row.provider])) throw new FoundationError(409, 'Reconnect this Google report source and grant the required read access.');
  const encrypted = encryptCredentials({ accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token ?? stored.data.refreshToken, expiresAt: Date.now() + refreshed.expires_in * 1000 }, googleConnectionContext(row));
  await client.query('UPDATE google_connection SET encrypted_tokens=$2,updated_at=now() WHERE id=$1', [row.id, encrypted]);
  return refreshed.access_token;
}

// A rotated refresh token must commit before a later API/page failure can roll
// back. The subsequent operation takes the same locks and rereads all authority.
export async function refreshGoogleConnection(projectId: string, userId: string, connectionId: string) {
  const failure = await googleProjectTransaction(projectId, userId, true, async client => {
    const row = await googleConnection(client, projectId, connectionId), app = await activeGoogleApp(client);
    try { await googleAccessToken(client, row, app, true); }
    catch (error) {
      if (!(error instanceof GoogleRequestError) || !error.reauthorize) throw error;
      await client.query("UPDATE google_connection SET status='reconnect',updated_at=now() WHERE id=$1", [row.id]);
      return error;
    }
  });
  if (failure) throw failure;
}

export async function getGoogleApp(userId: string) {
  const [operator, result] = await Promise.all([isInstanceOperator(userId), getDatabase().pool.query<App>("SELECT * FROM google_app WHERE id='instance'")]);
  const app = result.rows[0];
  return { configured: !!app, enabled: app?.enabled ?? false, testing: app?.testing ?? true, adsConfigured: !!app && googleAdsConfigured(app), vaultConfigured: !!credentialKeys(), redirectUri: redirectUri(), operator, revision: app?.revision ?? 0, ...(operator && app ? { clientId: app.client_id } : {}) };
}
export async function saveGoogleApp(userId: string, value: unknown) {
  const data = googleInput(z.object({ revision: z.number().int().nonnegative(), clientId: safeGoogleString(512).regex(/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$(?![\s\S])/), clientSecret: token, enabled: z.boolean(), testing: z.boolean(), adsDeveloperToken: token.regex(/^[A-Za-z0-9_-]+$/).optional(), clearAdsDeveloperToken: z.boolean().optional() }).strict().refine(v=>!(v.clearAdsDeveloperToken && v.adsDeveloperToken)), value);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN'); await requireInstanceOperator(client, userId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ten98-google-app',0))");
    const previous = (await client.query<App>("SELECT * FROM google_app WHERE id='instance' FOR UPDATE")).rows[0];
    if ((previous?.revision ?? 0) !== data.revision) throw new FoundationError(409, 'Google app settings changed. Reload before saving.');
    const revision = data.revision + 1;
    const developerToken = data.clearAdsDeveloperToken ? undefined : data.adsDeveloperToken ?? (previous ? appCredentials(previous).adsDeveloperToken : undefined);
    await client.query(`INSERT INTO google_app(id,revision,client_id,encrypted_secret,enabled,testing) VALUES('instance',$1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,client_id=excluded.client_id,encrypted_secret=excluded.encrypted_secret,enabled=excluded.enabled,testing=excluded.testing,updated_at=now()`,
    [revision, data.clientId, encryptCredentials({ clientSecret: data.clientSecret, ...(developerToken ? { adsDeveloperToken: developerToken } : {}) }, appContext(revision)), data.enabled, data.testing]);
    await client.query('DELETE FROM google_oauth_flow');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return getGoogleApp(userId);
}

const cookieName = (id: string) => `ten98.google.${id}`;
function bindingCookie(id: string, value: string, maxAge: number) {
  return `${cookieName(id)}=${value}; Path=/api/google/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${getConfig().appUrl.startsWith('https:') ? '; Secure' : ''}`;
}
export async function startGoogleConnect(projectId: string, session: Session, value: unknown) {
  const data = googleInput(z.object({ provider: z.enum(['gsc', 'ga4', 'ads']), name: safeGoogleString(120).trim().min(1), connectionId: z.uuid().optional() }).strict(), value);
  return googleProjectTransaction(projectId, session.user.id, true, async (client, workspaceId) => {
    const app = await activeGoogleApp(client);
    if (data.provider === 'ads') googleAdsHeaders(app);
    let previous: GoogleConnection | undefined;
    if (data.connectionId) {
      previous = await googleConnection(client, projectId, data.connectionId);
      if (previous.provider !== data.provider) throw new FoundationError(400, 'The reconnect provider must match the existing connection.');
    }
    await client.query('DELETE FROM google_oauth_flow WHERE expires_at<now() OR (user_id=$1 AND project_id=$2)', [session.user.id, projectId]);
    const id = randomUUID(), state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO google_oauth_flow(id,state_hash,browser_hash,session_id,user_id,workspace_id,project_id,connection_id,connection_revision,provider,name,app_revision,encrypted_verifier,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '10 minutes')`,
    [id, digest(state), digest(browser), session.session.id, session.user.id, workspaceId, projectId, previous?.id ?? null, previous?.revision ?? null, data.provider, data.name, app.revision,
      encryptCredentials({ verifier }, flowContext({ id, workspace_id: workspaceId, app_revision: app.revision }))]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [name, value] of Object.entries({ client_id: app.client_id, redirect_uri: redirectUri(), response_type: 'code', scope: googleScopes[data.provider], access_type: 'offline', prompt: 'select_account consent', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(name, value);
    return { authorizationUrl: url.href, cookie: bindingCookie(id, browser, 600) };
  });
}

export async function googleCallback(request: Request): Promise<Response> {
  let flowId: string | undefined;
  let navigation = '';
  const redirect = (success: boolean) => new Response(null, { status: 303, headers: { location: `${getConfig().appUrl}/#google=${success ? `connected${navigation}` : 'failed'}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(flowId ? { 'set-cookie': bindingCookie(flowId, '', 0) } : {}) } });
  try {
    const params = new URL(request.url).searchParams;
    const state = googleInput(z.string().regex(/^[A-Za-z0-9_-]{43}$/), params.get('state'));
    if (params.getAll('state').length !== 1 || params.getAll('code').length > 1 || params.getAll('error').length > 1) return redirect(false);
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return redirect(false);
    // DELETE is the one-use claim. A wrong browser/session cannot consume another
    // session's grant; both high-entropy state and bound session are required.
    const hint = (await getDatabase().pool.query('SELECT id FROM google_oauth_flow WHERE state_hash=$1 AND session_id=$2 AND user_id=$3', [digest(state), session.session.id, session.user.id])).rows[0];
    if (!hint) return redirect(false);
    flowId = hint.id;
    const browser = parseCookies(request.headers.get('cookie') ?? '').get(cookieName(flowId!)) ?? '';
    const result = await getDatabase().pool.query(`DELETE FROM google_oauth_flow WHERE id=$1 AND state_hash=$2 AND browser_hash=$3 AND session_id=$4 AND user_id=$5 AND expires_at>now() RETURNING *`, [flowId, digest(state), digest(browser), session.session.id, session.user.id]);
    const flow = result.rows[0];
    if (!flow || params.has('error') || !params.get('code')) return redirect(false);
    const code = googleInput(safeGoogleString(4096).min(1), params.get('code'));
    return await googleProjectTransaction(flow.project_id, session.user.id, true, async (client, workspaceId) => {
      // Hold the actual session row while exchanging; sign-out/revocation cannot
      // publish a newly connected grant after this authorization boundary.
      const alive = await client.query('SELECT id FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE', [session.session.id, session.user.id]);
      if (!alive.rowCount || workspaceId !== flow.workspace_id) return redirect(false);
      const app = await activeGoogleApp(client);
      if (app.revision !== flow.app_revision) return redirect(false);
      const previous = flow.connection_id ? await googleConnection(client, flow.project_id, flow.connection_id) : undefined;
      if (previous && previous.revision !== flow.connection_revision) return redirect(false);
      const { verifier } = googleInput(z.object({ verifier: token }), decryptCredentials(flow.encrypted_verifier, flowContext(flow)));
      const grant = await exchange(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
      if (!grant.refresh_token || !grant.scope?.split(/\s+/).includes(googleScopes[flow.provider as GoogleProvider])) return redirect(false);
      const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1;
      const row = { id, workspace_id: workspaceId, provider: flow.provider, revision } as GoogleConnection;
      const encrypted = encryptCredentials({ accessToken: grant.access_token, refreshToken: grant.refresh_token, expiresAt: Date.now() + grant.expires_in * 1000 }, googleConnectionContext(row));
      await client.query(`INSERT INTO google_connection(id,workspace_id,project_id,name,provider,revision,app_revision,encrypted_tokens,scopes,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,app_revision=excluded.app_revision,encrypted_tokens=excluded.encrypted_tokens,scopes=excluded.scopes,status=excluded.status,updated_at=now()`,
      [id, workspaceId, flow.project_id, flow.name, flow.provider, revision, app.revision, encrypted, JSON.stringify(grant.scope.split(/\s+/)), previous?.property_id ? 'ready' : 'select_property']);
      if (previous) await client.query("UPDATE google_import SET status='denied',diagnostic='The Google connection changed. Start a new import.',completed_at=now() WHERE connection_id=$1 AND status IN ('queued','running')", [id]);
      navigation = `&google-project=${encodeURIComponent(flow.project_id)}&google-workspace=${encodeURIComponent(workspaceId)}`;
      return redirect(true);
    });
  } catch { return redirect(false); }
}

export async function listGoogleProperties(projectId: string, userId: string, connectionId: string, value: unknown) {
  const data = googleInput(z.object({ pageToken: safeGoogleString(4096).min(1).optional(), managerCustomerId: googleAdsCustomerId.optional() }).strict(), value);
  await refreshGoogleConnection(projectId, userId, connectionId);
  return googleProjectTransaction(projectId, userId, true, async client => {
    const row = await googleConnection(client, projectId, connectionId), app = await activeGoogleApp(client), accessToken = await googleAccessToken(client, row, app);
    if (row.provider === 'ads') {
      if (data.pageToken) throw new FoundationError(400, 'Ads account discovery is bounded. Select a directly accessible manager to narrow the account list.');
      if (!data.managerCustomerId) {
        const raw = await googleRequest(`https://googleads.googleapis.com/${googleAdsVersion}/customers:listAccessibleCustomers`, accessToken, undefined, googleAdsHeaders(app));
        const response = providerInput(z.object({ resourceNames: z.array(z.string().regex(/^customers\/[1-9]\d{9}$/)).max(10000).default([]) }), raw);
        if (new Set(response.resourceNames).size !== response.resourceNames.length) throw new FoundationError(502, 'Google repeated an accessible account.');
        return { properties: response.resourceNames.map(id => ({ id, name: id, loginCustomerId: null })), nextPageToken: null };
      }
      const manager = await googleAdsCustomer(accessToken, app, data.managerCustomerId);
      if (!manager.manager) throw new FoundationError(400, 'This account is not an Ads manager. Select it directly instead.');
      const raw = await googleRequest(`https://googleads.googleapis.com/${googleAdsVersion}/customers/${manager.id}/googleAds:search`, accessToken,
        { query: 'SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.manager = FALSE ORDER BY customer_client.id', searchSettings: { returnTotalResultsCount: true } }, googleAdsHeaders(app, manager.id));
      const response = providerInput(z.object({ results: z.array(z.object({ customerClient: z.object({ id: googleAdsCustomerId, descriptiveName: safeGoogleString(512).optional() }) })).max(10000).default([]), nextPageToken: safeGoogleString(4096).optional() }), raw);
      if (response.nextPageToken) throw new FoundationError(409, 'This manager has more accounts than the bounded discovery can show. Choose a directly accessible sub-manager.');
      if (new Set(response.results.map(r=>r.customerClient.id)).size !== response.results.length) throw new FoundationError(502, 'Google repeated an Ads client account.');
      return { properties: response.results.map(({customerClient:c}) => ({ id: `customers/${c.id}`, name: c.descriptiveName || c.id, loginCustomerId: manager.id })), nextPageToken: null };
    }
    if (data.managerCustomerId) throw new FoundationError(400, 'Manager selection applies only to Google Ads.');
    if (row.provider === 'gsc') {
      if (data.pageToken) throw new FoundationError(400, 'Search Console property discovery has no next page.');
      const raw = await googleRequest('https://www.googleapis.com/webmasters/v3/sites', accessToken);
      const response = providerInput(z.object({ siteEntry: z.array(z.object({ siteUrl: safeGoogleString(2048).min(1), permissionLevel: safeGoogleString(80) })).max(5000).default([]) }), raw);
      return { properties: response.siteEntry.filter(site => ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(site.permissionLevel)).map(site => ({ id: site.siteUrl, name: site.siteUrl })), nextPageToken: null };
    }
    const query = new URLSearchParams({ pageSize: '50', ...(data.pageToken ? { pageToken: data.pageToken } : {}) });
    const raw = await googleRequest(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?${query}`, accessToken);
    const response = providerInput(z.object({ accountSummaries: z.array(z.object({ propertySummaries: z.array(z.object({ property: z.string().regex(/^properties\/[1-9]\d{0,19}$(?![\s\S])/), displayName: safeGoogleString(512) })).max(1000).default([]) })).max(50).default([]), nextPageToken: safeGoogleString(4096).optional() }), raw);
    return { properties: response.accountSummaries.flatMap(account => account.propertySummaries.map(property => ({ id: property.property, name: property.displayName }))), nextPageToken: response.nextPageToken || null };
  });
}

export async function selectGoogleProperty(projectId: string, userId: string, connectionId: string, value: unknown) {
  const data = googleInput(z.object({ propertyId: safeGoogleString(2048).min(1), loginCustomerId: googleAdsCustomerId.optional() }).strict(), value);
  await refreshGoogleConnection(projectId, userId, connectionId);
  return googleProjectTransaction(projectId, userId, true, async client => {
    const row = await googleConnection(client, projectId, connectionId);
    if (row.property_id) {
      if (row.property_id !== data.propertyId || (row.login_customer_id ?? undefined) !== data.loginCustomerId) throw new FoundationError(409, 'This source already has a property. Add another connection for a different property.');
      return { connection: googleConnectionDto(row) };
    }
    const app = await activeGoogleApp(client), accessToken = await googleAccessToken(client, row, app);
    let name = data.propertyId, timeZone = 'America/Los_Angeles', currency: string | null = null;
    if (row.provider !== 'ads' && data.loginCustomerId) throw new FoundationError(400, 'Manager selection applies only to Google Ads.');
    if (row.provider === 'ads') {
      googleInput(z.string().regex(/^customers\/[1-9]\d{9}$/), data.propertyId);
      const customer = await googleAdsCustomer(accessToken, app, data.propertyId.slice(10), data.loginCustomerId);
      if (customer.manager) throw new FoundationError(400, 'Choose an advertising customer, not a manager account. Load its client accounts first.');
      name = customer.descriptiveName || data.propertyId; timeZone = customer.timeZone; currency = customer.currencyCode;
    } else if (row.provider === 'gsc') {
      const raw = await googleRequest(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(data.propertyId)}`, accessToken);
      const property = providerInput(z.object({ siteUrl: safeGoogleString(2048), permissionLevel: z.enum(['siteOwner', 'siteFullUser', 'siteRestrictedUser']) }), raw);
      if (property.siteUrl !== data.propertyId) throw new FoundationError(409, 'Google property access could not be confirmed.');
    } else {
      googleInput(z.string().regex(/^properties\/[1-9]\d{0,19}$(?![\s\S])/), data.propertyId);
      const raw = await googleRequest(`https://analyticsadmin.googleapis.com/v1beta/${data.propertyId}`, accessToken);
      const property = providerInput(z.object({ name: z.string(), displayName: safeGoogleString(512), timeZone: safeGoogleString(120).min(1), currencyCode: z.string().regex(/^[A-Z]{3}$(?![\s\S])/) }), raw);
      if (property.name !== data.propertyId) throw new FoundationError(409, 'Google property access could not be confirmed.');
      name = property.displayName; timeZone = property.timeZone; currency = property.currencyCode;
    }
    const result = await client.query<GoogleConnection>("UPDATE google_connection SET property_id=$2,property_name=$3,time_zone=$4,currency_code=$5,login_customer_id=$6,status='ready',updated_at=now() WHERE id=$1 RETURNING *", [row.id, data.propertyId, name, timeZone, currency, data.loginCustomerId ?? null]);
    return { connection: googleConnectionDto(result.rows[0]) };
  });
}

export async function disconnectGoogle(projectId: string, userId: string, connectionId: string, value: unknown) {
  const data = googleInput(z.object({ revokeAtGoogle: z.boolean() }).strict(), value);
  const revokeToken = await googleProjectTransaction(projectId, userId, true, async client => {
    const row = await googleConnection(client, projectId, connectionId);
    let revoke: string | undefined;
    if (data.revokeAtGoogle && row.encrypted_tokens) {
      try {
        const stored = tokensInput.safeParse(decryptCredentials(row.encrypted_tokens, googleConnectionContext(row)));
        if (stored.success) revoke = stored.data.refreshToken;
      } catch { /* Lost keys prevent remote revocation, never local removal. */ }
    }
    await client.query("UPDATE google_connection SET status='disconnected',encrypted_tokens=NULL,revision=revision+1,updated_at=now() WHERE id=$1", [row.id]);
    await client.query('DELETE FROM google_oauth_flow WHERE connection_id=$1', [row.id]);
    await client.query("UPDATE google_import SET status='denied',diagnostic='This source was disconnected.',completed_at=now() WHERE connection_id=$1 AND status IN ('queued','running')", [row.id]);
    return revoke;
  });
  let remoteRevocation = data.revokeAtGoogle ? 'unconfirmed' : 'not_requested';
  if (revokeToken) {
    try { await googleRequest('https://oauth2.googleapis.com/revoke', undefined, new URLSearchParams({ token: revokeToken })); remoteRevocation = 'confirmed'; }
    catch { /* Local access stays removed even if Google cannot confirm revocation. */ }
  }
  return { disconnected: true, remoteRevocation };
}

export async function assertGoogleCredentialsReadable() {
  const app = (await getDatabase().pool.query<App>("SELECT * FROM google_app WHERE id='instance'")).rows[0];
  if (app) appSecret(app);
  const connections = await getDatabase().pool.query<GoogleConnection>('SELECT * FROM google_connection WHERE encrypted_tokens IS NOT NULL');
  for (const row of connections.rows) tokensInput.parse(decryptCredentials(row.encrypted_tokens, googleConnectionContext(row)));
  const flows = await getDatabase().pool.query('SELECT * FROM google_oauth_flow WHERE expires_at>now()');
  for (const flow of flows.rows) decryptCredentials(flow.encrypted_verifier, flowContext(flow));
}
export async function rotateGoogleCredentials() {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    // Rekey preserves revision and authorization. LOCK serializes credential
    // writers without changing app enablement or making any provider request.
    await client.query('LOCK google_app,google_connection,google_oauth_flow IN EXCLUSIVE MODE');
    const app = (await client.query<App>("SELECT * FROM google_app WHERE id='instance'")).rows[0];
    if (app) await client.query("UPDATE google_app SET encrypted_secret=$1 WHERE id='instance'", [encryptCredentials(appCredentials(app), appContext(app.revision))]);
    for (const row of (await client.query<GoogleConnection>('SELECT * FROM google_connection WHERE encrypted_tokens IS NOT NULL')).rows) {
      const context = googleConnectionContext(row);
      await client.query('UPDATE google_connection SET encrypted_tokens=$2 WHERE id=$1', [row.id, encryptCredentials(decryptCredentials(row.encrypted_tokens, context), context)]);
    }
    for (const row of (await client.query('SELECT * FROM google_oauth_flow')).rows) {
      const context = flowContext(row);
      await client.query('UPDATE google_oauth_flow SET encrypted_verifier=$2 WHERE id=$1', [row.id, encryptCredentials(decryptCredentials(row.encrypted_verifier, context), context)]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function googleSignedIn(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) throw new FoundationError(401, 'Sign in to continue.');
  return session;
}
