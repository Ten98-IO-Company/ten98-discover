import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleImportInput, googleReportRequest, googleCompatibilityRequest, normalizeGoogleCompatibility, normalizeGoogleReport } from '../src/server/google-reports.ts';
import { ga4CommerceReports, isGa4CommerceReport, googleGa4ColumnLabel, googleGa4MetricValue } from '../src/lib/google-report-display.ts';

// Independent contract literals: a catalog typo must fail, not update the fixture.
const profiles = {
  ga4_ecommerce_items: { dimensions: ['itemName','itemId'], metrics: ['itemsViewed','itemsAddedToCart','itemsPurchased','itemRevenue'] },
  ga4_ecommerce_landing: { dimensions: ['hostName','landingPage'], metrics: ['sessions','transactions','purchaseRevenue'] },
  ga4_site_search: { dimensions: ['searchTerm'], metrics: ['eventCount','activeUsers','sessions','engagedSessions','engagementRate'] },
  ga4_audience_device: { dimensions: ['deviceCategory'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
  ga4_audience_country: { dimensions: ['country'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
  ga4_audience_returning: { dimensions: ['newVsReturning'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
} as const;
type Report = keyof typeof profiles;
const reports = Object.keys(profiles) as Report[], from = '2024-03-01', to = '2024-03-10';
const filter = { andGroup: { expressions: [
  { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_search_results', caseSensitive: true } } },
  { notExpression: { filter: { fieldName: 'searchTerm', stringFilter: { matchType: 'EXACT', value: '(not set)', caseSensitive: true } } } },
] } };
function reply(report: Report) {
  const p = profiles[report];
  return { dimensionHeaders: p.dimensions.map(name=>({name})), metricHeaders: p.metrics.map(name=>({name})), rowCount: 1,
    rows: [{ dimensionValues: p.dimensions.map(name=>({value: name==='newVsReturning'?'returning':name==='deviceCategory'?'mobile':name==='country'?'United Arab Emirates':name==='landingPage'?'/shop':name==='hostName'?'shop.example.test':'term 🛒'})),
      metricValues: p.metrics.map(name=>({value: name==='itemRevenue'||name==='purchaseRevenue'?'-9007199254740993.1250':name==='engagementRate'?'0.5':name==='keyEvents'?'0.25':name==='activeUsers'?'9007199254740993':'0'})) }],
    metadata: { timeZone: 'America/New_York', currencyCode: 'AED' }, propertyQuota: {tokensPerDay:{consumed:1,remaining:199999}} };
}

test('six closed GA4 range profiles emit exact native fields, filters and stable paging without injecting dates',()=>{
  assert.deepEqual(Object.keys(ga4CommerceReports),reports);
  for(const report of reports){
    const p=profiles[report],body=googleReportRequest(report,from,to,1000),input={requestId:'cd81b617-b38c-4b15-9d63-49332908d09a',report,from,to};
    assert.deepEqual(body,{dateRanges:[{startDate:from,endDate:to}],dimensions:p.dimensions.map(name=>({name})),metrics:p.metrics.map(name=>({name})),orderBys:p.dimensions.map(dimensionName=>({dimension:{dimensionName,orderType:'ALPHANUMERIC'}})),offset:'1000',limit:'1000',returnPropertyQuota:true,keepEmptyRows:true,...report==='ga4_site_search'?{dimensionFilter:filter}:{}});
    assert.equal(googleImportInput.safeParse(input).success,true);
    for(const extra of [{channel:'Organic Search'},{dimension:'audienceName'},{filter:{}},{property:'properties/999'},{limit:100000}])assert.equal(googleImportInput.safeParse({...input,...extra}).success,false);
    assert.throws(()=>googleReportRequest(report,from,to,0,'current'),{status:400});
  }
  for(const name of ['ga4_ecommerce','ga4_siteSearch','constructor','__proto__'])assert.equal(isGa4CommerceReport(name),false);
});

test('commerce compatibility uses the exact selected fields and search filter without fallback',()=>{
  for(const report of reports){
    const p=profiles[report],expected={dimensions:p.dimensions.map(name=>({name})),metrics:p.metrics.map(name=>({name})),...report==='ga4_site_search'?{dimensionFilter:filter}:{}};
    assert.deepEqual(googleCompatibilityRequest(report,from,to),expected);
    const value={dimensionCompatibilities:p.dimensions.map(apiName=>({dimensionMetadata:{apiName},compatibility:'COMPATIBLE'})),metricCompatibilities:p.metrics.map(apiName=>({metricMetadata:{apiName},compatibility:'COMPATIBLE'}))};
    assert.doesNotThrow(()=>normalizeGoogleCompatibility(report,value));
    assert.doesNotThrow(()=>normalizeGoogleCompatibility(report,{...value,dimensionCompatibilities:[...value.dimensionCompatibilities,{dimensionMetadata:{apiName:'unrequested'},compatibility:'INCOMPATIBLE'}]}));
    for(const mutate of [(v:any)=>v.metricCompatibilities.pop(),(v:any)=>v.dimensionCompatibilities[0].compatibility='INCOMPATIBLE',(v:any)=>v.metricCompatibilities.push(v.metricCompatibilities[0]),(v:any)=>v.dimensionCompatibilities[0].dimensionMetadata.apiName='unknown']){const bad=structuredClone(value);mutate(bad);assert.throws(()=>normalizeGoogleCompatibility(report,bad),{status:502});}
  }
});

test('range rows keep exact zero, large user counts, fractional credit and signed item/purchase money',()=>{
  for(const report of reports){
    const normalized=normalizeGoogleReport(report,reply(report),from,to);
    assert.equal(normalized.rowCount,1);assert.equal(normalized.rows.length,1);assert.deepEqual(Object.keys(normalized.rows[0].dimensions),profiles[report].dimensions);
    for(const name of profiles[report].metrics){const value=normalized.rows[0].metrics[name];assert.equal(value,name==='itemRevenue'||name==='purchaseRevenue'?'-9007199254740993.1250':name==='engagementRate'?'0.5':name==='keyEvents'?'0.25':name==='activeUsers'?'9007199254740993':'0');}
    assert.equal(normalized.quality.metadata.timeZone,'America/New_York');assert.deepEqual(normalized.quality.metadata.quota,{tokensPerDay:{consumed:1,remaining:199999}});
    assert.deepEqual(normalizeGoogleReport(report,{},from,to).rows,[]);
  }
});

test('selected range rows reject missing counts, swapped headers, duplicates and malformed dimension text',()=>{
  for(const report of reports){
    for(const mutate of [(v:any)=>delete v.rowCount,(v:any)=>v.rowCount=0,(v:any)=>v.metricHeaders.reverse(),(v:any)=>v.rows.push(v.rows[0]),(v:any)=>v.rows[0].dimensionValues[0].value='\ud800',(v:any)=>v.rows[0].dimensionValues[0].value='bad\0value',(v:any)=>v.rows[0].dimensionValues[0].value='x'.repeat(4097),(v:any)=>v.rows[0].metricValues[0].value='NaN']){const bad=reply(report);mutate(bad);assert.throws(()=>normalizeGoogleReport(report,bad,from,to),{status:502});}
    const noZone:any=reply(report);delete noZone.metadata.timeZone;assert.throws(()=>normalizeGoogleReport(report,noZone,from,to),{status:502});
  }
  const wrongSearch=reply('ga4_site_search');wrongSearch.rows[0].dimensionValues[0].value='(not set)';assert.throws(()=>normalizeGoogleReport('ga4_site_search',wrongSearch,from,to),{status:502});
});

test('money requires currency only when available; non-revenue reports do not invent a currency requirement',()=>{
  for(const report of reports){
    const raw:any=reply(report);delete raw.metadata.currencyCode;
    const metric=profiles[report].metrics.find(name=>name==='itemRevenue'||name==='purchaseRevenue');
    if(metric){assert.throws(()=>normalizeGoogleReport(report,raw,from,to),{status:502});raw.metadata.schemaRestrictionResponse={activeMetricRestrictions:[{metricName:metric,restrictedMetricTypes:['REVENUE_DATA']}]};assert.equal(normalizeGoogleReport(report,raw,from,to).rows[0].metrics[metric],null);}
    else assert.equal(normalizeGoogleReport(report,raw,from,to).rows.length,1);
  }
});

test('restricted audience/search values remain unavailable and numeric rates/counts obey their native domains',()=>{
  for(const report of reports){
    const raw:any=reply(report),first=profiles[report].metrics[0];raw.metadata.schemaRestrictionResponse={activeMetricRestrictions:[{metricName:first,restrictedMetricTypes:['USER_DATA']}]};
    const normalized=normalizeGoogleReport(report,raw,from,to);assert.equal(normalized.rows[0].metrics[first],null);assert.match(normalized.quality.warnings.join(' '),/unavailable/);
    raw.metadata.schemaRestrictionResponse=undefined;for(const value of ['-1','-1e-400']){raw.rows[0].metricValues[0].value=value;assert.throws(()=>normalizeGoogleReport(report,raw,from,to),{status:502});}
    const rate=profiles[report].metrics.findIndex(name=>name==='engagementRate');if(rate>=0)for(const value of ['1.00001','1.0000000000000001']){const bad=reply(report);bad.rows[0].metricValues[rate].value=value;assert.throws(()=>normalizeGoogleReport(report,bad,from,to),{status:502});}
  }
});

test('commerce report values carry their source currency and item units without arithmetic or a fabricated audience total',()=>{
  assert.equal(googleGa4MetricValue('itemRevenue','-9007199254740993.1250','AED'),'AED -9007199254740993.1250');
  assert.equal(googleGa4MetricValue('itemRevenue','0','JPY'),'JPY 0');assert.equal(googleGa4MetricValue('itemRevenue',null,'AED'),'Unavailable');
  assert.equal(googleGa4MetricValue('itemRevenue','1.25e+2',null),'1.25e+2 (currency unavailable)');
  assert.equal(googleGa4ColumnLabel('itemsPurchased'),'Item units purchased');assert.equal(googleGa4ColumnLabel('searchTerm'),'Search term');
  assert.match(ga4CommerceReports.ga4_audience_returning.description,/both groups/);assert.match(ga4CommerceReports.ga4_audience_device.description,/do not sum/);
});
