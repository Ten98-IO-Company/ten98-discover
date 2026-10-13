import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {closeDatabase,getDatabase} from '../src/server/db.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';

export async function runExplorerChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(config.databaseUrl).hostname));
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
}

if(import.meta.main){try{await runExplorerChecks();}finally{await closeDatabase();}}
