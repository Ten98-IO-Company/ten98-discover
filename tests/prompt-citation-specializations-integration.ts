import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {createPrompts,updatePrompt} from '../src/server/prompts.ts';
import {updateProjectContext} from '../src/server/project-context.ts';
import {getPromptCitationSpecializations,exportPromptCitationSpecializations,type SpecializedReport} from '../src/server/prompt-citation-specializations.ts';
import {handleApi} from '../src/server/api.ts';
import {getAuth} from '../src/server/auth.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {validSpecializedCitationFilters,validSpecializedCitationNavigation,validSpecializedCitationReport} from '../src/lib/citation-specialized-report.ts';

const fail=(status:number)=>(e:unknown)=>!!e&&typeof e==='object'&&'status'in e&&e.status===status;
const model='openai/gpt-4o-mini',citation=(url:string,title:string|null=null)=>({url,title});
const answer=(citations:{url:string;title:string|null}[]=[])=>({text:'Retained answer.',resolvedModel:model,provider:'OpenAI',finishReason:'stop',citations,promptTokens:1,completionTokens:1,receivedAt:new Date().toISOString()});
type Sample={result?:unknown;status?:string;at?:string;purged?:boolean};
function csv(body:string){const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<body.length;i++){const c=body[i];if(c==='"'){if(quoted&&body[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.endsWith('\r')?cell.slice(0,-1):cell);rows.push(row);row=[];cell='';}else cell+=c;}
 assert.equal(quoted,false);assert.equal(row.length,0);assert.equal(cell,'');return rows;
}
function manifest(r:SpecializedReport){assert.equal(r.evidenceStates.length,r.current.coverage.attempted+r.previous.coverage.attempted);assert.equal(new Set(r.evidenceStates.map(e=>e.id)).size,r.evidenceStates.length);
 for(const e of r.evidenceStates)assert.deepEqual(Object.keys(e).sort(),['eligibility','id','period']);
 for(const period of ['current','previous'] as const)for(const [key,n]of Object.entries(r[period].coverage))if(key!=='attempted')assert.equal(r.evidenceStates.filter(e=>e.period===period&&e.eligibility===key).length,n);
 if(r.page.kind==='evidence')for(const e of r.page.rows)assert.deepEqual(r.evidenceStates.find(s=>s.id===e.executionId),{id:e.executionId,period:e.period,eligibility:'eligible'});
}
export async function runSpecializedCitationChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROMPT_CITATION_SPECIALIZATIONS_TEST,'1');
 const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
 const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_prompt_citation_specializations_ci';
 assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_prompt_citation_specializations_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty owned fixture.');
 const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('No outbound requests are permitted in specialized citation tests.');};
 const owner=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomUUID()+randomUUID();
 const day=(ago:number)=>new Date(Date.now()-ago*86400000).toISOString().slice(0,10),current=day(1),previous=day(2),stamp=(date:string)=>date+'T12:00:00Z';
 const params=(extra:Record<string,string>={})=>new URLSearchParams({from:current,to:current,timeZone:'UTC',...extra});
 for(const user of [owner,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Specialized fixture\',$2)',[user,`${user}@specializations.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);
 async function fixture(){const workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Specialized fixture')",[workspace]);
  for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Acme','https://brand.example.com',$3,'infinity')",[project,workspace,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','Synthetic read only')",[connection,workspace]);
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Which product?',tags:['original'],enabled:false}]})).items[0];
  const context=await updateProjectContext(project,owner,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Acme'},{kind:'citation-brand-domain',domain:'shared.example.com',action:'add'},{kind:'competitor',primaryDomain:'rival.example.com',name:'Rival Tools',domains:['rival.example.com','shared.example.com']},{kind:'competitor',primaryDomain:'nameless.example.com',aliases:['GhostAlias']}]});
  return {workspace,project,connection,prompt,c1:context.competitors.find(c=>c.primaryDomain==='rival.example.com')!.id,c2:context.competitors.find(c=>c.primaryDomain==='nameless.example.com')!.id};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function withPrompt(f:Fixture,text:string){return {...f,prompt:(await createPrompts(f.project,owner,{requestId:randomUUID(),prompts:[{text,enabled:false}]})).items[0]};}
 async function seed(f:Fixture,samples:Sample[]){const data=samples.map(s=>({id:randomUUID(),at:s.at??stamp(current),result:s.result??null,status:s.status??'completed',purged:s.purged??false})),payload=JSON.stringify(data),columns='id uuid,at timestamptz,result jsonb,status text,purged boolean';
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
   SELECT id,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),'{}','[]','[]',repeat('c',64),clock_timestamp()+interval '5 minutes' FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner,f.prompt.id,f.prompt.currentVersionId,f.connection]);
  await pool.query(`INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) SELECT id,id,$2,$3,$4,id,at FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,owner]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month) SELECT id,$2,$3,1,$4,id,'synthetic.specialized',repeat('d',64),1,'settled',current_date FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.connection,owner]);
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at,result_purged_at)
   SELECT id,id,$2,$3,0,jsonb_build_object('model',$4::text),status,result,clock_timestamp(),CASE WHEN purged THEN clock_timestamp() END FROM jsonb_to_recordset($1::jsonb) AS x(${columns})`,[payload,f.workspace,f.project,model]);return data;
 }
 const cursorPages=new Map<string,number>(),validatedViews=new Set<string>();let validatedReports=0;
 function agreement(report:unknown,extra:Record<string,string>={}){
  const filters:Record<string,string|null>={from:current,to:current,timeZone:'UTC',model:null,promptId:null,tag:null,urlGrouping:'retained-fragment-v1',query:null,publisherCategory:null,pageType:null,sourceType:null,ownership:null,entityId:null,productAttribution:null};
  for(const key of Object.keys(filters))if(Object.hasOwn(extra,key))filters[key]=extra[key];
  const view=extra.view??'reddit',navigation={view,period:extra.period??(view==='gaps'?'current':null),groupId:extra.groupId??null,gapPromptId:extra.gapPromptId??null,evidenceMode:extra.evidenceMode??null};
  assert.ok(validSpecializedCitationFilters(filters));assert.ok(validSpecializedCitationNavigation(navigation));
  const page=extra.cursor?cursorPages.get(extra.cursor):0;assert.notEqual(page,undefined,'Only a previously returned next cursor may advance this fixture.');
  assert.ok(validSpecializedCitationReport(report,filters,navigation,page!),`Actual service DTO rejected by client boundary: ${JSON.stringify(extra)}`);
  if(report.nextCursor)cursorPages.set(report.nextCursor,page!+1);
  manifest(report);validatedViews.add(view);validatedReports++;
 }
 const get=async(f:Fixture,extra:Record<string,string>={},user=owner)=>{const r=await getPromptCitationSpecializations(f.project,user,params(extra));agreement(r,extra);return r;};
 const download=(f:Fixture,r:SpecializedReport,user=viewer,signal?:AbortSignal)=>exportPromptCitationSpecializations(f.project,user,{...r.filters,expectedSelectionRevision:r.selectionRevision},signal);
 try {
  const f=await fixture(),[b,c,d,e,no]=await Promise.all(['Prompt B','Prompt C','Prompt D','Prompt E','Prompt F'].map(text=>withPrompt(f,text)));
  await seed(f,[{result:answer([citation('https://rival.example.com/a'),citation('https://rival.example.com/a')])},{result:answer([citation('https://brand.example.com/a','Only-brand-title')])}]);
  await seed(b,[{result:answer([citation('https://rival.example.com/b','Rival evidence')])},{result:answer()}]);
  await seed(c,[{result:answer([citation('https://rival.example.com/c')])},{result:answer([citation('https://brand.example.com/expired','PRIVATE EXPIRED TITLE')]),purged:true}]);
  await seed(d,[{result:answer([citation('https://shared.example.com/d')])}]);await seed(e,[{result:answer([citation('https://rival.example.com/e'),citation('https://nameless.example.com/e','Nameless-only evidence')])}]);await seed(no,[{status:'reconciled'}]);
  const all=await get(f,{view:'gaps'},viewer);assert.equal(all.role,'viewer');assert.equal(all.current.coverage.attempted,9);assert.equal(all.current.coverage.eligible,7);assert.equal(all.current.coverage.expired,1);assert.equal(all.current.coverage.no_answer,1);
  assert.deepEqual(all.current.gaps,{status:'ready',evaluatedPrompts:5,promptsWithCompetitor:5,observedCandidates:3,confirmedCandidates:2,matchingCandidates:3});assert.equal(all.page.kind,'gaps');if(all.page.kind!=='gaps')throw Error('Expected gap page');assert.equal(all.entities[0].id,'brand');assert.deepEqual(new Set(all.entities.slice(1).map(s=>s.id)),new Set([f.c1,f.c2]));
  assert.deepEqual(new Set(all.page.rows.map(r=>r.promptId)),new Set([b.prompt.id,c.prompt.id,e.prompt.id]));assert.equal(all.page.rows.find(r=>r.promptId===c.prompt.id)!.status,'incomplete_evidence');
  const filtered=await get(f,{view:'gaps',query:'Nameless-only'});assert.equal(filtered.totalRows,1);assert.equal(filtered.page.kind,'gaps');if(filtered.page.kind!=='gaps')throw Error('Expected gaps');
  assert.deepEqual(filtered.current.coverage,all.current.coverage);assert.deepEqual(filtered.evidenceStates,all.evidenceStates);assert.deepEqual(filtered.current.gaps,{...all.current.gaps,matchingCandidates:1});
  assert.deepEqual(filtered.page.rows[0].competitorCount,{annotations:2,executions:1,prompts:1});assert.deepEqual(filtered.page.rows[0].matchingCompetitorCount,{annotations:1,executions:1,prompts:1});assert.deepEqual(new Set(filtered.page.rows[0].competitorIds),new Set([f.c1,f.c2]));
  for(const extra of [{ownership:'competitor'},{publisherCategory:'other'},{pageType:'other'},{sourceType:'publisher'},{query:'Only-brand-title'}] as Record<string,string>[]){const report=await get(f,{view:'gaps',...extra});assert.deepEqual({...report.current.gaps,matchingCandidates:3},all.current.gaps);assert.ok(report.page.kind==='gaps'&&!report.page.rows.some(g=>g.promptId===f.prompt.id||g.promptId===d.prompt.id));}
  assert.equal((await get(f,{view:'gaps',entityId:'brand'})).totalRows,0);assert.equal((await get(f,{view:'gaps',entityId:f.c2})).totalRows,1);assert.deepEqual((await get(f,{view:'gaps',productAttribution:'brand'})).current.gaps,all.current.gaps);
  const proof=await get(f,{view:'evidence',period:'current',evidenceMode:'gap_all',gapPromptId:e.prompt.id,query:'Nameless-only'});assert.equal(proof.page.kind,'evidence');assert.equal(proof.totalRows,2);assert.equal(JSON.stringify(proof).includes('PRIVATE EXPIRED TITLE'),false);
  console.log('PASS source-filter-independent gap predicates, duplicate counts, ambiguous owners, eligible zeros and incomplete evidence');

  const google=await fixture(),shopping='https://google.com/search?tbm=shop',productId='900719925474099312345';
  await seed(google,[{result:answer([citation(shopping,'Acme Rival Tools Kit'),citation(shopping,'Rival Tools Kit'),citation(shopping,'rival tools kit'),citation(shopping,'nameless.example.com Kit'),citation(shopping,'GhostAlias Kit'),citation(`https://google.com/search?prds=productid:${productId}`),citation(`https://google.com/search?prds=productid:${productId}`,'   '),citation(shopping)])},
   {result:answer([citation(shopping,'Product '+productId)])},{result:answer(['C%2B%2B','C++','first&q=second','%2520','product','%00'].map(q=>citation('https://google.com/search?q='+q)))},{result:answer([citation('https://google.com/goto?url=https://rival.example.com/a')])}]);
  const gr=await get(google,{view:'shopping'});assert.equal(gr.current.google.shopping.annotations,9);assert.equal(gr.current.google.labelledShopping.annotations,8);assert.equal(gr.current.google.unlabelledShopping.annotations,1);assert.equal(gr.totalRows,5);assert.equal(gr.page.kind,'shopping');if(gr.page.kind!=='shopping')throw Error('Expected products');
  assert.equal(gr.page.rows.find(g=>g.label==='nameless.example.com Kit')!.attribution.kind,'other');assert.equal(gr.page.rows.find(g=>g.label==='GhostAlias Kit')!.attribution.kind,'other');
  const idGroup=gr.page.rows.find(g=>g.label==='Product '+productId)!;assert.equal(idGroup.current.annotations,3);assert.equal(idGroup.current.executions,2);assert.equal(idGroup.labelBasis,'mixed');assert.equal(gr.page.rows.find(g=>g.label==='Acme Rival Tools Kit')!.attribution.kind,'brand');
  const competitorOnly=await get(google,{view:'shopping',productAttribution:'competitor'});assert.equal(competitorOnly.totalRows,1);assert.equal(competitorOnly.current.google.matchingProducts.annotations,2);assert.equal(competitorOnly.current.google.unlabelledShopping.annotations,1);
  const queries=await get(google,{view:'search'});assert.equal(queries.current.google.search.annotations,6);assert.equal(queries.current.google.unlabelledSearch.annotations,2);assert.equal(queries.page.kind,'search');assert.deepEqual(new Set(queries.page.rows.map(g=>'label'in g?g.label:null)),new Set(['C++','C','first','%20']));assert.deepEqual(queries.googleConsumerModule,{status:'not_recorded',reason:'consumer_surface_not_captured'});
  assert.equal((await get(google,{view:'evidence',period:'current',evidenceMode:'matching',groupId:gr.unresolvedEvidence.googleWrapperId})).totalRows,1);
  const nameless=(await pool.query('SELECT name FROM context_competitor WHERE id=$1',[google.c2])).rows[0];assert.equal(nameless.name,null);
  await updateProjectContext(google.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'competitor',primaryDomain:'nameless.example.com',name:'Nameless'}]});
  const renamed=await get(google,{view:'shopping'});assert.equal(renamed.page.kind,'shopping');if(renamed.page.kind!=='shopping')throw Error('Expected products');assert.equal(renamed.page.rows.find(g=>g.label==='nameless.example.com Kit')!.attribution.competitorId,google.c2);await assert.rejects(download(google,gr),fail(409));
  console.log('PASS source-compatible Google labels, exact long IDs, real names not domain/alias fallbacks, unresolved/query-only evidence and absent module capability');

  const reddit=await fixture();await seed(reddit,[{result:answer(['https://reddit.com/r/Tech/comments/a','https://reddit.com/r/Tech/comments/a','https://old.reddit.com/r/tech/comments/b','https://reddit.com/r/Other/comments/c','https://reddit.com/search?next=https://reddit.com/r/Fake','https://reddit.com/user/person?community=r/Hidden','https://reddit.com/r/Tech%2FFake/comments/a'].map(u=>citation(u)))},
   {at:stamp(previous),result:answer([citation('https://reddit.com/r/Tech/comments/a'),citation('https://reddit.com/r/Old/comments/a')])}]);
  const rr=await get(reddit);assert.deepEqual(rr.current.reddit,{all:{annotations:7,executions:1,prompts:1},community:{annotations:4,executions:1,prompts:1},ungrouped:{annotations:3,executions:1,prompts:1}});assert.equal(rr.totalRows,3);assert.equal(rr.page.kind,'reddit');if(rr.page.kind!=='reddit')throw Error('Expected Reddit');
  const tech=rr.page.rows.find(g=>g.communityKey==='r/tech')!;assert.equal(tech.current.annotations,3);assert.equal(tech.current.executions,1);assert.equal(tech.current.groupedPages,2);assert.equal(tech.currentNewPages,1);assert.equal(rr.page.rows.find(g=>g.communityKey==='r/old')!.previousNotObservedPages,1);
  assert.equal((await get(reddit,{view:'evidence',period:'current',evidenceMode:'matching',groupId:rr.unresolvedEvidence.redditCommunityId})).totalRows,3);
  const pages=await get(reddit,{view:'reddit_pages',period:'current',groupId:tech.id});assert.equal(pages.totalRows,2);const prompts=await get(reddit,{view:'prompts',period:'current',groupId:tech.id});assert.equal(prompts.totalRows,1);
  const evidence=await get(reddit,{view:'evidence',period:'current',groupId:tech.id,gapPromptId:reddit.prompt.id,evidenceMode:'matching'});assert.equal(evidence.totalRows,3);assert.equal(evidence.page.kind,'evidence');if(evidence.page.kind!=='evidence')throw Error('Expected evidence');assert.deepEqual(evidence.page.rows.map(r=>r.retainedCitationIndex),[0,1,2]);
  const combined={model,promptId:reddit.prompt.id,tag:'original',urlGrouping:'elmo-url-v1',timeZone:'Asia/Dubai',query:'comments'};
  const combinedReport=await get(reddit,combined);assert.equal(combinedReport.current.reddit.all.annotations,5);assert.equal(combinedReport.current.reddit.ungrouped.annotations,1);
  await get(reddit,{...combined,view:'reddit_pages',period:'previous',groupId:tech.id});
  await get(reddit,{...combined,view:'evidence',period:'previous',groupId:tech.id,evidenceMode:'matching'});
  for(const group of gr.page.rows){await get(google,{view:'prompts',period:'current',groupId:group.id});await get(google,{view:'evidence',period:'current',groupId:group.id,evidenceMode:'matching'});}
  for(const groupId of [gr.unresolvedEvidence.shoppingLabelId,gr.unresolvedEvidence.searchQueryId])await get(google,{view:'evidence',period:'current',groupId,evidenceMode:'matching'});
  console.log('PASS parsed Reddit paths, unresolved raw-query traps, unique pages, previous-only groups and exact evidence navigation');

  const open=await fixture();await seed(open,[{at:stamp(day(0)),result:answer([citation('https://rival.example.com/now')])}]);let opened=await get(open,{view:'gaps',from:day(0),to:day(0)});assert.ok(opened.page.kind==='gaps'&&opened.page.rows[0].status==='in_progress');assert.equal(opened.current.gaps.confirmedCandidates,0);
  await seed(open,[{at:stamp(day(0)),status:'reconciled'}]);opened=await get(open,{view:'gaps',from:day(0),to:day(0)});assert.ok(opened.page.kind==='gaps'&&opened.page.rows[0].status==='incomplete_evidence');
  const versioned=await fixture();await seed(versioned,[{at:current+'T10:00:00Z',result:answer([citation('https://rival.example.com/version'),citation('https://reddit.com/r/version/comments/a')])}]);const updated=await updatePrompt(versioned.project,owner,versioned.prompt.id,{requestId:randomUUID(),revision:1,text:'New immutable prompt'});await seed({...versioned,prompt:updated.prompt},[{at:current+'T13:00:00Z',result:answer([citation('https://brand.example.com/version'),citation('https://reddit.com/r/version/comments/a')])}]);assert.equal((await get(versioned,{view:'gaps'})).totalRows,0);
  await updatePrompt(versioned.project,owner,versioned.prompt.id,{requestId:randomUUID(),revision:2,text:'Current text must not become old evidence'});
  const versionEvidence=await get(versioned,{view:'evidence',period:'current',evidenceMode:'gap_all',gapPromptId:versioned.prompt.id}).catch(error=>error);assert.ok(fail(404)(versionEvidence));
  const versionGroups=await get(versioned);assert.equal(versionGroups.page.kind,'reddit');if(versionGroups.page.kind!=='reddit')throw Error('Expected Reddit');const versionPrompt=await get(versioned,{view:'prompts',period:'current',groupId:versionGroups.page.rows[0].id});assert.ok(versionPrompt.page.kind==='prompts'&&versionPrompt.page.rows[0].versionCount===2&&versionPrompt.page.rows[0].promptPreview==='New immutable prompt');
  await updateProjectContext(f.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'citation-category',domain:'rival.example.com',category:'ecommerce'}]});assert.deepEqual((await get(f,{view:'gaps'})).current.gaps,all.current.gaps);await assert.rejects(download(f,all),fail(409));
  const noIdentity=await fixture();await pool.query("UPDATE project SET origin='http://localhost:3000' WHERE id=$1",[noIdentity.project]);await updateProjectContext(noIdentity.project,owner,{requestId:randomUUID(),revision:2,updates:[{kind:'citation-brand-domain',domain:'shared.example.com',action:'remove'}]});
  await seed(noIdentity,[{result:answer([citation('https://rival.example.com/positive'),citation(shopping,'Acme product')])}]);const unavailable=await get(noIdentity,{view:'gaps'});assert.deepEqual(unavailable.current.gaps,{status:'brand_identity_unavailable',evaluatedPrompts:null,promptsWithCompetitor:null,observedCandidates:null,confirmedCandidates:null,matchingCandidates:null});assert.equal(unavailable.totalRows,0);assert.equal(unavailable.current.coverage.eligible,1);assert.equal(unavailable.current.google.shopping.annotations,1);assert.equal(csv((await download(noIdentity,unavailable)).body).some(r=>r[0]==='gap'),false);
  await updateProjectContext(noIdentity.project,owner,{requestId:randomUUID(),revision:3,updates:[{kind:'citation-brand-domain',domain:'brand.example.com',action:'add'}]});const identified=await get(noIdentity,{view:'gaps'});assert.equal(identified.current.gaps.status,'ready');assert.equal(identified.current.gaps.confirmedCandidates,1);assert.deepEqual(identified.evidenceStates,unavailable.evidenceStates);await assert.rejects(download(noIdentity,unavailable),fail(409));
  console.log('PASS strict complete/closed gap confidence, immutable-version aggregation and publisher category independent of identity');

  const csvReport=await get(f,{view:'gaps',query:'Nameless-only'}),exported=await download(f,csvReport),rows=csv(exported.body),header=rows[0],index=(name:string)=>header.indexOf(name);
  assert.equal(exported.filename,'prompt-citation-specializations.csv');assert.equal(rows.length-1,exported.rowCount);assert.ok(rows.every(row=>row.length===25));
  assert.deepEqual(JSON.parse(rows.find(r=>r[0]==='metadata')![index('Summary')]).entities,csvReport.entities);
  const evidenceRows=rows.filter(r=>r[0]==='evidence');assert.equal(evidenceRows.length,4);assert.equal(new Set(evidenceRows.map(r=>r[index('Execution ID')]+':'+r[index('Retained citation index')])).size,4);
  const hiddenProof=evidenceRows.find(r=>r[index('Retained URL')]==='https://rival.example.com/e')!;assert.equal(hiddenProof[index('Basis')],'gap_proof');assert.equal(hiddenProof[index('Matches source filters')],'false');assert.equal(exported.body.includes('PRIVATE EXPIRED TITLE'),false);
  const paging=await fixture();const seeded=await seed(paging,[{result:answer(Array.from({length:53},(_,i)=>citation(`https://reddit.com/r/community_${i}/comments/a`,i===0?'=SUM(1,2)\n"quoted"':null)))}]);const first=await get(paging),second=await get(paging,{cursor:first.nextCursor!});assert.equal(first.page.rows.length,50);assert.equal(second.page.rows.length,3);assert.equal(new Set([...first.page.rows,...second.page.rows].map(g=>'id'in g?g.id:'')).size,53);assert.deepEqual(first.evidenceStates,second.evidenceStates);
  const csvPage=csv((await download(paging,first)).body);assert.match(csvPage.find(r=>r[index('Retained title')].includes('SUM'))![index('Retained title')],/^'/);
  await assert.rejects(get(paging,{view:'search',cursor:first.nextCursor!}),fail(400));await pool.query('UPDATE prompt_execution SET result_purged_at=clock_timestamp(),result=NULL WHERE id=$1',[seeded[0].id]);await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[paging.workspace]);await assert.rejects(get(paging,{cursor:first.nextCursor!}),fail(409));await assert.rejects(download(paging,first),fail(409));const expired=await get(paging);assert.equal(expired.totalRows,0);assert.equal(expired.evidenceStates[0].eligibility,'expired');
  await assert.rejects(download(f,csvReport,viewer,AbortSignal.abort()),fail(499));
  console.log('PASS proof-inclusive rectangular CSV, formula escaping, stable paging, unchanged full manifests and irreversible retention revisions');

  const foreignProject=await fixture();await seed(foreignProject,[{result:answer([citation('https://reddit.com/r/privatebeta/comments/a','Foreign-only secret')])}]);const foreignReport=await get(foreignProject);assert.equal(foreignReport.page.kind,'reddit');if(foreignReport.page.kind!=='reddit')throw Error('Expected Reddit');
  await assert.rejects(get(reddit,{view:'prompts',period:'current',groupId:foreignReport.page.rows[0].id}),fail(404));await assert.rejects(get(reddit,{},foreign),fail(404));await assert.rejects(get(reddit,{promptId:foreignProject.prompt.id}),fail(404));
  await seed(foreignProject,[{result:answer([citation('https://reddit.com/r/tech/comments/foreign','Foreign-only secret')])}]);const same=await get(foreignProject);assert.ok(same.page.kind==='reddit'&&same.page.rows.some(g=>g.id===tech.id));const scoped=await get(reddit,{view:'evidence',period:'current',groupId:tech.id,evidenceMode:'matching'});assert.equal(JSON.stringify(scoped).includes('Foreign-only secret'),false);
  for(const extra of [{view:'reddit',period:'current'},{view:'prompts',groupId:rr.unresolvedEvidence.redditCommunityId,period:'current'},{view:'evidence',groupId:'https://reddit.com',period:'current',evidenceMode:'matching'},{view:'evidence',groupId:tech.id,period:'current',evidenceMode:'gap_all',gapPromptId:reddit.prompt.id},{provider:'google'}] as Record<string,string>[])await assert.rejects(get(reddit,extra),error=>fail(400)(error)||fail(404)(error));
  const repeated=params();repeated.append('from',current);await assert.rejects(getPromptCitationSpecializations(reddit.project,owner,repeated),fail(400));
  console.log('PASS tenant-scoped deterministic targets, strict navigation and no foreign-title disclosure');

  const capacity=await fixture();await seed(capacity,Array.from({length:1000},()=>({result:answer(Array.from({length:100},()=>citation(shopping,'Rival Tools')))})));const started=performance.now(),full=await get(capacity,{view:'shopping'});assert.equal(full.current.google.shopping.annotations,100000);assert.equal(full.current.google.shopping.executions,1000);assert.equal(full.totalRows,1);assert.equal(full.evidenceStates.length,1000);await assert.rejects(download(capacity,full),fail(413));
  const expensive=await fixture();await pool.query('DELETE FROM context_competitor WHERE project_id=$1',[expensive.project]);await pool.query("INSERT INTO context_competitor(id,project_id,primary_domain,domains,name,aliases,updated_by) SELECT gen_random_uuid(),$1,'competitor-'||i||'.example.com',jsonb_build_array('competitor-'||i||'.example.com'),'Company '||i,'[]',$2 FROM generate_series(1,100)i",[expensive.project,owner]);await seed(expensive,[{result:answer(Array.from({length:100},(_,i)=>citation(shopping,'x'.repeat(11000)+i)))}]);await assert.rejects(get(expensive,{view:'shopping'}),fail(413));
  console.log(`PASS 100k repeated-annotation exact aggregation (${Math.round(performance.now()-started)}ms including capped export) and bounded distinct-label attribution work`);

  const auth=await getAuth().api.signInEmail({body:{email:`${viewer}@specializations.integration.test`,password},asResponse:true});assert.equal(auth.status,200);const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),address=config.appUrl+`/api/projects/${reddit.project}/prompt-insights/citation-specializations`,headers={cookie,origin:config.appUrl,'content-type':'application/json'};
  const http=await handleApi(new Request(address+'?'+params(),{headers}));assert.equal(http.status,200);assert.equal(http.headers.get('cache-control'),'no-store');const report=await http.json();agreement(report);const body=JSON.stringify({...report.filters,expectedSelectionRevision:report.selectionRevision});const exportedHttp=await handleApi(new Request(address+'/export',{method:'POST',headers,body}));assert.equal(exportedHttp.status,200);assert.equal(Number(exportedHttp.headers.get('x-export-row-count')),csv(await exportedHttp.text()).length-1);
  assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers:{...headers,origin:'https://foreign.example'},body}))).status,403);assert.equal((await handleApi(new Request(address,{method:'DELETE',headers}))).status,405);assert.equal((await handleApi(new Request(address+'/export?x=1',{method:'POST',headers,body}))).status,400);assert.equal((await handleApi(new Request(address+'/export',{method:'POST',headers,body:'x'.repeat(4097)}))).status,413);
  const key=await createApiKey(reddit.workspace,owner,{name:'Synthetic specialized exclusion',scopes:['analytics:read'],expiresInDays:1});assert.equal((await handleApi(new Request(address,{headers:{authorization:'Bearer '+key.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[reddit.workspace,viewer]);assert.equal((await handleApi(new Request(address,{headers}))).status,404);assert.equal(outbound,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM provider_request WHERE operation<>'synthetic.specialized'")).rows[0].n,0);
  console.log('PASS actual member/API/export authorization, Origin/method/body/API-key guards and zero provider or paid work');
  const empty=await fixture();for(const view of ['reddit','shopping','search','gaps']){const r=await get(empty,{view});assert.equal(r.totalRows,0);assert.equal(r.evidenceStates.length,0);assert.equal(r.current.eligibleAnswers,null);}
  const emptyReport=await get(empty);for(const groupId of Object.values(emptyReport.unresolvedEvidence))await get(empty,{view:'evidence',period:'current',groupId,evidenceMode:'matching'});
  assert.deepEqual([...validatedViews].sort(),['evidence','gaps','prompts','reddit','reddit_pages','search','shopping']);
  console.log(`PASS actual service/client agreement for all seven views (${validatedReports} reports), filters, full gap proof, missing brand, empty/expired populations and paged manifests`);
 }finally{await closeDatabase();globalThis.fetch=original;}
}
if(process.env.TEN98_PROMPT_CITATION_SPECIALIZATIONS_TEST==='1')runSpecializedCitationChecks().catch(e=>{console.error(e);process.exitCode=1;});
