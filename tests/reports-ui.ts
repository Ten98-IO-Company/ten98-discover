import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {claimInstallation} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {createWorkspace,removeMember} from '../src/server/teams.ts';
import {launchChromium,setViewport} from './helpers/playwright.mjs';

// Real local UI acceptance. Playwright is optional operator tooling, not an application dependency.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig();
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Set PLAYWRIGHT_MODULE to the installed Playwright module URL.');
let browser:any,releaseProjects:(()=>void)|undefined;
try {
  await assertSchema();
  const {pool}=getDatabase();
  const email=`${randomUUID()}@reports-ui.integration.test`,password=randomBytes(24).toString('base64url');
  if(!(await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed) {
    await claimInstallation({name:'Report UI owner',email,password,workspaceName:'Report UI checks'});
  } else {
    const userId=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Report UI owner',email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)',[randomUUID(),userId,'credential',await hashPassword(password)]);
    await createWorkspace(userId,{name:'Report UI checks'});
  }
  browser=await launchChromium();
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const request=async(path:string,body?:unknown)=>{
    const response=body===undefined?await context.request.get(config.appUrl+path):await context.request.post(config.appUrl+path,{headers:{origin:config.appUrl},data:body});
    assert.ok(response.ok(),`Fixture API failed at ${path}`);return response.json();
  };
  await request('/api/auth/sign-in/email',{email,password});
  const me=await request('/api/me'),workspaceId=me.workspaces[0].id;
  const project=(await request(`/api/workspaces/${workspaceId}/projects`,{name:'UI report project',origin:'https://report-ui.integration.test'})).project;
  const otherProject=(await request(`/api/workspaces/${workspaceId}/projects`,{name:'Other report project',origin:'https://other-report-ui.integration.test'})).project;
  const page=await context.newPage();let pageErrors=0;page.on('pageerror',()=>{pageErrors++;});
  async function navigation() {
    const toggle=page.getByRole('button',{name:/^(Menu|Close menu)$/});
    if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  }
  async function selectProject(name:string) {
    await navigation();await page.locator('aside.t98-shell-sidebar').getByLabel('Website',{exact:true}).selectOption({label:name});
  }
  // Report pages are tabs in a section's strip: open the section from the sidebar, then its tab.
  async function section(name:string,tab:string) {
    await navigation();await page.locator('aside.t98-shell-sidebar').getByRole('navigation',{name:'Sections',exact:true}).getByRole('link',{name,exact:true}).click();
    await page.getByRole('navigation',{name:`${name} pages`,exact:true}).getByRole('link',{name:tab,exact:true}).click();
  }
  // A late first-project response must not replace an explicitly chosen account view.
  const projectPath=`**/api/workspaces/${workspaceId}/projects`;
  const projectGate=new Promise<void>(resolve=>{releaseProjects=resolve;});
  await page.route(projectPath,async(route:any)=>{const response=await route.fetch();await projectGate;await route.fulfill({response});});
  await page.goto(config.appUrl,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Account menu',exact:true}).click();
  await page.locator('.t98-account-menu').getByRole('link',{name:'Security',exact:true}).click();
  await page.getByRole('heading',{name:'Two-factor authentication',exact:true}).waitFor();
  releaseProjects?.();
  await page.getByLabel('Website',{exact:true}).getByRole('option',{name:'UI report project',exact:true,includeHidden:true}).waitFor({state:'attached'});
  assert.equal(await page.getByRole('heading',{name:'Two-factor authentication',exact:true}).isVisible(),true,'Late project loading must preserve newer explicit navigation.');
  await page.unroute(projectPath);
  // Exercise callback navigation without an IdP: this deliberately invalid proof
  // must stay on its identity result view, never be mistaken for successful sign-in.
  const identityPage=await context.newPage();let releaseIdentity!:()=>void;
  const identityGate=new Promise<void>(resolve=>{releaseIdentity=resolve;});
  try {
    await identityPage.route(projectPath,async(route:any)=>{const response=await route.fetch();await identityGate;await route.fulfill({response});});
    await identityPage.goto(`${config.appUrl}/#oidc-proof=${randomUUID()}`,{waitUntil:'domcontentloaded'});
    await identityPage.getByRole('heading',{name:'Your sign-in methods',exact:true}).waitFor();
    releaseIdentity();
    await identityPage.getByLabel('Website',{exact:true}).getByRole('option',{name:'UI report project',exact:true,includeHidden:true}).waitFor({state:'attached'});
    assert.equal(await identityPage.getByRole('heading',{name:'Your sign-in methods',exact:true}).isVisible(),true,'Project loading must preserve identity callback navigation.');
    assert.equal(new URL(identityPage.url()).hash,'','Identity callback fragments must be cleared.');
  } finally {releaseIdentity();await identityPage.close();}
  await selectProject('UI report project');
  await section('Reports','Saved reports');
  // Selectors below intentionally follow visible labels rather than internal component state.
  await page.getByRole('button',{name:'New report',exact:true}).click();
  await page.getByLabel('Report title',{exact:true}).fill('Quarterly review');
  const source='<html><head><title>Quarterly review</title></head><body><h1>Public snapshot one</h1><script>window.reportExecuted=true</script></body></html>';
  await page.getByLabel('HTML source',{exact:true}).fill(source);
  let failSavedList=true;
  const savedListPattern=`**/api/projects/${project.id}/reports`;
  await page.route(savedListPattern,async(route:any)=>{
    if(route.request().method()==='GET'&&failSavedList){failSavedList=false;await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic report list refresh failure'})});}
    else await route.continue();
  });
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Synthetic report list refresh failure'}).waitFor();
  assert.ok(new URLSearchParams(new URL(page.url()).searchParams.get('reportQuery')!).get('id'),'A successful save commits selection before auxiliary refreshes.');
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),source);
  await page.unroute(savedListPattern);
  await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await page.getByRole('button',{name:'Preview saved report',exact:true}).click();
  const frame=page.frameLocator('iframe[title]');
  await frame.getByRole('heading',{name:'Public snapshot one'}).waitFor();
  assert.equal(await frame.locator('script').count(),0);
  const saved=(await request(`/api/projects/${project.id}/reports`)).reports.find((row:any)=>row.title==='Quarterly review');
  assert.ok(saved);assert.equal((await request(`/api/projects/${project.id}/reports/${saved.id}`)).report.html,source);
  const selectedUrl=page.url(),selectedQuery=new URLSearchParams(new URL(selectedUrl).searchParams.get('reportQuery')!);
  assert.equal(selectedQuery.get('id'),saved.id);assert.equal(selectedQuery.get('revision'),'1');assert.equal(selectedQuery.get('preview'),'1');
  await page.reload({waitUntil:'networkidle'});
  await frame.getByRole('heading',{name:'Public snapshot one'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),source);
  await page.getByRole('button',{name:'Hide preview',exact:true}).click();await page.goBack();await frame.getByRole('heading',{name:'Public snapshot one'}).waitFor();await page.goForward();await page.getByRole('button',{name:'Preview saved report',exact:true}).waitFor();
  let detailReads=0;const countDetail=(req:any)=>{if(new URL(req.url()).pathname===`/api/projects/${project.id}/reports/${saved.id}`&&req.method()==='GET')detailReads++;};page.on('request',countDetail);
  await page.getByLabel('HTML source',{exact:true}).fill('Protected draft');
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'Protected draft');
  await page.getByRole('button',{name:'Preview saved report',exact:true}).click();await frame.getByRole('heading',{name:'Public snapshot one'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'Protected draft');assert.equal(detailReads,0);page.off('request',countDetail);
  const dirtyUrl=page.url(),boards=page.getByRole('navigation',{name:'Reports pages',exact:true}).getByRole('link',{name:'Boards',exact:true});
  await boards.click();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(page.url(),dirtyUrl);assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'Protected draft');
  await boards.click();await page.getByRole('dialog').getByRole('button',{name:'Discard changes',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='boards');await page.goBack();await page.getByLabel('HTML source',{exact:true}).waitFor();assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),source);
  // A competing saved revision must never overwrite a typed draft silently.
  await page.getByLabel('HTML source',{exact:true}).fill('<h1>My unsaved draft</h1>');
  await request(`/api/projects/${project.id}/reports/${saved.id}`,{title:'Quarterly review',html:'<h1>Concurrent version</h1>',revision:1});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByText(/changed.*reload/i).first().waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'<h1>My unsaved draft</h1>');
  await page.getByRole('button',{name:'Reload saved version',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(input=>input.value==='<h1>Concurrent version</h1>'));
  await page.goto(selectedUrl);await page.getByRole('alert').filter({hasText:'The saved item changed.'}).waitFor();assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);assert.equal(await page.locator('iframe').count(),0);
  await page.getByRole('button',{name:'Reload saved version',exact:true}).click();await page.getByLabel('HTML source',{exact:true}).waitFor();assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'<h1>Concurrent version</h1>');
  const restoredReportUrl=page.url();
  for(const suffix of ['&reportQuery=kind%3Dreport','&view=reports']){let reads=0;const count=(req:any)=>{if(new URL(req.url()).pathname.includes(`/api/projects/${project.id}/reports`))reads++;};page.on('request',count);await page.goto(restoredReportUrl+suffix);await page.getByRole('alert').filter({hasText:'This report link is invalid.'}).waitFor();assert.equal(reads,0);page.off('request',count);}
  await page.goto(restoredReportUrl);await page.getByLabel('HTML source',{exact:true}).waitFor();
  // An old response cannot replace the draft after leaving and returning to the same target.
  await boards.click();await section('Reports','Saved reports');
  let detailReceived!:()=>void,releaseDetail!:()=>void,detailFinished!:()=>void;
  const detailIntercepted=new Promise<void>(resolve=>{detailReceived=resolve;}),detailReleased=new Promise<void>(resolve=>{releaseDetail=resolve;}),detailComplete=new Promise<void>(resolve=>{detailFinished=resolve;});
  const detailPath=`**/api/projects/${project.id}/reports/${saved.id}`;
  let firstDetail=true;
  await page.route(detailPath,async(route:any)=>{
    if(!firstDetail){await route.fallback();return;}firstDetail=false;
    const response=await route.fetch();detailReceived();await detailReleased;
    try{await route.fulfill({response});}catch{/* Leaving the target aborts the old read. */}finally{detailFinished();}
  });
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  await Promise.race([detailIntercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Report detail was not intercepted.')),10000))]);
  await page.goBack();
  await page.getByRole('button',{name:'Quarterly review',exact:true}).waitFor();
  assert.equal(new URLSearchParams(new URL(page.url()).searchParams.get('reportQuery')??'').get('id'),null);assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);
  await page.goForward();await page.getByLabel('HTML source',{exact:true}).waitFor();assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'<h1>Concurrent version</h1>');
  await page.getByLabel('HTML source',{exact:true}).fill('Protected returning draft');
  releaseDetail();await detailComplete;await page.unroute(detailPath);
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'Protected returning draft');
  await page.getByLabel('HTML source',{exact:true}).fill('<h1>Concurrent version</h1>');
  console.log('PASS report UI: real save/reload, preserved private source, isolated preview and optimistic-conflict draft preservation');

  const panel=page.getByRole('region',{name:'Reports and sharing',exact:true});
  // The same history round trip must also reject an old empty share list.
  await boards.click();await section('Reports','Saved reports');
  let shareReceived!:()=>void,releaseShares!:()=>void,shareFinished!:()=>void,firstShares=true;
  const sharesIntercepted=new Promise<void>(resolve=>{shareReceived=resolve;}),sharesReleased=new Promise<void>(resolve=>{releaseShares=resolve;}),sharesComplete=new Promise<void>(resolve=>{shareFinished=resolve;});
  const sharesPath=`**/api/projects/${project.id}/reports/${saved.id}/shares`;
  await page.route(sharesPath,async(route:any)=>{
    if(route.request().method()!=='GET'||!firstShares){await route.fallback();return;}firstShares=false;
    const response=await route.fetch();shareReceived();await sharesReleased;
    try{await route.fulfill({response});}catch{/* The departed read may already have been aborted. */}finally{shareFinished();}
  });
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  await Promise.race([sharesIntercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Share history was not intercepted.')),10000))]);
  await page.goBack();await page.getByRole('button',{name:'Quarterly review',exact:true}).waitFor();await page.goForward();
  await page.getByLabel('Link label',{exact:true}).waitFor();
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Fixture clipboard denial');}}});
    document.execCommand=()=>false;
  });
  await page.getByLabel('Link label',{exact:true}).fill('Client alpha');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 2/}).check();
  // Synchronous duplicate activation must still produce exactly one capability.
  await page.getByRole('button',{name:'Create public link',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  const oneTime=page.getByLabel('One-time share URL',{exact:true});
  await oneTime.waitFor();const firstUrl=await oneTime.inputValue();
  await page.getByText('Link created. Copy it now; the full URL is shown only once.',{exact:true}).waitFor();
  releaseShares();await sharesComplete;await page.unroute(sharesPath);
  await page.getByText('Client alpha',{exact:true}).waitFor();assert.equal(await oneTime.inputValue(),firstUrl);
  let links=await request(`/api/projects/${project.id}/reports/${saved.id}/shares`);
  assert.equal(links.shares.length,1);assert.equal(JSON.stringify(links).includes(firstUrl),false);
  const publicSnapshot=await context.request.get(firstUrl);assert.equal(publicSnapshot.status(),200);assert.match(await publicSnapshot.text(),/Concurrent version/);
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await page.getByText(/Automatic copy is unavailable/).waitFor();
  const manualCopy=page.getByRole('textbox',{name:'Select and copy',exact:true});
  assert.equal(await manualCopy.inputValue(),firstUrl);
  assert.equal(await manualCopy.evaluate((input:HTMLInputElement)=>input===document.activeElement&&input.readOnly),true);
  const selection=await manualCopy.evaluate((input:HTMLInputElement)=>({start:input.selectionStart,end:input.selectionEnd,length:input.value.length}));
  assert.deepEqual(selection,{start:0,end:selection.length,length:selection.length});
  await page.getByLabel('HTML source',{exact:true}).fill('<h1>Private version three</h1>');
  assert.equal(await page.getByRole('button',{name:'Create public link',exact:true}).isDisabled(),true,'Dirty source cannot be shared as though saved.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByText('Report saved. Preview the saved version before sharing.').waitFor();
  assert.equal(await oneTime.count(),0);assert.match(await (await context.request.get(firstUrl)).text(),/Concurrent version/);
  const firstRow=page.getByRole('row').filter({hasText:'Client alpha'});
  await firstRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await firstRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await firstRow.getByText('Revoked',{exact:true}).waitFor();assert.equal((await context.request.get(firstUrl)).status(),404);
  await page.getByLabel('Link label',{exact:true}).fill('Current link');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();
  const currentUrl=await oneTime.inputValue();
  const currentRow=page.getByRole('row').filter({hasText:'Current link'});
  await currentRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await currentRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await currentRow.getByText('Revoked',{exact:true}).waitFor();assert.equal(await oneTime.count(),0);assert.equal((await context.request.get(currentUrl)).status(),404);
  console.log('PASS report UI: duplicate-submit lock, immutable snapshots, dirty-share gate, clipboard fallback and matching-link revocation clears the capability');

  let failTemplateRead=true;
  const templatePath=`**/api/projects/${project.id}/report-templates`;
  await page.route(templatePath,async(route:any)=>{
    if(route.request().method()==='GET'&&failTemplateRead) {failTemplateRead=false;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Template list temporarily unavailable.'})});}
    else await route.continue();
  });
  await panel.getByRole('button',{name:'Templates',exact:true}).click();
  await page.getByText('No templates saved yet.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Quarterly review',exact:true}).count(),0,'Access-error recovery must refresh the selected collection, not the previous tab.');
  await page.unroute(templatePath);
  await page.getByRole('button',{name:'New template',exact:true}).click();
  await page.getByLabel('Template name',{exact:true}).fill('Monthly briefing');
  await page.getByLabel('Template brief',{exact:true}).fill('Compare the previous month. <script>This is plain text.</script>');
  await page.getByRole('button',{name:'Save template',exact:true}).click();await page.getByText('Template saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Copy brief',exact:true}).click();await page.getByText(/Automatic copy is unavailable/).waitFor();
  assert.equal(await manualCopy.inputValue(),'Compare the previous month. <script>This is plain text.</script>');
  assert.equal(await manualCopy.evaluate((input:HTMLInputElement)=>input===document.activeElement&&input.readOnly&&input.selectionEnd===input.value.length&&input.selectionStart===0),true);
  await page.getByLabel('Template brief',{exact:true}).fill('Changed draft');
  assert.equal(await panel.getByRole('button',{name:'Reports',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Cancel edits',exact:true}).click();
  assert.equal(await page.getByLabel('Template brief',{exact:true}).inputValue(),'Compare the previous month. <script>This is plain text.</script>');
  await page.getByRole('button',{name:'Delete template',exact:true}).click();await page.getByRole('button',{name:'Delete template permanently',exact:true}).click();
  await page.getByText('Template deleted.',{exact:true}).waitFor();assert.equal((await request(`/api/projects/${project.id}/report-templates`)).templates.length,0);
  await panel.getByRole('button',{name:'Reports',exact:true}).click();await page.getByRole('button',{name:'Quarterly review',exact:true}).click();

  let received!:()=>void,release!:()=>void;
  const intercepted=new Promise<void>(resolve=>{received=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const sharePath=`**/api/projects/${project.id}/reports/${saved.id}/shares`;
  await page.route(sharePath,async(route:any)=>{
    if(route.request().method()!=='POST') {await route.continue();return;}
    const response=await route.fetch();received();await released;
    try {await route.fulfill({response});} catch {/* The component aborts its request on project switch. */}
  });
  await page.getByLabel('Link label',{exact:true}).fill('Delayed result');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();
  await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Share response was not intercepted.')),10000))]);
  await selectProject('Other report project');release();
  await section('Reports','Saved reports');await page.getByText('No reports saved yet.',{exact:false}).waitFor();
  assert.equal(await oneTime.count(),0);assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);
  await page.unroute(sharePath);
  await selectProject('UI report project');await section('Reports','Saved reports');await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  assert.equal(await oneTime.count(),0,'Returning to a record must never recover a one-time URL.');
  await page.getByLabel('Link label',{exact:true}).fill('Clipboard race');await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{(window as unknown as {finishFixtureCopy:()=>void}).finishFixtureCopy=resolve;})}}));
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await selectProject('Other report project');
  await page.evaluate(()=>(window as unknown as {finishFixtureCopy:()=>void}).finishFixtureCopy());
  await section('Reports','Saved reports');await page.getByText('No reports saved yet.',{exact:false}).waitFor();
  assert.equal(await page.getByText('Link copied.',{exact:true}).count(),0);assert.equal(await oneTime.count(),0);
  await page.getByRole('button',{name:'New report',exact:true}).click();await page.getByLabel('Report title',{exact:true}).fill('Temporary deletion check');await page.getByLabel('HTML source',{exact:true}).fill('<p>Delete this fixture</p>');
  await page.getByRole('button',{name:'Save report',exact:true}).click();await page.getByRole('checkbox',{name:/I have reviewed saved revision 1/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();const deletedUrl=await oneTime.inputValue();
  await page.getByRole('button',{name:'Delete report',exact:true}).click();await page.getByRole('button',{name:'Delete report permanently',exact:true}).click();
  await page.getByText('Report deleted. Its public links are now unavailable.',{exact:true}).waitFor();
  assert.equal((await context.request.get(deletedUrl)).status(),404);assert.equal((await request(`/api/projects/${otherProject.id}/reports`)).reports.length,0);
  console.log('PASS report UI: templates are reusable plain text; dirty navigation, deletion and late share/clipboard results cannot cross project boundaries');

  await selectProject('UI report project');await section('Reports','Saved reports');
  let failHistory=true;
  await page.route(sharePath,async(route:any)=>{
    if(route.request().method()==='GET'&&failHistory) {failHistory=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Link history temporarily unavailable.'})});}
    else await route.continue();
  });
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();await page.getByRole('alert').filter({hasText:'Link history temporarily unavailable.'}).waitFor();
  await page.getByText('Link history has not loaded. Choose Refresh links to try again.',{exact:true}).waitFor();
  assert.equal(await page.getByText('No public links have been created.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Refresh links',exact:true}).click();await page.getByRole('row').filter({hasText:'Client alpha'}).waitFor();await page.unroute(sharePath);
  await mkdir('private/reports-screenshots',{recursive:true});
  for(const width of [1280,360]) {
    await setViewport(page,{width,height:900});
    if(width===360) {
      const menu=page.getByRole('button',{name:'Menu',exact:true});
      assert.equal(await menu.getAttribute('aria-expanded'),'false');
      const controlledSidebar=await menu.evaluate((button:HTMLButtonElement)=>{
        const id=button.getAttribute('aria-controls'),matches=Array.from(document.querySelectorAll('[id]')).filter(element=>element.id===id);
        return {id,count:matches.length,isSidebar:matches[0]===document.querySelector('aside.t98-shell-sidebar')};
      });
      assert.ok(controlledSidebar.id?.trim());assert.equal(controlledSidebar.count,1);assert.equal(controlledSidebar.isSidebar,true);
      const sidebar=page.locator('aside.t98-shell-sidebar');
      await sidebar.waitFor({state:'hidden',timeout:10000});
      assert.equal(await sidebar.getAttribute('data-sidebar-state'),'closed');assert.equal(await sidebar.evaluate((element:HTMLElement)=>element.hasAttribute('inert')),true);
      assert.equal(await page.getByRole('navigation',{name:'Sections',exact:true}).isVisible(),false);
      await menu.focus();await page.keyboard.press('Enter');
      const close=page.getByRole('button',{name:'Close navigation',exact:true});await close.waitFor({state:'visible',timeout:10000});
      assert.equal(await page.locator('.t98-app-topbar__menu').getAttribute('aria-expanded'),'true');
      // With a project selected, the sidebar Settings link opens its Tracking code settings.
      const install=page.locator('aside.t98-shell-sidebar').getByRole('link',{name:'Settings',exact:true});
      await install.focus();await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Tracking code',level:1,exact:true}).waitFor();
      await page.waitForFunction(()=>document.activeElement===document.querySelector('main'));
      await sidebar.waitFor({state:'hidden',timeout:10000});
      assert.equal(await sidebar.getAttribute('data-sidebar-state'),'closed');assert.equal(await sidebar.evaluate((element:HTMLElement)=>element.hasAttribute('inert')),true);
      assert.equal(await menu.getAttribute('aria-expanded'),'false');assert.equal(await page.getByRole('navigation',{name:'Sections',exact:true}).isVisible(),false);
      assert.match(await page.locator('pre.snippet[aria-label="Tracking code"]').textContent()??'',/tracker\.js/);
      await menu.focus();await page.keyboard.press('Space');
      const overview=page.getByRole('navigation',{name:'Sections',exact:true}).getByRole('link',{name:'Overview',exact:true});
      await overview.focus();await page.keyboard.press('Enter');
      const recent=page.getByRole('navigation',{name:'Overview pages',exact:true}).getByRole('link',{name:'Latest events',exact:true});
      await recent.focus();await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Overview',level:1,exact:true}).waitFor();
      assert.equal(await recent.getAttribute('aria-current'),'page');
      assert.equal(await page.locator('pre.snippet').count(),0,'Recent events must not expose the installation panel.');
      await selectProject('Other report project');await page.getByRole('heading',{name:'Overview',level:1,exact:true}).waitFor();
      await selectProject('UI report project');await section('Reports','Saved reports');await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
      await page.getByRole('row').filter({hasText:'Client alpha'}).waitFor();
      assert.equal(await menu.getAttribute('aria-expanded'),'false');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Report UI must fit viewport ${width}.`);
    assert.equal(await oneTime.count(),0,'Screenshots must not contain a one-time capability.');
    await page.screenshot({path:`private/reports-screenshots/reports-${width}.png`,fullPage:true});
  }
  const extraOwner=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[extraOwner,'Permission fixture owner',`${randomUUID()}@reports-ui.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,extraOwner]);
  await page.getByLabel('Link label',{exact:true}).fill('Permission race');await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,me.user.id]);
  await page.getByRole('button',{name:'Create public link',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Your current role cannot perform this report action.'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);assert.equal(await page.getByRole('region',{name:'Public report links',exact:true}).count(),0);assert.equal(await oneTime.count(),0);
  assert.equal(await page.locator('iframe').count(),0,'Authorization loss must purge the saved preview as well as the editor.');
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).isEditable(),true);
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,me.user.id]);
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();
  await page.getByRole('button',{name:'New report',exact:true}).waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#report-body')?.readOnly===true);
  assert.equal(await page.getByRole('button',{name:'New report',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Delete report',exact:true}).count(),0);
  await removeMember(workspaceId,extraOwner,me.user.id);
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();await page.getByRole('alert').filter({hasText:'Report not found or unavailable.'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Quarterly review',exact:true}).count(),0);
  await pool.query('DELETE FROM session WHERE "userId"=$1',[me.user.id]);await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();assert.equal(await panel.count(),0);
  console.log('PASS report UI: late account/identity navigation, keyboard mobile menu and focus, separate install/events views, 1280/360px layouts, owner-to-editor sharing denial, viewer read-only state, removal purge and revoked session sign-in');
  assert.equal(pageErrors,0,'Report flows must not raise uncaught browser errors.');
} finally {releaseProjects?.();await browser?.close();await closeDatabase();}
