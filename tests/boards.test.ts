import {boardShareCreate,boardSharePublish,boardShareRevoke,decodePublicBoardCard,decodePublicBoardManifest} from '../src/lib/boards.ts';
import {permittedBoardShareScope,projectBoardShareCard} from '../src/server/boards.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {boardCard,boardCardTypes,boardDefinition,boardMetricFields,boardPreviewInput,boardLimits,type BoardCard,type BoardDefinition} from '../src/lib/boards.ts';
import {boardParams,boardScope,parseBoardDefinition,parseBoardPreview,boardAssetQuery} from '../src/server/boards.ts';
import {nativeOpenApi} from '../src/server/openapi.ts';
import {analyticsQuery} from '../src/server/analytics.ts';

const scope='from=2026-01-01&to=2026-01-02&timeZone=UTC';
const card=(type:typeof boardCardTypes[number]):BoardCard=>boardCard.parse({id:randomUUID(),type,...type==='TextBlock'?{text:'<script>plain text 🐎</script>'}:{entity:null},...type==='Goal'||type==='Funnel'?{analysisId:randomUUID(),analysisRevision:1}:{},...type==='UTM'?{parameter:'campaignSource',limit:5}:{},...type==='EventsChart'?{limit:10}:{},...type.startsWith('Revenue')?{currency:'USD'}:{},...type==='RevenueMetricsTable'?{dimension:'referrer'}:{},...type==='MetricsTable'?{dimension:'path',limit:20}:{}});
const definition=():BoardDefinition=>({schemaVersion:1,name:'Board',description:'',defaultEntity:{kind:'website',id:randomUUID()},scope,rows:boardCardTypes.map(type=>({id:randomUUID(),minHeight:150,cards:[card(type)]}))});

