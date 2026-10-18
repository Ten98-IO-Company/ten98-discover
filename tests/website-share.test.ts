import assert from 'node:assert/strict';
import test from 'node:test';
import {parseHostedBoardShare,parseHostedWebsiteShare,scrubMalformedHostedBoardShareFragment} from '../src/lib/boards.ts';
import {decodePublicWebsiteShare,projectWebsiteShare,websiteShareCreate,websiteShareRead,websiteShareSections,type PublicWebsiteShare,type WebsiteShareSection} from '../src/lib/website-shares.ts';
import {canonicalShareToken} from '../src/server/website-shares.ts';
import type {AnalyticsReport} from '../src/lib/analytics-comparison.ts';
import type {GeographyRow} from '../src/lib/analytics-geography.ts';

const shareId='45000000-0000-4000-8000-000000000001',token='A'.repeat(43),range={from:'2026-01-01',to:'2026-01-02'},future=new Date(Date.now()+86_400_000).toISOString();
const geo=(key:GeographyRow['key'],regionName:string|null,pageViews:number):GeographyRow=>({key,regionName,pageViews,identifiedPageViews:pageViews,visitors:1,visits:1,bounceRate:0,averageVisitSeconds:2});
const environmentRow=(value:string|null,pageViews:number)=>({value,pageViews,identifiedPageViews:pageViews,visitors:1,visits:1,bounceRate:100,averageVisitSeconds:0});
function report():AnalyticsReport{
 const berlin={kind:'code' as const,value:'DE-BE'};
 return {range:{...range,timeZone:'UTC'},totals:{pageViews:5,customEvents:2},coverage:{status:'partial',retainedFrom:'2026-01-01T12:00:00.123456Z'},
  collection:{mode:'consent-first',captureCoverage:'unknown',pageViews:{cookieless:1,consent:4,unknown:0}},
  measurement:{version:'umami-3.4-hour-cache-v1',identifiedPageViews:4,unidentifiedPageViews:1,visitors:2,visits:3,bounceRate:33.333,averageVisitSeconds:12.5},
  daily:[{date:'2026-01-01',pageViews:3,customEvents:1,coverage:'partial'},{date:'2026-01-02',pageViews:2,customEvents:1,coverage:'complete'}],
  pages:[{path:'/pricing',pageViews:3}],referrers:[{host:'search.example',pageViews:2,visitors:1}],events:[{name:'signup',count:2}],lastReceivedAt:'2026-01-02T10:00:00.000Z',
  environment:{version:'server-ua-environment-v1',filters:{},browsers:[environmentRow('chrome',4),environmentRow(null,1)],operatingSystems:[environmentRow('Linux',5)],devices:[environmentRow('desktop',5)],
   coverage:{pageViews:5,recordedPageViews:4,notRecordedPageViews:1,firstRecordedAt:'2026-01-01T12:00:01.000Z'},method:{source:'bounded-request-user-agent',device:'ua-parser-v1-screen-if-enabled',rawUserAgentStored:false}},
  geography:{version:'native-geography-report-v1',filters:{},
   countries:{rows:[geo({state:'known',country:'DE'},null,3),geo({state:'not-recorded'},null,2)],limit:678,totalGroups:2,returnedPageViews:5,truncated:false},
   regions:{rows:[geo({state:'known',country:'DE',region:berlin},'Berlin',3)],limit:100,totalGroups:1,returnedPageViews:3,truncated:false},
   cities:{rows:[geo({state:'known',country:'DE',region:berlin,city:'Berlin'},'Berlin',3)],limit:100,totalGroups:1,returnedPageViews:3,truncated:false},
   coverage:{status:'partial',pageViews:5,recordedPageViews:3,notRecordedPageViews:2,knownCountryPageViews:3,knownRegionPageViews:3,knownCityPageViews:3,firstRecordedAt:'2026-01-01T12:00:01.000Z'},
   provenance:{source:'db-ip-city-lite',databaseCount:1,oldestDatabaseBuild:1700000000,newestDatabaseBuild:1700000000},method:{approximate:true,rawIpStored:false,coordinatesStored:false}}};
}
const subsets=Array.from({length:7},(_,mask)=>websiteShareSections.filter((_,bit)=>((mask+1)>>bit)&1));
const grant=(sections:readonly WebsiteShareSection[])=>({id:shareId,label:'Quarterly website',sections:[...sections].sort(),expiresAt:future});

