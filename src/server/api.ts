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
import {identifyBodyLimit,parseIdentifyInput} from './identify-input.ts';
import {collectIdentify,IdentifyRequestExpired} from './native-identify.ts';
import { extractAnalyticsPeer } from './analytics-network.ts';
import { collectionOriginAllowed } from './collection-origins.ts';
import { projectAnalytics } from './analytics.ts';
import {projectRealtime} from './realtime.ts';
import {projectJourneys} from './journeys.ts';
import {projectRevenue,listRevenueSessions,getRevenueSession}from'./revenue.ts';
import {projectAttribution} from './attribution.ts';
import {projectRetentionReport} from './retention-report.ts';
import { exploreAnalytics } from './explorer.ts';
import {listSessions,getSessionDetail,getLinkedSessionActivity} from './session-explorer.ts';
import {listAnnotations,annotationTimeline,getAnnotation,saveAnnotation,deleteAnnotation} from './annotations.ts';
import {listSegments,getSegment,saveSegment,deleteSegment} from './segments.ts';
import {listCohorts,getCohort,saveCohort,deleteCohort} from './cohorts.ts';
import {listAnalyses,getAnalysis,saveAnalysis,deleteAnalysis,runAnalysis} from './funnels.ts';
import { getRetention, previewRetention, saveRetention } from './retention.ts';
import {getProjectContext,getContextResearch,updateProjectContext} from './project-context.ts';
import {getPrompt,listPrompts,createPrompts,updatePrompt,setPromptArchived,promptVersions} from './prompts.ts';
import { acceptInvitation, changeRole, createWorkspace, getTeam, inspectInvitation, inviteMember, removeMember, renameWorkspace, revokeInvitation, transferOwnership } from './teams.ts';
import { handleAccountSecurity } from './account-security.ts';
import { authenticateApiKey, authorizeApiKey, createApiKey, listApiKeys, parseApiKeyHeaders, revokeApiKey } from './api-keys.ts';
import { assertCredentialKeys, checkProvider, listProviders, revokeProvider, saveBudget, saveProvider, saveProviderLimit } from './providers.ts';
import { assertOidcCredentialsReadable, handleOidc } from './oidc.ts';
import { isInstanceOperator } from './instance-operators.ts';
import { handleReports } from './reports.ts';
import { handleGoogle } from './google-api.ts';
import {handleMeta} from './meta-api.ts';
import {assertMetaCredentialsReadable} from './meta-auth.ts';
import { assertGoogleCredentialsReadable } from './google.ts';
import {assertProviderAccountIdentityReadable} from './provider-account-identity.ts';
import {getKeywordResearch,getKeywordRun,refreshKeywordMarkets,quoteKeywordResearch,startKeywordResearch,cancelKeywordResearch,reconcileKeywordResearch} from './keyword-research.ts';
import {getDomainResearch,getDomainResearchRun,refreshDomainResearchMarkets,quoteDomainResearch,startDomainResearch,cancelDomainResearch,reconcileDomainResearch} from './domain-research.ts';
import {listRankTrackers,getRankTracker,getRankCatalog,searchRankLocations,createRankTracker,updateRankTracker,archiveRankTracker,changeRankKeywords} from './rank-tracking.ts';
import {getRankRun,quoteRankCheck,startRankCheck} from './rank-execution.ts';
import {cancelRankRun} from './rank-worker.ts';
import {reconcileRankCheck} from './rank-reconciliation.ts';
import {listRankRuns,getLatestRankResults,getRankKeywordHistory} from './rank-history.ts';
import {getRankSchedule,previewRankSchedule,approveRankSchedule,disableRankSchedule} from './rank-scheduling.ts';
import {getRankDistribution} from './rank-distribution.ts';
import {getRankMatrix,exportRankMatrix} from './rank-matrix.ts';
import {listSavedKeywords,listSavedKeywordTags,saveSavedKeywords,changeSavedKeywordTags,removeSavedKeywords,updateSavedKeywordTag,deleteSavedKeywordTag,exportSavedKeywords} from './saved-keywords.ts';
import {quoteSavedKeywordRefresh,startSavedKeywordRefresh,listSavedKeywordRefreshes,getSavedKeywordRefresh,cancelSavedKeywordRefresh,reconcileSavedKeywordRefresh} from './saved-keyword-refresh.ts';
import { addDomain, getDomains, issueDomainChallenge, removeDomain, revokeDomain, updateDomain, verifyDomain } from './domains.ts';
import { getDomainRedirectChecks, startDomainRedirectCheck } from './domain-redirects.ts';
import { getDestinations, getPublicDestinations, previewDestinations, publishDestinations, rollbackDestinations, saveDestinationsDraft } from './destinations.ts';

import {getSiteAuditSetup,startSiteAudit,listSiteAudits,getSiteAudit,listSiteAuditPages,exportSiteAuditPages,getSiteAuditPage,listSiteAuditIssues,listSiteAuditLinks,cancelSiteAudit,deleteSiteAudit} from './site-audits.ts';

import {getPromptExecutions,getPromptComparison,getPromptComparisonSummary,getPromptExecutionResult,getPromptExecutionCitations,quotePromptExecution,startPromptExecution,cancelPromptComparison,reconcilePromptExecution} from './prompt-execution.ts';
import {getPromptTrackers,createPromptTracker,approvePromptTracker,pausePromptTracker,runPromptTrackerNow} from './prompt-recurring.ts';
import {getAiSuggestions,getAiSuggestion,quoteAiSuggestions,startAiSuggestions,cancelAiSuggestion,acceptAiSuggestions} from './ai-suggestions.ts';
import {reconcileAiSuggestion} from './ai-suggestion-worker.ts';
import {getOpenRouterModels,refreshOpenRouterModels} from './openrouter-models.ts';
import {getAiSearch,getAiSearchRun,getAiSearchAnalysis,refreshAiSearchCatalog,quoteAiSearch,startAiSearch,cancelAiSearch,reconcileAiSearch} from './ai-search.ts';
import {getContentCoverage,exportContentCoverage,getProjectContentCoverage,exportProjectContentCoverage} from './ai-content-coverage.ts';
import {getContentSupport,getContentSupportRun,quoteContentSupport,startContentSupport,cancelContentSupport,exportContentSupport} from './ai-content-support.ts';
import {reconcileContentSupport} from './ai-content-support-worker.ts';
import {getPromptInsights,exportPromptInsights} from './prompt-insights.ts';
import {getPromptInsightsComparison,exportPromptInsightsComparison} from './prompt-insights-comparison.ts';
import {getPromptCitations,exportPromptCitations} from './prompt-citations.ts';
import {getPromptCitationSpecializations,exportPromptCitationSpecializations} from './prompt-citation-specializations.ts';

