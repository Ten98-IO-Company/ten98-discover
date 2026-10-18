import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDatabase} from '../src/server/db.ts';
import {getConfig} from '../src/server/config.ts';
import {collectNative,saveAnalyticsSettings,trackingConsentEpoch} from '../src/server/native-analytics.ts';
import {getPublicDestinations,publishDestinations,saveDestinationsDraft} from '../src/server/destinations.ts';

export async function runNativeAnalyticsChecks(options:{baseUrl:string;appUrl:string;ownerCookie:string;ownerId:string;workspaceId:string}) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(getConfig().databaseUrl).hostname));
  const {pool}=getDatabase(), projectId=randomUUID(), siteKey=randomUUID(), origin='https://native.integration.test';
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)',[projectId,options.workspaceId,'Native analytics acceptance',origin,siteKey]);
  // Keep the original consent-first acceptance independent of future-project defaults.
  await pool.query("UPDATE project SET analytics_settings=jsonb_set(analytics_settings,'{collectionMode}','\"consent-first\"') WHERE id=$1",[projectId]);
  async function call(path:string,body?:unknown,publicCall=false,extra:Record<string,string>={}) {
    const response=await fetch(new URL(path,options.baseUrl),{method:body===undefined?'GET':'POST',headers:{origin:publicCall?origin:options.appUrl,
      ...(!publicCall?{cookie:options.ownerCookie}:{}),'user-agent':'Ten98 acceptance browser',...extra,...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    return {status:response.status,data:await response.json()};
  }
  let config=await getPublicDestinations(siteKey,'live',origin);
  const consent=()=>({analytics:true as const,epoch:config.consentEpoch});
  const event=()=>({siteKey,eventId:randomUUID(),name:'page_view',url:origin+'/hello?private-query#private-fragment'});
  assert.deepEqual((await call('/api/collect',event(),true)).data,{accepted:false,reason:'consent_required'});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event WHERE project_id=$1',[projectId])).rows[0].n,0);
  const acceptedEvent={...event(),consent:consent(),properties:{plan:'starter',nested:{count:2},when:'2024-02-29T12:00:00+04:00'},dimensions:{
    language:'en-us',referrer:'https://private-referrer.example/secret',campaign:{source:'private-campaign'},screen:{width:1024,height:768},distinctId:'private-distinct',
    clickIds:{gclid:'private-gclid',fbclid:'',msclkid:'m'.repeat(300),twclid:'😀'.repeat(256)}}};
  const clickColumns=['gclid','fbclid','msclkid','ttclid','li_fat_id','twclid'];
  const accepted=await call('/api/collect',acceptedEvent,true,{'x-forwarded-for':'192.0.2.99'});
  assert.equal(accepted.status,202); assert.equal(accepted.data.accepted,true); assert.equal(accepted.data.duplicate,false);
  if(process.env.ANALYTICS_NETWORK_MODE==='direct') assert.equal(typeof accepted.data.context,'string','Production Node transport must expose its real peer.');
  const duplicate=await call('/api/collect',{...acceptedEvent,properties:{overwrite:true}},true);
  assert.deepEqual(duplicate.data,{accepted:true,duplicate:true});
  const stored=(await pool.query('SELECT row_to_json(e) AS value FROM event e WHERE project_id=$1 AND id=$2',[projectId,acceptedEvent.eventId])).rows[0].value;
  assert.equal(stored.path,'/hello'); assert.equal(stored.source,'browser');
  assert.equal(stored.collection_basis,'consent');
  assert.equal(stored.identity_link_evidence_version,null,'Linking-off collection must not claim explicit event evidence.');
  assert.equal((await pool.query('SELECT identity_event_evidence_started_at FROM project WHERE id=$1',[projectId])).rows[0].identity_event_evidence_started_at,null);
  const {browser:storedBrowser,os:storedOs,device:storedDevice,environmentVersion:storedEnvironmentVersion,...storedPublicDimensions}=stored.dimensions;
  assert.deepEqual({browser:storedBrowser,os:storedOs,device:storedDevice,environmentVersion:storedEnvironmentVersion},{browser:'unknown',os:'unknown',device:'unknown',environmentVersion:'server-ua-environment-v1'});
  assert.deepEqual(storedPublicDimensions,{language:'en-US',origin});
  assert.deepEqual(stored.properties,{'plan':{type:'string',value:'starter'},'nested.count':{type:'number',value:2},when:{type:'date',value:'2024-02-29T08:00:00.000Z'}});
  for(const text of ['private-query','private-fragment','private-referrer','private-campaign','private-distinct','private-gclid','192.0.2.99','Ten98 acceptance browser'])assert.equal(JSON.stringify(stored).includes(text),false);
  for(const column of clickColumns)assert.equal(stored[column],null,'Campaign capture off stores no ad click identifier, even with the analytics grant.');
  for(const headers of [{'dnt':'1'},{'sec-gpc':'1'},{'user-agent':'Example crawler'}] as Record<string,string>[])assert.equal((await call('/api/collect',{...event(),consent:consent()},true,headers)).data.accepted,false);
  for(const properties of [{bad:'\u0000'},JSON.parse('{"__proto__":{"polluted":true}}'),{bad:'x'.repeat(1001)}])assert.equal((await call('/api/collect',{...event(),consent:consent(),properties},true)).status,400);
  for(const invalid of [{properties:null},{dimensions:null},{url:origin+'/'+ 'é'.repeat(400)}])assert.equal((await call('/api/collect',{...event(),consent:consent(),...invalid},true)).status,400);
  assert.equal((await call('/api/collect',{...event(),consent:consent(),identity_link_evidence_version:1},true)).status,400,'Payloads cannot supply the trusted event marker.');

  const settings=config.nativeTracking;
  const saved=await saveAnalyticsSettings(projectId,options.ownerId,{revision:1,settings:{...settings,captureReferrer:true,captureCampaigns:true,captureScreen:true,excludedPaths:['/private','/café']}});
  assert.equal(saved.revision,2);
  await assert.rejects(saveAnalyticsSettings(projectId,options.ownerId,{revision:1,settings}),{status:409});
  assert.equal((await call('/api/collect',{...event(),consent:consent()},true)).data.reason,'consent_required');
  config=await getPublicDestinations(siteKey,'live',origin);
  for(const path of ['/private','/%70rivate','/caf%C3%A9','/%ff'])assert.equal((await call('/api/collect',{...event(),url:origin+path,consent:consent()},true)).data.accepted,false);
  const enabled={...acceptedEvent,eventId:randomUUID(),consent:consent()};
  assert.equal((await call('/api/collect',enabled,true)).data.accepted,true);
  const dimensions=(await pool.query('SELECT dimensions FROM event WHERE project_id=$1 AND id=$2',[projectId,enabled.eventId])).rows[0].dimensions;
  const {browser:enabledBrowser,os:enabledOs,device:enabledDevice,environmentVersion:enabledEnvironmentVersion,...enabledPublicDimensions}=dimensions;
  assert.deepEqual({browser:enabledBrowser,os:enabledOs,device:enabledDevice,environmentVersion:enabledEnvironmentVersion},{browser:'unknown',os:'unknown',device:'unknown',environmentVersion:'server-ua-environment-v1'});
  assert.deepEqual(enabledPublicDimensions,{origin,language:'en-US',referrerHost:'private-referrer.example',campaign:{source:'private-campaign'},screenWidth:1024,screenHeight:768});
  // Owner decision D1: capture on plus the analytics grant stores the raw click IDs in their own columns (never the dimensions JSON above),
  // empty kept and each cut to 255 code points like pinned Umami's VarChar(255).
  assert.deepEqual((await pool.query('SELECT gclid,fbclid,msclkid,ttclid,li_fat_id,twclid FROM event WHERE project_id=$1 AND id=$2',[projectId,enabled.eventId])).rows[0],
    {gclid:'private-gclid',fbclid:'',msclkid:'m'.repeat(255),ttclid:null,li_fat_id:null,twclid:'😀'.repeat(255)});

  // A real PostgreSQL wait reproduces the stale-statement-snapshot consent bug.
  await saveDestinationsDraft(projectId,options.ownerId,'live',{expectedVersion:0,configuration:{destinations:[]}});
  const published=await publishDestinations(projectId,options.ownerId,'live',{expectedVersion:1});
  config=await getPublicDestinations(siteKey,'live',origin);
  const staleConsent=consent(), blocker=await pool.connect();
  let pending:Promise<unknown>|undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[projectId]);
    // Prime an earlier activity snapshot so the polling must refresh it.
    await blocker.query('SELECT count(*) FROM pg_stat_activity');
    pending=collectNative(new Request(origin,{headers:{origin,'user-agent':'Acceptance browser'}}),siteKey,{...event(),consent:staleConsent},'127.0.0.1');
    let waiting=false;
    for(let n=0;n<100;n++) {
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      const blocked=await blocker.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM project WHERE public_key=$1 FOR SHARE'");
      if(blocked.rowCount){waiting=true;break;} await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(waiting,'Collector must wait on the publication gate.');
    // Represents the epoch change while the publisher owns the project gate.
    const replacement=randomUUID();
    await blocker.query('INSERT INTO tracking_revision(id,project_id,environment,number,consent_epoch,configuration,created_by) SELECT $1,project_id,environment,number+1,$2,configuration,created_by FROM tracking_revision WHERE id=$3',[replacement,randomUUID(),published.active!.id]);
    await blocker.query('UPDATE tracking_state SET active_revision=$1,draft_version=draft_version+1 WHERE project_id=$2 AND environment=$3',[replacement,projectId,'live']);
    await blocker.query('COMMIT');
    assert.deepEqual(await pending,{accepted:false,reason:'consent_required'});
  }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await pending?.catch(()=>{});}

  const basicWorkspace=randomUUID(),basicProject=randomUUID(),basicKey=randomUUID();
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)',[basicWorkspace,'Basic analytics acceptance']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[basicWorkspace,options.ownerId]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Basic analytics acceptance',$3,$4)",[basicProject,basicWorkspace,origin,basicKey]);
  let basicConfig=await getPublicDestinations(basicKey,'live',origin);
  assert.equal(basicConfig.schemaVersion,3);assert.equal(basicConfig.nativeTracking.collectionMode,'cookieless');
  // Explicit fixture opt-in proves basic events stay outside the linking subsystem.
  // Campaign capture is on too, so the basic event below proves the consent gate on ad click identifiers (owner decision D1).
  await pool.query("UPDATE project SET analytics_settings=jsonb_set(jsonb_set(analytics_settings,'{linkIdentities}','true'),'{captureCampaigns}','true'),identity_links_started_at=clock_timestamp() WHERE id=$1",[basicProject]);
  basicConfig=await getPublicDestinations(basicKey,'live',origin);
  const basic=()=>({...event(),siteKey:basicKey,collection:{mode:'cookieless' as const,epoch:basicConfig.consentEpoch}});
  const basicEvent={...basic(),name:'signup',properties:{plan:'starter',nil:null,flag:false,nested:{count:0}},dimensions:{language:'en-us',campaign:{source:'basic-campaign'},clickIds:{gclid:'basic-click-sentinel',fbclid:'basic-click-sentinel',twclid:'basic-click-sentinel'}}};
  const basicAccepted=await call('/api/collect',basicEvent,true);assert.equal(basicAccepted.status,202);assert.equal(basicAccepted.data.accepted,true);
  const basicRow=(await pool.query('SELECT to_jsonb(e) AS value FROM event e WHERE project_id=$1 AND id=$2',[basicProject,basicEvent.eventId])).rows[0].value;
  assert.equal(basicRow.collection_basis,'cookieless');assert.equal(basicRow.identity_link_evidence_version,null);
  assert.deepEqual(basicRow.dimensions.campaign,{source:'basic-campaign'},'Basic events keep UTM values under campaign capture.');
  for(const column of clickColumns)assert.equal(basicRow[column],null,'A cookieless basic event never stores an ad click identifier, even with campaign capture on.');
  assert.deepEqual(basicRow.properties,{plan:{type:'string',value:'starter'},nil:{type:'null',value:null},flag:{type:'boolean',value:false},'nested.count':{type:'number',value:0}});
  assert.deepEqual((await call('/api/collect',{...basicEvent,consent:{analytics:true,epoch:basicConfig.consentEpoch},collection:undefined,dimensions:{distinctId:'cannot-retrofit'}},true)).data,{accepted:true,duplicate:true});
  assert.deepEqual((await pool.query('SELECT to_jsonb(e) AS value FROM event e WHERE project_id=$1 AND id=$2',[basicProject,basicEvent.eventId])).rows[0].value,basicRow,'Duplicate cannot change basis, identity or event proof.');
  assert.equal((await pool.query('SELECT 1 FROM analytics_identity_link WHERE project_id=$1',[basicProject])).rowCount,0);
  assert.equal((await pool.query('SELECT identity_event_evidence_started_at FROM project WHERE id=$1',[basicProject])).rows[0].identity_event_evidence_started_at,null,'Duplicate consented input cannot mint an evidence-start fence.');
  for(const sentinel of ['private-query','private-fragment','Ten98 acceptance browser','cannot-retrofit','basic-click-sentinel'])assert.equal(JSON.stringify(basicRow).includes(sentinel),false);
  for(const invalid of [{consent:{analytics:true,epoch:basicConfig.consentEpoch}},{dimensions:{distinctId:'private-id'}},{collection:{mode:'consent-first',epoch:basicConfig.consentEpoch}},{collection:{mode:'cookieless',epoch:basicConfig.consentEpoch,extra:true}},{properties:{bad:'x'.repeat(1001)}},{properties:Object.fromEntries(Array.from({length:51},(_,i)=>['key'+i,i]))}])assert.equal((await call('/api/collect',{...basic(),...invalid},true)).status,400);
  for(const authorization of [{collection:undefined},{collection:{mode:'cookieless',epoch:randomUUID()}}])assert.deepEqual((await call('/api/collect',{...basic(),...authorization},true)).data,{accepted:false,reason:'consent_required'});
  for(const headers of [{dnt:'1'},{'sec-gpc':'1'},{'user-agent':'Example crawler'}] as Record<string,string>[])assert.deepEqual((await call('/api/collect',basic(),true,headers)).data,{accepted:false,reason:'collection_disabled'});
  const {collectionMode:_,...legacySettings}=basicConfig.nativeTracking;
  const legacySave=await saveAnalyticsSettings(basicProject,options.ownerId,{revision:1,settings:legacySettings});assert.equal(legacySave.settings.collectionMode,'cookieless','An old settings writer cannot silently change saved mode.');
  basicConfig=await getPublicDestinations(basicKey,'live',origin);
  for(const nextMode of ['consent-first','cookieless'] as const){
    const staleBasic=basic(),gate=await pool.connect();let waitingCall:Promise<unknown>|undefined;
    try{
      await gate.query('BEGIN');await gate.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[basicProject]);await gate.query('SELECT count(*) FROM pg_stat_activity');
      waitingCall=collectNative(new Request(origin,{headers:{origin,'user-agent':'Acceptance browser'}}),basicKey,staleBasic,'127.0.0.1');
      let waiting=false;for(let n=0;n<100;n++){await gate.query('SELECT pg_stat_clear_snapshot()');if((await gate.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM project WHERE public_key=$1 FOR SHARE'")).rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}assert.ok(waiting,'Basic collection must wait for the same publication gate.');
      await gate.query("UPDATE project SET analytics_settings=jsonb_set(analytics_settings,'{collectionMode}',$2::jsonb),analytics_epoch=$3,analytics_revision=analytics_revision+1 WHERE id=$1",[basicProject,JSON.stringify(nextMode),randomUUID()]);await gate.query('COMMIT');
      assert.deepEqual(await waitingCall,{accepted:false,reason:'consent_required'},'Neither direction may accept an envelope from the old publication.');
    }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();await waitingCall?.catch(()=>{});}
    basicConfig=await getPublicDestinations(basicKey,'live',origin);
    assert.equal((await call('/api/collect',basic(),true)).data.accepted,nextMode==='cookieless');
  }
  await saveAnalyticsSettings(basicProject,options.ownerId,{revision:(await pool.query('SELECT analytics_revision FROM project WHERE id=$1',[basicProject])).rows[0].analytics_revision,settings:{...basicConfig.nativeTracking,excludedPaths:['/hello']}});
  basicConfig=await getPublicDestinations(basicKey,'live',origin);assert.deepEqual((await call('/api/collect',basic(),true)).data,{accepted:false,reason:'collection_disabled'});
  for(const table of ['analytics_identify_receipt','analytics_session_property','analytics_identity_link'])assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE project_id=$1`,[basicProject])).rowCount,0,'Basic events cannot write customer profiles or link evidence.');
  console.log('PASS basic event properties, strict envelopes, legacy saves, separate proof and both real publication-lock mode transitions');

  // Legacy observations retain their counts; only measured pageviews enter visit estimates.
  const knownVisitor='a'.repeat(64), anotherVisitor='b'.repeat(64), visitOne='1'.repeat(64), visitTwo='2'.repeat(64), visitThree='3'.repeat(64);
  await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,$4,$4),($1,$3,$4,$4)',[projectId,knownVisitor,anotherVisitor,'2024-02-29T10:00:00Z']);
  const samples=[['page_view',knownVisitor,visitOne,'10:00:00'],['page_view',knownVisitor,visitOne,'10:00:30'],['page_view',knownVisitor,visitTwo,'11:00:00'],
    ['signup',knownVisitor,visitTwo,'11:00:10'],['page_view',anotherVisitor,visitThree,'12:00:00'],['page_view',null,null,'13:00:00']];
  for(const [name,visitor,visit,time] of samples)await pool.query('INSERT INTO event(id,project_id,event_name,path,visitor_id,visit_id,received_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),projectId,name,'/metrics',visitor,visit,`2024-02-29T${time}Z`]);
  assert.ok((await pool.query("SELECT identity_link_evidence_version FROM event WHERE project_id=$1 AND path='/metrics'",[projectId])).rows.every(row=>row.identity_link_evidence_version===null),'Legacy-shaped inserts retain NULL evidence.');
  const report=await call(`/api/projects/${projectId}/analytics?from=2024-02-29&to=2024-02-29`);
  assert.equal(report.status,200); assert.deepEqual(report.data.totals,{pageViews:5,customEvents:1});
  assert.equal(report.data.measurement.visitors,2); assert.equal(report.data.measurement.visits,3);
  assert.equal(report.data.measurement.identifiedPageViews,4); assert.equal(report.data.measurement.unidentifiedPageViews,1);
  assert.ok(Math.abs(report.data.measurement.bounceRate-100/3)<1e-8); assert.equal(report.data.measurement.averageVisitSeconds,10);
  const empty=await call(`/api/projects/${projectId}/analytics?from=2024-03-01&to=2024-03-01`);
  assert.equal(empty.data.measurement.visitors,null); assert.equal(empty.data.measurement.bounceRate,null);
  await assert.rejects(pool.query('INSERT INTO event(id,project_id,event_name,path,visitor_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),projectId,'page_view','/',knownVisitor]),{code:'23514'});
  const epoch=(await pool.query('SELECT analytics_epoch FROM project WHERE id=$1',[projectId])).rows[0].analytics_epoch;
  assert.notEqual(trackingConsentEpoch(epoch,null),staleConsent.epoch);
  console.log('PASS native consent, privacy, settings epochs, publication-lock race, duplicate handling and measured visit statistics');
}
