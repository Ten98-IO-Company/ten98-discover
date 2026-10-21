// Deterministic SYNTHETIC API bodies for tests/openrouter-models-browser.mjs.
// Shapes follow the strict response validators in src/components (OpenRouterModelPicker, PromptExecutionsPanel,
// AIInsightsPanel, AIComparisonPanel, AiSuggestionsPanel); assertModelsCaptures() re-checks the catalog and quote
// reservations with the real src parsers. No customer, provider or captured data; every id and text is invented.
import assert from 'node:assert/strict';

const id = n => 'f0b00000-0000-4000-8000-' + String(n).padStart(12, '0');
const hex = char => char.repeat(64);
const cellId = n => n.toString(16).padStart(64, '0');
const AT = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-10-15T12:10:00.000Z';
const PROVIDER = 'Synthetic Compute', TAG = 'synthetic-compute', PROFILE = 'openrouter-api-text-no-search-v2';
const PRICES = { prompt: '0.0000001', completion: '0.0000004', request: '0' };
const MODEL = 'fixture/text-primary', OTHER_MODEL = 'fixture/text-secondary', OUTSIDE_MODEL = 'fixture/outside-observed';
const MATCHER = 'unicode-boundary-v1', ZONE = 'UTC';
const KINDS = ['eligible', 'queued', 'running', 'no_answer', 'empty', 'truncated', 'content_filtered', 'expired', 'invalid'];

// Same ceil-to-microdollar reservation arithmetic as validModelReservation.
function estimateMicros(output, promptCapacity = 1000) {
  const parts = [[PRICES.prompt, promptCapacity], [PRICES.completion, output], [PRICES.request, 1]].map(([price, count]) => ({ coefficient: BigInt(price.replace('.', '')), scale: price.split('.')[1]?.length ?? 0, count: BigInt(count) }));
  const scale = Math.max(6, ...parts.map(part => part.scale)), divisor = 10n ** BigInt(scale - 6);
  return (parts.reduce((sum, part) => sum + part.coefficient * part.count * 10n ** BigInt(scale - part.scale), 0n) + divisor - 1n) / divisor;
}
const usd = micros => (micros / 1000000n) + '.' + String(micros % 1000000n).padStart(6, '0');
const route = (model, output) => ({ model, tag: TAG, providerName: PROVIDER, profile: PROFILE, contextLength: 128000, promptCapacity: 1000, completionCapacity: 8192, promptPrice: PRICES.prompt, completionPrice: PRICES.completion, requestPrice: PRICES.request, estimateUsd: usd(estimateMicros(output)) });
const total = routes => usd(routes.reduce((sum, r) => sum + BigInt(r.estimateUsd.replace('.', '')), 0n));

const catalogRow = (slug, name, extra = {}) => ({ id: slug, canonicalSlug: slug, name, contextLength: 128000, maxCompletionTokens: 8192, promptPrice: PRICES.prompt, completionPrice: PRICES.completion, requestPrice: PRICES.request, structuredOutput: true, expirationDate: null, admission: 'candidate', reason: null, ...extra });
const catalog = () => ({ version: 'openrouter-text-catalog-v1', status: 'fresh', fetchedAt: AT, revision: hex('a'), complete: true, models: [
  catalogRow(MODEL, 'Synthetic primary text model'), catalogRow(OTHER_MODEL, 'Synthetic secondary text model'),
  catalogRow('fixture/text-retired', 'Synthetic retired model', { admission: 'unsupported', reason: 'Explicit synthetic unsupported reason.' })] });

