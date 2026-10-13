import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {analyzeCrawlPage} from '../src/server/crawl-analysis.ts';
import {analyzeCrawlGraph, crawlGraphLimits, type CrawlGraphInput, type GraphFacts, type GraphPage} from '../src/server/crawl-graph.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function page(id: string, facts: Partial<GraphFacts> = {}): GraphPage {
  return {id, status: 200, fetchState: 'ok', sitemapOnly: false, redirect: null,
    analysis: {ruleVersion: 'static-html-v1', coverage: 'analyzed', facts: {
      titleLength: 1, titleHash: digest(`title-${id}`), descriptionLength: 1, descriptionHash: digest(`description-${id}`),
      wordCount: 1, contentHash: digest(`body-${id}`), indexability: 'no_noindex_observed', canonical: 'none', unresolvedLinks: 0, ...facts,
    }}};
}
function observed(id: string, status: number | null, fetchState: GraphPage['fetchState'] = 'ok', coverage?: GraphPage['analysis']['coverage']): GraphPage {
  const analysis = analyzeCrawlPage({url: 'https://example.com/', status, fetchState, contentType: null, html: null,
    bodyComplete: false, responseTimeMs: null, crawlDepth: null});
  return {id, status, fetchState, sitemapOnly: false, redirect: null,
    analysis: {ruleVersion: analysis.ruleVersion, coverage: coverage ?? analysis.coverage, facts: null}};
}
function redirect(id: string, targetId: string | null, kind: 'outside_scope' | 'unresolved' = 'outside_scope'): GraphPage {
  return {...observed(id, 301), redirect: targetId === null ? {kind} : {kind: 'page', targetId}};
}
function input(pages: GraphPage[], links: CrawlGraphInput['links'] = [], coverage: Partial<CrawlGraphInput['coverage']> = {}): CrawlGraphInput {
  return {startPageId: pages[0].id, pages, links, coverage: {runComplete: true, discoveryComplete: true, linksComplete: true, dataState: 'available', ...coverage}};
}
const edge = (sourceId: string, targetId: string) => ({sourceId, targetId});
const findings = (result: ReturnType<typeof analyzeCrawlGraph>, code: string) => result.findings.filter(f => f.code === code);
const ids = (result: ReturnType<typeof analyzeCrawlGraph>, code: string) => findings(result, code).map(f => f.pageId);

