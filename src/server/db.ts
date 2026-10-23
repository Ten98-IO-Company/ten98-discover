import { join } from 'node:path';
import pg from 'pg';
import { createMigrationLedger } from '@ten98/runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { getConfig } from './config.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';

let database: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | undefined;
export function getDatabase() {
  if (!database) {
    const pool = new pg.Pool({ connectionString: getConfig().databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
    pool.on('error', () => console.error('Database connection failed; check database availability.'));
    database = { pool, db: drizzle(pool, { schema }) };
    registerResourceCleanup('database', closeDatabase);
  }
  return database;
}
export async function closeDatabase() { if (database) { await database.pool.end(); database = undefined; } }

export const migrationFiles = ['0001_foundation.sql', '0002_teams.sql', '0003_analytics.sql', '0004_account_security.sql', '0005_provider_core.sql', '0006_api_keys.sql', '0007_oidc.sql', '0008_destinations.sql', '0009_oidc_account_security.sql', '0010_reports.sql', '0011_domains.sql', '0012_native_analytics.sql', '0013_retention.sql', '0014_project_context.sql', '0015_google_imports.sql', '0016_keyword_research.sql', '0017_prompt_execution.sql', '0018_domain_redirect_checks.sql', '0019_site_audits.sql', '0020_funnels.sql', '0021_saved_keywords.sql', '0022_provider_account_identity.sql', '0023_rank_tracking.sql', '0024_rank_authored_revision.sql', '0025_meta_auth.sql', '0026_meta_imports.sql', '0027_meta_report_profiles.sql', '0028_meta_campaign_inventory.sql', '0029_meta_observed_cooldowns.sql', '0030_citation_context.sql', '0031_ai_suggestions.sql', '0032_site_audit_body.sql', '0033_analytics_segments.sql', '0034_analytics_annotations.sql', '0035_analytics_cohorts.sql', '0036_native_identify.sql', '0037_explicit_identity_links.sql', '0038_explicit_identity_event_evidence.sql', '0039_cookieless_collection.sql', '0040_analytics_geography.sql', '0041_api_prompt_scopes.sql', '0042_ai_search.sql', '0043_ai_content_support.sql', '0044_google_ads_imports.sql', '0045_account_preferences.sql', '0046_ga4_report_inventory.sql', '0047_prompt_explorer_models.sql', '0048_domain_research.sql', '0049_google_organic_reports.sql', '0050_prompt_explorer_cache.sql', '0051_prompt_recurring.sql', '0052_prompt_tracker_library.sql', '0053_ga4_commerce_reports.sql', '0054_web_performance.sql', '0055_session_replay.sql', '0056_replay_heatmaps.sql', '0057_custom_boards.sql', '0058_tracked_assets.sql', '0059_heatmap_backgrounds.sql', '0060_board_shares.sql', '0061_project_deletions.sql', '0062_api_content_scopes.sql', '0063_no_app_budgets.sql', '0064_remove_meta_google_ads.sql', '0065_event_click_ids.sql', '0066_google_domains_scopes.sql', '0067_audits_read_scope.sql', '0068_workspace_two_factor.sql', '0069_project_shares.sql', '0070_account_closure.sql', '0071_email_suppression.sql', '0072_paid_work_archive.sql', '0073_operator_export_audit.sql'] as const;
/**
 * The one PostgreSQL advisory lock (two-integer form, scoped to this database) that serialises every migration:
 * the ledger takes it per transaction, and startup migration holds it at session level while it waits and applies.
 */
export const migrationLockKey = [109857, 1] as const;
export const migrationLedger = createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: migrationFiles, lockKey: migrationLockKey });
export const migrationSources = () => migrationLedger.sources();

// Preserve the original foundation checksum contract used by existing integration checks.
export async function migrationSource() { return (await migrationSources())[0]; }

export const assertSchema = () => migrationLedger.assertCurrent(getDatabase().pool);
