import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {parseSegmentDefinition} from '../src/server/segment-input.ts';
import {listSegments,getSegment,saveSegment,deleteSegment} from '../src/server/segments.ts';

const definition=(query='',name='Saved filter')=>({schemaVersion:1 as const,name,query});
const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
export async function runSegmentChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SEGMENTS_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_segments_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_segments_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned fixture.');
  const owner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),foreign=randomUUID(),sibling=randomUUID();
  const password=randomBytes(24).toString('base64url'),hashed=await hashPassword(password),savedFetch=globalThis.fetch;
  let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('External traffic forbidden in saved-filter acceptance.');};
  try{
    for(const uid of [owner,admin,editor,viewer,stranger]){
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Segment fixture\',$2)',[uid,uid+'@segments.test']);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);
    }
    for(const wid of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Segment fixture')",[wid]);
    for(const [uid,role] of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,stranger]);
    for(const [pid,wid] of [[project,workspace],[sibling,workspace],[foreign,foreignWorkspace]])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Segment fixture',$3,$4,'infinity')",[pid,wid,'https://'+pid+'.example.com',randomUUID()]);
    const save=(raw=definition(),pid=project,uid=owner)=>saveSegment(pid,uid,{requestId:randomUUID(),definition:raw});
    const all=()=>listSegments(project,owner,new URLSearchParams());

    const intent={requestId:randomUUID(),definition:definition('path=%2Fa%25_&campaignSource=','  Exact filter  ')};
    const [first,replayed]=await Promise.all([saveSegment(project,owner,intent),saveSegment(project,owner,intent)]);
    assert.ok(first.item&&replayed.item);assert.equal(first.item.id,replayed.item.id);assert.notEqual(first.replayed,replayed.replayed);assert.equal(first.item.definition.name,'Exact filter');
    assert.equal((await pool.query('SELECT 1 FROM analytics_segment WHERE project_id=$1',[project])).rowCount,1);
    for(const [uid,role] of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']]){const result=await getSegment(project,uid,first.item.id);assert.equal(result.role,role);assert.deepEqual(result.item,first.item);}
    await assert.rejects(save(definition(),project,viewer),fail(404));await assert.rejects(getSegment(project,stranger,first.item.id),fail(404));await assert.rejects(getSegment(foreign,stranger,first.item.id),fail(404));
    await assert.rejects(saveSegment(project,admin,intent),fail(409));await assert.rejects(saveSegment(project,owner,{...intent,definition:definition('path=/other')}),fail(409));
    assert.ok((await save(definition('','Admin'),project,admin)).item);const editorIntent={requestId:randomUUID(),definition:definition('','Editor')};assert.ok((await saveSegment(project,editor,editorIntent)).item);
    console.log('PASS current member reads, owner/admin/editor writes, foreign-scope isolation and actor-bound concurrent create replay');

    const id=first.item.id,updates=[{requestId:randomUUID(),revision:1,definition:definition('path=/one','One')},{requestId:randomUUID(),revision:1,definition:definition('path=/two','Two')}];
    const races=await Promise.allSettled(updates.map(body=>saveSegment(project,owner,body,id)));
    assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.filter(x=>x.status==='rejected'&&fail(409)(x.reason)).length,1);
    const current=(await getSegment(project,owner,id)).item;assert.equal(current.revision,2);const winning=updates.find(x=>x.definition.name===current.definition.name)!;
    const replayUpdate=await saveSegment(project,owner,winning,id);assert.equal(replayUpdate.replayed,true);assert.equal(replayUpdate.item?.revision,2);
    await assert.rejects(deleteSegment(project,owner,id,{requestId:randomUUID(),revision:1}),fail(409));
    const deletion={requestId:randomUUID(),revision:2};assert.equal((await deleteSegment(project,owner,id,deletion)).replayed,false);assert.equal((await deleteSegment(project,owner,id,deletion)).replayed,true);
    assert.deepEqual(await saveSegment(project,owner,intent),{role:'owner',item:null,deleted:true,replayed:true});assert.equal((await saveSegment(project,owner,winning,id)).deleted,true);
    await assert.rejects(deleteSegment(project,admin,id,deletion),fail(409));assert.equal((await pool.query('SELECT 1 FROM analytics_segment WHERE id=$1',[id])).rowCount,0);
    const cap=(await save()).item!;await pool.query('UPDATE analytics_segment SET revision=2147483647 WHERE id=$1',[cap.id]);
    await assert.rejects(saveSegment(project,owner,{requestId:randomUUID(),revision:2147483647,definition:definition()},cap.id),fail(409));await deleteSegment(project,owner,cap.id,{requestId:randomUUID(),revision:2147483647});
    console.log('PASS revision races, exact update/delete replay, deleted receipt cannot recreate, and deletion remains possible at revision cap');

    const rollbackIntent={requestId:randomUUID(),definition:definition('path=/atomic','Atomic')};
    await pool.query(`CREATE FUNCTION segment_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'segment.%' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER segment_receipt_failure BEFORE INSERT ON project_content_request FOR EACH ROW EXECUTE FUNCTION segment_receipt_failure()');
    try{await assert.rejects(saveSegment(project,owner,rollbackIntent));assert.equal((await pool.query("SELECT 1 FROM analytics_segment WHERE name='Atomic'")).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[rollbackIntent.requestId])).rowCount,0);}finally{await pool.query('DROP TRIGGER segment_receipt_failure ON project_content_request');await pool.query('DROP FUNCTION segment_receipt_failure()');}
    assert.equal((await saveSegment(project,owner,rollbackIntent)).replayed,false);
    const gate=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{
      await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
      waiting=save(definition('path=/revoked','Revoked'),project,editor);const observed=waiting.catch(error=>error);const deadline=Date.now()+3000;let blocked=false;
      do{blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT w.id FROM workspace w JOIN project%') AS blocked")).rows[0].blocked;if(!blocked)await delay(10);}while(!blocked&&Date.now()<deadline);
      assert.equal(blocked,true);await gate.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await gate.query('COMMIT');assert.ok(fail(404)(await observed));
      assert.equal((await pool.query("SELECT 1 FROM analytics_segment WHERE name='Revoked'")).rowCount,0);
      await assert.rejects(saveSegment(project,editor,editorIntent),fail(404),'A former writer cannot replay their own accepted receipt.');
    }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();await waiting?.catch(()=>{});await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);}
    console.log('PASS mutation and receipt are atomic; write admission rechecks membership after actual workspace lock wait');

    await pool.query(`INSERT INTO analytics_segment(id,project_id,name,schema_version,query,created_at,updated_at)
      SELECT gen_random_uuid(),$1,'Page '||n,1,'kind=all','2026-01-01T00:00:00.123Z','2026-01-01T00:00:00.123Z' FROM generate_series(1,102) n`,[sibling]);
    const seen=new Set<string>();let cursor:string|null=null;let pages=0;
    do{const p=await listSegments(sibling,viewer,new URLSearchParams(cursor?{cursor}:{}));assert.ok(p.items.length<=50);for(const row of p.items){assert.equal(seen.has(row.id),false);seen.add(row.id);}if(!pages){assert.equal(p.items.length,50);assert.ok(p.nextCursor);await assert.rejects(listSegments(project,owner,new URLSearchParams({cursor:p.nextCursor!})),fail(400));await deleteSegment(sibling,owner,p.items[49].id,{requestId:randomUUID(),revision:1});}cursor=p.nextCursor;pages++;}while(cursor);
    assert.equal(seen.size,102);assert.equal(pages,3,'A deleted page boundary must not skip older rows.');
    for(const q of ['cursor=x','cursor=x&cursor=y','limit=100','from=2026-01-01'])await assert.rejects(listSegments(project,owner,new URLSearchParams(q)),fail(400));
    console.log('PASS bounded50 pagination with tied timestamps, deleted anchors, scoped cursors and rejected extra filters');

    const day=new Date(Date.now()-86400000).toISOString().slice(0,10),date=day+'T12:00:00Z';
    for(const [path,value,campaign] of [['/literal%_ 🐎',0,''],['/literalXX 🐎',null,''],['/literal%_ 🐎',false,'paid'],['/literal%_ 🐎',undefined,'']] as const){
      await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),project,'checkout',path,date,JSON.stringify(value===undefined?{}:normalizeProperties({value})),JSON.stringify({campaign:{source:campaign}})]);
    }
    for(const [filters,expected] of [[{path:'/literal%_ 🐎',campaignSource:''},2],[{propertyKey:'value',propertyType:'number',propertyValue:'0'},1],[{propertyKey:'value',propertyType:'null',propertyValue:'null'},1],[{propertyKey:'value',propertyType:'missing'},1],[{propertyKey:'value',propertyType:'boolean',propertyValue:'false'},1]] as const){
      const explicit=new URLSearchParams(filters),segment=(await save(definition(explicit.toString()))).item!;
      const recalled=(await getSegment(project,viewer,segment.id)).item;
      const applied=new URLSearchParams(recalled.definition.query);for(const p of [explicit,applied]){p.set('from',day);p.set('to',day);p.set('timeZone','UTC');p.set('groupBy','path');}
      const original=await exploreAnalytics(project,viewer,explicit),restored=await exploreAnalytics(project,viewer,applied);
      assert.deepEqual(restored,original);assert.equal(restored.totals.events,expected);assert.equal(restored.csv,original.csv);assert.equal(new URLSearchParams(recalled.definition.query).has('from'),false);
    }
    console.log('PASS saved predicates reproduce actual Explorer results and CSV with exact wildcard text, empty, typed zero/false/null and missing semantics');

    const login=async(uid:string)=>{const response=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@segments.test',password})}));assert.equal(response.status,200);return response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');};
    const cookie=await login(owner),viewerCookie=await login(viewer),endpoint=config.appUrl+'/api/projects/'+project+'/segments';
    const http=async(method:string,path='',body?:unknown,who=cookie,origin=config.appUrl)=>handleApi(new Request(endpoint+path,{method,headers:{cookie:who,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const request={requestId:randomUUID(),definition:definition('path=/http','HTTP')};const created=await http('POST','',request);assert.equal(created.status,200);assert.equal(created.headers.get('cache-control'),'no-store');const createdBody=await created.json();assert.equal(createdBody.item.projectId,project);
    assert.equal((await http('GET','/'+createdBody.item.id,undefined,viewerCookie)).status,200);assert.equal((await http('POST','',request,viewerCookie)).status,404);assert.equal((await http('POST','',request,cookie,'https://foreign.example')).status,403);
    assert.equal((await http('GET','',undefined,'')).status,401);assert.equal((await http('DELETE','/'+createdBody.item.id)).status,405);assert.equal((await http('GET','/'+createdBody.item.id+'?cursor=x')).status,400);assert.equal((await http('POST','?x=1',request)).status,400);
    assert.equal((await http('POST','',{...request,padding:'x'.repeat(33000)})).status,413);
    const token=await createApiKey(workspace,owner,{name:'Segment fixture',scopes:['analytics:read']});
    assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token.token}}))).status,403);
    const scoped=await createApiKey(workspace,owner,{name:'Segment reader',scopes:['segments:read']}),bearerList=await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+scoped.token}}));assert.equal(bearerList.status,200);assert.deepEqual(await bearerList.json(),await(await http('GET','')).json());
    assert.equal((await handleApi(new Request(endpoint+'/'+createdBody.item.id,{headers:{authorization:'Bearer '+scoped.token}}))).status,200);assert.equal((await handleApi(new Request(endpoint,{method:'POST',headers:{authorization:'Bearer '+scoped.token,'content-type':'application/json'},body:JSON.stringify(request)}))).status,403,'segments:read admits no write');
    const longDefinition=definition(new URLSearchParams({path:'中'.repeat(1000)}).toString(),'Large valid filter');assert.ok(JSON.stringify(longDefinition).length>8192);assert.equal((await http('POST','',{requestId:randomUUID(),definition:longDefinition})).status,200);
    const updateHttp=await http('POST','/'+createdBody.item.id+'/update',{requestId:randomUUID(),revision:1,definition:definition('path=/changed','HTTP changed')});assert.equal(updateHttp.status,200);assert.equal((await updateHttp.json()).item.revision,2);
    const deleteHttp={requestId:randomUUID(),revision:2};assert.equal((await http('POST','/'+createdBody.item.id+'/delete',deleteHttp)).status,200);const replayHttp=await http('POST','',request);assert.deepEqual(await replayHttp.json(),{role:'owner',item:null,deleted:true,replayed:true});
    console.log('PASS actual session/Origin/API-key/body-cap/method/query and CRUD routes; valid definitions larger than8KiB remain usable');

    let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),reading=new Promise<void>(r=>entered=r);
    const delayedBody={requestId:randomUUID(),definition:definition('path=/held','Held')};
    const held=new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:new ReadableStream({async start(controller){entered();await hold;controller.enqueue(new TextEncoder().encode(JSON.stringify(delayedBody)));controller.close();}}),duplex:'half'} as RequestInit);
    const response=handleApi(held);await reading;await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);release();assert.equal((await response).status,404);
    await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
    const rateDeadline=(await pool.query("SELECT to_timestamp((floor(extract(epoch FROM clock_timestamp())/60)+2)*60) AS at")).rows[0].at;
    await pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,30 FROM generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=30",['segments:'+owner+':write']);
    assert.equal((await http('POST','',{requestId:randomUUID(),definition:definition('','Rate limited')})).status,429);
    assert.equal((await pool.query('SELECT clock_timestamp()<$1 AS within_bound',[rateDeadline])).rows[0].within_bound,true,'The bounded rate check must complete within its two seeded real buckets.');
    assert.equal((await pool.query("SELECT 1 FROM analytics_segment WHERE name IN ('Held','Rate limited')")).rowCount,0);assert.equal(outbound,0);
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer]);assert.equal((await http('GET','',undefined,viewerCookie)).status,404);
    console.log('PASS held-body current-role revocation, write-rate rejection and subsequent reader revocation; zero provider calls');
    assert.ok((await all()).items.length>0);
  }finally{globalThis.fetch=savedFetch;}
}
if(import.meta.main){try{await runSegmentChecks();}finally{await closeDatabase();}}
