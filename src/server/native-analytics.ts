import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { toUSVString } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';
import { normalizeDimensions, normalizeProperties } from './analytics-input.ts';
import { resolveAnalyticsNetwork } from './analytics-network.ts';
import { eventPath, InputError } from './validation.ts';
import { collectionOriginAllowed } from './collection-origins.ts';
import {recordIdentityLink} from './identity-links.ts';
import {analyticsEnvironment} from './analytics-environment.ts';
import {collectGeography,geographyReadiness} from './analytics-geography.ts';
import type {GeographyObservation} from '../lib/analytics-geography.ts';
import {normalizeRevenueProperties} from '../lib/revenue.ts';
import {replaySettings} from '../lib/session-replay.ts';
import {heatmapSettings} from '../lib/replay-heatmaps.ts';

const settingsInput = z.object({
  enabled: z.boolean(), consentMode: z.enum(['builtin', 'external']),
  collectionMode: z.enum(['consent-first', 'cookieless']).optional(),
  captureReferrer: z.boolean(), captureCampaigns: z.boolean(), captureScreen: z.boolean(),captureGeography:z.boolean().optional(),capturePerformance:z.boolean().optional(),
  excludeBots: z.boolean(),linkIdentities:z.boolean().optional(),replay:replaySettings.optional(),heatmap:heatmapSettings.optional(),
  excludedPaths: z.array(z.string().min(1).max(256).regex(/^\/[^?#\u0000-\u001f\u007f]*$(?![\s\S])/).refine(value => { try { decodeURIComponent(value); return toUSVString(value) === value; } catch { return false; } })).max(50),
}).strict();
export type AnalyticsSettings = z.infer<typeof settingsInput>;
type Project = { id: string; origin: string; analytics_settings: AnalyticsSettings; analytics_epoch: string; analytics_revision: number; destination_epoch: string | null };
export function publicAnalyticsSettings(value: unknown): AnalyticsSettings { const parsed=settingsInput.parse(value); return {...parsed,collectionMode:parsed.collectionMode??'consent-first'}; }
export function publicTrackingSettings(value:unknown){const s=publicAnalyticsSettings(value);return{enabled:s.enabled,consentMode:s.consentMode,collectionMode:s.collectionMode,captureReferrer:s.captureReferrer,captureCampaigns:s.captureCampaigns,captureScreen:s.captureScreen,excludeBots:s.excludeBots,...s.capturePerformance===undefined?{}:{capturePerformance:s.capturePerformance},...s.replay===undefined?{}:{replay:s.replay},...s.heatmap===undefined?{}:{heatmap:s.heatmap},...s.linkIdentities===undefined?{}:{linkIdentities:s.linkIdentities},excludedPaths:s.excludedPaths};}
export function analyticsPathExcluded(path: string, prefixes: string[]): boolean {
  if (!prefixes.length) return false;
  try { const decoded = decodeURIComponent(path); return prefixes.some(prefix => decoded.startsWith(decodeURIComponent(prefix))); }
  catch { return true; } // Malformed encodings cannot bypass a configured exclusion.
}
export function trackingConsentEpoch(nativeEpoch: string, destinationEpoch: string | null): string {
  const bytes = createHash('sha256').update(JSON.stringify(['ten98.tracking.consent.v2', nativeEpoch, destinationEpoch])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function digest(value: unknown, secret = getConfig().authSecret) { return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex'); }
type Context = { version: 1; project: string; visitor: string; visit: string; issued: number; epoch?:string };
const contextInput = z.object({ version: z.literal(1), project: z.uuid(), visitor: z.string().regex(/^[a-f0-9]{64}$/), visit: z.string().regex(/^[a-f0-9]{64}$/), issued: z.number().int().nonnegative(),epoch:z.uuid().optional() }).strict();
function signContext(value: Context, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${digest(['ten98.analytics.context.v1', body], secret)}`;
}
function readContext(value: unknown, secret: string): Context | null {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)) return null;
  try {
    const [body, signature] = value.split('.');
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest(['ten98.analytics.context.v1', body], secret), 'hex'))) return null;
    return contextInput.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch { return null; }
}

// Pinned Umami overview semantics: monthly visitor rotation, hourly-derived visits,
// with a browser-held signed context whose original issuance lasts at most 30 minutes.
// This is deliberately not described as sliding inactivity sessions or unique people.
export function analyticsIdentity(input: { projectId: string; ip: string | null; userAgent: string; distinctId?: string; context?: string; now?: Date; secret?: string; epoch?:string; collectionBasis?:'consent'|'cookieless' }) {
  if(input.collectionBasis==='cookieless'&&input.distinctId!==undefined)throw new InputError(400,'Basic analytics cannot include an explicit identifier.');
  if (!input.ip || !input.userAgent || input.userAgent.length > 1024) return null;
  const now = input.now ?? new Date(), secret = input.secret ?? getConfig().authSecret;
  const visitor = digest(input.collectionBasis==='cookieless'
    ?['ten98.analytics.basic.visitor.v1',input.projectId,now.toISOString().slice(0,7),input.ip,input.userAgent]
    :['ten98.analytics.visitor.v1', input.projectId, now.toISOString().slice(0, 7), input.ip, input.userAgent, input.distinctId ?? null], secret);
  const prior = readContext(input.context, secret);
  const cached = prior && prior.project === input.projectId && prior.visitor === visitor && prior.epoch===input.epoch && prior.issued <= now.getTime() && now.getTime() - prior.issued <= 1_800_000 ? prior : null;
  const value: Context = cached ?? { version: 1, project: input.projectId, visitor, visit: digest(['ten98.analytics.visit.v1', visitor, now.toISOString().slice(0, 13)], secret), issued: now.getTime(),...input.epoch===undefined?{}:{epoch:input.epoch} };
  return { visitor: value.visitor, visit: value.visit, context: signContext(value, secret), metricVersion: 'umami-3.4-hour-cache-v1' };
}

export async function analyticsSettings(projectId: string, userId: string) {
  const result = await getDatabase().pool.query(`SELECT p.analytics_settings AS settings,p.analytics_revision AS revision,m.role
    FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1`, [projectId, userId]);
  if (!result.rowCount) throw new FoundationError(404, 'Project not found or unavailable.');
  const normalized=publicAnalyticsSettings(result.rows[0].settings),settings={...normalized,captureGeography:normalized.captureGeography??false};return { ...result.rows[0],settings, networkMode: process.env.ANALYTICS_NETWORK_MODE || 'off',geography:geographyReadiness(settings.captureGeography===true) };
}
export async function saveAnalyticsSettings(projectId: string, userId: string, raw: unknown) {
  const input = z.object({ revision: z.number().int().positive(), settings: settingsInput }).strict().parse(raw);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR UPDATE OF w', [projectId]);
    const role = await client.query('SELECT m.role FROM membership m JOIN project p ON p.workspace_id=m.workspace_id WHERE p.id=$1 AND m.user_id=$2', [projectId, userId]);
    if (!['owner','admin'].includes(role.rows[0]?.role)) throw new FoundationError(404, 'Project not found or unavailable.');
    const current=await client.query('SELECT analytics_settings FROM project WHERE id=$1 FOR UPDATE',[projectId]);
    if(!current.rowCount)throw new FoundationError(404,'Project not found or unavailable.');
    const saved=publicAnalyticsSettings(current.rows[0].analytics_settings),settings={...input.settings,collectionMode:input.settings.collectionMode??saved.collectionMode,captureGeography:input.settings.captureGeography??saved.captureGeography??false,...input.settings.capturePerformance===undefined&&saved.capturePerformance!==undefined?{capturePerformance:saved.capturePerformance}:{},...input.settings.replay===undefined&&saved.replay!==undefined?{replay:saved.replay}:{},...input.settings.heatmap===undefined&&saved.heatmap!==undefined?{heatmap:saved.heatmap}:{}};
    const result = await client.query(`UPDATE project SET analytics_settings=$3,analytics_revision=analytics_revision+1,analytics_epoch=$4,
      identity_links_started_at=CASE WHEN $5::boolean THEN COALESCE(identity_links_started_at,clock_timestamp()) ELSE identity_links_started_at END
      WHERE id=$1 AND analytics_revision=$2 RETURNING analytics_settings AS settings,analytics_revision AS revision`, [projectId, input.revision, JSON.stringify(settings), randomUUID(),settings.linkIdentities===true]);
    if (!result.rowCount) throw new FoundationError(409, 'Settings changed. Reload before saving.');
    await client.query('COMMIT'); return {...result.rows[0],geography:geographyReadiness(settings.captureGeography===true)};
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export type Observation = { eventId: string; name: string; url: string; properties?: unknown; dimensions?: unknown; context?: string; consent?: { analytics: true; epoch: string; replay?:true }; collection?:{mode:'cookieless';epoch:string} };
// Caller holds the project publication gate. Read policy in a fresh statement
// after waiting so collection and identify share the same current-consent rules.
export async function nativeCollectionPolicy(client:PoolClient,request:Request,siteKey:string,input:Pick<Observation,'url'|'consent'|'collection'>,operation:'event'|'identify'|'replay'|'heatmap'){
  const result=await client.query<Project>(`SELECT p.*,r.consent_epoch AS destination_epoch FROM project p
    LEFT JOIN tracking_state s ON s.project_id=p.id AND s.environment='live'
    LEFT JOIN tracking_revision r ON r.id=s.active_revision AND r.project_id=p.id AND r.environment=s.environment
    WHERE p.public_key=$1`,[siteKey]);
  const project=result.rows[0],origin=request.headers.get('origin');
  if(!project||origin!==new URL(input.url).origin||!await collectionOriginAllowed(client,origin,project))throw new FoundationError(403,'Event does not match an allowed website origin.');
  const settings=publicAnalyticsSettings(project.analytics_settings),path=eventPath(input.url),userAgent=request.headers.get('user-agent')??'';
  // ponytail: conservative named-bot heuristic; use a reviewed maintained detector
  // when broader bot classification has measured fixtures and license approval.
  const excluded=!settings.enabled||analyticsPathExcluded(path,settings.excludedPaths)||request.headers.get('dnt')==='1'||request.headers.get('sec-gpc')==='1'||
    (settings.excludeBots&&/bot\b|crawler|spider|headless|slurp/i.test(userAgent));
  const epoch=trackingConsentEpoch(project.analytics_epoch,project.destination_epoch);
  const basis=input.consent?.analytics===true&&input.consent.epoch===epoch&&!input.collection&&(operation!=='replay'||input.consent.replay===true)?'consent' as const:
    operation==='event'&&!input.consent&&input.collection?.mode==='cookieless'&&input.collection.epoch===epoch&&settings.collectionMode==='cookieless'?'cookieless' as const:null;
  const reason=excluded?'collection_disabled' as const:basis===null?'consent_required' as const:null;
  return {project,userAgent,reason,basis};
}
async function writeObservation(client: PoolClient, project: Project, input: Observation, source: 'browser' | 'api', identity: ReturnType<typeof analyticsIdentity>, now: Date|string, identityEvidence:1|null,basis:'consent'|'cookieless'|null, environment?: ReturnType<typeof analyticsEnvironment>,geography?:GeographyObservation|null) {
  const settings = publicAnalyticsSettings(project.analytics_settings), dimensions = normalizeDimensions(input.dimensions === undefined ? {} : input.dimensions);
  let properties=normalizeProperties(input.properties === undefined ? {} : input.properties);
  try{properties=normalizeRevenueProperties(input.name,properties);}catch{throw new InputError(400,'Invalid native revenue event.');}
  // Distinct identifiers participate only in keyed identity derivation, never raw storage.
  delete dimensions.distinctId;
  if (!settings.captureReferrer) delete dimensions.referrerHost;
  if (!settings.captureCampaigns) delete dimensions.campaign;
  if (!settings.captureScreen) { delete dimensions.screenWidth; delete dimensions.screenHeight; }
  const inserted = await client.query(`INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,properties,dimensions,source,metric_version,identity_link_evidence_version,collection_basis)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(project_id,id) DO NOTHING RETURNING id`,
    [input.eventId, project.id, input.name, eventPath(input.url), now, identity?.visitor ?? null, identity?.visit ?? null,
      JSON.stringify(properties), JSON.stringify({ ...dimensions, ...environment,...geography?{geography}:{}, origin: new URL(input.url).origin }), source, identity?.metricVersion ?? 'observations-v2',identityEvidence,basis]);
  if (inserted.rowCount && identity) await client.query(`INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,$3,$3)
    ON CONFLICT(project_id,id) DO UPDATE SET first_seen_at=CASE WHEN analytics_visitor.first_seen_at<(SELECT analytics_retained_from FROM project WHERE id=$1) THEN excluded.first_seen_at ELSE LEAST(analytics_visitor.first_seen_at,excluded.first_seen_at) END,last_seen_at=GREATEST(analytics_visitor.last_seen_at,excluded.last_seen_at)`, [project.id, identity.visitor, now]);
  return { accepted: true, duplicate: !inserted.rowCount, ...(inserted.rowCount && identity ? { context: identity.context } : {}) };
}

export async function collectNative(request: Request, siteKey: string, input: Observation, peerAddress?: string) {
  const dimensions = normalizeDimensions(input.dimensions === undefined ? {} : input.dimensions);
  if(input.collection&&(input.consent||dimensions.distinctId!==undefined))throw new InputError(400,'Basic analytics cannot include consent or an explicit identifier.');
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    // Obtain the publication gate first. Read the epoch in a fresh statement after
    // any publisher finishes; a joined SELECT's old snapshot can otherwise survive a lock wait.
    if(dimensions.distinctId!==undefined){
      await client.query("SET LOCAL statement_timeout='5s'");await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.public_key=$1 FOR SHARE OF w',[siteKey]);
      await client.query('SELECT id FROM project WHERE public_key=$1 FOR UPDATE',[siteKey]);
    }else await client.query('SELECT id FROM project WHERE public_key=$1 FOR SHARE', [siteKey]);
    const {project,userAgent:ua,reason,basis}=await nativeCollectionPolicy(client,request,siteKey,input,'event');
    if(reason){await client.query('COMMIT');return {accepted:false,reason};}
    // Preserve one database acceptance instant through the event/link fence;
    // Date is used only for monthly key/context derivation, never the fence.
    const now:string=(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at`)).rows[0].accepted_at;
    const address=resolveAnalyticsNetwork(request,peerAddress),identity = analyticsIdentity({ projectId: project.id, ip: address, userAgent: ua, distinctId: dimensions.distinctId, context: input.context, now:new Date(now),epoch:project.analytics_epoch,collectionBasis:basis! });
    const eligible=basis==='consent'&&identity!==null&&dimensions.distinctId!==undefined&&project.analytics_settings.linkIdentities===true;
    const environment=analyticsEnvironment(ua, project.analytics_settings.captureScreen ? dimensions.screenWidth : undefined);
    const response = await writeObservation(client, project, input, 'browser', identity, now,eligible?1:null,basis,environment,project.analytics_settings.captureGeography===true?collectGeography(address):null);
    if(!response.duplicate&&eligible){
      await recordIdentityLink(client,project.id,identity!.visitor,dimensions.distinctId!,now as string);
      await client.query('UPDATE project SET identity_event_evidence_started_at=$2 WHERE id=$1 AND identity_event_evidence_started_at IS NULL',[project.id,now]);
    }
    await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK').catch(() => {});
    if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,'Collection took too long. The outcome may be unknown.');
    throw error; }
  finally { client.release(); }
}

// Caller must hold the workspace authorization lock and revalidate its API key.
// Server-supplied observations intentionally do not claim browser identity/consent.
export async function insertApiObservation(client: PoolClient, projectId: string, input: Observation) {
  const result = await client.query<Project>('SELECT * FROM project WHERE id=$1 FOR SHARE', [projectId]);
  const project = result.rows[0];
  if (!project || !await collectionOriginAllowed(client, new URL(input.url).origin, project)) throw new FoundationError(400, 'Event URL must use an allowed project origin.');
  const settings = publicAnalyticsSettings(project.analytics_settings);
  if (!settings.enabled || analyticsPathExcluded(new URL(input.url).pathname, settings.excludedPaths)) return { accepted: false, reason: 'collection_disabled' };
  const now=(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at as string;
  return writeObservation(client, project, input, 'api', null, now,null,null);
}
