import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { withContentProject } from './project-context.ts';
import { getBoss, workJobs } from './jobs.ts';
import { activeGoogleApp, googleAccessToken, googleConnection, googleConnectionDto, googleProjectTransaction, refreshGoogleConnection } from './google.ts';
import { GoogleRequestError, googleRequest } from './google-http.ts';
import { googleImportInput, googleInput, googleReportRequest, googleReports, isDetailedGa4Report, ga4OrganicReports, isOrganicOverview, organicPreviousRange, validateOrganicDates, googleCompatibilityRequest, normalizeGoogleCompatibility, normalizeGoogleReport, type GoogleReport, type ReportRow } from './google-reports.ts';
import { isGa4CommerceReport, readOrganicOverview } from '../lib/google-report-display.ts';

export const googleQueue = 'google-report-import';
type ImportRow = { id: string; connection_id: string; project_id: string; user_id: string; request_id: string; connection_revision: number; app_revision: number; report: GoogleReport; date_from: string; date_to: string; status: string; pages: number; row_count: number; provider_row_count: number | null; source: Record<string, unknown>; quality: { warnings: string[]; metadata: Record<string, unknown> }; diagnostic: string | null; created_at: Date; completed_at: Date | null; data_expired_at: Date | null };
// Explicit text dates keep provider-local calendar boundaries independent of the host timezone.
const importFields = 'i.*,i.date_from::text AS date_from,i.date_to::text AS date_to';
function googleImportDto(row: ImportRow) {
  return { id: row.id, report: row.report, from: row.date_from, to: row.date_to, status: row.status, dataStatus: row.data_expired_at ? 'expired' : 'available', pages: row.pages, rowCount: row.row_count, diagnostic: row.diagnostic, createdAt: row.created_at, completedAt: row.completed_at };
}

// Saved-snapshot readers. Under a key they take the content gate (workspace SHARE, 5 s bounds, key rechecked after admission,
// before publication and on the error path); every writer of snapshot content (pages, publication, expiry, source configuration) holds the workspace
// FOR UPDATE, so a bearer read never sees a half-published or half-expired snapshot. The worker's status-only failure updates (an import marked failed,
// a source marked for reconnect) run on the pool without it, so a read may observe such a status change. The cookie path keeps googleProjectTransaction unchanged.
export async function listGoogleConnections(projectId: string, userId: string, apiToken?: string) {
  const run = async (client: PoolClient, role: string) => {
    const app = (await client.query("SELECT * FROM google_app WHERE id='instance'")).rows[0];
    const connections = await client.query('SELECT * FROM google_connection WHERE project_id=$1 ORDER BY created_at,id', [projectId]);
    const metadata = [];
    for (const row of connections.rows) {
      const imports = await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE connection_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [row.id]);
      metadata.push({ ...googleConnectionDto(row, app?.revision), imports: imports.rows.map(googleImportDto) });
    }
    // The instance app configuration is operator data, so a key never receives it.
    return apiToken === undefined ? { role, app: { configured: !!app, enabled: app?.enabled ?? false, testing: app?.testing ?? true }, connections: metadata } : { role, connections: metadata };
  };
  return apiToken === undefined ? googleProjectTransaction(projectId, userId, false, (client, _workspaceId, role) => run(client, role))
    : withContentProject(projectId, userId, false, (client, project) => run(client, project.role), apiToken, false, 'google:read');
}

