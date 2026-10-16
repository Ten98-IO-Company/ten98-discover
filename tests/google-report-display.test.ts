import assert from 'node:assert/strict';
import {test} from 'node:test';
import {googleAdsColumnLabel,googleAdsCost,googleGa4ColumnLabel,googleGa4MetricValue,googleGa4MetricInRange,googleDecimalPlain,googleLastCompletedDay,googleCalendarWeek,googleOrganicCalendar,googleOrganicChange,googleOrganicChangeValue,organicOverviewMetrics,readOrganicOverview} from '../src/lib/google-report-display.ts';

test('completed-day bounds use the property calendar across UTC offsets, DST, leap days and year changes',()=>{
  for(const[zone,now,expected]of [
    ['America/Los_Angeles','2026-01-01T00:30:00Z','2025-12-30'],
    ['Pacific/Kiritimati','2026-01-01T00:30:00Z','2025-12-31'],
    ['Pacific/Kiritimati','2026-01-01T10:30:00Z','2026-01-01'],
    ['America/New_York','2026-03-08T07:30:00Z','2026-03-07'],
    ['America/New_York','2026-11-01T05:30:00Z','2026-10-31'],
    ['UTC','2024-03-01T00:00:00Z','2024-02-29'],
  ])assert.equal(googleLastCompletedDay(zone,new Date(now)),expected);
  for(const zone of [null,'','No/Such_Zone'])assert.equal(googleLastCompletedDay(zone,new Date()),null);
  assert.equal(googleLastCompletedDay('UTC',new Date('invalid')),null);
});

test('organic trend slots keep calendar gaps and split Sunday Google weeks at January 1',()=>{
  assert.deepEqual(googleOrganicCalendar('2024-02-28','2024-03-01',false),[
    {key:'2024-02-28',from:'2024-02-28',to:'2024-02-28'},
    {key:'2024-02-29',from:'2024-02-29',to:'2024-02-29'},
    {key:'2024-03-01',from:'2024-03-01',to:'2024-03-01'},
  ]);
  assert.deepEqual(googleOrganicCalendar('2025-12-28','2026-01-04',true),[
    {key:'202553',from:'2025-12-28',to:'2025-12-31'},
    {key:'202601',from:'2026-01-01',to:'2026-01-03'},
    {key:'202602',from:'2026-01-04',to:'2026-01-04'},
  ]);
  assert.equal(googleOrganicCalendar('2024-01-01','2024-12-31',false).length,366);
  assert.equal(googleCalendarWeek('2026-01-01'),'202601');
  for(const[from,to]of [['2026-02-30','2026-03-01'],['2026-03-01','2026-02-28'],['2024-01-01','2025-01-01']])assert.throws(()=>googleOrganicCalendar(from,to,false));
  assert.throws(()=>googleCalendarWeek('2026-02-30'));
});

test('Ads cost uses exact account-currency micros beyond safe Number precision',()=>{
  assert.equal(googleAdsCost('9007199254740993','AED'),'AED 9,007,199,254.740993');
  assert.equal(googleAdsCost('9007199254740994','AED'),'AED 9,007,199,254.740994');
  assert.equal(googleAdsCost('0','JPY'),'JPY 0.000000');
  assert.equal(googleAdsCost('1','EUR'),'EUR 0.000001');
  assert.equal(googleAdsCost('999999999999999999999999999999','KWD'),'KWD 999,999,999,999,999,999,999,999.999999');
  assert.equal(googleAdsCost('1000000','USD'),'USD 1.000000');
  for(const currency of [null,undefined,'','usd','ZZZ','AED\n',42])assert.equal(googleAdsCost('1000000',currency),'1.000000 (currency unavailable)');
});

test('GA4 table labels and values preserve source scope, exact decimals and unknown currency',()=>{
  assert.equal(googleGa4ColumnLabel('unifiedPagePathScreen'),'Page path and screen class');assert.equal(googleGa4ColumnLabel('sessionCampaignName'),'Session campaign');assert.equal(googleGa4ColumnLabel('userEngagementDuration'),'Engagement time (seconds)');assert.equal(googleGa4ColumnLabel('constructor'),'constructor');
  assert.equal(googleGa4MetricValue('totalUsers','9007199254740993','USD'),'9007199254740993');assert.equal(googleGa4MetricValue('keyEvents','0.5','AED'),'0.5');assert.equal(googleGa4MetricValue('totalRevenue','-9007199254740993.1250','AED'),'AED -9007199254740993.1250');assert.equal(googleGa4MetricValue('totalRevenue','0','JPY'),'JPY 0');assert.equal(googleGa4MetricValue('totalRevenue','1.25e+2','KWD'),'KWD 1.25e+2');
  for(const currency of [null,undefined,'usd','ZZZ'])assert.equal(googleGa4MetricValue('totalRevenue','0',currency),'0 (currency unavailable)');
  for(const value of [null,undefined,0,'','NaN','Infinity','01','1\n',' 1','1'.repeat(101)])assert.equal(googleGa4MetricValue('totalRevenue',value,'AED'),'Unavailable');
});
test('Unavailable/invalid amounts never become zero or a guessed currency',()=>{
  for(const value of [null,undefined,'','-1','01','1.0','1e6','1000000\n',' 1000000',1000000,9007199254740993,'1'.repeat(31)])assert.equal(googleAdsCost(value,'AED'),'Unavailable');
});
test('Ads columns are readable without changing raw provider field identities',()=>{
  for(const [field,label] of Object.entries({date:'Date',customerId:'Account ID',campaignId:'Campaign ID',campaignName:'Campaign',campaignStatus:'Campaign status',adGroupId:'Ad group ID',adGroupName:'Ad group',adGroupStatus:'Ad group status',impressions:'Impressions',clicks:'Clicks',costMicros:'Cost',conversions:'Conversions',conversionsValue:'Conversion value'}))assert.equal(googleAdsColumnLabel(field),label);
  assert.equal(googleAdsColumnLabel('futureField'),'futureField');assert.equal(googleAdsColumnLabel('constructor'),'constructor');
});

