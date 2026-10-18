import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {nativeOpenApi} from '../src/server/openapi.ts';
import {handleApi} from '../src/server/api.ts';
import {promptBatch,promptPatch,contextOp} from '../src/server/context-input.ts';
import {savedKeywordFilterKeys} from '../src/server/saved-keyword-input.ts';
import {explorerQuery,explorerGroupingQuery} from '../src/server/explorer-input.ts';
import {analyticsQuery} from '../src/server/analytics.ts';
import {geographySearch} from '../src/lib/analytics-geography.ts';
import {journeysQuery} from '../src/server/journeys.ts';
import {journeysLimits} from '../src/lib/journeys.ts';
import {retentionReportQuery} from '../src/server/retention-report-input.ts';
import {retentionLimits} from '../src/lib/retention-report.ts';
import {attributionQuery} from '../src/server/attribution.ts';
import {attributionLimits} from '../src/lib/attribution.ts';
import {analyticsDimensions,analyticsSelectionFields,analyticsFieldLimit} from '../src/lib/analytics-dimensions.ts';
import {revenueQuery} from '../src/server/revenue.ts';
import {revenueCurrencies,revenueReportLimits} from '../src/lib/revenue.ts';

test('comparison dimension and selection contract describes the closed native parser',()=>{
 const params=nativeOpenApi.paths['/api/projects/{projectId}/analytics'].get.parameters as any[],parameter=(name:string)=>params.find(x=>x.name===name);
 assert.deepEqual(parameter('dimension').schema.enum,analyticsDimensions);assert.match(parameter('dimension').description,/Requires compare/);assert.equal(parameter('selection').schema.maxLength,20000);
 for(const dimension of analyticsDimensions){assert.equal(analyticsQuery(new URLSearchParams({compare:'prev',dimension})).dimension,dimension);assert.throws(()=>analyticsQuery(new URLSearchParams({dimension})));}
 for(const field of analyticsSelectionFields)for(const operator of ['eq','exists','missing']){const fields=[{field,operator,...operator==='eq'?{value:field==='origin'?'https://example.test':''}:{}}],selection=new URLSearchParams({predicates:JSON.stringify({version:1,match:'all',fields,properties:[]})}).toString(),result=analyticsQuery(new URLSearchParams({selection}));assert.deepEqual(result.selection?.fields,fields);assert.equal(result.selectionQuery,selection);}
 for(const field of analyticsSelectionFields){const query=(n:number)=>new URLSearchParams({selection:new URLSearchParams({[field]:field==='origin'?'https://'+'x'.repeat(n-8):'x'.repeat(n)}).toString()});assert.ok(analyticsQuery(query(analyticsFieldLimit(field))).selection);assert.throws(()=>analyticsQuery(query(analyticsFieldLimit(field)+1)));}
 const invalid:Record<string,string>[]=[{dimension:'distinctId',compare:'prev'},{dimension:'path'},{selection:'path=a&path=b'},{selection:'origin=https%3A%2F%2Fexample.test%2F'}];for(const value of invalid)assert.throws(()=>analyticsQuery(new URLSearchParams(value)));
 for(const patch of [{match:'any'}, {fields:[{field:'path',operator:'contains',value:'a'}]}, {properties:[{key:'x',operator:'exists'}]}, {sessionProperties:[{key:'x',operator:'exists'}]}]){const selection=new URLSearchParams({predicates:JSON.stringify({version:1,match:'all',fields:[{field:'path',operator:'eq',value:'a'}],properties:[],...patch})}).toString();assert.throws(()=>analyticsQuery(new URLSearchParams({selection})));}
 const repeated=new URLSearchParams({dimension:'path',compare:'prev'});repeated.append('dimension','event');assert.throws(()=>analyticsQuery(repeated));
});

