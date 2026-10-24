// Committed routing table for tests/browser-sweep.ts: one entry per browser suite, so a new or renamed suite
// fails tests/browser-sweep-routes.test.ts until someone decides how it runs. Never loosen a suite's own guard here;
// record what it needs instead.
//   component       runs directly with its opt-in flag(s); owned loopback Vite and synthetic, intercepted API only.
//   native          needs a migrated installation: tests/helpers/native-browser.mjs (fresh throwaway DB per suite, built
//                   .output, local PostgreSQL), or an operator-provisioned harness fixture (tests/research-ui, tests/conversions-ui).
//   evidence-gated  needs owner-approved or captured evidence files the sweep never creates; runs only when every evidence
//                   variable names an existing file, otherwise SKIPPED. `blocked` entries never run from the sweep.
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export type SuiteClass = 'component' | 'native' | 'evidence-gated';
export type Harness = 'native-browser' | 'research-ui' | 'conversions-ui';
export interface SuiteRoute {
  suite: string;
  class: SuiteClass;
  /** Opt-in variables the suite asserts; each is set to 1. */
  flags?: string[];
  /** native only: how the installation is provided. */
  harness?: Harness;
  /** native-browser options, e.g. --unclaimed, --no-worker, --self-hosted, --database=<prefix>, --database-port=<port>. */
  runner?: string[];
  /** native-browser app port (NATIVE_BROWSER_PORT) when the suite pins one; the runner defaults to 3197. */
  port?: number;
  /** evidence-gated: variables that must name existing evidence files. */
  evidence?: string[];
  /** evidence-gated: why the sweep can never run this suite as-is. */
  blocked?: string;
  /** Prerequisite or known follow-up shown in the table. */
  note?: string;
  timeoutMs?: number;
}

const component = (suite: string, flags: string[] = [], note?: string): SuiteRoute => ({suite, class: 'component', flags, ...(note ? {note} : {})});
const native = (suite: string, flags: string[], runner: string[] = [], extra: Partial<SuiteRoute> = {}): SuiteRoute => ({suite, class: 'native', harness: 'native-browser', flags, runner, ...extra});
const pinned = ['--database-port=55501'];
const fixture = (harness: 'research-ui' | 'conversions-ui', suite: string, note?: string): SuiteRoute => ({suite, class: 'native', harness, ...(note ? {note} : {})});
const evidence = (suite: string, flags: string[], files: string[], note: string): SuiteRoute => ({suite, class: 'evidence-gated', flags, evidence: files, note});

