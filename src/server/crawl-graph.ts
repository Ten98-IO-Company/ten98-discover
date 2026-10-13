import type {CrawlAnalysis, CrawlFacts, CrawlPageInput} from './crawl-analysis.ts';

export const crawlGraphRuleVersion = 'static-graph-v1';
export const crawlGraphLimits = Object.freeze({pages: 10_000, links: 100_000, findings: 10_000});
export type GraphFacts = Pick<CrawlFacts, 'titleLength' | 'titleHash' | 'descriptionLength' | 'descriptionHash' |
  'wordCount' | 'contentHash' | 'indexability' | 'canonical' | 'unresolvedLinks'>;
export type GraphPage = Pick<CrawlPageInput, 'status' | 'fetchState'> & {
  id: string;
  analysis: Pick<CrawlAnalysis, 'ruleVersion' | 'coverage'> & {facts: GraphFacts | null};
  sitemapOnly: boolean;
  redirect: {kind: 'page'; targetId: string} | {kind: 'outside_scope'} | {kind: 'unresolved'} | null;
};
export type CrawlGraphInput = {
  startPageId: string;
  pages: readonly GraphPage[];
  links: readonly {sourceId: string; targetId: string}[];
  coverage: {runComplete: boolean; discoveryComplete: boolean; linksComplete: boolean; dataState: 'available' | 'expired'};
};
export type GraphCode = 'duplicate-title' | 'duplicate-meta-description' | 'duplicate-content' |
  'redirect-chain' | 'redirect-loop' | 'broken-internal-link' | 'orphan-page';
export type GraphFinding = {
  key: string; code: GraphCode; severity: 'critical' | 'warning'; pageId: string; targetPageId: string | null;
  relatedPageIds: string[]; details: Record<string, number>;
};
type CheckCoverage = 'complete' | 'partial' | 'unavailable';
export type CrawlGraphResult = {
  ruleVersion: typeof crawlGraphRuleVersion;
  status: CheckCoverage; reasons: string[];
  checks: {duplicates: CheckCoverage; redirects: CheckCoverage; brokenLinks: CheckCoverage; orphans: 'complete' | 'unavailable'};
  counts: {pages: number; links: number; duplicateEligiblePages: number; observedErrorTargets: number; findings: number};
  findings: GraphFinding[]; findingsComplete: boolean;
};

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const ascii = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9_-]/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_048_576;
const hash = (value: unknown) => typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/u.test(value);

function validFacts(value: unknown): value is GraphFacts {
  if (!record(value) || !count(value.unresolvedLinks) ||
    !['noindex_observed', 'no_noindex_observed', 'unknown'].includes(value.indexability as string) ||
    !['none', 'self', 'other', 'conflict', 'invalid'].includes(value.canonical as string)) return false;
  for (const [lengthKey, hashKey] of [['titleLength', 'titleHash'], ['descriptionLength', 'descriptionHash'], ['wordCount', 'contentHash']]) {
    if (!count(value[lengthKey]) || (value[lengthKey] === 0 ? value[hashKey] !== null : !hash(value[hashKey]))) return false;
  }
  return true;
}

function validPage(value: unknown): value is GraphPage {
  if (!record(value) || !id(value.id) || typeof value.sitemapOnly !== 'boolean' || !record(value.analysis) ||
    value.analysis.ruleVersion !== 'static-html-v1' ||
    !['ok', 'blocked', 'rate_limited', 'error', 'robots_disallowed', 'not_fetched'].includes(value.fetchState as string) ||
    value.status !== null && (!Number.isInteger(value.status) || (value.status as number) < 200 || (value.status as number) > 599)) return false;
  const {coverage, facts} = value.analysis;
  if (coverage === 'analyzed' || coverage === 'shell') {
    if (!validFacts(facts) || coverage === 'analyzed' && facts.indexability === 'unknown') return false;
  } else if (facts !== null) return false;
  if (value.fetchState !== 'ok') {
    if (coverage !== (value.fetchState === 'error' ? 'unavailable' : value.fetchState)) return false;
  } else if (value.status === null) {
    if (coverage !== 'unavailable') return false;
  } else {
    const status = value.status as number;
    if (status === 429 ? coverage !== 'rate_limited' : status >= 400 ? coverage !== 'http_error' :
      status >= 300 ? coverage !== (redirectStatuses.has(status) ? 'redirect' : 'unavailable') :
      status === 204 || status === 205 ? coverage !== 'non_html' : status === 206 ? coverage !== 'partial' :
      !['analyzed', 'shell', 'partial', 'non_html', 'unavailable'].includes(coverage as string)) return false;
  }
  if (coverage !== 'redirect') return value.redirect === null;
  return record(value.redirect) && (value.redirect.kind === 'page' ? id(value.redirect.targetId) :
    value.redirect.kind === 'outside_scope' || value.redirect.kind === 'unresolved');
}