test('closed all17 board configuration roundtrips order, row design and literal text',()=>{
 const value=definition(),parsed=parseBoardDefinition(JSON.parse(JSON.stringify(value)));assert.deepEqual(parsed,value);assert.equal(parsed.rows.length,17);assert.deepEqual(parsed.rows.flatMap(r=>r.cards.map(c=>c?.type)),boardCardTypes);
 const reversed={...value,rows:value.rows.toReversed().map(r=>({...r,minHeight:600,cards:[null,...r.cards]}))};assert.deepEqual(parseBoardDefinition(reversed),reversed);
 for(const dimension of boardMetricFields)assert.equal(boardCard.parse({id:randomUUID(),entity:null,type:'MetricsTable',dimension,limit:5}).type,'MetricsTable');
});
test('unknown props, incompatible entities, duplicate identity and bounded configuration fail closed',()=>{
 const value=definition();for(const raw of [{...value,html:'x'},{...value,schemaVersion:2},{...value,name:' Board '},{...value,description:'\ud800'},{...value,rows:[...value.rows,value.rows[0]]},{...value,rows:[{...value.rows[0],minHeight:149}]},{...value,rows:[{...value.rows[0],cards:Array(5).fill(null)}]},{...value,rows:Array.from({length:11},()=>({id:randomUUID(),minHeight:150,cards:Array.from({length:4},()=>card('TextBlock'))}))}])assert.throws(()=>parseBoardDefinition(raw));
 for(const raw of [{...card('TextBlock'),html:true},{...card('Goal'),analysisRevision:0},{...card('UTM'),limit:100},{...card('RevenueChart'),currency:'ZZZ'},{...card('WebsiteChart'),type:'UnlistedCard'}])assert.equal(boardCard.safeParse(raw).success,false);
 const compatible={...value,defaultEntity:{kind:'link' as const,id:randomUUID()},rows:[{id:randomUUID(),minHeight:150,cards:[card('WebsiteChart'),{...card('MetricsTable'),dimension:'country'}]}]};assert.equal(boardDefinition.safeParse(compatible).success,true);assert.equal(boardDefinition.safeParse({...compatible,rows:[{id:randomUUID(),minHeight:150,cards:[card('UTM')]}]}).success,false);
 assert.equal(boardDefinition.safeParse({...value,defaultEntity:null}).success,false);assert.equal(boardDefinition.safeParse({...value,defaultEntity:null,rows:[{id:randomUUID(),minHeight:150,cards:[card('TextBlock')]}]}).success,true);
});
test('applied native scope canonicalizes without losing exact empty, percent, typed and location values',()=>{
 const params=new URLSearchParams({from:'2026-01-01',to:'2026-01-02',timeZone:'America/New_York',path:'/literal%_ 🐎',campaignSource:'',propertyKey:'price',propertyType:'number',propertyValue:'0'}),parsed=boardScope(params.toString());
 assert.equal(parsed.query.filters.path,'/literal%_ 🐎');assert.equal(parsed.query.filters.campaignSource,'');assert.deepEqual(parsed.query.property,{key:'price',type:'number',value:0});assert.equal(boardScope(parsed.scope).scope,parsed.scope);
 const country=JSON.stringify({state:'known',country:'US'});const geo=boardScope(scope+'&country='+encodeURIComponent(country));assert.equal(geo.query.filters.country,country);
 for(const raw of [scope+'&path=%',scope+'&path=%GG',scope+'&path=%ED%A0%80',scope+'&path=%FF',scope+'&path=%00',scope+'&path=\ud800',scope+'&path=a&path=b',scope+'&kind=custom',scope+'&groupBy=path',scope+'&cohortId='+randomUUID(),scope+'&predicates=%7B%7D','from=2026-01-01&to=2026-01-02',scope.replace('2026-01-02','2026-02-31')])assert.throws(()=>boardScope(raw));
 assert.equal(boardScope(scope+'&path=%25').query.filters.path,'%');assert.equal(boardScope(scope+'&path=%EF%BF%BD').query.filters.path,'�');assert.throws(()=>boardParams('scope='+encodeURIComponent(scope+'&path=%ED%A0%80')).get('scope')&&boardScope(boardParams('scope='+encodeURIComponent(scope+'&path=%ED%A0%80')).get('scope')!));
});
test('board endpoints are browser-only and preserve existing bearer operation inventory',()=>{
 const inventory=nativeOpenApi['x-ten98-browser-operations'];const paths=Object.keys(inventory).filter(p=>p.includes('/boards')&&!p.includes('/shares'));assert.equal(paths.length,7);for(const path of paths)assert.equal(Object.hasOwn(nativeOpenApi.paths,path),false);
 assert.equal(inventory['/api/workspaces/{workspaceId}/boards'].post.bodyMaxBytes,196608);assert.match(inventory['/api/workspaces/{workspaceId}/boards/{boardId}/cards/{cardId}'].get.query,/Unsupported/);
});

