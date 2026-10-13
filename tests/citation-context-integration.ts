import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {hashPassword} from 'better-auth/crypto';
import {FoundationError,getAuth} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {contentProfile,getProjectContext,updateProjectContext,withContentProject} from '../src/server/project-context.ts';
import {createPrompts,getPrompt,listPrompts} from '../src/server/prompts.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_CITATION_CONTEXT_TEST,'1');
const url=new URL(getConfig().databaseUrl),ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1';
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.search,'');assert.equal(url.hash,'');
assert.ok(ci?url.port==='5432'&&url.pathname==='/ten98_citation_context_ci':url.port==='55501'&&/^\/ten98_citation_context_[a-f0-9]+$/.test(url.pathname));
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.ok(!process.env[key]);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(getConfig().appUrl).hostname));
await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh migrated fixture.');
const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),other=randomUUID(),foreign=randomUUID(),cap=randomUUID();
const email=`${randomUUID()}@example.com`,password=randomBytes(24).toString('base64url'),fail=(status:number)=>(error:unknown)=>error instanceof FoundationError&&error.status===status;
const fetchOriginal=globalThis.fetch,dnsOriginal=Resolver.prototype.resolveTxt;let requests=0;
globalThis.fetch=async()=>{requests++;throw new Error('Unexpected provider request.');};Resolver.prototype.resolveTxt=async()=>{requests++;throw new Error('Unexpected DNS lookup.');};
const change=(pid:string,revision:number,updates:unknown[],user=owner,requestId=randomUUID())=>updateProjectContext(pid,user,{revision,requestId,updates});
try{
 await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Owner\',$2),($3,\'Editor\',$4),($5,\'Viewer\',$6),($7,\'Foreign owner\',$8)',[owner,email,editor,`${editor}@example.com`,viewer,`${viewer}@example.com`,outsider,`${outsider}@example.com`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Citation context\'),($2,\'Foreign\')',[workspace,foreignWorkspace]);
 await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer'),($5,$6,'owner')",[workspace,owner,editor,viewer,foreignWorkspace,outsider]);
 for(const [id,w,origin]of [[project,workspace,'https://brand.example.com'],[other,workspace,'https://other.example.com'],[foreign,foreignWorkspace,'https://foreign.example.com'],[cap,workspace,'http://localhost:4567']])await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,\'Brand\',$3,$4)',[id,w,origin,randomUUID()]);
 let context=await getProjectContext(project,viewer);assert.deepEqual(context.profile.citationDomains,[]);assert.deepEqual(context.citationCategoryOverrides,[]);
 assert.deepEqual(await withContentProject(project,viewer,false,(client,p)=>contentProfile(client,p)),{revision:1,name:'Brand',aliases:[],citationDomains:[],citationCategoryOverrides:[]});
 for(const user of [viewer,outsider])await assert.rejects(change(project,1,[{kind:'citation-brand-domain',domain:'extra.example.com',action:'add'}],user),fail(404));
 await assert.rejects(getProjectContext(foreign,owner),fail(404));
 const created=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'citations-only.example.com alternatives'}]})).items[0];assert.equal(created.classification.isBranded,false);
 console.log('PASS citation context defaults, scoped member reads and current writer permissions.');

 const request={revision:1,requestId:randomUUID(),updates:[{kind:'citation-brand-domain',domain:'Z.example.com',action:'add'},{kind:'citation-brand-domain',domain:'BÜCHER.example.com.',action:'add'},{kind:'citation-brand-domain',domain:'citations-only.example.com',action:'add'},{kind:'citation-category',domain:'WWW.source.example.com',category:'other'},{kind:'citation-category',domain:'source.example.com',category:'editorial'},{kind:'competitor',primaryDomain:'citations-only.example.com',domains:['child.citations-only.example.com']}]};
 const replies=await Promise.all([updateProjectContext(project,editor,request),updateProjectContext(project,editor,request)]);context=replies[0];assert.equal(replies[1].revision,2);
 assert.deepEqual(context.profile.citationDomains,['citations-only.example.com','xn--bcher-kva.example.com','z.example.com']);
 assert.deepEqual(context.citationCategoryOverrides,[{domain:'source.example.com',category:'editorial'},{domain:'www.source.example.com',category:'other'}]);assert.equal(context.competitors.length,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_content_request WHERE project_id=$1 AND request_id=$2',[project,request.requestId])).rows[0].n,1);
 // Receipts retain the existing normalized-body/project guarantee, not an invented actor binding.
 assert.equal((await updateProjectContext(project,owner,request)).revision,2);
 await assert.rejects(updateProjectContext(project,owner,{...request,updates:[{kind:'citation-category',domain:'source.example.com',category:'reviews'}]}),fail(409));
 await assert.rejects(change(project,1,[{kind:'citation-brand-domain',domain:'stale.example.com',action:'add'}]),fail(409));
 context=await change(project,2,[{kind:'citation-category',domain:'source.example.com',category:null},{kind:'citation-category',domain:'www.source.example.com',category:'social'},{kind:'citation-brand-domain',domain:'z.example.com',action:'remove'},{kind:'citation-brand-domain',domain:'absent.example.com',action:'remove'},{kind:'citation-brand-domain',domain:'brand.example.com',action:'add'}]);
 assert.deepEqual(context.citationCategoryOverrides,[{domain:'www.source.example.com',category:'social'}]);assert.equal(context.profile.citationDomains.length,2);assert.equal((await updateProjectContext(project,editor,request)).revision,3,'Late replay returns current context without reapplying removed domains.');
 assert.deepEqual((await getProjectContext(other,owner)).profile.citationDomains,[]);
 console.log('PASS normalized exact-host arrays, accepted overlaps, explicit override reset and concurrent/late receipt replay.');

 const untouched=await getProjectContext(project,owner);
 await assert.rejects(change(project,untouched.revision,[{kind:'research',summary:'must rollback'},{kind:'citation-brand-domain',domain:'brand.example.com',action:'remove'}]),fail(400));
 assert.deepEqual(await getProjectContext(project,owner),untouched);
 await assert.rejects(change(project,untouched.revision,[{kind:'competitor',primaryDomain:'collision.example.com',domains:['child.citations-only.example.com']}]),fail(409));
 context=await change(project,untouched.revision,[{kind:'profile',aliases:['Human Alias']}]);
 assert.deepEqual(context.profile.citationDomains,untouched.profile.citationDomains);assert.deepEqual(context.citationCategoryOverrides,untouched.citationCategoryOverrides);
 assert.equal((await getPrompt(project,owner,created.id)).prompt.classification.isBranded,false);
 assert.equal((await listPrompts(project,owner,new URLSearchParams({classification:'branded'}))).items.length,0);
 for(const table of ['project_domain','provider_request'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
 console.log('PASS implicit origin immutability, unchanged competitor conflicts and prompt text classification; no registry/provider writes.');

 let bounded=await change(cap,1,Array.from({length:19},(_,i)=>({kind:'citation-brand-domain',domain:`d${String(i).padStart(2,'0')}.example.com`,action:'add'})));
 const failedId=randomUUID();await assert.rejects(change(cap,bounded.revision,[{kind:'profile',name:'must rollback'},{kind:'citation-brand-domain',domain:'overflow.example.com',action:'add'}],owner,failedId),fail(400));
 assert.deepEqual(await getProjectContext(cap,owner),bounded);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[cap,failedId])).rowCount,0);
 bounded=await change(cap,bounded.revision,[{kind:'citation-brand-domain',domain:'d00.example.com',action:'remove'},{kind:'citation-brand-domain',domain:'replacement.example.com',action:'add'}]);assert.equal(bounded.profile.citationDomains.length,19);
 for(let start=0;start<100;start+=50)bounded=await change(cap,bounded.revision,Array.from({length:50},(_,i)=>({kind:'citation-category',domain:`c${String(start+i).padStart(3,'0')}.example.com`,category:'other'})));
 await assert.rejects(change(cap,bounded.revision,[{kind:'profile',name:'must rollback'},{kind:'citation-category',domain:'overflow.example.com',category:'editorial'}]),fail(400));assert.deepEqual(await getProjectContext(cap,owner),bounded);
 bounded=await change(cap,bounded.revision,[{kind:'citation-category',domain:'c000.example.com',category:null},{kind:'citation-category',domain:'replacement.example.com',category:'reference'},{kind:'citation-category',domain:'c001.example.com',category:'reviews'}]);assert.equal(bounded.citationCategoryOverrides.length,100);assert.equal(bounded.citationCategoryOverrides.find(o=>o.domain==='c001.example.com')?.category,'reviews');
 for(const [column,value]of [['brand_citation_domains',{}],['brand_citation_domains',Array(20).fill('example.com')],['citation_category_overrides',{}],['citation_category_overrides',Array(101).fill({domain:'example.com',category:'other'})]])await assert.rejects(pool.query(`UPDATE project_context SET ${column}=$2 WHERE project_id=$1`,[cap,JSON.stringify(value)]));
 assert.deepEqual(await getProjectContext(cap,owner),bounded);
 console.log('PASS19-domain/100-override boundaries, replacement at capacity and atomic full-batch/receipt rollback plus SQL caps.');

 context=await getProjectContext(project,owner);
 const concurrent=await Promise.allSettled(['a','b'].map(suffix=>change(project,context.revision,[{kind:'citation-category',domain:`${suffix}.example.com`,category:'pr'}])));
 assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);assert.ok(concurrent.some(result=>result.status==='rejected'&&fail(409)(result.reason)));
 const blocker=await pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await blocker.query('BEGIN');const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
  pending=updateProjectContext(project,editor,request).then(()=>null,error=>error);
  const deadline=Date.now()+5000;let waiting=false;
  while(Date.now()<deadline){const observed=await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT w.id FROM workspace w JOIN project%'",[blockerPid]);if(observed.rowCount===1){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(waiting,'Observe this writer blocked by this fixture transaction before demotion.');await blocker.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await blocker.query('COMMIT');assert.ok(fail(404)(await pending));
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await pending;}
 assert.equal(requests,0);
 console.log('PASS one CAS winner and live demotion before receipt replay under the exact workspace lock.');

 const signIn=await getAuth().api.signInEmail({body:{email,password},asResponse:true}),cookie=signIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),app=getConfig().appUrl;
 const http=(pid:string,body:unknown,origin=app)=>handleApi(new Request(`${app}/api/projects/${pid}/context/update`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
 const current=await getProjectContext(other,owner),httpInput={revision:current.revision,requestId:randomUUID(),updates:[{kind:'citation-brand-domain',domain:'http.example.com',action:'add'},{kind:'citation-category',domain:'http.example.com',category:'institutional'}]};
 const accepted=await http(other,httpInput);assert.equal(accepted.status,200);const body=await accepted.json();assert.deepEqual(body.profile.citationDomains,['http.example.com']);assert.deepEqual(body.citationCategoryOverrides,[{domain:'http.example.com',category:'institutional'}]);assert.equal((await http(other,httpInput)).status,200);
 assert.equal((await http(other,{...httpInput,requestId:randomUUID()},'https://foreign.example.com')).status,403);assert.equal((await http(foreign,{...httpInput,requestId:randomUUID()})).status,404);assert.equal(requests,0);
 console.log('PASS actual authenticated context route, exact DTO/retry, Origin denial and foreign-project denial with zero provider/DNS calls.');
}finally{globalThis.fetch=fetchOriginal;Resolver.prototype.resolveTxt=dnsOriginal;await closeDatabase();}
