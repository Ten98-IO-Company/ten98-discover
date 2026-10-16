import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { getBoss } from './jobs.ts';
import { activeGoogleApp, googleAccessToken, googleConnection, googleConnectionDto, googleProjectTransaction, refreshGoogleConnection, googleAdsConfigured, googleAdsHeaders, googleAdsCustomer } from './google.ts';
import { GoogleRequestError, googleRequest } from './google-http.ts';
import { googleImportInput, googleInput, googleReportRequest, googleReports, googleAdsVersion, ga4InventoryReports, googleCompatibilityRequest, normalizeGoogleCompatibility, normalizeGoogleReport, type GoogleReport, type ReportRow } from './google-reports.ts';

export const googleQueue = 'google-report-import';
type ImportRow = { id: string; connection_id: string; project_id: string; user_id: string; request_id: string; connection_revision: number; app_revision: number; report: GoogleReport; date_from: string; date_to: string; status: string; pages: number; row_count: number; provider_row_count: number | null; source: Record<string, unknown>; quality: { warnings: string[]; metadata: Record<string, unknown> }; diagnostic: string | null; created_at: Date; completed_at: Date | null; data_expired_at: Date | null };
// Explicit text dates keep provider-local calendar boundaries independent of the host timezone.
const importFields = 'i.*,i.date_from::text AS date_from,i.date_to::text AS date_to';
export function googleImportDto(row: ImportRow) {
  return { id: row.id, report: row.report, from: row.date_from, to: row.date_to, status: row.status, dataStatus: row.data_expired_at ? 'expired' : 'available', pages: row.pages, rowCount: row.row_count, diagnostic: row.diagnostic, createdAt: row.created_at, completedAt: row.completed_at };
}

export async function listGoogleConnections(projectId: string, userId: string) {
  return googleProjectTransaction(projectId, userId, false, async (client, _workspaceId, role) => {
    const app = (await client.query("SELECT * FROM google_app WHERE id='instance'")).rows[0];
    const connections = await client.query('SELECT * FROM google_connection WHERE project_id=$1 ORDER BY created_at,id', [projectId]);
    const metadata = [];
    for (const row of connections.rows) {
      const imports = await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE connection_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [row.id]);
      metadata.push({ ...googleConnectionDto(row, app?.revision), imports: imports.rows.map(googleImportDto) });
    }
    return { role, app: { configured: !!app, enabled: app?.enabled ?? false, testing: app?.testing ?? true, adsConfigured: !!app && googleAdsConfigured(app) }, connections: metadata };
  });
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
    if (connection.provider === 'ads') googleAdsHeaders(app, connection.login_customer_id ?? undefined);
    if ((await client.query("SELECT 1 FROM google_import WHERE connection_id=$1 AND status IN ('queued','running')", [connectionId])).rowCount) throw new FoundationError(409, 'This connection already has an active import. Wait for it to finish.');
    const source = { provider: connection.provider, propertyId: connection.property_id, propertyName: connection.property_name, timeZone: connection.time_zone, currencyCode: connection.currency_code, ...(connection.provider === 'ads' ? { loginCustomerId: connection.login_customer_id, apiVersion: googleAdsVersion, attribution: 'Google Ads conversion settings; not native analytics' } : {}) };
    const id = randomUUID();
    const inserted = (await client.query<ImportRow>(`INSERT INTO google_import AS i(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${importFields}`, [id, connectionId, projectId, userId, data.requestId, connection.revision, app.revision, data.report, data.from, data.to, source])).rows[0];
    const sent = await boss.send(googleQueue, { importId: id }, { id, retryLimit: 2, retryDelay: 60, expireInSeconds: 600, db: { executeSql: (text, values) => client.query(text, values) } });
    if (!sent) throw new FoundationError(503, 'The import could not be queued. Retry the same request.');
    return { import: googleImportDto(inserted) };
  });
}

