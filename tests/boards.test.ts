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
 const inventory=nativeOpenApi['x-ten98-browser-operations'];const paths=Object.keys(inventory).filter(p=>p.includes('/boards'));assert.equal(paths.length,7);for(const path of paths)assert.equal(Object.hasOwn(nativeOpenApi.paths,path),false);
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
