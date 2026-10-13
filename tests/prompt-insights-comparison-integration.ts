import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts,updatePrompt} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {getPromptInsightsComparison,exportPromptInsightsComparison,type PromptInsightsComparison} from '../src/server/prompt-insights-comparison.ts';
import {getAuth} from '../src/server/auth.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {handleApi} from '../src/server/api.ts';

const fail=(status:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===status;
const mini='openai/gpt-4o-mini',large='openai/gpt-4o';
const fraction=(n:string,d='1')=>({numerator:n,denominator:d});
const result=(text:string,finishReason='stop',cited=false)=>({text,finishReason,resolvedModel:mini,provider:'OpenAI',citations:cited?[{url:'https://docs.acme.com/a',title:null}]:[]});
type Sample={text?:string;result?:unknown;status?:string;side?:'current'|'previous';at?:string;completed?:string|null;system?:string;maximum?:number;model?:string;models?:string[];input?:unknown;messages?:unknown;inputPurged?:boolean;resultPurged?:boolean;prompt?:{id:string;currentVersionId:string;text:string};connection?:string};

export async function runPromptComparisonChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROMPT_INSIGHTS_COMPARISON_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_prompt_insights_comparison_ci';
 assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');
 assert.match(url.pathname,/^\/ten98_prompt_insights_comparison_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const k of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[k],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int n FROM workspace')).rows[0].n,0,'Use a new owned empty fixture.');
 const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('Outbound access is disabled in this fixture.');};
 const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomUUID()+randomUUID();
 const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10),current=day(-1),previous=day(-2);
 const params=(extra:Record<string,string>={})=>new URLSearchParams({from:current,to:current,...extra});
 for(const id of [owner,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Comparison fixture\',$2)',[id,`${id}@comparison.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
 async function fixture(text='Which products are suitable?'){
  const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Comparison fixture')",[workspace]);
  for(const [id,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,id,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','Synthetic read-only connection')",[connection,workspace]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text,tags:['original'],enabled:false}]})).items[0];
  const context=await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme',aliases:[]},{kind:'competitor',name:'Beta',primaryDomain:'beta.com',aliases:[]}]});
  return {workspace,project,connection,prompt,competitor:context.competitors[0].id};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function seed(f:Fixture,samples:Sample[]){
  const rows=samples.map(s=>{const p=s.prompt??f.prompt,model=s.model??mini,system=s.system??'',connection=s.connection??f.connection;
   return {id:randomUUID(),prompt:p.id,version:p.currentVersionId,at:s.at??`${s.side==='previous'?previous:current}T12:00:00Z`,completed:s.completed===undefined?new Date().toISOString():s.completed,
    result:s.result===undefined?s.text===undefined?null:{...result(s.text),resolvedModel:model}:s.result,status:s.status??'completed',model,connection,
    input:s.input??{connectionId:connection,promptId:p.id,versionId:p.currentVersionId,systemText:system,models:s.models??[model],maxCompletionTokens:s.maximum??1024,fundedCredits:true},
    messages:s.messages??[...(system?[{role:'system',content:system}]:[]),{role:'user',content:p.text}],inputPurged:s.inputPurged??false,resultPurged:s.resultPurged??false};});
  const data=JSON.stringify(rows),cols='id uuid,prompt uuid,version uuid,at timestamptz,completed timestamptz,result jsonb,status text,model text,connection uuid,input jsonb,messages jsonb,"inputPurged" boolean,"resultPurged" boolean';
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,input_purged_at,routes,input_hash,expires_at)
   SELECT id,$2,$3,$4,prompt,version,connection,1,repeat('a',64),repeat('b',64),CASE WHEN "inputPurged" THEN NULL ELSE input END,CASE WHEN "inputPurged" THEN NULL ELSE messages END,CASE WHEN "inputPurged" THEN clock_timestamp() END,'[]',repeat('c',64),clock_timestamp()+interval '5 minutes' FROM jsonb_to_recordset($1::jsonb) x(${cols})`,[data,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) SELECT id,id,$2,$3,$4,id,at FROM jsonb_to_recordset($1::jsonb) x(${cols})`,[data,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
   SELECT id,$2,connection,1,$3,id,'fixture.comparison',repeat('d',64),1,CASE WHEN status='uncertain' THEN 'uncertain' ELSE 'settled' END,current_date FROM jsonb_to_recordset($1::jsonb) x(${cols})`,[data,f.workspace,owner]);
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at,result_purged_at)
   SELECT id,id,$2,$3,0,jsonb_build_object('model',model,'tag','openai','providerName','OpenAI','promptPrice','0.000001'),status,CASE WHEN "resultPurged" THEN NULL ELSE result END,completed,CASE WHEN "resultPurged" THEN clock_timestamp() END FROM jsonb_to_recordset($1::jsonb) x(${cols})`,[data,f.workspace,f.project]);
  return rows;
 }
 const get=(f:Fixture,extra:Record<string,string>={},user=owner)=>getPromptInsightsComparison(f.project,user,params(extra));
 const exp=(f:Fixture,r:Awaited<ReturnType<typeof get>>,signal?:AbortSignal)=>exportPromptInsightsComparison(f.project,viewer,{...r.filters,expectedSelectionRevision:r.selectionRevision},signal);
 function manifest(r:PromptInsightsComparison){
  assert.equal(r.evidenceStates.length,r.current.coverage.attempted+r.previous.coverage.attempted);assert.ok(r.evidenceStates.length<=1000);assert.equal(new Set(r.evidenceStates.map(e=>e.id)).size,r.evidenceStates.length);
  for(const e of r.evidenceStates)assert.deepEqual(Object.keys(e).sort(),['eligibility','id','identity','period'],'The manifest must contain states only, never raw text, settings or matches.');
  for(const side of ['current','previous'] as const){const rows=r.evidenceStates.filter(e=>e.period===side),p=r[side];assert.equal(rows.length,p.coverage.attempted);
   for(const [kind,n]of Object.entries(p.coverage))if(kind!=='attempted')assert.equal(rows.filter(e=>e.eligibility===kind).length,n);
   assert.equal(rows.filter(e=>e.eligibility==='eligible'&&e.identity==='available').length,p.usable);assert.equal(rows.filter(e=>e.eligibility==='eligible'&&e.identity==='unavailable').length,p.identityUnavailable);assert.equal(rows.filter(e=>e.eligibility==='eligible'&&e.identity==='invalid').length,p.identityInvalid);
  }
  if(r.page.kind==='executions')for(const {id,period,eligibility,identity}of r.page.rows)assert.deepEqual(r.evidenceStates.find(e=>e.id===id),{id,period,eligibility,identity});
 }
 try{
  const f=await fixture();const own=await seed(f,[{text:'Acme',system:'A'},{text:'Acme',system:'A',status:'uncertain'},{text:'Other',system:'B'},
   {text:'Other',system:'A',side:'previous'},{result:result('Acme','stop',true),system:'B',side:'previous'}]);
  const r=await get(f,{},viewer);assert.equal(r.role,'viewer');assert.equal(r.status,'comparable');assert.equal(r.periodOpen,false);assert.equal(r.cellCount,2);assert.equal(r.current.usable,3);assert.equal(r.previous.usable,2);
  assert.deepEqual(r.metrics[0],{id:'brand',current:fraction('1','2'),previous:fraction('1','2'),delta:fraction('0'),citationsCurrent:fraction('0'),citationsPrevious:fraction('1','2'),citationsDelta:fraction('-1','2')});
  assert.equal(r.current.matchedExecutions,3);assert.equal(r.current.matchedCells,2);assert.equal(r.headlineBasis,'matched_cells');
  manifest(r);assert.deepEqual(r.evidenceStates.map(e=>e.id).sort(),own.map(e=>e.id).sort());
  for(const [outcome,total]of [['mentioned',2],['not_mentioned',1],['cited',0]] as const){const part=await get(f,{view:'executions',period:'current',entityId:'brand',outcome});assert.equal(part.totalRows,total);assert.deepEqual(part.metrics,r.metrics);manifest(part);assert.deepEqual(part.evidenceStates,r.evidenceStates,'Drilldown must not shrink the whole-report expiry manifest.');}
  await assert.rejects(get(f,{},foreign),fail(404));const another=await fixture();const foreignRows=await seed(another,[{text:'Foreign secret text'}]);await assert.rejects(get(f,{promptId:another.prompt.id}),fail(404));assert.ok(!(await get(f)).evidenceStates.some(e=>e.id===foreignRows[0].id));
  const serialized=JSON.stringify(r);for(const secret of ['key_fingerprint','request_actor','input_hash','promptPrice'])assert.ok(!serialized.includes(secret));
  console.log('PASS equal-cell means differ from pooled counts, signed citation delta, exact drilldowns and tenant/member scope');

  const threshold=await fixture();await seed(threshold,[...Array.from({length:9},()=>({text:'Other'})),{status:'queued',completed:null},...Array.from({length:9},()=>({text:'Acme',side:'previous' as const})),{status:'failed',side:'previous'}]);
  let tr=await get(threshold);assert.equal(tr.status,'comparable');assert.deepEqual(tr.metrics[0].current,fraction('0'));assert.deepEqual(tr.metrics[0].delta,fraction('-1'));
  await seed(threshold,[{status:'failed'}]);tr=await get(threshold);assert.equal(tr.status,'incomplete');assert.equal(tr.metrics[0].delta,null);assert.deepEqual(tr.metrics[0].current,fraction('0'));assert.equal(tr.current.coverage.attempted,11);
  const empty=await fixture();assert.equal((await get(empty)).status,'no_data');await seed(empty,[{text:'Acme'}]);assert.equal((await get(empty)).status,'no_previous');
  const unavailable=await fixture();await seed(unavailable,[{status:'failed'},{text:'Acme',side:'previous'}]);assert.equal((await get(unavailable)).status,'unavailable');
  const drift=await fixture();await seed(drift,[{text:'Acme',system:'New scope'},{text:'Acme',side:'previous'}]);const dr=await get(drift);assert.equal(dr.status,'scope_changed');assert.equal(dr.metrics[0].previous,null);assert.equal(dr.headlineBasis,'current_cells');
  const open=await fixture();await seed(open,[{text:'Acme',at:day(0)+'T12:00:00Z'},{text:'Other'}]);const op=await get(open,{from:day(0),to:day(0)});assert.equal(op.status,'in_progress');assert.equal(op.periodOpen,true);assert.equal(op.metrics[0].delta,null);
  console.log('PASS all comparison status priorities, strict 90-percent coverage boundary, open period and genuine zero versus unavailable');

  const identities=await fixture(),conn=randomUUID();await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','Changed connection')",[conn,identities.workspace]);
  const originals=await seed(identities,[{text:'Acme'},{text:'Other',side:'previous',models:[mini,large],connection:conn}]);
  assert.equal((await get(identities)).cellCount,1,'Prices, actor, connection and unrelated sibling model choices do not split an identical request.');
  await pool.query("UPDATE prompt_execution SET route=route||'{\"promptPrice\":\"999\"}'::jsonb WHERE id=$1",[originals[0].id]);assert.equal((await get(identities)).cellCount,1);
  await seed(identities,[{text:'Acme',maximum:2048},{text:'Acme',model:large},{text:'Acme',system:'Different instruction'},{text:'Acme',messages:[{role:'user',content:'Wrong captured user text'}]},
   {text:'Acme',input:{}},{text:'Acme',inputPurged:true},{result:result('Acme','length')},{result:result('Acme','content_filter')},{result:result(' ')},{result:{text:'Acme'}},{status:'reconciled'}]);
  const ir=await get(identities);assert.equal(ir.cellCount,4);assert.equal(ir.current.identityInvalid,2);assert.equal(ir.current.identityUnavailable,1);assert.equal(ir.current.coverage.eligible,7);assert.equal(ir.current.usable,4);
  manifest(ir);
  assert.equal(ir.current.usable+ir.current.identityInvalid+ir.current.identityUnavailable,ir.current.coverage.eligible);
  const unusable=await get(identities,{view:'executions',period:'current',outcome:'unavailable'});assert.equal(unusable.totalRows,8);assert.ok(unusable.page.rows.every(e=>'usable'in e&&!e.usable));
  const cohort=await fixture('How does Acme compare?');await seed(cohort,[{text:'Acme'},{text:'Acme',side:'previous'}]);assert.equal((await get(cohort)).current.excludedByCohort,1);assert.equal((await get(cohort)).status,'no_data');assert.equal((await get(cohort)).evidenceStates.length,0);assert.equal((await get(cohort,{cohort:'all'})).status,'comparable');assert.equal((await get(cohort,{cohort:'all'})).evidenceStates.length,2);
  await pool.query("UPDATE project_prompt SET user_tags='[\"unbranded\"]',archived_at=clock_timestamp() WHERE id=$1",[cohort.prompt.id]);assert.equal((await get(cohort)).status,'comparable');
  await pool.query("UPDATE project_prompt SET user_tags='[\"branded\",\"unbranded\"]' WHERE id=$1",[cohort.prompt.id]);assert.equal((await get(cohort)).status,'no_data');
  const immutable=await fixture();await seed(immutable,[{text:'Acme'},{text:'Acme',side:'previous'}]);const edited=await updatePrompt(immutable.project,owner,immutable.prompt.id,{requestId:randomUUID(),revision:1,text:'Acme current text'});
  const im=await get(immutable);assert.equal(im.status,'comparable');assert.equal(im.page.kind,'cells');if(im.page.kind!=='cells')throw new Error('Expected comparison cells.');assert.equal(im.page.rows[0].promptPreview,immutable.prompt.text,'Current prompt editing cannot replace the captured version for classification/preview.');
  await seed(immutable,[{text:'Acme',prompt:edited.prompt}]);const versioned=await get(immutable,{cohort:'all'});assert.equal(versioned.cellCount,2);assert.equal(versioned.current.matchedCells,1);assert.equal(versioned.current.matchedExecutions,1);
  assert.ok(versioned.page.rows.some(c=>'versionId'in c&&c.versionId===edited.prompt.currentVersionId&&'status'in c&&c.status==='current_only'));
  // Two actual children share one comparison request but remain two model cells.
  const siblings=await fixture(),siblingsRows=await seed(siblings,[{text:'Acme',models:[mini,large]},{text:'Acme',model:large,models:[mini,large]},{text:'Acme',side:'previous'},{text:'Acme',side:'previous',model:large}]);
  await pool.query('UPDATE prompt_execution SET comparison_id=$2,position=1 WHERE id=$1',[siblingsRows[1].id,siblingsRows[0].id]);await pool.query('DELETE FROM prompt_comparison WHERE id=$1',[siblingsRows[1].id]);
  const sr=await get(siblings,{view:'executions',period:'current'});assert.equal(sr.current.coverage.attempted,2);assert.equal(sr.current.matchedCells,2);assert.equal(new Set(sr.page.rows.map(e=>'comparisonId'in e?e.comparisonId:null)).size,1);
  console.log('PASS exact captured cell identity, invalid/unavailable input distinction, versioned neutral cohort and current manual overrides');

  const paging=await fixture('=SUM(1,2) quoted "prompt"');await seed(paging,[...Array.from({length:53},(_,i)=>({text:'Acme',system:String(i)})),{text:'Acme',side:'previous',system:'0'}]);
  const first=await get(paging);assert.equal(first.page.rows.length,50);assert.equal(first.totalRows,53);assert.ok(first.nextCursor);
  const second=await get(paging,{cursor:first.nextCursor!});assert.equal(second.page.rows.length,3);assert.equal(new Set([...first.page.rows,...second.page.rows].map(c=>c.id)).size,53);
  const exec=await get(paging,{view:'executions',period:'current'});assert.equal(exec.totalRows,53);const exec2=await get(paging,{view:'executions',period:'current',cursor:exec.nextCursor!});assert.equal(exec2.page.rows.length,3);
  for(const page of [first,second,exec,exec2]){manifest(page);assert.deepEqual(page.evidenceStates,first.evidenceStates);assert.equal(page.evidenceStates.length,54,'All selected evidence states survive cell and execution pagination.');}
  await assert.rejects(get(paging,{view:'executions',period:'current',cursor:first.nextCursor!}),fail(400));await assert.rejects(get(paging,{view:'cells',period:'current'}),fail(400));
  await assert.rejects(get(paging,{view:'executions',period:'previous',cellId:'f'.repeat(64)}),fail(409));
  const csv=await exp(paging,first);assert.equal(csv.rowCount,2+first.subjects.length+2*first.cellCount*first.subjects.length+first.current.coverage.attempted+first.previous.coverage.attempted);
  const csvRows=csv.body.trimEnd().split('\r\n').map(line=>{const cells=line.match(/"(?:[^"]|"")*"/g)!;assert.equal(cells.join(','),line);assert.equal(cells.length,45);return cells.map(c=>c.slice(1,-1).replaceAll('""','"'));});
  assert.equal(csvRows.length,csv.rowCount+1);assert.ok(csvRows.some(row=>row[0]==='cell'&&row[16]==='\'=SUM(1,2) quoted "prompt"'));assert.ok(!csvRows.some(row=>row.some(c=>/^[=+@-]/.test(c))));
  await pool.query("UPDATE project_prompt SET user_tags='[\"changed\"]' WHERE id=$1",[paging.prompt.id]);await assert.rejects(get(paging,{cursor:first.nextCursor!}),fail(409));await assert.rejects(exp(paging,first),fail(409));
  const before=await get(paging);await updateProjectContext(paging.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',name:'Gamma',aliases:[]}]});await assert.rejects(exp(paging,before),fail(409));
  await assert.rejects(exp(paging,await get(paging),AbortSignal.abort()),fail(499));
  console.log('PASS independent cell/execution pagination, revision-bound full rectangular formula-safe CSV, context/tag changes and abort');

  const retention=await fixture(),old=new Date(Date.now()-100*86400000).toISOString();const retained=await seed(retention,[{text:'Acme'},{text:'Acme',side:'previous'},{text:'Acme',completed:old},{status:'failed',completed:old}]);
  let rr=await get(retention);assert.equal(rr.current.coverage.expired,1);assert.equal(rr.current.coverage.no_answer,1);assert.equal(rr.cellCount,1);
  await pool.query('UPDATE prompt_execution_quote SET input=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1',[retained[0].id]);await assert.rejects(exp(retention,rr),fail(409));rr=await get(retention);assert.equal(rr.current.identityUnavailable,1);
  await pool.query('UPDATE prompt_execution SET result=NULL,result_purged_at=clock_timestamp() WHERE id=$1',[retained[1].id]);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[retention.workspace]);rr=await get(retention);assert.equal(rr.previous.coverage.expired,1);assert.equal(rr.current.identityUnavailable,1);
  manifest(rr);assert.equal(rr.evidenceStates.find(e=>e.id===retained[1].id)?.eligibility,'expired');assert.equal(rr.evidenceStates.find(e=>e.id===retained[0].id)?.identity,'unavailable');
  // A non-UTC database session crosses DST differently from elapsed policy days.
  const dst=await fixture(),probe=await pool.connect();let boundary:{days:number;completed:Date;expired:boolean};
  try{await probe.query('BEGIN');await probe.query("SET LOCAL TimeZone='America/New_York'");boundary=(await probe.query(`WITH c AS(SELECT d,transaction_timestamp()-make_interval(days=>d) civil,transaction_timestamp()-d*interval '24 hours' elapsed FROM generate_series(1,366)d)
    SELECT d days,elapsed+(civil-elapsed)/2 completed,civil<elapsed expired FROM c WHERE civil<>elapsed ORDER BY d LIMIT 1`)).rows[0];assert.ok(boundary);}finally{await probe.query('ROLLBACK');probe.release();}
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=$2 WHERE id=$1',[dst.workspace,boundary!.days]);await seed(dst,[{text:'Acme',completed:boundary!.completed.toISOString()},{text:'Acme',side:'previous'}]);
  const connect=pool.connect.bind(pool);let dstReads=0;pool.connect=(async(...args:any[])=>{if(args.length)return (connect as any)(...args);const c=await connect(),query=c.query.bind(c),release=c.release.bind(c);
   c.query=(async(...a:any[])=>{const v=await (query as any)(...a);if(String(a[0]).startsWith('BEGIN')){await query("SET LOCAL TimeZone='America/New_York'");dstReads++;}return v;})as typeof c.query;
   c.release=((...a:any[])=>{c.query=query;return(release as any)(...a);})as typeof c.release;return c;})as typeof pool.connect;
  try{const d=await get(dst);assert.equal(dstReads,1);assert.equal(d.current.coverage.expired,Number(boundary!.expired));assert.equal(d.current.usable,Number(!boundary!.expired));}finally{pool.connect=connect;}
  console.log('PASS fresh answer/input retention, irrevocable tombstones after extension, exact elapsed24h policy under DST sessions');

  const zones=await fixture();await seed(zones,[{text:'Acme',at:'2025-11-02T04:30:00Z'},{text:'Acme',at:'2025-11-03T04:30:00Z'},{text:'Other',at:'2025-11-01T04:30:00Z'},
   {text:'Acme',at:'2025-03-09T07:30:00Z'},{text:'Other',at:'2025-03-08T07:30:00Z'},{text:'Acme',at:'2011-12-30T10:30:00Z'}]);
  const ny=await get(zones,{from:'2025-11-02',to:'2025-11-02',timeZone:'America/New_York'});assert.equal(ny.current.coverage.attempted,2);assert.equal(ny.previous.coverage.attempted,1);assert.equal(ny.previous.from,'2025-11-01');
  const spring=await get(zones,{from:'2025-03-09',to:'2025-03-09',timeZone:'America/New_York'});assert.equal(spring.current.coverage.attempted,1);assert.equal(spring.previous.coverage.attempted,1);
  const apia=await get(zones,{from:'2011-12-31',to:'2011-12-31',timeZone:'Pacific/Apia'});assert.equal(apia.current.coverage.attempted,1);assert.equal(apia.previous.from,'2011-12-30');assert.equal(apia.previous.coverage.attempted,0);assert.equal(apia.status,'no_previous');
  const month=await get(zones,{from:'2025-03-01',to:'2025-03-31'});assert.equal(month.previous.from,'2025-01-29');assert.equal(month.previous.to,'2025-02-28');
  const epoch=await fixture();await seed(epoch,[{text:'Acme',at:'1970-01-01T12:00:00Z'},{text:'Other',at:'1969-12-31T12:00:00Z'}]);const er=await get(epoch,{from:'1970-01-01',to:'1970-01-01'});assert.equal(er.previous.from,'1969-12-31');assert.equal(er.previous.coverage.attempted,1);assert.equal(er.status,'comparable');
  await assert.rejects(get(zones,{from:'0001-01-01',to:'0001-01-01'}),fail(400));await assert.rejects(get(zones,{from:'2025-01-01',to:'2025-02-01'}),fail(400));await assert.rejects(get(zones,{timeZone:'Invalid/Zone'}),fail(400));
  console.log('PASS adjacent local-date windows across 23/25-hour and skipped days, 31-day limit and lower-year boundary');

  const snapshot=await fixture();await seed(snapshot,[{text:'Acme'},{text:'Acme',side:'previous'}]);let release!:()=>void,admit!:()=>void,taken=false;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>admit=r),originalConnect=pool.connect.bind(pool);
  pool.connect=(async(...args:any[])=>{if(args.length)return(originalConnect as any)(...args);const c=await originalConnect();if(!taken){taken=true;const query=c.query.bind(c),done=c.release.bind(c);c.query=(async(...a:any[])=>{if(String(a[0]).startsWith('SELECT revision,brand_name')){admit();await gate;}return(query as any)(...a);})as typeof c.query;c.release=((...a:any[])=>{c.query=query;return(done as any)(...a);})as typeof c.release;}return c;})as typeof pool.connect;
  try{const pending=get(snapshot,{},viewer);await entered;await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[snapshot.workspace,viewer]);await pool.query("UPDATE project_context SET brand_name='Gamma',revision=revision+1 WHERE project_id=$1",[snapshot.project]);release();const read=await pending;assert.equal(read.role,'viewer');assert.equal(read.subjects[0].name,'Acme');assert.equal(read.status,'comparable');}finally{release();pool.connect=originalConnect;}
  await assert.rejects(get(snapshot,{},viewer),fail(404));
  const countCap=await fixture();await seed(countCap,Array.from({length:1001},(_,i)=>({status:'failed',side:i%2?'previous':'current'})));await assert.rejects(get(countCap),fail(413));
  const inputCap=await fixture();await seed(inputCap,Array.from({length:900},()=>({status:'failed',system:'😀'.repeat(2000)})));await assert.rejects(get(inputCap),fail(413));
  const answerCap=await fixture();await seed(answerCap,Array.from({length:44},(_,i)=>({text:'x'.repeat(245000),side:i%2?'previous':'current'})));await assert.rejects(get(answerCap),fail(413));
  const cpu=await fixture();await updateProjectContext(cpu.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'profile',aliases:Array.from({length:20},(_,i)=>'term '+i)}]});await seed(cpu,Array.from({length:21},()=>({text:'x'.repeat(245000)})));await assert.rejects(get(cpu),fail(413));
  console.log('PASS repeatable-read admission with concurrent role/context change, whole-union execution/input/answer/work limits without sampling');

  const login=await getAuth().api.signInEmail({body:{email:`${viewer}@comparison.integration.test`,password},asResponse:true});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),headers={cookie,origin:config.appUrl,'content-type':'application/json'};
  const address=config.appUrl+`/api/projects/${f.project}/prompt-insights/comparison`,response=await handleApi(new Request(address+'?'+params(),{headers}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const read=await response.json(),body=JSON.stringify({...read.filters,expectedSelectionRevision:read.selectionRevision});const download=await handleApi(new Request(address+'/export',{method:'POST',headers,body}));assert.equal(download.status,200);assert.match(download.headers.get('content-type')!,/^text\/csv/);assert.equal(Number(download.headers.get('x-export-row-count')),2+read.subjects.length+2*read.cellCount*read.subjects.length+5);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers:{...headers,origin:'https://foreign.example'},body}))).status,403);
  assert.equal((await handleApi(new Request(address,{method:'DELETE',headers}))).status,405);assert.equal((await handleApi(new Request(address+'/export?q=1',{method:'POST',headers,body}))).status,400);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers,body:'x'.repeat(4097)}))).status,413);
  const key=await createApiKey(f.workspace,owner,{name:'Comparison exclusion',scopes:['analytics:read'],expiresInDays:1});assert.equal((await handleApi(new Request(address,{headers:{authorization:'Bearer '+key.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,viewer]);assert.equal((await handleApi(new Request(address,{headers}))).status,404);assert.equal(outbound,0);
  console.log('PASS actual member GET/export, Origin/method/body/API-key controls, access revocation and zero outbound calls');
 }finally{try{await closeDatabase();}finally{globalThis.fetch=originalFetch;}}
}
if(process.env.TEN98_PROMPT_INSIGHTS_COMPARISON_TEST==='1')runPromptComparisonChecks().catch(e=>{console.error(e);process.exitCode=1;});