import {nativeOpenApi} from './openapi.ts';

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
    if(path==='/api/openapi.json') {
      if(request.method!=='GET')return json({error:'Method not allowed.'},405,{allow:'GET'});
      if(url.search||request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')return json({error:'Use the specification URL without parameters or a body.'},400);
      return json(nativeOpenApi);
    }
    const config = getConfig();
    await assertSchema();
    if(path==='/api/mcp')return await (await import('./mcp.ts')).handleMcp(request,config.appUrl,limit);
    const apiToken = parseApiKeyHeaders(request.headers);
    const principal = apiToken ? await authenticateApiKey(apiToken) : null;
    if (principal) {
      const workspaceRoute = path.match(new RegExp(`^/api/workspaces/(${id})/(projects|team)$`, 'i'));
      const projectRoute = path.match(new RegExp(`^/api/projects/(${id})/(events|analytics|realtime|journeys|attribution|retention-report|revenue(?:/sessions(?:/[a-f0-9]{64})?)?|explore|sessions(?:/[a-f0-9]{64}(?:/linked-activity)?)?)$`, 'i'));
      const promptApiRoute=path.match(new RegExp(`^/api/projects/(${id})/prompts(?:/(bulk|(${id})(?:/(update|archive|restore|versions))?))?$`,'i'));
      const promptRead=promptApiRoute&&request.method==='GET'&&(!promptApiRoute[2]||!!promptApiRoute[3]&&(!promptApiRoute[4]||promptApiRoute[4]==='versions'));
      const promptWrite=promptApiRoute&&request.method==='POST'&&(promptApiRoute[2]==='bulk'||['update','archive','restore'].includes(promptApiRoute[4]));
      if(promptApiRoute&&(promptRead||promptWrite)) {
        const target=await getDatabase().pool.query('SELECT workspace_id FROM project WHERE id=$1 AND workspace_id=$2',[promptApiRoute[1],principal.workspaceId]);
        if(!target.rowCount)throw new FoundationError(404,'Project not found or unavailable.');
        await authorizeApiKey(apiToken!,target.rows[0].workspace_id,promptWrite?'prompts:write':'prompts:read');
      } else if (workspaceRoute && (request.method === 'GET' || (request.method === 'POST' && workspaceRoute[2] === 'projects'))) {
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
      await assertMetaCredentialsReadable();
      await assertProviderAccountIdentityReadable();
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
      if (!await collectionOriginAllowed(getDatabase().pool, origin)) throw new FoundationError(403, 'Website origin is not configured.');
      cors = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '300' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);
      if (path === '/api/tracking-config') {
        const input = z.object({ siteKey: z.uuid(), environment: z.enum(['live', 'test']) }).strict().parse(await readJson(request));
        await limit(`tracking-config:${input.siteKey}`, 600);
        return json(await getPublicDestinations(input.siteKey, input.environment, origin), 200, cors);
      }
      const raw = await readJson(request, identifyBodyLimit);
      const event = (raw as {type?:unknown}|null)?.type==='identify' ? parseIdentifyInput(raw) : eventInput.parse(raw);
      const { rows } = await getDatabase().pool.query('SELECT id,origin FROM project WHERE public_key=$1', [event.siteKey]);
      const project = rows[0];
      if (!project || new URL(event.url).origin !== origin || !await collectionOriginAllowed(getDatabase().pool, origin, project)) throw new FoundationError(403, 'Event does not match an allowed website origin.');
      await limit(`collector:${project.id}`, 3000);
      // Origin and a site key are public routing values, never visitor identity proof.
      if ('type' in event) {
        try { return json(await collectIdentify(request,event,extractAnalyticsPeer(request)),202,cors); }
        catch(error) { if(error instanceof IdentifyRequestExpired)return json({error:error.message,reason:'request_expired'},400,cors);throw error; }
      }
      return json(await collectNative(request, event.siteKey, event, extractAnalyticsPeer(request)), 202, cors);
    }
    // Meta verifies provider-signed callbacks itself; its browser writes still require Origin and a session.
    const metaResponse = await handleMeta(request);
    if (metaResponse) return metaResponse;
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
    const annotationRoute=path.match(new RegExp('^/api/projects/('+id+')/annotations(?:/(timeline|'+id+')(?:/(update|delete))?)?$','i'));
    if(annotationRoute){
      const pid=annotationRoute[1],target=annotationRoute[2],action=annotationRoute[3];
      await limit('annotations:'+user.id+':'+(request.method==='GET'?'read':'write'),request.method==='GET'?60:30);
      if(request.method==='GET'){
        if(action)return json({error:'Method not allowed.'},405);
        if(target==='timeline')return json(await annotationTimeline(pid,user.id,url.searchParams));
        if(!target)return json(await listAnnotations(pid,user.id,url.searchParams));
        if(url.search)throw new FoundationError(400,'This annotation read has no query parameters.');
        return json(await getAnnotation(pid,user.id,target));
      }
      if(request.method==='POST'&&target!=='timeline'&&(!target||action==='update'||action==='delete')){
        if(url.search)throw new FoundationError(400,'Annotation writes have no query parameters.');
        const body=await readJson(request,8192);
        return json(action==='delete'?await deleteAnnotation(pid,user.id,target,body):await saveAnnotation(pid,user.id,body,target));
      }
      return json({error:'Method not allowed.'},405);
    }
    const cohortRoute=path.match(new RegExp('^/api/projects/('+id+')/cohorts(?:/('+id+')(?:/(update|delete))?)?$','i'));
    if(cohortRoute){
      const [,projectId,cohortId,action]=cohortRoute;
      await limit('cohorts:'+user.id+':'+(request.method==='GET'?'read':'write'),request.method==='GET'?60:30);
      if(request.method==='GET'){
        if(!cohortId)return json(await listCohorts(projectId,user.id,url.searchParams));
        if(!action){if(url.search)throw new FoundationError(400,'Cohort details do not accept query parameters.');return json(await getCohort(projectId,user.id,cohortId));}
      }
      if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'Cohort changes do not accept query parameters.');
        const input=await readJson(request,32768);
        if(!cohortId)return json(await saveCohort(projectId,user.id,input));
        if(action==='update')return json(await saveCohort(projectId,user.id,input,cohortId));
        if(action==='delete')return json(await deleteCohort(projectId,user.id,cohortId,input));
      }
      return json({error:'Method not allowed.'},405);
    }
    const segmentRoute=path.match(new RegExp('^/api/projects/('+id+')/segments(?:/('+id+')(?:/(update|delete))?)?$','i'));
    if(segmentRoute){
      const [,projectId,segmentId,action]=segmentRoute;
      await limit('segments:'+user.id+':'+(request.method==='GET'?'read':'write'),request.method==='GET'?60:30);
      if(request.method==='GET'){
        if(!segmentId)return json(await listSegments(projectId,user.id,url.searchParams));
        if(!action){if(url.search)throw new FoundationError(400,'Saved filter details do not accept query parameters.');return json(await getSegment(projectId,user.id,segmentId));}
      }
      if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'Saved filter changes do not accept query parameters.');
        const input=await readJson(request,32768);
        if(!segmentId)return json(await saveSegment(projectId,user.id,input));
        if(action==='update')return json(await saveSegment(projectId,user.id,input,segmentId));
        if(action==='delete')return json(await deleteSegment(projectId,user.id,segmentId,input));
      }
      return json({error:'Method not allowed.'},405);
    }
    const analysisRoute=path.match(new RegExp(`^/api/projects/(${id})/(funnels|goals)(?:/(${id})(?:/(update|delete|result|witnesses))?)?$`,'i'));
    if(analysisRoute){
      const [,projectId,collection,analysisId,action]=analysisRoute,kind=collection.toLowerCase()==='funnels'?'funnel':'goal';
      await limit(`analyses:${user.id}:${request.method==='GET'?'read':'write'}`,request.method==='GET'?60:30);
      if(request.method==='GET'){
        if(!analysisId)return json(await listAnalyses(projectId,user.id,kind,url.searchParams));
        if(!action){if(url.search)throw new FoundationError(400,'Analysis details do not accept query parameters.');return json(await getAnalysis(projectId,user.id,kind,analysisId));}
        if(action==='result'||action==='witnesses')return json(await runAnalysis(projectId,user.id,kind,analysisId,url.searchParams,action==='witnesses'));
      }
      if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'Analysis changes do not accept query parameters.');
        const input=await readJson(request,65536);
        if(!analysisId)return json(await saveAnalysis(projectId,user.id,kind,input));
        if(action==='update')return json(await saveAnalysis(projectId,user.id,kind,input,analysisId));
        if(action==='delete')return json(await deleteAnalysis(projectId,user.id,kind,analysisId,input));
      }
      return json({error:'Method not allowed.'},405);
    }
    const auditExportRoute=path.match(new RegExp(`^/api/projects/(${id})/audits/(${id})/pages/export$`,'i'));
    if(auditExportRoute){
      if(request.method!=='POST')return json({error:'Method not allowed.'},405);
      if(url.search)throw new FoundationError(400,'Audit page exports do not accept query parameters.');
      await limit(`audit-pages-export:${user.id}`,6);
      try{return await exportSiteAuditPages(auditExportRoute[1],user.id,auditExportRoute[2],await readJson(request,4096),request.signal);}
      catch(error){if(error instanceof FoundationError&&error.status===503)return json({error:error.message},503,{'retry-after':'5'});throw error;}
    }
    const auditRoute=path.match(new RegExp(`^/api/projects/(${id})/audits(?:/(setup|${id})(?:/(pages|issues|cancel|delete)(?:/(${id})(?:/(links))?)?)?)?$`,'i'));
    if(auditRoute){
      const [,projectId,runOrSetup,action,pageId,links]=auditRoute;
      await limit(`audits:${user.id}:${request.method==='GET'?'read':'write'}`,request.method==='GET'?120:10);
      if(request.method==='GET'){
        if(!runOrSetup)return json(await listSiteAudits(projectId,user.id,url.searchParams));
        if(runOrSetup==='setup'&&!action){if(url.search)throw new FoundationError(400,'Audit setup does not accept query parameters.');return json(await getSiteAuditSetup(projectId,user.id));}
        if(runOrSetup!=='setup'){
          if(!action){if(url.search)throw new FoundationError(400,'Audit details do not accept query parameters.');return json(await getSiteAudit(projectId,user.id,runOrSetup));}
          if(action==='pages'&&!pageId)return json(await listSiteAuditPages(projectId,user.id,runOrSetup,url.searchParams));
          if(action==='pages'&&pageId&&links)return json(await listSiteAuditLinks(projectId,user.id,runOrSetup,pageId,url.searchParams));
          if(action==='pages'&&pageId&&!links){if(url.search)throw new FoundationError(400,'Page details do not accept query parameters.');return json(await getSiteAuditPage(projectId,user.id,runOrSetup,pageId));}
          if(action==='issues'&&!pageId)return json(await listSiteAuditIssues(projectId,user.id,runOrSetup,url.searchParams));
        }
      }
      if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'Audit actions do not accept query parameters.');
        const input=await readJson(request,4096);
        if(!runOrSetup){const result=await startSiteAudit(projectId,user.id,input);return json(result,result.created?202:200);}
        if(runOrSetup!=='setup'&&!pageId){
          if(action==='cancel')return json(await cancelSiteAudit(projectId,user.id,runOrSetup,input));
          if(action==='delete')return json(await deleteSiteAudit(projectId,user.id,runOrSetup,input));
        }
      }
      return json({error:'Method not allowed.'},405);
    }
    const specializedCitationRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-insights/citation-specializations(?:/(export))?$`,'i'));
    if(specializedCitationRoute){
      const [,projectId,action]=specializedCitationRoute;await projectAccess(projectId,user.id,false);
      await limit(`prompt-insights:${user.id}`,30);
      if(request.method==='GET'&&!action)return json(await getPromptCitationSpecializations(projectId,user.id,url.searchParams,request.signal));
      if(request.method==='POST'&&action==='export'){
        if(url.search)throw new FoundationError(400,'Citation exports do not accept query parameters.');
        await limit(`prompt-insights-export:${user.id}`,5);
        const result=await exportPromptCitationSpecializations(projectId,user.id,await readJson(request,4096),request.signal);
        return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return json({error:'Method not allowed.'},405);
    }
    const citationRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-insights/citations(?:/(export))?$`,'i'));
    if(citationRoute){
      const [,projectId,action]=citationRoute;await projectAccess(projectId,user.id,false);
      await limit(`prompt-insights:${user.id}`,30);
      if(request.method==='GET'&&!action)return json(await getPromptCitations(projectId,user.id,url.searchParams,request.signal));
      if(request.method==='POST'&&action==='export'){
        if(url.search)throw new FoundationError(400,'Citation exports do not accept query parameters.');
        await limit(`prompt-insights-export:${user.id}`,5);
        const result=await exportPromptCitations(projectId,user.id,await readJson(request,4096),request.signal);
        return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return json({error:'Method not allowed.'},405);
    }
    const comparisonInsightRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-insights/comparison(?:/(export))?$`,'i'));
    if(comparisonInsightRoute){
      const [,projectId,action]=comparisonInsightRoute;await projectAccess(projectId,user.id,false);
      await limit(`prompt-insights:${user.id}`,30);
      if(request.method==='GET'&&!action)return json(await getPromptInsightsComparison(projectId,user.id,url.searchParams));
      if(request.method==='POST'&&action==='export'){
        if(url.search)throw new FoundationError(400,'Comparison exports do not accept query parameters.');
        await limit(`prompt-insights-export:${user.id}`,5);
        const result=await exportPromptInsightsComparison(projectId,user.id,await readJson(request,4096),request.signal);
        return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return json({error:'Method not allowed.'},405);
    }
    const insightRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-insights(?:/(export))?$`,'i'));
    if(insightRoute){
      const [,projectId,action]=insightRoute;await projectAccess(projectId,user.id,false);
      await limit(`prompt-insights:${user.id}`,30);
      if(request.method==='GET'&&!action)return json(await getPromptInsights(projectId,user.id,url.searchParams));
      if(request.method==='POST'&&action==='export'){
        if(url.search)throw new FoundationError(400,'Insight exports do not accept query parameters.');
        await limit(`prompt-insights-export:${user.id}`,5);
        const result=await exportPromptInsights(projectId,user.id,await readJson(request,4096),request.signal);
        return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return json({error:'Method not allowed.'},405);
    }
    const modelCatalogRoute=path.match(new RegExp(`^/api/projects/(${id})/openrouter-models$`,'i'));
    if(modelCatalogRoute){
      const projectId=modelCatalogRoute[1];
      if(url.search)throw new FoundationError(400,'The model catalog does not accept query parameters.');
      await projectAccess(projectId,user.id,request.method==='POST');
      if(request.method==='GET'){
        if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Model catalog reads do not accept a body.');
        await limit(`openrouter-models-read:${user.id}`,60);return json(await getOpenRouterModels(projectId,user.id));
      }
      if(request.method==='POST'){
        await limit(`openrouter-models-refresh:${projectId}`,3);return json(await refreshOpenRouterModels(projectId,user.id,await readJson(request,256)));
      }
      return json({error:'Method not allowed.'},405);
    }
    const suggestionRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-suggestions(?:/(quote|runs)(?:/(${id})(?:/(cancel|reconcile|accept))?)?)?$`,'i'));
    if(suggestionRoute){
      const [,projectId,action,runId,operation]=suggestionRoute;
      await projectAccess(projectId,user.id,request.method!=='GET');await limit(`ai-suggestions:${user.id}`,60);
      if(request.method==='GET'&&!runId&&(!action||action==='runs'))return json(await getAiSuggestions(projectId,user.id,url.searchParams));
      if(url.search)throw new FoundationError(400,'This suggestion operation does not accept query parameters.');
      if(request.method==='GET'&&action==='runs'&&runId&&!operation)return json(await getAiSuggestion(projectId,user.id,runId));
      if(request.method==='POST'){
        await limit(`ai-suggestions-write:${user.id}`,10);
        const input=await readJson(request,action==='quote'?262144:operation==='accept'?131072:2048);
        if(action==='quote'&&!runId)return json(await quoteAiSuggestions(projectId,user.id,input));
        if(action==='runs'&&!runId)return json(await startAiSuggestions(projectId,user.id,input),202);
        if(action==='runs'&&runId&&operation==='cancel')return json(await cancelAiSuggestion(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&operation==='accept')return json(await acceptAiSuggestions(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&operation==='reconcile'){await limit(`ai-suggestions-reconcile:${projectId}`,3);return json(await reconcileAiSuggestion(projectId,user.id,runId,input));}
      }
      return json({error:'Method not allowed.'},405);
    }
    const trackerRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-trackers(?:/(${id})/(approve|pause|run))?$`,'i'));
    if(trackerRoute){
      const [,projectId,trackerId,action]=trackerRoute;
      if(/[?#]/.test(request.url))throw new FoundationError(400,'Prompt tracker actions do not accept query parameters or fragments.');
      await projectAccess(projectId,user.id,request.method!=='GET');await limit(`prompt-tracker-read:${user.id}`,120);
      if(request.method==='GET'&&!trackerId)return json(await getPromptTrackers(projectId,user.id));
      if(request.method==='POST'){
        await limit(`prompt-tracker-write:${user.id}`,10);const input=await readJson(request,8192);
        if(!trackerId)return json(await createPromptTracker(projectId,user.id,input));
        if(action==='approve')return json(await approvePromptTracker(projectId,user.id,trackerId,input));
        if(action==='pause')return json(await pausePromptTracker(projectId,user.id,trackerId,input));
        if(action==='run')return json(await runPromptTrackerNow(projectId,user.id,trackerId,input),202);
      }
      return json({error:'Method not allowed.'},405);
    }
    const executionRoute=path.match(new RegExp(`^/api/projects/(${id})/prompt-executions(?:/(quote|comparisons|runs)(?:/(${id})(?:/(cancel|reconcile|summary|citations))?)?)?$`,'i'));
    if(executionRoute){
      const [,projectId,action,runId,runAction]=executionRoute;
      const citationRead=request.method==='GET'&&action==='runs'&&!!runId&&runAction==='citations';
      if(url.search&&!citationRead)throw new FoundationError(400,'Prompt executions do not accept query parameters.');
      await projectAccess(projectId,user.id,request.method!=='GET');
      await limit(`execution:${user.id}`,120);
      if(request.method==='GET'&&!action)return json(await getPromptExecutions(projectId,user.id));
      if(request.method==='GET'&&action==='comparisons'&&runId&&!runAction)return json(await getPromptComparison(projectId,user.id,runId));
      if(request.method==='GET'&&action==='comparisons'&&runId&&runAction==='summary')return json(await getPromptComparisonSummary(projectId,user.id,runId));
      if(request.method==='GET'&&action==='runs'&&runId&&!runAction)return json(await getPromptExecutionResult(projectId,user.id,runId));
      if(citationRead)return json(await getPromptExecutionCitations(projectId,user.id,runId,url.searchParams));
      if(request.method==='POST'){
        await limit(`execution-write:${user.id}`,10);
        const input=await readJson(request,32768);
        if(!runId&&action==='quote')return json(await quotePromptExecution(projectId,user.id,input));
        if(!runId&&action==='comparisons')return json(await startPromptExecution(projectId,user.id,input),202);
        if(action==='comparisons'&&runId&&runAction==='cancel')return json(await cancelPromptComparison(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&runAction==='reconcile'){
          await limit(`execution-reconcile:${projectId}`,3);
          return json(await reconcilePromptExecution(projectId,user.id,runId,input));
        }
      }
      return json({error:'Method not allowed.'},405);
    }
    const savedKeywordRoute=path.match(new RegExp(`^/api/projects/(${id})/saved-keywords(?:/(list|bulk-tags|remove|export|refresh-quote|refreshes|tags)(?:/(list|${id})(?:/(update|delete|cancel|reconcile))?)?)?$`,'i'));
    if(savedKeywordRoute){
      if(url.search)throw new FoundationError(400,'Saved keyword requests do not accept query parameters.');
      const [,projectId,action,targetId,operation]=savedKeywordRoute;
      await limit(`saved-keyword:${user.id}`,120);
      if(request.method==='GET'){
        if(!action)return json(await listSavedKeywords(projectId,user.id,{}));
        if(action==='refreshes'&&!operation)return json(targetId?await getSavedKeywordRefresh(projectId,user.id,targetId):await listSavedKeywordRefreshes(projectId,user.id));
      }
      if(request.method==='POST'){
        const readOnly=action==='list'||action==='export'||action==='tags'&&targetId==='list';
        await projectAccess(projectId,user.id,!readOnly);
        await limit(`saved-keyword-${readOnly?'read':'write'}:${user.id}`,readOnly?60:30);
        const input=await readJson(request,!action?1_048_576:131_072);
        if(!targetId&&!operation){
          if(!action)return json(await saveSavedKeywords(projectId,user.id,input));
          if(action==='list')return json(await listSavedKeywords(projectId,user.id,input));
          if(action==='bulk-tags')return json(await changeSavedKeywordTags(projectId,user.id,input));
          if(action==='remove')return json(await removeSavedKeywords(projectId,user.id,input));
          if(action==='refresh-quote'){await limit(`saved-keyword-quote:${user.id}`,10);return json(await quoteSavedKeywordRefresh(projectId,user.id,input));}
          if(action==='refreshes')return json(await startSavedKeywordRefresh(projectId,user.id,input),202);
          if(action==='export'){
            const result=await exportSavedKeywords(projectId,user.id,input,request.signal);
            return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
          }
        }
        if(action==='tags'&&targetId==='list'&&!operation)return json(await listSavedKeywordTags(projectId,user.id,input));
        if(action==='tags'&&targetId&&targetId!=='list'){
          if(operation==='update')return json(await updateSavedKeywordTag(projectId,user.id,targetId,input));
          if(operation==='delete')return json(await deleteSavedKeywordTag(projectId,user.id,targetId,input));
        }
        if(action==='refreshes'&&targetId){
          if(operation==='cancel')return json(await cancelSavedKeywordRefresh(projectId,user.id,targetId,input));
          if(operation==='reconcile'){await limit(`saved-keyword-reconcile:${projectId}`,3);return json(await reconcileSavedKeywordRefresh(projectId,user.id,targetId,input));}
        }
      }
      return json({error:'Method not allowed.'},405);
    }
    const rankCheckRoute=path.match(new RegExp(`^/api/projects/(${id})/rank-checks/(${id})(?:/(start|cancel|reconcile))?$`,'i'));
    if(rankCheckRoute){
      const [,projectId,runId,action]=rankCheckRoute;
      if(url.searchParams.size)throw new FoundationError(400,'Rank check actions do not accept query parameters.');
      await projectAccess(projectId,user.id,request.method!=='GET');
      await limit(`rank-read:${user.id}`,120);
      if(request.method==='GET'&&!action)return json(await getRankRun(projectId,user.id,runId));
      if(request.method==='POST'){
        await limit(`rank-check-write:${user.id}`,10);
        const input=await readJson(request,8192);
        if(action==='start')return json(await startRankCheck(projectId,user.id,runId,input),202);
        if(action==='cancel')return json(await cancelRankRun(projectId,user.id,runId,input));
        if(action==='reconcile'){await limit(`rank-reconcile:${projectId}`,3);return json(await reconcileRankCheck(projectId,user.id,runId,input));}
      }
      return json({error:'Method not allowed.'},405);
    }
    const rankScheduleRoute=path.match(new RegExp(`^/api/projects/(${id})/rank-trackers/(${id})/schedule(?:/(preview|approve|disable))?$`,'i'));
    if(rankScheduleRoute){
      const [,projectId,trackerId,action]=rankScheduleRoute;
      if(url.searchParams.size)throw new FoundationError(400,'Rank schedule actions do not accept query parameters.');
      await projectAccess(projectId,user.id,request.method!=='GET');
      await limit(`rank-read:${user.id}`,120);
      if(request.method==='GET'&&!action)return json(await getRankSchedule(projectId,user.id,trackerId));
      if(request.method==='POST'&&action){
        await limit(`rank-schedule-write:${user.id}`,10);const input=await readJson(request,8192);
        if(action==='preview')return json(await previewRankSchedule(projectId,user.id,trackerId,input));
        if(action==='approve')return json(await approveRankSchedule(projectId,user.id,trackerId,input));
        return json(await disableRankSchedule(projectId,user.id,trackerId,input));
      }
      return json({error:'Method not allowed.'},405);
    }
    const rankReportRoute=path.match(new RegExp(`^/api/projects/(${id})/rank-trackers/(${id})/(distribution|matrix)(/export)?$`,'i'));
    if(rankReportRoute){
      const [,projectId,trackerId,rawReport,exportPath]=rankReportRoute,report=rawReport.toLowerCase();
      await projectAccess(projectId,user.id);
      await limit(`rank-report:${user.id}`,30);
      if(request.method==='GET'&&!exportPath)return json(report==='distribution'
        ?await getRankDistribution(projectId,user.id,trackerId,url.searchParams)
        :await getRankMatrix(projectId,user.id,trackerId,url.searchParams));
      if(request.method==='POST'&&report==='matrix'&&exportPath){
        if(url.searchParams.size)throw new FoundationError(400,'Put rank export filters in the request body.');
        await limit(`rank-report-export:${user.id}`,6);
        const result=await exportRankMatrix(projectId,user.id,trackerId,await readJson(request,8192),request.signal);
        return new Response(result.body,{headers:{'content-type':result.contentType,'content-disposition':`attachment; filename="${result.filename}"`,'x-export-row-count':String(result.rowCount),'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return json({error:'Method not allowed.'},405);
    }
    const rankHistoryRoute=path.match(new RegExp(`^/api/projects/(${id})/rank-trackers/(${id})/(runs|results|keywords/(${id})/history)$`,'i'));
    if(rankHistoryRoute){
      const [,projectId,trackerId,action,keywordId]=rankHistoryRoute;
      await projectAccess(projectId,user.id);
      await limit(`rank-read:${user.id}`,120);
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(action==='runs')return json(await listRankRuns(projectId,user.id,trackerId,url.searchParams));
      if(action==='results')return json(await getLatestRankResults(projectId,user.id,trackerId,url.searchParams));
      return json(await getRankKeywordHistory(projectId,user.id,trackerId,keywordId,url.searchParams));
    }
    const rankRoute=path.match(new RegExp(`^/api/projects/(${id})/rank-trackers(?:/(catalog|locations|${id})(?:/(update|archive|keywords|quote)(?:/(add|remove|pin))?)?)?$`,'i'));
    if(rankRoute){
      const [,projectId,target,action,keywordAction]=rankRoute;
      await projectAccess(projectId,user.id,request.method!=='GET'||target==='locations');
      await limit(`rank-read:${user.id}`,120);
      if(request.method==='GET'&&!target)return json(await listRankTrackers(projectId,user.id,url.searchParams));
      if(request.method==='GET'&&target==='locations'&&!action){await limit(`rank-catalog:${user.id}`,30);return json(await searchRankLocations(projectId,user.id,url.searchParams));}
      if(request.method==='GET'&&target&&target!=='catalog'&&!action){
        if(url.searchParams.size)throw new FoundationError(400,'This tracker detail does not accept filters.');
        return json(await getRankTracker(projectId,user.id,target));
      }
      if(request.method==='POST'){
        if(url.searchParams.size)throw new FoundationError(400,'Put tracker changes in the request body.');
        await limit(`rank-write:${user.id}`,30);
        // Up to2,000 bounded raw terms (including JSON Unicode escapes), or IDs.
        const input=await readJson(request,action==='keywords'?(keywordAction==='add'?2_621_440:131_072):action==='quote'?262_144:8192);
        if(!target)return json(await createRankTracker(projectId,user.id,input));
        if(target==='catalog'&&!action){await limit(`rank-catalog:${user.id}`,30);return json(await getRankCatalog(projectId,user.id,input));}
        if(target!=='catalog'&&target!=='locations'){
          if(action==='update'&&!keywordAction)return json(await updateRankTracker(projectId,user.id,target,input));
          if(action==='archive'&&!keywordAction)return json(await archiveRankTracker(projectId,user.id,target,input));
          if(action==='quote'&&!keywordAction){await limit(`rank-quote:${user.id}`,10);return json(await quoteRankCheck(projectId,user.id,target,input));}
          if(action==='keywords'&&keywordAction)return json(await changeRankKeywords(projectId,user.id,target,keywordAction as 'add'|'remove'|'pin',input));
        }
      }
      return json({error:'Method not allowed.'},405);
    }
    const contentSupportRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-content-support(?:/(quote|runs)(?:/(${id})(?:/(cancel|reconcile|export))?)?)?$`,'i'));
    if(contentSupportRoute){
      const [,projectId,action,runId,operation]=contentSupportRoute;
      await projectAccess(projectId,user.id,false);await limit(`ai-content-support:${user.id}`,30);
      if(request.method==='GET'){
        if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'This read does not accept a body.');
        if(!action||action==='runs'&&!runId)return json(await getContentSupport(projectId,user.id,url.searchParams));
        if(url.search)throw new FoundationError(400,'This assessment detail does not accept query parameters.');
        if(action==='runs'&&runId&&!operation)return json(await getContentSupportRun(projectId,user.id,runId));
      }else if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'This assessment action does not accept query parameters.');
        if(operation==='export'&&runId)return await exportContentSupport(projectId,user.id,runId,await readJson(request,2048),request.signal);
        await limit(`ai-content-support-write:${user.id}`,10);
        if(action==='quote'&&!runId)return json(await quoteContentSupport(projectId,user.id,await readJson(request,32768)));
        if(action==='runs'&&!runId)return json(await startContentSupport(projectId,user.id,await readJson(request,2048)),202);
        if(action==='runs'&&runId&&operation==='cancel')return json(await cancelContentSupport(projectId,user.id,runId,await readJson(request,2048)));
        if(action==='runs'&&runId&&operation==='reconcile'){await limit(`ai-content-support-reconcile:${projectId}`,3);return json(await reconcileContentSupport(projectId,user.id,runId,await readJson(request,2048)));}
      }
      return json({error:'Method not allowed.'},405);
    }
    const projectContentCoverageRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-search/content-coverage/project(?:/(export))?$`,'i'));
    if(projectContentCoverageRoute){
      if(request.method!=='POST')return json({error:'Method not allowed.'},405);
      if(url.search)throw new FoundationError(400,'Website-text comparison does not accept URL parameters.');
      await projectAccess(projectContentCoverageRoute[1],user.id,false);await limit(`ai-search:${user.id}`,30);
      const input=await readJson(request,8192);return projectContentCoverageRoute[2]?await exportProjectContentCoverage(projectContentCoverageRoute[1],user.id,input,request.signal):json(await getProjectContentCoverage(projectContentCoverageRoute[1],user.id,input,request.signal));
    }
    const contentCoverageRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-search/content-coverage(?:/(export))?$`,'i'));
    if(contentCoverageRoute){
      if(request.method!=='POST')return json({error:'Method not allowed.'},405);
      if(url.search)throw new FoundationError(400,'Website-text comparison does not accept URL parameters.');
      await projectAccess(contentCoverageRoute[1],user.id,false);await limit(`ai-search:${user.id}`,30);
      const input=await readJson(request,4096);return contentCoverageRoute[2]?await exportContentCoverage(contentCoverageRoute[1],user.id,input,request.signal):json(await getContentCoverage(contentCoverageRoute[1],user.id,input,request.signal));
    }
    const aiAnalysisRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-search/analysis$`,'i'));
    if(aiAnalysisRoute){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')!=='0')throw new FoundationError(400,'Search capture reads do not accept a body.');
      await limit(`ai-search:${user.id}`,30);return json(await getAiSearchAnalysis(aiAnalysisRoute[1],user.id,url.searchParams));
    }
    const aiSearchRoute=path.match(new RegExp(`^/api/projects/(${id})/ai-search(?:/(catalog/refresh|quote|runs)(?:/(${id})(?:/(cancel|reconcile))?)?)?$`,'i'));
    if(aiSearchRoute){
      const[,projectId,action,runId,runAction]=aiSearchRoute;
      await projectAccess(projectId,user.id,request.method!=='GET');await limit(`ai-search:${user.id}`,30);
      if(request.method==='GET'){
        if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')!=='0')throw new FoundationError(400,'Search capture reads do not accept a body.');
        if(!action)return json(await getAiSearch(projectId,user.id,url.searchParams));
        if(action==='runs'&&runId&&!runAction){if(url.search)throw new FoundationError(400,'This capture does not accept query parameters.');return json(await getAiSearchRun(projectId,user.id,runId));}
      }
      if(request.method==='POST'){
        if(url.search)throw new FoundationError(400,'Search capture actions do not accept query parameters.');
        await limit(`ai-search-write:${user.id}`,10);const input=await readJson(request,4096);
        if(action==='catalog/refresh'&&!runId){await limit(`ai-search-catalog:${projectId}`,3);return json(await refreshAiSearchCatalog(projectId,user.id,input));}
        if(action==='quote'&&!runId)return json(await quoteAiSearch(projectId,user.id,input));
        if(action==='runs'&&!runId){const result=await startAiSearch(projectId,user.id,input);return json(result,result.replayed?200:202);}
        if(action==='runs'&&runId&&runAction==='cancel')return json(await cancelAiSearch(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&runAction==='reconcile'){await limit(`ai-search-reconcile:${projectId}`,3);return json(await reconcileAiSearch(projectId,user.id,runId,input));}
      }
      return json({error:'Method not allowed.'},405);
    }
    const domainResearchRoute=path.match(new RegExp(`^/api/projects/(${id})/domain-research(?:/(catalog|quote|runs)(?:/(${id})(?:/(cancel|reconcile))?)?)?$`,'i'));
    if(domainResearchRoute){
      const [,projectId,action,runId,runAction]=domainResearchRoute;
      if(url.search)throw new FoundationError(400,'Domain research does not accept query parameters.');
      await projectAccess(projectId,user.id,request.method!=='GET');await limit(`domain-research:${user.id}`,120);
      if(request.method==='GET'&&!action)return json(await getDomainResearch(projectId,user.id));
      if(request.method==='GET'&&action==='runs'&&runId&&!runAction)return json(await getDomainResearchRun(projectId,user.id,runId));
      if(request.method==='POST'){
        await limit(`domain-research-write:${user.id}`,10);const input=await readJson(request,8192);
        if(!runId&&action==='catalog')return json(await refreshDomainResearchMarkets(projectId,user.id,input));
        if(!runId&&action==='quote')return json(await quoteDomainResearch(projectId,user.id,input));
        if(!runId&&action==='runs')return json(await startDomainResearch(projectId,user.id,input),202);
        if(action==='runs'&&runId&&runAction==='cancel')return json(await cancelDomainResearch(projectId,user.id,runId,input));
        if(action==='runs'&&runId&&runAction==='reconcile'){await limit(`domain-research-reconcile:${projectId}`,3);return json(await reconcileDomainResearch(projectId,user.id,runId,input));}
      }
      return json({error:'Method not allowed.'},405);
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
    const redirectRoute=path.match(new RegExp(`^/api/projects/(${id})/domains/(${id})/redirect-checks$`,'i'));
    if(redirectRoute){
      if(url.search)throw new FoundationError(400,'Redirect checks do not accept query parameters.');
      await limit(`domain-redirect:${user.id}:read`,60);
      if(request.method==='GET')return json(await getDomainRedirectChecks(redirectRoute[1],user.id,redirectRoute[2]));
      if(request.method==='POST'){
        await limit(`domain-redirect:${user.id}:write`,10);
        return json(await startDomainRedirectCheck(redirectRoute[1],user.id,redirectRoute[2],await readJson(request,4096)),202);
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
      if(request.method==='GET'&&!promptRoute[2]) return json(await listPrompts(pid,user.id,url.searchParams,apiToken??undefined));
      if(request.method==='GET'&&promptId&&!action&&!url.search) return json(await getPrompt(pid,user.id,promptId,apiToken??undefined));
      if(request.method==='GET'&&action==='versions') return json(await promptVersions(pid,user.id,promptId,url.searchParams,apiToken??undefined));
      if(request.method==='POST'&&!url.search) {
        const input=await readJson(request,262144);
        if(promptRoute[2]==='bulk') return json(await createPrompts(pid,user.id,input,apiToken??undefined),201);
        if(action==='update') return json(await updatePrompt(pid,user.id,promptId,input,apiToken??undefined));
        if(action==='archive'||action==='restore') return json(await setPromptArchived(pid,user.id,promptId,action==='archive',input,apiToken??undefined));
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
    const providerLimit = path.match(new RegExp(`^/api/workspaces/(${id})/providers/(${id})/limit$`, 'i'));
    if (providerLimit) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      await limit(`settings:${user.id}`, 60);
      return json(await saveProviderLimit(providerLimit[1], user.id, providerLimit[2], await readJson(request)));
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
    let match = path.match(new RegExp(`^/api/workspaces/(${id})/(team|rename|invitations|transfer-ownership)$`, 'i'));
    if (match) {
      if (request.method === 'GET' && match[2] === 'team') {
        const result = await getTeam(match[1], user.id);
        if (apiToken) await authorizeApiKey(apiToken, match[1], 'team:read');
        return json(result);
      }
      if (request.method === 'POST') {
        await limit(`team:${user.id}`, 60);
        if (match[2] === 'transfer-ownership') return json(await transferOwnership(match[1], user.id, await readJson(request)));
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
        if (apiToken) await authorizeApiKey(apiToken, match[1], 'projects:read');
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
    match=path.match(new RegExp(`^/api/projects/(${id})/revenue(?:/(sessions)(?:/([a-f0-9]{64}))?)?$`,'i'));
    if(match){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Revenue accepts query parameters without a request body.');
      await limit(`revenue:${user.id}`,30);
      const authority=apiToken?{kind:'api-key' as const,token:apiToken}:{kind:'session' as const,userId:user.id};
      return json(await(match[3]?getRevenueSession(match[1],match[3],authority,url.searchParams):match[2]?listRevenueSessions(match[1],authority,url.searchParams):projectRevenue(match[1],authority,url.searchParams)));
    }
    match=path.match(new RegExp(`^/api/projects/(${id})/attribution$`,'i'));
    if(match){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Attribution accepts query parameters without a request body.');
      await limit(`attribution:${user.id}`,30);
      return json(await projectAttribution(match[1],apiToken?{kind:'api-key',token:apiToken}:{kind:'session',userId:user.id},url.searchParams));
    }
    match=path.match(new RegExp(`^/api/projects/(${id})/journeys$`,'i'));
    if(match){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Journeys accepts query parameters without a request body.');
      await limit(`journeys:${user.id}`,30);
      return json(await projectJourneys(match[1],apiToken?{kind:'api-key',token:apiToken}:{kind:'session',userId:user.id},url.searchParams));
    }
    match=path.match(new RegExp(`^/api/projects/(${id})/retention-report$`,'i'));
    if(match){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Retention reports do not accept a request body.');
      await limit(`retention-report:${user.id}`,30);
      return json(await projectRetentionReport(match[1],apiToken?{kind:'api-key',token:apiToken}:{kind:'session',userId:user.id},url.searchParams));
    }
    match=path.match(new RegExp(`^/api/projects/(${id})/realtime$`,'i'));
    if(match){
      if(request.method!=='GET')return json({error:'Method not allowed.'},405);
      if(url.search||request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw new FoundationError(400,'Live traffic uses the fixed window with no query parameters or body.');
      await limit(`realtime:${user.id}`,60);
      return json(await projectRealtime(match[1],apiToken?{kind:'api-key',token:apiToken}:{kind:'session',userId:user.id},url.searchParams));
    }
    match = path.match(new RegExp(`^/api/projects/(${id})/sessions(?:/([a-f0-9]{64})(/linked-activity)?)?$`, 'i'));
    if (match && request.method === 'GET') {
      await limit(`sessions:${user.id}`,30);
      const authority=apiToken?{kind:'api-key' as const,token:apiToken}:{kind:'session' as const,userId:user.id};
      return json(match[3]?await getLinkedSessionActivity(match[1],match[2],authority,url.searchParams):match[2]?await getSessionDetail(match[1],match[2],authority,url.searchParams):await listSessions(match[1],authority,url.searchParams));
    }
    match = path.match(new RegExp(`^/api/projects/(${id})/(events|analytics|explore|jobs|check-worker)$`, 'i'));
    if (match) {
      const target = await projectAccess(match[1], user.id, request.method !== 'GET');
      if (principal && request.method === 'POST' && match[2] === 'events') {
        const input = eventInput.omit({ siteKey: true, consent: true, collection: true, context: true }).parse(await readJson(request, 16384));
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
      if (request.method === 'GET' && match[2] === 'analytics') return json(await projectAnalytics(match[1], user.id, url.searchParams,principal?.id));
      if (request.method === 'GET' && match[2] === 'explore') {
        await limit(`explore:${user.id}`,30);
        const result = await exploreAnalytics(match[1],user.id,url.searchParams);
        if (apiToken) await authorizeApiKey(apiToken, target.workspace_id, 'analytics:read');
        return json(result);
      }
      if (request.method === 'GET' && match[2] === 'events') {
        const { rows } = await getDatabase().pool.query(`WITH retained AS MATERIALIZED (
          SELECT e.*,COALESCE(e.dimensions->>'origin',p.origin) AS origin FROM event e JOIN project p ON p.id=e.project_id WHERE p.id=$1
            AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        ), recent AS (SELECT id,event_name AS "eventName",path,origin,received_at AS "receivedAt" FROM retained ORDER BY received_at DESC,id DESC LIMIT 50)
        SELECT (SELECT analytics_retained_from FROM project WHERE id=$1) AS "retainedFrom",(SELECT count(*) FROM retained) AS total,
          COALESCE((SELECT json_agg(recent ORDER BY "receivedAt" DESC,id DESC) FROM recent),'[]'::json) AS events`, [match[1]]);
        if (apiToken) await authorizeApiKey(apiToken, target.workspace_id, 'analytics:read');
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
    if(error instanceof FoundationError&&['AI_SEARCH_BUSY','AI_SEARCH_DEADLINE','CONTENT_COVERAGE_BUSY'].includes((error as FoundationError&{code?:string}).code??''))return json({error:error.message},error.status,{...cors,'retry-after':'5'});
    if (error instanceof FoundationError || error instanceof InputError) return json({ error: error.message }, error.status, cors);
    if (error instanceof z.ZodError) return json({ error: 'Check the submitted fields and try again.' }, 400, cors);
    const code = (error as { code?: string })?.code;
    if (code === '23505') return json({ error: 'This item already exists in the workspace.' }, 409, cors);
    if (['SCHEMA_MISMATCH', 'ANALYTICS_NETWORK_CONFIG', '42P01', '42703', 'ECONNREFUSED', 'ENOTFOUND', 'ENOENT', 'EACCES'].includes(code ?? '')) return json({ error: 'The installation is not ready. Check configuration, database migrations and storage.' }, 503, cors);
    console.error('Application request failed; inspect configuration and database availability.');
    return json({ error: 'The request could not be completed. Try again or contact your operator.' }, 500, cors);
  }
}
