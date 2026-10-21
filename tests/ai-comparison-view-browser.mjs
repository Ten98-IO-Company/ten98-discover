// Optional pure presentation acceptance. No API/database/provider/preview traffic.
// TEN98_AI_COMPARISON_VIEW_BROWSER=1; PLAYWRIGHT_MODULE may name an installed ESM file.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_AI_COMPARISON_VIEW_BROWSER,'1');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/ai-comparison-view-vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI comparison presentation acceptance</title><div id="root"></div><script type="module" src="/tests/ai-comparison-view-browser-fixture.tsx"></script></html>');});
let browser,page;
const evidence=resolve('private/ai-comparison-view-evidence');
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 browser=await launchChromium();
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});page=await context.newPage();page.setDefaultTimeout(7000);
 const errors=[],outbound=[];page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin||url.pathname.startsWith('/api/')||req.method()!=='GET'||['fetch','xhr'].includes(req.resourceType())){outbound.push(req.method()+' '+url.pathname);return route.abort();}return route.continue();});
 const button=name=>page.getByRole('button',{name,exact:true}),field=name=>page.getByLabel(name,{exact:true}),main=page.locator('main');
 const patch=value=>page.evaluate(value=>window.aiComparisonViewFixture.patch(value),value),reset=()=>page.evaluate(()=>window.aiComparisonViewFixture.reset()),calls=()=>page.evaluate(()=>window.aiComparisonViewFixture.calls()),clear=()=>page.evaluate(()=>window.aiComparisonViewFixture.clear());
 const report=value=>page.evaluate(value=>window.aiComparisonViewFixture.patch({report:{...window.aiComparisonViewFixture.initial.report,...value}}),value);
 const table=column=>main.locator('table').filter({has:page.getByRole('columnheader',{name:column,exact:true})});
 const until=async check=>{const end=Date.now()+5000;while(!await check()){assert.ok(Date.now()<end,'Controlled view condition timed out');await new Promise(r=>setTimeout(r,15));}};
 await page.goto(origin);await page.getByRole('heading',{name:'Compare AI periods',exact:true,level:2}).waitFor();assert.deepEqual(await calls(),[]);
 assert.equal(await page.locator('#comparison-view-heading').getAttribute('tabindex'),'-1');assert.equal(await field('Prompt cohort').inputValue(),'current-neutral');
 assert.deepEqual(await field('Prompt cohort').locator('option').allTextContents(),['Currently classified neutral prompts','All prompts']);
 await field('Prompt cohort').selectOption('all');assert.deepEqual((await calls()).at(-1),['cohort','all']);
 for(const [name,event]of [['Apply cohort','apply'],['Reload comparison','reload'],['Back to insights','back']]){await button(name).focus();await page.keyboard.press('Enter');assert.deepEqual((await calls()).at(-1),[event]);}
 const prevented=await main.locator('form').evaluate(form=>!form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(prevented,true);assert.deepEqual((await calls()).at(-1),['apply']);assert.equal(new URL(page.url()).search,'');
 console.log('PASS native controlled cohort, exact labels, keyboard callbacks and prevented form navigation.');

 await reset();const initial=await page.evaluate(()=>window.aiComparisonViewFixture.initial);
 assert.equal(await field('Applied filters').innerText(),initial.filtersLabel);for(const text of [initial.report.scopeLabel,initial.report.snapshotLabel,initial.report.cohortLabel,initial.report.statusLabel,initial.report.basisLabel,...initial.report.warnings,'Recomputed using current project context; historical identities were not captured.','OpenRouter API · web search off'])assert.ok((await main.innerText()).includes(text),text);
 const metrics=table('Citation change');assert.equal(await metrics.count(),1);assert.deepEqual(await metrics.locator('thead th').allTextContents(),['Entity','Current mentions','Previous mentions','Change','Current citations','Previous citations','Citation change']);
 assert.deepEqual(await metrics.locator('tbody tr').first().locator('th,td').allTextContents(),['Synthetic brand','1 / 3 (33.333333%)','2 / 5 (40%)','-6.666667 pp','0','Unavailable','Unavailable']);
 assert.deepEqual((await table('Current coverage').locator('tbody tr').first().locator('td').allTextContents()).slice(0,10),Object.values(initial.report.cells[0]).slice(1,11));
 for(const period of initial.report.periods){await page.getByText(period.range,{exact:true}).waitFor();await page.getByText(period.details,{exact:true}).waitFor();}
 for(const name of ['Period coverage','Equal-cell mention and citation rates','Comparison evidence'])await page.getByRole('heading',{name,exact:true}).waitFor();
 for(const statusLabel of ['Open period · provisional rates; delta unavailable','No comparable cells','Coverage below90%']){await report({statusLabel,metrics:initial.report.metrics.map(m=>({...m,delta:'Unavailable',citationsDelta:'Unavailable'}))});assert.equal(await metrics.locator('tbody tr').first().locator('th,td').nth(3).innerText(),'Unavailable');await page.getByText(statusLabel,{exact:true}).waitFor();}
 assert.equal(await main.locator('img,script,iframe,a').count(),0);assert.equal(await page.evaluate(()=>window.comparisonExecuted),undefined);assert.deepEqual(await calls(),[]);
 console.log('PASS unchanged supplied exact fractions, zero/unavailable/deltas and current-context/provisional provenance; hostile text stays inert.');

 await reset();await page.evaluate(()=>window.scrollTo(0,0));
 const heading=page.getByRole('heading',{name:'Compare AI periods',exact:true,level:2}),header=heading.locator('..');
 for(const name of ['Back to insights','Reload comparison','Export comparison CSV'])assert.equal(await header.getByRole('button',{name,exact:true}).count(),1,'Header action: '+name);
 assert.equal(await button('Export comparison CSV').count(),1);
 const exportScope=page.getByText('Exports both periods, all cells and executions in the applied comparison; not only this page.',{exact:true});
 assert.equal(await exportScope.count(),1);assert.equal(await exportScope.isVisible(),true);
 assert.ok(await exportScope.evaluate((element,form)=>Boolean(element.compareDocumentPosition(form)&Node.DOCUMENT_POSITION_FOLLOWING),await main.locator('form').elementHandle()),'Whole-comparison export scope precedes filters');
 const coverageHeading=page.getByRole('heading',{name:'Period coverage',exact:true}),evidenceHeading=page.getByRole('heading',{name:'Comparison evidence',exact:true});
 assert.ok(await metrics.evaluate((element,coverage)=>Boolean(element.compareDocumentPosition(coverage)&Node.DOCUMENT_POSITION_FOLLOWING),await coverageHeading.elementHandle()),'Rates precede period coverage in DOM');
 assert.ok(await coverageHeading.evaluate((element,evidence)=>Boolean(element.compareDocumentPosition(evidence)&Node.DOCUMENT_POSITION_FOLLOWING),await evidenceHeading.elementHandle()),'Coverage precedes evidence controls');
 assert.ok((await metrics.locator('tbody tr').first().boundingBox()).y<900,'First result row appears in desktop viewport before coverage');
 for(const period of initial.report.periods){
  const coverage=main.locator('div').filter({has:page.getByText(period.range,{exact:true})}).filter({has:page.getByText(period.details,{exact:true})}).last();
  assert.equal(await coverage.getByText(period.label,{exact:true}).isVisible(),true);
  for(const [label,key]of [['Attempted','attempted'],['Eligible','eligible'],['Usable','usable'],['Identity unavailable','identityUnavailable'],['Identity invalid','identityInvalid'],['Matched','matched'],['Details','details']]){
   const value=coverage.getByText(label,{exact:true}).locator('..').getByText(period[key],{exact:true});
   assert.equal(await value.isVisible(),true,period.label+' '+label);
  }
 }
 assert.deepEqual(await calls(),[]);
 console.log('PASS one header export with whole-report scope, rates before complete visible period coverage, and results before evidence.');

 await reset();await field('Evidence entity').selectOption('other');assert.deepEqual((await calls()).at(-1),['entity','other']);assert.equal(await button('Show comparison cells').getAttribute('aria-pressed'),'true');
 for(const [name,period]of [['Show current executions for cell cell-one','current'],['Show previous executions for cell cell-one','previous']]){await button(name).click();assert.deepEqual((await calls()).at(-1),['cell','cell-one',period]);}
 for(const name of ['Show current executions for cell cell-two','Show previous executions for cell cell-two'])assert.equal(await button(name).isDisabled(),true);
 for(const [name,view]of [['Show current executions','current'],['Show previous executions','previous']]){await button(name).click();assert.deepEqual((await calls()).at(-1),['view',view]);assert.equal(await button(name).getAttribute('aria-pressed'),'true');assert.equal(await table('Answer eligibility').count(),1);assert.equal(await table('Current coverage').count(),0);}
 assert.deepEqual(await field('Evidence').locator('option').allTextContents(),['All executions','Usable answers','Unavailable answers','Mentions','Non-mentions','Citations']);
 for(const outcome of ['usable','unavailable','mentioned','not_mentioned','cited','all']){await field('Evidence').selectOption(outcome);assert.deepEqual((await calls()).at(-1),['outcome',outcome]);}
 await button('Open comparison for execution execution-one').click();assert.deepEqual((await calls()).at(-1),['open','execution-one']);assert.equal(await button('Open comparison for execution execution-two').isDisabled(),true);
 for(const [name,event]of [['Previous page','previous'],['Next page','next'],['Export comparison CSV','export']]){await button(name).click();assert.deepEqual((await calls()).at(-1),[event]);}
 await page.getByText('Exports both periods, all cells and executions in the applied comparison; not only this page.',{exact:true}).waitFor();await button('Show comparison cells').click();assert.deepEqual((await calls()).at(-1),['view','cells']);assert.equal(await field('Evidence').count(),0);
 console.log('PASS exact evidence/cell/receipt IDs, outcome unions, active views, independent capabilities and whole-comparison export.');

 for(const role of ['owner','admin','editor','viewer']){await patch({role});assert.equal(await button('Export comparison CSV').isEnabled(),true);assert.equal(await button('Apply cohort').isEnabled(),true);}
 await patch({role:null,error:'Current access unavailable.',notice:'Read access again.'});assert.equal(await page.getByRole('alert').innerText(),'Current access unavailable.');await page.getByRole('status').filter({hasText:'Read access again.'}).waitFor();assert.equal(await main.locator('form,table,input,select').count(),0);for(const value of [initial.filtersLabel,initial.report.scopeLabel,initial.report.snapshotLabel,'Synthetic brand','Immutable authored prompt'])assert.equal((await main.innerText()).includes(value),false);
 assert.equal(await button('Export comparison CSV').count(),0);assert.equal(await button('Back to insights').isEnabled(),true);assert.equal(await button('Reload comparison').isEnabled(),true);
 assert.equal(await exportScope.count(),0,'Role-null state hides relocated export scope');
 console.log('PASS all-member reading/export and role-null purge even when protected props remain supplied.');

 await reset();await patch({dirty:true,cohort:'all'});await page.getByText('Unapplied cohort change. The report below still uses the applied cohort.',{exact:true}).waitFor();await page.getByText(initial.report.cohortLabel,{exact:true}).waitFor();
 for(const name of ['Show comparison cells','Show current executions','Show previous executions','Show current executions for cell cell-one','Previous page','Next page','Export comparison CSV'])assert.equal(await button(name).isDisabled(),true,name);assert.equal(await field('Evidence entity').isDisabled(),true);assert.equal(await button('Apply cohort').isEnabled(),true);
 await report({view:'current'});assert.equal(await field('Evidence').isDisabled(),true);assert.equal(await button('Open comparison for execution execution-one').isDisabled(),true);
 await patch({canApply:false});await clear();await main.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.deepEqual(await calls(),[]);
 await reset();await report({canPrevious:false,canNext:false,canExport:false});for(const name of ['Previous page','Next page','Export comparison CSV'])assert.equal(await button(name).isDisabled(),true);
 await clear();await button('Export comparison CSV').evaluate(element=>element.click());assert.deepEqual(await calls(),[],'Native disabled header export does not call the handler');
 console.log('PASS staged cohort preserves applied labels and disables evidence/export; capabilities and synthetic submit remain guarded.');

 for(const flags of [{reading:true,exporting:false},{reading:false,exporting:true},{reading:true,exporting:true}]){await reset();await patch(flags);await clear();assert.ok(await page.getByRole('status').count()>0);for(const control of await main.locator('button,input,select').all()){const text=await control.innerText();if(['Back to insights','Cancel export'].includes(text))continue;assert.equal(await control.isDisabled(),true,text);}
  assert.equal(await button('Back to insights').isEnabled(),true);await button('Back to insights').click();assert.deepEqual((await calls()).at(-1),['back']);if(flags.exporting){assert.equal(await button('Cancel export').isEnabled(),true);await button('Cancel export').click();assert.deepEqual((await calls()).at(-1),['cancelExport']);}else assert.equal(await button('Cancel export').count(),0);
  const beforeDisabledExport=await calls();await button('Export comparison CSV').evaluate(element=>element.click());assert.deepEqual(await calls(),beforeDisabledExport,'Busy header export stays inert');
  if(flags.exporting)assert.equal(await header.getByRole('button',{name:'Cancel export',exact:true}).count(),1,'Cancel remains in the header while exporting');
  await main.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal((await calls()).some(c=>c[0]==='apply'),false);
 }
 console.log('PASS reading/exporting lock controls while Back and explicit Cancel export remain usable.');

 await reset();await report({cells:[],canPrevious:false,canNext:false});await page.getByText('No comparison cells match these filters.',{exact:true}).waitFor();assert.equal(await table('Current coverage').locator('tbody td:not([colspan])').count(),0);
 await report({view:'current',executions:[]});await page.getByText('No executions match this selection.',{exact:true}).waitFor();assert.equal(await table('Answer eligibility').locator('tbody td:not([colspan])').count(),0);
 await patch({report:null});assert.equal(await main.locator('table').count(),0);for(const name of ['Previous page','Next page','Export comparison CSV'])assert.equal(await button(name).count(),0);assert.equal(await field('Prompt cohort').isVisible(),true);
 assert.equal(await exportScope.count(),0,'Null report hides relocated export scope');
 console.log('PASS explicit empty selection and no invented report/evidence/pagination/export when report is null.');

 await reset();await mkdir(evidence,{recursive:true});
 for(const width of [1440,768,360,320])for(const view of ['cells','current']){await patch({role:'viewer'});await report({view});await page.setViewportSize({width,height:1000});await page.evaluate(()=>window.scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const tables=await main.locator('table').all(),labels=[];assert.equal(tables.length,2);for(const t of tables){const r=t.locator('xpath=ancestor::*[@role="region"][1]');assert.equal(await r.count(),1);assert.equal(await r.getAttribute('tabindex'),'0');const label=await r.getAttribute('aria-label');assert.ok(label);labels.push(label);assert.equal(await page.getByRole('region',{name:label,exact:true}).count(),1);assert.ok((await t.locator('caption').innerText()).trim());assert.equal(await t.locator('thead th:not([scope="col"])').count(),0);assert.ok((await t.boundingBox()).width>=(await t.getByRole('columnheader',{name:'Current coverage',exact:true}).count()?1100:760));assert.ok((await r.boundingBox()).width<=width);
   const hint=await r.getAttribute('aria-describedby');assert.ok(hint);for(const id of hint.split(/\s+/)){assert.equal(await page.locator('[id="'+id+'"]').count(),1);assert.equal(await page.locator('[id="'+id+'"]').innerText(),'Scroll horizontally to see every column.');}
   await r.evaluate(el=>el.scrollLeft=0);await r.focus();assert.equal(await r.evaluate(el=>el===document.activeElement),true);if(width===360){assert.ok(await r.evaluate(el=>el.scrollWidth>el.clientWidth));await page.keyboard.press('ArrowRight');await until(()=>r.evaluate(el=>el.scrollLeft>0));}
  }assert.equal(new Set(labels).size,labels.length);if(view==='cells'){const cells=table('Current coverage');for(const column of ['Prompt','Model','Identity','Status'])assert.ok((await cells.getByRole('columnheader',{name:column,exact:true}).boundingBox()).width>=120,'Readable '+column+' column');}else{const executions=table('Answer eligibility');for(const column of ['Model','Answer eligibility','Cell identity','Matches'])assert.ok((await executions.getByRole('columnheader',{name:column,exact:true}).boundingBox()).width>=120,'Readable '+column+' column');}assert.ok((await field('Applied filters').boundingBox()).width>=Math.min(width-40,600),'Readable applied scope');
  for(const control of await main.locator('button,input,select').all()){const box=await control.boundingBox();assert.ok(box&&box.height>=44,'44px target');}
  const ids=await main.locator('[id]').evaluateAll(nodes=>nodes.map(n=>n.id));assert.equal(new Set(ids).size,ids.length);
  await page.locator('#comparison-view-heading').focus();await main.getByRole('region').evaluateAll(nodes=>nodes.forEach(node=>node.scrollLeft=0));await page.screenshot({path:resolve(evidence,`comparison-${view}-${width}.png`),fullPage:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);console.log('PASS1440/768/360/320 independent keyboard-scroll tables,44px targets, unique hint IDs, inert longtext, no page overflow or view I/O.');
}catch(error){if(page&&!page.isClosed()){await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await server.close();}
