import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { projectAnalytics } from '../src/server/analytics.ts';
import { createApiKey } from '../src/server/api-keys.ts';
import { getRetention, previewRetention, runRetentionBatch, saveRetention } from '../src/server/retention.ts';
import { runClosedAccountRetention } from '../src/server/account-closure-retention.ts';

export async function runRetentionCoverageChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig(), local = ['localhost','127.0.0.1','[::1]'];
  assert.ok(local.includes(new URL(config.databaseUrl).hostname) && local.includes(new URL(config.appUrl).hostname));
  const { pool } = getDatabase(), userId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
  const email = `${randomUUID()}@retention-http.integration.test`, password = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Retention HTTP reviewer', email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, await hashPassword(password)]);
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspaceId, 'Retention coverage']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_cutoff,retention_policy_revision,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'2024-03-31T12:00:00Z',1,'infinity')", [projectId,workspaceId,'Coverage','https://coverage.integration.test',randomUUID()]);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at) VALUES
    (gen_random_uuid(),$1,'page_view','/old','2024-03-30T00:00:00Z'),
    (gen_random_uuid(),$1,'page_view','/old','2024-03-31T11:59:59.999999Z'),
    (gen_random_uuid(),$1,'page_view','/exact','2024-03-31T12:00:00Z'),
    (gen_random_uuid(),$1,'page_view','/next','2024-04-01T05:00:00Z')`, [projectId]);
  const result = await runRetentionBatch(projectId);
  assert.equal(result?.deletedEvents, 2);
  const partial = await projectAnalytics(projectId,userId,new URLSearchParams({from:'2024-03-30',to:'2024-04-01'}));
  assert.deepEqual(partial.coverage,{status:'partial',retainedFrom:'2024-03-31T12:00:00.000Z'});
  assert.deepEqual(partial.totals,{pageViews:2,customEvents:0});
  assert.deepEqual(partial.daily,[
    {date:'2024-03-30',pageViews:null,customEvents:null,coverage:'unavailable'},
    {date:'2024-03-31',pageViews:1,customEvents:0,coverage:'partial'},
    {date:'2024-04-01',pageViews:1,customEvents:0,coverage:'complete'},
  ]);
  const oldRange = new URLSearchParams({from:'2024-03-30',to:'2024-03-30'});
  const absent = await projectAnalytics(projectId,userId,oldRange);
  assert.equal(absent.coverage.status,'unavailable');
  assert.deepEqual(absent.totals,{pageViews:null,customEvents:null});
  assert.equal(absent.measurement.identifiedPageViews,null);
  const empty = await projectAnalytics(projectId,userId,new URLSearchParams({from:'2024-04-02',to:'2024-04-02'}));
  assert.equal(empty.coverage.status,'complete');assert.deepEqual(empty.totals,{pageViews:0,customEvents:0});
  await assert.rejects(projectAnalytics(projectId,randomUUID(),oldRange),(error:any)=>error.status===404);
  const initial = await getRetention(workspaceId,userId);
  const extension = await previewRetention(workspaceId,userId,{revision:initial.revision,settings:{...initial.settings,rawAnalyticsDays:3650}});
  await saveRetention(workspaceId,userId,{previewToken:extension.previewToken});
  await runRetentionBatch(projectId);
  assert.deepEqual((await projectAnalytics(projectId,userId,oldRange)).coverage,absent.coverage,'Extending policy must not restore deleted history or change unavailable to zero.');

  const partialProject=randomUUID();
  await pool.query(`INSERT INTO project(id,workspace_id,name,origin,public_key,retention_cutoff,retention_policy_revision,retention_next_run_at)
    SELECT $1,$2,'Partial cleanup','https://partial-coverage.integration.test',$3,'2024-03-31T12:00:00Z',retention_revision,'infinity' FROM workspace WHERE id=$2`,[partialProject,workspaceId,randomUUID()]);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) SELECT gen_random_uuid(),$1,'page_view','/old','2024-03-30' FROM generate_series(1,1501)",[partialProject]);
  assert.equal((await runRetentionBatch(partialProject))?.complete,false);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM event WHERE project_id=$1',[partialProject])).rows[0].n,501);
  const during=await projectAnalytics(partialProject,userId,oldRange);
  assert.equal(during.coverage.status,'unavailable');assert.deepEqual(during.totals,{pageViews:null,customEvents:null});
  assert.deepEqual(during.pages,[],'Partially deleted historical rows must not leak misleading rankings.');
  const newer=await getRetention(workspaceId,userId);
  const again=await previewRetention(workspaceId,userId,{revision:newer.revision,settings:newer.settings});
  await saveRetention(workspaceId,userId,{previewToken:again.previewToken});
  assert.equal((await runRetentionBatch(partialProject))?.deletedEvents,0,'A revised long policy must stop the saved partial-pass target.');
  assert.deepEqual((await projectAnalytics(partialProject,userId,oldRange)).coverage,during.coverage);

  async function http(path:string,status:number,body?:unknown,cookie='',origin=config.appUrl,authorization?:string) {
    const response=await handleApi(new Request(`${config.appUrl}${path}`,{method:body===undefined?'GET':'POST',
      headers:{...(cookie?{cookie}:{}),...(authorization?{authorization}:{}),...(body===undefined?{}:{origin,'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}));
    assert.equal(response.status,status,`Retention HTTP status at ${path}`);
    return {data:await response.json(),cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
  }
  const cookie=(await http('/api/auth/sign-in/email',200,{email,password})).cookie;
  assert.ok(cookie);
  const route=`/api/workspaces/${workspaceId}/retention`;
  await http(route,401);
  const current=(await http(route,200,undefined,cookie)).data;
  await http(`${route}/preview`,403,{revision:current.revision,settings:current.settings},cookie,'https://foreign.integration.test');
  const reviewed=(await http(`${route}/preview`,200,{revision:current.revision,settings:current.settings},cookie)).data;
  const [encoded]=reviewed.previewToken.split('.');
  const content=JSON.parse(Buffer.from(encoded,'base64url').toString());
  for(const issuedAt of [Date.now()-600_000,Date.now()+600_000]) {
    const body=Buffer.from(JSON.stringify({...content,issuedAt})).toString('base64url');
    const signed=createHmac('sha256',config.authSecret).update(`ten98.retention.preview.v1:${body}`).digest('hex');
    await http(`${route}/save`,409,{previewToken:`${body}.${signed}`},cookie);
  }
  await http(`${route}/save`,400,{previewToken:`${reviewed.previewToken}\n`},cookie);
  await http(`${route}/save`,200,{previewToken:reviewed.previewToken},cookie);
  await http(`${route}/save`,409,{previewToken:reviewed.previewToken},cookie);
  const events=(await http(`/api/projects/${projectId}/events`,200,undefined,cookie)).data;
  assert.equal(events.total,2);assert.equal(events.events.length,2);assert.equal(events.retainedFrom,'2024-03-31T12:00:00.000Z');
  const projects=(await http(`/api/workspaces/${workspaceId}/projects`,200,undefined,cookie)).data.projects;
  const listed=projects.find((project:{id:string})=>project.id===projectId);
  assert.equal(listed.eventCount,2);assert.equal(listed.retainedFrom,events.retainedFrom);
  assert.equal(projects.find((project:{id:string})=>project.id===partialProject).eventCount,0,'Retained counts must exclude partially purged history.');
  const key=await createApiKey(workspaceId,userId,{name:'Retention cannot use bearer',scopes:['analytics:read']});
  await http(route,403,undefined,'',config.appUrl,`Bearer ${key.token}`);
  const foreignUser=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[foreignUser,'New owner',`${foreignUser}@retention-http.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,foreignUser]);
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,userId]);
  assert.equal((await http(route,200,undefined,cookie)).data.role,'viewer');
  await http(`${route}/preview`,403,{revision:3,settings:current.settings},cookie);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId]);
  await http(route,404,undefined,cookie);
  // Paid-work archive (#292): workspace retention never shortens it; only the daily 7-year job removes a row, and again
  // finds nothing more.
  const agedArchive=randomUUID(),recentArchive=randomUUID();
  for(const [id,age] of [[agedArchive,'7 years 1 day'],[recentArchive,'6 years 11 months']])await pool.query("INSERT INTO paid_work_archive(source_table,source_id,workspace_id,project_id,account_ids,record,created_at) VALUES('keyword_quote',$1::uuid,$2,$3,'{}',jsonb_build_object('id',$1::uuid),now()-$4::interval)",[id,workspaceId,projectId,age]);
  const archivedIds=async()=>(await pool.query<{id:string}>('SELECT source_id::text AS id FROM paid_work_archive WHERE workspace_id=$1 ORDER BY created_at',[workspaceId])).rows.map(row=>row.id);
  await pool.query("UPDATE project SET retention_next_run_at=clock_timestamp() WHERE id=$1",[projectId]);await runRetentionBatch(projectId);
  assert.deepEqual(await archivedIds(),[agedArchive,recentArchive],'Workspace analytics retention must not delete archived paid work.');
  for(let run=0;run<2;run++){const summary=await runClosedAccountRetention();assert.ok(!summary.archiveFailed);assert.deepEqual(await archivedIds(),[recentArchive],'Only 7-year-old archive rows go, and a repeat run is a no-op.');}
  console.log('PASS retention coverage: partial UTC day, unavailable versus zero, extension watermark, protected cookie routes, signed expiry, scopes, retained counts and the 7-year paid-work archive');
}
