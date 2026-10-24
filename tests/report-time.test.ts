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

test('report times follow daylight-saving changes in the report zone',()=>{
  // Spring forward: 02:00 EST becomes 03:00 EDT, so 01:59 local is followed by 03:00.
  assert.equal(formatReportInstant('2026-03-08T06:59:00Z','America/New_York'),'2026-03-08 01:59 America/New_York');
  assert.equal(formatReportInstant('2026-03-08T07:00:00Z','America/New_York'),'2026-03-08 03:00 America/New_York');
  // Fall back: 01:30 local occurs twice, so two different instants show identically; panels expose the ISO instant as a title.
  assert.equal(formatReportInstant('2026-11-01T05:30:00Z','America/New_York'),'2026-11-01 01:30 America/New_York');
  assert.equal(formatReportInstant('2026-11-01T06:30:00Z','America/New_York'),'2026-11-01 01:30 America/New_York');
  assert.equal(formatReportInstant('2026-11-01T07:30:00Z','America/New_York'),'2026-11-01 02:30 America/New_York');
});

test('UTC output matches the retired Analytics fmtUtc byte for byte',()=>{
  // Expected strings were produced by the removed `${new Date(iso).toISOString().slice(0,16).replace('T',' ')} UTC`.
  const expected:[string,string][]=[
    ['1970-01-01T00:00:00.000Z','1970-01-01 00:00 UTC'],
    ['2000-02-29T12:00:00Z','2000-02-29 12:00 UTC'],
    ['2025-12-31T23:59:59.999Z','2025-12-31 23:59 UTC'],
    ['2026-01-01T00:00:00Z','2026-01-01 00:00 UTC'],
    ['2026-01-01T00:00:00.000001Z','2026-01-01 00:00 UTC'],
    ['2026-10-24T00:00:00Z','2026-10-24 00:00 UTC'],
    ['2026-10-23T21:45:00.123456Z','2026-10-23 21:45 UTC'],
    ['2026-12-31T23:59:00Z','2026-12-31 23:59 UTC'],
    ['2027-01-01T00:00:00.000Z','2027-01-01 00:00 UTC'],
    ['2026-06-15T12:34:56+03:00','2026-06-15 09:34 UTC'],
  ];
  for(const[iso,text]of expected)assert.equal(formatReportInstant(iso,'UTC'),text,iso);
  const analytics=readFileSync(new URL('../src/components/AnalyticsPanel.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(analytics,/fmtUtc/);
  assert.match(analytics,/formatReportInstant\(data\.lastReceivedAt,'UTC'\)/);
});

test('Revenue, Conversions and Attribution do not format report times in the browser zone (#373)',()=>{
  for(const file of['RevenuePanel','ConversionsPanel','AttributionPanel']){
    const source=readFileSync(new URL(`../src/components/${file}.tsx`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/new Date\([\w.]+(?:asOf|At)\)\.toLocaleString\(\)|date\(result\.generatedAt\)/,file);
    assert.match(source,/formatReportInstant\(/,file);
  }
  assert.doesNotMatch(readFileSync(new URL('../src/components/RevenuePanel.tsx',import.meta.url),'utf8'),/ as of\{/,'missing space before the time');
  const conversions=readFileSync(new URL('../src/components/ConversionsPanel.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(conversions,/>\{e\.receivedAt\}</,'matching-activity times must not show the raw ISO value');
  assert.match(conversions,/formatReportInstant\(e\.receivedAt,witness\.range\.timeZone\)/);
});

test('report status lines carry the exact instant for repeated fall-back hours',()=>{
  const source=(file:string)=>readFileSync(new URL(`../src/components/${file}.tsx`,import.meta.url),'utf8');
  assert.match(source('RevenuePanel'),/<p role="status" title=\{!busy&&report\?report\.asOf:undefined\}>/);
  assert.match(source('AttributionPanel'),/<p role="status" title=\{!busy&&shown\?shown\.asOf:undefined\}>/);
  assert.match(source('ConversionsPanel'),/<p className="hint" title=\{result\.generatedAt\}>/);
});

test('Recent events shows UTC report times with the exact instant (#401)',()=>{
  const source=readFileSync(new URL('../src/routes/index.tsx',import.meta.url),'utf8');
  const start=source.indexOf("<h2 id='ev-h'>Retained events</h2>"),end=source.indexOf('persisted events.</p>',start);
  assert.ok(start>=0&&end>start,'Recent events view not found');
  const view=source.slice(start,end);
  assert.doesNotMatch(view,/\{fmt\(/,'Recent events must not use browser-local fmt');
  // Each shown time is UTC and carries its exact ISO instant as a title (the row also as <time dateTime>).
  const retained='\\(events\\?\\.retainedFrom \\?\\? project\\.retainedFrom\\)!';
  assert.match(view,/<Text tone='muted' title=\{eventsReadAt\}>Read \{formatReportInstant\(eventsReadAt,'UTC'\)\}<\/Text>/);
  assert.match(view,new RegExp(`<p className='hint' title=\\{${retained}\\}>History before \\{formatReportInstant\\(${retained},'UTC'\\)\\}`));
  assert.match(view,/<p className='dim' title=\{lastReceived\}>Last retained event received \{formatReportInstant\(lastReceived,'UTC'\)\}<\/p>/);
  assert.match(view,/<time dateTime=\{ev\.receivedAt\} title=\{ev\.receivedAt\}>\{formatReportInstant\(ev\.receivedAt,'UTC'\)\}<\/time>/);
});

test('Revenue labels keep a space before their values (#401)',()=>{
  const source=readFileSync(new URL('../src/components/RevenuePanel.tsx',import.meta.url),'utf8');
  for(const label of[/ of\{table\./,/Sales\{display\(/,/Refunds\{display\(/])assert.doesNotMatch(source,label,String(label));
  assert.match(source,/ matching of \{table\.sessions\.totalRevenueKeys/);
  assert.match(source,/<p>Sales \{display\(detail\.detail\.summary\?\.sales,currency\)\} · Refunds \{display\(/);
});
