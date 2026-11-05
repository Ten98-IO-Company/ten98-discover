import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {claimInstallation} from '../src/server/auth.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {saveProvider} from '../src/server/providers.ts';
import {compileRankPlan,rankGroupPayload} from '../src/server/rank-execution-plan.ts';
import {getLatestRankResults} from '../src/server/rank-history.ts';
import {launchChromium} from './helpers/playwright.mjs';
import {openView} from './helpers/app-navigation.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
assert.equal(process.env.TEN98_RANK_HISTORY_NATIVE_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const config=getConfig(),database=new URL(config.databaseUrl),origin=new URL(config.appUrl);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(database.hostname));
assert.ok(['127.0.0.1','localhost','[::1]'].includes(origin.hostname));
assert.match(database.pathname,/^\/ten98_rank_history_native_[a-f0-9]{12}$/);
assert.equal(database.search,'');assert.equal(database.hash,'');
assert.equal(process.env.DATABASE_URL_FILE,undefined);
const output=process.env.ARTIFACT_DIR;assert.ok(output);await mkdir(output,{recursive:true});
const originalFetch=globalThis.fetch;let providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Retained rank reads must not call providers.');};
let browser:any,page:any,requests=0,contexts=0;
const errors:string[]=[],external:string[]=[],writes:string[]=[],groups:string[]=[];
const passed=(message:string)=>{groups.push(message);console.log('PASS '+message);};
const charge=()=>assert.ok(++requests<=100,'Native API request cap exceeded');
try{
 await assertSchema();const pool=getDatabase().pool;
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
 const ownerEmail=randomUUID()+'@rank-native.integration.test',password=randomBytes(24).toString('base64url');
 await claimInstallation({name:'Rank native owner',email:ownerEmail,password,workspaceName:'Rank installation'});
 const owner=(await pool.query('SELECT id FROM "user" WHERE email=$1',[ownerEmail])).rows[0].id as string;
 const viewer=randomUUID(),email=viewer+'@rank-native.integration.test',now=Date.now();
 const at=(days:number)=>new Date(now-days*86400000).toISOString();
 await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[viewer,'Rank native viewer',email]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),viewer,await hashPassword(password)]);

  async function fixture(terms:string[]){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',keywords:terms.map(keyword=>({id:randomUUID(),keyword,matchCase:true}))};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank history fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'History','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic history account',credentials:{login:'history@integration.test',password:'synthetic-only'}})).connection.id;
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'History tracker','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'both',100,1)`,[f.tracker,f.workspace,f.project]);
    for(const k of f.keywords)await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) VALUES($1,$2,$3,$4,$5,$6)',[k.id,f.workspace,f.project,f.tracker,k.keyword,k.matchCase]);return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  type Options={device?:'desktop'|'mobile';status?:'ranked'|'not_found'|'failed';position?:number;created:string};
  async function run(f:Fixture,opt:Options){
    const id=randomUUID(),dispatch=randomUUID(),created=opt.created,device=opt.device??'desktop',state=opt.status??'ranked';
    const plan=compileRankPlan({method:'queued',target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1},devices:device,keywords:[f.keywords[0]]});
    const status=state==='failed'?'failed':'completed';
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,request_version,expires_at,request_key,is_subset,created_at,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,'manual','queued',$6,1,1,$7,1,$8,'Synthetic',$9,$10,$11,1,$12::timestamptz+interval '5 minutes',$13,false,$12,$12,$12)`,
      [id,f.workspace,f.project,f.tracker,owner,status,f.connection,'a'.repeat(64),JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,created,randomUUID()]);
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,connection_revision,status)
      VALUES($1,$2,$3,$4,$5,'rank.queued',$6,1,'settled')`,[dispatch,f.workspace,f.connection,owner,randomUUID(),'b'.repeat(64)]);
    const payload=rankGroupPayload(plan,plan.groups[0]);await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,dispatched_at,completed_at)
      VALUES($1,$2,$3,$4,0,'queued',$5,$6,$7,'finished',$8,$8)`,[dispatch,f.workspace,f.project,id,plan.tasks.length,JSON.stringify(payload),canonicalHash(payload),created]);
    const measured=state==='ranked'||state==='not_found',ranked=state==='ranked',position=opt.position??8;
    await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,position,rank_basis,absolute_position,ranking_url,serp_features,checked_depth,returned_item_count,observed_at,retrieved_at,raw_evidence)
      SELECT t.id,$2,$3,$4,$5,t."keywordId",t.keyword,t."matchCase",t.device,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15
      FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,"keywordId" uuid,keyword text,"matchCase" boolean,device text)`,
      [JSON.stringify(plan.tasks),f.workspace,f.project,id,dispatch,state,ranked?position:null,ranked?'organic':null,ranked?position:null,ranked?'https://example.com/result':null,measured?'["organic"]':null,measured?10:null,measured?10:null,measured?created:null,measured?'{}':null]);
    return {id};
  }
 const literal='venture C++ %20',f=await fixture([literal,'unrelated keyword']);
 const good=await run(f,{created:at(2),position:3}),failed=await run(f,{created:at(.5),status:'failed'}),mobile=await run(f,{created:at(1),device:'mobile',status:'not_found'});
 const foreignWorkspace=randomUUID(),foreignProject=randomUUID();
 await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign rank fixture')",[foreignWorkspace]);
 await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Foreign','https://foreign.example',$3,'infinity')",[foreignProject,foreignWorkspace,randomUUID()]);
 const snapshot=async()=>{const rows:Record<string,unknown>={};for(const table of ['rank_run','rank_task','rank_dispatch','provider_request'])rows[table]=(await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS rows FROM ${table} t`)).rows[0].rows;rows.jobs=(await pool.query("SELECT to_regclass('pgboss.job') AS present")).rows[0].present?(await pool.query("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS rows FROM pgboss.job t")).rows[0].rows:null;return rows;};
 const before=await snapshot(),native=await getLatestRankResults(f.project,viewer,f.tracker);
 const desktop=native.rows.find(row=>row.keywordId===f.keywords[0].id&&row.device==='desktop')!,mobileRow=native.rows.find(row=>row.keywordId===f.keywords[0].id&&row.device==='mobile')!;
 assert.equal(desktop.latestAttempt?.runId,failed.id);assert.equal(desktop.latestAttempt?.status,'failed');assert.equal(desktop.latestObservation?.runId,good.id);assert.equal(desktop.latestObservation?.position,3);
 assert.equal(mobileRow.latestObservation?.runId,mobile.id);assert.equal(mobileRow.latestObservation?.status,'not_found');
 browser=await launchChromium();
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});contexts++;
 await context.route('**/*',async(route:any)=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin.origin){external.push(url.origin);return route.abort();}if(url.pathname.startsWith('/api/')){charge();if(!['GET','HEAD'].includes(request.method())){writes.push(request.method()+' '+url.pathname);return route.abort();}}return route.continue();});
 const api=async(path:string,options:Record<string,unknown>={})=>{assert.ok(path.startsWith('/api/'));charge();return context.request.fetch(origin.origin+path,{...options,headers:{origin:origin.origin},maxRedirects:0,maxRetries:0,timeout:10000});};
 assert.equal((await api('/api/auth/sign-in/email',{method:'POST',data:{email,password}})).status(),200);
 assert.ok((await context.cookies(origin.origin)).some((cookie:any)=>cookie.name.includes('session_token')));
 assert.equal((await api(`/api/projects/${foreignProject}/rank-trackers/${f.tracker}/results`)).status(),404);
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',(error:Error)=>errors.push(error.message));
 await page.goto(origin.origin+'/?'+new URLSearchParams({workspace:f.workspace,project:f.project}));await openView(page,'ranks');
 await page.getByRole('button',{name:'History tracker',exact:true}).click();await page.getByRole('button',{name:'Latest observations',exact:true}).click();
 await page.getByRole('button',{name:literal,exact:true}).first().waitFor();
 const filter=page.getByText('Observation filters',{exact:true});await filter.click();await page.getByLabel('Device',{exact:true}).selectOption('desktop');await page.getByLabel('Keyword contains',{exact:true}).fill(literal);await page.getByRole('button',{name:'Apply filters',exact:true}).click();
 const row=page.getByRole('row').filter({has:page.getByRole('button',{name:literal,exact:true})});await row.locator('td').nth(3).getByText('Organic rank 3',{exact:true}).waitFor();assert.match(await row.innerText(),/failed/);assert.equal(await page.getByRole('button',{name:literal,exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'unrelated keyword',exact:true}).count(),0);
 passed('native viewer, foreign scope denial and failed desktop attempt remain distinct from older rank3 and mobile not_found');
 const openKeyword=async()=>{await page.getByRole('button',{name:literal,exact:true}).click();await page.getByRole('heading',{name:'Keyword rank history',exact:true}).waitFor();};
 await openKeyword();
 for(const [id,status]of [[failed.id,'failed'],[good.id,'ranked']] as const){
  const history=page.getByRole('region',{name:'Keyword rank history',exact:true}),selected=history.locator('tbody tr').filter({has:page.getByText(status,{exact:true})});
  const responsePromise=page.waitForResponse((response:any)=>response.url()===`${origin.origin}/api/projects/${f.project}/rank-checks/${id}`&&response.request().method()==='GET');
  await selected.getByRole('button').first().click();const response=await responsePromise;assert.equal(response.status(),200);const body=await response.json();assert.equal(body.role,'viewer');assert.equal(body.run.id,id);assert.equal(body.run.requestStatus,'settled');assert.equal(body.run.tasks[0].status,status);
  await page.getByText('Request status settled',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Keyword rank history',exact:true}).count(),0);
  await page.getByText('Check ID '+id,{exact:true}).waitFor({state:'visible'});
  const retainedRow=page.getByRole('region',{name:'Rank observations',exact:true}).getByRole('row').filter({has:page.getByRole('cell',{name:literal,exact:true})});
  await retainedRow.locator('td').nth(2).getByText(status,{exact:true}).waitFor({state:'visible'});
  await retainedRow.locator('td').nth(3).getByText(status==='ranked'?'Organic rank 3':'Unavailable',{exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:join(output,status+'-retained-run.png'),fullPage:true});
  await page.getByRole('button',{name:'Back to observations',exact:true}).click();await page.getByRole('heading',{name:'Keyword rank history',exact:true}).waitFor();await page.waitForFunction(()=>document.activeElement?.id.endsWith('history-heading'));
  await page.getByRole('button',{name:'Latest observations',exact:true}).click();await page.getByText(`Applied: desktop devices · Contains “${literal}” · All pin states`,{exact:true}).waitFor();await page.getByRole('row').filter({has:page.getByRole('button',{name:literal,exact:true})}).locator('td').nth(3).getByText('Organic rank 3',{exact:true}).waitFor();await openKeyword();
 }
 passed('both native retained run IDs and settled requests open read-only; Back preserves keyword history, Desktop+literal filters and focus');
 const failedRow=page.getByRole('region',{name:'Keyword rank history',exact:true}).locator('tbody tr').filter({has:page.getByText('failed',{exact:true})});await failedRow.getByRole('button').first().click();await page.getByText('Request status settled',{exact:true}).waitFor();
 await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,viewer]);
 const denied=page.waitForResponse((response:any)=>response.url()===`${origin.origin}/api/projects/${f.project}/rank-checks/${failed.id}`&&response.status()===404);await page.getByRole('button',{name:'Refresh check',exact:true}).click();await denied;
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Rank observations"]'));assert.equal(await page.getByText('Request status settled',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Back to observations',exact:true}).click();await page.getByRole('button',{name:'Reload access',exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'Keyword rank history',exact:true}).count(),0);assert.equal(await page.getByText('Organic rank 3',{exact:true}).count(),0);
 assert.equal((await api(`/api/projects/${f.project}/rank-trackers/${f.tracker}/keywords/${f.keywords[0].id}/history`)).status(),404);
 assert.deepEqual(await snapshot(),before);assert.equal(providerCalls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);assert.ok(contexts<=2);assert.ok(requests<=100);
 passed('actual membership revocation purges retained run and history; rank, task, dispatch, provider-request and job rows stay identical with zero provider calls');
 await writeFile(join(output,'acceptance.json'),JSON.stringify({status:'passed',groups,requests,contexts,providerCalls,external,writes,errors,runIds:{good:good.id,failed:failed.id,mobile:mobile.id},databaseRowsUnchanged:true},null,2));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();await closeDatabase();globalThis.fetch=originalFetch;}