test('Revenue inventory matches the three closed native readers and pinned currencies',()=>{
 const paths=['/api/projects/{projectId}/revenue','/api/projects/{projectId}/revenue/sessions','/api/projects/{projectId}/revenue/sessions/{visitorKey}'] as const;
 for(const[index,path]of paths.entries()){
  const op=nativeOpenApi.paths[path].get,params=op.parameters as any[],parameter=(name:string)=>params.find(p=>p.name===name),route=index===0?'report':index===1?'sessions':'detail',key=route==='detail'?'a'.repeat(64):null;
  assert.deepEqual(op['x-ten98-scopes'],['analytics:read']);assert.equal(Object.hasOwn(op,'requestBody'),false);
  for(const name of['from','to','timeZone','currency'])assert.equal(parameter(name).required,true);
  assert.deepEqual(parameter('currency').schema.enum,revenueCurrencies);assert.equal(parameter('pageSize').schema.default,50);assert.match(op.description,new RegExp(String(revenueReportLimits.responseBytes)));
  for(const currency of['USD','AED','EUR']){const q=new URLSearchParams({from:'2024-03-01',to:'2024-03-07',timeZone:'Asia/Dubai',currency});assert.equal(revenueQuery(q,route,key).currency,currency);for(const[name,value]of[['groupBy','event'],['currency','XXX']] as const){const bad=new URLSearchParams(q);bad.set(name,value);assert.throws(()=>revenueQuery(bad,route,key));}}
  assert.equal(!!parameter('compare'),route==='report');if(route==='report'){assert.deepEqual(parameter('compare').schema.enum,['prev','yoy']);assert.equal(Object.hasOwn(parameter('compare').schema,'default'),false);}for(const mode of['prev','yoy']){const q=new URLSearchParams({from:'2024-03-01',to:'2024-03-07',timeZone:'Asia/Dubai',currency:'USD',compare:mode});if(route==='report')assert.equal(revenueQuery(q,route,key).compare,mode);else assert.throws(()=>revenueQuery(q,route,key));}for(const selector of['','unknown','prev&compare=yoy'])assert.throws(()=>revenueQuery(new URLSearchParams('from=2024-03-01&to=2024-03-07&timeZone=UTC&currency=USD&compare='+selector),route,key));
  assert.equal(!!parameter('cursor'),route!=='report');assert.equal(!!parameter('search'),route!=='detail');
 }
});

