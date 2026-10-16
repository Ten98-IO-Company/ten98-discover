import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {boardCard,boardCardTypes,boardDefinition,boardMetricFields,type BoardCard,type BoardDefinition} from '../src/lib/boards.ts';
import {boardParams,boardScope,parseBoardDefinition} from '../src/server/boards.ts';
import {nativeOpenApi} from '../src/server/openapi.ts';

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
 const inventory=nativeOpenApi['x-ten98-browser-operations'];const paths=Object.keys(inventory).filter(p=>p.includes('/boards'));assert.equal(paths.length,6);for(const path of paths)assert.equal(Object.hasOwn(nativeOpenApi.paths,path),false);
 assert.equal(inventory['/api/workspaces/{workspaceId}/boards'].post.bodyMaxBytes,196608);assert.match(inventory['/api/workspaces/{workspaceId}/boards/{boardId}/cards/{cardId}'].get.query,/Unsupported/);
});