export async function readGoogleImport(projectId: string, userId: string, importId: string, offsetValue: unknown) {
  googleInput(z.uuid(), importId);
  const offset = googleInput(z.coerce.number().int().min(0).max(10000), offsetValue ?? 0);
  return googleProjectTransaction(projectId, userId, false, async client => {
    const row = (await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1 AND project_id=$2`, [importId, projectId])).rows[0];
    if (!row) throw new FoundationError(404, 'Google report not found or unavailable.');
    const definition = googleReports[row.report];
    // A running/failed snapshot is not a successful zero-row report. Only finished
    // complete or explicitly partial snapshots expose persisted observations.
    const readable = !row.data_expired_at && (row.status === 'completed' || row.status === 'partial');
    const page = readable ? await client.query<{ row: ReportRow }>(`SELECT item.value AS row FROM google_import_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) WITH ORDINALITY AS item(value,n)
      WHERE import_id=$1 ORDER BY p.page,item.n LIMIT 51 OFFSET $2`, [row.id, offset]) : { rows: [] };
    return { import: googleImportDto(row), source: row.source, dimensions: definition.dimensions, metrics: definition.metrics, rows: page.rows.slice(0, 50).map(item => item.row), quality: row.quality, nextOffset: page.rows.length > 50 ? offset + 50 : null };
  });
}

export async function runGoogleImport(importId: string): Promise<void> {
  if (!z.uuid().safeParse(importId).success) throw new Error('Invalid Google import payload.');
  const initial = (await getDatabase().pool.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1`, [importId])).rows[0];
  if (!initial || !['queued', 'running'].includes(initial.status)) return;
  try {
    for (;;) {
      await refreshGoogleConnection(initial.project_id, initial.user_id, initial.connection_id);
      // ponytail: a GSC/legacy GA4 page holds the workspace lock for one bounded 15s
      // request; detailed GA4 first-page attempts and Ads use two independently
      // bounded reads (compatibility/customer verification, then report). Split into revocable leases if volume
      // makes this brief serialization disruptive; never drop the final recheck.
      const done = await googleProjectTransaction(initial.project_id, initial.user_id, true, async client => {
        const connection = await googleConnection(client, initial.project_id, initial.connection_id);
        const row = (await client.query<ImportRow>(`SELECT ${importFields} FROM google_import i WHERE id=$1 FOR UPDATE`, [importId])).rows[0];
        if (!row || !['queued', 'running'].includes(row.status)) return true;
        const app = await activeGoogleApp(client);
        if (row.connection_revision !== connection.revision || row.app_revision !== app.revision || connection.app_revision !== app.revision || connection.status !== 'ready' || !connection.property_id) throw new FoundationError(409, 'Google authorization changed. Reconnect and start a new import.');
        if (row.pages >= 10) throw new Error('Invalid Google import checkpoint.');
        const accessToken = await googleAccessToken(client, connection, app);
        if (connection.provider === 'ads') {
          if (row.pages !== 0 || row.row_count !== 0) throw new FoundationError(409, 'The Ads import checkpoint is inconsistent. Start a fresh import.');
          const customerId = connection.property_id.slice(10), customer = await googleAdsCustomer(accessToken, app, customerId, connection.login_customer_id ?? undefined);
          if (customer.manager || customer.timeZone !== connection.time_zone || customer.currencyCode !== connection.currency_code) throw new FoundationError(409, 'The Google Ads account settings changed. Add a new source to preserve timezone and currency provenance.');
          const raw = await googleRequest(`https://googleads.googleapis.com/${googleAdsVersion}/customers/${customerId}/googleAds:search`, accessToken,
            googleReportRequest(row.report, row.date_from, row.date_to, 0), googleAdsHeaders(app, connection.login_customer_id ?? undefined));
          const page = normalizeGoogleReport(row.report, raw, row.date_from, row.date_to, customerId), storedPages = Math.max(1, Math.ceil(page.rows.length / 1000));
          // One bounded provider response is published atomically; its unconsumed
          // continuation is evidence of a partial import, never a complete report.
          for (let n = 0; n < storedPages; n++) await client.query('INSERT INTO google_import_page(import_id,page,rows) VALUES($1,$2,$3)', [row.id, n, JSON.stringify(page.rows.slice(n * 1000, (n + 1) * 1000))]);
          await client.query(`UPDATE google_import SET status=$2,pages=$3,row_count=$4,provider_row_count=$5,quality=$6,diagnostic=NULL,completed_at=now() WHERE id=$1`,
            [row.id, page.complete ? 'completed' : 'partial', storedPages, page.rows.length, page.rowCount, page.quality]);
          return true;
        }
        const endpoint = connection.provider === 'gsc' ? `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.property_id)}/searchAnalytics/query` : `https://analyticsdata.googleapis.com/v1beta/${connection.property_id}:runReport`;
        if (connection.provider === 'ga4' && ga4InventoryReports.includes(row.report) && row.pages === 0) {
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
  await boss.work<{ importId: string }>(googleQueue, { batchSize: 1 }, async jobs => { for (const job of jobs) await runGoogleImport(job.data.importId); });
}