test('static OpenAPI exposes exactly the supported 45 native operations with local references',()=>{
 assert.equal(nativeOpenApi.openapi,'3.1.2');assert.deepEqual(nativeOpenApi.servers,[{url:'/'}]);
 const ids:string[]=[];for(const[path,item]of Object.entries(nativeOpenApi.paths))for(const[method,op]of Object.entries(item)){
  assert.ok(['get','post'].includes(method));ids.push(op.operationId);assert.deepEqual(op.security,[{bearerAuth:[]}]);assert.equal(op['x-ten98-scopes'].length,1);
  assert.deepEqual([...path.matchAll(/\{([^}]+)\}/g)].map(x=>x[1]).sort(),op.parameters.filter((x:any)=>x.in==='path').map((x:any)=>x.name).sort());
  const names=op.parameters.map((x:any)=>x.in+':'+x.name);assert.equal(new Set(names).size,names.length);
 }
 assert.equal(ids.length,45);assert.equal(new Set(ids).size,45);assert.equal(ids.filter(x=>/Prompt/.test(x)).length,7);
 const prior=['listProjects','createProject','readTeam','listRecentEvents','writeObservation','readAnalytics','readRealtime','exploreAnalytics','listSessions','readSession','readLinkedActivity','listPrompts','readPrompt','listPromptVersions','createPrompts','updatePrompt','archivePrompt','restorePrompt'];
 const added=['readJourneys','readRetentionReport','readAttribution','readRevenue','listRevenueSessions','readRevenueSession','readWebPerformance','readContext','listContextResearch','updateContext',
  'listSegments','readSegment','listCohorts','readCohort','listAnnotations','readAnnotationTimeline','readAnnotation','listRankTrackers','readRankTracker','readRankDistribution','readRankMatrix','querySavedKeywords','listSavedKeywordTags','listGoogleSources','readGoogleSnapshot','listDomains','listDomainRedirectChecks'];
 assert.deepEqual(ids.filter(id=>!added.includes(id)).sort(),prior.sort());for(const name of added)assert.equal(ids.filter(id=>id===name).length,1);
 const walk=(x:any)=>{if(!x||typeof x!=='object')return;if(x.$ref){assert.match(x.$ref,/^#\/components\/schemas\//);assert.ok(Object.hasOwn(nativeOpenApi.components.schemas,x.$ref.split('/').at(-1)));}for(const v of Object.values(x))walk(v);};walk(nativeOpenApi);
 const params=nativeOpenApi.paths['/api/projects/{projectId}/explore'].get.parameters as any[];
 assert.ok(params.some(x=>x.name==='eventName'));assert.ok(!params.some(x=>x.name==='event'||x.name==='screenWidth'));
 assert.equal(explorerQuery(new URLSearchParams({eventName:'signup'})).filters.eventName,'signup');
 assert.equal(params.find(x=>x.name==='fields')?.schema.maxLength,20000);
 assert.deepEqual(explorerGroupingQuery(new URLSearchParams({fields:'["path","referrer"]'})).fields,['path','referrer']);
 for(const item of Object.values(nativeOpenApi.paths))for(const op of Object.values(item))if(op.parameters.some((x:any)=>x.name==='fields'))assert.equal(op.operationId,'exploreAnalytics');
});

test('context operations carry one content scope each, a body only on updateContext and the native op kinds',()=>{
 const base='/api/projects/{projectId}/context',cases=[[base,'get','readContext','context:read'],[base+'/research-log','get','listContextResearch','context:read'],[base+'/update','post','updateContext','context:write']] as const;
 for(const[path,method,operationId,scope]of cases){
  const op=(nativeOpenApi.paths as any)[path][method];assert.equal(op.operationId,operationId);assert.deepEqual(op['x-ten98-scopes'],[scope]);
  assert.equal(Object.hasOwn(op,'requestBody'),operationId==='updateContext');
  assert.equal(op.parameters.some((x:any)=>x.in==='query'),operationId==='listContextResearch');
 }
 assert.deepEqual((nativeOpenApi.paths as any)[base+'/update'].post.requestBody.content['application/json'].schema,{$ref:'#/components/schemas/ContextPatch'});
 const patch=nativeOpenApi.components.schemas.ContextPatch as any;assert.equal(patch.additionalProperties,false);assert.deepEqual(patch.required.sort(),['requestId','revision','updates']);
 assert.equal(patch.properties.updates.minItems,1);assert.equal(patch.properties.updates.maxItems,50);assert.equal(patch.properties.revision.maximum,2147483646);
 assert.deepEqual(patch.properties.updates.items.properties.kind.enum,contextOp.options.map(option=>option.shape.kind.value));
 assert.match(nativeOpenApi.components.securitySchemes.bearerAuth.description,/context:write does not imply context:read/);
 // The bearer update answer is a receipt, never the context; both readers keep the broad native response.
 const response=(path:string,method:string)=>(nativeOpenApi.paths as any)[path][method].responses['200'].content['application/json'].schema;
 assert.deepEqual(response(base+'/update','post'),{type:'object',properties:{revision:{type:'integer',minimum:1,maximum:2147483646},replayed:{type:'boolean'}},required:['revision','replayed'],additionalProperties:false});
 assert.equal(response(base,'get').additionalProperties,true);assert.equal(Object.hasOwn(response(base,'get'),'properties'),false);
 assert.equal(response(base+'/research-log','get').properties.entries.items.additionalProperties,true);
});

test('content read families carry one scope each, a body only on the two saved-keyword readers and parameters mirroring the native parsers',()=>{
 const base='/api/projects/{projectId}',cases=[
  ['/segments','listSegments','segments:read',['cursor']],['/segments/{segmentId}','readSegment','segments:read',[]],['/cohorts','listCohorts','segments:read',['cursor']],['/cohorts/{cohortId}','readCohort','segments:read',[]],
  ['/annotations','listAnnotations','annotations:read',['from','to','timeZone','search','cursor']],['/annotations/timeline','readAnnotationTimeline','annotations:read',['from','to','timeZone']],['/annotations/{annotationId}','readAnnotation','annotations:read',[]],
  ['/rank-trackers','listRankTrackers','rank:read',['archived','cursor']],['/rank-trackers/{trackerId}','readRankTracker','rank:read',[]],['/rank-trackers/{trackerId}/distribution','readRankDistribution','rank:read',['device','runId']],['/rank-trackers/{trackerId}/matrix','readRankMatrix','rank:read',['device','search','pinned','runLimit','cursor']],
  ['/saved-keywords/list','querySavedKeywords','keywords:read',[]],['/saved-keywords/tags/list','listSavedKeywordTags','keywords:read',[]],
  ['/google','listGoogleSources','google:read',[]],['/google/imports/{importId}','readGoogleSnapshot','google:read',['offset']],
  ['/domains','listDomains','domains:read',[]],['/domains/{domainId}/redirect-checks','listDomainRedirectChecks','domains:read',[]],
 ] as const;
 for(const[suffix,operationId,scope,queries]of cases){
  const item=(nativeOpenApi.paths as any)[base+suffix],method=scope==='keywords:read'?'post':'get',op=item[method];
  assert.deepEqual(Object.keys(item),[method],operationId);assert.equal(op.operationId,operationId);assert.deepEqual(op['x-ten98-scopes'],[scope]);
  assert.equal(Object.hasOwn(op,'requestBody'),scope==='keywords:read');
  assert.deepEqual(op.parameters.filter((x:any)=>x.in==='query').map((x:any)=>x.name),queries);
  for(const parameter of op.parameters.filter((x:any)=>x.name==='cursor'))assert.equal(parameter.schema.maxLength,512);
  assert.ok(Object.values(op.responses).every((response:any)=>Object.keys(response.content).length===1));
 }
 const parameter=(suffix:string,name:string)=>(nativeOpenApi.paths as any)[base+suffix].get.parameters.find((x:any)=>x.name===name);
 for(const name of ['from','to'])assert.equal(parameter('/annotations/timeline',name).required,true);
 for(const name of ['from','to','timeZone','search'])assert.equal(parameter('/annotations',name).required,false);
 assert.deepEqual(parameter('/rank-trackers','archived').schema,{type:'string',enum:['active','archived','all'],default:'active'});
 assert.deepEqual(parameter('/rank-trackers/{trackerId}/distribution','device').schema,{type:'string',enum:['desktop','mobile','both'],default:'both'});
 assert.deepEqual(parameter('/rank-trackers/{trackerId}/distribution','runId').schema,{type:'string',format:'uuid'});
 const matrixDevice=parameter('/rank-trackers/{trackerId}/matrix','device');assert.equal(matrixDevice.required,true);assert.deepEqual(matrixDevice.schema.enum,['desktop','mobile']);
 assert.deepEqual(parameter('/rank-trackers/{trackerId}/matrix','runLimit').schema,{type:'integer',minimum:1,maximum:26,default:12});assert.equal(parameter('/rank-trackers/{trackerId}/matrix','search').schema.maxLength,200);
 const list=nativeOpenApi.components.schemas.SavedKeywordList as any;assert.equal(list.additionalProperties,false);assert.deepEqual(list.required,[]);assert.deepEqual(list.properties.pageSize.enum,[50,100,250]);assert.equal(list.properties.cursor.maxLength,512);
 assert.equal(list.properties.filters.additionalProperties,false);assert.deepEqual(Object.keys(list.properties.filters.properties),[...savedKeywordFilterKeys]);
 const cursorBody=nativeOpenApi.components.schemas.CursorBody as any;assert.deepEqual(cursorBody.required,[]);assert.equal(cursorBody.properties.cursor.maxLength,512);
 for(const[suffix,schema]of [['/saved-keywords/list','SavedKeywordList'],['/saved-keywords/tags/list','CursorBody']])assert.deepEqual((nativeOpenApi.paths as any)[base+suffix].post.requestBody.content['application/json'].schema,{$ref:'#/components/schemas/'+schema});
 // Excluded neighbours never enter the bearer inventory: rank catalog/locations/schedule/runs/results/history/checks, every export or refresh, and every saved-definition write.
 for(const path of Object.keys(nativeOpenApi.paths))assert.doesNotMatch(path,/rank-trackers\/(?:catalog|locations|\{trackerId\}\/(?:runs|results|schedule|keywords|quote|update|archive))|rank-checks|\/export$|refresh|saved-keywords$|saved-keywords\/(?:remove|bulk-tags|tags\/\{)|(?:segments|cohorts|annotations)\/\{\w+\}\/(?:update|delete)$/,path);
 // Nor the cookie-only Google app, callback, connect, property, disconnect, import and inspection routes, or any domain write or domain research.
 for(const path of Object.keys(nativeOpenApi.paths))assert.doesNotMatch(path,/^\/api\/google\/|\/google\/(?:connect|connections)|\/domains\/\{domainId\}\/(?:update|challenge|verify|revoke|remove)$|domain-research/,path);
 const offset=parameter('/google/imports/{importId}','offset');assert.deepEqual(offset.schema,{type:'integer',minimum:0,maximum:10000,default:0});assert.equal(offset.required,false);
 for(const suffix of ['/domains','/domains/{domainId}/redirect-checks'])assert.match((nativeOpenApi.paths as any)[base+suffix].get.description,/owner\/admin keys only.*No query parameters\./);
 assert.deepEqual(Object.keys((nativeOpenApi.paths as any)[base+'/google'].get.responses['200'].content['application/json'].schema.properties),['role','connections'],'A key never receives the instance app configuration.');
});

test('retention specification requires month/timezone and preserves closed entry-filter and response bounds',()=>{
 const operation=nativeOpenApi.paths['/api/projects/{projectId}/retention-report'].get,params=operation.parameters as any[],parameter=(name:string)=>params.find(x=>x.name===name);
 assert.deepEqual(operation['x-ten98-scopes'],['analytics:read']);assert.equal(Object.hasOwn(operation,'requestBody'),false);for(const name of ['month','timeZone'])assert.equal(parameter(name).required,true);
 const inherited=(nativeOpenApi.paths['/api/projects/{projectId}/explore'].get.parameters as any[]).filter(x=>!['from','to','timeZone','groupBy','groupProperty','fields','propertyView','propertyCursor'].includes(x.name));assert.deepEqual(params.filter(x=>!['month','timeZone'].includes(x.name)),inherited);
 assert.match(operation.description,new RegExp(String(retentionLimits.json)));assert.match(operation.description,new RegExp(String(retentionLimits.csv)));
 const monthPattern=new RegExp(parameter('month').schema.pattern);for(const month of ['1970-01','2024-03','9998-12'])assert.equal(monthPattern.test(month),true);for(const month of ['1969-12','9999-01','2024-00','2024-13'])assert.equal(monthPattern.test(month),false);
 const now=new Date('2026-10-15T08:00:00Z'),valid={month:'2024-03',timeZone:'Asia/Dubai',kind:'custom',path:'/entry',propertyKey:'done',propertyType:'boolean',propertyValue:'false'};
 const value=retentionReportQuery(new URLSearchParams(valid),now);assert.equal(value.query.month,valid.month);assert.equal(value.query.timeZone,valid.timeZone);assert.equal(value.query.property?.value,false);assert.equal(value.scope.from,'2024-03-01');assert.equal(value.scope.to,'2024-03-31');
 const invalid:Record<string,string>[]=[{month:''},{timeZone:''},{month:'1969-12'},{month:'9999-01'},{month:'2026-11'},{month:'2024-13'},{from:'2024-03-01'},{to:'2024-03-31'},{groupBy:'path'},{groupProperty:'done'},{cursor:'opaque'},{limit:'10'}];for(const patch of invalid)assert.throws(()=>retentionReportQuery(new URLSearchParams({...valid,...patch}),now));
 assert.throws(()=>retentionReportQuery(new URLSearchParams(new URLSearchParams(valid)+'&month=2024-03'),now));
 assert.throws(()=>retentionReportQuery(new URLSearchParams({...valid,fields:'["path","referrer"]'}),now));
 for(const [name,value] of Object.entries({propertyView:'details',propertyCursor:'opaque'}))assert.throws(()=>retentionReportQuery(new URLSearchParams({...valid,[name]:value}),now));
});
test('Journeys specification reuses population filters with closed typed first/last step pairs',()=>{
 const operation=nativeOpenApi.paths['/api/projects/{projectId}/journeys'].get,params=operation.parameters as any[],schema=(name:string)=>params.find(x=>x.name===name)?.schema;
 assert.deepEqual(operation['x-ten98-scopes'],['analytics:read']);assert.equal(Object.hasOwn(operation,'requestBody'),false);
 const inherited=(nativeOpenApi.paths['/api/projects/{projectId}/explore'].get.parameters as any[]).filter(x=>!['groupBy','groupProperty','fields','propertyView','propertyCursor'].includes(x.name));
 assert.deepEqual(params.filter(x=>!['steps','startKind','startValue','endKind','endValue'].includes(x.name)),inherited);
 assert.equal(schema('steps').minimum,2);assert.equal(schema('steps').maximum,journeysLimits.steps);assert.equal(schema('steps').default,journeysQuery(new URLSearchParams()).steps);
 assert.match(operation.description,new RegExp(String(journeysLimits.responseBytes)));
 for(const prefix of ['start','end'])assert.deepEqual(schema(prefix+'Kind').enum,['pageview','custom']);
 for(const steps of [schema('steps').minimum,schema('steps').maximum])for(const kind of schema('startKind').enum){const value=kind==='pageview'?'/literal%25':'signup',result=journeysQuery(new URLSearchParams({steps:String(steps),startKind:kind,startValue:value,endKind:kind,endValue:value,kind:'pageviews',timeZone:'Asia/Dubai',browser:'chrome'}));assert.equal(result.steps,steps);assert.deepEqual(result.start,{kind,value});assert.deepEqual(result.end,{kind,value});assert.equal(result.scope.filters.browser,'chrome');assert.equal(result.scope.timeZone,'Asia/Dubai');}
 const invalid:Record<string,string>[]=[{steps:'1'},{steps:'8'},{steps:'3.0'},{steps:'03'},{startKind:'pageview'},{endValue:'/end'},{startKind:'custom',startValue:'page_view'},{endKind:'pageview',endValue:'/end?query'},{groupBy:'path'},{groupProperty:'plan'},{cursor:'opaque'},{limit:'100'},{sort:'visits'},{compare:'prev'}];
 for(const value of invalid)assert.throws(()=>journeysQuery(new URLSearchParams(value)));
 assert.throws(()=>journeysQuery(new URLSearchParams('steps=3&steps=4')));
 assert.throws(()=>journeysQuery(new URLSearchParams({fields:'["path","referrer"]'})));
 for(const [name,value] of Object.entries({propertyView:'details',propertyCursor:'opaque'}))assert.throws(()=>journeysQuery(new URLSearchParams({[name]:value})));
});
test('attribution specification preserves native population filters and the required closed conversion pair',()=>{
 const operation=nativeOpenApi.paths['/api/projects/{projectId}/attribution'].get,params=operation.parameters as any[],parameter=(name:string)=>params.find(x=>x.name===name);
 assert.deepEqual(operation['x-ten98-scopes'],['analytics:read']);assert.equal(Object.hasOwn(operation,'requestBody'),false);
 const inherited=(nativeOpenApi.paths['/api/projects/{projectId}/explore'].get.parameters as any[]).filter(x=>!['groupBy','groupProperty','fields','propertyView','propertyCursor'].includes(x.name));assert.deepEqual(params.filter(x=>!['model','conversionKind','conversionValue'].includes(x.name)),inherited);
 for(const name of ['conversionKind','conversionValue'])assert.equal(parameter(name).required,true);assert.deepEqual(parameter('model').schema.enum,['first-click','last-click']);assert.equal(parameter('model').schema.default,'first-click');assert.match(operation.description,new RegExp(String(attributionLimits.responseBytes)));
 for(const model of parameter('model').schema.enum)for(const kind of parameter('conversionKind').schema.enum){const value=kind==='pageview'?'/literal%25':'signup',result=attributionQuery(new URLSearchParams({model,conversionKind:kind,conversionValue:value,from:'2024-03-01',to:'2024-03-07',timeZone:'Asia/Dubai',kind:'custom',campaignSource:'recorded'}));assert.equal(result.model,model);assert.deepEqual(result.conversion,{kind,value});assert.equal(result.scope.filters.campaignSource,'recorded');assert.equal(result.scope.timeZone,'Asia/Dubai');}
 const valid={conversionKind:'custom',conversionValue:'signup'};assert.equal(attributionQuery(new URLSearchParams(valid)).model,parameter('model').schema.default);
 const invalid:Record<string,string>[]=[{model:'linear'},{conversionKind:''},{conversionValue:''},{conversionKind:'custom',conversionValue:'page_view'},{conversionKind:'pageview',conversionValue:'/path?query'},{groupBy:'path'},{groupProperty:'plan'},{cursor:'opaque'},{limit:'100'},{sort:'keys'},{currency:'USD'},{compare:'prev'}];for(const patch of invalid)assert.throws(()=>attributionQuery(new URLSearchParams({...valid,...patch})));
 assert.throws(()=>attributionQuery(new URLSearchParams({conversionKind:'custom'})));assert.throws(()=>attributionQuery(new URLSearchParams({conversionValue:'signup'})));assert.throws(()=>attributionQuery(new URLSearchParams(new URLSearchParams(valid)+'&model=first-click&model=last-click')));
 assert.throws(()=>attributionQuery(new URLSearchParams({...valid,fields:'["path","referrer"]'})));
 for(const [name,value] of Object.entries({propertyView:'details',propertyCursor:'opaque'}))assert.throws(()=>attributionQuery(new URLSearchParams({...valid,[name]:value})));
});

test('published batch/patch limits match native strict input and atomic batch semantics',()=>{
 const schemas=nativeOpenApi.components.schemas;assert.equal(schemas.PromptBatch.additionalProperties,false);assert.equal((schemas.PromptBatch.properties.prompts as {maxItems:number}).maxItems,100);
 const input={requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'  Prompt '+i+'  '}))};assert.equal(promptBatch.parse(input).prompts[0].text,'Prompt 0');
 assert.equal(promptBatch.safeParse({...input,prompts:[...input.prompts,{text:'101'}]}).success,false);assert.equal(promptBatch.safeParse({...input,execute:true}).success,false);
 assert.equal(promptPatch.safeParse({requestId:randomUUID(),revision:1}).success,false);assert.equal(promptPatch.safeParse({requestId:randomUUID(),revision:1,enabled:false}).success,true);
});
test('published location detail choices match the native parser and preserve normalized search bounds',()=>{
 const params=nativeOpenApi.paths['/api/projects/{projectId}/analytics'].get.parameters as any[];
 const schema=(name:string)=>params.find(x=>x.name===name)?.schema;
 assert.deepEqual(schema('geoDetail').enum,['region','city']);assert.deepEqual(schema('geoPeriod').enum,['current','comparison']);assert.equal(schema('geoPeriod').default,'current');assert.equal(schema('geoSearch').default,'');assert.equal(schema('geoSearch').maxLength,2048);
 for(const field of schema('geoDetail').enum)for(const period of schema('geoPeriod').enum){
  const result=analyticsQuery(new URLSearchParams({from:'2025-01-01',to:'2026-01-01',geoDetail:field,geoPeriod:period,compare:'yoy',geoSearch:'  Cafe\u0301%_  '}));
  assert.deepEqual(result.detail,{field,period,search:'Café%_'});
 }
 assert.deepEqual(analyticsQuery(new URLSearchParams({geoDetail:'city'})).detail,{field:'city',period:schema('geoPeriod').default,search:schema('geoSearch').default});
 assert.equal(Object.hasOwn(analyticsQuery(new URLSearchParams()),'detail'),false);
 const detail=(geoSearch:string)=>analyticsQuery(new URLSearchParams({geoDetail:'region',geoSearch})).detail;
 assert.equal(detail(' '.repeat(1920)+'x'.repeat(128))?.search,'x'.repeat(128));assert.equal(detail('😀'.repeat(128))?.search,'😀'.repeat(128));
 for(const value of [' '.repeat(1921)+'x'.repeat(128),'x'.repeat(129),'x\u0000'])assert.throws(()=>detail(value));
 assert.equal(geographySearch('\ud800'),null); // URLSearchParams replaces lone surrogates before the query parser sees them.
 const invalid:Record<string,string>[]=[{geoSearch:'x'},{geoPeriod:'current'},{geoDetail:'country'},{geoDetail:'city',geoPeriod:'comparison'},{geoDetail:'city',geoPeriod:'previous'},{geoDetail:'city',offset:'500'}];
 for(const value of invalid)assert.throws(()=>analyticsQuery(new URLSearchParams(value)));
 for(const name of ['geoDetail','geoPeriod','geoSearch']){const query=new URLSearchParams({geoDetail:'city'});query.append(name,name==='geoDetail'?'city':'');query.append(name,'');assert.throws(()=>analyticsQuery(query));}
});
test('specification bypasses invalid configuration and database/setup, with no reflected host or credentials',async()=>{
 const previous=process.env.APP_URL;process.env.APP_URL='not a URL';
 try{const response=await handleApi(new Request('https://untrusted.example/api/openapi.json',{headers:{authorization:'Bearer private-sentinel'}}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.deepEqual(body,nativeOpenApi);assert.equal(JSON.stringify(body).includes('untrusted.example'),false);assert.equal(JSON.stringify(body).includes('private-sentinel'),false);
 for(const request of [new Request('https://untrusted.example/api/openapi.json?x=1'),new Request('https://untrusted.example/api/openapi.json',{headers:{'content-length':'1'}})])assert.equal((await handleApi(request)).status,400);
 assert.equal((await handleApi(new Request('https://untrusted.example/api/openapi.json',{method:'POST',body:'{}'}))).status,405);
 }finally{if(previous===undefined)delete process.env.APP_URL;else process.env.APP_URL=previous;}
});

test('Domain SEO fixed profiles and retained exports stay browser-only with explicit quote bounds',()=>{
 const inventory=nativeOpenApi['x-ten98-browser-operations'];
 const quote=inventory['/api/projects/{projectId}/domain-research/quote'].post;
 const [organic,overview,profile]=quote.body.oneOf;
 assert.ok('enum' in organic.properties.report);assert.ok('const' in overview.properties.limit);
 assert.deepEqual(organic.properties.scope.enum,['subdomains','domain','subfolder','exact_url']);assert.deepEqual(organic.properties.limit.enum,[1,25,50,100]);assert.deepEqual(organic.properties.report.enum,['overview_v1','pages_v1','competitors_v1']);assert.equal(organic.required.includes('report'),false);assert.match(quote.summary,/overview requires limit1/);assert.match(quote.summary,/overview\/competitors require subdomains scope/);assert.equal(quote.quoteSeconds,300);assert.equal(quote.bodyMaxBytes,8192);
 assert.equal(quote.body.oneOf.length,5);for(const [i,report] of ['backlinks_referring_domains_v1','backlinks_anchors_v1'].entries()){const branch=quote.body.oneOf[3+i];assert.equal(branch.properties.report.const,report);assert.deepEqual(branch.properties.limit.enum,[25,50,100]);assert.equal(branch.properties.offset?.maximum,20000);assert.deepEqual(branch.properties.order?.enum,['backlinks_desc','rank_desc','first_seen_desc']);assert.deepEqual(branch.properties.follow,{enum:['all','dofollow','nofollow'],description:'Filters the initial backlinks before grouping.'});assert.deepEqual(branch.properties.sourceHost,{type:'string',maxLength:253,description:'Optional exact source host in the initial backlink population, not a group filter.'});assert.equal(Object.hasOwn(branch.properties,'locationCode'),false);}for(const branch of quote.body.oneOf)assert.equal(branch.additionalProperties,false);
 assert.equal(overview.properties.report.const,'backlinks_overview_v1');assert.equal(overview.properties.limit.const,1);assert.equal(profile.properties.report.const,'backlinks_profile_v1');assert.deepEqual(profile.properties.limit.enum,[25,50,100]);assert.equal(profile.properties.offset?.maximum,20000);assert.deepEqual(profile.properties.follow?.enum,['all','dofollow','nofollow']);for(const branch of [overview,profile])assert.equal(Object.hasOwn(branch.properties,'locationCode'),false);
 for(const path of Object.keys(inventory).filter(path=>path.includes('/domain-research'))){assert.equal(Object.hasOwn(nativeOpenApi.paths,path),false);}
 assert.match(inventory['/api/projects/{projectId}/domain-research/runs'].post.summary,/summary-only ACK/);
 assert.equal(inventory['/api/projects/{projectId}/domain-research/runs/{runId}'].get.responseMaxBytes,2097152);
 assert.equal(inventory['/api/projects/{projectId}/domain-research/runs/{runId}/export'].get.responseMaxBytes,2097152);assert.match(inventory['/api/projects/{projectId}/domain-research/runs/{runId}/export'].get.summary,/current-retention CSV/);
});
