// Independent phases use fresh actors/projects, preserving production rate limits.
import assert from 'node:assert/strict';
import {createKeywordCase} from './fixtures.mjs';
import {fixtureGuard} from './guard.mjs';
import {browserSession,providerCounts,href,loseFirstPost,holdNextGet,deferred,bounded,captureFailure,assertLayout,selectedKeywordFocus,openKeywordForm} from './browser.mjs';
import {runKeyword} from './jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {stopJobs} from '../../src/server/jobs.ts';
fixtureGuard();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);

const {pool}=getDatabase();let session,stage='initial';const cleanups=[];
async function phase(label){
  await session?.browser.close();const group=await createKeywordCase(label);session=await browserSession(chromium,group.owner);const {page}=session;
  await page.goto(href(group,'keywords'),{waitUntil:'networkidle'});
  const panel=page.locator('section[aria-label="Keyword research"]');await panel.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
  return {group,page,panel,B:'/api/projects/'+group.main.id+'/keyword-research'};
}
async function overview(panel,text){
  await openKeywordForm(panel);
  await panel.getByLabel('Keywords (one per line)',{exact:true}).fill(text);await panel.getByLabel('Country and language',{exact:true}).selectOption('2840|en');
  await panel.getByRole('button',{name:'Prepare quote',exact:true}).click();await panel.getByRole('heading',{name:'Quote for keyword overview',exact:true}).waitFor();
}
async function start(page,panel,B,{double=false}={}){
  const response=page.waitForResponse(response=>response.url().endsWith(B+'/runs')&&response.request().method()==='POST');
  const button=panel.getByRole('button',{name:'Run quoted research (paid)',exact:true});
  if(double)await button.evaluate(element=>{element.click();element.click();});else await button.click();
  const received=await response;assert.equal(received.status(),202);const run=(await received.json()).run;await selectedKeywordFocus(page,panel);return run;
}
async function completed(page,panel,B,run){
  const response=page.waitForResponse(response=>response.url().endsWith(B+'/runs/'+run.id)&&response.request().method()==='GET');
  await panel.getByRole('button',{name:'Check status',exact:true}).click();const saved=(await (await response).json()).run;assert.equal(saved.id,run.id);
  await panel.getByRole('region',{name:'Keyword data table',exact:true}).locator(':scope > table > tbody > tr').filter({hasText:saved.result.rows[0].keyword}).waitFor();
}
function noBrowserErrors(){assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);}

