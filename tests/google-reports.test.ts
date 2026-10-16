import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleImportInput, googleReportRequest, normalizeGoogleReport, safeGoogleString, googleReports, ga4InventoryReports, googleCompatibilityRequest, normalizeGoogleCompatibility, organicPreviousRange, validateOrganicDates, organicWeek } from '../src/server/google-reports.ts';

test('Google dates, scope and request bounds preserve provider calendar semantics', () => {
  const input = { requestId: 'cd81b617-b38c-4b15-9d63-49332908d09a', report: 'gsc_daily', from: '2024-02-29', to: '2024-03-01' };
  assert.equal(googleImportInput.safeParse(input).success, true);
  for (const range of [{ from: '2023-02-29' }, { to: '2024-02-28' }, { to: '2025-03-01' }, { to: '9999-12-31' }]) assert.equal(googleImportInput.safeParse({ ...input, ...range }).success, false);
  for (const value of ['bad\0text', '\ud800']) assert.equal(safeGoogleString(50).safeParse(value).success, false);
  const gsc = googleReportRequest('gsc_daily', input.from, input.to, 1000);
  assert.equal(gsc.startDate, input.from); assert.equal(gsc.dataState, 'final'); assert.equal(gsc.startRow, 1000); assert.equal(gsc.rowLimit, 1000);
  const ga4 = googleReportRequest('ga4_events', input.from, input.to, 2000);
  assert.equal(ga4.offset, '2000'); assert.equal(ga4.limit, '1000'); assert.equal(ga4.returnPropertyQuota, true);
});

test('GA4 inventory requests are fixed, ordered and checked without dropping incompatible fields', () => {
  for (const report of ga4InventoryReports) {
    const definition=googleReports[report],request=googleReportRequest(report,'2024-03-01','2024-03-02',1000),compatibility=googleCompatibilityRequest(report,'2024-03-01','2024-03-02');
    assert.equal(googleImportInput.safeParse({requestId:'cd81b617-b38c-4b15-9d63-49332908d09a',report,from:'2024-03-01',to:'2024-03-02'}).success,true);
    assert.deepEqual(request.dimensions,definition.dimensions.map(name=>({name})));assert.deepEqual(request.metrics,definition.metrics.map(name=>({name})));assert.equal(request.offset,'1000');assert.equal(request.limit,'1000');assert.equal(request.returnPropertyQuota,true);assert.equal(request.keepEmptyRows,true);
    assert.deepEqual(request.orderBys,definition.dimensions.map(dimensionName=>({dimension:{dimensionName,orderType:'ALPHANUMERIC'}})));
    assert.deepEqual(compatibility,{dimensions:request.dimensions,metrics:request.metrics,...report==='ga4_key_events'?{dimensionFilter:request.dimensionFilter}:{}});
    const reply={dimensionCompatibilities:definition.dimensions.map(apiName=>({dimensionMetadata:{apiName},compatibility:'COMPATIBLE'})),metricCompatibilities:definition.metrics.map(apiName=>({metricMetadata:{apiName},compatibility:'COMPATIBLE'}))};
    assert.doesNotThrow(()=>normalizeGoogleCompatibility(report,reply));assert.doesNotThrow(()=>normalizeGoogleCompatibility(report,{...reply,metricCompatibilities:[...reply.metricCompatibilities].reverse()}));
    assert.doesNotThrow(()=>normalizeGoogleCompatibility(report,{dimensionCompatibilities:[...reply.dimensionCompatibilities,{dimensionMetadata:{apiName:'unselectedDimension'},compatibility:'INCOMPATIBLE'}],metricCompatibilities:[...reply.metricCompatibilities,...Array.from({length:100},(_,index)=>({metricMetadata:{apiName:'unselectedMetric'+index},compatibility:index%2?'COMPATIBLE':'INCOMPATIBLE'}))]}));
    for(const mutate of [(v:any)=>{v.metricCompatibilities.pop();},(v:any)=>{v.dimensionCompatibilities[0].compatibility='INCOMPATIBLE';},(v:any)=>{v.metricCompatibilities[0].compatibility='COMPATIBILITY_UNSPECIFIED';},(v:any)=>{v.metricCompatibilities[1]=v.metricCompatibilities[0];},(v:any)=>{v.dimensionCompatibilities[0].dimensionMetadata.apiName='foreign';}]){const invalid=structuredClone(reply);mutate(invalid);assert.throws(()=>normalizeGoogleCompatibility(report,invalid),{status:502});}
  }
  assert.deepEqual(googleReportRequest('ga4_key_events','2024-03-01','2024-03-01',0).dimensionFilter,{filter:{fieldName:'isKeyEvent',stringFilter:{matchType:'EXACT',value:'true',caseSensitive:true}}});
  assert.throws(()=>googleCompatibilityRequest('ga4_events','2024-03-01','2024-03-01'),{status:400});
});