function quote({ n, role, models, scope, promptId, versionId, connectionId, authored, system, output }) {
  const routes = models.map(model => route(model, output));
  return { role, quote: { id: id(n), createdAt: AT, expiresAt: EXPIRES, input: { connectionId, promptId, versionId, systemText: system, models, maxCompletionTokens: output, fundedCredits: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: authored }], connectionName: 'Synthetic OpenRouter connection', routes, estimateUsd: total(routes), explanation: 'Synthetic reservation for ' + scope + '.', cacheReused: false } };
}
function comparison({ n, role, q, state }) {
  const done = state === 'completed', input = q.quote.input;
  const runs = q.quote.routes.map((r, i) => ({ id: id(n * 100 + i + 1), model: r.model, provider: r.providerName, status: done ? 'completed' : 'queued', chargeStatus: done ? 'settled' : 'reserved', estimateUsd: r.estimateUsd, actualUsd: done ? '0.000013' : null, dispatchedAt: done ? AT : null, completedAt: done ? AT : null, diagnostic: null, resultExpired: false,
    result: done ? { text: 'Synthetic answer ' + (i + 1), resolvedModel: r.model, provider: r.providerName, finishReason: 'stop', promptTokens: 10, completionTokens: 3, receivedAt: AT, citations: [] } : null,
    reportedCost: done ? '0.000013' : null, isByok: done ? false : null, upstreamReportedCost: null, generationId: done ? 'gen-synthetic-' + (i + 1) : null }));
  return { role, comparison: { id: id(n), quoteId: q.quote.id, createdAt: AT, cancelRequested: false, prompt: { id: input.promptId, versionId: input.versionId, textPreview: q.quote.messages.at(-1).content }, canCancel: !done, runs, input, messages: q.quote.messages, inputExpired: false, cache: { reused: false, available: false }, answerMode: 'individual' } };
}
const RUN_SUMMARY_KEYS = ['id', 'model', 'provider', 'status', 'chargeStatus', 'estimateUsd', 'actualUsd', 'dispatchedAt', 'completedAt', 'diagnostic', 'resultExpired'];
const summaryOf = detail => ({ ...Object.fromEntries(Object.entries(detail.comparison).filter(([key]) => !['input', 'messages', 'inputExpired', 'cache', 'answerMode'].includes(key))), runs: detail.comparison.runs.map(run => Object.fromEntries(RUN_SUMMARY_KEYS.map(key => [key, run[key]]))) });
function metadata({ role, connectionId, comparisons = [] }) {
  const value = catalog();
  return { role, models: value.models.filter(m => m.admission === 'candidate').map(m => m.id), catalog: value, vaultConfigured: true, spendingPaused: false, connections: [{ id: connectionId, name: 'Synthetic OpenRouter connection', checkStatus: 'ok' }], comparisons, cache: { available: false }, scheduling: { available: false } };
}

// ---- Prompt insights (AIInsightsPanel report) -------------------------------------------------
const subjects = [{ id: 'brand', name: 'Fixture Brand', aliases: ['Fixture'], domains: ['brand.example'] }, { id: id(900), name: 'Fixture Competitor', aliases: [], domains: ['competitor.example'] }];
const coverageOf = rows => { const result = Object.fromEntries(['attempted', ...KINDS].map(k => [k, 0])); for (const row of rows) { result.attempted++; result[row.eligibility]++; } return result; };
const metricsOf = rows => {
  const eligible = rows.filter(r => r.eligibility === 'eligible');
  const counts = subjects.map((s, i) => ({ id: s.id, mentions: eligible.filter(r => r.matches[i].mentioned).length, citations: eligible.filter(r => r.matches[i].cited).length }));
  const denominator = counts.reduce((n, m) => n + m.mentions, 0) || null;
  return counts.map(m => ({ ...m, eligibleAnswers: eligible.length || null, citationDenominator: eligible.length || null, shareOfVoiceDenominator: denominator }));
};
function insightRows({ count, model, promptId, from, base }) {
  return Array.from({ length: count }, (_unused, n) => {
    const mentioned = n % 2 === 0, cited = n === 0, date = from;
    return { id: id(base + n), comparisonId: id(base + 500 + n), promptId, versionId: id(base + 700 + n), requestedAt: date + 'T12:00:00.000Z', date, model, resolvedModel: model, status: 'completed', eligibility: 'eligible',
      matches: subjects.map((s, i) => ({ id: s.id, mentioned: i === 0 && mentioned, matchedTerm: i === 0 && mentioned ? s.name : null, cited: i === 0 && cited, citationIndexes: i === 0 && cited ? [0] : [] })) };
  });
}
function insights({ role, from, to, model = null, promptId = null, rows, modelOptions }) {
  const days = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  return { role, modelOptions, filters: { from, to, timeZone: ZONE, model, promptId, tag: null, matcher: MATCHER }, drilldown: { entityId: null, outcome: 'all' }, asOf: to + 'T23:59:59.000Z', contextRevision: 1, profileHash: hex('b'), matcherVersion: MATCHER, selectionRevision: hex('a'),
    label: 'Recomputed from retained answers using current project context', warnings: [], subjects, coverage: coverageOf(rows), metrics: metricsOf(rows),
    daily: days.map(date => { const day = rows.filter(r => r.date === date); return { date, coverage: coverageOf(day), metrics: metricsOf(day) }; }),
    evidenceStates: rows.map(({ id: rowId, eligibility }) => ({ id: rowId, eligibility })), executions: rows, totalRows: rows.length, nextCursor: null };
}
const promptPage = (role, items) => ({ role, items: items.map(([promptId, text]) => ({ id: promptId, text, enabled: true, archivedAt: null })), nextCursor: null });