try{
  stage='ideas limits25/50/100';{
    const {group,page,panel,B}=await phase('ideas');const before=await providerCounts();
    await panel.getByLabel('Research mode',{exact:true}).selectOption('ideas');
    for(const limit of [25,50,100]){
      await openKeywordForm(panel);
      await panel.getByLabel('Seed keyword',{exact:true}).fill('Synthetic ideas '+limit);await panel.getByLabel('Max ideas',{exact:true}).selectOption(String(limit));
      await panel.getByLabel('Country and language',{exact:true}).selectOption('2840|en');
      const response=page.waitForResponse(response=>response.url().endsWith(B+'/quote')&&response.request().method()==='POST');
      await panel.getByRole('button',{name:'Prepare quote',exact:true}).click();const quote=(await (await response).json()).quote;
      assert.equal(quote.request.limit,limit);assert.equal(quote.request.mode,'ideas');assert.deepEqual(quote.request.keywords,['synthetic ideas '+limit]);
      const run=await start(page,panel,B);await runKeyword(run.id);await completed(page,panel,B,run);
      assert.match(await panel.innerText(),new RegExp('Showing 1 of 250 keywords \\(bounded to the requested limit of '+limit+'\\)'));
    }
    assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE project_id=$1',[group.main.id])).rows[0].n,'3');
    assert.equal((await providerCounts())['keyword-dispatch']-(before['keyword-dispatch']??0),3);await assertLayout(page,'keyword-ideas');noBrowserErrors();
    console.log('PASS keyword ideas25/50/100 preserve exact limit, explicit bounded results and one dispatch per intent.');
  }

  stage='quote lock/double click and held poll cancellation';{
    const {group,page,panel,B}=await phase('cancel');const before=await providerCounts(),entered=deferred(),release=deferred();let quoteCalls=0,startCalls=0;
    const quotePath='**'+B+'/quote';
    await page.route(quotePath,async route=>{quoteCalls++;const response=await route.fetch();entered.resolve();await release.promise;await route.fulfill({response});});
    cleanups.push(async()=>{release.resolve();await page.unroute(quotePath);});
    await panel.getByLabel('Keywords (one per line)',{exact:true}).fill('Cancellation fixture');await panel.getByLabel('Country and language',{exact:true}).selectOption('2840|en');
    await panel.getByRole('button',{name:'Prepare quote',exact:true}).evaluate(element=>{element.click();element.click();});await bounded(entered.promise);
    assert.equal(await panel.getByLabel('Keywords (one per line)',{exact:true}).isDisabled(),true);assert.equal(await panel.getByRole('button',{name:'Refresh markets',exact:true}).isDisabled(),true);
    release.resolve();await panel.getByRole('heading',{name:'Quote for keyword overview',exact:true}).waitFor();await page.unroute(quotePath);assert.equal(quoteCalls,1);
    const countStarts=route=>{if(route.request().method()==='POST')startCalls++;return route.continue();};await page.route('**'+B+'/runs',countStarts);
    const run=await start(page,panel,B,{double:true});await page.unroute('**'+B+'/runs',countStarts);assert.equal(startCalls,1);
    const held=await holdNextGet(page,'**'+B+'/runs/'+run.id);cleanups.push(held.dispose);await bounded(held.entered,10_000);
    assert.equal(await panel.getByRole('button',{name:'Cancel run',exact:true}).isEnabled(),true,'Cancel must remain usable during an interruptible poll.');
    page.once('dialog',dialog=>dialog.accept());await panel.getByRole('button',{name:'Cancel run',exact:true}).click();
    const selected=panel.locator('[aria-label="Selected run"]');await selected.getByText(/^Cancelled ·/).waitFor();
    held.release();await held.dispose();await page.waitForTimeout(250);assert.ok(await selected.getByText(/^Cancelled ·/).isVisible());
    assert.equal(await selected.getByRole('button',{name:'Cancel run',exact:true}).count(),0);
    const saved=(await pool.query('SELECT r.status,p.status AS charge FROM keyword_research_run r JOIN provider_request p ON p.id=r.id WHERE r.id=$1',[run.id])).rows[0];assert.deepEqual(saved,{status:'cancelled',charge:'cancelled'});
    await runKeyword(run.id);assert.equal((await providerCounts())['keyword-dispatch']??0,before['keyword-dispatch']??0);noBrowserErrors();
    console.log('PASS quote mutation locks, same-tick double clicks, real held-poll cancellation and zero paid dispatch.');
  }

  stage='503/malformed acknowledged starts and expiry recovery';{
    const {group,page,panel,B}=await phase('ack-faults');await page.clock.install();const before=await providerCounts();
    for(const failure of ['503','malformed','malformed-row']){
      await overview(panel,'Acknowledgement '+failure);
      const lost=await loseFirstPost(page,'**'+B+'/runs',{failure,onCommitted:async(body,accepted)=>{
        await runKeyword(accepted.run.id);await pool.query("UPDATE keyword_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[body.quoteId]);
      }});cleanups.push(lost.dispose);
      await panel.getByRole('button',{name:'Run quoted research (paid)',exact:true}).evaluate(element=>{element.click();element.click();});
      await panel.getByRole('button',{name:'Retry same request',exact:true}).waitFor();assert.equal(lost.bodies.length,1);
      await page.clock.setSystemTime(new Date(Date.now()+360_000));await page.waitForTimeout(1100);
      assert.equal(await panel.getByLabel('Keywords (one per line)',{exact:true}).isDisabled(),true);
      assert.equal(await panel.getByRole('button',{name:'Retry same request',exact:true}).isEnabled(),true);
      const retry=panel.getByRole('button',{name:'Retry same request',exact:true}),retried=page.waitForResponse(response=>response.url().endsWith(B+'/runs')&&response.request().method()==='POST');
      await retry.click();const response=await retried;assert.equal(response.status(),202);const accepted=(await response.json()).run;
      assert.deepEqual(accepted.request.keywords,['acknowledgement '+failure]);await retry.waitFor({state:'hidden'});
      await panel.getByRole('region',{name:'Keyword data table',exact:true}).locator(':scope > table > tbody > tr').filter({hasText:'acknowledgement '+failure}).waitFor();
      assert.equal(lost.bodies.length,2);assert.deepEqual(lost.bodies[0],lost.bodies[1]);
      assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE quote_id=$1',[lost.bodies[0].quoteId])).rows[0].n,'1');
      await lost.dispose();await page.clock.setSystemTime(new Date());
    }
    assert.equal((await providerCounts())['keyword-dispatch']-(before['keyword-dispatch']??0),3);noBrowserErrors();
    console.log('PASS503, malformed2xx and malformed nested result acknowledgement loss preserve the accepted quote/key through browser/server expiry.');
  }

  stage='known receipt reconciliation without paid retry';{
    const {group,page,panel,B}=await phase('reconcile');const before=await providerCounts();await overview(panel,'Known reconciliation fixture');
    const run=await start(page,panel,B);await runKeyword(run.id,'receipt-only');await panel.getByRole('button',{name:'Check status',exact:true}).click();
    await panel.getByText('Check provider charge (owner)',{exact:true}).click();await panel.getByRole('button',{name:'Check provider charge',exact:true}).click();
    const selected=panel.locator('[aria-label="Selected run"]');await selected.getByText(/^Reconciled ·/).waitFor();
    assert.match(await selected.innerText(),/Only the cost was reconciled/);assert.match(await selected.innerText(),/\$0\.012120/);
    assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[group.workspace.id])).rows[0].paused,true);
    const after=await providerCounts();assert.equal(after['keyword-dispatch']-(before['keyword-dispatch']??0),1);assert.equal(after['keyword-reconcile']-(before['keyword-reconcile']??0),1);
    assert.equal(await panel.getByRole('region',{name:'Keyword data table',exact:true}).count(),0);noBrowserErrors();
    console.log('PASS owner metadata reconciliation records known cost, retains pause and does not recover/invent a result or rerun paid work.');
  }

  stage='current403/404 purge cached results and quote';{
    const {page,panel,B}=await phase('access-loss');await overview(panel,'Access loss completed fixture');const run=await start(page,panel,B);await runKeyword(run.id);await completed(page,panel,B,run);
    for(const status of [403,404]){
      await overview(panel,'Privileged draft '+status);const path='**'+B;
      const denial=route=>route.fulfill({status,json:{error:'Synthetic current access unavailable.'}});await page.route(path,denial);
      await panel.getByRole('button',{name:'Reload access',exact:true}).click();await panel.getByRole('alert').waitFor();
      assert.equal(await panel.getByRole('region',{name:'Keyword data table',exact:true}).count(),0);assert.equal(await panel.getByRole('heading',{name:'Quote for keyword overview',exact:true}).count(),0);
      assert.equal(await panel.getByLabel('Keywords (one per line)',{exact:true}).count(),0);assert.equal(await panel.getByRole('heading',{name:'Recent runs',exact:true}).count(),0);
      await page.unroute(path,denial);await panel.getByRole('button',{name:'Reload access',exact:true}).click();await panel.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
      assert.equal(await panel.getByLabel('Keywords (one per line)',{exact:true}).inputValue(),'');
      if(status===403){await panel.getByRole('region',{name:'Recent keyword runs',exact:true}).getByRole('button',{name:'View',exact:true}).click();await panel.getByRole('region',{name:'Keyword data table',exact:true}).waitFor();await selectedKeywordFocus(page,panel);}
    }
    noBrowserErrors();console.log('PASS current403/404 purge all privileged drafts, quotes and retained result controls before explicit reload.');
  }
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL keyword lifecycle stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{for(const cleanup of cleanups)await cleanup().catch(()=>{});await session?.browser.close();await stopJobs();await closeDatabase();}