export const browserSuiteRoutes: SuiteRoute[] = [
  component('tests/account-preferences-browser.mjs', ['TEN98_ACCOUNT_PREFERENCES_BROWSER']),
  component('tests/advanced-filters-browser.mjs', ['TEN98_ADVANCED_BROWSER']),
  component('tests/ai-comparison-browser.mjs', ['TEN98_AI_COMPARISON_BROWSER']),
  component('tests/ai-comparison-view-browser.mjs', ['TEN98_AI_COMPARISON_VIEW_BROWSER']),
  component('tests/ai-insights-browser.mjs', ['TEN98_AI_INSIGHTS_BROWSER']),
  component('tests/ai-insights-view-browser.mjs', ['TEN98_AI_INSIGHTS_VIEW_BROWSER']),
  component('tests/ai-query-export-browser.mjs'),
  component('tests/ai-suggestions-browser.mjs', ['TEN98_AI_SUGGESTIONS_BROWSER']),
  component('tests/analytics-comparison-browser.mjs', ['TEN98_COMPARISON_BROWSER'], 'optional TEN98_DIMENSION_SQL_SNAPSHOTS groups report NOT RUN'),
  component('tests/analytics-environment-browser.mjs', ['TEN98_ENVIRONMENT_BROWSER']),
  component('tests/analytics-export-browser.mjs', ['TEN98_ANALYTICS_EXPORT_BROWSER']),
  component('tests/analytics-geography-browser.mjs', ['TEN98_GEOGRAPHY_BROWSER'], 'optional TEN98_LOCATION_DETAIL_SNAPSHOT not supplied'),
  component('tests/analytics-geography-flow-browser.mjs', ['TEN98_GEOGRAPHY_FLOW_BROWSER'], 'optional TEN98_GEOGRAPHY_SQL_DTOS not supplied'),
  component('tests/analytics-library-browser.mjs', ['TEN98_ANALYTICS_LIBRARY_BROWSER']),
  component('tests/analytics-reset-browser.mjs', ['TEN98_ANALYTICS_RESET_BROWSER']),
  component('tests/annotations-browser.mjs', ['TEN98_ANNOTATIONS_BROWSER']),
  component('tests/attribution-library-browser.mjs'),
  component('tests/backlink-research-browser.mjs', ['TEN98_BACKLINK_RESEARCH_BROWSER']),
  component('tests/board-share-owner-browser.mjs', ['TEN98_BOARD_SHARE_OWNER_BROWSER']),
  component('tests/board-share-recipient-browser.mjs', ['TEN98_BOARD_SHARE_BROWSER']),
  component('tests/boards-browser.mjs', ['TEN98_BOARDS_BROWSER']),
  component('tests/boards-library-browser.mjs', ['TEN98_BOARDS_LIBRARY_BROWSER']),
  component('tests/campaign-ui-browser.mjs', ['TEN98_CAMPAIGN_UI_BROWSER']),
  component('tests/citation-browser.mjs', ['TEN98_CITATION_BROWSER']),
  component('tests/citation-specializations-browser.mjs', ['TEN98_CITATION_SPECIALIZATIONS_BROWSER']),
  component('tests/citation-specializations-view-browser.mjs', ['TEN98_SPECIALIZED_CITATION_VIEW_BROWSER']),
  component('tests/citation-view-browser.mjs', ['TEN98_CITATION_VIEW_BROWSER']),
  component('tests/cohorts-browser.mjs', ['TEN98_COHORTS_BROWSER']),
  component('tests/context-exit-browser.mjs', ['TEN98_CONTEXT_EXIT_BROWSER']),
  component('tests/conversions-library-browser.mjs'),
  component('tests/design-system-browser.mjs', ['TEN98_DESIGN_SYSTEM_BROWSER']),
  component('tests/design-tokens-browser.mjs', ['TEN98_DESIGN_TOKENS_BROWSER']),
  component('tests/destinations-settings-browser.mjs', ['TEN98_DESTINATION_SETTINGS_BROWSER']),
  component('tests/domain-overview-browser.mjs', ['TEN98_DOMAIN_OVERVIEW_BROWSER']),
  component('tests/domains-setup-browser.mjs', ['TEN98_DOMAINS_SETUP_BROWSER']),
  component('tests/explorer-library-browser.mjs', ['TEN98_EXPLORER_LIBRARY_BROWSER']),
  component('tests/explorer-scope-browser.mjs', ['TEN98_EXPLORER_SCOPE_BROWSER']),
  component('tests/google-commerce-browser.mjs', ['TEN98_GOOGLE_COMMERCE_BROWSER']),
  component('tests/google-library-browser.mjs'),
  component('tests/google-organic-browser.mjs', ['TEN98_GOOGLE_ORGANIC_BROWSER']),
  component('tests/heatmap-collector-browser.mjs', ['TEN98_HEATMAP_COLLECTOR_BROWSER']),
  component('tests/heatmap-geometry-browser.mjs', ['TEN98_HEATMAP_GEOMETRY_BROWSER']),
  component('tests/journey-saved-scopes-browser.mjs', ['TEN98_JOURNEY_SAVED_BROWSER']),
  component('tests/journey-step-search-browser.mjs', ['TEN98_JOURNEY_STEP_BROWSER']),
  component('tests/journeys-browser.mjs', ['TEN98_JOURNEYS_BROWSER'], 'optional TEN98_JOURNEYS_SQL_DTOS not supplied'),
  component('tests/keyword-cost-library-browser.mjs', ['TEN98_KEYWORD_COST_BROWSER']),
  component('tests/library-flow-adapters-browser.mjs'),
  component('tests/openrouter-models-browser.mjs', ['TEN98_MODELS_BROWSER']),
  component('tests/password-recovery-browser.mjs', ['TEN98_PASSWORD_RECOVERY_BROWSER']),
  component('tests/project-delete-browser.mjs', ['TEN98_PROJECT_DELETE_BROWSER']),
  component('tests/prompt-discovery-browser.mjs', ['TEN98_PROMPT_DISCOVERY_BROWSER']),
  component('tests/prompt-receipt-browser.mjs', ['TEN98_PROMPT_RECEIPT_BROWSER']),
  component('tests/prompt-recurring-browser.mjs', ['TEN98_PROMPT_RECURRING_BROWSER']),
  component('tests/rank-check-browser.mjs', ['TEN98_RANK_CHECK_BROWSER']),
  component('tests/rank-history-browser.mjs', ['TEN98_RANK_HISTORY_BROWSER']),
  component('tests/rank-reporting-browser.mjs', ['TEN98_RANK_REPORTING_BROWSER']),
  component('tests/rank-saved-keywords-browser.mjs', ['TEN98_RANK_SAVED_BROWSER']),
  component('tests/rank-schedule-browser.mjs', ['TEN98_RANK_SCHEDULE_BROWSER']),
  component('tests/rank-tracking-browser.mjs', ['TEN98_RANK_PANEL_BROWSER']),
  component('tests/realtime-browser.mjs', ['TEN98_REALTIME_BROWSER']),
  component('tests/replay-heatmaps-browser.mjs', ['TEN98_REPLAY_HEATMAPS_BROWSER']),
  component('tests/replay-heatmaps-classic-browser.mjs', ['TEN98_REPLAY_HEATMAPS_CLASSIC']),
  component('tests/report-navigation-browser.mjs', ['TEN98_REPORT_NAVIGATION_BROWSER'], 'optional TEN98_REPORT_NAV_*_SQL snapshots not supplied'),
  component('tests/research-flow-browser.mjs'),
  component('tests/revenue-empty-browser.mjs', ['TEN98_REVENUE_EMPTY_BROWSER']),
  component('tests/saved-filters-browser.mjs', ['TEN98_SAVED_FILTERS_BROWSER']),
  component('tests/session-explorer-browser.ts', ['TEN98_SESSION_EXPLORER_BROWSER']),
  component('tests/session-predicates-browser.ts', ['TEN98_SESSION_BROWSER']),
  component('tests/session-replay-browser.mjs', ['TEN98_SESSION_REPLAY_BROWSER']),
  component('tests/session-replay-vendor-browser.mjs', ['TEN98_REPLAY_VENDOR_SMOKE']),
  component('tests/settings-recovery-browser.mjs', ['TEN98_SETTINGS_RECOVERY_BROWSER']),
  component('tests/site-audit-ux-browser.mjs', ['TEN98_SITE_AUDIT_UX_BROWSER']),
  component('tests/tracked-assets-browser.mjs', ['TEN98_TRACKED_ASSETS_BROWSER']),
  component('tests/utm-report-browser.mjs', ['TEN98_UTM_BROWSER']),
  component('tests/web-performance-browser.mjs', ['TEN98_WEB_PERFORMANCE_BROWSER']),
  component('tests/website-quick-share-browser.ts', ['TEN98_QUICK_SHARE_BROWSER']),
  component('tests/website-share-exit-browser.mjs', ['TEN98_WEBSITE_SHARE_EXIT_BROWSER']),
  component('tests/workspace-navigation-browser.mjs', ['TEN98_WORKSPACE_NAV_BROWSER']),

  // Runner options follow the container runs recorded on #287 (PRs #295, #299, #301). Suites that pin app 127.0.0.1:3099 and
  // DB port 55501 with a named database prefix get exactly those; the runner refuses non-local PostgreSQL.
  native('tests/explorer-browser.ts', []),
  native('tests/retention-browser.ts', []),
  native('tests/navigation-browser.ts', []),
  native('tests/reports-browser.ts', []),
  native('tests/native-analytics-browser.ts', []),
  native('tests/project-context-browser.mjs', []),
  native('tests/domain-collection-browser.ts', []),
  native('tests/domain-redirect-browser.ts', [], ['--no-worker'], {note: 'starts its own worker with a synthetic provider transport'}),
  native('tests/domain-research-browser.ts', [], ['--self-hosted'], {note: 'hosts its own front server on the app port and SSR on port+1; runner route not yet proven in the container'}),
  native('tests/google-browser.ts', [], ['--self-hosted', '--database=ten98_google_browser', ...pinned], {note: 'hosts its own front server on the app port and SSR on port+1'}),
  native('tests/segments-browser.mjs', ['TEN98_SEGMENTS_BROWSER'], ['--database=ten98_segments_browser', ...pinned], {port: 3099}),
  native('tests/annotations-production-browser.mjs', ['TEN98_ANNOTATIONS_PRODUCTION_BROWSER'], ['--database=ten98_annotations', ...pinned], {port: 3099}),
  native('tests/cohorts-production-browser.mjs', ['TEN98_COHORTS_PRODUCTION_BROWSER'], ['--database=ten98_cohorts', ...pinned], {port: 3099}),
  native('tests/native-identify-production-browser.ts', ['TEN98_IDENTIFY_BROWSER'], ['--database=ten98_identify', ...pinned], {port: 3099}),
  native('tests/session-explorer-production-browser.ts', ['TEN98_SESSION_EXPLORER_PRODUCTION_BROWSER'], ['--database=ten98_session', ...pinned], {port: 3099}),
  native('tests/session-predicates-production-browser.ts', ['TEN98_SESSION_PRODUCTION_BROWSER'], ['--database=ten98_session', ...pinned], {port: 3099}),
  native('tests/project-delete-compiled-browser.mjs', ['TEN98_PROJECT_DELETE_COMPILED'], ['--unclaimed']),
  // The navigation-review fixture claims the fresh installation itself through the first sign-up.
  native('tests/shell-flow-browser.mjs', ['TEN98_SHELL_FLOW_BROWSER'], ['--unclaimed'], {port: 3094}),
  native('tests/rank-loading-browser.mjs', ['TEN98_RANK_LOADING_BROWSER'], ['--unclaimed'], {port: 3094,
    note: 'asserts origin http://localhost:3094 while the runner serves BASE_URL http://127.0.0.1:3094; stale Analytics/Rank tracking locators (#320)'}),

  // Operator-provisioned harness fixtures (see each README): a seeded, migrated ten98_research_ui_*/ten98_funnels_* database and the
  // web process started with the harness preload. The sweep runs them in README order with the operator's env file and never seeds.
  fixture('research-ui', 'tests/research-ui/keyword-browser.mjs'),
  fixture('research-ui', 'tests/research-ui/keyword-lifecycle-browser.mjs'),
  fixture('research-ui', 'tests/research-ui/prompt-browser.mjs'),
  fixture('research-ui', 'tests/research-ui/audit-browser.mjs'),
  fixture('research-ui', 'tests/research-ui/audit-body-browser.mjs', 'not listed in the harness README run order'),
  fixture('conversions-ui', 'tests/conversions-ui/browser.mjs'),
  fixture('conversions-ui', 'tests/conversions-ui/editor.mjs', 'reuses the browser.mjs fixture'),

  evidence('tests/ai-content-coverage-browser.mjs', ['TEN98_CONTENT_COVERAGE_BROWSER'], ['TEN98_CONTENT_COVERAGE_BROWSER_APPROVAL'], 'needs ROOT-approved c1-browser-native-source-v1 approval and causal source captures'),
  evidence('tests/ai-content-support-browser.mjs', ['TEN98_CONTENT_SUPPORT_BROWSER'], ['TEN98_CONTENT_SUPPORT_BROWSER_APPROVAL'], 'needs an owner-approved approval file for the unapplied candidate'),
  evidence('tests/ai-project-content-coverage-browser.mjs', ['TEN98_PROJECT_CONTENT_BROWSER'], ['TEN98_PROJECT_CONTENT_BROWSER_APPROVAL'], 'needs ROOT approval of the immutable source and native causal captures'),
  evidence('tests/ai-search-browser.mjs', ['TEN98_AI_SEARCH_BROWSER'], ['TEN98_AI_QUERY_DTOS', 'TEN98_AI_CAPTURE_DTOS', 'TEN98_AI_BOUNDARY_DTOS', 'TEN98_AI_UI_SUPPLEMENT'],
    'needs root-captured SQL DTOs and UI supplement; the suite forbids fabricated DTOs'),
  evidence('tests/attribution-browser.mjs', ['TEN98_ATTRIBUTION_BROWSER'], ['TEN98_ATTRIBUTION_SQL_DTOS'], 'needs unchanged actual attribution SQL DTO capture'),
  evidence('tests/google-inspection-browser.mjs', ['TEN98_GOOGLE_INSPECTION_BROWSER'], ['TEN98_GOOGLE_INSPECTION_DTOS'], 'needs unchanged captured native inspection responses'),
  evidence('tests/retention-report-browser.mjs', ['TEN98_RETENTION_BROWSER'], ['TEN98_RETENTION_REPORT_DTOS'], 'needs retained SQL DTOs from a synthetic-database retention capture'),
  evidence('tests/revenue-browser.mjs', ['TEN98_REVENUE_BROWSER'], ['TEN98_REVENUE_SQL_DTOS', 'TEN98_REVENUE_COMPARISON_DTOS', 'TEN98_REVENUE_EDGE_DTOS'],
    'needs unchanged revenue SQL report, comparison and 4 edge DTO captures'),
  {suite: 'tests/account-preferences-http-browser.ts', class: 'evidence-gated', flags: ['TEN98_ACCOUNT_PREFERENCES_HTTP_BROWSER'],
    blocked: 'needs a separately approved outer harness: app 127.0.0.1:3111 with ANALYTICS_NETWORK_MODE=off (native-browser forces direct)'},
  {suite: 'tests/advanced-filters-production-browser.mjs', class: 'evidence-gated', flags: ['TEN98_ADVANCED_PRODUCTION_BROWSER'],
    blocked: 'asserts explorer-browser ran once on the same installation; the runner gives every suite a fresh one (needs its own seed)'},
];