test('Hosted website links are /share/websites/{lowercase uuid} with a canonical fragment secret only',()=>{
 const path='/share/websites/'+shareId,expected={shareId,token};
 assert.deepEqual(parseHostedWebsiteShare(path,'','#'+token),expected);assert.deepEqual(parseHostedWebsiteShare(path,'',token),expected);
 for(const search of ['?','?token='+token,'?view=share'])assert.equal(parseHostedWebsiteShare(path,search,'#'+token),null);
 for(const fragment of ['','#',token+'=',token.slice(1),'A'.repeat(42)+'B','#'+token+'x','%41'.repeat(43),token+'\n'])assert.equal(parseHostedWebsiteShare(path,'',fragment),null);
 for(const invalid of [path+'/',path+'/read','/share/websites/ABCDEF00-0000-4000-8000-00000000000A','/share/websites/label-'+shareId,'/share/'+shareId,'/share/boards/label-'+shareId,'/share/websites/not-a-share-id'])assert.equal(parseHostedWebsiteShare(invalid,'','#'+token),null);
 assert.equal(parseHostedBoardShare(path,'','#'+token),null,'A website link is never a board capability.');
});

test('Router preflight scrubs only malformed website fragments and leaves valid website and board links untouched',()=>{
 const pathname='/share/websites/'+shareId,state={unchanged:'entry'},calls:Array<{state:unknown;url:string|URL|null|undefined}>=[];
 const history={state,replaceState:(value:unknown,unused:string,url?:string|URL|null)=>{assert.equal(unused,'');calls.push({state:value,url});}};
 scrubMalformedHostedBoardShareFragment({pathname,search:'',hash:'#'+token},history);scrubMalformedHostedBoardShareFragment({pathname,search:'',hash:''},history);
 scrubMalformedHostedBoardShareFragment({pathname:'/share/boards/quarterly-'+shareId,search:'',hash:'#'+token},history);
 for(const path of ['/','/share/websites','/share/website/'+shareId])scrubMalformedHostedBoardShareFragment({pathname:path,search:'',hash:'#%41'},history);
 assert.equal(calls.length,0);
 for(const hash of ['#'+'%41'.repeat(43),'#'+token+'=','#'+'A'.repeat(42)+'B','#invalid']){scrubMalformedHostedBoardShareFragment({pathname,search:'',hash},history);assert.equal(calls.at(-1)!.state,state);assert.equal(calls.at(-1)!.url,pathname);}
 scrubMalformedHostedBoardShareFragment({pathname,search:'?x=1',hash:'#'+token},history);assert.equal(calls.length,5);assert.equal(calls.at(-1)!.url,pathname+'?x=1');
});

test('Every section subset projects exactly its declared display fields and nothing private',()=>{
 assert.equal(subsets.length,7);
 for(const sections of subsets){
  const value=projectWebsiteShare(grant(sections),report());assert.ok(value,sections.join());
  assert.deepEqual(Object.keys(value).sort(),['coverage','expiresAt','label','range','sections','shareId','version',...sections].sort());
  assert.deepEqual(value.range,{...range,timeZone:'UTC'});assert.deepEqual(value.coverage,{status:'partial',retainedFrom:'2026-01-01T12:00:00.123456Z'});
  if(value.overview){
   assert.deepEqual(Object.keys(value.overview).sort(),['averageVisitSeconds','bounceRate','browsers','countries','daily','devices','operatingSystems','pageViews','pages','referrers','visitors','visits']);
   assert.deepEqual(value.overview.daily,[{date:'2026-01-01',pageViews:3,coverage:'partial'},{date:'2026-01-02',pageViews:2,coverage:'complete'}]);
   assert.deepEqual(value.overview.browsers,[{value:'chrome',pageViews:4,visitors:1},{value:null,pageViews:1,visitors:1}]);
   assert.deepEqual(value.overview.countries,[{key:{state:'known',country:'DE'},pageViews:3,visitors:1},{key:{state:'not-recorded'},pageViews:2,visitors:1}]);
  }
  if(value.events)assert.deepEqual(value.events,{customEvents:2,daily:[{date:'2026-01-01',customEvents:1,coverage:'partial'},{date:'2026-01-02',customEvents:1,coverage:'complete'}],names:[{name:'signup',count:2}]});
  if(value.locations)assert.deepEqual(Object.keys(value.locations.cities[0]).sort(),['key','pageViews','regionName','visitors']);
  const wire=JSON.stringify(value);
  for(const privateKey of ['lastReceivedAt','collection','identifiedPageViews','unidentifiedPageViews','provenance','firstRecordedAt','filters','method','consent','cookieless','visits":1','bounceRate":0','averageVisitSeconds":2','databaseCount','totalGroups'])assert.equal(wire.includes(privateKey),false,privateKey+' in '+sections.join());
  if(!sections.includes('locations'))assert.equal(wire.includes('Berlin'),false,'Regions and cities appear only with the locations section.');
  assert.deepEqual(decodePublicWebsiteShare(JSON.parse(wire),shareId,range),value);
 }
});