// ---- Adjacent-period comparison (AIComparisonPanel report) -----------------------------------
const fraction = (n, d) => { if (!d) return null; const a = BigInt(n), b = BigInt(d); let x = a, y = b; while (y) [x, y] = [y, x % y]; return { numerator: String(a / x), denominator: String(b / x) }; };
const minus = (a, b) => a && b ? fraction(BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator)) : null;
function comparisonReport(filters) {
  const all = filters.cohort === 'all', span = (Date.parse(filters.to) - Date.parse(filters.from)) / 86400000 + 1, day = t => new Date(t).toISOString().slice(0, 10);
  const previousFrom = day(Date.parse(filters.from) - span * 86400000), previousTo = day(Date.parse(filters.from) - 86400000);
  const specs = [{ mentions: [1, 0], cited: [1, 0] }, { mentions: [0, 1], cited: [0, 0] }].slice(0, all ? 2 : 1);
  const executions = [], cells = [];
  specs.forEach((spec, k) => {
    const cell = { id: cellId(k + 1), promptId: id(1100 + k), versionId: id(1200 + k), promptPreview: 'Synthetic neutral prompt ' + (k + 1), model: MODEL, provider: PROVIDER, maxCompletionTokens: 1024, status: 'matched' };
    ['current', 'previous'].forEach((side, s) => {
      const mentioned = spec.mentions[s] === 1, cited = spec.cited[s] === 1, date = side === 'current' ? filters.to : previousTo;
      executions.push({ id: id(1300 + k * 2 + s), comparisonId: id(1400 + k * 2 + s), promptId: cell.promptId, versionId: cell.versionId, requestedAt: date + 'T12:00:00.000Z', date, model: MODEL, resolvedModel: MODEL, status: 'completed', eligibility: 'eligible',
        matches: subjects.map((sub, i) => ({ id: sub.id, mentioned: i === 0 && mentioned, matchedTerm: i === 0 && mentioned ? sub.name : null, cited: i === 0 && cited, citationIndexes: i === 0 && cited ? [0] : [] })), period: side, cellId: cell.id, identity: 'available', usable: true });
      cell[side] = { attempted: 1, usable: 1, metrics: subjects.map((_sub, i) => ({ id: subjects[i].id, mentions: i === 0 && mentioned ? 1 : 0, citations: i === 0 && cited ? 1 : 0 })) };
    });
    cells.push(cell);
  });
  const periods = {};
  for (const side of ['current', 'previous']) {
    const rows = executions.filter(e => e.period === side);
    periods[side] = { from: side === 'current' ? filters.from : previousFrom, to: side === 'current' ? filters.to : previousTo, coverage: coverageOf(rows), usable: rows.length, identityUnavailable: 0, identityInvalid: 0, excludedByCohort: all ? 0 : 1, cells: cells.length, matchedCells: cells.length, matchedExecutions: cells.length };
  }
  const mean = (side, index, kind) => fraction(cells.reduce((n, c) => n + c[side].metrics[index][kind] * 2, 0), 2 * cells.length);
  const metrics = subjects.map((sub, i) => { const current = mean('current', i, 'mentions'), previous = mean('previous', i, 'mentions'), citationsCurrent = mean('current', i, 'citations'), citationsPrevious = mean('previous', i, 'citations');
    return { id: sub.id, current, previous, delta: minus(current, previous), citationsCurrent, citationsPrevious, citationsDelta: minus(citationsCurrent, citationsPrevious) }; });
  return { role: 'owner', filters, asOf: '2026-10-16T00:00:00.000Z', contextRevision: 1, profileHash: hex('b'), matcherVersion: filters.matcher, selectionRevision: hex('a'), formulaVersion: 'current-context-equal-cell-v1', eligibilityVersion: 'retained-nonempty-stop-v1', classifierVersion: 'elmo-substring-current-overrides-v1',
    label: 'Adjacent local-day comparison recomputed using current project context', warnings: [], subjects, periodOpen: false, status: 'comparable', ...periods, cellCount: cells.length, headlineBasis: 'matched_cells', metrics,
    evidenceStates: executions.map(({ id: rowId, period, eligibility, identity }) => ({ id: rowId, period, eligibility, identity })), navigation: { view: 'cells', period: null, cellId: null, outcome: 'all', entityId: null }, page: { kind: 'cells', rows: cells }, totalRows: cells.length, nextCursor: null };
}

