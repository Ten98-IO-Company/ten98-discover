import assert from 'node:assert/strict';
import {test} from 'node:test';
import {trendSvg, trendY} from '../src/components/ai-trend-svg.ts';

test('the downloaded trend is inert standalone SVG: escaped workspace text, finite geometry and the on-screen gaps', () => {
  const label = `<script>&"'\u0001￾`;
  const values = [10, null, 50, 75, Number.NaN, 100, Number.POSITIVE_INFINITY, 0];
  const points = values.map((value, index) => ({x: 4 + index * 592 / (values.length - 1), value, date: `2026-10-1${index}${index === 2 ? label : ''}`}));
  const svg = trendSvg({title: `Mention rate for ${label}`, desc: `Range ${label}`, points});
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180"'));
  assert.ok(svg.includes('<title>Mention rate for &lt;script&gt;&amp;&quot;&#39;</title>'));
  assert.ok(svg.includes('<desc>Range &lt;script&gt;&amp;&quot;&#39;</desc>'));
  for (const forbidden of ['<script', '\u0001', '￾', 'href', 'url(', 'foreignObject', 'NaN', 'Infinity', '<style']) assert.equal(svg.includes(forbidden), false, forbidden);
  assert.doesNotMatch(svg, / on[a-z]+=/i);
  const count = (pattern: RegExp) => svg.match(pattern)?.length ?? 0;
  const finite = values.filter(value => value !== null && Number.isFinite(value)).length;
  assert.equal(count(/<circle /g), finite);
  assert.equal(count(/stroke-dasharray="2 4"/g), values.length - finite);
  // Segments split on every missing day: [10] [50,75] [100] [0] leave one polyline of two points.
  assert.equal(count(/<polyline /g), 1);
  assert.ok(svg.includes(`points="${points[2].x.toFixed(2)},${trendY(50).toFixed(2)} ${points[3].x.toFixed(2)},${trendY(75).toFixed(2)}"`));
  assert.ok(svg.includes('<title>2026-10-10: 10%</title>') && svg.includes('<title>2026-10-15: 100%</title>') && svg.includes('<title>2026-10-11: Unavailable</title>'));
  assert.ok(svg.includes('>2026-10-10</text>') && svg.includes('>2026-10-17</text>'));
  assert.equal(trendY(0), 170);assert.equal(trendY(100), 10);
  assert.ok(trendSvg({title: 't', desc: 'd', points: [{x: 300, value: null, date: '2026-10-13'}]}).includes('stroke-dasharray'));
});