test('The recipient decoder refuses undeclared keys, section mismatches, foreign shares, other ranges, unknown labels, expiry and oversize payloads',()=>{
 const value=projectWebsiteShare(grant(['overview','events','locations']),report())!,copy=()=>JSON.parse(JSON.stringify(value)) as PublicWebsiteShare&Record<string,unknown>;
 assert.ok(decodePublicWebsiteShare(copy(),shareId,range));
 const extraNested=copy();(extraNested.overview!.pages[0] as Record<string,unknown>).visitorId='v';assert.equal(decodePublicWebsiteShare(extraNested,shareId,range),null);
 const extraTop=copy();extraTop.projectId=shareId;assert.equal(decodePublicWebsiteShare(extraTop,shareId,range),null);
 const missing=copy();delete missing.events;assert.equal(decodePublicWebsiteShare(missing,shareId,range),null,'A granted section must be present.');
 const ungranted=copy();ungranted.sections=['overview'];assert.equal(decodePublicWebsiteShare(ungranted,shareId,range),null,'An ungranted section must be absent.');
 const duplicate=copy();duplicate.sections=['events','events','locations','overview'] as WebsiteShareSection[];assert.equal(decodePublicWebsiteShare(duplicate,shareId,range),null);
 assert.equal(decodePublicWebsiteShare(copy(),'45000000-0000-4000-8000-000000000002',range),null,'A foreign share is refused.');
 assert.equal(decodePublicWebsiteShare(copy(),shareId,{from:'2026-01-01',to:'2026-01-03'}),null,'Another range is refused.');
 const browser=copy();(browser.overview!.browsers[0] as unknown as {value:string}).value='netscape';assert.equal(decodePublicWebsiteShare(browser,shareId,range),null,'Environment values come from the fixed catalog.');
 const region=copy();(region.locations!.regions[0] as {key:unknown}).key={state:'known',country:'DE',region:{kind:'code',value:'FR-75'}};assert.equal(decodePublicWebsiteShare(region,shareId,range),null);
 assert.equal(decodePublicWebsiteShare(copy(),shareId,range,Date.parse(future)),null,'An expired share is refused.');
 const large=copy();large.label='x'.repeat(2*1024*1024);assert.equal(decodePublicWebsiteShare(large,shareId,range),null);
 const unsafeReport=report();unsafeReport.environment.devices=[environmentRow('toaster',1)];assert.equal(projectWebsiteShare(grant(['overview']),unsafeReport),null,'The server never publishes an unverifiable value.');
 const negative=report();negative.totals.pageViews=-1;assert.equal(projectWebsiteShare(grant(['overview']),negative),null);
 assert.ok(projectWebsiteShare(grant(['events']),unsafeReport),'An ungranted section is never read, so its values cannot refuse the read.');
});

test('Create and read bodies are strict; tokens are canonical 32-byte base64url secrets',()=>{
 const body={requestId:shareId.toUpperCase(),label:'  Launch  ',sections:['overview','events'],expiresAt:future,token};
 assert.deepEqual(websiteShareCreate.parse(body),{...body,requestId:shareId,label:'Launch',sections:['events','overview']});
 for(const change of [{sections:[]},{sections:['overview','overview']},{sections:['sessions']},{label:'   '},{label:'x'.repeat(121)},{expiresAt:'2026-01-01T00:00:00Z'},{token:'A'.repeat(42)+'B'},{token:token+'A'},{extra:true}])assert.equal(websiteShareCreate.safeParse({...body,...change}).success,false,JSON.stringify(change));
 assert.equal(canonicalShareToken(token),true);for(const value of ['A'.repeat(42)+'B',token+'=',token+'\n','A'.repeat(42)+'+',null,43])assert.equal(canonicalShareToken(value),false,String(value));
 assert.deepEqual(websiteShareRead.parse(range),range);for(const extra of [{compare:'prev'},{dimension:'path'},{browser:'chrome'},{path:'/'},{timeZone:'UTC'}])assert.equal(websiteShareRead.safeParse({...range,...extra}).success,false);
});