test('duplicates use complete analyzer fingerprints, exact case and eligible declarations, without raw evidence', () => {
  function analyzed(id: string, title: string, description: string, body: string): GraphPage {
    const analysis = analyzeCrawlPage({url: `https://example.com/${id}`, status: 200, fetchState: 'ok', contentType: 'text/html',
      html: `<title>${title}</title><meta name="description" content="${description}"><p>${body}</p>`, bodyComplete: true, responseTimeMs: 1, crawlDepth: 1});
    assert.equal(analysis.coverage, 'analyzed');
    return {...page(id), analysis: {ruleVersion: analysis.ruleVersion, coverage: analysis.coverage, facts: analysis.facts}};
  }
  const a = analyzed('A', 'Shared   title', 'Shared\n description', 'shared  content');
  const b = analyzed('B', 'Shared title', 'Shared description', 'shared content');
  const c = analyzed('C', 'shared title', 'shared description', 'Shared content');
  const excluded = ['other', 'conflict', 'invalid'].map((canonical, i) => page(`excluded${i}`, {...a.analysis.facts!, canonical: canonical as GraphFacts['canonical']}));
  excluded.push(page('noindex', {...a.analysis.facts!, indexability: 'noindex_observed'}));
  const empty = ['empty1', 'empty2'].map(key => page(key, {titleLength: 0, titleHash: null, descriptionLength: 0, descriptionHash: null, wordCount: 0, contentHash: null}));
  const self = page('self', {...a.analysis.facts!, canonical: 'self'});
  const prefix = 'x'.repeat(2100);
  const long1 = analyzed('long1', `${prefix}a`, `${prefix}a`, 'a');
  const long2 = analyzed('long2', `${prefix}b`, `${prefix}b`, 'b');
  const shell = page('shell', {...a.analysis.facts!, indexability: 'unknown'}); shell.analysis.coverage = 'shell';
  const result = analyzeCrawlGraph(input([a, b, c, ...excluded, ...empty, self, long1, long2, shell, observed('partial', 206), observed('pdf', 200, 'ok', 'non_html')]));
  for (const code of ['duplicate-title', 'duplicate-meta-description', 'duplicate-content']) {
    assert.deepEqual(ids(result, code), ['A', 'B', 'self']);
    for (const finding of findings(result, code)) {
      assert.equal(finding.details.groupSize, 3);
      assert.equal(finding.relatedPageIds.length, 2);
      assert.ok(!finding.relatedPageIds.includes(finding.pageId));
    }
  }
  assert.equal(result.status, 'partial');
  assert.equal(result.counts.duplicateEligiblePages, 8);
  for (const secret of ['Shared title', prefix, 'https://', '<title>', 'shared content']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(result, analyzeCrawlGraph({...input([a]), pages: [...[a, b, c, ...excluded, ...empty, self, long1, long2, shell, observed('partial', 206), observed('pdf', 200, 'ok', 'non_html')]].reverse()}));
});

test('redirect paths distinguish shared tails, observed hops, unfetched targets and headless cycles deterministically', () => {
  const pages = [page('start'), page('T'),
    redirect('A1', 'B'), redirect('A2', 'B'), redirect('B', 'T'),
    redirect('H', 'C'), redirect('H2', 'D'), redirect('C', 'D'), redirect('D', 'C'),
    redirect('E', 'E'), redirect('X', 'Y'), redirect('Y', 'X'),
    redirect('O', 'P'), redirect('P', null),
    redirect('U', 'V'), redirect('V', 'N'), observed('N', null, 'not_fetched'),
    redirect('R', 'S'), redirect('S', null, 'unresolved'), redirect('single', 'T')];
  pages.find(p => p.id === 'A2')!.status = 302;
  pages.find(p => p.id === 'B')!.status = 303;
  pages.find(p => p.id === 'C')!.status = 307;
  pages.find(p => p.id === 'D')!.status = 308;
  const result = analyzeCrawlGraph(input(pages));
  assert.deepEqual(ids(result, 'redirect-chain'), ['A1', 'A2', 'O', 'R', 'U']);
  assert.deepEqual(findings(result, 'redirect-chain').map(f => f.details), [
    {observedHops: 2, terminalObserved: 1}, {observedHops: 2, terminalObserved: 1},
    {observedHops: 2, terminalObserved: 0}, {observedHops: 2, terminalObserved: 0}, {observedHops: 2, terminalObserved: 0},
  ]);
  assert.deepEqual(ids(result, 'redirect-loop'), ['E', 'H', 'H2', 'X']);
  assert.deepEqual(findings(result, 'redirect-loop').map(f => f.details), [
    {cycleLength: 1, prefixHops: 0}, {cycleLength: 2, prefixHops: 1}, {cycleLength: 2, prefixHops: 1}, {cycleLength: 2, prefixHops: 0},
  ]);
  assert.deepEqual(result, analyzeCrawlGraph({...input(pages), pages: [...pages].reverse()}));
  assert.ok(result.reasons.includes('unresolved_redirect'));
  const unsupported = analyzeCrawlGraph(input([page('start'), observed('cached', 304)]));
  assert.equal(unsupported.status, 'partial'); assert.deepEqual(unsupported.findings, []);
});

test('broken links require direct observed error responses; access blocks, rate limits and failures are not broken', () => {
  const source = page('source', {indexability: 'noindex_observed', canonical: 'other'});
  const targets = [404, 410, 500, 401, 403, 407, 429].map(status => observed(`http${status}`, status));
  targets.push(observed('block200', 200, 'blocked'), observed('block403', 403, 'blocked'), observed('block500', 500, 'blocked'),
    observed('rate503', 503, 'rate_limited'), observed('robots', null, 'robots_disallowed'), observed('unfetched', null, 'not_fetched'),
    observed('failed', 503, 'error'), observed('unknown', null), observed('pdf', 200, 'ok', 'non_html'), redirect('later404', 'http404'));
  const links = targets.map(target => edge('source', target.id)); links.push(edge('source', 'http404'));
  const result = analyzeCrawlGraph(input([source, ...targets], links));
  assert.deepEqual(findings(result, 'broken-internal-link').map(f => [f.pageId, f.targetPageId, f.details.targetStatus, f.severity]), [
    ['source', 'http404', 404, 'critical'], ['source', 'http410', 410, 'critical'], ['source', 'http500', 500, 'critical'],
  ]);
  assert.equal(result.counts.links, targets.length);
  assert.equal(result.counts.observedErrorTargets, 3);
  assert.equal(result.checks.brokenLinks, 'partial');
  assert.equal(result.checks.orphans, 'unavailable');
  assert.deepEqual(result, analyzeCrawlGraph({...input([source, ...targets]), links: [...links].reverse()}));
});

test('orphan candidates require complete scope and sitemap provenance, not merely zero inbound links', () => {
  const pages = ['start', 'orphan', 'linked', 'canonicalLinked', 'redirectDest', 'notSitemap', 'noindex', 'other'].map(key => ({...page(key), sitemapOnly: key !== 'notSitemap'}));
  pages.find(p => p.id === 'noindex')!.analysis.facts!.indexability = 'noindex_observed';
  pages.find(p => p.id === 'other')!.analysis.facts!.canonical = 'other';
  pages.push(page('noindexSource', {indexability: 'noindex_observed'}), page('canonicalSource', {canonical: 'invalid'}), redirect('r', 'redirectDest'));
  const links = [edge('orphan', 'orphan'), edge('noindexSource', 'linked'), edge('canonicalSource', 'canonicalLinked')];
  const result = analyzeCrawlGraph(input(pages, links));
  assert.equal(result.status, 'complete'); assert.equal(result.checks.orphans, 'complete');
  assert.deepEqual(ids(result, 'orphan-page'), ['orphan']);
  // Nofollow is deliberately absent from the graph DTO: the observed edge still exists.
  const analysis = analyzeCrawlPage({url: 'https://example.com/start', status: 200, fetchState: 'ok', contentType: 'text/html',
    html: '<a href="/orphan" rel="nofollow">Destination</a>', bodyComplete: true, responseTimeMs: 1, crawlDepth: 0});
  assert.equal(analysis.evidence!.links[0].nofollow, true);
  assert.deepEqual(ids(analyzeCrawlGraph(input(pages, [...links, edge('start', 'orphan')])), 'orphan-page'), []);
  for (const flag of ['runComplete', 'discoveryComplete', 'linksComplete'] as const) {
    const partial = analyzeCrawlGraph(input(pages, links, {[flag]: false}));
    assert.equal(partial.status, 'partial'); assert.equal(partial.checks.orphans, 'unavailable'); assert.deepEqual(ids(partial, 'orphan-page'), []);
  }
  const shell = page('shell', {indexability: 'unknown'}); shell.analysis.coverage = 'shell';
  const incomplete = [shell, page('unresolved', {unresolvedLinks: 1}), observed('partial', 206), observed('blocked', 200, 'blocked'),
    observed('rate', 429), observed('robots', null, 'robots_disallowed'), observed('unfetched', null, 'not_fetched'), observed('error', null, 'error'),
    observed('unknown', 200), observed('httpError', 404), redirect('redirectUnknown', null, 'unresolved')];
  for (const observation of incomplete) {
    const partial = analyzeCrawlGraph(input([...pages, observation], links));
    assert.equal(partial.status, 'partial', observation.id); assert.equal(partial.checks.orphans, 'unavailable', observation.id);
    assert.deepEqual(ids(partial, 'orphan-page'), [], observation.id);
  }
  const nonHtml = analyzeCrawlGraph(input([...pages, observed('pdf', 200, 'ok', 'non_html')], links));
  assert.equal(nonHtml.status, 'complete'); assert.deepEqual(ids(nonHtml, 'orphan-page'), ['orphan']);
});

test('unavailable, expired and invalid graphs fail closed without substituting an empty healthy result or echoing inputs', () => {
  const unavailable = analyzeCrawlGraph(input([observed('start', null, 'not_fetched')]));
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.findingsComplete, false);
  const expiry = analyzeCrawlGraph(input([page('A'), page('B', page('A').analysis.facts!)], [], {dataState: 'expired'}));
  assert.deepEqual(expiry.reasons, ['data_expired']); assert.equal(expiry.status, 'unavailable'); assert.deepEqual(expiry.findings, []);
  const bad: unknown[] = [null, {}, {...input([page('A')]), pages: []}, input([page('A'), page('A')]),
    {...input([page('A')]), startPageId: 'missing'}, input([page('A')], [edge('A', 'missing')]), input([page('A')], [edge('missing', 'A')]),
    input([page('A'), redirect('B', 'missing')]), input([page('A'), observed('B', null, 'not_fetched')], [edge('B', 'A')]),
    input([page('A\n')]), input([page('raw:secret')]), input([page('á')]), input([page('a'.repeat(65))]),
    input([page('A', {titleHash: `${'a'.repeat(63)}\n`})]), input([page('A', {titleHash: 'A'.repeat(64)})]),
    input([page('A', {titleLength: 0})]), input([page('A', {titleHash: null})]), input([page('A', {wordCount: 0, contentHash: digest('')})]),
    input([page('A', {wordCount: -1})]), input([page('A', {wordCount: Number.MAX_SAFE_INTEGER})]), input([page('A', {unresolvedLinks: 0.5})]),
    input([page('A', {canonical: 'invalid-enum' as never})]), input([page('A', {indexability: 'unknown'})]),
    input([{...page('A'), status: 404}]), input([{...page('A'), status: 199}]), input([{...page('A'), status: 600}]),
    input([{...page('A'), redirect: {kind: 'outside_scope'}}]), input([observed('A', 301)]),
    input([{...redirect('A', null), status: 304}]),
    input([{...page('A'), analysis: {...page('A').analysis, ruleVersion: 'future-v2' as never}}]),
    input([{...page('A'), analysis: {...page('A').analysis, facts: null}}]),
    {...input([page('A')]), coverage: {runComplete: true, discoveryComplete: true, linksComplete: 'true', dataState: 'available'}},
  ];
  for (const value of bad) {
    const result = analyzeCrawlGraph(value as CrawlGraphInput);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.reasons, ['invalid_input']); assert.deepEqual(result.findings, []);
    assert.ok(!JSON.stringify(result).includes('raw:secret'));
  }
  const boundary = page('a'.repeat(64)); assert.equal(analyzeCrawlGraph(input([boundary])).status, 'complete');
});

