import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {parseIdentifyInput} from '../src/server/identify-input.ts';
import {collectIdentify,IdentifyRequestExpired} from '../src/server/native-identify.ts';
import {analyticsIdentity,analyticsSettings,collectNative,saveAnalyticsSettings,trackingConsentEpoch} from '../src/server/native-analytics.ts';
import {getRetention,previewRetention,runRetentionBatch,saveRetention} from '../src/server/retention.ts';
import {expireSessionProperties} from '../src/server/session-property-retention.ts';
import {handleApi} from '../src/server/api.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
const day=86_400_000,ua='Identify fixture browser',ip='192.0.2.48';
export async function runNativeIdentifyChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_IDENTIFY_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_identify_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_identify_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
  const owner=randomUUID(),originalFetch=globalThis.fetch,network=process.env.ANALYTICS_NETWORK_MODE;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw new Error('External requests forbidden in identify acceptance.');};process.env.ANALYTICS_NETWORK_MODE='direct';
  try{
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Identify fixture\',$2)',[owner,owner+'@identify.test']);
    async function fixture(){
      const workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID(),origin='https://'+project+'.identify.test';
      await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Identify fixture\')',[workspace]);
      await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
      const p=(await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Identify fixture',$3,$4,'infinity') RETURNING analytics_epoch",[project,workspace,origin,siteKey])).rows[0];
      const consent={analytics:true as const,epoch:trackingConsentEpoch(p.analytics_epoch,null)};
      const raw=(properties:object={},extra:Record<string,unknown>={})=>({type:'identify',siteKey,requestId:randomUUID(),sentAt:new Date().toISOString(),url:origin+'/account?private-query#private-fragment',properties,consent,...extra});
      const request=(headers:Record<string,string>={})=>new Request(origin,{headers:{origin,'user-agent':ua,...headers}});
      const send=(input:unknown,headers:Record<string,string>={},peer:string|undefined=ip)=>collectIdentify(request(headers),parseIdentifyInput(input),peer);
      const rows=async()=>(await pool.query('SELECT visitor_key,property_key,property,updated_at FROM analytics_session_property WHERE project_id=$1 ORDER BY visitor_key,property_key',[project])).rows;
      const markers=async()=>(await pool.query('SELECT session_properties_retained_from,session_properties_evidence_lost_at FROM project WHERE id=$1',[project])).rows[0];
      return {workspace,project,siteKey,origin,consent,raw,request,send,rows,markers};
    }
    // A test-only clock seam substitutes just the already-authorized database admission time.
    // Every gate, mutation, receipt and retention query still executes against PostgreSQL.
    async function at<T>(now:Date,fn:()=>Promise<T>):Promise<T>{
      const connect=pool.connect.bind(pool);pool.connect=(async()=>{const client=await connect(),query=client.query.bind(client),release=client.release.bind(client);
        client.query=(async(...args:any[])=>{const result=await (query as any)(...args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT c.instant AS now,w.raw_analytics_days')){result.rows[0].now=now;result.rows[0].accepted_at=now.toISOString().replace('Z','000Z');}return result;}) as typeof client.query;
        client.release=((...args:any[])=>{client.query=query;release(...args);}) as typeof client.release;return client;}) as typeof pool.connect;
      try{return await fn();}finally{pool.connect=connect;}
    }
    const f=await fixture(),initial=f.raw({plan:'starter',nil:null,blank:'',flag:false,amount:0,list:[1,'1',null],nested:{id:'ordinary explicit data'},when:'2024-03-10T00:00:00.123456789Z'},{dimensions:{distinctId:'private-distinct'}});
    const first=await f.send(initial);assert.ok(first.accepted&&!first.duplicate&&first.context);
    const original=await f.rows();assert.equal(original.length,8);assert.deepEqual(original.find(r=>r.property_key==='nil')?.property,{type:'null',value:null});assert.deepEqual(original.find(r=>r.property_key==='when')?.property,{type:'date',value:'2024-03-10T00:00:00.123456789Z'});
    await delay(5);await f.send(f.raw({plan:'later'},{dimensions:{distinctId:'private-distinct'},sentAt:new Date(Date.now()-60_000).toISOString()}));
    const after=await f.rows();assert.equal(after.find(r=>r.property_key==='plan')?.property.value,'later');assert.deepEqual(after.find(r=>r.property_key==='nil'),original.find(r=>r.property_key==='nil'),'Omitted keys retain their own timestamps.');
    const beforeReplay={rows:after,markers:await f.markers(),receipts:(await pool.query('SELECT * FROM analytics_identify_receipt WHERE project_id=$1 ORDER BY request_id',[f.project])).rows};
    assert.deepEqual(await f.send(initial),{accepted:true,duplicate:true});
    assert.deepEqual({rows:await f.rows(),markers:await f.markers(),receipts:(await pool.query('SELECT * FROM analytics_identify_receipt WHERE project_id=$1 ORDER BY request_id',[f.project])).rows},beforeReplay);
    const offset=initial.sentAt.replace('Z','+00:00');assert.deepEqual(await f.send({...initial,sentAt:offset}),{accepted:true,duplicate:true});
    for(const changed of [{properties:{plan:'changed'}},{dimensions:{distinctId:'other'}},{sentAt:new Date(Date.parse(initial.sentAt)+1).toISOString()}])await assert.rejects(f.send({...initial,...changed}),fail(409));
    for(const table of ['event','analytics_visitor'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`,[f.project])).rows[0].n,0);
    const receiptText=JSON.stringify(beforeReplay.receipts);for(const transient of ['private-distinct',ip,ua,'private-query','private-fragment','starter','ordinary explicit data'])assert.equal(receiptText.includes(transient),false);
    const same=f.raw({parallel:1},{dimensions:{distinctId:'private-distinct'}}),duplicates=await Promise.all(Array.from({length:4},()=>f.send(same)));
    assert.equal(duplicates.filter(v=>v.accepted&&!v.duplicate).length,1);assert.equal(duplicates.filter(v=>v.accepted&&v.duplicate).length,3);
    console.log('PASS independent typed patches, omission timestamps, normalized replay, conflicts, concurrent exactly-once receipt, no traffic or raw identity storage');

    const capped=await fixture();await capped.send(capped.raw(Object.fromEntries(Array.from({length:49},(_,i)=>['key'+i,i]))));
    const race=await Promise.allSettled([capped.send(capped.raw({fiftieth:1})),capped.send(capped.raw({alsoFiftieth:2}))]);
    assert.equal(race.filter(v=>v.status==='fulfilled').length,1);assert.equal(race.filter(v=>v.status==='rejected'&&fail(400)(v.reason)).length,1);assert.equal((await capped.rows()).length,50);
    const capBefore={rows:await capped.rows(),markers:await capped.markers()};await assert.rejects(capped.send(capped.raw({oneTooMany:true})),fail(400));assert.deepEqual({rows:await capped.rows(),markers:await capped.markers()},capBefore);
    await capped.send(capped.raw({key0:null}));assert.equal((await capped.rows()).find(r=>r.property_key==='key0')?.property.type,'null');
    const ordered=await fixture();await Promise.all([ordered.send(ordered.raw({a:1})),ordered.send(ordered.raw({b:2}))]);assert.deepEqual((await ordered.rows()).map(r=>r.property_key),['a','b']);
    console.log('PASS serialized accumulated50-key cap, concurrent disjoint patches and rollback of rejected caps');

    const clocked=await fixture(),now=new Date('2040-05-15T12:00:00.000Z');
    await at(now,()=>clocked.send(clocked.raw({futureEdge:true},{sentAt:new Date(now.getTime()+300_000).toISOString()})));
    await assert.rejects(at(now,()=>clocked.send(clocked.raw({bad:true},{sentAt:new Date(now.getTime()+300_001).toISOString()}))),fail(400));
    const almostExpired=clocked.raw({pastEdge:true},{sentAt:new Date(now.getTime()-day+1).toISOString()});await at(now,()=>clocked.send(almostExpired));
    await assert.rejects(at(new Date(now.getTime()+1),()=>clocked.send(almostExpired)),IdentifyRequestExpired);
    const expired=clocked.raw({expired:true},{sentAt:new Date(now.getTime()-day).toISOString()});await assert.rejects(at(now,()=>clocked.send(expired)),IdentifyRequestExpired);
    const jan=new Date('2041-01-31T23:59:00Z'),feb=new Date('2041-02-01T00:01:00Z'),rotated=clocked.raw({month:'January'},{sentAt:jan.toISOString()});
    await at(jan,()=>clocked.send(rotated));await assert.rejects(at(feb,()=>clocked.send(rotated)),fail(409));await at(feb,()=>clocked.send(clocked.raw({month:'February'},{sentAt:feb.toISOString()})));
    const months=(await clocked.rows()).filter(r=>r.property_key==='month');assert.equal(months.length,2);assert.notEqual(months[0].visitor_key,months[1].visitor_key);
    const hourly=await fixture(),time=new Date('2042-06-01T10:00:00Z'),later=new Date('2042-06-01T11:00:00Z');
    const oldIdentity=analyticsIdentity({projectId:hourly.project,ip,userAgent:ua,now:time})!,newIdentity=analyticsIdentity({projectId:hourly.project,ip,userAgent:ua,now:later})!;assert.equal(oldIdentity.visitor,newIdentity.visitor);assert.notEqual(oldIdentity.visit,newIdentity.visit);
    await at(time,()=>hourly.send(hourly.raw({same:'first'},{sentAt:time.toISOString()})));await at(later,()=>hourly.send(hourly.raw({same:'second'},{sentAt:later.toISOString()})));assert.equal((await hourly.rows()).length,1);
    console.log('PASS exact24h/5min boundaries after gates, immutable replay expiry, monthly separation and same profile across hourly visit keys');

    const denied=await fixture();const stale=denied.raw({secret:1},{sentAt:'2000-01-01T00:00:00Z',consent:{analytics:true,epoch:randomUUID()}});
    assert.deepEqual(await denied.send(stale),{accepted:false,reason:'consent_required'});
    for(const headers of [{dnt:'1'},{'sec-gpc':'1'},{'user-agent':'example crawler'}] as Record<string,string>[])assert.deepEqual(await denied.send(denied.raw({}),headers),{accepted:false,reason:'collection_disabled'});
    assert.deepEqual(await collectIdentify(denied.request(),parseIdentifyInput(denied.raw({}))),{accepted:false,reason:'identity_unavailable'});
    await assert.rejects(denied.send(denied.raw({}),{origin:'https://foreign.example'}),fail(403));
    await pool.query("UPDATE project SET analytics_settings=jsonb_set(analytics_settings,'{excludedPaths}','[\"/account\"]') WHERE id=$1",[denied.project]);assert.deepEqual(await denied.send(denied.raw({})),{accepted:false,reason:'collection_disabled'});assert.equal((await denied.rows()).length,0);
    const gated=await fixture(),blocker=await pool.connect();let held:Promise<unknown>|undefined;
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[gated.project]);held=gated.send(gated.raw({never:1}));let waiting=false;
      for(let n=0;n<100;n++){await blocker.query('SELECT pg_stat_clear_snapshot()');if((await blocker.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM project WHERE public_key=$1 FOR UPDATE'")).rowCount){waiting=true;break;}await delay(20);}assert.ok(waiting);
      await blocker.query('UPDATE project SET analytics_epoch=$2 WHERE id=$1',[gated.project,randomUUID()]);await blocker.query('COMMIT');assert.deepEqual(await held,{accepted:false,reason:'consent_required'});assert.equal((await gated.rows()).length,0);
    }finally{await blocker.query('ROLLBACK');blocker.release();await held?.catch(()=>{});}
    console.log('PASS current origin/policy/consent before age or replay and real publication-lock wait revalidation');

    const basicProfile=await fixture();
    const basicEvent={eventId:randomUUID(),name:'page_view',url:basicProfile.origin+'/account',collection:{mode:'cookieless' as const,epoch:basicProfile.consent.epoch}};
    const basicResult=await collectNative(basicProfile.request(),basicProfile.siteKey,basicEvent,ip);assert.ok(basicResult.accepted&&'duplicate' in basicResult&&!basicResult.duplicate&&basicResult.context);
    const basicRow=(await pool.query('SELECT visitor_id,collection_basis,identity_link_evidence_version FROM event WHERE project_id=$1',[basicProfile.project])).rows[0];assert.equal(basicRow.collection_basis,'cookieless');assert.equal(basicRow.identity_link_evidence_version,null);
    const {consent:omittedConsent,...unconsented}=basicProfile.raw({forbidden:true});assert.ok(omittedConsent);
    await assert.rejects(async()=>basicProfile.send({...unconsented,collection:basicEvent.collection}),fail(400));
    assert.deepEqual(await basicProfile.send({...unconsented,context:basicResult.context}),{accepted:false,reason:'consent_required'});
    assert.equal((await basicProfile.rows()).length,0);assert.equal((await pool.query('SELECT 1 FROM analytics_identify_receipt WHERE project_id=$1',[basicProfile.project])).rowCount,0);
    const grant=await basicProfile.send(basicProfile.raw({plan:'consented-only'},{context:basicResult.context}));assert.ok(grant.accepted&&!grant.duplicate);
    const profile=await basicProfile.rows();assert.equal(profile.length,1);assert.notEqual(profile[0].visitor_key,basicRow.visitor_id,'Basic context cannot select the later consented profile key.');
    assert.equal((await pool.query('SELECT 1 FROM event e JOIN analytics_session_property s ON s.project_id=e.project_id AND s.visitor_key=e.visitor_id WHERE e.project_id=$1',[basicProfile.project])).rowCount,0,'No retroactive profile attachment to basic activity.');
    assert.equal((await pool.query('SELECT 1 FROM analytics_identity_link WHERE project_id=$1',[basicProfile.project])).rowCount,0);
    console.log('PASS basic events cannot identify or claim link proof; later consented profile cannot attach to a basic key');

    // #371: identify mid-visit keeps the visit's anonymous key for the events after it, so funnels and revenue see one visitor.
    const visit=await fixture(),visitSettings=await analyticsSettings(visit.project,owner);
    await saveAnalyticsSettings(visit.project,owner,{revision:visitSettings.revision,settings:{...visitSettings.settings,collectionMode:'consent-first',linkIdentities:true}});
    const visitConsent={analytics:true as const,epoch:trackingConsentEpoch((await pool.query('SELECT analytics_epoch FROM project WHERE id=$1',[visit.project])).rows[0].analytics_epoch,null)};
    const observe=async(name:string,path:string,extra:Record<string,unknown>={})=>{const result=await collectNative(visit.request(),visit.siteKey,{eventId:randomUUID(),name,url:visit.origin+path,consent:visitConsent,...extra},ip);
      assert.ok(result.accepted&&'context' in result&&result.context);return result.context;};
    const landing=await observe('page_view','/pricing/'),checkout=await observe('page_view','/checkout/',{context:landing});
    const identified=await visit.send(visit.raw({plan:'pro'},{consent:visitConsent,context:checkout,dimensions:{distinctId:'buyer-371'}}));assert.ok(identified.accepted&&!identified.duplicate);
    await observe('signup','/checkout/',{context:identified.context,dimensions:{distinctId:'buyer-371'}});
    const visitRows=async()=>(await pool.query('SELECT event_name,path,visitor_id,visit_id,identity_link_evidence_version AS evidence FROM event WHERE project_id=$1 ORDER BY received_at,id',[visit.project])).rows;
    const inVisit=await visitRows();assert.deepEqual(inVisit.map(r=>[r.event_name,r.path]),[['page_view','/pricing/'],['page_view','/checkout/'],['signup','/checkout/']]);
    assert.equal(new Set(inVisit.map(r=>r.visitor_id)).size,1,'Pre-identify views and the identified event share one visitor key.');assert.equal(new Set(inVisit.map(r=>r.visit_id)).size,1);
    assert.deepEqual(inVisit.map(r=>r.evidence),[null,null,null],'The continued anonymous key never becomes link evidence.');
    const visitLinks=(await pool.query('SELECT visitor_key FROM analytics_identity_link WHERE project_id=$1',[visit.project])).rows,visitProfile=await visit.rows();
    assert.equal(visitLinks.length,1);assert.notEqual(visitLinks[0].visitor_key,inVisit[0].visitor_id,'The shared anonymous key is never linked.');
    assert.deepEqual(visitProfile.map(r=>[r.visitor_key,r.property_key]),[[visitLinks[0].visitor_key,'plan']],'Profiles stay on the explicit key.');
    await observe('signup','/account/',{dimensions:{distinctId:'buyer-371'}});
    const explicitRow=(await visitRows()).at(-1)!;assert.equal(explicitRow.visitor_id,visitLinks[0].visitor_key);assert.equal(explicitRow.evidence,1);
    console.log('PASS identify mid-visit continues the anonymous visit key for later events without linking it; explicit key outside it (#371)');

    const retention=await fixture(),rInput=retention.raw({old:1,recent:2});await retention.send(rInput);
    await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '10 days' WHERE project_id=$1 AND property_key='old'",[retention.project]);
    const originalOld=(await retention.rows()).find(r=>r.property_key==='old')!;
    const change=async(fx:typeof retention,days:number)=>{const current=await getRetention(fx.workspace,owner),preview=await previewRetention(fx.workspace,owner,{revision:current.revision,settings:{...current.settings,rawAnalyticsDays:days}});await saveRetention(fx.workspace,owner,{previewToken:preview.previewToken});return preview;};
    const shrink=await change(retention,1);assert.deepEqual(shrink.profileEstimate,{status:'available',properties:1,atLeast:false});assert.equal(shrink.estimate.rows,0);
    const lost=await retention.markers();assert.ok(lost.session_properties_evidence_lost_at);await change(retention,90);const extended=await retention.markers();assert.ok(extended.session_properties_retained_from>=lost.session_properties_retained_from);assert.deepEqual(extended.session_properties_evidence_lost_at,lost.session_properties_evidence_lost_at);assert.equal((await retention.rows()).length,2,'Physical cleanup has not run.');
    assert.ok(originalOld.updated_at<lost.session_properties_retained_from);assert.equal((await pool.query('SELECT analytics_retained_from FROM project WHERE id=$1',[retention.project])).rows[0].analytics_retained_from,null);
    await retention.send(retention.raw({recent:3}));assert.deepEqual((await retention.rows()).find(r=>r.property_key==='old'),originalOld,'Sibling updates do not refresh expired evidence.');
    await retention.send(retention.raw({old:4}));assert.ok((await retention.markers()).session_properties_evidence_lost_at);assert.equal((await retention.rows()).find(r=>r.property_key==='old')?.property.value,4);
    const expiredReceipt=retention.raw({neverAgain:1},{sentAt:new Date(Date.now()-2*day).toISOString()});
    await pool.query("INSERT INTO analytics_identify_receipt(project_id,request_id,visitor_key,operation_hash,sent_at,expires_at,accepted_at) VALUES($1,$2,$3,$3,$4::timestamptz,$4::timestamptz+interval '24 hours',$4)",[retention.project,expiredReceipt.requestId,'e'.repeat(64),expiredReceipt.sentAt]);
    const cleaned=await runRetentionBatch(retention.project);assert.equal(cleaned?.expiredIdentifyReceipts,1);assert.ok((await pool.query('SELECT 1 FROM analytics_identify_receipt WHERE project_id=$1 AND request_id=$2',[retention.project,rInput.requestId])).rowCount);
    await assert.rejects(retention.send(expiredReceipt),IdentifyRequestExpired);
    const oldPolicy=await fixture();await pool.query('UPDATE workspace SET raw_analytics_days=1 WHERE id=$1',[oldPolicy.workspace]);await oldPolicy.send(oldPolicy.raw({past:1}));await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '2 days' WHERE project_id=$1",[oldPolicy.project]);await change(oldPolicy,90);assert.ok((await oldPolicy.markers()).session_properties_evidence_lost_at,'Extension latches the old-policy cutoff before cleanup.');
    console.log('PASS separate preview, irreversible shrink then expand, old-policy extension, sticky loss before overwrite and independent receipt expiry');

    const batches=await fixture();await pool.query('UPDATE workspace SET raw_analytics_days=1 WHERE id=$1',[batches.workspace]);
    await pool.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)
      SELECT $1,md5(i::text)||md5(i::text),'old','{"type":"number","value":1}',clock_timestamp()-interval '2 days' FROM generate_series(1,1001) i`,[batches.project]);
    await pool.query(`INSERT INTO analytics_identify_receipt(project_id,request_id,visitor_key,operation_hash,sent_at,expires_at,accepted_at)
      SELECT $1,gen_random_uuid(),repeat('a',64),repeat('b',64),t,t+interval '24 hours',t FROM generate_series(1,1001) i CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp())-interval '2 days' AS t) age`,[batches.project]);
    const pass1=await runRetentionBatch(batches.project);assert.equal(pass1?.expiredSessionProperties,1000);assert.equal(pass1?.expiredIdentifyReceipts,1000);assert.equal(pass1?.complete,false);
    const pass2=await runRetentionBatch(batches.project);assert.equal(pass2?.expiredSessionProperties,1);assert.equal(pass2?.expiredIdentifyReceipts,1);assert.equal(pass2?.complete,true);assert.ok((await batches.markers()).session_properties_evidence_lost_at);
    const boundary=await fixture(),cutoff=new Date('2026-01-01T00:00:00.000Z');
    await pool.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at) VALUES
      ($1,repeat('a',64),'before','{"type":"null","value":null}',$2::timestamptz-interval '1 microsecond'),
      ($1,repeat('a',64),'equal','{"type":"null","value":null}',$2),
      ($1,repeat('a',64),'after','{"type":"null","value":null}',$2::timestamptz+interval '1 microsecond')`,[boundary.project,cutoff]);
    const exact=await pool.connect();try{await exact.query('BEGIN');await exact.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[boundary.workspace]);await exact.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[boundary.project]);const result=await expireSessionProperties(exact,boundary.project,cutoff,new Date(cutoff.getTime()+day));assert.equal(result.expiredProperties,1);await exact.query('COMMIT');}finally{await exact.query('ROLLBACK');exact.release();}
    assert.deepEqual((await boundary.rows()).map(r=>r.property_key),['after','equal']);assert.ok((await boundary.markers()).session_properties_evidence_lost_at);
    const bounded=await fixture();await pool.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)
      SELECT $1,md5(i::text)||md5(i::text),'old','{"type":"number","value":1}',clock_timestamp()-interval '100 days' FROM generate_series(1,10001) i`,[bounded.project]);
    const boundedSettings=await getRetention(bounded.workspace,owner),previewBody={revision:boundedSettings.revision,settings:boundedSettings.settings};
    assert.deepEqual((await previewRetention(bounded.workspace,owner,previewBody)).profileEstimate,{status:'available',properties:10000,atLeast:true});
    const connectEstimate=pool.connect.bind(pool);pool.connect=(async()=>{const client=await connectEstimate(),query=client.query.bind(client),release=client.release.bind(client);client.query=(async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('SELECT s.property_key FROM project p JOIN analytics_session_property'))await query('SELECT pg_sleep(3)');return (query as any)(...args);}) as typeof client.query;client.release=((...args:any[])=>{client.query=query;release(...args);}) as typeof client.release;return client;}) as typeof pool.connect;
    try{assert.deepEqual((await previewRetention(bounded.workspace,owner,previewBody)).profileEstimate,{status:'unavailable',properties:null,atLeast:false});}finally{pool.connect=connectEstimate;}
    console.log('PASS strict per-key expiry at PostgreSQL microsecond boundary, bounded10000 estimate and actual query-timeout unavailable estimate');
    const rollback=await fixture();await rollback.send(rollback.raw({keep:1}));await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '100 days' WHERE project_id=$1",[rollback.project]);
    const beforeFailure={rows:await rollback.rows(),markers:await rollback.markers()};
    await pool.query(`CREATE FUNCTION identify_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic identify receipt failure'; END $$`);
    await pool.query('CREATE TRIGGER identify_fixture_fail BEFORE INSERT ON analytics_identify_receipt FOR EACH ROW EXECUTE FUNCTION identify_fixture_fail()');
    try{await assert.rejects(rollback.send(rollback.raw({keep:2})));assert.deepEqual({rows:await rollback.rows(),markers:await rollback.markers()},beforeFailure);}finally{await pool.query('DROP TRIGGER identify_fixture_fail ON analytics_identify_receipt');}
    await pool.query('CREATE TRIGGER identify_fixture_fail BEFORE DELETE ON analytics_session_property FOR EACH ROW EXECUTE FUNCTION identify_fixture_fail()');
    try{await assert.rejects(runRetentionBatch(rollback.project));assert.deepEqual({rows:await rollback.rows(),markers:await rollback.markers()},beforeFailure);}finally{await pool.query('DROP TRIGGER identify_fixture_fail ON analytics_session_property');await pool.query('DROP FUNCTION identify_fixture_fail()');}
    await runRetentionBatch(rollback.project);assert.equal((await rollback.rows()).length,0);assert.ok((await rollback.markers()).session_properties_evidence_lost_at);
    console.log('PASS bounded1000-row property/receipt batches, completion accounting and transactional receipt/cleanup rollback');

    const timeout=await fixture(),lock=await pool.connect();try{await lock.query('BEGIN');await lock.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[timeout.project]);const started=Date.now();await assert.rejects(timeout.send(timeout.raw({blocked:1})),fail(503));assert.ok(Date.now()-started>=4500);assert.equal((await timeout.rows()).length,0);}finally{await lock.query('ROLLBACK');lock.release();}
    assert.ok((await timeout.send(timeout.raw({recovered:true}))).accepted);
    const http=await fixture();
    async function post(body:unknown,raw?:string){const request=new Request(config.appUrl+'/api/collect',{method:'POST',headers:{origin:http.origin,'content-type':'application/json','user-agent':ua},body:raw??JSON.stringify(body)});const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:ip});Object.defineProperty(request,'runtime',{value:{name:'node',node:{req:{socket}}}});return handleApi(request);}
    const body=http.raw({ok:true}),response=await post(body);assert.equal(response.status,202);assert.equal(response.headers.get('access-control-allow-origin'),http.origin);assert.equal((await response.json()).duplicate,false);assert.deepEqual(await (await post(body)).json(),{accepted:true,duplicate:true});
    const tooOld=await post(http.raw({},{sentAt:new Date(Date.now()-day-1000).toISOString()}));assert.equal(tooOld.status,400);assert.equal((await tooOld.json()).reason,'request_expired');
    const future=await post(http.raw({},{sentAt:new Date(Date.now()+360_000).toISOString()}));assert.equal(future.status,400);assert.equal((await future.json()).reason,undefined);
    assert.equal((await post(http.raw({id:'reserved'}))).status,400);assert.equal((await post({...body,eventId:randomUUID()})).status,400);assert.equal((await post({...body,properties:{ok:false}})).status,409);
    const json=JSON.stringify(http.raw({}));assert.equal((await post(null,json+' '.repeat(16384-Buffer.byteLength(json)))).status,202);assert.equal((await post(null,json+' '.repeat(16385-Buffer.byteLength(json)))).status,413);
    assert.equal(outgoing,0);console.log('PASS actual5s cancellation/recovery and collector DTO, CORS, expiry reason, conflict, strict variant and16KiB boundary');
  }finally{globalThis.fetch=originalFetch;if(network===undefined)delete process.env.ANALYTICS_NETWORK_MODE;else process.env.ANALYTICS_NETWORK_MODE=network;}
}
if(process.env.TEN98_IDENTIFY_TEST==='1')try{await runNativeIdentifyChecks();}finally{await closeDatabase();}