test('GA4 nonempty rows require a provider total; detailed reports bind key state and money provenance',()=>{
  for(const report of [...ga4InventoryReports,'ga4_events'] as const){
    const definition=googleReports[report],reply={dimensionHeaders:definition.dimensions.map(name=>({name})),metricHeaders:definition.metrics.map(name=>({name})),rowCount:1,metadata:{timeZone:'America/New_York',currencyCode:'AED'},rows:[{dimensionValues:definition.dimensions.map(name=>({value:name==='date'?'20240301':name==='isKeyEvent'?'true':name==='sessionMedium'?'':name==='sessionCampaignName'?'(not set)':'sample'})),metricValues:definition.metrics.map(name=>({value:name==='totalRevenue'?'-9007199254740993.1250':name==='keyEvents'?'0.5':'0'}))}]};
    const page=normalizeGoogleReport(report,reply,'2024-03-01','2024-03-01');assert.equal(page.rowCount,1);assert.equal(page.rows[0].metrics.keyEvents,'0.5');assert.deepEqual(normalizeGoogleReport(report,{},'2024-03-01','2024-03-01').rows,[]);
    const {rowCount,...withoutCount}=reply;assert.throws(()=>normalizeGoogleReport(report,withoutCount,'2024-03-01','2024-03-01'),{status:502});assert.throws(()=>normalizeGoogleReport(report,{...reply,rowCount:0},'2024-03-01','2024-03-01'),{status:502});
    if(report!=='ga4_events'){
      assert.equal(page.rows[0].metrics.totalRevenue,'-9007199254740993.1250');const noZone=structuredClone(reply);delete(noZone.metadata as any).timeZone;assert.throws(()=>normalizeGoogleReport(report,noZone,'2024-03-01','2024-03-01'),{status:502});const noCurrency=structuredClone(reply);delete(noCurrency.metadata as any).currencyCode;assert.throws(()=>normalizeGoogleReport(report,noCurrency,'2024-03-01','2024-03-01'),{status:502});
      const restricted={...noCurrency,metadata:{...noCurrency.metadata,schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'totalRevenue',restrictedMetricTypes:['REVENUE_DATA']}]}}};assert.equal(normalizeGoogleReport(report,restricted,'2024-03-01','2024-03-01').rows[0].metrics.totalRevenue,null);
    }
    if(report==='ga4_key_events'){const invalid=structuredClone(reply);invalid.rows[0].dimensionValues[2].value='false';assert.throws(()=>normalizeGoogleReport(report,invalid,'2024-03-01','2024-03-01'),{status:502});}
  }
});

test('GSC keeps unknown position and absent rows distinct from zero', () => {
  const row = normalizeGoogleReport('gsc_daily', { rows: [{ keys: ['2024-03-01'], clicks: 0, impressions: 10, ctr: 0 }] }, '2024-03-01', '2024-03-01');
  assert.equal(row.rows[0].metrics.clicks, '0'); assert.equal(row.rows[0].metrics.position, null); assert.equal(row.quality.metadata.timeZone, 'America/Los_Angeles');
  assert.equal(normalizeGoogleReport('gsc_daily', {}, '2024-03-01', '2024-03-01').rows.length, 0);
  for (const invalid of [{ keys: ['2024-02-29'], clicks: 1, impressions: 10, ctr: .1 }, { keys: ['2024-03-01'], clicks: -1, impressions: 10, ctr: 0 }, { keys: [], clicks: 1, impressions: 10, ctr: 0 }]) assert.throws(() => normalizeGoogleReport('gsc_daily', { rows: [invalid] }, '2024-03-01', '2024-03-01'), { status: 502 });
});

