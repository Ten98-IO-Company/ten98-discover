import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {getPromptInsights,exportPromptInsights} from '../src/server/prompt-insights.ts';
import {handleApi} from '../src/server/api.ts';
import {getAuth} from '../src/server/auth.ts';
import {createApiKey} from '../src/server/api-keys.ts';

const fail=(status:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===status;
const mini='openai/gpt-4o-mini',large='openai/gpt-4o';
const result=(text:string,finishReason='stop',citations:{url:string;title:string|null}[]=[])=>({text,resolvedModel:mini,provider:'OpenAI',finishReason,citations,promptTokens:1,completionTokens:1,receivedAt:new Date().toISOString()});
type Sample={result?:unknown;status?:string;model?:string;at?:string;completed?:string|null;purged?:boolean;promptId?:string;versionId?:string};
export async function runPromptInsightsChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROMPT_INSIGHTS_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_prompt_insights_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_prompt_insights_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('No provider requests are permitted in insight tests.');};
 const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomUUID()+randomUUID(),today=new Date().toISOString().slice(0,10);
 const params=(extra:Record<string,string>={})=>new URLSearchParams({from:today,to:today,...extra});
 for(const user of [owner,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Insight fixture\',$2)',[user,`${user}@insight.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Insight fixture')",[workspace]);
  for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','No credentials; read only')",[connection,workspace]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Which brand?',tags:['original'],enabled:false}]})).items[0];
  const context=await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme',aliases:['ACME','Acme corp']},{kind:'competitor',primaryDomain:'beta.com',name:'Beta',aliases:[]}]});
  return {workspace,project,connection,prompt,competitor:context.competitors[0].id as string};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function seed(f:Fixture,samples:Sample[]){
  const data=samples.map(s=>({id:randomUUID(),prompt:s.promptId??f.prompt.id,version:s.versionId??f.prompt.currentVersionId,at:s.at??new Date().toISOString(),completed:s.completed===undefined?new Date().toISOString():s.completed,
   result:s.result??null,status:s.status??'completed',model:s.model??mini,purged:s.purged??false}));
  const payload=JSON.stringify(data),columns='id uuid,prompt uuid,version uuid,at timestamptz,completed timestamptz,result jsonb,status text,model text,purged boolean';
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
   SELECT id,$2,$3,$4,prompt,version,$5,1,repeat('a',64),repeat('b',64),'{}','[]','[]',repeat('c',64),clock_timestamp()+interval '5 minutes' FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner,f.connection]);
  await pool.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) SELECT id,id,$2,$3,$4,id,at FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
   SELECT id,$2,$3,1,$4,id,'synthetic.insight',repeat('d',64),1,CASE WHEN status='uncertain' THEN 'uncertain' ELSE 'settled' END,current_date FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.connection,owner]);
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at,result_purged_at)
   SELECT id,id,$2,$3,0,jsonb_build_object('model',model),status,result,completed,CASE WHEN purged THEN clock_timestamp() END FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project]);
  return data;
 }
 const get=(f:Fixture,extra:Record<string,string>={},user=owner)=>getPromptInsights(f.project,user,params(extra));
 const exported=(f:Fixture,r:Awaited<ReturnType<typeof get>>,user=viewer,signal?:AbortSignal)=>exportPromptInsights(f.project,user,{...r.filters,expectedSelectionRevision:r.selectionRevision},signal);
 try{
  const f=await fixture();await seed(f,[{result:result('Acme Beta Acme')},{result:result('Beta is not recommended.')},{result:result('Other products','stop',[{url:'https://news.acme.com/article',title:'Actual annotation'}])},{result:result('Acme corp'),status:'uncertain'},
   {result:result(' \n ')},{result:result('Acme','length')},{result:result('Acme','content_filter')},{status:'reconciled'},{status:'queued',completed:null},{status:'running',completed:null},{result:{text:'Acme'}},{result:null,purged:true}]);
  const r=await get(f,{},viewer);assert.equal(r.role,'viewer');assert.deepEqual(r.coverage,{attempted:12,eligible:4,queued:1,running:1,no_answer:1,empty:1,truncated:1,content_filtered:1,expired:1,invalid:1});
  assert.deepEqual(r.metrics,[{id:'brand',mentions:2,citations:1,eligibleAnswers:4,shareOfVoiceDenominator:4,citationDenominator:4},{id:f.competitor,mentions:2,citations:0,eligibleAnswers:4,shareOfVoiceDenominator:4,citationDenominator:4}]);
  assert.equal(r.executions.find(e=>e.status==='uncertain')?.eligibility,'eligible');assert.equal(r.daily[0].coverage.eligible,4);assert.match(r.label,/current project context/);
  for(const [outcome,total]of [['mentioned',2],['not_mentioned',2],['cited',1]] as const)assert.equal((await get(f,{entityId:'brand',outcome})).totalRows,total);
  assert.equal((await get(f,{outcome:'eligible'})).totalRows,4);assert.equal((await get(f,{outcome:'unavailable'})).totalRows,8);
  await assert.rejects(get(f,{},foreign),fail(404));const other=await fixture();await assert.rejects(get(f,{promptId:other.prompt.id}),fail(404));
  const text=JSON.stringify(r);for(const forbidden of ['key_fingerprint','request_actor','Acme Beta Acme','input_hash'])assert.ok(!text.includes(forbidden));
  const csv=await exported(f,r);assert.equal(csv.role,'viewer');assert.equal(csv.filename,'prompt-insights.csv');assert.match(csv.body,/execution/);assert.ok(!csv.body.includes('Acme Beta Acme'));
  function csvRows(body:string){return body.trimEnd().split('\r\n').map(line=>{const cells=line.match(/"(?:[^"]|"")*"/g)!;assert.equal(cells.join(','),line);assert.equal(cells.length,26);return cells.map(cell=>cell.slice(1,-1).replaceAll('""','"'));});}
  const cells=csvRows(csv.body),execution=cells.find(row=>row[0]==='execution')!;assert.equal(execution[16],r.executions[0].id);assert.equal(execution[17],r.executions[0].comparisonId);assert.equal(execution[24],r.executions[0].eligibility);
  console.log('PASS eligibility reconciles all attempts, exact entity/citation denominators, uncertainty independence and scoped member exports');

  const zero=await fixture();await seed(zero,[{result:result('No named products.')}]);const zr=await get(zero);assert.equal(zr.metrics[0].mentions,0);assert.equal(zr.metrics[0].eligibleAnswers,1);assert.equal(zr.metrics[0].shareOfVoiceDenominator,null);
  await updateProjectContext(zero.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',name:'=SUM(1,2)',aliases:['Quoted "alias"']}]});
  const safeCsv=csvRows((await exported(zero,await get(zero))).body);assert.equal(JSON.parse(safeCsv[1][7])[0].name,'=SUM(1,2)');assert.ok(!safeCsv.some(row=>row.some(cell=>/^[=+@-]/.test(cell))));
  const empty=await fixture(),er=await get(empty);assert.equal(er.coverage.attempted,0);assert.equal(er.metrics[0].eligibleAnswers,null);assert.equal(er.daily[0].metrics[0].shareOfVoiceDenominator,null);
  const page=await fixture();await seed(page,Array.from({length:53},(_,i)=>({result:result(i<51?'Acme':'Neither')})));const first=await get(page,{entityId:'brand',outcome:'mentioned'});assert.equal(first.totalRows,51);assert.equal(first.executions.length,50);assert.ok(first.nextCursor);
  const next=await get(page,{entityId:'brand',outcome:'mentioned',cursor:first.nextCursor!});assert.equal(next.executions.length,1);assert.equal(next.nextCursor,null);assert.equal(new Set([...first.executions,...next.executions].map(e=>e.id)).size,51);assert.equal(next.metrics[0].eligibleAnswers,53);
  await assert.rejects(get(page,{entityId:page.competitor,outcome:'mentioned',cursor:first.nextCursor!}),fail(400));
  await pool.query("UPDATE project_prompt SET user_tags='[\"changed\"]' WHERE id=$1",[page.prompt.id]);await assert.rejects(get(page,{entityId:'brand',outcome:'mentioned',cursor:first.nextCursor!}),fail(409));await assert.rejects(exported(page,first),fail(409));
  assert.equal((await get(page,{tag:'original'})).coverage.attempted,0);assert.equal((await get(page,{tag:'changed'})).coverage.attempted,53);
  const beforeContext=await get(page);await updateProjectContext(page.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',name:'Gamma',aliases:[]}]});await assert.rejects(exported(page,beforeContext),fail(409));assert.equal((await get(page)).metrics[0].mentions,0);
  console.log('PASS zero versus unavailable, full-population filtered pagination and current tag/context revision invalidation');

  const retention=await fixture(),old=new Date(Date.now()-100*86400000).toISOString();const oldRows=await seed(retention,[{result:result('Acme'),completed:old},{result:result('Acme')},{status:'reconciled',completed:old}]);
  let rr=await get(retention);assert.equal(rr.coverage.expired,1);assert.equal(rr.coverage.eligible,1);assert.equal(rr.coverage.no_answer,1);
  await pool.query('UPDATE prompt_execution SET result=NULL,result_purged_at=clock_timestamp() WHERE id=$1',[oldRows[1].id]);await assert.rejects(exported(retention,rr),fail(409));
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[retention.workspace]);rr=await get(retention);assert.equal(rr.coverage.expired,1);assert.equal(rr.coverage.eligible,1);
  const revived=await get(retention);await pool.query("UPDATE prompt_execution SET result=jsonb_set(result,'{text}','\"Beta\"') WHERE id=$1",[oldRows[0].id]);await assert.rejects(exported(retention,revived),fail(409));
  await assert.rejects(exported(retention,await get(retention),viewer,AbortSignal.abort()),fail(499));
  console.log('PASS fresh raw retention, permanent tombstones, changed payload revisions and cancelled exports');

  const zones=await fixture();await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[zones.workspace]);await seed(zones,[
   {result:result('Acme'),at:'2025-11-02T04:30:00Z'},{result:result('Beta'),at:'2025-11-02T05:30:00Z'},{result:result('Neither'),at:'2025-11-03T04:30:00Z'},
   {result:result('Acme'),at:'2011-12-30T10:30:00Z'},{result:{...result('Beta'),resolvedModel:large},model:large,at:'2025-11-02T07:00:00Z'}]);
  const ny=await get(zones,{from:'2025-11-02',to:'2025-11-03',timeZone:'America/New_York'});assert.equal(ny.coverage.attempted,4);assert.equal(ny.daily[0].coverage.attempted,4);assert.equal(ny.daily[1].coverage.attempted,0);assert.equal(ny.daily[1].metrics[0].eligibleAnswers,null);
  assert.equal((await get(zones,{from:'2025-11-02',to:'2025-11-02',timeZone:'America/New_York',model:large})).coverage.eligible,1);
  const apia=await get(zones,{from:'2011-12-30',to:'2011-12-31',timeZone:'Pacific/Apia'});assert.equal(apia.daily[0].coverage.attempted,0);assert.equal(apia.daily[1].coverage.attempted,1);
  await assert.rejects(get(zones,{from:'2025-01-01',to:'2025-02-01'}),fail(400));await assert.rejects(get(zones,{timeZone:'Not/A_Zone'}),e=>!!e&&typeof e==='object'&&'status'in e&&e.status===400);
  await assert.rejects(getPromptInsights(zones.project,owner,new URLSearchParams('matcher=unicode-boundary-v1&matcher=elmo-substring-v1')),fail(400));
  console.log('PASS actual local-day observations across 25-hour and skipped days, exact model scope and strict filters');

  const snapshot=await fixture();await seed(snapshot,[{result:result('Acme')}]);
  const connect=pool.connect.bind(pool);let release!:()=>void,admitted!:()=>void,taken=false;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>admitted=r);
  pool.connect=(async(...connectArgs:any[])=>{if(connectArgs.length)return (connect as any)(...connectArgs);const client=await connect();if(!taken){taken=true;const query=client.query.bind(client);client.query=(async(...args:any[])=>{
   const sql=String(args[0]);if(sql.startsWith('SELECT revision,brand_name')){admitted();await gate;}
   return (query as any)(...args);
  }) as typeof client.query;const done=client.release.bind(client);client.release=((...args:any[])=>{client.query=query;return (done as any)(...args);}) as typeof client.release;}return client;}) as typeof pool.connect;
  try{const pending=get(snapshot,{},viewer);await entered;
   await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[snapshot.workspace,viewer]);
   await pool.query("UPDATE project_context SET brand_name='Changed during read',revision=revision+1 WHERE project_id=$1",[snapshot.project]);
   release();const admittedReport=await pending;assert.equal(admittedReport.role,'viewer');assert.equal(admittedReport.subjects[0].name,'Acme');assert.equal(admittedReport.metrics[0].mentions,1);
  }finally{release();pool.connect=connect;}
  await assert.rejects(get(snapshot,{},viewer),fail(404));
  console.log('PASS one admitted repeatable-read snapshot during concurrent context change and membership removal; next read denied');

  const limits=await fixture();await seed(limits,Array.from({length:1001},()=>({status:'reconciled'})));await assert.rejects(get(limits),fail(413));
  const bytes=await fixture();await seed(bytes,Array.from({length:45},()=>({result:result('x'.repeat(245000))})));await assert.rejects(get(bytes),fail(413));
  const cpu=await fixture();await updateProjectContext(cpu.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',aliases:Array.from({length:20},(_,i)=>'term '+i)}]});
  await seed(cpu,Array.from({length:21},()=>({result:result('x'.repeat(245000))})));await assert.rejects(get(cpu),fail(413));
  const localOrigin=await fixture();await pool.query("UPDATE project SET origin='http://localhost:3999' WHERE id=$1",[localOrigin.project]);assert.equal((await get(localOrigin)).warnings.length,1);
  console.log('PASS count, retained-byte and explicit work capacity rejection before any sampled report; local origin warning');

  const auth=await getAuth().api.signInEmail({body:{email:`${viewer}@insight.integration.test`,password},asResponse:true});assert.equal(auth.status,200);const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const address=config.appUrl+`/api/projects/${f.project}/prompt-insights`,headers={cookie,origin:config.appUrl,'content-type':'application/json'};
  const http=await handleApi(new Request(address+'?'+params(),{headers}));assert.equal(http.status,200);assert.equal(http.headers.get('cache-control'),'no-store');const report=await http.json();
  const body=JSON.stringify({...report.filters,expectedSelectionRevision:report.selectionRevision});const download=await handleApi(new Request(address+'/export',{method:'POST',headers,body}));assert.equal(download.status,200);assert.match(download.headers.get('content-type')!,/^text\/csv/);assert.ok(Number(download.headers.get('x-export-row-count'))>0);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers:{...headers,origin:'https://foreign.example'},body}))).status,403);
  assert.equal((await handleApi(new Request(address,{method:'DELETE',headers}))).status,405);
  assert.equal((await handleApi(new Request(address+'/export?x=1',{method:'POST',headers,body}))).status,400);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers,body:'x'.repeat(4097)}))).status,413);
  const key=await createApiKey(f.workspace,owner,{name:'Synthetic insights exclusion',scopes:['analytics:read'],expiresInDays:1});
  assert.equal((await handleApi(new Request(address,{headers:{authorization:'Bearer '+key.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,viewer]);assert.equal((await handleApi(new Request(address,{headers}))).status,404);
  assert.equal(outbound,0);console.log('PASS actual cookie API viewer export, Origin/method/body/API-key guards and current access revocation with zero outbound requests');
 }finally{globalThis.fetch=original;await closeDatabase();}
}
if(process.env.TEN98_PROMPT_INSIGHTS_TEST==='1')runPromptInsightsChecks().catch(e=>{console.error(e);process.exitCode=1;});
