// Adapted from Elmo 0.4.4 (3c673d0253d01ae030fa41519f62ad7e54f2281b) apps/web/src/lib/__tests__/visibility-stats.test.ts
// Copyright (c) 2026 Blue Whale Software, LLC. MIT License; see THIRD_PARTY_NOTICES.md.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  computeShareOfVoice,
  computeVolatility,
  type DailyDomainCount,
  shareOfVoiceLeaderboardLVCF,
  shareOfVoiceTimeSeriesLVCF,
  stabilityScore,
} from '../src/server/visibility-stats.ts';
import {carriedInsights, type InsightExecution} from '../src/server/prompt-insights.ts';

/** Helper: build daily rows from a {date: {domain: count}} spec. */
function rows(spec: Record<string, Record<string, number>>): DailyDomainCount[] {
  const out: DailyDomainCount[] = [];
  for (const [date, domains] of Object.entries(spec)) {
    for (const [domain, count] of Object.entries(domains)) {
      out.push({date, domain, count});
    }
  }
  return out;
}
const near = (actual: number | null, expected: number, digits: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 0.5 * 10 ** -digits, `${actual} is not close to ${expected}`);
};

describe('computeVolatility', () => {
  it('returns nulls with zero transitions when there are fewer than two days', () => {
    assert.deepEqual(computeVolatility([]), {setVolatility: null, weightedVolatility: null, dayTransitions: 0});
    assert.deepEqual(computeVolatility(rows({'2026-01-01': {a: 1, b: 1}})), {
      setVolatility: null,
      weightedVolatility: null,
      dayTransitions: 0,
    });
  });

  it('is zero for an identical domain set every day', () => {
    const r = computeVolatility(rows({'2026-01-01': {a: 1, b: 1}, '2026-01-02': {a: 1, b: 1}}));
    assert.equal(r.setVolatility, 0);
    assert.equal(r.weightedVolatility, 0);
    assert.equal(r.dayTransitions, 1);
  });

  it('is one for completely disjoint sets each day', () => {
    const r = computeVolatility(rows({'2026-01-01': {a: 1}, '2026-01-02': {b: 1}}));
    assert.equal(r.setVolatility, 1);
    assert.equal(r.weightedVolatility, 1);
  });

  it('matches hand-computed Jaccard and Bray–Curtis on a mixed example', () => {
    // day1 {a,b,c} -> day2 {b,c,d}: inter=2, union=4 -> setDist 0.5
    // shares all 1/3; overlap = min(b)+min(c) = 1/3+1/3 -> weightedDist 1/3
    const r = computeVolatility(rows({'2026-01-01': {a: 1, b: 1, c: 1}, '2026-01-02': {b: 1, c: 1, d: 1}}));
    assert.equal(r.setVolatility, 0.5);
    near(r.weightedVolatility, 0.333, 3);
  });

  it('captures the orthogonality of set churn vs volume churn (pinned head, noisy tail)', () => {
    // A dominant 'hub' every day (80% of volume) with a fully-rotating tail.
    // Set churn is high (most distinct domains change) but volume churn is low
    // (the source that carries the answer is stable).
    const r = computeVolatility(rows({'2026-01-01': {hub: 8, x: 1, y: 1}, '2026-01-02': {hub: 8, z: 1, w: 1}}));
    assert.equal(r.setVolatility, 0.8); // inter {hub}=1, union 5 -> 1 - 1/5
    near(r.weightedVolatility, 0.2, 5); // overlap = min(hub .8,.8) = .8
  });

  it('averages across multiple transitions and sums duplicate same-day rows', () => {
    const r = computeVolatility(
      rows({
        '2026-01-01': {a: 1, b: 1}, // -> day2 identical: setDist 0
        '2026-01-02': {a: 1, b: 1}, // -> day3 disjoint: setDist 1
        '2026-01-03': {c: 1, d: 1},
      }),
    );
    assert.equal(r.dayTransitions, 2);
    assert.equal(r.setVolatility, 0.5); // (0 + 1) / 2
  });

  it('ignores non-positive counts', () => {
    const r = computeVolatility(rows({'2026-01-01': {a: 1, ghost: 0}, '2026-01-02': {a: 1}}));
    assert.equal(r.setVolatility, 0); // 'ghost' dropped, both days = {a}
  });
});

