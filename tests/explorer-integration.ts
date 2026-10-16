import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {closeDatabase,getDatabase} from '../src/server/db.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {revokeApiKey} from '../src/server/api-keys.ts';
import {saveCohort} from '../src/server/cohorts.ts';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runExplorerChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(config.databaseUrl).hostname));
  if(process.env.GITHUB_ACTIONS==='true'){
    const database=new URL(config.databaseUrl);assert.equal(process.env.TEN98_ISOLATED_CI_DATABASE,'1');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5432');assert.equal(database.pathname,'/ten98_explorer_ci');assert.doesNotMatch(config.databaseUrl,/[?#]/);
  }
  const {pool}=getDatabase(),owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),workspace=randomUUID(),project=randomUUID(),other=randomUUID();
  const password=randomBytes(24).toString('base64url');
  for(const id of [owner,viewer,foreign]){
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Explorer fixture\',$2)',[id,`${id}@explorer.integration.test`]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,await hashPassword(password)]);
  }
  await pool.query('INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,\'Explorer fixture\',3650)',[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[workspace,owner,viewer]);
  for(const id of [project,other])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Explorer','https://'||$1||'.integration.test',$3,'infinity')",[id,workspace,randomUUID()]);
  const v='a'.repeat(64),visit='b'.repeat(64);
  await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2026-03-08','2026-03-09')",[project,v]);
  const values=[undefined,null,'',42,'42',true,'2026-03-08T12:00:00+04:00',[42,'42'],0.1,0.2,'=HYPERLINK("https://example.invalid")'];
  for(let n=0;n<values.length;n++)await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions,visitor_id,visit_id)
    VALUES($1,$2,$3,$4,'2026-03-08T12:00:00Z',$5,$6,$7,$8)`,[randomUUID(),project,n%2===0?'page_view':'signup',n%2===0?'/one':'/two',
    JSON.stringify(values[n]===undefined?{}:normalizeProperties({value:values[n],'a.b':values[n],nested:{key:values[n]}})),
    JSON.stringify(n%2===0?{language:'en-US',referrerHost:'search.example',campaign:{source:'email',campaign:''}}:{}),n<2?v:null,n<2?visit:null]);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES(gen_random_uuid(),$1,'page_view','/foreign','2026-03-08T12:00:00Z')",[other]);
  const base={from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York'};
  const report=(extra:Record<string,string>={},actor=owner,target=project)=>exploreAnalytics(target,actor,new URLSearchParams({...base,...extra}));
  const all=await report();
  assert.equal(all.range.start,'2026-03-08T05:00:00.000Z');assert.equal(all.range.end,'2026-03-09T04:00:00.000Z');
  assert.deepEqual(all.totals,{events:11,pageViews:6,customEvents:5,identifiedEvents:2,unidentifiedEvents:9,visitors:1,visits:1});
  assert.equal(all.daily[0].events,11);assert.equal(all.breakdown.returnedGroupEvents,11);assert.equal(all.properties.keys.length,3);
  assert.deepEqual((await report({},viewer)).totals,all.totals);await assert.rejects(report({},foreign),{status:404});
  const groups=await report({groupBy:'property',groupProperty:'value'});
  assert.equal(groups.breakdown.totalGroups,11);assert.equal(groups.numeric?.samples,3);assert.equal(groups.numeric?.sum,'42.3');
  assert.equal(groups.numeric?.average,'14.1000000000000000');
  assert.deepEqual(new Set(groups.breakdown.groups.map(g=>g.type)),new Set(['missing','null','string','number','boolean','date','array']));
  assert.ok(groups.csv.includes("'=HYPERLINK"),'CSV data formulas must be neutralized.');
  for(const [type,value,count] of [['missing',undefined,1],['null',null,1],['string','',1],['number',42,1],['string','42',1],['boolean',true,1],['array',[42,'42'],1],['date','2026-03-08T08:00:00Z',1]] as const){
    const filter={propertyKey:'a\\.b',propertyType:type,...(value===undefined?{}:{propertyValue:JSON.stringify(value)})};
    assert.equal((await report(filter)).totals.events,count,`${type} must be distinct`);
  }
  assert.equal((await report({kind:'pageviews',path:'/one',referrer:'search.example',language:'en-US',campaignSource:'email',campaignName:''})).totals.events,6);
  assert.equal((await report({kind:'custom',eventName:'signup'})).totals.events,5);
  assert.equal((await report({groupBy:'referrer'})).breakdown.groups.find(g=>g.type==='missing')?.events,5);
  assert.equal((await report({path:"' OR true; --"})).totals.events,0);
  assert.equal((await report({groupBy:'property',groupProperty:"x') OR true; --"})).breakdown.groups[0].type,'missing');
  const empty=await report({eventName:'no-such-event'});assert.equal(empty.totals.events,0);assert.equal(empty.totals.visitors,null);assert.equal(empty.breakdown.totalGroups,0);
  const fall=await report({from:'2026-11-01',to:'2026-11-01'});assert.equal(Date.parse(fall.range.end)-Date.parse(fall.range.start),25*3600000);
  const skipped=await report({from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia'});assert.equal(skipped.daily[0].skipped,true);assert.equal(skipped.totals.events,0);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES(gen_random_uuid(),$1,'page_view','/exact-gap-start','2018-11-04T03:00:00Z')",[other]);
  const gap=await report({from:'2018-11-04',to:'2018-11-04',timeZone:'America/Sao_Paulo'},owner,other);
  assert.equal(gap.range.start,'2018-11-04T03:00:00.000Z');assert.equal(gap.totals.events,1,'The exact first real instant after a midnight gap must be included.');
  assert.equal((await report({from:'2024-01-01',to:'2024-12-31'})).daily.length,366);
  // Midnight itself repeats in this zone: include its first occurrence too.
  const midnight=await report({from:'2026-11-01',to:'2026-11-01',timeZone:'America/Havana'});
  assert.equal(Date.parse(midnight.range.end)-Date.parse(midnight.range.start),25*3600000,'Repeated local midnight must use its first occurrence.');
  for(const at of ['1987-10-25T03:00:30Z','1987-10-25T03:01:00Z','1987-10-25T03:30:00Z','1987-10-25T04:00:00Z'])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES(gen_random_uuid(),$1,'page_view','/repeated-date',$2)",[project,at]);
  for(const [from,to,expected] of [['1987-10-24','1987-10-24',2],['1987-10-25','1987-10-25',2],['1987-10-24','1987-10-25',4]] as const){
    const reversed=await report({from,to,timeZone:'America/Goose_Bay'});assert.equal(reversed.totals.events,expected);
    assert.equal(reversed.daily.reduce((sum,day)=>sum+(day.events??0),0),expected,'A local date may reverse after midnight; buckets must reconcile with totals.');
  }
  console.log('PASS Explorer typed filters, exact decimals, identity coverage, tenant isolation, DST and skipped dates');

  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at,properties)
    SELECT gen_random_uuid(),$1,'page_view','/group-'||lpad(n::text,3,'0'),'2026-03-09T12:00:00Z',jsonb_build_object('key-'||lpad(n::text,3,'0'),jsonb_build_object('type','number','value',n)) FROM generate_series(1,105) n`,[project]);
  const capped=await report({from:'2026-03-09',to:'2026-03-09',groupBy:'path'});
  assert.equal(capped.breakdown.truncated,true);assert.equal(capped.breakdown.totalGroups,105);assert.equal(capped.breakdown.groups.length,100);assert.equal(capped.breakdown.returnedGroupEvents,100);
  assert.equal(capped.breakdown.groups[0].value,'/group-001');assert.equal(capped.properties.keys.length,100);assert.equal(capped.properties.truncated,true);
  await pool.query("UPDATE project SET analytics_retained_from='2026-03-08T13:00:00Z' WHERE id=$1",[project]);
  const partial=await report({to:'2026-03-09'});assert.equal(partial.coverage.status,'partial');assert.equal(partial.daily[0].coverage,'partial');assert.equal(partial.totals.events,105);
  const absent=await report({from:'2026-03-07',to:'2026-03-07'});assert.equal(absent.coverage.status,'unavailable');assert.ok(Object.values(absent.totals).every(value=>value===null));assert.equal(absent.daily[0].events,null);
  console.log('PASS Explorer deterministic bounded groups and inventory, same-snapshot retention coverage and totals');

  const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${owner}@explorer.integration.test`,password})}));
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const url=`${config.appUrl}/api/projects/${project}/explore?`+new URLSearchParams(base);
  assert.equal((await handleApi(new Request(url))).status,401);
  assert.equal((await handleApi(new Request(url,{headers:{cookie}}))).status,200);
  assert.equal((await handleApi(new Request(url+'&timeZone=UTC',{headers:{cookie}}))).status,400);
  const scoped=await createApiKey(workspace,owner,{name:'Explorer read fixture',scopes:['analytics:read']});
  assert.equal((await handleApi(new Request(url,{headers:{authorization:`Bearer ${scoped.token}`}}))).status,200);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);
  assert.equal((await handleApi(new Request(url,{headers:{cookie}}))).status,404);
  assert.notEqual((await handleApi(new Request(url,{headers:{authorization:`Bearer ${scoped.token}`}}))).status,200);
  console.log('PASS Explorer HTTP login, scope, live membership and malformed-query boundaries');
  await runCompoundExplorerChecks();
}

async function runCompoundExplorerChecks(){
  const {pool}=getDatabase(),config=getConfig(),workspace=randomUUID(),project=randomUUID(),inventory=randomUUID(),geoProject=randomUUID(),pressure=randomUUID(),password=randomBytes(24).toString('base64url');
  const actors=Object.fromEntries(['owner','admin','editor','viewer','foreign'].map(role=>[role,randomUUID()])),cookies:Record<string,string>={},base={from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York',kind:'all'},fields=['campaignSource','campaignMedium','campaignName'];
  const ledgerBefore=(await pool.query('SELECT id,md5(to_jsonb(p)::text) AS digest FROM provider_request p ORDER BY id')).rows;
  for(const [role,id]of Object.entries(actors)){await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,$2,$3)',[id,'Tuple '+role,id+'@tuple.integration.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,await hashPassword(password)]);}
  await pool.query("INSERT INTO workspace(id,name,raw_analytics_days)VALUES($1,'Tuple fixture',3650)",[workspace]);
  for(const [role,id]of Object.entries(actors))if(role!=='foreign')await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,id,role]);
  for(const id of [project,inventory,geoProject,pressure])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Tuple fixture','https://'||$1||'.tuple.integration.test',$3,'infinity')",[id,workspace,randomUUID()]);
  const visitors=['1','2','3','4'].map(value=>value.repeat(64));for(const key of visitors)await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2026-03-08','2026-03-08')",[project,key]);
  const samples:[string|undefined,string,string,string|null,string][]=[['google','cpc','spring',visitors[0],'page_view'],['google','cpc','spring',visitors[0],'page_view'],['google','cpc','spring',null,'signup'],['google','cpc','summer',visitors[0],'page_view'],['google','cpc','summer',visitors[1],'page_view'],['email','newsletter','spring',null,'page_view'],[undefined,'cpc','spring',visitors[2],'page_view'],['','cpc','spring',visitors[2],'signup'],['missing','cpc','spring',visitors[3],'page_view']];
  for(const [source,medium,campaign,visitor,event]of samples)await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions,visitor_id,visit_id)VALUES(gen_random_uuid(),$1,$2,'/entry','2026-03-08T12:00:00Z',$3,$4,$5)",[project,event,JSON.stringify({campaign:{...(source===undefined?{}:{source}),medium,campaign}}),visitor,visitor]);
  const report=(extra:Record<string,string>={},target=project,actor=actors.owner)=>exploreAnalytics(target,actor,new URLSearchParams({...base,fields:JSON.stringify(fields),...extra}));
  const scalarBefore=await exploreAnalytics(project,actors.owner,new URLSearchParams({...base,groupBy:'campaignSource'})),tuple=await report();
  assert.deepEqual(tuple.query,{...base,fields,filters:{},property:null});assert.deepEqual(tuple.totals,{events:9,pageViews:7,customEvents:2,identifiedEvents:7,unidentifiedEvents:2,visitors:4,visits:4});assert.equal(tuple.breakdown.totalGroups,6);assert.equal(tuple.breakdown.returnedGroupEvents,9);assert.equal(tuple.numeric,null);
  const atom=(type:string,value:unknown)=>({type,value}),find=(source:unknown,medium='cpc',campaign='spring')=>tuple.breakdown.groups.find(row=>JSON.stringify(row.value)===JSON.stringify([source,atom('string',medium),atom('string',campaign)]))!;
  assert.deepEqual(find(atom('string','google')),{type:'tuple',value:[atom('string','google'),atom('string','cpc'),atom('string','spring')],events:3,identifiedEvents:2,visitors:1,pageViews:2,identifiedPageViews:2,estimatedVisitors:1,visits:1,bounceRate:0,averageVisitSeconds:0});assert.equal(find(atom('string','google'),'cpc','summer').visitors,2);assert.equal(find(atom('string','email'),'newsletter').visitors,null);assert.equal(find(atom('missing',null)).events,1);assert.equal(find(atom('string','')).events,1);assert.equal(find(atom('string','missing')).events,1);assert.equal(tuple.breakdown.groups.reduce((sum,row)=>sum+(row.visitors??0),0),6,'Group visitor counts must not be summed into parent visitors.');
  assert.deepEqual((await report({fields:JSON.stringify(fields.slice(0,2))})).breakdown.groups.find(row=>JSON.stringify(row.value)===JSON.stringify([atom('string','google'),atom('string','cpc')]))?.events,5);
  const reversed=await report({fields:JSON.stringify([...fields].reverse())});assert.deepEqual((reversed.query as {fields:string[]}).fields,[...fields].reverse());assert.ok(reversed.breakdown.groups.every(row=>Array.isArray(row.value)&&row.value.length===3));
  assert.deepEqual(await exploreAnalytics(project,actors.owner,new URLSearchParams({...base,groupBy:'campaignSource'})),scalarBefore,'A tuple read must not change legacy scalar DTO/CSV.');
  assert.equal((await report({kind:'pageviews'})).totals.events,7);assert.equal((await report({campaignSource:'google'})).totals.events,5);assert.equal((await report({predicates:JSON.stringify({version:1,match:'all',fields:[{field:'campaignSource',operator:'missing'}],properties:[]})})).totals.events,1);
  assert.equal(tuple.csv.includes('"campaignSource type","campaignSource value"'),true);assert.equal(tuple.csv.includes('"Returned group events","9"'),true);
  console.log('PASS compound Explorer nine actual events/six tuples, nonadditive keys, typed missing/empty/literal, field order, two-field rollup and unchanged scalar snapshot');
  for(const [source,medium]of [['a|b','c'],['a','b|c']])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions)VALUES(gen_random_uuid(),$1,'page_view','/collision','2026-03-08T12:00:00Z',$2)",[inventory,JSON.stringify({campaign:{source,medium,campaign:'=SUM(1,2)'}})]);
  const collision=await report({},inventory);assert.equal(collision.breakdown.totalGroups,2);assert.ok(collision.csv.includes("'=SUM(1,2)"));
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions)SELECT gen_random_uuid(),$1,'page_view','/top','2026-03-09T12:00:00Z',jsonb_build_object('campaign',jsonb_build_object('source','source-'||lpad(n::text,3,'0'),'medium','cpc','campaign','spring'))FROM generate_series(1,501)n",[inventory]);
  const ranked=await report({from:'2026-03-09',to:'2026-03-09'},inventory);assert.equal(ranked.totals.events,501);assert.equal(ranked.breakdown.totalGroups,501);assert.equal(ranked.breakdown.groups.length,500);assert.equal(ranked.breakdown.returnedGroupEvents,500);assert.equal(ranked.breakdown.truncated,true);assert.deepEqual(ranked.breakdown.groups[0].value,[atom('string','source-001'),atom('string','cpc'),atom('string','spring')]);
  assert.deepEqual(ranked.breakdown.groups[499].value,[atom('string','source-500'),atom('string','cpc'),atom('string','spring')]);assert.equal(ranked.breakdown.groups.every(row=>row.pageViews===1&&row.estimatedVisitors===null&&row.visits===null&&row.bounceRate===null&&row.averageVisitSeconds===null),true);
  const geo={version:'dbip-city-lite-v1',databaseBuild:1790818881,databaseSha256:'a'.repeat(64)};
  for(const observation of [{...geo,country:'US',region:{code:'US-CA',name:'California'},city:'Café'},{...geo,country:null,region:null,city:null},null])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions)VALUES(gen_random_uuid(),$1,'page_view','/geo','2026-03-08T12:00:00Z',$2)",[geoProject,JSON.stringify(observation?{geography:observation}:{})]);
  const geographic=await report({fields:'["country","city"]'},geoProject);assert.equal(geographic.breakdown.totalGroups,3);assert.equal(geographic.geographyProvenance?.databaseCount,1);assert.deepEqual(new Set(geographic.breakdown.groups.map(row=>JSON.parse((row.value as {value:string}[])[0].value).state)),new Set(['known','unknown','not-recorded']));assert.ok(geographic.csv.includes('DB-IP City Lite'));
  console.log('PASS compound full-population top500/501, collision-safe/formula-safe tuples and canonical known/unknown/not-recorded geography');
  const cohort=await saveCohort(project,actors.owner,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Tuple qualification',query:new URLSearchParams({...base,path:'/entry'}).toString()}});
  const cohortReport=await report({cohortId:cohort.item!.id,cohortRevision:String(cohort.item!.revision)});assert.equal(cohortReport.totals.events,7);assert.equal(cohortReport.cohort?.membership.countsAreLowerBounds,true);assert.ok(cohortReport.csv.includes('Tuple qualification'));
  assert.equal(cohortReport.breakdown.groups.every(row=>row.bounceRate===null&&row.averageVisitSeconds===null),true,'Incomplete qualification keeps observed counts but cannot establish complete visit rates.');
  await assert.rejects(report({cohortId:cohort.item!.id,cohortRevision:String(cohort.item!.revision+1)}),{status:409});
  const empty=await report({path:'/absent'});assert.equal(empty.totals.events,0);assert.equal(empty.totals.visitors,null);assert.equal(empty.breakdown.totalGroups,0);
  assert.equal(Date.parse(tuple.range.end)-Date.parse(tuple.range.start),23*3600000);assert.equal((await report({from:'2026-11-01',to:'2026-11-01'})).range.end,'2026-11-02T05:00:00.000Z');assert.equal((await report({from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia'})).daily[0].skipped,true);
  const unknownSelection=await report({predicates:JSON.stringify({version:1,match:'all',fields:[],properties:[],sessionProperties:[{key:'plan',operator:'missing'}]})});assert.ok(unknownSelection.sessionProperties);assert.equal(unknownSelection.totals.events,7,'Unkeyed events cannot satisfy current-key property selection.');
  await pool.query("UPDATE project SET session_properties_evidence_lost_at=clock_timestamp() WHERE id=$1",[project]);
  const missingSelection=await report({predicates:JSON.stringify({version:1,match:'all',fields:[],properties:[],sessionProperties:[{key:'plan',operator:'missing'}]})});assert.equal(missingSelection.sessionProperties?.selection.status,'unavailable');assert.equal(missingSelection.breakdown.totalGroups,null);assert.equal(missingSelection.breakdown.groups.length,0);
  console.log('PASS compound cohorts and current-property evidence, true empty versus unavailable, DST and skipped local dates');
  const metricKeys=Array.from({length:6},(_,i)=>(i+5).toString(16).repeat(64)),visit=(n:number)=>n.toString(16).padStart(64,'0');
  for(const key of metricKeys)await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2026-03-10','2026-03-10')",[pressure,key]);
  const metricSamples:[string,number,string|null,string|null,string?][]=[['/a',0,metricKeys[0],visit(1)],['/b',30,metricKeys[0],visit(1)],['/a',60,metricKeys[0],visit(1)],['/c',0,metricKeys[1],visit(2)],['/d',10,metricKeys[1],visit(2),'custom'],['/e',0,metricKeys[2],visit(3)],['/f',30,metricKeys[2],visit(3)],['/g',0,metricKeys[3],visit(4)],['/g',10,metricKeys[3],visit(5)],['/g',30,metricKeys[3],visit(5)],['/g',50,metricKeys[3],visit(5)],['/h',0,metricKeys[4],visit(6)],['/h',0,metricKeys[5],visit(6)],['/outside',10,metricKeys[4],visit(6),'custom'],['/anonymous',0,null,null]];
  for(const [path,seconds,key,visitId,event='page_view']of metricSamples)await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id)VALUES(gen_random_uuid(),$1,$2,$3,'2026-03-10T12:00:00Z'::timestamptz+$4*interval '1 second',$5,$6)",[pressure,event,path,seconds,key,visitId]);
  // Outside-range custom activity cannot suppress this visit's bounce.
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id)VALUES(gen_random_uuid(),$1,'custom','/elsewhere','2026-03-11T12:00:00Z',$2,$3)",[pressure,metricKeys[2],visit(3)]);
  const metricQuery={from:'2026-03-10',to:'2026-03-10',fields:'["path","campaignSource"]'},metrics=await report(metricQuery,pressure);
  const metricRow=(path:string,value=metrics)=>value.breakdown.groups.find(row=>(row.value as {value:unknown}[])[0].value===path)!;
  assert.equal(metrics.totals.pageViews,13);assert.equal(metrics.totals.customEvents,2);assert.equal(metricRow('/a').averageVisitSeconds,60);assert.equal(metricRow('/b').averageVisitSeconds,0);assert.equal(metricRow('/b').bounceRate,100);
  assert.equal(metricRow('/c').bounceRate,0);assert.equal(metricRow('/e').bounceRate,100,'Other-path page views do not suppress a single matching page-view bounce.');
  assert.equal(metricRow('/g').estimatedVisitors,1);assert.equal(metricRow('/g').visits,2);assert.equal(metricRow('/g').bounceRate,50);assert.equal(metricRow('/g').averageVisitSeconds,20,'Average weights each visit equally, including its zero-second visit.');
  assert.equal(metricRow('/h').estimatedVisitors,2);assert.equal(metricRow('/h').visits,2);assert.equal(metricRow('/h').bounceRate,50,'Identical visit IDs belong to separate visitor/visit pairs.');assert.equal((metrics.breakdown.groups[0].value as {value:string}[])[0].value,'/h','Rank uses page-view visitors before page views.');
  for(const path of ['/anonymous','/d']){const row=metricRow(path);assert.equal(row.pageViews,path==='/anonymous'?1:0);assert.deepEqual([row.estimatedVisitors,row.visits,row.bounceRate,row.averageVisitSeconds],[null,null,null,null]);}
  const filteredMetrics=await report({...metricQuery,path:'/c',kind:'pageviews'},pressure);assert.equal(metricRow('/c',filteredMetrics).bounceRate,0,'A custom event outside exact report/kind filters still suppresses bounce.');
  const advancedMetrics=await report({...metricQuery,predicates:JSON.stringify({version:1,match:'all',fields:[{field:'path',operator:'eq',value:'/c'}],properties:[]})},pressure);assert.equal(metricRow('/c',advancedMetrics).bounceRate,0,'The same rule precedes advanced report filters.');
  assert.ok(metrics.csv.includes('"Estimated visitors (page views)"'));assert.ok(metrics.csv.includes('"Average observed visit duration (seconds)"'));assert.ok(Buffer.byteLength(JSON.stringify(metrics),'utf8')<=2097152);
  await pool.query("UPDATE project SET analytics_retained_from=$2::timestamptz+interval '1 hour' WHERE id=$1",[pressure,metrics.range.start]);const partialMetrics=await report(metricQuery,pressure);assert.equal(partialMetrics.coverage.status,'partial');assert.equal(metricRow('/g',partialMetrics).visits,2);assert.equal(metricRow('/g',partialMetrics).bounceRate,null);assert.equal(metricRow('/g',partialMetrics).averageVisitSeconds,null);await pool.query('UPDATE project SET analytics_retained_from=NULL WHERE id=$1',[pressure]);
  console.log('PASS compound Umami per-group visit span, project-range custom bounce suppression, weighted visits, paired identities, anonymous unknowns and retained partial-rate suppression');
  for(const [role,id]of Object.entries(actors)){const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:id+'@tuple.integration.test',password})}));assert.equal(login.status,200);cookies[role]=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');}
  const endpoint=(extra:Record<string,string>={},target=project)=>`${config.appUrl}/api/projects/${target}/explore?`+new URLSearchParams({...base,fields:JSON.stringify(fields),...extra});
  for(const role of ['owner','admin','editor','viewer'])assert.equal((await handleApi(new Request(endpoint(),{headers:{cookie:cookies[role]}}))).status,200);
  assert.equal((await handleApi(new Request(endpoint(),{headers:{cookie:cookies.foreign}}))).status,404);assert.equal((await handleApi(new Request(endpoint()))).status,401);
  for(const extra of Array.of<Record<string,string>>({groupBy:'path'},{fields:'["path","path"]'}))assert.equal((await handleApi(new Request(endpoint(extra),{headers:{cookie:cookies.owner}}))).status,400);
  const key=await createApiKey(workspace,actors.owner,{name:'Tuple read',scopes:['analytics:read']});try{assert.equal((await handleApi(new Request(endpoint(),{headers:{authorization:'Bearer '+key.token}}))).status,200);await revokeApiKey(workspace,actors.owner,key.key.id);assert.equal((await handleApi(new Request(endpoint(),{headers:{authorization:'Bearer '+key.token}}))).status,401);}finally{await revokeApiKey(workspace,actors.owner,key.key.id);}
  const expiring=await createApiKey(workspace,actors.owner,{name:'Tuple wait expiry',scopes:['analytics:read']}),lock=await pool.connect();let pending:Promise<Response>|undefined,waitProof:unknown;
  try{
    await lock.query('BEGIN');const blocker=(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
    pending=handleApi(new Request(endpoint({predicates:JSON.stringify({version:1,match:'all',fields:[],properties:[],sessionProperties:[{key:'plan',operator:'missing'}]})}),{headers:{authorization:'Bearer '+expiring.token}}));void pending.catch(()=>{});
    const deadline=Date.now()+1000;let blocked=false;while(Date.now()<deadline){await lock.query('SELECT pg_stat_clear_snapshot()');blocked=!!(await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database()AND pid<>pg_backend_pid()AND $1=ANY(pg_blocking_pids(pid))AND wait_event_type='Lock'",[blocker])).rowCount;if(blocked)break;await lock.query('SELECT pg_sleep(0.005)');}assert.equal(blocked,true,'Observe this request waiting at the exact workspace blocker.');
    const expires=(await lock.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '60 milliseconds' WHERE id=$1 RETURNING expires_at::text AS expiry",[expiring.key.id])).rows[0].expiry;
    let elapsed=false;while(Date.now()<deadline){elapsed=(await lock.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[expires])).rows[0].expired;if(elapsed)break;await lock.query('SELECT pg_sleep(0.005)');}assert.equal(elapsed,true);await lock.query('COMMIT');assert.equal((await pending).status,401,'Final key admission must use the actual post-wait expiry.');waitProof={blockObserved:blocked,naturalExpiryObserved:elapsed};
  }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});await revokeApiKey(workspace,actors.owner,expiring.key.id);}
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,actors.viewer]);assert.equal((await handleApi(new Request(endpoint(),{headers:{cookie:cookies.viewer}}))).status,404);
  // Adversarial stored-schema strings, not a claim these are normalized browser URLs.
  const long='\u0001'.repeat(2000);await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions)SELECT gen_random_uuid(),$1,'page_view','/'||$2||n::text,'2026-03-08T12:00:00Z',jsonb_build_object('origin',$2,'referrerHost',$2)FROM generate_series(1,105)n",[pressure,long]);
  const pressureFields='["path","origin","referrer"]',smallPath='/'+long+'1';assert.equal((await report({fields:pressureFields,path:smallPath},pressure)).totals.events,1);
  const tooLarge=await handleApi(new Request(endpoint({fields:pressureFields},pressure),{headers:{cookie:cookies.owner}}));assert.equal(tooLarge.status,503);assert.match((await tooLarge.json()).error,/complete combination report is too large/i);assert.equal((await handleApi(new Request(endpoint({fields:pressureFields,path:smallPath},pressure),{headers:{cookie:cookies.owner}}))).status,200);
  await pool.query("UPDATE project SET analytics_retained_from='2026-03-08T13:00:00Z' WHERE id=$1",[project]);const partial=await report();assert.equal(partial.coverage.status,'partial');assert.equal(partial.totals.events,0);const expired=await report({from:'2026-03-07',to:'2026-03-07'});assert.equal(expired.coverage.status,'unavailable');assert.equal(expired.breakdown.totalGroups,null);assert.equal(expired.breakdown.returnedGroupEvents,null);
  assert.deepEqual((await pool.query('SELECT id,md5(to_jsonb(p)::text) AS digest FROM provider_request p ORDER BY id')).rows,ledgerBefore);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()AND state='idle in transaction'")).rows[0].n,0);
  if(process.env.TEN98_EXPLORER_TUPLE_OUTPUT){const target=resolve(process.env.TEN98_EXPLORER_TUPLE_OUTPUT),prefix=resolve('private/compound-breakdown');assert.ok(target.startsWith(prefix+'/')||target.startsWith(prefix+'\\'));assert.ok(target.endsWith('.json'));await writeFile(target,JSON.stringify({tuple,reversed,ranked,geographic,cohortReport,empty,missingSelection,expired,waitProof,metrics,filteredMetrics,advancedMetrics,partialMetrics})+'\n');}
  console.log('PASS compound actual four-role HTTP/key/revocation, complete2MiB refusal with same-record small recovery, retention and unchanged financial rows');
}

if(import.meta.main){try{await runExplorerChecks();}finally{await closeDatabase();}}
