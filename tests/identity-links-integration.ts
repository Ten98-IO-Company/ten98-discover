import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {analyticsIdentity,collectNative,insertApiObservation,saveAnalyticsSettings,trackingConsentEpoch} from '../src/server/native-analytics.ts';
import {collectIdentify} from '../src/server/native-identify.ts';
import {parseIdentifyInput} from '../src/server/identify-input.ts';
import {explicitIdentityReference,recordIdentityLink,latchIdentityLinkRetention,expireIdentityLinks} from '../src/server/identity-links.ts';
import {getRetention,previewRetention,runRetentionBatch,saveRetention} from '../src/server/retention.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
export async function runIdentityLinkChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_IDENTITY_LINK_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_identity_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');
  assert.ok(ci||/^\/ten98_identity_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
  const originalFetch=globalThis.fetch,network=process.env.ANALYTICS_NETWORK_MODE;let external=0;
  globalThis.fetch=async()=>{external++;throw Error('External requests forbidden.');};process.env.ANALYTICS_NETWORK_MODE='direct';
  try{
    const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID(),origin='https://identity.example.test',ua='Identity fixture browser',ip='192.0.2.48';
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Identity fixture\',$2)',[owner,owner+'@identity.test']);
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Identity fixture')",[workspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Identity fixture',$3,$4,'infinity')",[project,workspace,origin,siteKey]);
    const state=async()=>(await pool.query('SELECT * FROM project WHERE id=$1',[project])).rows[0];
    const evidenceStart=async(pid=project)=>(await pool.query(`SELECT to_char(identity_event_evidence_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start FROM project WHERE id=$1`,[pid])).rows[0].start;
    const eventEvidence=async(pid=project)=>(await pool.query(`SELECT id,visitor_id,identity_link_evidence_version,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted FROM event WHERE project_id=$1 ORDER BY received_at,id`,[pid])).rows;
    const request=(headers:Record<string,string>={})=>new Request(origin,{headers:{origin,'user-agent':ua,...headers}});
    const consent=async()=>({analytics:true as const,epoch:trackingConsentEpoch((await state()).analytics_epoch,null)});
    const links=async()=>(await pool.query(`SELECT visitor_key,identity_version,key_generation,identity_token,
      to_char(first_accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first,
      to_char(last_accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last FROM analytics_identity_link WHERE project_id=$1 ORDER BY visitor_key`,[project])).rows;
    const event=async(id= randomUUID(),distinctId:string|null='account-A',headers:Record<string,string>={})=>collectNative(request(headers),siteKey,
      {eventId:id,name:'case',url:origin+'/account',dimensions:distinctId===null?{}:{distinctId},consent:await consent()},ip);
    const identify=async(raw:ReturnType<typeof parseIdentifyInput>)=>collectIdentify(request(),raw,ip);
    async function at<T>(instant:string,run:()=>Promise<T>):Promise<T>{
      const connect=pool.connect.bind(pool);pool.connect=(function(callback?:any){if(callback)return connect(callback);return connect().then(client=>{const query=client.query.bind(client),release=client.release.bind(client);
        client.query=(function(...args:any[]){if(typeof args[0]==='string'&&args[0].includes(' AS accepted_at')&&args[0].includes('clock_timestamp()')){
          const values=[...(args[1]??[]),instant];args[0]=args[0].replace('clock_timestamp()',`$${values.length}::timestamptz`);args[1]=values;
        }return (query as any)(...args);}) as typeof client.query;
        client.release=((...args:any[])=>{client.query=query;release(...args);}) as typeof client.release;return client;});}) as typeof pool.connect;
      try{return await run();}finally{pool.connect=connect;}
    }
    async function gated<T>(run:(client:PoolClient)=>Promise<T>){const client=await pool.connect();try{
      await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[workspace]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[project]);
      const result=await run(client);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
    const instant=new Date().toISOString().slice(0,19),early=instant+'.123100Z',accepted=instant+'.123900Z';
    const oldId=randomUUID();await at(early,()=>event(oldId));assert.deepEqual(await links(),[]);assert.equal((await state()).identity_links_started_at,null);
    assert.equal(await evidenceStart(),null);assert.equal((await eventEvidence())[0].identity_link_evidence_version,null);
    const before=await state();await saveAnalyticsSettings(project,owner,{revision:before.analytics_revision,settings:{...before.analytics_settings,linkIdentities:true}});
    const enabled=await state();assert.ok(enabled.identity_links_started_at);assert.notEqual(enabled.analytics_epoch,before.analytics_epoch);
    assert.equal(await evidenceStart(),null,'Enabling settings cannot infer event evidence.');
    const firstId=randomUUID();await at(accepted,()=>event(firstId));let rows=await links();assert.equal(rows.length,1);assert.equal(rows[0].first,accepted);assert.equal(rows[0].last,accepted);
    assert.equal(await evidenceStart(),accepted);assert.deepEqual((await eventEvidence()).map(row=>[row.id,row.identity_link_evidence_version,row.accepted]),[[oldId,null,early],[firstId,1,accepted]]);
    const included=(await pool.query('SELECT e.id FROM event e JOIN analytics_identity_link l ON l.project_id=e.project_id AND l.visitor_key=e.visitor_id WHERE e.project_id=$1 AND e.received_at>=l.first_accepted_at ORDER BY e.id',[project])).rows.map(row=>row.id);
    assert.deepEqual(included,[firstId],'Same-millisecond earlier event stays excluded; first accepted event equality is included.');
    await event(firstId);assert.deepEqual(await links(),rows,'Duplicate event must not refresh the link.');
    assert.equal(await evidenceStart(),accepted);
    const raw=parseIdentifyInput({type:'identify',siteKey,requestId:randomUUID(),sentAt:new Date().toISOString(),url:origin+'/account',properties:{plan:'pro'},dimensions:{distinctId:'account-A'},consent:await consent()});
    assert.equal((await identify(raw)).accepted,true);rows=await links();assert.equal(rows[0].first,accepted);await identify(raw);assert.deepEqual(await links(),rows);
    const count=rows.length;await event(randomUUID(),null);await event(randomUUID(),'denied',{dnt:'1'});assert.equal((await links()).length,count);
    const noId=parseIdentifyInput({...raw,requestId:randomUUID(),dimensions:{},properties:{anonymous:true}});await identify(noId);assert.equal((await links()).length,count);
    const disabled=await state();await saveAnalyticsSettings(project,owner,{revision:disabled.analytics_revision,settings:{...disabled.analytics_settings,linkIdentities:false}});
    await event(randomUUID(),'disabled');assert.deepEqual(await links(),rows);assert.equal((await state()).identity_links_started_at.toISOString(),enabled.identity_links_started_at.toISOString());
    const on=await state();await saveAnalyticsSettings(project,owner,{revision:on.analytics_revision,settings:{...on.analytics_settings,linkIdentities:true}});
    assert.equal(await evidenceStart(),accepted,'Identify, anonymous, denied and off/on operations preserve the original microsecond start.');
    console.log('PASS opt-in/consent epoch, exact prospective fence, event/identify duplicate no-op, anonymous/denied paths and disable preservation');

    const a=rows[0].visitor_key,conflict=await state();const originalToken=rows[0].identity_token;
    await pool.query("UPDATE analytics_identity_link SET identity_token=repeat('0',64) WHERE project_id=$1 AND visitor_key=$2",[project,a]);
    const conflictEvent=randomUUID();await assert.rejects(event(conflictEvent),fail(409));assert.equal((await pool.query('SELECT 1 FROM event WHERE project_id=$1 AND id=$2',[project,conflictEvent])).rowCount,0);
    assert.equal(await evidenceStart(),accepted,'Assignment failure cannot change an established event-evidence start.');
    const conflictIdentify=parseIdentifyInput({...raw,requestId:randomUUID(),properties:{mustRollback:true},consent:await consent()});await assert.rejects(identify(conflictIdentify),fail(409));
    assert.equal((await pool.query('SELECT 1 FROM analytics_identify_receipt WHERE project_id=$1 AND request_id=$2',[project,conflictIdentify.requestId])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM analytics_session_property WHERE project_id=$1 AND property_key='mustRollback'",[project])).rowCount,0);
    await pool.query('UPDATE analytics_identity_link SET identity_token=$3 WHERE project_id=$1 AND visitor_key=$2',[project,a,originalToken]);
    await pool.query('UPDATE analytics_identity_link SET first_accepted_at=$3,last_accepted_at=$3 WHERE project_id=$1 AND visitor_key=$2',[project,a,early]);
    const renewed=instant+'.124100Z';await gated(async client=>{await latchIdentityLinkRetention(client,[project],accepted,accepted);await recordIdentityLink(client,project,a,'account-A',renewed);});
    assert.equal((await links())[0].first,renewed,'Lossless cutoff must renew the hidden submillisecond interval.');assert.ok((await state()).identity_links_evidence_lost_at);
    const policy=await getRetention(workspace,owner);await pool.query("UPDATE analytics_identity_link SET first_accepted_at=clock_timestamp()-interval '10 days',last_accepted_at=clock_timestamp()-interval '10 days' WHERE project_id=$1",[project]);
    const preview=await previewRetention(workspace,owner,{revision:policy.revision,settings:{...policy.settings,rawAnalyticsDays:1}});assert.equal(preview.identityLinkEstimate.links,1);
    await saveRetention(workspace,owner,{previewToken:preview.previewToken});const shrunk=await state(),current=await getRetention(workspace,owner);
    const expand=await previewRetention(workspace,owner,{revision:current.revision,settings:{...current.settings,rawAnalyticsDays:90}});await saveRetention(workspace,owner,{previewToken:expand.previewToken});
    assert.ok((await state()).identity_links_retained_from>=shrunk.identity_links_retained_from);
    const expired=await gated(client=>expireIdentityLinks(client,project,new Date(Date.now()-90*86400000),new Date()));assert.equal(expired.expiredIdentityLinks,1);assert.equal(expired.pending,false);
    assert.deepEqual(await links(),[]);assert.equal(external,0);assert.equal(conflict.identity_links_started_at.toISOString(),enabled.identity_links_started_at.toISOString());
    assert.equal(await evidenceStart(),accepted,'Retention shrink, extension, renewal and cleanup must preserve the capability milestone.');
    console.log('PASS atomic immutable-assignment conflict, lossless expired renewal, independent loss/preview, shrink-expand no resurrection and bounded expiry');

    async function fixture(){
      const wid=randomUUID(),pid=randomUUID(),key=randomUUID(),url='https://'+pid+'.identity.test';
      await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Identity boundary fixture')",[wid]);
      await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[wid,owner]);
      const p=(await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Identity boundary fixture',$3,$4,'infinity') RETURNING *",[pid,wid,url,key])).rows[0];
      await saveAnalyticsSettings(pid,owner,{revision:p.analytics_revision,settings:{...p.analytics_settings,linkIdentities:true}});
      const policy=(await pool.query('SELECT analytics_epoch FROM project WHERE id=$1',[pid])).rows[0];
      const permission={analytics:true as const,epoch:trackingConsentEpoch(policy.analytics_epoch,null)};
      const req=()=>new Request(url,{headers:{origin:url,'user-agent':ua}});
      const observation=(id=randomUUID(),extra:Record<string,unknown>={})=>({eventId:id,name:'boundary',url:url+'/case',dimensions:{distinctId:'same-account'},consent:permission,...extra});
      const send=(input=observation())=>collectNative(req(),key,input,ip);
      const raw=()=>parseIdentifyInput({type:'identify',siteKey:key,requestId:randomUUID(),sentAt:new Date().toISOString(),url,properties:{plan:'new'},dimensions:{distinctId:'same-account'},consent:permission});
      const count=async(table:'event'|'analytics_identity_link'|'analytics_identify_receipt')=>(await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`,[pid])).rows[0].n;
      return {wid,pid,key,url,permission,req,observation,send,raw,count};
    }
    async function lockProject(f:Awaited<ReturnType<typeof fixture>>){
      const client=await pool.connect();await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[f.wid]);
      await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[f.pid]);
      return {client,pid:(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number};
    }
    async function observedWait(blocker:number,minimum=1){
      for(let n=0;n<25;n++){
        const r=await pool.query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM project WHERE public_key=$1 FOR UPDATE'");
        if(r.rowCount!>=minimum&&r.rows.some(row=>(row.blockers as number[]).includes(blocker)))return r.rows.map(row=>row.pid);
        await delay(4);
      }assert.fail('The actual collector project-lock wait and exact blocker were not observed.');
    }
    for(const change of ['epoch','disabled'] as const){
      const f=await fixture(),block=await lockProject(f);let pending:Promise<Awaited<ReturnType<typeof f.send>>>|undefined;
      try{
        pending=f.send();void pending.catch(()=>{});await observedWait(block.pid);
        if(change==='epoch')await block.client.query('UPDATE project SET analytics_epoch=$2 WHERE id=$1',[f.pid,randomUUID()]);
        else await block.client.query("UPDATE project SET analytics_settings=jsonb_set(analytics_settings,'{enabled}','false') WHERE id=$1",[f.pid]);
        await block.client.query('COMMIT');const result=await pending;
        assert.equal(result.accepted,false);assert.equal('reason'in result?result.reason:null,change==='epoch'?'consent_required':'collection_disabled');
        assert.equal(await f.count('event'),0);assert.equal(await f.count('analytics_identity_link'),0);
      }finally{await block.client.query('ROLLBACK').catch(()=>{});block.client.release();await pending?.catch(()=>{});}
      assert.equal(await evidenceStart(f.pid),null,'A denied collector behind the publication gate cannot latch event evidence.');
    }
    const concurrent=await fixture(),block=await lockProject(concurrent),sameEvent=concurrent.observation(),sameIdentify=concurrent.raw();
    let writes:Promise<unknown[]>|undefined;
    try{
      writes=Promise.all([concurrent.send(sameEvent),collectIdentify(concurrent.req(),sameIdentify,ip)]);void writes.catch(()=>{});
      await observedWait(block.pid,2);await block.client.query('COMMIT');await writes;
      await Promise.all([concurrent.send(sameEvent),collectIdentify(concurrent.req(),sameIdentify,ip)]);
      assert.equal(await concurrent.count('event'),1);assert.equal(await concurrent.count('analytics_identify_receipt'),1);assert.equal(await concurrent.count('analytics_identity_link'),1);
    }finally{await block.client.query('ROLLBACK').catch(()=>{});block.client.release();await writes?.catch(()=>{});}
    console.log('PASS observed project-lock wait before consent/disable publication and concurrent event/identify serialization with duplicate no-op');

    const monthly=await fixture(),firstMonth='2026-10-31T23:59:59.999100Z',nextMonth='2026-11-01T00:00:00.000900Z';
    const first=await at(firstMonth,()=>monthly.send());assert.ok('context'in first&&first.context);
    await at(nextMonth,()=>monthly.send(monthly.observation(randomUUID(),{context:'context'in first?first.context:undefined})));
    const monthRows=(await pool.query('SELECT visitor_key,identity_token,key_generation FROM analytics_identity_link WHERE project_id=$1 ORDER BY visitor_key',[monthly.pid])).rows;
    assert.equal(monthRows.length,2);assert.notEqual(monthRows[0].visitor_key,monthRows[1].visitor_key);assert.equal(monthRows[0].identity_token,monthRows[1].identity_token);assert.equal(monthRows[0].key_generation,monthRows[1].key_generation);
    const noIdentity=await fixture();await noIdentity.send(noIdentity.observation(randomUUID(),{dimensions:{}}));
    await collectNative(noIdentity.req(),noIdentity.key,noIdentity.observation(),undefined);
    await collectIdentify(noIdentity.req(),noIdentity.raw(),undefined);
    const apiClient=await pool.connect();try{
      await apiClient.query('BEGIN');await apiClient.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[noIdentity.wid]);
      await insertApiObservation(apiClient,noIdentity.pid,noIdentity.observation());await apiClient.query('COMMIT');
    }finally{await apiClient.query('ROLLBACK').catch(()=>{});apiClient.release();}
    assert.equal(await noIdentity.count('analytics_identity_link'),0);assert.equal(await noIdentity.count('analytics_identify_receipt'),0);
    const unidentified=(await pool.query('SELECT source,visitor_id,dimensions FROM event WHERE project_id=$1',[noIdentity.pid])).rows;
    assert.equal(unidentified.length,3);assert.ok(unidentified.find(row=>row.source==='api'&&row.visitor_id===null));assert.equal(unidentified.filter(row=>row.visitor_id===null).length,2);assert.ok(unidentified.every(row=>!Object.hasOwn(row.dimensions,'distinctId')));
    assert.ok((await eventEvidence(noIdentity.pid)).every(row=>row.identity_link_evidence_version===null));assert.equal(await evidenceStart(noIdentity.pid),null);
    const otherProject=await fixture();await at(nextMonth,()=>otherProject.send());
    const other=(await pool.query('SELECT identity_token,key_generation FROM analytics_identity_link WHERE project_id=$1',[otherProject.pid])).rows[0];
    assert.notEqual(other.identity_token,monthRows[0].identity_token);assert.notEqual(other.key_generation,monthRows[0].key_generation);
    const generation=await fixture(),visitor=analyticsIdentity({projectId:generation.pid,ip,userAgent:ua,distinctId:'same-account'})!.visitor;
    const oldReference=explicitIdentityReference(generation.pid,'same-account','synthetic-previous-generation-secret');
    await pool.query('INSERT INTO analytics_identity_link(project_id,visitor_key,identity_version,key_generation,identity_token,first_accepted_at,last_accepted_at) VALUES($1,$2,1,$3,$4,clock_timestamp(),clock_timestamp())',[generation.pid,visitor,oldReference.keyGeneration,oldReference.identityToken]);
    await assert.rejects(generation.send(),fail(409));assert.equal(await generation.count('event'),0);
    assert.equal(await evidenceStart(generation.pid),null,'A first-event assignment conflict rolls back the event and leaves the milestone unset.');
    const preserved=(await pool.query('SELECT identity_token,key_generation FROM analytics_identity_link WHERE project_id=$1',[generation.pid])).rows[0];
    assert.equal(preserved.identity_token,oldReference.identityToken);assert.equal(preserved.key_generation,oldReference.keyGeneration);
    console.log('PASS long-lived identified context across months, missing ID/IP and API exclusions, project/generation assignment boundaries');

    const offOn=await fixture(),aId=randomUUID(),bId=randomUUID(),cId=randomUUID();
    const aAt=instant+'.125100Z',bAt=instant+'.125200Z',cAt=instant+'.125300Z';
    const currentConsent=async()=>(await pool.query('SELECT analytics_epoch FROM project WHERE id=$1',[offOn.pid])).rows[0].analytics_epoch;
    async function toggle(enabled:boolean){const p=(await pool.query('SELECT analytics_revision,analytics_settings FROM project WHERE id=$1',[offOn.pid])).rows[0];await saveAnalyticsSettings(offOn.pid,owner,{revision:p.analytics_revision,settings:{...p.analytics_settings,linkIdentities:enabled}});}
    const sendCurrent=async(id:ReturnType<typeof randomUUID>)=>offOn.send(offOn.observation(id,{consent:{analytics:true,epoch:trackingConsentEpoch(await currentConsent(),null)}}));
    await at(aAt,()=>sendCurrent(aId));await toggle(false);
    await collectIdentify(offOn.req(),parseIdentifyInput({...offOn.raw(),requestId:randomUUID(),consent:{analytics:true,epoch:trackingConsentEpoch(await currentConsent(),null)}}),ip);
    await at(bAt,()=>sendCurrent(bId));await toggle(true);await at(cAt,()=>sendCurrent(cId));
    const offOnRows=await eventEvidence(offOn.pid);assert.equal(new Set(offOnRows.map(row=>row.visitor_id)).size,1,'Settings epochs do not change the identified key in the same month.');
    assert.deepEqual(offOnRows.map(row=>[row.id,row.identity_link_evidence_version]),[[aId,1],[bId,null],[cId,1]]);assert.equal(await evidenceStart(offOn.pid),aAt);
    const linkBefore=(await pool.query('SELECT to_jsonb(l) AS row FROM analytics_identity_link l WHERE project_id=$1',[offOn.pid])).rows;
    const bReplay=await at(instant+'.125900Z',()=>sendCurrent(bId));assert.equal('duplicate' in bReplay?bReplay.duplicate:null,true);
    assert.deepEqual(await eventEvidence(offOn.pid),offOnRows,'An off-period replay cannot upgrade NULL evidence.');
    assert.deepEqual((await pool.query('SELECT to_jsonb(l) AS row FROM analytics_identity_link l WHERE project_id=$1',[offOn.pid])).rows,linkBefore);assert.equal(await evidenceStart(offOn.pid),aAt);
    const identifyOnly=await fixture();await collectIdentify(identifyOnly.req(),identifyOnly.raw(),ip);assert.equal(await evidenceStart(identifyOnly.pid),null);assert.equal(await identifyOnly.count('event'),0);assert.equal(await identifyOnly.count('analytics_identity_link'),1);
    const legacyId=randomUUID();await pool.query("INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,'legacy','/')",[legacyId,identifyOnly.pid]);
    assert.equal((await eventEvidence(identifyOnly.pid))[0].identity_link_evidence_version,null);await identifyOnly.send(identifyOnly.observation(legacyId));assert.equal(await evidenceStart(identifyOnly.pid),null,'A legacy duplicate cannot start event evidence.');
    const deniedOnly=await fixture();assert.equal((await collectNative(new Request(deniedOnly.url,{headers:{origin:deniedOnly.url,'user-agent':ua,dnt:'1'}}),deniedOnly.key,deniedOnly.observation(),ip)).accepted,false);
    assert.equal(await evidenceStart(deniedOnly.pid),null);
    const oldSecret=process.env.AUTH_SECRET;try{process.env.AUTH_SECRET='synthetic-next-generation-secret'.repeat(3);await offOn.send(offOn.observation(randomUUID(),{consent:{analytics:true,epoch:trackingConsentEpoch(await currentConsent(),null)}}));}finally{process.env.AUTH_SECRET=oldSecret;}
    assert.equal(await evidenceStart(offOn.pid),aAt,'Secret rotation cannot reset the first event-evidence timestamp.');
    for(const [version,source,visitor,visit] of [[0,'browser',null,null],[2,'browser',null,null],[1,'browser',null,null],[1,'api',offOnRows[0].visitor_id,'a'.repeat(64)]] as const)
      await assert.rejects(pool.query('INSERT INTO event(id,project_id,event_name,path,source,visitor_id,visit_id,identity_link_evidence_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),offOn.pid,'invalid','/',source,visitor,visit,version]),{code:'23514'});
    for(const table of ['event','analytics_identity_link','analytics_identify_receipt','analytics_session_property']){const stored=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows;for(const rawId of ['account-A','same-account','disabled'])assert.equal(JSON.stringify(stored).includes(rawId),false,'Explicit IDs must not enter persistent evidence.');}
    console.log('PASS per-event prospective proof, same-key off/on and NULL replay, identify-only/legacy exclusions, constraints and rotation-stable microsecond milestone');

    const batch=await fixture(),ref=explicitIdentityReference(batch.pid,'expired-fixture');
    await pool.query("INSERT INTO analytics_identity_link(project_id,visitor_key,identity_version,key_generation,identity_token,first_accepted_at,last_accepted_at) SELECT $1,repeat(md5($1||n::text),2),1,$2,$3,statement_timestamp()-interval '100 days',statement_timestamp()-interval '100 days' FROM generate_series(1,1001)n",[batch.pid,ref.keyGeneration,ref.identityToken]);
    const pass1=await runRetentionBatch(batch.pid);assert.ok(pass1);assert.equal(pass1.expiredIdentityLinks,1000);assert.equal(pass1.complete,false);assert.equal(await batch.count('analytics_identity_link'),1);
    assert.equal((await pool.query('SELECT retention_last_completed_at FROM project WHERE id=$1',[batch.pid])).rows[0].retention_last_completed_at,null);
    const pass2=await runRetentionBatch(batch.pid);assert.ok(pass2);assert.equal(pass2.expiredIdentityLinks,1);assert.equal(pass2.complete,true);assert.equal(await batch.count('analytics_identity_link'),0);
    const marker=(await pool.query('SELECT identity_links_retained_from,identity_links_evidence_lost_at,retention_last_completed_at FROM project WHERE id=$1',[batch.pid])).rows[0];assert.ok(marker.identity_links_retained_from&&marker.identity_links_evidence_lost_at&&marker.retention_last_completed_at);
    assert.equal(external,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()")).rows[0].n,0);
    console.log('PASS real retention worker 1001-edge continuation: 1000/incomplete then1/complete, sticky evidence loss and no idle transaction');
  }finally{globalThis.fetch=originalFetch;if(network===undefined)delete process.env.ANALYTICS_NETWORK_MODE;else process.env.ANALYTICS_NETWORK_MODE=network;}
}
if(import.meta.main){try{await runIdentityLinkChecks();}finally{await closeDatabase();}}