test('optional design preserves legacy JSON and real bounded canonical unsaved preview identity',()=>{
 const legacy=definition();assert.deepEqual(parseBoardDefinition(legacy),legacy);
 for(const type of boardCardTypes){const value={...card(type),title:'Campaign view 🐎',description:'<b>Literal description</b>'};assert.deepEqual(boardCard.parse(value),value);}
 const designed={...legacy,rows:[{...legacy.rows[0],cards:[{...card('TextBlock'),title:'Notes',description:'Literal <script>text</script>'},null],widths:[30,70]}]};assert.deepEqual(parseBoardDefinition(designed),designed);
 for(const widths of [[100],[0,100],[1,98],[50,50,0],[50.5,49.5],[101,-1]])assert.equal(boardDefinition.safeParse({...designed,rows:[{...designed.rows[0],widths}]}).success,false);
 for(const bad of [{title:''},{title:' padded '},{title:'x'.repeat(121)},{description:'x'.repeat(1001)},{title:'\u0000'},{description:'\ud800'}])assert.equal(boardCard.safeParse({...card('TextBlock'),...bad}).success,false);
 const request={previewId:randomUUID(),card:card('WebsiteChart'),defaultEntity:legacy.defaultEntity,scope},parsed=parseBoardPreview(request);assert.deepEqual(parsed,request);assert.equal('boardId'in parsed,false);assert.equal('revision'in parsed,false);
 for(const bad of [{...request,boardId:randomUUID()},{...request,previewId:'bad'},{...request,defaultEntity:null},{...request,card:{...card('UTM'),entity:{kind:'link',id:randomUUID()}}},{...request,scope:scope+'&path=%ED%A0%80'}])assert.throws(()=>parseBoardPreview(bad));
 const linkPreview={...request,card:{...request.card,entity:{kind:'link' as const,id:randomUUID()}}};assert.deepEqual(parseBoardPreview(linkPreview),linkPreview);
 assert.equal(boardPreviewInput.safeParse({...request,card:card('TextBlock'),defaultEntity:null}).success,true);
 const largeScope=new URLSearchParams({from:'2026-01-01',to:'2026-01-02',timeZone:'UTC',path:'\u0001'.repeat(2048),referrer:'\u0001'.repeat(2048),campaignSource:'',propertyKey:'v',propertyType:'string',propertyValue:JSON.stringify('\u0001'.repeat(910))});
 const remaining=20000-largeScope.toString().length;assert.ok(remaining>=0&&remaining<=320);largeScope.set('campaignSource','x'.repeat(remaining));const canonical=boardScope(largeScope.toString()).scope;assert.equal(canonical.length,20000);
 const largest={previewId:randomUUID(),card:{...card('TextBlock'),title:'\u0001'.repeat(120),description:'\u0001'.repeat(1000),text:'\u0001'.repeat(4000)},defaultEntity:legacy.defaultEntity,scope:canonical};const bytes=Buffer.byteLength(JSON.stringify(largest));assert.ok(bytes>32768&&bytes<=boardLimits.previewBodyBytes);assert.deepEqual(parseBoardPreview(largest),largest);assert.equal(boardLimits.previewBodyBytes,51200);
 assert.equal(nativeOpenApi['x-ten98-browser-operations']['/api/workspaces/{workspaceId}/boards/preview'].post.bodyMaxBytes,boardLimits.previewBodyBytes);
});

test('mixed tracked cards use only exact native request report families and fixed row bounds',()=>{
 const value=definition(),assetScope=boardScope(scope+'&browser=unknown&referrer=referrer.example.com'),link={kind:'link' as const,id:randomUUID()};
 for(const kind of ['link','pixel']as const)for(const type of ['WebsiteMetricsBar','WebsiteChart','MetricsTable','WorldMap']as const){
  const c=boardCard.parse({...card(type),entity:{...link,kind},...type==='MetricsTable'?{dimension:'referrer',limit:5}:{}});
  const query=boardAssetQuery(c,assetScope);assert.ok(query);assert.equal(query.from,'2026-01-01');assert.equal(query.timeZone,'UTC');assert.deepEqual(query.filters,{referrer:'referrer.example.com',browser:'unknown'});assert.equal(query.dimension,type==='WorldMap'?'country':'referrer');assert.equal(query.limit,type==='WorldMap'?100:type==='MetricsTable'?5:10);
 }
 for(const dimension of ['referrer','channel','browser','os','device','country','region','city']){const c=boardCard.parse({...card('MetricsTable'),entity:link,dimension,limit:20});assert.equal(boardAssetQuery(c,boardScope(scope))?.dimension,dimension);}
 for(const dimension of ['path','entry','exit','hostname','screen','utmSource','event'])assert.equal(boardAssetQuery(boardCard.parse({...card('MetricsTable'),dimension}),boardScope(scope)),null);
 for(const type of ['UTM','RevenueChart','Goal','RealtimeHeader','WeeklyTraffic']as const)assert.equal(boardAssetQuery(card(type),boardScope(scope)),null);
 assert.deepEqual(parseBoardDefinition({...value,defaultEntity:link,rows:[{...value.rows[0],cards:[{...card('WebsiteChart'),entity:null}]}]}).defaultEntity,link);
});
test('tracked board scopes refuse website, event, campaign and property widening without changing the original applied scope',()=>{
 const c={...card('WebsiteMetricsBar'),entity:{kind:'pixel' as const,id:randomUUID()}};
 for(const suffix of ['&path=%2Fa','&origin=https%3A%2F%2Fexample.com','&eventName=purchase','&language=en','&campaignSource=','&propertyKey=plan&propertyType=string&propertyValue=%22pro%22','&referrer=https%3A%2F%2Fexample.com%2Fprivate'])assert.equal(boardAssetQuery(c,boardScope(scope+suffix)),null);
 const original=boardScope(scope+'&referrer=REFERRER.EXAMPLE.COM'),query=boardAssetQuery(c,original);assert.ok(query);assert.equal(query.filters.referrer,'referrer.example.com');assert.equal(original.scope,scope+'&referrer=REFERRER.EXAMPLE.COM','The board echo remains its full applied scope; only the native hostname equivalence is canonicalized.');
 assert.equal(boardAssetQuery(c,boardScope(scope+'&device=not-recorded'))?.filters.device,'not-recorded');
});