describe('stabilityScore', () => {
  it('inverts weighted volatility onto a 0-100 scale', () => {
    assert.equal(stabilityScore(0), 100);
    assert.equal(stabilityScore(1), 0);
    assert.equal(stabilityScore(0.2), 80);
    assert.equal(stabilityScore(null), null);
  });
});

describe('computeShareOfVoice', () => {
  it('computes shares that sum to 1 and sorts by mentions desc', () => {
    const {entries, brandShare, total} = computeShareOfVoice({name: 'Nike', mentions: 10}, [
      {name: 'Adidas', mentions: 8},
      {name: 'Puma', mentions: 2},
    ]);
    assert.equal(total, 20);
    assert.equal(brandShare, 0.5);
    assert.deepEqual(entries.map((e) => e.name), ['Nike', 'Adidas', 'Puma']);
    assert.equal(entries.find((e) => e.isBrand)?.share, 0.5);
    near(entries.reduce((s, e) => s + e.share, 0), 1, 5);
  });

  it('handles the no-data case without dividing by zero', () => {
    const {brandShare, entries} = computeShareOfVoice({name: 'Nike', mentions: 0}, []);
    assert.equal(brandShare, null);
    assert.equal(entries[0]?.share, 0);
  });
});

describe('shareOfVoiceTimeSeriesLVCF', () => {
  it("carries each prompt's last values forward across gap days", () => {
    const series = shareOfVoiceTimeSeriesLVCF(
      [
        {promptId: 'p1', date: '2026-01-01', brandMentions: 2, competitorMentions: 2},
        {promptId: 'p1', date: '2026-01-03', brandMentions: 1, competitorMentions: 3},
      ],
      ['2026-01-01', '2026-01-02', '2026-01-03'],
    );
    // day2 has no run, so it carries day1 (2/(2+2)); day3 uses its own (1/(1+3))
    assert.deepEqual(series.map((s) => s.share), [0.5, 0.5, 0.25]);
  });

  it('aggregates across prompts and yields null for days with no data', () => {
    const series = shareOfVoiceTimeSeriesLVCF(
      [
        {promptId: 'a', date: '2026-01-02', brandMentions: 1, competitorMentions: 0},
        {promptId: 'b', date: '2026-01-02', brandMentions: 0, competitorMentions: 1},
      ],
      ['2026-01-01', '2026-01-02'],
    );
    // day1: both prompts carry their earliest (day2) obs -> brand 1 / total 2
    assert.deepEqual(series[0], {date: '2026-01-01', share: 0.5});
    assert.deepEqual(series[1], {date: '2026-01-02', share: 0.5});
    assert.deepEqual(shareOfVoiceTimeSeriesLVCF([], ['2026-01-01']), [{date: '2026-01-01', share: null}]);
  });
});

describe('shareOfVoiceLeaderboardLVCF', () => {
  it("carries each prompt's last standings forward and sums per competitor", () => {
    const r = shareOfVoiceLeaderboardLVCF(
      [
        {promptId: 'p1', date: '2026-01-01', brand: 2},
        {promptId: 'p1', date: '2026-01-03', brand: 1},
        {promptId: 'p2', date: '2026-01-02', brand: 0},
      ],
      [
        {promptId: 'p1', date: '2026-01-01', competitor: 'A', mentions: 1},
        {promptId: 'p1', date: '2026-01-01', competitor: 'B', mentions: 1},
        {promptId: 'p1', date: '2026-01-03', competitor: 'A', mentions: 3},
        {promptId: 'p2', date: '2026-01-02', competitor: 'A', mentions: 2},
      ],
      ['2026-01-01', '2026-01-02', '2026-01-03'],
    );
    // p1's latest obs is day3 (brand 1, {A:3} — B is gone, not in the latest run);
    // p2's latest obs is day2 (brand 0, {A:2}).
    assert.equal(r.brandMentions, 1);
    assert.equal(r.brandPrompts, 1);
    assert.deepEqual(r.competitors, [{name: 'A', mentions: 5, prompts: 2}]);
    // The implied brand share equals the trend's final point (1 / (1 + 5)).
    const fromLeaderboard = computeShareOfVoice({name: 'you', mentions: r.brandMentions}, r.competitors).brandShare;
    const trend = shareOfVoiceTimeSeriesLVCF(
      [
        {promptId: 'p1', date: '2026-01-01', brandMentions: 2, competitorMentions: 2},
        {promptId: 'p1', date: '2026-01-03', brandMentions: 1, competitorMentions: 3},
        {promptId: 'p2', date: '2026-01-02', brandMentions: 0, competitorMentions: 2},
      ],
      ['2026-01-01', '2026-01-02', '2026-01-03'],
    );
    // Both are exact ratios, so this is equality rather than agreement after rounding.
    assert.equal(fromLeaderboard, trend[trend.length - 1].share);
  });

  it('returns empty for an empty date range', () => {
    assert.deepEqual(shareOfVoiceLeaderboardLVCF([], [], []), {brandMentions: 0, brandPrompts: 0, competitors: []});
  });
});

