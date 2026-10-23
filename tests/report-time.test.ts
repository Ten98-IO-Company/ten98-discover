import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// Pin a non-UTC browser zone (UTC+3, as in #373) before any formatting so browser-local output would differ.
process.env.TZ='Asia/Riyadh';
const {formatReportInstant}=await import('../src/lib/report-time.ts');

test('report timestamps use the report time zone, not the browser zone (#373)',()=>{
  assert.equal(new Date('2026-10-23T21:45:00.000Z').getDate(),24,'test zone must be ahead of UTC');
  assert.equal(formatReportInstant('2026-10-23T21:45:00.000Z','UTC'),'2026-10-23 21:45 UTC');
  assert.equal(formatReportInstant('2026-10-23T21:45:00.123456Z','America/New_York'),'2026-10-23 17:45 America/New_York');
  assert.equal(formatReportInstant('2026-10-23T23:30:00Z','Asia/Tokyo'),'2026-10-24 08:30 Asia/Tokyo');
  assert.equal(formatReportInstant('2026-10-24T00:00:00Z','UTC'),'2026-10-24 00:00 UTC','midnight is 00, not 24');
  assert.equal(formatReportInstant('not a time','UTC'),'not a time');
  assert.equal(formatReportInstant('2026-10-23T21:45:00Z','Not/AZone'),'2026-10-23T21:45:00Z');
});

test('Revenue, Conversions and Attribution do not format report times in the browser zone (#373)',()=>{
  for(const file of['RevenuePanel','ConversionsPanel','AttributionPanel']){
    const source=readFileSync(new URL(`../src/components/${file}.tsx`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/new Date\([\w.]+(?:asOf|At)\)\.toLocaleString\(\)|date\(result\.generatedAt\)/,file);
    assert.match(source,/formatReportInstant\(/,file);
  }
  assert.doesNotMatch(readFileSync(new URL('../src/components/RevenuePanel.tsx',import.meta.url),'utf8'),/ as of\{/,'missing space before the time');
});