export async function enqueueGoogleImport(projectId: string, userId: string, connectionId: string, value: unknown) {
  const data = googleInput(googleImportInput, value), boss = await getBoss();
  return googleProjectTransaction(projectId, userId, true, async client => {
    const connection = await googleConnection(client, projectId, connectionId);
    const prior = (await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE project_id=$1 AND request_id=$2`, [projectId, data.requestId])).rows[0];
    if (prior) {
      if (prior.connection_id !== connectionId || prior.report !== data.report || prior.date_from !== data.from || prior.date_to !== data.to) throw new FoundationError(409, 'This request identifier was already used for a different import.');
      return { import: googleImportDto(prior) };
    }
    const app = await activeGoogleApp(client);
    if (connection.status !== 'ready' || !connection.property_id || connection.app_revision !== app.revision) throw new FoundationError(409, 'Connect and select an authorized property before importing.');
    if (googleReports[data.report].provider !== connection.provider) throw new FoundationError(400, 'Select a report for this provider.');
    if (ga4OrganicReports.includes(data.report)) validateOrganicDates(data.from, data.to, connection.time_zone);
    if ((await client.query("SELECT 1 FROM google_import WHERE connection_id=$1 AND status IN ('queued','running')", [connectionId])).rowCount) throw new FoundationError(409, 'This connection already has an active import. Wait for it to finish.');
    const source = { provider: connection.provider, propertyId: connection.property_id, propertyName: connection.property_name, timeZone: connection.time_zone, currencyCode: connection.currency_code };
    const id = randomUUID();
    const inserted = (await client.query<ImportRow>(`INSERT INTO google_import AS i(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${importFields}`, [id, connectionId, projectId, userId, data.requestId, connection.revision, app.revision, data.report, data.from, data.to, source])).rows[0];
    const sent = await boss.send(googleQueue, { importId: id }, { id, retryLimit: 2, retryDelay: 60, expireInSeconds: 600, db: { executeSql: (text, values) => client.query(text, values) } });
    if (!sent) throw new FoundationError(503, 'The import could not be queued. Retry the same request.');
    return { import: googleImportDto(inserted) };
  });
}

export async function readGoogleImport(projectId: string, userId: string, importId: string, offsetValue: unknown, apiToken?: string) {
  googleInput(z.uuid(), importId);
  const offset = googleInput(z.coerce.number().int().min(0).max(10000), offsetValue ?? 0);
  const run = async (client: PoolClient) => {
    const row = (await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1 AND project_id=$2`, [importId, projectId])).rows[0];
    if (!row) throw new FoundationError(404, 'Google report not found or unavailable.');
    const definition = googleReports[row.report];
    // A running/failed snapshot is not a successful zero-row report. Only finished
    // complete or explicitly partial snapshots expose persisted observations.
    const readable = !row.data_expired_at && (row.status === 'completed' || row.status === 'partial');
    const overview = isOrganicOverview(row.report), limit = overview ? 366 : 50;
    if (overview && offset !== 0) throw new FoundationError(400, 'Organic overviews are returned as one complete snapshot.');
    const page = readable ? await client.query<{ row: ReportRow }>(`SELECT item.value AS row FROM google_import_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) WITH ORDINALITY AS item(value,n)
      WHERE import_id=$1 ORDER BY p.page,item.n LIMIT $3 OFFSET $2`, [row.id, offset, limit + 1]) : { rows: [] };
    // Overview aggregates and range-report metadata are observations too.
    const quality = (overview || isGa4CommerceReport(row.report)) && !readable ? { warnings: [], metadata: {} } : row.quality;
    if (overview && readable) {
      const observations = readOrganicOverview(quality.metadata.organic, row.date_from, row.date_to, row.report === 'ga4_organic_weekly');
      if (row.status !== 'completed' || row.pages !== 3 || page.rows.length !== row.row_count || !observations || observations.trend.rowCount !== row.row_count) throw new FoundationError(503, 'The complete organic overview is unavailable. Import a fresh snapshot.');
    }
    const result = { import: googleImportDto(row), source: row.source, dimensions: definition.dimensions, metrics: definition.metrics, rows: page.rows.slice(0, limit).map(item => item.row), quality, nextOffset: page.rows.length > limit ? offset + limit : null };
    const organic = ga4OrganicReports.includes(row.report);
    if ((organic || isGa4CommerceReport(row.report)) && Buffer.byteLength(JSON.stringify(result), 'utf8') > 2097152) throw new FoundationError(503, `The complete ${organic ? 'organic' : 'GA4'} report is too large. Choose a smaller date range.`);
    return result;
  };
  return apiToken === undefined ? googleProjectTransaction(projectId, userId, false, run) : withContentProject(projectId, userId, false, run, apiToken, false, 'google:read');
}

export async function runGoogleImport(importId: string): Promise<void> {
  if (!z.uuid().safeParse(importId).success) throw new Error('Invalid Google import payload.');
  const initial = (await getDatabase().pool.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1`, [importId])).rows[0];
  if (!initial || !['queued', 'running'].includes(initial.status)) return;
  try {
    for (;;) {
      // Reject obsolete work before opening or refreshing a replacement grant.
      await refreshGoogleConnection(initial.project_id, initial.user_id, initial.connection_id, undefined, { revision: initial.connection_revision, appRevision: initial.app_revision, propertyId: typeof initial.source.propertyId === 'string' ? initial.source.propertyId : '' });
      // ponytail: a GSC/legacy GA4 page holds the workspace lock for one bounded 15s
      // request; detailed GA4 first-page attempts use two independently
      // bounded reads (compatibility, then report). Organic
      // overview stages each commit separately; current/trend have compatibility
      // plus report, previous has one report. No lock spans all three stages. Split into revocable leases if volume
      // makes this brief serialization disruptive; never drop the final recheck.
      const done = await googleProjectTransaction(initial.project_id, initial.user_id, true, async client => {
        const connection = await googleConnection(client, initial.project_id, initial.connection_id);
        const row = (await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1 FOR UPDATE`, [importId])).rows[0];
        if (!row || !['queued', 'running'].includes(row.status)) return true;
        const app = await activeGoogleApp(client);
        if (row.connection_revision !== connection.revision || row.app_revision !== app.revision || connection.app_revision !== app.revision || connection.status !== 'ready' || !connection.property_id) throw new FoundationError(409, 'Google authorization changed. Reconnect and start a new import.');
        if (row.pages >= 10) throw new Error('Invalid Google import checkpoint.');
        if (ga4OrganicReports.includes(row.report)) validateOrganicDates(row.date_from, row.date_to, connection.time_zone);
        const accessToken = await googleAccessToken(client, connection, app);
        const endpoint = connection.provider === 'gsc' ? `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.property_id)}/searchAnalytics/query` : `https://analyticsdata.googleapis.com/v1beta/${connection.property_id}:runReport`;
        if (isOrganicOverview(row.report)) {
          const stage = (['current', 'previous', 'trend'] as const)[row.pages];
          if (!stage) throw new FoundationError(409, 'The organic overview checkpoint is inconsistent. Start a new import.');
          const range = stage === 'previous' ? organicPreviousRange(row.date_from, row.date_to) : { from: row.date_from, to: row.date_to };
          // Two distinct field configurations: range aggregates and trend. The prior range reuses the committed aggregate compatibility check.
          if (stage !== 'previous') {
            const compatibility = await googleRequest(`https://analyticsdata.googleapis.com/v1beta/${connection.property_id}:checkCompatibility`, accessToken, googleCompatibilityRequest(row.report, row.date_from, row.date_to, stage));
            normalizeGoogleCompatibility(row.report, compatibility, stage);
          }
          const raw = await googleRequest(endpoint, accessToken, googleReportRequest(row.report, row.date_from, row.date_to, 0, stage));
          const page = normalizeGoogleReport(row.report, raw, range.from, range.to, stage);
          if (page.quality.metadata.timeZone && page.quality.metadata.timeZone !== connection.time_zone) throw new FoundationError(409, 'The Google property timezone changed. Add a new source.');
          if (page.quality.metadata.currencyCode && page.quality.metadata.currencyCode !== connection.currency_code) throw new FoundationError(409, 'The Google property currency changed. Add a new source.');
          const prior = row.quality.metadata.organic as Record<string, unknown> | undefined;
          if (row.pages && (!prior || !Object.hasOwn(prior, 'current')) || row.pages === 2 && !Object.hasOwn(prior!, 'previous')) throw new FoundationError(409, 'The organic overview checkpoint is incomplete. Start a new import.');
          const observation = { from: range.from, to: range.to, values: stage === 'trend' ? null : page.rows[0]?.metrics ?? null, rowCount: page.rowCount, quality: page.quality, reportRequests: 1, compatibilityRequests: stage === 'previous' ? 0 : 1 };
          const organic = { ...prior, [stage]: observation, complete: stage === 'trend', interval: row.report === 'ga4_organic_daily' ? 'daily' : 'weekly' };
          const quality = { warnings: [...new Set([...row.quality.warnings, ...page.quality.warnings])], metadata: { organic } };
          if (Buffer.byteLength(JSON.stringify(quality), 'utf8') > 131072) throw new FoundationError(502, 'Google returned too much overview metadata.');
          if (stage === 'trend' && !readOrganicOverview(organic, row.date_from, row.date_to, row.report === 'ga4_organic_weekly')) throw new FoundationError(502, 'The complete organic overview metadata could not be verified.');
          await client.query('INSERT INTO google_import_page(import_id,page,rows) VALUES($1,$2,$3)', [row.id, row.pages, JSON.stringify(stage === 'trend' ? page.rows : [])]);
          await client.query(`UPDATE google_import SET status=$2,pages=$3,row_count=$4,provider_row_count=$4,quality=$5,diagnostic=NULL,completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE NULL END WHERE id=$1`, [row.id, stage === 'trend' ? 'completed' : 'running', row.pages + 1, stage === 'trend' ? page.rows.length : 0, quality]);
          return stage === 'trend';
        }
        if (connection.provider === 'ga4' && isDetailedGa4Report(row.report) && row.pages === 0) {
          const compatibility = await googleRequest(`https://analyticsdata.googleapis.com/v1beta/${connection.property_id}:checkCompatibility`, accessToken, googleCompatibilityRequest(row.report, row.date_from, row.date_to));
          normalizeGoogleCompatibility(row.report, compatibility);
        }
        const raw = await googleRequest(endpoint, accessToken, googleReportRequest(row.report, row.date_from, row.date_to, row.row_count));
        const page = normalizeGoogleReport(row.report, raw, row.date_from, row.date_to);
        if (connection.provider === 'ga4' && row.provider_row_count !== null && page.rowCount !== row.provider_row_count) throw new FoundationError(409, 'Google data changed during pagination. Start a fresh import.');
        if (page.rowCount !== null && page.rowCount < row.row_count + page.rows.length) throw new FoundationError(502, 'Google returned inconsistent report pagination.');
        const duplicate = await client.query(`SELECT 1 FROM google_import_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) old_row
          JOIN jsonb_array_elements($2::jsonb) new_row ON old_row->'dimensions'=new_row->'dimensions' WHERE import_id=$1 LIMIT 1`, [row.id, JSON.stringify(page.rows)]);
        if (duplicate.rowCount) throw new FoundationError(409, 'Google repeated report rows during pagination. Start a fresh import.');
        const rowCount = row.row_count + page.rows.length, pages = row.pages + 1;
        const complete = connection.provider === 'ga4' ? rowCount >= (page.rowCount ?? 0) : page.rows.length < 1000;
        if (!complete && !page.rows.length) throw new FoundationError(502, 'Google report pagination stopped before completion.');
        const capped = !complete && pages === 10;
        const warnings = [...new Set([...row.quality.warnings, ...page.quality.warnings, ...(capped ? ['This import reached its 10,000-row safety bound. Choose a smaller date range; this snapshot is partial.'] : [])])];
        // Preserve quality from every page; a later page cannot erase earlier
        // suppression/restriction/sampling evidence or change property-local dates.
        const metadata = { ...row.quality.metadata, [`page${pages}`]: page.quality.metadata };
        if (page.quality.metadata.timeZone && page.quality.metadata.timeZone !== connection.time_zone) throw new FoundationError(409, 'The Google property timezone changed. Add a new source to preserve date provenance.');
        if (connection.provider === 'ga4' && page.quality.metadata.currencyCode && page.quality.metadata.currencyCode !== connection.currency_code) throw new FoundationError(409, 'The Google property currency changed. Add a new source to preserve currency provenance.');
        await client.query('INSERT INTO google_import_page(import_id,page,rows) VALUES($1,$2,$3)', [row.id, row.pages, JSON.stringify(page.rows)]);
        await client.query(`UPDATE google_import SET status=$2,pages=$3,row_count=$4,provider_row_count=$5,quality=$6,diagnostic=NULL,
          completed_at=CASE WHEN $2 IN ('completed','partial') THEN now() ELSE NULL END WHERE id=$1`, [row.id, complete ? 'completed' : capped ? 'partial' : 'running', pages, rowCount, page.rowCount, { warnings, metadata }]);
        return complete || capped;
      });
      if (done) return;
    }
  } catch (error) {
    if (error instanceof GoogleRequestError && error.reauthorize) {
      await getDatabase().pool.query("UPDATE google_connection SET status='reconnect',updated_at=now() WHERE id=$1 AND revision=$2 AND status<>'disconnected'", [initial.connection_id, initial.connection_revision]);
    }
    const retryable = error instanceof GoogleRequestError && error.retryable;
    const denied = error instanceof FoundationError && [403, 404, 409].includes(error.status) && !(error instanceof GoogleRequestError);
    const diagnostic = error instanceof FoundationError ? error.message : 'The report could not be imported. Retry later.';
    await getDatabase().pool.query(`UPDATE google_import SET status=$2,diagnostic=$3,completed_at=CASE WHEN $2 IN ('failed','denied') THEN now() ELSE NULL END
      WHERE id=$1 AND status IN ('queued','running')`, [importId, retryable ? 'queued' : denied ? 'denied' : 'failed', diagnostic]);
    if (retryable) throw new Error('Google import is temporarily unavailable.');
  }
}

export async function reconcileGoogleImports() {
  // Pinned pg-boss12 schema; completed queue jobs without an application terminal
  // state and deleted/failed jobs are recoverable failures, never false success.
  await getDatabase().pool.query(`UPDATE google_import i SET status='failed',diagnostic='The worker stopped before this import completed. Start a new import.',completed_at=now()
    WHERE status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.id=i.id AND j.name=$1 AND j.state NOT IN ('failed','cancelled','completed'))`, [googleQueue]);
}
export async function startGoogleImportWorker(boss: PgBoss) {
  await workJobs<{ importId: string }>(boss, googleQueue, { batchSize: 1 }, async jobs => { for (const job of jobs) await runGoogleImport(job.data.importId); });
}