test('GA4 preserves exact metric strings, restrictions and quality; rejects confused report schemas', () => {
  const input = { dimensionHeaders: [{ name: 'date' }, { name: 'eventName' }], metricHeaders: [{ name: 'eventCount' }, { name: 'keyEvents' }, { name: 'totalUsers' }],
    rows: [{ dimensionValues: [{ value: '20240301' }, { value: 'signup' }], metricValues: [{ value: '9007199254740993' }, { value: '0' }, { value: '4' }] }], rowCount: 1,
    metadata: { timeZone: 'Asia/Dubai', subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }], schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'keyEvents', restrictedMetricTypes: ['REVENUE_DATA'] }] } } };
  const page = normalizeGoogleReport('ga4_events', input, '2024-03-01', '2024-03-01');
  assert.equal(page.rows[0].dimensions.date, '2024-03-01'); assert.equal(page.rows[0].metrics.eventCount, '9007199254740993'); assert.equal(page.rows[0].metrics.keyEvents, null); assert.equal(page.quality.warnings.length, 4);
  assert.throws(() => normalizeGoogleReport('ga4_traffic', input, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [...input.rows, ...input.rows] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [{ ...input.rows[0], metricValues: [{ value: '' }, { value: '0' }, { value: '1' }] }] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.throws(() => normalizeGoogleReport('ga4_events', { ...input, rows: [{ ...input.rows[0], metricValues: [{ value: '1\n' }, { value: '0' }, { value: '1' }] }] }, '2024-03-01', '2024-03-01'), { status: 502 });
  assert.deepEqual(normalizeGoogleReport('ga4_events', {}, '2024-03-01', '2024-03-01').rows, []);
});

test('Organic fixed requests separate complete range aggregates from daily/weekly trends', () => {
  const metrics=['sessions','activeUsers','engagedSessions','engagementRate','keyEvents','transactions','purchaseRevenue'];
  for(const report of ['ga4_organic_daily','ga4_organic_weekly'] as const)for(const stage of ['current','previous','trend'] as const){
    const body=googleReportRequest(report,'2024-03-01','2024-03-02',0,stage);
    assert.deepEqual(body.metrics,metrics.map(name=>({name})));assert.deepEqual(body.dimensions,stage==='trend'?[{name:report==='ga4_organic_daily'?'date':'yearWeek'}]:[]);
    assert.deepEqual(body.dateRanges,[stage==='previous'?{startDate:'2024-02-28',endDate:'2024-02-29'}:{startDate:'2024-03-01',endDate:'2024-03-02'}]);
    assert.deepEqual(body.dimensionFilter,{filter:{fieldName:'sessionDefaultChannelGroup',stringFilter:{matchType:'EXACT',value:'Organic Search',caseSensitive:true}}});
    assert.equal(body.offset,'0');assert.equal(body.limit,'1000');assert.equal(body.keepEmptyRows,true);
  }
  const landing=googleReportRequest('ga4_organic_landing','2024-03-01','2024-03-02',1000);
  assert.deepEqual(landing.dimensions,[{name:'hostName'},{name:'landingPage'}]);assert.deepEqual(landing.metrics,[...metrics.slice(0,5),'sessionKeyEventRate','transactions','purchaseRevenue'].map(name=>({name})));assert.equal(landing.offset,'1000');
  const compatibility={metricCompatibilities:metrics.map(apiName=>({metricMetadata:{apiName},compatibility:'COMPATIBLE'}))};
  assert.doesNotThrow(()=>normalizeGoogleCompatibility('ga4_organic_daily',compatibility,'current'));
  assert.throws(()=>normalizeGoogleCompatibility('ga4_organic_daily',compatibility,'trend'),{status:502});
  assert.throws(()=>googleReportRequest('ga4_events','2024-03-01','2024-03-02',0,'current'),{status:400});
});

