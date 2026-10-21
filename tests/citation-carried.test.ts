// Elmo 0.4.4 ships no chart-utils tests; these cover the ported function and the Discover adapter.
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {applyPerPromptKeyedLVCF, carriedCitations} from '../src/server/citation-carried.ts';
import {validCarriedCitations} from '../src/lib/citation-report.ts';

const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];

describe('applyPerPromptKeyedLVCF', () => {
  const keys = ['a', 'b'] as const;
  it('carries the last value forward and seeds earlier days from the earliest observation', () => {
    const daily = applyPerPromptKeyedLVCF([
      {prompt_id: 'p', date: '2026-10-02', key: 'a', count: 3},
      {prompt_id: 'p', date: '2026-10-03', key: 'b', count: 2},
    ], dates, 24, keys);
    assert.deepEqual([...dates].map(d => daily.get(d)), [{a: 3, b: 0}, {a: 3, b: 0}, {a: 0, b: 2}, {a: 0, b: 2}]);
  });
  it('sums prompts and sums repeated rows for one prompt and day', () => {
    const daily = applyPerPromptKeyedLVCF([
      {prompt_id: 'p', date: '2026-10-01', key: 'a', count: 1},
      {prompt_id: 'p', date: '2026-10-01', key: 'a', count: 1},
      {prompt_id: 'q', date: '2026-10-04', key: 'b', count: 4},
    ], dates, null, keys);
    assert.deepEqual(daily.get('2026-10-01'), {a: 2, b: 4});
    assert.deepEqual(daily.get('2026-10-04'), {a: 2, b: 4});
  });
  it('divides by the cadence in days, with a one day minimum', () => {
    const rows = [{prompt_id: 'p', date: '2026-10-01', key: 'a' as const, count: 6}];
    assert.equal(applyPerPromptKeyedLVCF(rows, dates, 72, keys).get('2026-10-02')!.a, 2);
    assert.equal(applyPerPromptKeyedLVCF(rows, dates, 1, keys).get('2026-10-02')!.a, 6);
  });
  it('returns an empty map without rows', () => {
    assert.equal(applyPerPromptKeyedLVCF([], dates, 24, keys).size, 0);
  });
});

describe('carriedCitations', () => {
  const axisKeys = {ownership: ['brand', 'untracked'], publisher: ['editorial', 'other'], pageType: ['article', 'other'], sourceType: ['publisher', 'unclassified']} as const;
  const keysFor = (own: string) => ({ownership: own, publisher: 'editorial', pageType: 'article', sourceType: 'publisher'});
  it('treats an eligible answer without citations as an observed zero and flags observed days', () => {
    const result = carriedCitations(
      [{promptId: 'p', date: dates[0], keys: keysFor('brand')}, {promptId: 'p', date: dates[0], keys: keysFor('brand')}],
      [{promptId: 'p', date: dates[0]}, {promptId: 'p', date: dates[2]}],
      dates, axisKeys);
    assert.equal(result.method, 'elmo-lvcf-v1');
    assert.deepEqual(result.observed, [true, false, true, false]);
    const brand = result.axes.ownership.find(a => a.key === 'brand')!;
    assert.deepEqual(brand.values, [2, 2, 0, 0]);
    assert.deepEqual(result.axes.ownership.find(a => a.key === 'untracked')!.values, [0, 0, 0, 0]);
    assert.deepEqual(result.axes.publisher.map(a => a.key), ['editorial', 'other']);
  });
  it('is empty and unobserved with no answers', () => {
    const result = carriedCitations([], [], dates, axisKeys);
    assert.deepEqual(result.observed, [false, false, false, false]);
    assert.ok(Object.values(result.axes).every(rows => rows.every(r => r.values.every(v => v === 0))));
  });
  it('is validated by the client and malformed blocks are rejected', () => {
    const full = {
      ownership: ['untracked', 'brand', 'competitor', 'ambiguous'], publisher: ['editorial', 'reviews', 'ecommerce', 'social', 'developer', 'pr', 'reference', 'institutional', 'other'],
      pageType: ['homepage', 'article', 'listicle', 'howto', 'comparison', 'review', 'product', 'doc', 'forum', 'video', 'info', 'search', 'shopping', 'other'],
      sourceType: ['publisher', 'google_shopping', 'google_search', 'google_wrapper', 'unclassified'],
    } as const;
    const carried = carriedCitations([], [{promptId: 'p', date: dates[1]}], dates, full);
    assert.deepEqual(validCarriedCitations({carried}, dates), carried);
    assert.equal(validCarriedCitations({}, dates), null);
    assert.equal(validCarriedCitations({carried}, dates.slice(1)), null);
    assert.equal(validCarriedCitations({carried: {...carried, observed: [true]}}, dates), null);
    const bad = structuredClone(carried);
    bad.axes.publisher[0].values[0] = -1;
    assert.equal(validCarriedCitations({carried: bad}, dates), null);
  });
});
