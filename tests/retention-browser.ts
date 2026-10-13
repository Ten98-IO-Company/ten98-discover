import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { runRetentionBatch } from '../src/server/retention.ts';

// Optional real-browser acceptance. Use a separately supplied browser module,
// never an extra production dependency or a deployment/customer database.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig(),local=['localhost','127.0.0.1','[::1]'];
assert.ok(local.includes(new URL(config.appUrl).hostname)&&local.includes(new URL(config.databaseUrl).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply an installed Playwright module URL.');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE!);
let browser:any,releasePreview:(()=>void)|undefined;
try {
  await assertSchema();
  const {pool}=getDatabase(),userId=randomUUID(),email=`${randomUUID()}@retention-browser.integration.test`,password=randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Retention browser reviewer',email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),userId,await hashPassword(password)]);
  const {workspace}=await createWorkspace(userId,{name:'Retention browser workspace'});
  const projectId=randomUUID(),cutoff=new Date();cutoff.setUTCHours(12,0,0,0);cutoff.setUTCDate(cutoff.getUTCDate()-1);
  await pool.query(`INSERT INTO project(id,workspace_id,name,origin,public_key,retention_policy_revision,retention_cutoff,retention_next_run_at)
    VALUES($1,$2,'Retention browser project','https://retention-browser.integration.test',$3,1,$4,'infinity')`,[projectId,workspace.id,randomUUID(),cutoff]);
  await pool.query(`INSERT INTO event(id,project_id,event_name,path,received_at) VALUES
    (gen_random_uuid(),$1,'page_view','/old',$2::timestamptz-interval '2 days'),
    (gen_random_uuid(),$1,'page_view','/retained',$2::timestamptz),
    (gen_random_uuid(),$1,'signup','/retained',$2::timestamptz+interval '1 hour')`,[projectId,cutoff]);
  await runRetentionBatch(projectId);
  await pool.query("UPDATE project SET retention_next_run_at='infinity' WHERE id=$1",[projectId]);
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:360,height:800}});
  const external:string[]=[];
  await context.route('**/*',async(route:any)=>{
    if(new URL(route.request().url()).origin!==config.appUrl){external.push(route.request().url());await route.abort();}
    else await route.continue();
  });
  const signed=await context.request.post(`${config.appUrl}/api/auth/sign-in/email`,{headers:{origin:config.appUrl},data:{email,password}});
  assert.equal(signed.status(),200);
  const page=await context.newPage();page.setDefaultTimeout(15000);
  async function navigation() {
    const toggle=page.getByRole('button',{name:/^(Menu|Close menu)$/});
    if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
  }
  async function section(name:string) {
    await navigation();await page.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('link',{name,exact:true}).click();
  }
  async function settings(name:string) {
    await navigation();
    const target=page.getByRole('navigation',{name:'Workspace settings',exact:true}).getByRole('link',{name,exact:true});
    if(!await target.isVisible())await page.getByText('Workspace settings',{exact:true}).click();
    await target.click();
  }
  await page.goto(config.appUrl,{waitUntil:'networkidle'});
  await navigation();await page.getByRole('navigation',{name:'Projects',exact:true}).getByRole('link',{name:'Retention browser project',exact:true}).click();
  await page.getByText('This date range is partial after retention.',{exact:false}).waitFor();
  await page.getByText('Daily data table',{exact:true}).click();
  assert.ok(await page.getByText('Unavailable',{exact:true}).count()>0);
  await page.getByText('(partial)',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile analytics must not overflow.');
  const artifacts=process.env.BROWSER_ARTIFACT_DIR;
  if(artifacts){await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'retention-coverage-mobile.png'),fullPage:true});}
  await section('Recent events');
  await page.getByText('Events currently retained',{exact:true}).waitFor();
  assert.equal(await page.getByText('All received events, across all dates',{exact:true}).count(),0);
  await settings('Data retention');
  const raw=()=>page.getByLabel('Raw analytics (days)',{exact:true});
  await raw().waitFor();assert.equal(await raw().inputValue(),'90');
  const preview=()=>page.getByRole('button',{name:'Preview cleanup',exact:true});
  const save=()=>page.getByRole('button',{name:'Save retention',exact:true});
  await raw().fill('0');assert.equal(await preview().isEnabled(),false);
  await raw().fill('30');await preview().click();await save().waitFor();
  await page.getByText('0 generated prompt answers and 0 copied execution inputs eligible under raw provider evidence retention.',{exact:true}).waitFor();
  await page.getByText('0 saved keyword metric snapshots eligible. Authored keywords and tags remain.',{exact:true}).waitFor();
  await page.getByText('0 finished Meta imports eligible or already awaiting cleanup. Their receipts remain.',{exact:true}).waitFor();
  await page.getByText('0 finished Meta campaign inventories eligible or already awaiting cleanup. Their receipts remain.',{exact:true}).waitFor();
  await page.getByText('Raw provider evidence cutoff (UTC):',{exact:false}).waitFor();
  assert.equal((await pool.query('SELECT raw_analytics_days FROM workspace WHERE id=$1',[workspace.id])).rows[0].raw_analytics_days,90,'Preview must not save.');
  const unavailableMeta=async(route:any)=>{const response=await route.fetch(),body=await response.json();body.metaEstimate={status:'unavailable',imports:null,atLeast:false};body.metaInventoryEstimate={status:'unavailable',inventories:null,atLeast:false};await route.fulfill({response,json:body});};
  await page.route(`**/api/workspaces/${workspace.id}/retention/preview`,unavailableMeta);
  await preview().click();await page.getByText('Meta import estimate unavailable. Finished Meta report rows still follow this policy.',{exact:true}).waitFor();
  await page.getByText('Meta campaign inventory estimate unavailable. Finished campaign metadata still follows this policy.',{exact:true}).waitFor();
  assert.equal(await page.getByText('0 finished Meta imports eligible or already awaiting cleanup. Their receipts remain.',{exact:true}).count(),0);
  assert.equal(await page.getByText('0 finished Meta campaign inventories eligible or already awaiting cleanup. Their receipts remain.',{exact:true}).count(),0);
  await page.unroute(`**/api/workspaces/${workspace.id}/retention/preview`,unavailableMeta);
  await raw().fill('45');assert.equal(await save().count(),0,'Editing invalidates an earlier confirmation.');
  await preview().click();await save().click();
  await page.waitForFunction(async(id:string)=>{const response=await fetch(`/api/workspaces/${id}/retention`);return(response.ok&&(await response.json()).settings.rawAnalyticsDays===45);},workspace.id);
  await save().waitFor({state:'detached'});
  assert.equal(await raw().inputValue(),'45');
  await raw().fill('50');await preview().click();await save().waitFor();
  await pool.query('UPDATE workspace SET raw_analytics_days=60,retention_revision=retention_revision+1 WHERE id=$1',[workspace.id]);
  await save().click();await save().waitFor({state:'detached'});
  assert.equal(await raw().inputValue(),'50','A stale save must preserve the draft.');
  await page.getByRole('button',{name:'Reload saved settings',exact:true}).click();
  await page.waitForFunction(()=>{const el=document.querySelector('input[id$="-rawAnalyticsDays"]') as HTMLInputElement|null;return el?.value==='60';});
  await raw().fill('65');
  let intercepted:()=>void=()=>{};const interceptedPromise=new Promise<void>(resolve=>{intercepted=resolve;});
  const held=new Promise<void>(resolve=>{releasePreview=resolve;});
  const hold=async(route:any)=>{const response=await route.fetch();intercepted();await held;await route.fulfill({response}).catch(()=>{});};
  await page.route(`**/api/workspaces/${workspace.id}/retention/preview`,hold);
  await preview().click();await interceptedPromise;
  await settings('Account security');
  releasePreview!();releasePreview=undefined;
  await page.unroute(`**/api/workspaces/${workspace.id}/retention/preview`,hold);
  await settings('Data retention');await raw().waitFor();
  assert.equal(await raw().inputValue(),'60');assert.equal(await save().count(),0,'A late preview must not reappear after navigation.');
  await raw().fill('75');await preview().click();await save().waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile retention controls must not overflow.');
  const undersized=await page.getByRole('button').evaluateAll((buttons:HTMLButtonElement[])=>buttons.filter(button=>button.textContent?.includes('retention')||button.textContent?.includes('preview')).filter(button=>button.getBoundingClientRect().height<44).map(button=>button.textContent));
  assert.deepEqual(undersized,[],'Retention controls should provide 44px touch targets.');
  if(artifacts)await page.screenshot({path:join(artifacts,'retention-settings-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1360,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Desktop retention must not overflow.');
  if(artifacts)await page.screenshot({path:join(artifacts,'retention-settings-desktop.png'),fullPage:true});
  await page.setViewportSize({width:360,height:800});
  const replacement=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[replacement,'Remaining owner',`${replacement}@retention-browser.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,replacement]);
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace.id,userId]);
  await save().click();
  await page.getByText('Only a workspace owner can change retention.',{exact:true}).waitFor();
  assert.equal(await save().count(),0);
  assert.equal((await pool.query('SELECT raw_analytics_days FROM workspace WHERE id=$1',[workspace.id])).rows[0].raw_analytics_days,60,'Demoted owner cannot save.');
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace.id,userId]);
  await page.getByRole('button',{name:'Reload saved settings',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('input[id$="-rawAnalyticsDays"]').length===0);
  assert.equal(await save().count(),0);
  assert.equal(external.length,0,'Retention must not contact external services.');
  console.log('PASS Edge retention: partial/unavailable mobile charts, explicit preview/save, draft invalidation, stale save recovery, late response, demotion and removal; no external requests');
} finally {releasePreview?.();await browser?.close();await closeDatabase();}
