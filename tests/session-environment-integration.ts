import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {collectNative,saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import {getPublicDestinations} from '../src/server/destinations.ts';
import {getSessionDetail,getLinkedSessionActivity} from '../src/server/session-explorer.ts';
import {environmentVersion} from '../src/lib/analytics-environment.ts';

export async function runSessionEnvironmentChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SESSION_ENVIRONMENT_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_session_environment_ci';assert.equal(url.port,ci?'5432':'55501');if(!ci)assert.match(url.pathname,/^\/ten98_session_environment_[a-f0-9]{12}$/);assert.equal(url.search,'');assert.equal(url.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  assert.equal(process.env.ANALYTICS_NETWORK_MODE,'direct');await assertSchema();const{pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
  const owner=randomUUID(),viewer=randomUUID(),workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID(),origin='https://session-environment.test';
  for(const user of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Session environment fixture\',$2)',[user,user+'@session-environment.test']);await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Session environment fixture')",[workspace]);for(const[user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Session environment fixture',$3,$4,'infinity')",[project,workspace,origin,siteKey]);
  const settings=(await pool.query('SELECT analytics_settings,analytics_revision FROM project WHERE id=$1',[project])).rows[0];await saveAnalyticsSettings(project,owner,{revision:settings.analytics_revision,settings:{...settings.analytics_settings,captureReferrer:true,linkIdentities:true}});const tracking=await getPublicDestinations(siteKey,'live',origin),consent={analytics:true as const,epoch:tracking.consentEpoch};
  const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',ip='192.0.2.50',longHost=('a'.repeat(60)+'.').repeat(6)+'test',request=()=>new Request(origin,{headers:{origin,'user-agent':ua}}),firstId=randomUUID();
  const first=await collectNative(request(),siteKey,{eventId:firstId,name:'page_view',url:origin+'/native?discard-private#fragment',dimensions:{distinctId:'synthetic-session-user',referrer:'https://'+longHost+'/referrer-path?discard-private'},consent},ip);assert.equal(first.accepted,true);assert.ok('context'in first&&first.context);
  const second=await collectNative(request(),siteKey,{eventId:randomUUID(),name:'button',url:origin+'/native',dimensions:{distinctId:'synthetic-session-user',referrer:'https://'+longHost},context:first.context,consent,properties:{action:'synthetic'}},ip);assert.equal(second.accepted,true);
  const events=(await pool.query('SELECT visitor_id,dimensions,to_jsonb(e) AS value FROM event e WHERE project_id=$1 ORDER BY received_at,id',[project])).rows;assert.equal(events.length,2);const visitor=events[0].visitor_id as string;assert.match(visitor,/^[a-f0-9]{64}$/);assert.ok(events.every(row=>row.visitor_id===visitor));
  for(const row of events){assert.deepEqual(row.dimensions,{referrerHost:longHost,browser:'chrome',os:'Windows 10',device:'desktop',environmentVersion,origin});for(const discarded of [ua,ip,'synthetic-session-user','discard-private','referrer-path'])assert.equal(JSON.stringify(row.value).includes(discarded),false);}
  console.log('PASS actual native consented explicit-link collection stores bounded environment and370-character referrer with no raw address/UA/identifier/query evidence');
  const today=new Date().toISOString().slice(0,10),params=new URLSearchParams({from:today,to:today,timeZone:'UTC'}),authority={kind:'session' as const,userId:viewer},detail=JSON.parse(JSON.stringify(await getSessionDetail(project,visitor,authority,params))),linked=JSON.parse(JSON.stringify(await getLinkedSessionActivity(project,visitor,authority,params)));
  assert.equal(detail.activity.length,2);assert.equal(linked.activity.length,2);assert.equal(detail.summary.events,2);assert.equal(linked.summary.events,2);
  const server=await createServer({configFile:false,cacheDir:'private/session-environment-integration-cache-'+process.pid,appType:'custom',server:{middlewareMode:true,hmr:false,watch:null}});
  try{
    const{readSessionResponse,readLinkedActivityResponse}=await server.ssrLoadModule('/src/lib/session-explorer.ts');
    for(const[response,read]of [[detail,(value:unknown)=>readSessionResponse(value,params,project,visitor)],[linked,(value:unknown)=>readLinkedActivityResponse(value,params,project,visitor)]]as const){const confirmed=read(response);assert.deepEqual(confirmed.activity,response.activity);assert.ok(confirmed.activity.every((event:{dimensions:Record<string,unknown>})=>event.dimensions.environmentVersion===environmentVersion&&event.dimensions.browser==='chrome'&&event.dimensions.referrerHost===longHost));for(const change of [{environmentVersion:'future-environment-v9'},{browser:'forged'},{ip},{userAgent:ua},{referrerHost:'x'.repeat(2049)}]){const invalid=structuredClone(response);Object.assign(invalid.activity[0].dimensions,change);assert.throws(()=>read(invalid));}}
    console.log('PASS both real native SQL detail and linked DTOs validate forViewer through Vite SSR; unsupported metadata/future version/raw fields/overlong host still reject');
  }finally{await server.close();}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);return{project,visitor,params:params.toString(),detail,linked};
}
if(import.meta.main){try{await runSessionEnvironmentChecks();}finally{await closeDatabase();}}
