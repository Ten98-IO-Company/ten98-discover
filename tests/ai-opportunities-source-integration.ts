import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts,updatePrompt} from '../src/server/prompts.ts';
import {updateProjectContext,withContentProject} from '../src/server/project-context.ts';
import {openRouterTextProfile} from '../src/lib/openrouter-models.ts';
import type {OpportunitiesScope} from '../src/lib/ai-opportunities.ts';
import {assertOpportunitiesSourceCurrent} from '../src/server/ai-opportunities-input.ts';
import {readOpportunitiesSource,selectOpportunitiesSource} from '../src/server/ai-opportunities-source.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const model='openai/gpt-4o-mini';
const citation=(url:string,title:string|null=null)=>({url,title});
export async function runAiOpportunitiesSourceChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_OPPORTUNITIES_SOURCE_TEST,'1');
 const config=getConfig(),database=new URL(config.databaseUrl);assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_opportunities_source_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_opportunities_source_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(config.appUrl).hostname));
 for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Opportunity source checks forbid outbound requests.');};
 const owner=randomUUID(),viewer=randomUUID(),outsider=randomUUID();
 const day=(n:number)=>new Date(Date.now()-n*86400000).toISOString().slice(0,10),current=day(1),previous=day(2),at=current+'T12:00:00.000000Z';
 const scope=(patch:Partial<OpportunitiesScope>={}):OpportunitiesScope=>({from:current,to:current,timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1',...patch});
 for(const user of [owner,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Source fixture\',$2)',[user,`${user}@opportunities.integration.test`]);
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Opportunity source')",[workspace]);
  for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name)VALUES($1,$2,'openrouter','No credentials')",[connection,workspace]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Which solar product should I choose?',tags:['solar'],enabled:false}]})).items[0];
  const context=await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme',aliases:['Acme Solar']},{kind:'competitor',primaryDomain:'beta.com',name:'Beta',aliases:['Beta Solar']}]});
  return {workspace,project,connection,prompt,competitor:context.competitors[0].id as string};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 type Sample={text?:string;citations?:{url:string;title:string|null}[];at?:string;completed?:string;finish?:string;input?:unknown;purged?:boolean;prompt?:{id:string;currentVersionId:string;text:string}};
 async function seed(f:Fixture,samples:Sample[]){
  const route={model,tag:'openai',providerName:'OpenAI',profile:openRouterTextProfile,contextLength:32768,promptCapacity:32768,completionCapacity:4096};
  const data=samples.map(s=>{const p=s.prompt??f.prompt;return {id:randomUUID(),prompt:p.id,version:p.currentVersionId,at:s.at??at,completed:s.completed??new Date().toISOString(),purged:s.purged??false,
   input:s.input??{connectionId:f.connection,promptId:p.id,versionId:p.currentVersionId,systemText:'',models:[model],maxCompletionTokens:1024},messages:[{role:'user',content:p.text}],
   result:{text:s.text??'Acme and Beta are mentioned.',resolvedModel:model,provider:'OpenAI',finishReason:s.finish??'stop',citations:s.citations??[]}};});
  const payload=JSON.stringify(data),columns='id uuid,prompt uuid,version uuid,at timestamptz,completed timestamptz,purged boolean,input jsonb,messages jsonb,result jsonb';
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at,request_version)
   SELECT id,$2,$3,$4,prompt,version,$5,1,repeat('a',64),repeat('b',64),input,messages,'[]',repeat('c',64),clock_timestamp()+interval '5 minutes',1 FROM jsonb_to_recordset($1::jsonb)x(${columns})`,[payload,f.workspace,f.project,owner,f.connection]);
  await pool.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at)SELECT id,id,$2,$3,$4,id,at FROM jsonb_to_recordset($1::jsonb)x(${columns})`,[payload,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,status)SELECT id,$2,$3,1,$4,id,'fixture.opportunities',repeat('d',64),'settled' FROM jsonb_to_recordset($1::jsonb)x(${columns})`,[payload,f.workspace,f.connection,owner]);
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at,result_purged_at)SELECT id,id,$2,$3,0,$4,'completed',CASE WHEN purged THEN NULL ELSE result END,completed,CASE WHEN purged THEN clock_timestamp() END FROM jsonb_to_recordset($1::jsonb)x(${columns})`,[payload,f.workspace,f.project,JSON.stringify(route)]);
  return data;
 }
 const read=(f:Fixture,patch:Partial<OpportunitiesScope>={},user=owner,signal?:AbortSignal)=>readOpportunitiesSource(f.project,user,scope(patch),signal);
 try{
  const f=await fixture(),rows=await seed(f,[{citations:[citation('https://acme.com/guide','Owned'),citation('https://beta.com/guide','Competitor'),citation('https://www.reddit.com/r/solar/comments/1','Community'),citation('https://www.google.com/search?q=solar','Search')]},{at:previous+'T12:00:00.000000Z',citations:[citation('https://previous-only.com/a')]}]);
  const first=await read(f,{},viewer);assert.equal(first.availability,'available');assert.equal(first.snapshot.executions.length,1);assert.equal(first.dependencies[0].executionId,rows[0].id);assert.equal(first.snapshot.citations.length,4);assert.ok(!JSON.stringify(first).includes('previous-only.com'));
  assert.deepEqual(first.snapshot.citations.map(c=>[c.retainedCitationIndex,c.ownership,c.sourceType]).sort((a,b)=>Number(a[0])-Number(b[0])),[[0,'brand','publisher'],[1,'competitor','publisher'],[2,'untracked','publisher'],[3,'untracked','google_search']]);
  assert.equal(first.snapshot.subjects.find(s=>s.id==='brand')!.name,'Acme');assert.equal(first.snapshot.subjects.find(s=>s.id===f.competitor)!.name,'Beta');assert.deepEqual(first.snapshot.executions[0].competitorIds,[f.competitor]);assert.ok(first.warnings.some(w=>w.includes('preceding equal-length')));
  const stored=(await pool.query("SELECT encode(sha256(convert_to(result::text,'UTF8')),'hex') AS hash FROM prompt_execution WHERE id=$1",[rows[0].id])).rows[0];assert.equal(first.dependencies[0].resultHash,stored.hash);
  await pool.query("UPDATE prompt_execution SET result=jsonb_set(result,'{text}','\"Changed previous answer\"') WHERE id=$1",[rows[1].id]);
  const priorChanged=await read(f);assert.equal(priorChanged.evidenceHash,first.evidenceHash);assert.equal(priorChanged.businessInputHash,first.businessInputHash);
  await assert.rejects(read(f,{},outsider),fail(404));const foreign=await fixture();await assert.rejects(read(f,{promptId:foreign.prompt.id}),fail(404));
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,viewer]);await assert.rejects(read(f,{},viewer),fail(404));
  await assert.rejects(read(f,{},owner,AbortSignal.abort()),fail(499));
  console.log('PASS native membership, current-only classification, names, exact jsonb hashes and cancellation');

  const empty=await fixture(),noAnswers=await read(empty);assert.equal(noAnswers.availability,'insufficient-evidence');assert.equal(noAnswers.snapshot.coverage.attempted,0);assert.equal(noAnswers.snapshot.source.rawAnchorAt,null);
  await seed(empty,[{text:'No named products and no citations.'}]);const noCitations=await read(empty);assert.equal(noCitations.availability,'available');assert.equal(noCitations.snapshot.citations.length,0);assert.equal(noCitations.snapshot.executions[0].brandMentioned,false);
  const oldPrompt=empty.prompt;const updated=await updatePrompt(empty.project,owner,oldPrompt.id,{requestId:randomUUID(),revision:oldPrompt.revision,text:'A later immutable solar question'});
  await seed(empty,[{prompt:updated.prompt}]);const versions=await read(empty);assert.equal(versions.snapshot.prompts.length,2);assert.deepEqual(new Set(versions.snapshot.prompts.map(p=>p.text)),new Set([oldPrompt.text,'A later immutable solar question']));
  await assert.rejects(withContentProject(empty.project,owner,false,(client,p)=>selectOpportunitiesSource(client,p,scope(),()=>{throw Object.assign(Error('cancel'),{status:499});}),undefined,true),fail(499));
  const before=await read(f);await pool.query("UPDATE prompt_execution SET result=jsonb_set(result,'{text}','\"Changed current answer\"') WHERE id=$1",[rows[0].id]);const changed=await read(f);assert.notEqual(changed.evidenceHash,before.evidenceHash);assert.notEqual(changed.businessInputHash,before.businessInputHash);assert.throws(()=>assertOpportunitiesSourceCurrent(before.snapshot,changed.snapshot.source),fail(409));
  const stable=await read(f);await pool.query('UPDATE workspace SET retention_revision=retention_revision+1,raw_provider_evidence_days=80 WHERE id=$1',[f.workspace]);const administrative=await read(f);assert.notEqual(administrative.evidenceHash,stable.evidenceHash);assert.equal(administrative.businessInputHash,stable.businessInputHash);
  await updateProjectContext(f.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'citation-category',domain:'www.reddit.com',category:'editorial'}]});const classified=await read(f);assert.notEqual(classified.evidenceHash,administrative.evidenceHash);
  console.log('PASS no answers versus no citations, immutable versions, stale results and policy/classification freshness');

  const invalid=await fixture();await seed(invalid,[{input:{}}]);await assert.rejects(read(invalid),fail(409));
  const purged=await fixture(),purgedRows=await seed(purged,[{}]);await pool.query('UPDATE prompt_execution_quote SET input=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1',[purgedRows[0].id]);await assert.rejects(read(purged),fail(410));
  const expiredFixture=await fixture();await pool.query('UPDATE workspace SET raw_provider_evidence_days=1 WHERE id=$1',[expiredFixture.workspace]);await seed(expiredFixture,[{at:previous+'T00:00:00.000000Z',completed:previous+'T12:00:00.000000Z'}]);const expiredSource=await read(expiredFixture,{from:previous,to:previous});assert.equal(expiredSource.availability,'insufficient-evidence');assert.equal(expiredSource.snapshot.coverage.expired,1);
  const deleted=await fixture(),deletedRows=await seed(deleted,[{}]),beforeDelete=await read(deleted);
  await pool.query('DELETE FROM prompt_comparison_item WHERE execution_id=$1 AND project_id=$2',[deletedRows[0].id,deleted.project]);
  await pool.query('DELETE FROM prompt_execution WHERE id=$1 AND project_id=$2',[deletedRows[0].id,deleted.project]);
  const afterDelete=await read(deleted);assert.equal(afterDelete.availability,'insufficient-evidence');assert.throws(()=>assertOpportunitiesSourceCurrent(beforeDelete.snapshot,afterDelete.snapshot.source),fail(409));
  console.log('PASS malformed identities, purged input, elapsed retention and deleted source invalidation');

  const boundary=await fixture();await seed(boundary,[{citations:Array.from({length:100},(_,i)=>citation('https://news.com/a'+i))},{citations:Array.from({length:100},(_,i)=>citation('https://news.com/b'+i))}]);assert.equal((await read(boundary)).snapshot.citations.length,200);await seed(boundary,[{citations:[citation('https://news.com/overflow')]}]);await assert.rejects(read(boundary),fail(413));
  const promptBound=await fixture();const many=(await createPrompts(promptBound.project,owner,{requestId:randomUUID(),prompts:Array.from({length:31},(_,i)=>({text:'Question '+i,tags:[],enabled:false}))})).items;
  await seed(promptBound,many.slice(0,30).map(prompt=>({prompt})));assert.equal((await read(promptBound)).snapshot.prompts.length,30);await seed(promptBound,[{prompt:many[30]}]);await assert.rejects(read(promptBound),fail(413));
  const scanBound=await fixture();await seed(scanBound,Array.from({length:1001},()=>({at:previous+'T12:00:00.000000Z'})));await assert.rejects(read(scanBound),e=>fail(413)(e)&&String(e).includes('preceding equal-length'));
  console.log('PASS complete citation/prompt bounds and inherited previous-period population cap');

  // The transaction starts before this wait. Fresh clock checks must reject an
  // answer that expires while its workspace gate is held by another writer.
  const waiting=await fixture();await pool.query('UPDATE workspace SET raw_provider_evidence_days=1 WHERE id=$1',[waiting.workspace]);
  const near=(await pool.query("SELECT clock_timestamp()-interval '24 hours'+interval '600 milliseconds' AS at")).rows[0].at as Date;
  await seed(waiting,[{at:previous+'T00:00:00.000000Z',completed:near.toISOString()}]);
  const gate=await pool.connect();await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[waiting.workspace]);
  const pending=read(waiting,{from:previous,to:previous});const outcome=pending.then(value=>({value,error:null}),error=>({value:null,error}));
  try{await gate.query('SELECT pg_sleep(0.9)');await gate.query('COMMIT');const settled=await outcome;assert.ok(settled.error&&fail(410)(settled.error),'Evidence expiring during the lock wait must not be published.');}
  finally{await gate.query('ROLLBACK');gate.release();}
  assert.equal(outbound,0);console.log('PASS fresh retention after workspace wait; zero outbound calls');
 }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runAiOpportunitiesSourceChecks();}finally{await closeDatabase();}}
