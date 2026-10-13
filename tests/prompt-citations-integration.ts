import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {getPromptInsights} from '../src/server/prompt-insights.ts';
import {getPromptCitations,exportPromptCitations,type CitationReport} from '../src/server/prompt-citations.ts';
import {handleApi} from '../src/server/api.ts';
import {getAuth} from '../src/server/auth.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {validCitationReport} from '../src/lib/citation-report.ts';

const fail=(status:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===status;
const model='openai/gpt-4o-mini';
const citation=(url:string,title:string|null=null)=>({url,title});
const answer=(citations:{url:string;title:string|null}[]=[],text='Retained answer.',finishReason='stop')=>({text,resolvedModel:model,provider:'OpenAI',finishReason,citations,promptTokens:1,completionTokens:1,receivedAt:new Date().toISOString()});
type Sample={result?:unknown;status?:string;at?:string;completed?:string|null;purged?:boolean};
function csv(body:string){const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<body.length;i++){const c=body[i];if(c==='"'){if(quoted&&body[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.endsWith('\r')?cell.slice(0,-1):cell);rows.push(row);row=[];cell='';}else cell+=c;}
 assert.equal(quoted,false);assert.equal(row.length,0);assert.equal(cell,'');return rows;
}
export async function runPromptCitationChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROMPT_CITATIONS_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_prompt_citations_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_prompt_citations_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('No outbound requests are permitted in citation tests.');};
 const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomUUID()+randomUUID();
 const date=(days:number)=>new Date(Date.now()-days*86400000).toISOString().slice(0,10),current=date(1),previous=date(2),stamp=(day:string)=>day+'T12:00:00Z';
 const params=(extra:Record<string,string>={})=>new URLSearchParams({from:current,to:current,timeZone:'UTC',...extra});
 for(const user of [owner,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Citation fixture\',$2)',[user,`${user}@citations.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
 async function fixture(){const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Citation fixture')",[workspace]);
  for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Acme','https://acme.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','Read only; no credentials')",[connection,workspace]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Which product?',tags:['original'],enabled:false}]})).items[0];
  const context=await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme'},{kind:'competitor',primaryDomain:'beta.com',name:'Beta'}]});
  return {workspace,project,connection,prompt,competitor:context.competitors[0].id as string};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function seed(f:Fixture,samples:Sample[]){const data=samples.map(s=>({id:randomUUID(),at:s.at??stamp(current),completed:s.completed===undefined?new Date().toISOString():s.completed,result:s.result??null,status:s.status??'completed',purged:s.purged??false}));
  const payload=JSON.stringify(data),columns='id uuid,at timestamptz,completed timestamptz,result jsonb,status text,purged boolean';
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
   SELECT id,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),'{}','[]','[]',repeat('c',64),clock_timestamp()+interval '5 minutes' FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner,f.prompt.id,f.prompt.currentVersionId,f.connection]);
  await pool.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) SELECT id,id,$2,$3,$4,id,at FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
   SELECT id,$2,$3,1,$4,id,'synthetic.citation',repeat('d',64),1,CASE WHEN status='uncertain' THEN 'uncertain' ELSE 'settled' END,current_date FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.connection,owner]);
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at,result_purged_at)
   SELECT id,id,$2,$3,0,jsonb_build_object('model',$4::text),status,result,completed,CASE WHEN purged THEN clock_timestamp() END FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,model]);return data;
 }
 const get=async(f:Fixture,extra:Record<string,string>={},user=owner)=>{
  const report=await getPromptCitations(f.project,user,params(extra));
  const page=extra.cursor?JSON.parse(Buffer.from(extra.cursor,'base64url').toString('utf8')).offset/50:0;
  assert.ok(validCitationReport(report,report.filters,report.navigation,page),'Actual service report must satisfy the independently authored client boundary.');
  return report;
 };
 const download=(f:Fixture,r:CitationReport,user=viewer,signal?:AbortSignal)=>exportPromptCitations(f.project,user,{...r.filters,expectedSelectionRevision:r.selectionRevision},signal);
 function manifest(r:CitationReport){assert.equal(r.evidenceStates.length,r.current.coverage.attempted+r.previous.coverage.attempted);assert.equal(new Set(r.evidenceStates.map(e=>e.id)).size,r.evidenceStates.length);
  for(const e of r.evidenceStates)assert.deepEqual(Object.keys(e).sort(),['eligibility','id','period']);
  for(const side of ['current','previous'] as const)for(const [key,n]of Object.entries(r[side].coverage))if(key!=='attempted')assert.equal(r.evidenceStates.filter(e=>e.period===side&&e.eligibility===key).length,n);
  if(r.page.kind==='evidence')for(const e of r.page.rows)assert.deepEqual(r.evidenceStates.find(s=>s.id===e.executionId),{id:e.executionId,period:e.period,eligibility:'eligible'});
 }
 try{
  const f=await fixture();const records=await seed(f,[{at:stamp(previous),result:answer([citation('https://news.acme.com/a#one'),citation('https://news.acme.com/a#two'),citation('https://news.acme.com/b'),citation('https://news.acme.com/b'),citation('https://news.acme.com/title','Before')])},
   {result:answer([citation('https://news.acme.com/a#three'),citation('https://beta.com/new'),citation('https://beta.com/new'),citation('https://news.acme.com/title','After')]),status:'uncertain'}, {result:answer()}]);
  const r=await get(f,{},viewer);manifest(r);assert.equal(r.role,'viewer');assert.equal(r.current.eligibleAnswers,2);assert.equal(r.current.citedExecutions,1);assert.equal(r.current.annotations,4);assert.equal(r.current.uniqueUrls,3);assert.equal(r.previous.annotations,5);assert.equal(r.changes.status,'ready');
  assert.equal(r.page.kind,'urls');if(r.page.kind!=='urls')throw Error('Expected URL page');const newUrl=r.page.rows.find(v=>v.url==='https://beta.com/new')!;assert.deepEqual(newUrl.current.count,{executions:1,annotations:2,prompts:1});
  const domains=await get(f,{view:'domains'});assert.equal(domains.page.kind,'domains');if(domains.page.kind!=='domains')throw Error('Expected domain page');assert.deepEqual(domains.page.rows.find(v=>v.hostname==='news.acme.com')!.previous.count,{executions:1,annotations:5,prompts:1});
  const changes=await get(f,{view:'changes'});assert.equal(changes.page.kind,'changes');if(changes.page.kind!=='changes')throw Error('Expected changes');assert.ok(changes.page.rows.some(c=>c.kind==='newly_observed'&&c.label==='https://beta.com/new'));assert.ok(changes.page.rows.some(c=>c.kind==='fewer_citations'&&c.label==='https://news.acme.com/a'));assert.ok(changes.page.rows.some(c=>c.kind==='not_observed_now'&&c.label==='https://news.acme.com/b'));assert.ok(changes.page.rows.some(c=>c.kind==='annotation_title_changed'&&c.before?.retainedTitle==='Before'&&c.after?.retainedTitle==='After'));
  const evidence=await get(f,{view:'evidence'});manifest(evidence);assert.equal(evidence.page.kind,'evidence');if(evidence.page.kind!=='evidence')throw Error('Expected evidence');assert.deepEqual(evidence.page.rows.map(e=>e.retainedCitationIndex),[0,1,2,3]);assert.equal(evidence.page.rows[0].retainedUrl,'https://news.acme.com/a#three');assert.equal(evidence.page.rows[0].executionId,records[1].id);
  console.log('PASS distinct answer/domain unions, duplicate annotations, immutable retained order and all four descriptive change kinds');

  const filtered=await get(f,{query:'BETA.COM',view:'evidence'});manifest(filtered);assert.deepEqual(filtered.current.coverage,r.current.coverage);assert.deepEqual(filtered.evidenceStates,r.evidenceStates);assert.equal(filtered.current.annotations,2);assert.equal(filtered.current.eligibleAnswers,2);assert.equal(filtered.previous.annotations,0);assert.equal(filtered.daily.find(d=>d.date===current)!.summary.annotations,2);
  assert.equal(filtered.axes.current.ownership.find(a=>a.key==='competitor')!.count.annotations,2);assert.equal((await get(f,{entityId:f.competitor,ownership:'brand'})).current.annotations,0);
  const groups=await fixture();await seed(groups,[{result:answer([citation('https://www.acme.com/path/?utm_source=openai&q=a%20b#part','C++ 100% _literal_'),citation('https://acme.com/path?q=a+b#part','Other'),citation('https://acme.com/path?q=a+b#different','Third')])}]);
  const conservative=await get(groups),baseline=await get(groups,{urlGrouping:'elmo-url-v1'});assert.equal(conservative.current.uniqueUrls,2);assert.equal(baseline.current.uniqueUrls,2);assert.equal((await get(groups,{query:'C++'})).current.annotations,1);assert.equal((await get(groups,{query:'100% _literal_'})).current.annotations,1);assert.equal((await get(groups,{query:'does-not-exist'})).current.citedExecutions,0);
  const filteredCsv=csv((await download(f,filtered)).body);assert.equal(filteredCsv.length-1,3+filtered.daily.length+filtered.current.annotations+filtered.previous.annotations);assert.ok(filteredCsv.filter(row=>row[0]==='evidence').every(row=>row[22].includes('beta.com')));
  const invalidFilters:Record<string,string>[]=[{query:'x'.repeat(201)},{query:'\n'},{publisherCategory:'brand'},{entityId:randomUUID()},{view:'urls',period:'current'},{view:'evidence',urlId:'not-a-hash'},{matcher:'unicode-boundary-v1'}];
  for(const invalid of invalidFilters)await assert.rejects(get(f,invalid),fail(400));
  console.log('PASS applied literal/source filters reconcile charts, evidence and CSV while full answer denominator/manifest remain unchanged');

  const sources=await fixture();await seed(sources,[{result:answer([citation('https://www.google.com/search?q=topic'),citation('https://www.google.com/search?q=product&udm=28','Product'),citation('https://www.google.com/goto?url=opaque'),citation('https://google.evil.com/search?q=topic'),citation('https://localhost/private'),citation('https://en.wikipedia.org/wiki/Topic')])}]);
  const sr=await get(sources,{view:'evidence'});assert.equal(sr.current.annotations,6);assert.equal(sr.current.unclassifiedHostAnnotations,1);assert.equal(sr.page.kind,'evidence');if(sr.page.kind!=='evidence')throw Error('Expected evidence');
  assert.deepEqual(sr.page.rows.map(e=>e.classification.sourceType),['google_search','google_shopping','google_wrapper','publisher','unclassified','publisher']);assert.equal(sr.page.rows[4].trackable,false);assert.equal(sr.page.rows[4].classification.publisherBasis,'unclassified');
  const wrapper=await get(sources,{sourceType:'google_wrapper'});assert.equal(wrapper.current.annotations,1);assert.equal(wrapper.current.eligibleAnswers,1);
  const wiki=sr.page.rows[5];assert.equal(wiki.classification.publisherCategory,'reference');await updateProjectContext(sources.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'citation-category',domain:'en.wikipedia.org',category:'ecommerce'}]});
  const over=await get(sources,{view:'evidence'});assert.equal(over.page.kind,'evidence');if(over.page.kind!=='evidence')throw Error('Expected evidence');const after=over.page.rows.find(e=>e.hostname==='en.wikipedia.org')!;assert.equal(after.classification.publisherCategory,'ecommerce');assert.equal(after.classification.automaticPublisherCategory,'reference');assert.equal(after.classification.pageType,wiki.classification.pageType);await assert.rejects(download(sources,sr),fail(409));
  await updateProjectContext(sources.project,owner,{requestId:randomUUID(),revision:3,updates:[{kind:'citation-category',domain:'en.wikipedia.org',category:null}]});assert.equal((await get(sources,{publisherCategory:'reference'})).current.annotations,1);
  console.log('PASS all Google surfaces retained without dereference, spoofed/private hosts, and exact publisher override/reset independent of page type');

  const ownershipCase=await fixture();await seed(ownershipCase,[{result:answer([citation('https://beta.com/a')])}]);const before=await get(ownershipCase);
  await updateProjectContext(ownershipCase.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'citation-brand-domain',domain:'beta.com',action:'add'}]});
  const overlapping=await get(ownershipCase,{view:'evidence'});assert.equal(overlapping.page.kind,'evidence');if(overlapping.page.kind!=='evidence')throw Error('Expected evidence');assert.deepEqual(overlapping.page.rows[0].classification.ownership,{brand:true,competitorIds:[ownershipCase.competitor],ambiguous:true});assert.equal((await get(ownershipCase,{entityId:'brand'})).current.annotations,1);assert.equal((await get(ownershipCase,{entityId:ownershipCase.competitor})).current.annotations,1);
  const ordinary=await getPromptInsights(ownershipCase.project,viewer,params());assert.equal(ordinary.metrics.find(m=>m.id==='brand')!.citations,1);await assert.rejects(download(ownershipCase,before),fail(409));
  await assert.rejects(updateProjectContext(ownershipCase.project,viewer,{requestId:randomUUID(),revision:3,updates:[{kind:'citation-brand-domain',domain:'example.net',action:'add'}]}),fail(404));
  const noAnswers=await fixture();assert.equal((await get(noAnswers)).current.eligibleAnswers,null);const zero=await fixture();await seed(zero,[{result:answer()}]);assert.equal((await get(zero)).current.eligibleAnswers,1);assert.equal((await get(zero)).current.annotations,0);
  console.log('PASS current identity recomputation, multiple ownership matches, ordinary insight consistency and zero versus unavailable');

  const paging=await fixture();await seed(paging,[{result:answer(Array.from({length:53},(_,i)=>citation(`https://acme.com/page-${i}`,i===0?'=SUM(1,2)\n"quoted"':null)))}]);
  const first=await get(paging,{view:'evidence'});manifest(first);assert.equal(first.page.rows.length,50);assert.ok(first.nextCursor);const second=await get(paging,{view:'evidence',cursor:first.nextCursor!});manifest(second);assert.equal(second.page.rows.length,3);assert.deepEqual(first.evidenceStates,second.evidenceStates);
  const exportRows=csv((await download(paging,first)).body);assert.ok(exportRows.every(row=>row.length===29));assert.equal(exportRows.length-1,3+first.daily.length+53);assert.equal(exportRows.find(row=>row[0]==='evidence')![21],'0');assert.match(exportRows.find(row=>row[23].includes('SUM'))![23],/^'/);
  await assert.rejects(get(paging,{view:'urls',cursor:first.nextCursor!}),fail(400));await assert.rejects(get(paging,{view:'evidence',query:'page-1',cursor:first.nextCursor!}),fail(400));
  await pool.query('UPDATE prompt_execution SET result_purged_at=clock_timestamp(),result=NULL WHERE project_id=$1',[paging.project]);await assert.rejects(get(paging,{view:'evidence',cursor:first.nextCursor!}),fail(409));await assert.rejects(download(paging,first),fail(409));
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[paging.workspace]);const purged=await get(paging);manifest(purged);assert.equal(purged.current.coverage.expired,1);assert.equal(purged.current.annotations,0);assert.equal(purged.evidenceStates[0].eligibility,'expired');
  const old=await fixture();await seed(old,[{result:answer([citation('https://acme.com/expired')]),completed:new Date(Date.now()-100*86400000).toISOString()}]);assert.equal((await get(old)).current.coverage.expired,1);
  await assert.rejects(download(f,await get(f),viewer,AbortSignal.abort()),fail(499));
  console.log('PASS full-manifest pagination, rectangular formula-safe CSV, revision binding and irreversible raw-evidence expiry');

  const coverageCase=await fixture();await seed(coverageCase,[...Array.from({length:9},()=>({result:answer([citation('https://acme.com/a')])})),{status:'reconciled'},...Array.from({length:9},()=>({at:stamp(previous),result:answer([citation('https://acme.com/a')])})),{at:stamp(previous),status:'reconciled'}]);
  assert.equal((await get(coverageCase)).changes.status,'ready');await seed(coverageCase,[{status:'reconciled'}]);const incomplete=await get(coverageCase,{view:'changes'});assert.equal(incomplete.changes.status,'incomplete');assert.equal(incomplete.page.rows.length,0);assert.equal(incomplete.current.annotations,9);
  const open=await fixture();await seed(open,[{at:stamp(date(0)),result:answer([citation('https://acme.com/a')])},{result:answer([citation('https://acme.com/a')])}]);assert.equal((await get(open,{from:date(0),to:date(0)})).changes.status,'in_progress');
  const zones=await fixture();await seed(zones,[{at:'2025-11-02T04:30:00Z',result:answer([citation('https://acme.com/one')])},{at:'2025-11-03T04:30:00Z',result:answer([citation('https://acme.com/two')])},{at:'2011-12-30T10:30:00Z',result:answer([citation('https://acme.com/apia')])}]);
  const ny=await get(zones,{from:'2025-11-02',to:'2025-11-02',timeZone:'America/New_York'});assert.equal(ny.current.coverage.eligible,2);const apia=await get(zones,{from:'2011-12-31',to:'2011-12-31',timeZone:'Pacific/Apia'});assert.equal(apia.current.coverage.eligible,1);assert.equal(apia.previous.coverage.attempted,0);
  console.log('PASS exact90% coverage boundary, open-period suppression and observed local dates including DST/skipped day');

  const countLimit=await fixture();await seed(countLimit,Array.from({length:1001},(_,i)=>({at:stamp(i<500?current:previous),status:'reconciled'})));await assert.rejects(get(countLimit),fail(413));
  const byteLimit=await fixture();await seed(byteLimit,Array.from({length:45},(_,i)=>({at:stamp(i%2?current:previous),result:answer([],'x'.repeat(245000))})));await assert.rejects(get(byteLimit),fail(413));
  const capacity=await fixture();await seed(capacity,Array.from({length:1000},()=>({result:answer(Array.from({length:100},()=>citation('https://acme.com/a')))})));const started=performance.now(),full=await get(capacity,{view:'evidence'});assert.equal(full.current.annotations,100000);assert.equal(full.current.citedExecutions,1000);assert.equal(full.evidenceStates.length,1000);assert.equal(full.page.rows.length,50);assert.equal(full.totalRows,100000);await assert.rejects(download(capacity,full),fail(413));
  console.log(`PASS combined execution/byte caps, complete100k-annotation selection (${Math.round(performance.now()-started)}ms including capped export), no sampling`);

  await assert.rejects(get(f,{},foreign),fail(404));const other=await fixture();await assert.rejects(get(f,{promptId:other.prompt.id}),fail(404));
  const auth=await getAuth().api.signInEmail({body:{email:`${viewer}@citations.integration.test`,password},asResponse:true});assert.equal(auth.status,200);const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const address=config.appUrl+`/api/projects/${f.project}/prompt-insights/citations`,headers={cookie,origin:config.appUrl,'content-type':'application/json'};
  const http=await handleApi(new Request(address+'?'+params(),{headers}));assert.equal(http.status,200);assert.equal(http.headers.get('cache-control'),'no-store');const report=await http.json(),body=JSON.stringify({...report.filters,expectedSelectionRevision:report.selectionRevision});
  const exported=await handleApi(new Request(address+'/export',{method:'POST',headers,body}));assert.equal(exported.status,200);assert.match(exported.headers.get('content-type')!,/^text\/csv/);assert.equal(Number(exported.headers.get('x-export-row-count')),csv(await exported.text()).length-1);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers:{...headers,origin:'https://foreign.example'},body}))).status,403);assert.equal((await handleApi(new Request(address,{method:'DELETE',headers}))).status,405);assert.equal((await handleApi(new Request(address+'/export?x=1',{method:'POST',headers,body}))).status,400);assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers,body:'x'.repeat(4097)}))).status,413);
  const key=await createApiKey(f.workspace,owner,{name:'Synthetic citations exclusion',scopes:['analytics:read'],expiresInDays:1});assert.equal((await handleApi(new Request(address,{headers:{authorization:'Bearer '+key.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,viewer]);assert.equal((await handleApi(new Request(address,{headers}))).status,404);assert.equal(outbound,0);
  console.log('PASS actual member-read/export API, tenant/session/Origin/body/method/API-key boundaries and zero provider traffic');
 }finally{await closeDatabase();globalThis.fetch=original;}
}
if(process.env.TEN98_PROMPT_CITATIONS_TEST==='1')runPromptCitationChecks().catch(e=>{console.error(e);process.exitCode=1;});
