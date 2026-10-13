import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {hashPassword} from 'better-auth/crypto';
import {FoundationError,getAuth} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {getContextResearch,getProjectContext,updateProjectContext} from '../src/server/project-context.ts';
import {getPrompt,createPrompts,listPrompts,promptVersions,setPromptArchived,updatePrompt} from '../src/server/prompts.ts';
import {createApiKey} from '../src/server/api-keys.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(getConfig().databaseUrl).hostname));
await assertSchema();const {pool}=getDatabase();
assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count,0,'Use a new empty migrated test database.');
const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),other=randomUUID(),foreignProject=randomUUID();
const email=`${randomUUID()}@example.com`,password=randomBytes(24).toString('base64url');
const fail=(status:number)=>(error:unknown)=>error instanceof FoundationError&&error.status===status;
const fetchOriginal=globalThis.fetch,dnsOriginal=Resolver.prototype.resolveTxt;
let fetches=0,dnsLookups=0;
globalThis.fetch=async()=>{fetches++;throw new Error('Unexpected network request.');};
Resolver.prototype.resolveTxt=async()=>{dnsLookups++;throw new Error('Unexpected DNS lookup.');};
try {
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Context owner\',$2),($3,\'Editor\',$4),($5,\'Viewer\',$6),($7,\'Outsider\',$8)',[owner,email,editor,`${editor}@example.com`,viewer,`${viewer}@example.com`,outsider,`${outsider}@example.com`]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
  const foreignWorkspace=randomUUID();
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Context fixtures\'),($2,\'Other workspace\')',[workspace,foreignWorkspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer'),($5,$6,'owner')",[workspace,owner,editor,viewer,foreignWorkspace,outsider]);
  await pool.query(`INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Acme Corp','https://www.acmecorp.example.com',$3),($4,$2,'Other project','https://other.example.com',$5),($6,$7,'Foreign','https://foreign.example.com',$8)`,[project,workspace,randomUUID(),other,randomUUID(),foreignProject,foreignWorkspace,randomUUID()]);
  let context=await getProjectContext(project,owner);
  assert.equal(context.revision,1);assert.equal(context.missingSections.length,4);assert.equal(context.profile.name,'Acme Corp');
  assert.equal((await getProjectContext(project,viewer)).role,'viewer');
  for(const uid of [viewer,outsider]) await assert.rejects(updateProjectContext(project,uid,{revision:1,requestId:randomUUID(),updates:[{kind:'research',summary:'denied'}]}),fail(404));
  await assert.rejects(getProjectContext(foreignProject,owner),fail(404));
  const request={revision:1,requestId:randomUUID(),updates:[
    {kind:'profile',aliases:['ACME','Acme Inc.']},
    {kind:'section',key:'business_overview',content:'  Original <script>text only</script>  '},
    {kind:'section',key:'custom:launch-plan',title:'Launch plan',content:'Keep authored notes.'},
    {kind:'competitor',primaryDomain:'BÜCHER.example.com',domains:['www.bücher.example.com'],name:'Books',aliases:['Book Brand'],notes:'Keep this note'},
    {kind:'key-page',url:'http://www.example.com/pricing?plan=team#heading',role:'money',topic:'Pricing',notes:'Existing note'},
    {kind:'research',summary:'Research note, no provider purchase.'},
  ]};
  const replies=await Promise.all([updateProjectContext(project,editor,request),updateProjectContext(project,editor,request)]);
  context=replies[0];assert.equal(replies[1].revision,2);assert.equal(context.researchLog.length,1);assert.equal(context.researchLog[0].createdBy,editor);
  assert.equal(context.competitors[0].primaryDomain,'xn--bcher-kva.example.com');assert.equal(context.competitors[0].domains.length,2);
  assert.equal(context.keyPages[0].url,'http://www.example.com/pricing?plan=team');assert.equal(context.sections[0].content,'Original <script>text only</script>');
  assert.equal(context.researchLog[0].entryDate,new Date().toISOString().slice(0,10));
  await assert.rejects(updateProjectContext(project,editor,{...request,updates:[{kind:'research',summary:'changed'}]}),fail(409));
  await assert.rejects(updateProjectContext(project,owner,{revision:1,requestId:randomUUID(),updates:[{kind:'research',summary:'stale'}]}),fail(409));
  context=await updateProjectContext(project,owner,{revision:2,requestId:randomUUID(),updates:[{kind:'competitor',primaryDomain:context.competitors[0].primaryDomain,notes:''},{kind:'key-page',url:context.keyPages[0].url,topic:''}]});
  assert.equal(context.competitors[0].name,'Books');assert.deepEqual(context.competitors[0].aliases,['Book Brand']);assert.equal(context.competitors[0].notes,'');assert.equal(context.keyPages[0].role,'money');assert.equal(context.keyPages[0].notes,'Existing note');assert.equal(context.keyPages[0].topic,'');
  await assert.rejects(updateProjectContext(project,owner,{revision:3,requestId:randomUUID(),updates:[{kind:'research',summary:'must rollback'},{kind:'competitor',primaryDomain:'collision.example.com',domains:['www.xn--bcher-kva.example.com']}]}),fail(409));
  assert.equal((await getProjectContext(project,owner)).researchLog.length,1);
  await assert.rejects(updateProjectContext(project,owner,{revision:3,requestId:randomUUID(),updates:Array.from({length:21},(_,i)=>({kind:'section',key:`custom:cap-${i}`,content:'x'}))}),fail(400));
  assert.equal((await getProjectContext(project,owner)).customSections.length,1);
  await pool.query("UPDATE context_research SET created_at=now()-interval '400 days',entry_date=(now()-interval '400 days')::date WHERE project_id=$1",[project]);
  context=await updateProjectContext(project,owner,{revision:3,requestId:randomUUID(),updates:Array.from({length:21},(_,i)=>({kind:'research',summary:`Retained entry ${i}`}))});
  assert.equal(context.researchLog.length,20);assert.ok(context.researchLogNextCursor);
  const older=await getContextResearch(project,viewer,new URLSearchParams({cursor:context.researchLogNextCursor!}));assert.equal(older.entries.length,2);
  assert.ok(older.entries.some(entry=>entry.summary==='Research note, no provider purchase.'),'Old authored data survives append.');
  await assert.rejects(getContextResearch(other,owner,new URLSearchParams({cursor:context.researchLogNextCursor!})),fail(400));
  await pool.query('INSERT INTO report_template(id,project_id,name,brief) VALUES($1,$2,\'Brief\',$3)',[randomUUID(),project,'x'.repeat(300)]);
  context=await getProjectContext(project,owner);assert.equal(context.reportTemplates[0].preview.length,200);assert.equal(context.reportTemplates[0].truncated,true);

  const batch={requestId:randomUUID(),prompts:[{text:'Is Acme Corp useful?',tags:['TOFU','tofu']},{text:'Generic products',tags:['branded']},{text:'Question to version',topic:'Research'}]};
  const made=await Promise.all([createPrompts(project,editor,batch),createPrompts(project,editor,batch)]);
  assert.deepEqual(made[0].items.map(p=>p.id),made[1].items.map(p=>p.id));assert.equal(made.filter(r=>r.replayed).length,1);
  assert.equal(made[0].items[0].enabled,false);assert.deepEqual(made[0].items[0].userTags,['tofu']);
  assert.deepEqual(made[0].items[1].systemTags,['unbranded']);assert.equal(made[0].items[1].classification.isOverridden,true);
  let prompt=made[0].items[2];const originalVersion=prompt.currentVersionId;
  assert.equal((await getPrompt(project,viewer,prompt.id)).prompt.id,prompt.id);
  await assert.rejects(getPrompt(other,owner,prompt.id),fail(404));
  await assert.rejects(getPrompt(project,outsider,prompt.id),fail(404));
  await assert.rejects(createPrompts(project,owner,{...batch,prompts:[{text:'Different'}]}),fail(409));
  await assert.rejects(createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Duplicate'},{text:' Duplicate '}]}),fail(400));
  await assert.rejects(createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'First should rollback'},{text:'Generic products'}]}),fail(409));
  assert.equal((await listPrompts(project,owner,new URLSearchParams({q:'First should rollback'}))).items.length,0);
  const change={requestId:randomUUID(),revision:prompt.revision,text:'Changed exact text',tags:['unbranded']};
  prompt=(await updatePrompt(project,editor,prompt.id,change)).prompt;
  assert.notEqual(prompt.currentVersionId,originalVersion);assert.equal((await updatePrompt(project,editor,prompt.id,change)).replayed,true);
  let versions=await promptVersions(project,viewer,prompt.id,new URLSearchParams());assert.equal(versions.versions.length,2);assert.equal(versions.versions[1].text,'Question to version');
  await assert.rejects(pool.query('UPDATE prompt_text_version SET text=\'changed\' WHERE id=$1',[originalVersion]),/immutable/);
  await assert.rejects(updatePrompt(other,owner,prompt.id,{...change,requestId:randomUUID()}),fail(404));
  await assert.rejects(updatePrompt(project,viewer,prompt.id,{...change,requestId:randomUUID()}),fail(404));
  await assert.rejects(updatePrompt(project,owner,prompt.id,{...change,requestId:randomUUID()}),fail(409));
  prompt=(await updatePrompt(project,owner,prompt.id,{requestId:randomUUID(),revision:prompt.revision,topic:'New topic'})).prompt;
  assert.equal((await promptVersions(project,owner,prompt.id,new URLSearchParams())).versions.length,2);
  const ordered=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Ordered version fixture'}]})).items[0];
  for(let n=2;n<=55;n++) await pool.query(`INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7)`,[randomUUID(),project,ordered.id,n,`version ${n}`,owner,n%2?'2000-01-01T00:00:00.000Z':'2000-01-02T00:00:00.000Z']);
  const historyFirst=await promptVersions(project,viewer,ordered.id,new URLSearchParams());
  assert.deepEqual(historyFirst.versions.map(v=>v.number),Array.from({length:50},(_,i)=>55-i));assert.ok(historyFirst.nextCursor);
  const historyLast=await promptVersions(project,viewer,ordered.id,new URLSearchParams({cursor:historyFirst.nextCursor!}));
  assert.deepEqual(historyLast.versions.map(v=>v.number),[5,4,3,2,1]);
  await assert.rejects(promptVersions(project,viewer,prompt.id,new URLSearchParams({cursor:historyFirst.nextCursor!})),fail(400));
  prompt=(await setPromptArchived(project,owner,prompt.id,true,{revision:prompt.revision,requestId:randomUUID()})).prompt;
  assert.ok(prompt.archivedAt);assert.equal((await listPrompts(project,owner,new URLSearchParams({status:'archived'}))).items.length,1);
  const duplicate=await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:prompt.text}]});
  await assert.rejects(setPromptArchived(project,owner,prompt.id,false,{revision:prompt.revision,requestId:randomUUID()}),fail(409));
  await setPromptArchived(project,owner,duplicate.items[0].id,true,{revision:1,requestId:randomUUID()});
  prompt=(await setPromptArchived(project,owner,prompt.id,false,{revision:prompt.revision,requestId:randomUUID()})).prompt;assert.equal(prompt.archivedAt,null);
  assert.equal((await listPrompts(project,viewer,new URLSearchParams({classification:'branded'}))).items.length,2);
  assert.equal((await listPrompts(project,viewer,new URLSearchParams({tag:'TOFU'}))).items.length,1);
  await createPrompts(project,owner,{requestId:randomUUID(),prompts:Array.from({length:55},(_,i)=>({text:`Pagination ${i}`,topic:'Pages'}))});
  const page=await listPrompts(project,owner,new URLSearchParams({q:'Pagination'}));assert.equal(page.items.length,50);assert.ok(page.nextCursor);
  const next=await listPrompts(project,owner,new URLSearchParams({q:'Pagination',cursor:page.nextCursor!}));assert.equal(next.items.length,5);assert.equal(new Set([...page.items,...next.items].map(p=>p.id)).size,55);
  await assert.rejects(listPrompts(project,owner,new URLSearchParams({q:'Changed',cursor:page.nextCursor!})),fail(400));
  await assert.rejects(listPrompts(project,owner,new URLSearchParams('q=x&q=y')),fail(400));
  context=await getProjectContext(project,owner);
  await updateProjectContext(project,owner,{revision:context.revision,requestId:randomUUID(),updates:[{kind:'profile',name:'İ',aliases:[]}]});
  const unicode=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'İstanbul exact'}]})).items[0];
  assert.equal(unicode.classification.isBranded,true);assert.ok((await listPrompts(project,owner,new URLSearchParams({classification:'branded'}))).items.some(p=>p.id===unicode.id),'SQL filter and JavaScript Unicode classifier agree.');

  // A write waiting on the shared workspace lock must observe a committed demotion.
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
  const pending=createPrompts(project,editor,{requestId:randomUUID(),prompts:[{text:'Revoked while waiting'}]}).then(()=>null,e=>e);
  let waited=false;
  for(let i=0;i<50;i++) {const waiting=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT w.id FROM workspace w JOIN project%' LIMIT 1");if(waiting.rowCount){waited=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.ok(waited);await blocker.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await blocker.query('COMMIT');blocker.release();
  assert.ok(fail(404)(await pending));assert.equal((await listPrompts(project,owner,new URLSearchParams({q:'Revoked while waiting'}))).items.length,0);

  const signIn=await getAuth().api.signInEmail({body:{email,password},asResponse:true});
  const cookie=signIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const url=getConfig().appUrl;
  const http=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>handleApi(new Request(url+path,{method,headers:{origin:url,cookie,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const root=`/api/projects/${project}`;
  assert.equal((await http(`${root}/context`)).status,200);
  assert.equal((await http(`${root}/prompts`)).status,200);
  assert.equal((await http(`${root}/prompts/${prompt.id}`)).status,200);
  assert.equal((await http(`${root}/prompts/${prompt.id}/versions`)).status,200);
  assert.equal((await http(`${root}/prompts/bulk`,'POST',{requestId:randomUUID(),prompts:[{text:'HTTP creation'}]})).status,201);
  assert.equal((await http(`${root}/prompts/bulk`,'POST',{requestId:randomUUID(),prompts:[{text:'blocked'}]},{origin:'https://untrusted.example.com'})).status,403);
  const key=await createApiKey(workspace,owner,{name:'Restricted fixture',scopes:['projects:read'],expiresInDays:1});
  assert.equal((await handleApi(new Request(url+root+'/context',{headers:{authorization:`Bearer ${key.token}`}}))).status,403);
  assert.equal((await http(`${root}/prompts`,'GET',undefined,{cookie:''})).status,401);
  assert.equal(fetches,0);assert.equal(dnsLookups,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM provider_request')).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM import_probe')).rows[0].count,0);
  console.log('Project context/prompts integration passed: isolated roles, atomic caps, retries, retained notes, exact metadata, immutable versions, filters/pagination, demotion race, cookie-only HTTP; zero provider/DNS/job activity.');
} finally {globalThis.fetch=fetchOriginal;Resolver.prototype.resolveTxt=dnsOriginal;await closeDatabase();}