// ---- Evaluation suggestions (AiSuggestionsPanel) ---------------------------------------------
function suggestions({ projectId, workspaceId, ownerId }) {
  const contextProject = { id: projectId, name: 'Synthetic suggestion project', origin: 'https://suggestions.example.test' };
  const profile = { name: 'Fixture Brand', aliases: ['Fixture'], citationDomains: ['brand.example'] };
  const connectionId = id(2301), contextRevision = 1, evidenceId = 'profile-1';
  const base = role => ({ role, profiles: [{ id: 'catalog-text-schema-v1', model: null, label: 'Dynamic catalog structured text', admission: 'benchmark' }], defaults: { economy: null, balanced: null }, canQuote: role === 'owner', runs: [], nextCursor: null });
  const input = { requestId: id(2310), connectionId, contextRevision, profileId: 'catalog-text-schema-v1', model: MODEL, benchmark: true, fundedCredits: true, topic: 'Synthetic topic', country: 'Synthetic country', language: 'English', sectionKeys: [], competitorIds: [], excludedPrompts: [] };
  const snapshot = { project: contextProject, contextRevision, profile, sections: [], competitors: [], topic: input.topic, country: input.country, language: input.language, existingPrompts: [], excludedPrompts: [], evidence: [{ id: evidenceId, kind: 'profile', sha256: hex('c'), value: profile }], topicLibraryHash: hex('d'), snapshotHash: hex('e') };
  const r = route(MODEL, 2048), runBase = { id: id(2330), quoteId: id(2320), model: MODEL, provider: PROVIDER, estimateUsd: r.estimateUsd, createdAt: AT, proposalRevision: 1, acceptedCandidateIds: [], inputExpired: false, resultExpired: false, diagnostic: null, canReconcile: false, snapshot, generationId: null };
  const started = { ...runBase, status: 'queued', chargeStatus: 'reserved', actualUsd: null, dispatchedAt: null, completedAt: null, proposalStatus: 'unavailable', canCancel: true, proposal: null, acceptance: null };
  const completed = { ...runBase, status: 'completed', chargeStatus: 'settled', actualUsd: '0.000013', dispatchedAt: AT, completedAt: AT, proposalStatus: 'available', canCancel: false, generationId: 'gen-synthetic-suggestion',
    proposal: { limitation: 'none', prompts: [{ id: id(2340), text: 'Which synthetic tool fits a small team?', tags: ['synthetic'], rationale: 'Grounded in the invented profile.', evidenceIds: [evidenceId] }] }, acceptance: { proposalRevision: 1, contextRevision, topicLibraryHash: snapshot.topicLibraryHash } };
  return {
    scope: { projectId, workspaceId, userId: ownerId },
    initial: base('owner'), roleInitial: { admin: base('admin'), editor: base('editor'), viewer: base('viewer') },
    context: { project: contextProject, role: 'owner', revision: contextRevision, profile, sections: [], competitors: [] },
    providers: { vaultConfigured: true, connections: [{ id: connectionId, name: 'Synthetic OpenRouter connection', provider: 'openrouter', checkStatus: 'ok' }], budget: { paused: false } },
    catalog: { role: 'owner', catalog: catalog() },
    quote: { role: 'owner', quote: { id: runBase.quoteId, requestId: input.requestId, inputHash: hex('f'), snapshotHash: snapshot.snapshotHash, createdAt: AT, expiresAt: EXPIRES, input, snapshot, inputExpired: false, route: r, estimateUsd: r.estimateUsd }, acknowledgement: { requestId: input.requestId, quoteId: runBase.quoteId, inputHash: hex('f') } },
    started: { role: 'owner', run: started, acknowledgement: { requestId: id(2311), quoteId: runBase.quoteId, operation: 'start', runId: runBase.id } },
    completed: { role: 'owner', run: completed } };
}

