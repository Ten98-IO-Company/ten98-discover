import assert from 'node:assert/strict';
import {test} from 'node:test';
import {revenueCalendarPresets,revenueCalendarRange} from '../src/lib/revenue-calendar.ts';
import {deriveAnalyticsComparison} from '../src/lib/analytics-comparison.ts';

test('calendar presets have truthful inclusive counts and whole current periods',()=>{
  const now=new Date('2026-10-15T12:00:00Z'),expected={today:['2026-10-15','2026-10-15'],week:['2026-10-11','2026-10-17'],'7days':['2026-10-09','2026-10-15'],month:['2026-10-01','2026-10-31'],'30days':['2026-09-16','2026-10-15'],'90days':['2026-07-18','2026-10-15'],year:['2026-01-01','2026-12-31'],'6months':['2026-05-01','2026-10-31'],'12months':['2025-11-01','2026-10-31']};
  assert.equal(revenueCalendarPresets.length,Object.keys(expected).length);
  for(const [preset,[from,to]]of Object.entries(expected))assert.deepEqual(revenueCalendarRange(preset,'UTC',now),{from,to},preset);
});
test('local today follows the selected zone, including DST and a skipped calendar date',()=>{
  const range=(zone:string,at:string)=>revenueCalendarRange('today',zone,new Date(at));
  assert.deepEqual(range('America/Los_Angeles','2026-01-01T00:30:00Z'),{from:'2025-12-31',to:'2025-12-31'});
  assert.deepEqual(range('Asia/Tokyo','2026-12-31T23:30:00Z'),{from:'2027-01-01',to:'2027-01-01'});
  for(const at of['2026-03-08T06:59:00Z','2026-03-08T07:01:00Z'])assert.deepEqual(range('America/New_York',at),{from:'2026-03-08',to:'2026-03-08'});
  for(const at of['2026-11-01T05:59:00Z','2026-11-01T06:01:00Z'])assert.deepEqual(range('America/New_York',at),{from:'2026-11-01',to:'2026-11-01'});
  assert.deepEqual(range('Pacific/Apia','2011-12-30T09:59:00Z'),{from:'2011-12-29',to:'2011-12-29'});
  assert.deepEqual(range('Pacific/Apia','2011-12-30T10:01:00Z'),{from:'2011-12-31',to:'2011-12-31'});
  assert.deepEqual(revenueCalendarRange('7days','Pacific/Apia',new Date('2011-12-30T10:01:00Z')),{from:'2011-12-25',to:'2011-12-31'});
});
test('week and month boundaries cross years without elapsed-day or overflow arithmetic',()=>{
  assert.deepEqual(revenueCalendarRange('week','UTC',new Date('2026-01-01T12:00Z')),{from:'2025-12-28',to:'2026-01-03'});
  assert.deepEqual(revenueCalendarRange('week','UTC',new Date('2026-02-01T12:00Z')),{from:'2026-02-01',to:'2026-02-07'});
  assert.deepEqual(revenueCalendarRange('month','UTC',new Date('2024-02-29T12:00Z')),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(revenueCalendarRange('6months','UTC',new Date('2024-03-31T12:00Z')),{from:'2023-10-01',to:'2024-03-31'});
  assert.deepEqual(revenueCalendarRange('year','UTC',new Date('2024-02-29T12:00Z')),{from:'2024-01-01',to:'2024-12-31'});
  for(const year of[2023,2024,2025,2100])for(let month=0;month<12;month++)for(const[preset]of revenueCalendarPresets){const value=revenueCalendarRange(preset,'UTC',new Date(Date.UTC(year,month,15,12)))!;assert.ok(value,preset);const days=(Date.parse(value.to)-Date.parse(value.from))/864e5+1;assert.ok(days>=1&&days<=366,`${preset}/${year}/${month}: ${days}`);if(preset.endsWith('days'))assert.equal(days,Number(preset.slice(0,-4)));}
});
test('closed inputs and supported years refuse instead of clipping or silently falling back',()=>{
  for(const preset of['','custom','24hour','all','13months','7days\n','unknown'])assert.equal(revenueCalendarRange(preset,'UTC'),null);
  for(const zone of['','No/Such_Zone','+04:00','UTC\0','U'.repeat(81)])assert.equal(revenueCalendarRange('today',zone),null);
  assert.equal(revenueCalendarRange('today','UTC',new Date(NaN)),null);
  assert.equal(revenueCalendarRange('today','UTC',new Date('1969-12-31T12:00Z')),null);
  assert.equal(revenueCalendarRange('today','UTC',new Date('9999-01-01T12:00Z')),null);
  assert.equal(revenueCalendarRange('7days','UTC',new Date('1970-01-01T12:00Z')),null);
  assert.equal(revenueCalendarRange('week','UTC',new Date('1970-01-01T12:00Z')),null);
  assert.equal(revenueCalendarRange('12months','UTC',new Date('1970-01-01T12:00Z')),null);
  assert.deepEqual(revenueCalendarRange('today',' UTC ',new Date('1970-01-01T12:00Z')),{from:'1970-01-01',to:'1970-01-01'});
  assert.deepEqual(revenueCalendarRange('year','UTC',new Date('9998-12-31T12:00Z')),{from:'9998-01-01',to:'9998-12-31'});
});
test('calendar presets leave previous-period/year derivation and trusted prior367 semantics unchanged',()=>{
  const range=revenueCalendarRange('12months','America/New_York',new Date('2025-02-28T18:00Z'))!;
  assert.deepEqual(range,{from:'2024-03-01',to:'2025-02-28'});
  assert.ok(deriveAnalyticsComparison(range,'prev'));assert.ok(deriveAnalyticsComparison(range,'yoy'));
  const leap=deriveAnalyticsComparison({from:'2025-02-28',to:'2026-02-28'},'yoy')!;assert.equal(leap.alignment.comparisonDays,367);
  assert.equal(deriveAnalyticsComparison(revenueCalendarRange('today','UTC',new Date('1970-01-01T12:00Z'))!,'prev'),null);
});