test('board local exact scopes do not expand the legacy Analytics parser, UTC range or comparison protocol',()=>{
 const legacy=analyticsQuery(new URLSearchParams({from:'2026-01-01',to:'2026-01-02',compare:'prev'}));assert.equal(legacy.compare,'prev');assert.deepEqual(legacy.range,{from:'2026-01-01',to:'2026-01-02',timeZone:'UTC',start:'2026-01-01T00:00:00.000Z',end:'2026-01-03T00:00:00.000Z'});
 for(const field of [{timeZone:'America/New_York'},{origin:'https://example.com'},{propertyKey:'price',propertyType:'number',propertyValue:'0'}]){const params=new URLSearchParams({from:'2026-01-01',to:'2026-01-02'});for(const[key,value]of Object.entries(field))if(value!==undefined)params.set(key,value);assert.throws(()=>analyticsQuery(params));}
 const local=new URLSearchParams({from:'2025-03-09',to:'2025-03-09',timeZone:'America/New_York',origin:'https://example.com',browser:'chrome',country:JSON.stringify({state:'known',country:'US'}),propertyKey:'price',propertyType:'number',propertyValue:'0'}),parsed=boardScope(local.toString());assert.equal(parsed.query.timeZone,'America/New_York');assert.deepEqual(parsed.query.property,{key:'price',type:'number',value:0});for(const key of ['origin','browser','country'])assert.equal(parsed.query.filters[key],local.get(key));
});