test('Organic comparison preserves decimals beyond Number precision and refuses unknown/zero baselines',()=>{
  assert.deepEqual(googleOrganicChange('9007199254740993.1250','9007199254740992.1250'),{absolute:'1.0000',percent:'0.00'});
  assert.deepEqual(googleOrganicChange('-3','-2'),{absolute:'-1',percent:'-50.00'});assert.deepEqual(googleOrganicChange('1','3'),{absolute:'-2',percent:'-66.66'});
  assert.deepEqual(googleOrganicChange('0','0'),{absolute:'0',percent:null});assert.deepEqual(googleOrganicChange(null,'1'),{absolute:null,percent:null});
  assert.equal(googleOrganicChangeValue(googleOrganicChange('1e308','0').absolute,'AED'),'AED 1'+'0'.repeat(308));assert.equal(googleDecimalPlain('1.25e-3'),'0.00125');assert.equal(googleDecimalPlain('-1e3'),'-1000');
  for(const value of ['1e999999','1e-999999','1'.repeat(101),'1\n',{},Infinity])assert.equal(googleDecimalPlain(value),null);
  assert.equal(googleGa4MetricValue('purchaseRevenue','-9007199254740993.1250','AED'),'AED -9007199254740993.1250');
});

test('Organic complete-stage decoder refuses mixed dates, unknown metadata and incomplete observations',()=>{
  const observation={from:'2024-03-01',to:'2024-03-02',values:Object.fromEntries(organicOverviewMetrics.map(name=>[name,'0'])),rowCount:1,quality:{warnings:[],metadata:{timeZone:'America/New_York',currencyCode:'AED'}},reportRequests:1,compatibilityRequests:1};
  const full={complete:true,interval:'daily',current:observation,previous:{...structuredClone(observation),from:'2024-02-28',to:'2024-02-29',compatibilityRequests:0},trend:{...structuredClone(observation),values:null,rowCount:2}};
  assert.ok(readOrganicOverview(full,'2024-03-01','2024-03-02',false));
  for(const[field,value]of [['activeUsers','-1e-400'],['engagementRate','1.0000000000000001']]){const bad=structuredClone(full);bad.current.values[field]=value;assert.equal(readOrganicOverview(bad,'2024-03-01','2024-03-02',false),null);}
  for(const mutate of [(v:any)=>v.complete=false,(v:any)=>delete v.previous,(v:any)=>v.previous.from='2024-02-27',(v:any)=>v.current.values.activeUsers='1e9999',(v:any)=>v.trend.rowCount=367,(v:any)=>v.current.quality.metadata.secret='unselected',(v:any)=>v.previous.compatibilityRequests=1,(v:any)=>v.current.rowCount=0]){const bad=structuredClone(full);mutate(bad);assert.equal(readOrganicOverview(bad,'2024-03-01','2024-03-02',false),null);}
  full.current={...observation,values:null as any,rowCount:0};assert.ok(readOrganicOverview(full,'2024-03-01','2024-03-02',false));
});

test('GA4 exact metric bounds reject rounded above-one rates and underflowed negatives without losing signed revenue or zero',()=>{
  for(const field of ['activeUsers','itemsViewed','keyEvents','engagementRate','sessionKeyEventRate']){
    for(const value of [null,'0','-0','-0.000e-400','0.25','1e-400','1.0000000000000000'])assert.equal(googleGa4MetricInRange(field,value),true);
    for(const value of ['-1e-400','-0.0000000000000000001','NaN','1e401',undefined])assert.equal(googleGa4MetricInRange(field,value),false);
  }
  for(const field of ['engagementRate','sessionKeyEventRate'])for(const value of ['1.0000000000000001','10000000000000001e-16','2'])assert.equal(googleGa4MetricInRange(field,value),false);
  assert.equal(googleGa4MetricInRange('activeUsers','9007199254740993'),true);
  for(const field of ['purchaseRevenue','itemRevenue'])for(const value of [null,'-1e-400','-9007199254740993.1250','0'])assert.equal(googleGa4MetricInRange(field,value),true);
});