test('maximum graphs stay iterative and deterministic, with exact totals after bounded output', () => {
  const same = page('seed').analysis.facts!;
  const pages = Array.from({length: crawlGraphLimits.pages}, (_, i) => page(`p${String(i).padStart(5, '0')}`, same));
  const result = analyzeCrawlGraph(input(pages));
  assert.equal(result.counts.findings, 30_000); assert.equal(result.findings.length, crawlGraphLimits.findings);
  assert.equal(result.findingsComplete, false); assert.equal(result.status, 'partial'); assert.deepEqual(result.reasons, ['findings_limit']);
  assert.ok(result.findings.every(f => f.code === 'duplicate-title' && f.details.groupSize === 10_000 && f.relatedPageIds.length === 3));
  assert.deepEqual(result, analyzeCrawlGraph({...input(pages), pages: [...pages].reverse()}));
  assert.deepEqual(analyzeCrawlGraph(input([...pages, page('overflow')])).reasons, ['input_limit']);

  const tail = Array.from({length: 9_900}, (_, i) => redirect(`t${String(i).padStart(4, '0')}`, i === 9_899 ? null : `t${String(i + 1).padStart(4, '0')}`));
  const heads = Array.from({length: 100}, (_, i) => redirect(`h${String(i).padStart(3, '0')}`, 't0000'));
  const chain = analyzeCrawlGraph(input([...heads, ...tail]));
  assert.equal(chain.counts.findings, 100); assert.equal(findings(chain, 'redirect-loop').length, 0);
  assert.ok(chain.findings.every(f => f.code === 'redirect-chain' && f.details.observedHops === 9_901 && f.relatedPageIds.length === 8));
  assert.deepEqual(chain, analyzeCrawlGraph({...input([...heads, ...tail]), pages: [...tail, ...heads].reverse()}));
  tail[9_899].redirect = {kind: 'page', targetId: 't0000'};
  const cycle = analyzeCrawlGraph(input([...heads, ...tail]));
  assert.equal(cycle.counts.findings, 100);
  assert.ok(cycle.findings.every(f => f.code === 'redirect-loop' && f.details.cycleLength === 9_900 && f.details.prefixHops === 1));

  const sources = Array.from({length: 100}, (_, i) => page(`s${String(i).padStart(3, '0')}`));
  const errors = Array.from({length: 1_000}, (_, i) => observed(`e${String(i).padStart(4, '0')}`, 404));
  const links = sources.flatMap(source => errors.map(target => edge(source.id, target.id)));
  assert.equal(links.length, crawlGraphLimits.links);
  const dense = analyzeCrawlGraph(input([...sources, ...errors], links));
  assert.equal(dense.counts.findings, 100_000); assert.equal(dense.findings.length, crawlGraphLimits.findings);
  assert.equal(dense.counts.links, 100_000); assert.equal(dense.findingsComplete, false);
  assert.deepEqual(dense, analyzeCrawlGraph({...input([...sources, ...errors]), pages: [...sources, ...errors].reverse(), links: [...links].reverse()}));
  assert.deepEqual(analyzeCrawlGraph(input([...sources, ...errors], [...links, links[0]])).reasons, ['input_limit']);
});
