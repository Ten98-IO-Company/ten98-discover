import assert from 'node:assert/strict';
import {test} from 'node:test';
import {googleAdsVersion,googleImportInput,googleReportRequest,googleScopes,normalizeGoogleReport} from '../src/server/google-reports.ts';
import {googleRequest,withGoogleTransportForTests} from '../src/server/google-http.ts';

const from='2024-03-01',customer='1234567890',url=`https://googleads.googleapis.com/${googleAdsVersion}/customers/${customer}/googleAds:search`;
const row=(id='1')=>({segments:{date:from},customer:{id:customer},campaign:{id,name:'A & العربية',status:'PAUSED'},metrics:{impressions:'9007199254740993',clicks:'0',costMicros:'9007199254740994',conversions:0.5,conversionsValue:2.25}});
test('Ads queries are fixed reporting-only and preserve legacy provider/date contracts',()=>{
 assert.equal(googleScopes.ads,'https://www.googleapis.com/auth/adwords');
 for(const report of ['ads_daily','ads_campaigns','ads_ad_groups'] as const){
  assert.equal(googleImportInput.safeParse({requestId:'cd81b617-b38c-4b15-9d63-49332908d09a',report,from,to:from}).success,true);
  const request=googleReportRequest(report,from,from,0);assert.ok(request.query?.startsWith('SELECT '));assert.ok(request.query?.includes("segments.date BETWEEN '2024-03-01' AND '2024-03-01'"));assert.deepEqual(request.searchSettings,{returnTotalResultsCount:true});assert.equal(Object.hasOwn(request,'pageSize'),false);assert.equal(Object.hasOwn(request,'pageToken'),false);
  assert.throws(()=>googleReportRequest(report,"2024-03-01' OR 1=1",from,0),{status:400});assert.throws(()=>googleReportRequest(report,from,from,1000),{status:400});
 }
 assert.equal(googleReportRequest('gsc_daily',from,from,1000).startRow,1000);assert.equal(googleReportRequest('ga4_events',from,from,1000).offset,'1000');
});
test('Ads exact integer amounts, fractional conversions, unavailable metrics and source binding',()=>{
 const page=normalizeGoogleReport('ads_campaigns',{results:[row()],totalResultsCount:'1'},from,from,customer);
 assert.deepEqual(page.rows[0],{dimensions:{date:from,customerId:customer,campaignId:'1',campaignName:'A & العربية',campaignStatus:'PAUSED'},metrics:{impressions:'9007199254740993',clicks:'0',costMicros:'9007199254740994',conversions:'0.5',conversionsValue:'2.25'}});assert.equal(page.complete,true);assert.equal(page.rowCount,1);
 assert.equal(normalizeGoogleReport('ads_campaigns',{results:[{...row(),metrics:{clicks:'0'}}]},from,from,customer).rows[0].metrics.costMicros,null);
 assert.deepEqual(normalizeGoogleReport('ads_daily',{totalResultsCount:'0'},from,from,customer).rows,[]);
 for(const value of [{results:[{...row(),customer:{id:'9876543210'}}]},{results:[{...row(),segments:{date:'2024-02-29'}}]},{results:[row(),row()]},{results:[{...row(),metrics:{clicks:9007199254740993}}]},{results:[row()],totalResultsCount:'0'},{results:[row()],totalResultsCount:'2'},{results:[],nextPageToken:'more'}])assert.throws(()=>normalizeGoogleReport('ads_campaigns',value,from,from,customer),{status:502});
 assert.throws(()=>normalizeGoogleReport('ads_campaigns',{results:[row()]},from,from),{status:502});
 assert.throws(()=>normalizeGoogleReport('ads_campaigns',{results:[row(),{...row(),campaign:{...row().campaign,name:'renamed',status:'ENABLED'}}]},from,from,customer),{status:502});
 assert.equal(normalizeGoogleReport('ads_campaigns',{results:[row('1'),row('2')]},from,from,customer).rows.length,2);
 assert.throws(()=>normalizeGoogleReport('ads_ad_groups',{results:[{...row(),adGroup:{id:'9',name:'original'}},{...row(),adGroup:{id:'9',name:'renamed',status:'PAUSED'}}]},from,from,customer),{status:502});
 const adGroup=normalizeGoogleReport('ads_ad_groups',{results:[{...row(),adGroup:{id:'9',name:'Ad group',status:'ENABLED'}}]},from,from,customer);assert.equal(adGroup.rows[0].dimensions.adGroupId,'9');
});
test('Native ten-thousand-row provider page retains explicit incomplete and count evidence',()=>{
 const results=Array.from({length:10000},(_,i)=>row(String(i+1))),page=normalizeGoogleReport('ads_campaigns',{results,nextPageToken:'opaque-not-stored',totalResultsCount:'10001'},from,from,customer);
 assert.equal(page.rows.length,10000);assert.equal(page.complete,false);assert.equal(page.rowCount,10001);assert.equal(page.quality.metadata.nextPageAvailable,true);assert.equal(page.quality.metadata.totalResultsCount,'10001');assert.equal(JSON.stringify(page).includes('opaque-not-stored'),false);
 assert.throws(()=>normalizeGoogleReport('ads_campaigns',{results:[...results,row('10001')]},from,from,customer),{status:502});
 assert.throws(()=>normalizeGoogleReport('ads_campaigns',{results,nextPageToken:'more',totalResultsCount:'10000'},from,from,customer),{status:502});
 const huge=normalizeGoogleReport('ads_campaigns',{results:[row()],nextPageToken:'more',totalResultsCount:'9007199254740993'},from,from,customer);assert.equal(huge.rowCount,null);assert.equal(huge.quality.metadata.totalResultsCount,'9007199254740993');
});
test('Ads transport isolates secrets and fixed read endpoints; malformed and oversized bodies refuse',async()=>{
 const names=['TEN98_INTEGRATION_TEST','APP_URL','DATABASE_URL','AUTH_SECRET','BOOTSTRAP_TOKEN'] as const,previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));Object.assign(process.env,{TEN98_INTEGRATION_TEST:'1',APP_URL:'http://127.0.0.1:3012',DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:55501/not_opened',AUTH_SECRET:'synthetic-only-auth-secret-32-characters',BOOTSTRAP_TOKEN:'synthetic-only-bootstrap-32-characters'});
 try{
  let calls=0;await withGoogleTransportForTests(async(actual,init)=>{calls++;assert.equal(actual,url);const h=new Headers(init.headers);assert.equal(h.get('authorization'),'Bearer synthetic-access');assert.equal(h.get('developer-token'),'synthetic-developer');assert.equal(h.get('login-customer-id'),'9876543210');assert.equal(init.redirect,'error');return Response.json({results:[]});},async()=>{assert.deepEqual(await googleRequest(url,'synthetic-access',{query:'SELECT customer.id FROM customer'},{developerToken:'synthetic-developer',loginCustomerId:'9876543210'}),{results:[]});});assert.equal(calls,1);
  for(const target of [url.replace(':search',':mutate'),url+'?redirect=1',url.replace('googleads.googleapis.com','evil.test'),url.replace('v26','v25')])await assert.rejects(googleRequest(target,'synthetic-access',{}, {developerToken:'synthetic-developer'}),/Invalid Google endpoint/);
  await assert.rejects(googleRequest('https://oauth2.googleapis.com/token',undefined,{}, {developerToken:'synthetic-developer'}),/Invalid Google endpoint/);await assert.rejects(googleRequest(url,'synthetic-access',{}),/Invalid Google endpoint/);
  for(const response of [()=>new Response(Uint8Array.from([123,34,120,34,58,34,0xc3,0x28,34,125])),()=>new Response(' '.repeat(2097153)),()=>new Response(null,{status:302,headers:{location:'https://evil.test'}})])await withGoogleTransportForTests(async()=>response(),async()=>{await assert.rejects(googleRequest(url,'synthetic-access',{}, {developerToken:'synthetic-developer'}),{status:502});});
 }finally{for(const n of names){if(previous[n]===undefined)delete process.env[n];else process.env[n]=previous[n];}}
});
