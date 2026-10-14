import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {listAnnotations,annotationTimeline,getAnnotation,saveAnnotation,deleteAnnotation} from '../src/server/annotations.ts';

const definition=(note='Saved note',date='2026-10-14T12:34:56.123Z',allDay=true)=>({date,allDay,note});
const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
export async function runAnnotationChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_ANNOTATIONS_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_annotations_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_annotations_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned fixture.');
  const owner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),foreign=randomUUID(),sibling=randomUUID();
  const password=randomBytes(24).toString('base64url'),hashed=await hashPassword(password),savedFetch=globalThis.fetch;
  let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('External traffic forbidden in annotation acceptance.');};
  try{
    for(const uid of [owner,admin,editor,viewer,stranger]){
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Annotation fixture\',$2)',[uid,uid+'@annotations.test']);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);
    }
    for(const wid of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Annotation fixture')",[wid]);
    for(const [uid,role] of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,stranger]);
    for(const [pid,wid] of [[project,workspace],[sibling,workspace],[foreign,foreignWorkspace]])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Annotation fixture',$3,$4,'infinity')",[pid,wid,'https://'+pid+'.example.com',randomUUID()]);
    const save=(raw=definition(),pid=project,uid=owner)=>saveAnnotation(pid,uid,{requestId:randomUUID(),definition:raw});
    const all=()=>listAnnotations(project,owner,new URLSearchParams());

    assert.deepEqual((await all()).items,[],'All-notes null calendar still returns a valid empty list.');
    const intent={requestId:randomUUID(),definition:definition('  Launch  ')};
    const [first,replayed]=await Promise.all([saveAnnotation(project,owner,intent),saveAnnotation(project,owner,intent)]);
    assert.ok(first.item&&replayed.item);assert.equal(first.item.id,replayed.item.id);assert.notEqual(first.replayed,replayed.replayed);assert.equal(first.item.definition.note,'Launch');
    assert.equal((await pool.query('SELECT user_id FROM analytics_annotation WHERE id=$1',[first.item.id])).rows[0].user_id,owner);
    for(const [uid,role]of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']]){const got=await getAnnotation(project,uid,first.item.id);assert.equal(got.role,role);assert.deepEqual(got.item,first.item);}
    await assert.rejects(save(definition(),project,viewer),fail(404));await assert.rejects(getAnnotation(project,stranger,first.item.id),fail(404));await assert.rejects(getAnnotation(foreign,stranger,first.item.id),fail(404));
    await assert.rejects(saveAnnotation(project,admin,intent),fail(409));await assert.rejects(saveAnnotation(project,owner,{...intent,definition:definition('Other')}),fail(409));
    assert.ok((await save(definition('Admin'),project,admin)).item);const editorIntent={requestId:randomUUID(),definition:definition('Editor')};await saveAnnotation(project,editor,editorIntent);
    console.log('PASS current scoped roles, creator provenance, actor/body-bound concurrent create and all-notes null calendar');

    const id=first.item.id,updates=['One','Two'].map(note=>({requestId:randomUUID(),revision:1,definition:definition(note)}));
    const race=await Promise.allSettled(updates.map(body=>saveAnnotation(project,owner,body,id)));assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&fail(409)(r.reason)).length,1);
    const current=(await getAnnotation(project,owner,id)).item,winning=updates.find(v=>v.definition.note===current.definition.note)!;assert.equal(current.revision,2);assert.equal((await saveAnnotation(project,owner,winning,id)).replayed,true);
    await assert.rejects(deleteAnnotation(project,owner,id,{requestId:randomUUID(),revision:1}),fail(409));const del={requestId:randomUUID(),revision:2};await deleteAnnotation(project,owner,id,del);assert.equal((await deleteAnnotation(project,owner,id,del)).replayed,true);
    assert.deepEqual(await saveAnnotation(project,owner,intent),{role:'owner',item:null,deleted:true,replayed:true});assert.equal((await saveAnnotation(project,owner,winning,id)).deleted,true);await assert.rejects(deleteAnnotation(project,admin,id,del),fail(409));
    const cap=(await save()).item!;await pool.query('UPDATE analytics_annotation SET revision=2147483647 WHERE id=$1',[cap.id]);await assert.rejects(saveAnnotation(project,owner,{requestId:randomUUID(),revision:2147483647,definition:definition()},cap.id),fail(409));await deleteAnnotation(project,owner,cap.id,{requestId:randomUUID(),revision:2147483647});
    console.log('PASS revision race, update/delete replay, deleted-null no resurrection and revision-cap deletion');

    const atomic={requestId:randomUUID(),definition:definition('Atomic')};
    await pool.query(`CREATE FUNCTION annotation_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'annotation.%' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER annotation_receipt_failure BEFORE INSERT ON project_content_request FOR EACH ROW EXECUTE FUNCTION annotation_receipt_failure()');
    try{await assert.rejects(saveAnnotation(project,owner,atomic));assert.equal((await pool.query("SELECT 1 FROM analytics_annotation WHERE note='Atomic'")).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[atomic.requestId])).rowCount,0);}finally{await pool.query('DROP TRIGGER annotation_receipt_failure ON project_content_request');await pool.query('DROP FUNCTION annotation_receipt_failure()');}
    await saveAnnotation(project,owner,atomic);
    const gate=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);waiting=save(definition('Revoked'),project,editor);const observed=waiting.catch(e=>e),deadline=Date.now()+3000;let blocked=false;
      do{blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT w.id FROM workspace w JOIN project%') AS blocked")).rows[0].blocked;if(!blocked)await delay(10);}while(!blocked&&Date.now()<deadline);
      assert.equal(blocked,true);await gate.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await gate.query('COMMIT');assert.ok(fail(404)(await observed));await assert.rejects(saveAnnotation(project,editor,editorIntent),fail(404));assert.equal((await pool.query("SELECT 1 FROM analytics_annotation WHERE note='Revoked'")).rowCount,0);
    }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();await waiting?.catch(()=>{});await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);}
    console.log('PASS atomic note/receipt rollback and current authorization after an observed workspace-lock wait');

    const daySave=async(day:string,timeZone:string)=>saveAnnotation(project,owner,{requestId:randomUUID(),definition:{day,timeZone,allDay:true,note:'Calendar '+day}});
    for(const [day,timeZone,expected]of [
      ['2024-03-10','America/New_York','2024-03-10T05:00:00.000Z'],['2024-11-03','America/New_York','2024-11-03T04:00:00.000Z'],
      ['2018-11-04','America/Sao_Paulo','2018-11-04T03:00:00.000Z'],['2024-11-03','America/Havana','2024-11-03T04:00:00.000Z'],
      ['2099-01-02','Asia/Dubai','2099-01-01T20:00:00.000Z'],['1970-01-01','UTC','1970-01-01T00:00:00.000Z']]){
      const saved=await daySave(day,timeZone);assert.equal(saved.item!.definition.date,expected);assert.equal(saved.item!.definition.allDay,true);
      assert.ok((await listAnnotations(project,viewer,new URLSearchParams({from:day,to:day,timeZone}))).items.some(item=>item.id===saved.item!.id));
    }
    await assert.rejects(daySave('2011-12-30','Pacific/Apia'),fail(400));await assert.rejects(daySave('1970-01-01','Asia/Dubai'),fail(400));
    const timed=(await save(definition('Timed','2026-06-01T23:30:00+00:00',false))).item!;
    const edited=await saveAnnotation(project,owner,{requestId:randomUUID(),revision:1,definition:{...timed.definition,note:'Timed edit'}},timed.id);assert.equal(edited.item!.definition.date,timed.definition.date);assert.equal(edited.item!.definition.allDay,false);
    assert.equal((await listAnnotations(project,viewer,new URLSearchParams({from:'2026-06-02',to:'2026-06-02',timeZone:'Asia/Dubai'}))).items[0].id,timed.id);
    for(const [from,start,end,hours]of [['2024-03-10','2024-03-10T05:00:00Z','2024-03-11T04:00:00Z',23],['2024-11-03','2024-11-03T04:00:00Z','2024-11-04T05:00:00Z',25]] as const){
      assert.equal((Date.parse(end)-Date.parse(start))/3600000,hours);const before=(await save(definition('before',new Date(Date.parse(start)-1).toISOString()))).item!,inside=(await save(definition('inside',new Date(Date.parse(end)-1).toISOString()))).item!,outside=(await save(definition('outside',end))).item!;
      const rows=(await listAnnotations(project,viewer,new URLSearchParams({from,to:from,timeZone:'America/New_York'}))).items;assert.equal(rows.some(r=>r.id===before.id),false);assert.equal(rows.some(r=>r.id===inside.id),true);assert.equal(rows.some(r=>r.id===outside.id),false);
    }
    console.log('PASS future/epoch/offset dates, skipped dates, first real or repeated midnight, exact23/25-hour boundaries and timed edit preservation');

    await pool.query(`INSERT INTO analytics_annotation(id,project_id,date,all_day,note) SELECT gen_random_uuid(),$1,'2026-01-01T12:00:00.123Z',true,CASE WHEN n<=4 THEN 'literal %_ note' ELSE 'Note '||n END FROM generate_series(1,1005)n`,[sibling]);
    const scope=new URLSearchParams({from:'2026-01-01',to:'2026-01-01',timeZone:'UTC'}),timeline=await annotationTimeline(sibling,viewer,scope);assert.equal(timeline.totalCount,1005);assert.equal(timeline.days.length,1);assert.equal(timeline.days[0].count,1005);assert.equal(timeline.days[0].previews.length,3);
    const seen=new Set<string>();let cursor:string|null=null,pages=0,literalCount=4;
    do{const page=await listAnnotations(sibling,viewer,new URLSearchParams(cursor?{cursor}:{}));assert.ok(page.items.length<=50);for(const row of page.items){assert.equal(seen.has(row.id),false);seen.add(row.id);}
      if(!pages){assert.ok(page.nextCursor);assert.deepEqual(timeline.days[0].previews,page.items.slice(0,3));await assert.rejects(listAnnotations(project,owner,new URLSearchParams({cursor:page.nextCursor})),fail(400));await assert.rejects(listAnnotations(sibling,owner,new URLSearchParams({cursor:page.nextCursor,search:'note'})),fail(400));if(page.items[49].definition.note==='literal %_ note')literalCount--;await deleteAnnotation(sibling,owner,page.items[49].id,{requestId:randomUUID(),revision:1});}
      cursor=page.nextCursor;pages++;
    }while(cursor);assert.equal(seen.size,1005);assert.equal(pages,21);
    assert.equal((await listAnnotations(sibling,viewer,new URLSearchParams({search:'%_'}))).items.length,literalCount);const retained=await annotationTimeline(sibling,viewer,scope);assert.equal(retained.totalCount,1004);
    await pool.query("UPDATE project SET analytics_retained_from='2099-01-01T00:00:00Z' WHERE id=$1",[sibling]);assert.deepEqual(await annotationTimeline(sibling,viewer,scope),retained);assert.equal((await listAnnotations(sibling,viewer,new URLSearchParams())).items.length,50);
    assert.deepEqual((await annotationTimeline(sibling,viewer,new URLSearchParams({from:'2011-12-30',to:'2011-12-30',timeZone:'Pacific/Apia'}))).days,[]);
    console.log('PASS1005 notes with exact timeline counts/three previews,50-row complete tied-date pagination, literal search and independent authored retention');

    const locked=await pool.connect();try{await locked.query('BEGIN');await locked.query('LOCK TABLE analytics_annotation IN ACCESS EXCLUSIVE MODE');const start=Date.now();await assert.rejects(annotationTimeline(project,viewer,scope),fail(503));assert.ok(Date.now()-start<15000);}finally{await locked.query('ROLLBACK');locked.release();}
    console.log('PASS scoped timeline query timeout is bounded and returns sanitized503');

    const login=async(uid:string)=>{const response=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@annotations.test',password})}));assert.equal(response.status,200);return response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');};
    const cookie=await login(owner),viewerCookie=await login(viewer),endpoint=config.appUrl+'/api/projects/'+project+'/annotations';
    const http=(method:string,path='',body?:unknown,who=cookie,origin=config.appUrl)=>handleApi(new Request(endpoint+path,{method,headers:{cookie:who,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const body={requestId:randomUUID(),definition:definition('HTTP')};const response=await http('POST','',body);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const created=await response.json();
    assert.equal((await http('GET','/'+created.item.id,undefined,viewerCookie)).status,200);assert.equal((await http('GET','/timeline?from=2026-10-14&to=2026-10-14',undefined,viewerCookie)).status,200);
    assert.equal((await http('POST','',body,viewerCookie)).status,404);assert.equal((await http('POST','',body,cookie,'https://foreign.example')).status,403);assert.equal((await http('GET','',undefined,'')).status,401);assert.equal((await http('DELETE','/'+created.item.id)).status,405);assert.equal((await http('GET','/'+created.item.id+'?x=1')).status,400);assert.equal((await http('POST','?x=1',body)).status,400);assert.equal((await http('GET','/timeline')).status,400);assert.equal((await http('POST','/timeline',body)).status,405);assert.equal((await http('POST','',{...body,padding:'x'.repeat(8200)})).status,413);
    const token=await createApiKey(workspace,owner,{name:'Annotation fixture',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token.token}}))).status,403);
    assert.equal((await http('POST','/'+created.item.id+'/update',{requestId:randomUUID(),revision:1,definition:definition('Changed')})).status,200);assert.equal((await http('POST','/'+created.item.id+'/delete',{requestId:randomUUID(),revision:2})).status,200);assert.deepEqual(await(await http('POST','',body)).json(),{role:'owner',item:null,deleted:true,replayed:true});
    const rate=(await pool.query("SELECT to_timestamp((floor(extract(epoch FROM clock_timestamp())/60)+2)*60) AS deadline")).rows[0].deadline;
    await pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,30 FROM generate_series(0,1)n ON CONFLICT(key,minute) DO UPDATE SET count=30",['annotations:'+owner+':write']);assert.equal((await http('POST','',{requestId:randomUUID(),definition:definition('Rate')})).status,429);assert.equal((await pool.query('SELECT clock_timestamp()<$1 AS ok',[rate])).rows[0].ok,true);
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer]);assert.equal((await http('GET','',undefined,viewerCookie)).status,404);assert.equal(outbound,0);
    console.log('PASS actual CRUD/timeline session routes, Origin/API-key/body/method/query/rate/role boundaries and zero external requests');
  }finally{globalThis.fetch=savedFetch;}
}
if(import.meta.main){try{await runAnnotationChecks();}finally{await closeDatabase();}}