const listing = (root: string, dir: string) => readdirSync(join(root, dir), {withFileTypes: true}).filter(entry => entry.isFile()).map(entry => entry.name);

/** Every browser suite on disk, as repository-relative paths. Fixtures, unit tests and harness helper modules are excluded. */
export function discoverBrowserSuites(root: string): string[] {
  const top = listing(root, 'tests').filter(name => /-browser/.test(name) && /\.(mjs|ts)$/.test(name) && !/\.test\.ts$/.test(name)).map(name => 'tests/' + name);
  // Harness directories: a runnable module imports Playwright (directly or via ./browser.mjs) and exports nothing.
  const harness = ['research-ui', 'conversions-ui'].flatMap(dir => listing(root, 'tests/' + dir).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).filter(name => {
    const source = readFileSync(join(root, 'tests', dir, name), 'utf8');
    return !/^export /m.test(source) && /helpers\/playwright\.mjs'|from '\.\/browser\.mjs'/.test(source);
  }).map(name => `tests/${dir}/${name}`));
  return [...top, ...harness].sort();
}

/** How the sweep stops a suite on timeout or shutdown: SIGTERM the process group, then SIGKILL it after a grace period long enough
 *  for tests/helpers/native-browser.mjs to stop its server and DROP its throwaway database in `finally`. */
export function stopSequence(route: Pick<SuiteRoute, 'harness'>): {signal: 'SIGTERM' | 'SIGKILL'; afterMs: number}[] {
  return [{signal: 'SIGTERM', afterMs: 0}, {signal: 'SIGKILL', afterMs: route.harness === 'native-browser' ? 20_000 : 5_000}];
}

export const signalExitCode = (signal: 'SIGINT' | 'SIGTERM') => signal === 'SIGINT' ? 130 : 143;