function invalid(reason: string): CrawlGraphResult {
  return {ruleVersion: crawlGraphRuleVersion, status: 'unavailable', reasons: [reason],
    checks: {duplicates: 'unavailable', redirects: 'unavailable', brokenLinks: 'unavailable', orphans: 'unavailable'},
    counts: {pages: 0, links: 0, duplicateEligiblePages: 0, observedErrorTargets: 0, findings: 0},
    findings: [], findingsComplete: false};
}

const candidate = (page: GraphPage) => page.analysis.coverage === 'analyzed' &&
  page.analysis.facts!.indexability === 'no_noindex_observed' && ['none', 'self'].includes(page.analysis.facts!.canonical);
const broken = (page: GraphPage) => page.analysis.coverage === 'http_error' && ![401, 403, 407, 429].includes(page.status!);
type RedirectResult = {kind: 'terminal'; hops: number; terminalObserved: number} |
  {kind: 'cycle'; cycleId: string; cycleLength: number; prefixHops: number};

/** Pure, ID-only analysis of one caller-authorized exact-origin run. Completeness is never inferred. */
export function analyzeCrawlGraph(input: CrawlGraphInput): CrawlGraphResult {
  if (!record(input) || !Array.isArray(input.pages) || !Array.isArray(input.links) || !record(input.coverage) ||
    !id(input.startPageId) || ['runComplete', 'discoveryComplete', 'linksComplete'].some(key => typeof input.coverage[key as keyof typeof input.coverage] !== 'boolean') ||
    !['available', 'expired'].includes(input.coverage.dataState)) return invalid('invalid_input');
  if (input.pages.length > crawlGraphLimits.pages || input.links.length > crawlGraphLimits.links) return invalid('input_limit');
  if (input.coverage.dataState === 'expired') return invalid('data_expired');
  const pages = new Map<string, GraphPage>();
  for (const page of input.pages) {
    if (!validPage(page) || pages.has(page.id)) return invalid('invalid_input');
    pages.set(page.id, page);
  }
  if (!pages.has(input.startPageId)) return invalid('invalid_input');
  const links = new Map<string, Set<string>>(), inbound = new Set<string>(), redirectTargets = new Set<string>();
  for (const page of pages.values()) if (page.redirect?.kind === 'page') {
    if (!pages.has(page.redirect.targetId)) return invalid('invalid_input');
    redirectTargets.add(page.redirect.targetId);
  }
  let linkCount = 0;
  for (const edge of input.links) {
    if (!record(edge) || !id(edge.sourceId) || !id(edge.targetId) || !pages.has(edge.targetId) ||
      pages.get(edge.sourceId)?.analysis.coverage !== 'analyzed') return invalid('invalid_input');
    let targets = links.get(edge.sourceId);
    if (!targets) links.set(edge.sourceId, targets = new Set());
    if (!targets.has(edge.targetId)) { targets.add(edge.targetId); linkCount++; }
    if (edge.sourceId !== edge.targetId) inbound.add(edge.targetId);
  }
  const ordered = [...pages.keys()].sort(ascii), eligible = ordered.filter(key => candidate(pages.get(key)!));
  const reasons: string[] = [];
  if (!input.coverage.runComplete) reasons.push('run_incomplete');
  if (!input.coverage.discoveryComplete) reasons.push('discovery_incomplete');
  if (!input.coverage.linksComplete) reasons.push('links_incomplete');
  if (ordered.some(key => !['analyzed', 'redirect', 'non_html'].includes(pages.get(key)!.analysis.coverage))) reasons.push('page_coverage_incomplete');
  if (ordered.some(key => (pages.get(key)!.analysis.facts?.unresolvedLinks ?? 0) > 0)) reasons.push('unresolved_links');
  if (ordered.some(key => pages.get(key)!.redirect?.kind === 'unresolved')) reasons.push('unresolved_redirect');
  const complete = reasons.length === 0;
  const usable = ordered.some(key => ['analyzed', 'redirect', 'non_html', 'http_error'].includes(pages.get(key)!.analysis.coverage));
  const coverage = complete ? 'complete' : usable ? 'partial' : 'unavailable';
  const out: CrawlGraphResult = {ruleVersion: crawlGraphRuleVersion, status: coverage, reasons,
    checks: {duplicates: coverage, redirects: coverage, brokenLinks: coverage, orphans: complete ? 'complete' : 'unavailable'},
    counts: {pages: pages.size, links: linkCount, duplicateEligiblePages: eligible.length,
      observedErrorTargets: ordered.filter(key => broken(pages.get(key)!)).length, findings: 0},
    findings: [], findingsComplete: usable || complete};
  function emit(code: GraphCode, pageId: string, targetPageId: string | null, relatedPageIds: string[], details: Record<string, number>) {
    out.counts.findings++;
    // ponytail: retain 10k records but count every finding; stream deterministic batches if storage needs more.
    if (out.findings.length < crawlGraphLimits.findings) out.findings.push({
      key: `${crawlGraphRuleVersion}:${code}:${pageId}:${targetPageId ?? ''}`, code,
      severity: code === 'broken-internal-link' ? 'critical' : 'warning', pageId, targetPageId, relatedPageIds, details,
    });
  }

  for (const [code, field] of [['duplicate-title', 'titleHash'], ['duplicate-meta-description', 'descriptionHash'], ['duplicate-content', 'contentHash']] as const) {
    const groups = new Map<string, string[]>();
    for (const key of eligible) {
      const value = pages.get(key)!.analysis.facts![field];
      if (value) { const group = groups.get(value); if (group) group.push(key); else groups.set(value, [key]); }
    }
    for (const key of eligible) {
      const group = groups.get(pages.get(key)!.analysis.facts![field] ?? '');
      if (group && group.length > 1) emit(code, key, null, group.slice(0, 4).filter(other => other !== key).slice(0, 3), {groupSize: group.length});
    }
  }

  const redirects = ordered.filter(key => pages.get(key)!.analysis.coverage === 'redirect');
  const memo = new Map<string, RedirectResult>(), cycles = new Set<string>();
  const next = (key: string): string | null => {
    const target = pages.get(key)!.redirect;
    return target?.kind === 'page' && pages.get(target.targetId)!.analysis.coverage === 'redirect' ? target.targetId : null;
  };
  // Functional graph: classify each redirect once, iteratively; shared tails are not cycles.
  for (const start of redirects) {
    if (memo.has(start)) continue;
    const path: string[] = [], positions = new Map<string, number>();
    let current: string | null = start, tail: RedirectResult | undefined;
    while (current !== null && !memo.has(current) && !positions.has(current)) {
      positions.set(current, path.length); path.push(current);
      const successor = next(current);
      if (successor === null) {
        const redirect = pages.get(current)!.redirect!;
        const target = redirect.kind === 'page' ? pages.get(redirect.targetId)! : null;
        tail = {kind: 'terminal', hops: 0, terminalObserved: target?.fetchState === 'ok' && target.status !== null ? 1 : 0};
      }
      current = successor;
    }
    if (current !== null && positions.has(current)) {
      const cycleStart = positions.get(current)!, cycle = path.slice(cycleStart);
      const cycleId = cycle.reduce((a, b) => ascii(a, b) < 0 ? a : b);
      tail = {kind: 'cycle', cycleId, cycleLength: cycle.length, prefixHops: 0};
      cycles.add(cycleId);
      for (const key of cycle) memo.set(key, tail);
      path.length = cycleStart;
    } else if (current !== null) tail = memo.get(current)!;
    for (let i = path.length - 1; i >= 0; i--) {
      tail = tail!.kind === 'terminal' ? {...tail!, hops: tail!.hops + 1} : {...tail!, prefixHops: tail!.prefixHops + 1};
      memo.set(path[i], tail);
    }
  }
  function pathSample(start: string): string[] {
    const sample: string[] = [], seen = new Set<string>();
    let current: string | null = start;
    while (current !== null && sample.length < 8 && !seen.has(current)) {
      sample.push(current); seen.add(current);
      const redirect: GraphPage['redirect'] = pages.get(current)!.redirect;
      current = redirect?.kind === 'page' ? redirect.targetId : null;
    }
    return sample;
  }
  const heads = redirects.filter(key => !redirectTargets.has(key));
  for (const key of heads) {
    const result = memo.get(key)!;
    if (result.kind === 'terminal' && result.hops >= 2) emit('redirect-chain', key, null, pathSample(key),
      {observedHops: result.hops, terminalObserved: result.terminalObserved});
  }
  const loopHeads: string[] = [], reachedCycles = new Set<string>();
  for (const key of heads) {
    const result = memo.get(key)!;
    if (result.kind === 'cycle') { loopHeads.push(key); reachedCycles.add(result.cycleId); }
  }
  for (const cycle of cycles) if (!reachedCycles.has(cycle)) loopHeads.push(cycle);
  for (const key of loopHeads.sort(ascii)) {
    const result = memo.get(key)!;
    if (result.kind === 'cycle') emit('redirect-loop', key, null, pathSample(key), {cycleLength: result.cycleLength, prefixHops: result.prefixHops});
  }
  for (const source of ordered) for (const target of [...(links.get(source) ?? [])].sort(ascii)) {
    const page = pages.get(target)!;
    if (broken(page)) emit('broken-internal-link', source, target, [], {targetStatus: page.status!});
  }
  if (complete) for (const key of eligible) if (key !== input.startPageId && pages.get(key)!.sitemapOnly && !inbound.has(key) && !redirectTargets.has(key)) {
    emit('orphan-page', key, null, [], {});
  }
  if (out.counts.findings > out.findings.length) {
    out.findingsComplete = false; out.reasons.push('findings_limit'); out.status = 'partial';
  }
  return out;
}