export function buildModelsCaptures() {
  const S = { project: id(1), workspace: id(2), users: { owner: id(3), admin: id(4), editor: id(5), viewer: id(6) }, model: MODEL, otherModel: OTHER_MODEL };
  const connectionId = id(7), promptId = id(8), versionId = id(9);
  const range = { from: '2026-10-09', to: '2026-10-15' };
  const mainRows = insightRows({ count: 3, model: MODEL, promptId, from: '2026-10-12', base: 2000 });
  const mainOptions = { values: [MODEL, OTHER_MODEL], complete: true };
  const historyOptions = { values: [OTHER_MODEL, MODEL], complete: true };

  const base = { connectionId, promptId, versionId, authored: 'Synthetic authored prompt for model comparison.', system: 'Synthetic system message.', output: 64 };
  const single = quote({ ...base, n: 30, role: 'editor', models: [MODEL], scope: 'one model' });
  const both = quote({ ...base, n: 31, role: 'owner', models: [MODEL, OTHER_MODEL], scope: 'two models' });
  const pairedScope = { projectId: id(40), workspaceId: id(41), userId: id(42) };
  const paired = quote({ ...base, n: 43, role: 'owner', models: [MODEL, OTHER_MODEL], scope: 'paired models' });
  const pairedStarted = comparison({ n: 44, role: 'owner', q: paired, state: 'queued' }), pairedCompleted = comparison({ n: 44, role: 'owner', q: paired, state: 'completed' });
  const started = comparison({ n: 32, role: 'editor', q: single, state: 'queued' });

  const many = { projectId: id(50), workspaceId: id(51), userId: id(52), promptId: id(53) };
  const manyFilters = { ...range, timeZone: ZONE, model: null, promptId: null, tag: null, matcher: MATCHER };
  const observed = Array.from({ length: 1000 }, (_unused, n) => 'fixture/observed-' + String(n).padStart(4, '0'));
  const incompleteFilters = { from: '2026-10-12', to: '2026-10-14', timeZone: ZONE, model: OUTSIDE_MODEL, promptId: null, tag: null, matcher: MATCHER };
  const incompleteRows = insightRows({ count: 1, model: OUTSIDE_MODEL, promptId: many.promptId, from: '2026-10-13', base: 3000 });
  const suggestion = suggestions({ projectId: id(60), workspaceId: id(61), ownerId: id(62) });
  const comparisonFilters = { ...manyFilters, cohort: 'all' };

  const captures = {
    uiClock: AT,
    catalogOwner: { role: 'owner', catalog: catalog() },
    quote: single, quoteTwoModels: both, started,
    executionsInitialEditor: metadata({ role: 'editor', connectionId }), executionsInitial: metadata({ role: 'owner', connectionId }),
    pairedScope: { project: pairedScope.projectId, workspace: pairedScope.workspaceId, user: pairedScope.userId },
    pairedMetadata: metadata({ role: 'owner', connectionId, comparisons: [summaryOf(pairedCompleted)] }), pairedQuote: paired, pairedStarted, pairedCompleted,
    mainViewerPrompts: promptPage('viewer', [[promptId, 'Synthetic prompt about model comparison']]), mainOwnerPrompts: promptPage('owner', [[promptId, 'Synthetic prompt about model comparison']]),
    mainViewerInitialInsights: insights({ role: 'viewer', ...range, rows: mainRows, modelOptions: mainOptions }),
    mainOwnerInitialInsights: insights({ role: 'owner', ...range, rows: mainRows, modelOptions: mainOptions }),
    insights: insights({ role: 'viewer', from: '2026-10-10', to: range.to, rows: insightRows({ count: 2, model: MODEL, promptId, from: '2026-10-12', base: 2100 }), modelOptions: mainOptions }),
    retiredHistory: insights({ role: 'owner', from: '2026-10-11', to: range.to, model: MODEL, rows: insightRows({ count: 2, model: MODEL, promptId, from: '2026-10-12', base: 2200 }), modelOptions: historyOptions }),
    comparison: comparisonReport(comparisonFilters), mainOwnerNeutralComparison: comparisonReport({ ...comparisonFilters, cohort: 'current-neutral' }),
    suggestionScope: { project: suggestion.scope.projectId, workspace: suggestion.scope.workspaceId, owner: suggestion.scope.userId },
    suggestionsInitial: suggestion.initial, 'suggestionsInitial-admin': suggestion.roleInitial.admin, 'suggestionsInitial-editor': suggestion.roleInitial.editor, 'suggestionsInitial-viewer': suggestion.roleInitial.viewer,
    suggestionContext: suggestion.context, suggestionProviders: suggestion.providers, suggestionCatalog: suggestion.catalog, suggestionQuote: suggestion.quote, suggestionStarted: suggestion.started, suggestionCompleted: suggestion.completed,
    manyScope: { project: many.projectId, workspace: many.workspaceId, user: many.userId, promptId: many.promptId },
    manyPromptsAfterSeed: promptPage('owner', [[many.promptId, 'Synthetic prompt with many observed models']]),
    manyDefaultRefusal: { error: 'Synthetic report is too large. Narrow the filters.' },
    manyPromptNarrowed: insights({ role: 'owner', ...range, promptId: many.promptId, rows: insightRows({ count: 1, model: MODEL, promptId: many.promptId, from: '2026-10-12', base: 3100 }), modelOptions: mainOptions }),
    optionsIncomplete: insights({ role: 'owner', from: incompleteFilters.from, to: incompleteFilters.to, model: OUTSIDE_MODEL, rows: incompleteRows, modelOptions: { values: observed, complete: false } }),
    optionsRecovered: insights({ role: 'owner', from: incompleteFilters.from, to: incompleteFilters.to, model: OUTSIDE_MODEL, promptId: many.promptId, rows: incompleteRows, modelOptions: { values: [OUTSIDE_MODEL], complete: true } }),
    retiredModel: OUTSIDE_MODEL };
  return { captures, scope: S };
}

// Re-checks the builder against the real src parsers, so a drifting contract fails here, not as a vague UI timeout.
export function assertModelsCaptures(C, { readModelCatalog, validModelReservation, validObservedModels }) {
  for (const catalogBody of [C.catalogOwner.catalog, C.pairedMetadata.catalog, C.suggestionCatalog.catalog]) assert.deepEqual(readModelCatalog(catalogBody), catalogBody);
  for (const q of [C.quote, C.quoteTwoModels, C.pairedQuote]) assert.ok(validModelReservation(q.quote.routes, q.quote.estimateUsd, q.quote.input.models, q.quote.input.maxCompletionTokens, 4), 'Synthetic quote reservation must satisfy the real validator.');
  const sq = C.suggestionQuote.quote;
  assert.ok(validModelReservation([sq.route], sq.estimateUsd, [sq.input.model], 2048));
  for (const report of [C.mainOwnerInitialInsights, C.insights, C.retiredHistory, C.manyPromptNarrowed, C.optionsIncomplete, C.optionsRecovered]) assert.ok(validObservedModels(report.modelOptions));
  assert.equal(C.optionsIncomplete.modelOptions.values.includes(C.retiredModel), false);
  assert.equal(C.optionsRecovered.modelOptions.values.length, 1);
}