describe('share-of-voice percentage consistency across computation methods', () => {
  it('leaderboard, donut, and trend round the same brand share to the same percent (no double-rounding)', () => {
    // 235 / 1002 = 23.453% — exactly the band where pre-rounding the share to
    // 3 decimals first would bump the leaderboard/donut to 24% while the trend,
    // rounding the exact ratio, shows 23%. Every path carries the exact ratio
    // and rounds once at the end, so all four must land on 23%.
    const dateRange = ['2026-01-01'];

    // Trend (per-prompt LVCF time series): rounds brand / (brand + competitor).
    const trend = shareOfVoiceTimeSeriesLVCF(
      [{promptId: 'p1', date: '2026-01-01', brandMentions: 235, competitorMentions: 767}],
      dateRange,
    );
    const trendShare = trend[trend.length - 1].share;

    // Leaderboard -> computeShareOfVoice (the source for the table + donut).
    const standings = shareOfVoiceLeaderboardLVCF(
      [{promptId: 'p1', date: '2026-01-01', brand: 235}],
      [{promptId: 'p1', date: '2026-01-01', competitor: 'X', mentions: 767}],
      dateRange,
    );
    const {entries, brandShare} = computeShareOfVoice(
      {name: 'you', mentions: standings.brandMentions},
      standings.competitors.map((c) => ({name: c.name, mentions: c.mentions})),
    );
    const brandEntry = entries.find((e) => e.isBrand);
    const total = entries.reduce((s, e) => s + e.mentions, 0);

    assert.equal(Math.round((trendShare ?? 0) * 100), 23); // headline / sparkline
    assert.equal(Math.round((brandShare ?? 0) * 100), 23); // headline derived from the leaderboard
    assert.equal(Math.round((brandEntry?.share ?? 0) * 100), 23); // leaderboard table cell (formatPct)
    assert.equal(Math.round((brandEntry!.mentions / total) * 100), 23); // donut slice
  });
});

describe('carriedInsights (Discover adapter)', () => {
  const subjects = [
    {id: 'brand', name: 'Acme', aliases: [], domains: []},
    {id: 'beta', name: 'Beta', aliases: [], domains: []},
  ];
  const obs = (promptId: string, date: string, brand: boolean, beta: boolean, citedBeta = false): InsightExecution => ({
    id: `${promptId}-${date}`, comparisonId: 'c', promptId, versionId: 'v', requestedAt: `${date}T00:00:00.000000Z`, date,
    model: 'm', resolvedModel: 'm', status: 'completed', eligibility: 'eligible',
    matches: [
      {id: 'brand', mentioned: brand, matchedTerm: null, cited: false, citationIndexes: []},
      {id: 'beta', mentioned: beta, matchedTerm: null, cited: citedBeta, citationIndexes: []},
    ],
  });

  it('carries observed prompt values across gap days, keeps one headline share, and reports stability', () => {
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const carried = carriedInsights(subjects, [
      obs('p1', '2026-01-01', true, true, true),
      obs('p1', '2026-01-03', true, false, true),
      {...obs('p2', '2026-01-02', false, true), eligibility: 'empty', matches: null},
    ], dates);
    assert.deepEqual(carried.series, [{date: dates[0], share: 0.5}, {date: dates[1], share: 0.5}, {date: dates[2], share: 1}]);
    assert.deepEqual(carried.leaderboard.entries.map((e) => [e.id, e.name, e.mentions, e.prompts]), [['brand', 'Acme', 1, 1]]);
    assert.equal(carried.leaderboard.brandShare, carried.series.at(-1)!.share);
    assert.equal(carried.volatility.dayTransitions, 1);
    assert.equal(carried.volatility.stability, 100);
  });
});
