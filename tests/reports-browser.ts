import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {closeDatabase,getDatabase,assertSchema} from '../src/server/db.ts';
import {createWorkspace} from '../src/server/teams.ts';
import {createReportShare,revokeReportShare,saveReport} from '../src/server/reports.ts';

// Optional browser acceptance runner: installed tooling is supplied by the operator, never bundled in production.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1','Browser checks require an isolated local fixture.');
const config=getConfig(),local=['localhost','127.0.0.1','[::1]'];
assert.ok(local.includes(new URL(config.appUrl).hostname)&&local.includes(new URL(config.databaseUrl).hostname));
const playwrightPath=process.env.PLAYWRIGHT_MODULE;
assert.ok(playwrightPath,'Set PLAYWRIGHT_MODULE to an installed Playwright module URL.');
const {chromium}=await import(playwrightPath);
let hits=0;
const trap=createServer((_request,response)=>{hits++;response.writeHead(200,{'content-type':'text/plain'});response.end('Unexpected report request');});
await new Promise<void>((resolve,reject)=>{trap.once('error',reject);trap.listen(0,'127.0.0.1',resolve);});
const trapUrl=`http://127.0.0.1:${(trap.address() as AddressInfo).port}`;
let browser:any;
try {
  await assertSchema();
  const {pool}=getDatabase(),userId=randomUUID(),email=`${randomUUID()}@report-browser.integration.test`,password=randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Browser report reviewer',email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)',[randomUUID(),userId,'credential',await hashPassword(password)]);
  const {workspace}=await createWorkspace(userId,{name:'Browser report sandbox checks'}),projectId=randomUUID();
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)',[projectId,workspace.id,'Sandbox','https://sandbox.integration.test',randomUUID()]);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xUAAAAASUVORK5CYII=';
  const html=`<!doctype html><html><head><title>Static report</title><style>@import url('${trapUrl}/style'); @font-face{font-family:leak;src:url('${trapUrl}/font')} body{font-family:leak, sans-serif;background-image:url('${trapUrl}/css');color:rgb(12,34,56)}</style><base href="${trapUrl}/"><meta http-equiv="refresh" content="0;url=${trapUrl}/refresh"></head><body><h1>Isolated static report</h1><p id="result">Safe content</p><script>window.reportExecuted=true;parent.reportExecuted=true;fetch('${trapUrl}/script')</script><img src="${trapUrl}/img" onerror="window.reportExecuted=true"><img id="chart" src="${png}" alt="One pixel chart"><svg viewBox="0 0 10 10"><rect width="8" height="5" fill="blue"/><foreignObject><iframe src="${trapUrl}/foreign"></iframe></foreignObject><script>window.reportExecuted=true</script><use href="${trapUrl}/svg"/></svg><a id="navigate" href="${trapUrl}/navigate" target="_top" ping="${trapUrl}/ping">Link text</a><form action="${trapUrl}/submit"><input name="secret"><button>Submit</button></form><iframe src="${trapUrl}/frame"></iframe><object data="${trapUrl}/object"></object></body></html>`;
  const report=(await saveReport(projectId,userId,{title:'Sandbox evidence',html})).report;
  const share=await createReportShare(projectId,userId,report.id,{label:'Sandbox test',revision:1,expiresAt:new Date(Date.now()+86400000).toISOString()});
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});
  const context=await browser.newContext();
  const signIn=await context.request.post(`${config.appUrl}/api/auth/sign-in/email`,{headers:{origin:config.appUrl},data:{email,password}});
  assert.equal(signIn.status(),200,'Fixture sign-in must establish a real cookie session.');
  const cookies=await context.cookies(config.appUrl);assert.ok(cookies.some((cookie:any)=>cookie.name.includes('session_token')));
  const page=await context.newPage();
  await page.goto(config.appUrl,{waitUntil:'networkidle'});
  const preview=`${config.appUrl}/api/projects/${projectId}/reports/${report.id}/preview?revision=1`;
  for(const source of [preview,share.url]) {
    await page.evaluate((src:string)=>{document.querySelector('#report-frame')?.remove();const frame=document.createElement('iframe');frame.id='report-frame';frame.title='Isolated report';frame.setAttribute('sandbox','');frame.src=src;document.body.append(frame);},source);
    const frame=page.frameLocator('#report-frame');
    await frame.getByRole('heading',{name:'Isolated static report'}).waitFor();
    assert.equal(await frame.locator('script,form,iframe,object,base,meta[http-equiv],svg foreignObject,svg use').count(),0);
    assert.equal(await frame.locator('#navigate').getAttribute('href'),null);
    const frameHandle=await (await page.locator('#report-frame').elementHandle()).contentFrame();
    const isolation=await frameHandle.evaluate(()=>{
      let parentBlocked=false,cookieBlocked=false,storageBlocked=false;
      try {void parent.document.body;}catch{parentBlocked=true;}
      try {void document.cookie;}catch{cookieBlocked=true;}
      try {void localStorage.length;}catch{storageBlocked=true;}
      return {parentBlocked,cookieBlocked,storageBlocked,executed:Boolean((window as unknown as {reportExecuted?:boolean}).reportExecuted),color:getComputedStyle(document.body).color};
    });
    assert.deepEqual(isolation,{parentBlocked:true,cookieBlocked:true,storageBlocked:true,executed:false,color:'rgb(12, 34, 56)'});
    await frame.locator('#chart').evaluate((image:HTMLImageElement)=>image.decode());
    await frame.locator('#navigate').click();
    assert.equal(page.url(),`${config.appUrl}/`,'Report links must not navigate the parent.');
  }
  const publicPage=await context.newPage();
  const response=await publicPage.goto(share.url,{waitUntil:'networkidle'});
  assert.equal(response.status(),200);assert.equal(response.headers()['set-cookie'],undefined);
  assert.match(response.headers()['content-security-policy'],/^sandbox;/);
  assert.equal(await publicPage.evaluate(()=>{try {void document.cookie;return false;}catch{return true;}}),true,'The HTTP CSP must sandbox a direct public navigation too.');
  assert.equal(hits,0,'Report HTML/CSS/SVG must not make any outbound request.');
  await revokeReportShare(projectId,userId,report.id,share.share.id);
  const revoked=await publicPage.reload({waitUntil:'networkidle'});assert.equal(revoked.status(),404);
  await publicPage.getByRole('heading',{name:'Report unavailable'}).waitFor();
  assert.equal(await publicPage.getByRole('heading',{name:'Isolated static report'}).count(),0);
  console.log('PASS Edge: real authenticated preview and public share block scripts, parent/cookie/storage access, navigation and all external resources; static CSS/SVG/data images render; revocation reload is 404');
} finally {
  await browser?.close();trap.closeAllConnections();await new Promise<void>(resolve=>trap.close(()=>resolve()));await closeDatabase();
}