test('board share contracts keep separate receipt intent, canonical selected IDs and closed tokens',()=>{
 const id=randomUUID(),input={requestId:randomUUID(),boardRevision:1,label:'Stakeholders',theme:'light',selectedCardIds:[id],scope,allowFilter:false,ongoingLive:false,expiresAt:'2027-01-01T00:00:00.000Z',token:'a'.repeat(42)+'A'};
 assert.equal(boardShareCreate.parse(input).selectedCardIds[0],id);assert.throws(()=>boardShareCreate.parse({...input,selectedCardIds:[id,id]}));
 assert.throws(()=>boardShareCreate.parse({...input,token:input.token+'\n'}));assert.throws(()=>boardShareCreate.parse({...input,token:'a'.repeat(42)+'B'}));assert.throws(()=>boardShareCreate.parse({...input,actorId:randomUUID()}));
 const{token:_token,...publication}=input;assert.ok(boardSharePublish.safeParse({...publication,revision:1}).success);assert.equal(boardSharePublish.safeParse({...input,revision:1}).success,false);
 assert.equal(boardShareRevoke.safeParse({requestId:randomUUID(),revision:1,boardId:randomUUID()}).success,false);
});
test('board share narrowing pins timezone, every exact filter and typed property without silently widening',()=>{
 const granted='from=2026-01-01&to=2026-01-03&timeZone=UTC&path=%2Fonly&propertyKey=amount&propertyType=number&propertyValue=0';
 const subset=new URLSearchParams(granted);subset.set('from','2026-01-02');subset.set('to','2026-01-02');subset.set('browser','chrome');
 assert.equal(permittedBoardShareScope(granted,subset.toString(),true).query.filters.browser,'chrome');
 assert.throws(()=>permittedBoardShareScope(granted,subset.toString(),false),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===403);
 for(const change of [(p:URLSearchParams)=>p.set('timeZone','America/New_York'),(p:URLSearchParams)=>p.delete('path'),(p:URLSearchParams)=>p.set('path','/other'),(p:URLSearchParams)=>p.delete('propertyKey'),(p:URLSearchParams)=>p.set('propertyValue','1'),(p:URLSearchParams)=>p.set('from','2025-12-31')]){
  const p=new URLSearchParams(granted);change(p);assert.throws(()=>permittedBoardShareScope(granted,p.toString(),true));
 }
 assert.equal(permittedBoardShareScope(granted,granted,false).scope,boardScope(granted).scope);
});
test('canonical board scope rejects post-normalization expansion at the persisted boundary',()=>{
 const params=new URLSearchParams({from:'2026-01-01',to:'2026-01-02',timeZone:'US/Eastern',path:'\u0001'.repeat(2048),referrer:'\u0001'.repeat(2048),campaignSource:'',propertyKey:'v',propertyType:'string',propertyValue:JSON.stringify('\u0001'.repeat(910))});
 const remaining=20000-params.toString().length;assert.ok(remaining>=0&&remaining<=320);params.set('campaignSource','x'.repeat(remaining));assert.equal(params.toString().length,20000);
 assert.throws(()=>boardScope(params.toString()),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===400);
 params.set('campaignSource','x'.repeat(remaining-6));const accepted=boardScope(params.toString());assert.equal(accepted.query.timeZone,'America/New_York');assert.equal(accepted.scope.length,20000);assert.equal(Buffer.byteLength(accepted.scope),20000);
});
test('public board projection exposes literal text only and rejects a mismatched native family',()=>{
 const textCard=card('TextBlock');assert.ok(textCard.type==='TextBlock');const source={status:'ready' as const,source:'text' as const,data:{text:textCard.text,privateSession:'must not escape'},role:'owner',workspaceId:randomUUID()};
 assert.deepEqual(projectBoardShareCard(textCard,source),{status:'ready',data:{text:textCard.text}});
 assert.throws(()=>projectBoardShareCard(card('WebsiteChart'),source));
 assert.deepEqual(projectBoardShareCard(card('WebsiteChart'),{status:'unsupported',reason:'not_collected',message:'Not collected.'}),{status:'unsupported',reason:'not_collected',message:'Not collected.'});
});
test('all17 explicit public projections reject private canaries, copied scope and undeclared nested fields',()=>{
 const range={from:'2026-01-01',to:'2026-01-02',timeZone:'UTC',start:'2026-01-01T00:00:00.000Z',end:'2026-01-03T00:00:00.000Z'},coverage={status:'unavailable',retainedFrom:'2026-01-03T00:00:00.000Z'},day={date:'2026-01-01',start:range.start,end:'2026-01-02T00:00:00.000Z',skipped:false,coverage:'unavailable'},money={sales:'0.0000',refunds:'0.0000',net:'0.0000',saleObservations:0,refundObservations:0};
 const live={range:{start:range.start,end:range.end,timeZone:'UTC',seconds:1800},asOf:range.end,coverage,activeWindow:{start:range.start,end:range.end,seconds:300},active:{coverage,estimatedVisitors:null},totals:{pageViews:null,customEvents:null,estimatedVisitors:null},minutes:[],geography:{countries:{totalGroups:null,rows:[]}},activity:{rows:[{visitorKey:'PRIVATE-CANARY'}]}};
 const goal={kind:'goal',name:'Reviewed goal',description:'Literal',condition:{type:'path',match:'exact',value:'/thanks'}},funnel={kind:'funnel',name:'Reviewed funnel',description:'Literal',windowMinutes:60,steps:[{type:'path',match:'exact',value:'/a',pageViewsOnly:true,properties:[]},{type:'event',match:'exact',value:'purchase',pageViewsOnly:false,properties:[{key:'plan',operator:'eq',type:'array',value:['pro',0,false,null]}]}]};
 for(const type of boardCardTypes){
  const c=card(type);let source:string,data:unknown;
  if(type==='TextBlock'){source='text';data={text:'Literal <script>text</script>'};}
  else if(type==='WebsiteMetricsBar'){source='analytics';data={range,coverage,totals:{pageViews:null},measurement:{visitors:null,visits:null,bounceRate:null,averageVisitSeconds:null}};}
  else if(type.startsWith('Realtime')){source='realtime';data=live;}
  else if(type==='Goal'||type==='Funnel'){source='analysis';data={range,coverage,item:{revision:1,definition:type==='Goal'?goal:funnel},goal:null,steps:[{step:1,visitors:null,dropped:null,conversionRate:null,remainingRate:null},{step:2,visitors:null,dropped:null,conversionRate:null,remainingRate:null}],witnesses:['PRIVATE-CANARY']};}
  else if(type.startsWith('Revenue')){source='revenue';data={range,coverage,query:{currency:'USD'},selection:{evidenceIncomplete:true},money:null,identity:{revenueKeys:null},daily:null,series:null,dimensions:null,sessions:{rows:[{visitorKey:'PRIVATE-CANARY',totals:money}]},detail:{visitorKey:'PRIVATE-CANARY'}};}
  else if(type==='WebsiteChart'||type==='EventsChart'||type==='WeeklyTraffic'){source='activity';data={range,coverage,daily:[{...day,events:null,estimatedVisitors:null}],weekly:Array.from({length:168},(_,i)=>({weekday:Math.floor(i/24)+1,hour:i%24,coverage:'unavailable',estimatedVisitors:null})),method:{weeklyRepeatedHours:'combined',visitorCountsAdditive:false},series:[],eventNames:null};}
  else{source='explorer';data={range,coverage,totals:{events:null,visitors:null,visits:null},breakdown:{totalGroups:null,returnedGroupEvents:null,groups:[],truncated:false},csv:'PRIVATE-CANARY'};}
  // Synthetic SQL-free projection check, deliberately including fields a private DTO must not publish.
  const projected=projectBoardShareCard(c,{status:'ready',source,data,privateSession:'PRIVATE-CANARY'}as never),expected={shareId:randomUUID(),grantRevision:1,boardRevision:1,cardId:c.id,cardType:type,scope,entityKind:type==='TextBlock'?'none' as const:'website' as const};
  assert.ok(projected.status==='ready');const envelope={version:'public-board-card-v1',...expected,effectiveWindow:type==='TextBlock'?'none':type.startsWith('Realtime')?'fixed-live':'historical',readAt:range.end,...projected};delete(envelope as Record<string,unknown>).entityKind;
  assert.equal(JSON.stringify(envelope).includes('PRIVATE-CANARY'),false,type);assert.ok(decodePublicBoardCard(envelope,expected),type);
  assert.equal(decodePublicBoardCard({...envelope,scope:scope+'&browser=chrome'},expected),null,type);
  assert.equal(decodePublicBoardCard({...envelope,data:{...projected.data,privateSession:'PRIVATE-CANARY'}},expected),null,type);
  if(type==='WeeklyTraffic'&&'weekly'in projected.data){
   const weekly=projected.data.weekly;assert.ok(weekly);
   assert.equal(weekly[0].weekday,1);assert.equal(weekly.at(-1)?.weekday,7);
   for(const weekday of [0,8])assert.equal(decodePublicBoardCard({...envelope,data:{...projected.data,weekly:weekly.map((bin,i)=>i===0?{...bin,weekday}:bin)}},expected),null,'Only native ISO weekdays 1–7 are accepted.');
  }
 }
 // Synthetic SQL-free native country-cap boundary: 676 two-letter keys plus unknown/not-recorded.
 const revenueCard=boardCard.parse({...card('RevenueMetricsTable'),dimension:'country'}),revenueExpected={shareId:randomUUID(),grantRevision:1,boardRevision:1,cardId:revenueCard.id,cardType:'RevenueMetricsTable' as const,scope,entityKind:'website' as const};
 const countryRows=Array.from({length:678},(_,i)=>({key:i<676?{state:'known',country:String.fromCharCode(65+Math.floor(i/26),65+i%26)}:{state:i===676?'unknown':'not-recorded'},totals:money,saleShare:null}));
 const revenueProjected=projectBoardShareCard(revenueCard,{status:'ready',source:'revenue',data:{range,coverage,query:{currency:'USD'},selection:{evidenceIncomplete:true},money:{sales:'0.0000'},dimensions:{countries:{rows:countryRows,totalGroups:678,limit:678,truncated:false,displayed:money,omitted:money}}}}as never);
 assert.ok(revenueProjected.status==='ready'&&'breakdown'in revenueProjected.data&&revenueProjected.data.breakdown);
 const revenueEnvelope={version:'public-board-card-v1',shareId:revenueExpected.shareId,grantRevision:1,boardRevision:1,cardId:revenueCard.id,cardType:'RevenueMetricsTable',scope,effectiveWindow:'historical',readAt:range.end,...revenueProjected},breakdown=revenueProjected.data.breakdown;
 assert.ok(decodePublicBoardCard(revenueEnvelope,revenueExpected),'All 678 native country slots remain available.');
 assert.ok(decodePublicBoardCard({...revenueEnvelope,data:{...revenueProjected.data,breakdown:{...breakdown,rows:breakdown.rows.slice(0,101)}}},revenueExpected));
 assert.equal(decodePublicBoardCard({...revenueEnvelope,data:{...revenueProjected.data,breakdown:{...breakdown,rows:[...breakdown.rows,breakdown.rows[0]]}}},revenueExpected),null);
 for(const length of [100,101])assert.equal(!!decodePublicBoardCard({...revenueEnvelope,data:{...revenueProjected.data,dimension:'referrer',breakdown:{...breakdown,rows:Array.from({length},(_,i)=>({key:'referrer-'+i,totals:money,saleShare:null}))}}},revenueExpected),length===100,'Other revenue dimensions retain their 100-row bound.');
 const publicInventory=nativeOpenApi['x-ten98-public-operations'];assert.equal(publicInventory['/api/board-shares/{shareId}/cards/{cardId}/read'].post.bodyMaxBytes,51200);
 const textCard=card('TextBlock');assert.ok(textCard.type==='TextBlock');const id=randomUUID(),manifest={version:'public-board-share-v1',shareId:id,grantRevision:1,boardRevision:1,label:'Shared',theme:'light',expiresAt:range.end,allowFilter:false,ongoingLive:false,scope,readAt:range.start,rows:[{id:randomUUID(),minHeight:150,cards:[{id:textCard.id,type:'TextBlock',text:textCard.text}]}]};
 assert.ok(decodePublicBoardManifest(manifest,id));assert.equal(decodePublicBoardManifest({...manifest,defaultEntity:{id:randomUUID()}},id),null);
});
