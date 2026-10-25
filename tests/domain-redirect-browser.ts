import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {createWorkspace} from '../src/server/teams.ts';
import {addDomain,issueDomainChallenge,verifyDomain} from '../src/server/domains.ts';
import {executeDomainRedirectCheck} from '../src/server/domain-redirects.ts';
import {stopJobs} from '../src/server/jobs.ts';
import type {RedirectTransport} from '../src/server/domain-redirect-network.ts';
import {launchChromium,setViewport} from './helpers/playwright.mjs';

// Production UI/API with a synthetic DNS/HTTP worker transport, never a public request.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig();
for(const value of [config.appUrl,config.databaseUrl])assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE);
let browser:any,stage='setup';const releases:(()=>void)[]=[];
try{
  await assertSchema();const {pool}=getDatabase(),user=randomUUID(),password=randomBytes(24).toString('base64url'),email=`${user}@redirect-browser.integration.test`;
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Redirect browser owner',email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),user,await hashPassword(password)]);
  stage='workspace fixture';const workspace=(await createWorkspace(user,{name:'Redirect browser workspace'})).workspace;
  async function project(name:string){const id=randomUUID();await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[id,workspace.id,name,name==='Other browser site'?'https://other.example.com':'https://canonical.example.com',randomUUID()]);return id;}
  stage='project fixture';const projectId=await project('Redirect browser site'),otherProject=await project('Other browser site');
  async function alias(hostname:string){const state=await addDomain(projectId,user,{hostname,role:'redirect_alias'}),row=state.domains.find(d=>d.hostname===hostname)!;
    const proof=await issueDomainChallenge(projectId,user,row.id,{});await verifyDomain(projectId,user,row.id,{},async()=>[[proof.challenge.value]]);return row;}
  stage='alias fixture';const first=await alias('alias-browser.example.com'),lost=await alias('lost-browser.example.com');
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  stage='browser launch';browser=await launchChromium();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});let external=0,errors=0;
  await context.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin!==config.appUrl){external++;return route.abort();}return route.continue();});
  stage='browser sign in';const signin=await context.request.post(`${config.appUrl}/api/auth/sign-in/email`,{headers:{origin:config.appUrl},data:{email,password}});assert.equal(signin.status(),200);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
  const href=(id:string)=>`${config.appUrl}/?${new URLSearchParams({workspace:workspace.id,project:id,view:'domains'})}`;
  const row=(host:string)=>page.getByRole('row').filter({has:page.getByText(host,{exact:true})});
  const panel=(host:string)=>row(host).locator('details');
  async function open(host:string){const details=panel(host);await details.locator('summary').focus();await page.keyboard.press('Enter');await details.getByRole('button',{name:'Check redirect',exact:true}).waitFor();await details.getByText('No redirect checks have been run.',{exact:true}).waitFor();return details;}
  const transport:RedirectTransport={resolve:async()=>[{address:'1.1.1.1',family:4}],request:async url=>url.hostname==='canonical.example.com'?{status:200,location:null}:{status:301,location:'https://canonical.example.com/landing?private_query=never-stored#private-fragment'}};
  const checkRow=async(domain:string)=>(await pool.query('SELECT * FROM domain_redirect_check WHERE domain_id=$1 ORDER BY created_at DESC',[domain])).rows[0];

  stage='manual check and sanitised response';await page.goto(href(projectId),{waitUntil:'networkidle'});const details=await open(first.hostname);
  await details.getByRole('button',{name:'Check redirect',exact:true}).click();await details.getByText('Queued',{exact:true}).waitFor();
  const initial=await checkRow(first.id);await executeDomainRedirectCheck(initial.id,transport);
  await details.getByRole('button',{name:'Refresh checks',exact:true}).click();await details.getByText('Check finished',{exact:true}).waitFor();
  const content=await details.innerText();assert.match(content,/HTTP 301/);assert.match(content,/HTTP 200/);assert.match(content,/Final hostname matched/);assert.ok(!content.includes('private_query')&&!content.includes('private-fragment'));
  assert.equal(await details.locator('a').count(),0,'Observed external URLs remain plain text.');
  console.log('PASS production manual redirect flow, keyboard disclosure, sanitised chain and explicit observation copy');

  stage='failed refresh preserves evidence';const endpoint=`**/api/projects/${projectId}/domains/${first.id}/redirect-checks`;
  await page.route(endpoint,(route:any)=>route.fulfill({status:503,json:{error:'Synthetic refresh unavailable.'}}));
  await details.getByRole('button',{name:'Refresh checks',exact:true}).click();await details.getByRole('alert').waitFor();assert.match(await details.innerText(),/last loaded result remains/);assert.match(await details.innerText(),/HTTP 301/);await page.unroute(endpoint);
  console.log('PASS failed history refresh preserves explicitly stale evidence');

  stage='lost POST acknowledgement retains idempotency';const lostDetails=await open(lost.hostname),bodies:any[]=[];let drop=true;
  const lostEndpoint=`**/api/projects/${projectId}/domains/${lost.id}/redirect-checks`;
  await page.route(lostEndpoint,async(route:any)=>{if(route.request().method()!=='POST')return route.continue();bodies.push(route.request().postDataJSON());
    const response=await route.fetch();assert.equal(response.status(),202);if(drop){drop=false;return route.abort('connectionreset');}return route.fulfill({response});});
  await lostDetails.getByRole('button',{name:'Check redirect',exact:true}).click();await lostDetails.getByRole('button',{name:'Retry check request',exact:true}).waitFor();
  assert.equal((await pool.query('SELECT id FROM domain_redirect_check WHERE domain_id=$1',[lost.id])).rowCount,1);
  await lostDetails.getByRole('button',{name:'Retry check request',exact:true}).click();await lostDetails.getByText('Queued',{exact:true}).waitFor();assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);
  assert.equal((await pool.query('SELECT id FROM domain_redirect_check WHERE domain_id=$1',[lost.id])).rowCount,1);await page.unroute(lostEndpoint);
  await executeDomainRedirectCheck((await checkRow(lost.id)).id,transport);await lostDetails.getByRole('button',{name:'Refresh checks',exact:true}).click();await lostDetails.getByText('Check finished',{exact:true}).waitFor();
  console.log('PASS dropped committed POST acknowledgement retries the exact request ID with one receipt');

  stage='desktop and mobile layout';await mkdir('private/redirect-screenshots',{recursive:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'private/redirect-screenshots/desktop.png',fullPage:true});
  await setViewport(page,{width:360,height:860});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await details.getByRole('button',{name:'Refresh checks',exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await details.getByRole('button',{name:'Refresh checks',exact:true}).isVisible());
  await page.screenshot({path:'private/redirect-screenshots/mobile.png',fullPage:true});
  await setViewport(page,{width:1440,height:1000});console.log('PASS desktop and 360px document bounds');

  stage='expired receipt and revoked proof';await pool.query('UPDATE domain_redirect_check SET observation=NULL,observation_expired_at=clock_timestamp() WHERE id=$1',[initial.id]);
  await details.getByRole('button',{name:'Refresh checks',exact:true}).click();await details.getByText('Observation expired under workspace retention. Only this check receipt remains.',{exact:true}).waitFor();assert.ok(!(await details.innerText()).includes('HTTP 301'));
  await row(first.hostname).getByRole('button',{name:'Revoke proof',exact:true}).click();await page.getByRole('dialog',{name:`Revoke the proof for ${first.hostname}?`,exact:true}).getByRole('button',{name:'Revoke proof',exact:true}).click();await row(first.hostname).getByText('Revoked',{exact:true}).waitFor();
  const revoked=panel(first.hostname);await revoked.locator('summary').click();await revoked.getByText('Historical configuration; this check does not describe the current alias settings.',{exact:true}).waitFor();assert.equal(await revoked.getByRole('button',{name:'Check redirect',exact:true}).isDisabled(),true);
  console.log('PASS expired evidence remains a receipt; revoked proof disables checks and labels historical configuration');

  stage='delayed project response and current permission';let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);releases.push(release);
  await page.route(lostEndpoint,async(route:any)=>{const response=await route.fetch();entered();await held;await route.fulfill({response}).catch(()=>{});});
  await lostDetails.getByRole('button',{name:'Refresh checks',exact:true}).click();await began;
  // Browser navigation unmounts the old project while its authorised response is held.
  await page.goto(href(otherProject),{waitUntil:'domcontentloaded'});release();await page.unroute(lostEndpoint);await page.getByRole('heading',{name:'Domains',exact:true}).waitFor();
  assert.equal(await page.getByText(lost.hostname,{exact:true}).count(),0);assert.equal(await page.getByText('Check finished',{exact:true}).count(),0);
  await page.goto(href(projectId),{waitUntil:'networkidle'});await panel(lost.hostname).locator('summary').click();await panel(lost.hostname).getByText('Check finished',{exact:true}).waitFor();
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,user]);
  await panel(lost.hostname).getByRole('button',{name:'Refresh checks',exact:true}).click();await page.getByRole('alert').first().waitFor();
  assert.equal(await page.getByText('Check finished',{exact:true}).count(),0);assert.equal(await page.getByText(lost.hostname,{exact:true}).count(),0);
  assert.equal(external,0);assert.equal(errors,0);console.log('PASS delayed project response isolation, current-role denial and zero external browser requests');
  console.log('Redirect browser checks passed. Only synthetic local fixtures remain.');
}catch(error){console.error(`Redirect browser checks failed during ${stage}: ${error instanceof Error?error.name:'Error'}.`);process.exitCode=1;}
finally{for(const release of releases)release();await browser?.close();await stopJobs().catch(()=>{});await closeDatabase();}