test('Organic dates require completed property days and a representable equal prior range',()=>{
  assert.deepEqual(organicPreviousRange('2024-03-01','2024-03-02'),{from:'2024-02-28',to:'2024-02-29'});
  assert.deepEqual(organicPreviousRange('2024-01-01','2024-01-01'),{from:'2023-12-31',to:'2023-12-31'});
  for(const date of ['0000-01-01','0001-01-01'])assert.throws(()=>organicPreviousRange(date,date),{status:400});
  assert.throws(()=>validateOrganicDates('2024-03-09','2024-03-10','America/New_York',new Date('2024-03-11T02:00:00Z')),{status:400});
  assert.doesNotThrow(()=>validateOrganicDates('2024-03-09','2024-03-10','America/New_York',new Date('2024-03-11T04:00:00Z')));
  assert.throws(()=>validateOrganicDates('2024-03-01','2024-03-02','Invalid/Zone'),{status:409});
  assert.equal(organicWeek('2024-01-01'),'202401');assert.equal(organicWeek('2024-01-07'),'202402');assert.equal(organicWeek('2023-12-31'),'202353');
});

test('Organic aggregates preserve exact native users, signed money, restrictions and unknown empty results',()=>{
  const metrics=['sessions','activeUsers','engagedSessions','engagementRate','keyEvents','transactions','purchaseRevenue'];
  const reply={metricHeaders:metrics.map(name=>({name})),rows:[{metricValues:['20','11','10','0.5','0.5','0','-9007199254740993.1250'].map(value=>({value}))}],rowCount:1,metadata:{timeZone:'America/New_York',currencyCode:'AED'}};
  const page=normalizeGoogleReport('ga4_organic_daily',reply,'2024-03-01','2024-03-02',undefined,'current');assert.deepEqual(page.rows[0].dimensions,{});assert.equal(page.rows[0].metrics.activeUsers,'11');assert.equal(page.rows[0].metrics.purchaseRevenue,'-9007199254740993.1250');assert.equal(page.rows[0].metrics.transactions,'0');
  assert.deepEqual(normalizeGoogleReport('ga4_organic_daily',{},'2024-03-01','2024-03-02',undefined,'current').rows,[]);
  const restricted={...reply,metadata:{timeZone:'America/New_York',schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'purchaseRevenue',restrictedMetricTypes:['REVENUE_DATA']}]}}};assert.equal(normalizeGoogleReport('ga4_organic_daily',restricted,'2024-03-01','2024-03-02',undefined,'current').rows[0].metrics.purchaseRevenue,null);
  for(const mutate of [(v:any)=>v.rowCount=2,(v:any)=>v.rows.push(v.rows[0]),(v:any)=>v.dimensionHeaders=[{name:'date'}],(v:any)=>v.metricHeaders.reverse(),(v:any)=>v.rows[0].metricValues[3].value='1.1',(v:any)=>v.rows[0].metricValues[3].value='1.0000000000000001',(v:any)=>v.rows[0].metricValues[0].value='-1e-400',(v:any)=>v.rows[0].metricValues[0].value='-1',(v:any)=>delete v.metadata.currencyCode]){const bad=structuredClone(reply);mutate(bad);assert.throws(()=>normalizeGoogleReport('ga4_organic_daily',bad,'2024-03-01','2024-03-02',undefined,'current'),{status:502});}
  const trend={...reply,dimensionHeaders:[{name:'date'}],rows:[{...reply.rows[0],dimensionValues:[{value:'20240301'}]}]};assert.equal(normalizeGoogleReport('ga4_organic_daily',trend,'2024-03-01','2024-03-02').rows.length,1);assert.throws(()=>normalizeGoogleReport('ga4_organic_daily',{...trend,rowCount:1001},'2024-03-01','2024-03-02'),{status:502});
});
