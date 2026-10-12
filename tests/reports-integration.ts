import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {FoundationError} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {createWorkspace,removeMember} from '../src/server/teams.ts';
import {createReportShare,deleteReport,getReport,handleReportShare,listReports,listReportShares,revokeReportShare,saveReport} from '../src/server/reports.ts';

type Options={baseUrl:string;appUrl:string;ownerCookie:string;ownerId:string;workspaceId:string};
function guard(baseUrl:string) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1','Report checks require the isolated integration-test opt-in.');
  const local=['localhost','127.0.0.1','[::1]'];
  assert.ok(local.includes(new URL(baseUrl).hostname)&&local.includes(new URL(getConfig().appUrl).hostname)&&local.includes(new URL(getConfig().databaseUrl).hostname),'Report tests require local HTTP and PostgreSQL fixtures.');
  assert.equal(new URL(baseUrl).port,new URL(getConfig().appUrl).port,'The report HTTP target must use this fixture application port.');
}
async function denied(work:Promise<unknown>,status:number) { await assert.rejects(work,(error:unknown)=>error instanceof FoundationError&&error.status===status); }
async function http(baseUrl:string,appUrl:string,path:string,cookie:string,expected:number,body?:unknown) {
  const response=await fetch(new URL(path,baseUrl),{method:body===undefined?'GET':'POST',headers:{cookie,origin:appUrl,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,expected,`Report HTTP contract: ${path}`);
  return response;
}

export async function runReportsChecks(options:Options) {
  guard(options.baseUrl);
  const {pool}=getDatabase();
  const {workspace}=await createWorkspace(options.ownerId,{name:'Isolated report checks'});
  const workspaceId=workspace.id,projectId=randomUUID(),siblingId=randomUUID();
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)',[projectId,workspaceId,'Reports','https://reports.integration.test',randomUUID(),siblingId,'Sibling','https://sibling.integration.test',randomUUID()]);
  const members:Record<string,string>={};
  for(const role of ['admin','editor','viewer']) {
    members[role]=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[members[role],`Report ${role}`,`${randomUUID()}@reports.integration.test`]);
    await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,members[role],role]);
  }
  const report=(await saveReport(projectId,members.editor,{title:'Original report',html:'<h1>Snapshot one</h1><script>window.forbidden=1</script>'})).report;
  assert.equal(report.revision,1);
  assert.match((await getReport(projectId,members.viewer,report.id)).report.html,/<script>/,'Members may retrieve their original private source.');
  assert.equal((await listReports(projectId,members.viewer)).role,'viewer');
  await denied(saveReport(projectId,members.viewer,{title:'Blocked',html:'<p>Denied</p>'}),403);
  await denied(getReport(siblingId,members.editor,report.id),404);
  await denied(getReport(projectId,randomUUID(),report.id),404);
  await denied(saveReport(projectId,members.editor,{title:'Invalid',html:'<p>x</p>',unexpected:true}),400);
  const template=(await saveReport(projectId,members.editor,{name:'Monthly briefing',brief:'Explain changes and their supporting metrics.'},undefined,true)).template;
  assert.equal((await getReport(projectId,members.viewer,template.id,true)).template.brief,'Explain changes and their supporting metrics.');
  await denied(saveReport(siblingId,members.editor,{name:'Cross project',brief:'Denied',revision:1},template.id,true),404);
  const templateUpdated=(await saveReport(projectId,members.editor,{name:'Updated briefing',brief:'Compare the previous month.',revision:1},template.id,true)).template;
  assert.equal(templateUpdated.revision,2);
  await denied(deleteReport(projectId,members.editor,template.id,{revision:1},true),409);
  await deleteReport(projectId,members.editor,template.id,{revision:2},true);
  await denied(getReport(projectId,members.viewer,template.id,true),404);

  const future=new Date(Date.now()+86400000).toISOString();
  const shareInput={label:'Client report',revision:1,expiresAt:future};
  await denied(createReportShare(projectId,members.editor,report.id,shareInput),403);
  await denied(listReportShares(projectId,members.viewer,report.id),403);
  await denied(createReportShare(siblingId,options.ownerId,report.id,shareInput),404);
  await denied(createReportShare(projectId,options.ownerId,report.id,{...shareInput,expiresAt:new Date(Date.now()+1000).toISOString()}),400);
  const created=await createReportShare(projectId,members.admin,report.id,shareInput);
  assert.ok(created.url.startsWith(`${options.appUrl}/share/client-report-`));
  const token=new URL(created.url).pathname.slice(-43);
  assert.equal(Buffer.from(token,'base64url').length,32);
  const stored=(await pool.query('SELECT token_hash,snapshot_html FROM report_share WHERE id=$1',[created.share.id])).rows[0];
  assert.equal(stored.token_hash,createHash('sha256').update(token).digest('hex'));
  const listed=await listReportShares(projectId,options.ownerId,report.id);
  assert.deepEqual(Object.keys(listed.shares[0]).sort(),['id','label','reportRevision','createdAt','expiresAt','revokedAt'].sort());
  assert.equal(JSON.stringify(listed).includes(token),false);
  const published=await handleReportShare(new Request(created.url));
  assert.equal(published.status,200);
  assert.equal(published.headers.has('set-cookie'),false);
  const snapshot=await published.text();
  assert.match(snapshot,/Snapshot one/);assert.equal(snapshot.includes('<script>'),false);
  assert.equal(snapshot.includes(workspaceId),false);assert.equal(snapshot.includes(options.ownerId),false);
  const racing=await Promise.allSettled([
    saveReport(projectId,members.editor,{title:'Updated A',html:'<h1>Snapshot two</h1>',revision:1},report.id),
    saveReport(projectId,members.admin,{title:'Updated B',html:'<h1>Snapshot two</h1>',revision:1},report.id),
  ]);
  assert.equal(racing.filter(result=>result.status==='fulfilled').length,1,'Concurrent edits must have one revision winner.');
  assert.ok(racing.some(result=>result.status==='rejected'&&result.reason instanceof FoundationError&&result.reason.status===409));
  assert.equal(await (await handleReportShare(new Request(created.url))).text(),snapshot,'Published snapshots must not change when the private source changes.');
  await denied(createReportShare(projectId,options.ownerId,report.id,shareInput),409);
  await denied(deleteReport(projectId,options.ownerId,report.id,{revision:1}),409);
  const updatedShare=await createReportShare(projectId,options.ownerId,report.id,{...shareInput,revision:2});
  assert.match(await (await handleReportShare(new Request(updatedShare.url))).text(),/Snapshot two/);
  const missing=await handleReportShare(new Request(`${options.appUrl}/share/unknown-${randomBytes(32).toString('base64url')}`));
  const missingBody=await missing.text();assert.equal(missing.status,404);
  const wrongLabel=await handleReportShare(new Request(created.url.replace('/client-report-','/changed-label-')));
  assert.equal(wrongLabel.status,404);assert.equal(await wrongLabel.text(),missingBody);
  await revokeReportShare(projectId,members.admin,report.id,created.share.id);
  const firstRevocation=(await listReportShares(projectId,options.ownerId,report.id)).shares.find(share=>share.id===created.share.id) as unknown as {revokedAt:Date};
  await revokeReportShare(projectId,members.admin,report.id,created.share.id);
  const secondRevocation=(await listReportShares(projectId,options.ownerId,report.id)).shares.find(share=>share.id===created.share.id) as unknown as {revokedAt:Date};
  assert.deepEqual(secondRevocation.revokedAt,firstRevocation.revokedAt);
  const revoked=await handleReportShare(new Request(created.url));assert.equal(revoked.status,404);assert.equal(await revoked.text(),missingBody);
  await pool.query("UPDATE report_share SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[updatedShare.share.id]);
  const expired=await handleReportShare(new Request(updatedShare.url));assert.equal(expired.status,404);assert.equal(await expired.text(),missingBody);
  const head=await handleReportShare(new Request(updatedShare.url,{method:'HEAD'}));assert.equal(head.status,404);assert.equal(await head.text(),'');
  for(let index=0;index<20;index++) await createReportShare(projectId,options.ownerId,report.id,{...shareInput,revision:2,label:`Limited link ${index}`});
  await denied(createReportShare(projectId,options.ownerId,report.id,{...shareInput,revision:2}),409);
  const active=(await listReportShares(projectId,options.ownerId,report.id)).shares.find(share=>!(share as unknown as {revokedAt:Date|null;expiresAt:Date}).revokedAt && (share as unknown as {expiresAt:Date}).expiresAt.getTime()>Date.now())!;
  await revokeReportShare(projectId,options.ownerId,report.id,active.id);
  const replacement=await createReportShare(projectId,options.ownerId,report.id,{...shareInput,revision:2});
  await deleteReport(projectId,members.editor,report.id,{revision:2});
  assert.equal((await handleReportShare(new Request(replacement.url))).status,404,'Deleting a report must invalidate its links.');
  assert.equal((await pool.query('SELECT 1 FROM report_share WHERE report_id=$1',[report.id])).rowCount,0);
  console.log('PASS reports: live roles, project isolation, original source, immutable sanitized shares, revisions, expiry/revocation and active-link bound');

  // Equal timestamps exercise the UUID tie-breaker; pages have no hidden lifetime count ceiling.
  const seeded=Array.from({length:105},()=>randomUUID());
  await pool.query("INSERT INTO report(id,project_id,title,source_html,created_at) SELECT id,$1,'Pagination','<p>Static</p>','2026-01-01T00:00:00.123Z'::timestamptz FROM unnest($2::uuid[]) AS id",[projectId,seeded]);
  const first=await listReports(projectId,members.viewer),second=await listReports(projectId,members.viewer,first.nextCursor),third=await listReports(projectId,members.viewer,second.nextCursor);
  assert.equal(first.reports!.length,50);assert.equal(second.reports!.length,50);assert.equal(third.reports!.length,5);assert.equal(third.nextCursor,null);
  assert.deepEqual([...first.reports!,...second.reports!,...third.reports!].map(row=>row.id),seeded.sort().reverse());
  await denied(listReports(projectId,members.viewer,'invalid'),400);
  const endpoint=`/api/projects/${projectId}/reports`;
  const read=await http(options.baseUrl,options.appUrl,endpoint,options.ownerCookie,200);
  assert.equal(read.headers.get('cache-control'),'no-store');
  assert.equal((await read.json()).reports.length,50);
  // List/preview refreshes must not consume the separately bounded mutation allowance.
  for(let index=0;index<31;index++) await http(options.baseUrl,options.appUrl,endpoint,options.ownerCookie,200);
  const savedResponse=await http(options.baseUrl,options.appUrl,endpoint,options.ownerCookie,200,{title:'HTTP saved',html:'<h1>HTTP report</h1><script>window.forbidden=1</script>'});
  const saved=(await savedResponse.json()).report;
  for(const title of ['private-sentinel\0','private-sentinel\ud800']) {
    const invalid=await http(options.baseUrl,options.appUrl,endpoint,options.ownerCookie,400,{title,html:'<p>Valid</p>'});
    assert.equal((await invalid.text()).includes('private-sentinel'),false,'Validation responses must not echo report input.');
  }
  const preview=await http(options.baseUrl,options.appUrl,`${endpoint}/${saved.id}/preview?revision=1`,options.ownerCookie,200);
  assert.match(preview.headers.get('content-security-policy')!,/^sandbox;/);assert.equal((await preview.text()).includes('<script>'),false);
  await http(options.baseUrl,options.appUrl,`${endpoint}/${saved.id}/preview?revision=2`,options.ownerCookie,409);
  await http(options.baseUrl,options.appUrl,endpoint,'',401);
  const csrf=await fetch(new URL(endpoint,options.baseUrl),{method:'POST',headers:{cookie:options.ownerCookie,origin:'https://attacker.invalid','content-type':'application/json'},body:JSON.stringify({title:'CSRF',html:'<p>Denied</p>'})});
  assert.equal(csrf.status,403);
  const httpShare=(await (await http(options.baseUrl,options.appUrl,`${endpoint}/${saved.id}/shares`,options.ownerCookie,200,{...shareInput,revision:1})).json());
  const publicResponse=await fetch(new URL(new URL(httpShare.url).pathname,options.baseUrl),{signal:AbortSignal.timeout(15000)});
  assert.equal(publicResponse.status,200);assert.equal(publicResponse.headers.has('set-cookie'),false);assert.match(publicResponse.headers.get('content-security-policy')!,/^sandbox;/);
  const validHead=await fetch(new URL(new URL(httpShare.url).pathname,options.baseUrl),{method:'HEAD'});assert.equal(validHead.status,200);assert.equal(await validHead.text(),'');

  const editorPassword=randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)',[randomUUID(),members.editor,'credential',await hashPassword(editorPassword)]);
  const editorEmail=(await pool.query('SELECT email FROM "user" WHERE id=$1',[members.editor])).rows[0].email;
  const login=await http(options.baseUrl,options.appUrl,'/api/auth/sign-in/email','',200,{email:editorEmail,password:editorPassword});
  const editorCookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  assert.ok(editorCookie,'An editor session is required to test authorization after body reads.');
  let begin!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{begin=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const stream=new ReadableStream<Uint8Array>({async pull(controller){begin();await released;controller.enqueue(new TextEncoder().encode(JSON.stringify({title:'Revoked during upload',html:'<p>Denied</p>'})));controller.close();}},{highWaterMark:0});
  const pending=handleApi(new Request(`${options.appUrl}${endpoint}`,{method:'POST',headers:{cookie:editorCookie,origin:options.appUrl,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit));
  try {
    await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Report body read did not begin.')),5000))]);
    await removeMember(workspaceId,options.ownerId,members.editor);
  } finally {release();}
  assert.equal((await pending).status,404,'Authorization must be rechecked inside the workspace transaction after the body arrives.');
  assert.equal((await pool.query("SELECT 1 FROM report WHERE project_id=$1 AND title='Revoked during upload'",[projectId])).rowCount,0);
  const lock=await pool.connect();
  let waiting:Promise<unknown>|undefined;
  try {
    await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspaceId]);
    await lock.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,members.admin]);
    waiting=denied(createReportShare(projectId,members.admin,saved.id,{...shareInput,revision:1}),403);
    const deadline=Date.now()+5000;let blocked=false;
    while(!blocked&&Date.now()<deadline) {
      await lock.query('SELECT pg_stat_clear_snapshot()');
      blocked=(await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM workspace WHERE id=$1 FOR UPDATE'")).rowCount!==0;
      if(!blocked) await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(blocked,'Share creation must serialize with role changes on the workspace lock.');
    await lock.query('COMMIT');await waiting;
  } finally {await lock.query('ROLLBACK').catch(()=>undefined);lock.release();await waiting;}
  console.log('PASS reports: 105-item stable pagination, HTTP preview/share/HEAD/CSRF, redacted text validation, membership removal during upload and demotion while sharing waits');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const config=getConfig(),baseUrl=process.env.BASE_URL??config.appUrl;guard(baseUrl);await assertSchema();
    const userId=randomUUID(),email=`${randomUUID()}@reports.integration.test`,password=randomBytes(24).toString('base64url');
    const {pool}=getDatabase();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Report test owner',email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)',[randomUUID(),userId,'credential',await hashPassword(password)]);
    const {workspace}=await createWorkspace(userId,{name:'Report integration owner'});
    const login=await http(baseUrl,config.appUrl,'/api/auth/sign-in/email','',200,{email,password});
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
    await runReportsChecks({baseUrl,appUrl:config.appUrl,ownerCookie:cookie,ownerId:userId,workspaceId:workspace.id});
  } finally {await closeDatabase();}
}
