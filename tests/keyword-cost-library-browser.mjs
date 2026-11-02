// Opt-in synthetic KeywordResearchPanel acceptance: no database, provider, or real paid work.
// 120-second total deadline, at most 100 synthetic API requests and one browser context.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium,setViewport} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_KEYWORD_COST_BROWSER,'1');
const started=Date.now(),id=n=>`${n}0000000-0000-4000-8000-000000000001`,pid=id(3),cid=id(4),rid=id(5),qid=id(6),at='2026-10-19T12:00:00.000Z';
const request={connectionId:cid,mode:'overview',keywords:['native keyword','second keyword'],locationCode:2840,languageCode:'en',limit:100};
const original={id:rid,...request,request,status:'failed',createdAt:at,completedAt:at,estimateUsd:'0.123456',actualUsd:'0.000000',chargeStatus:'settled',canCancel:false,diagnostic:'Synthetic provider refusal',result:null,resultExpired:false};
const baseline=process.env.TEN98_KEYWORD_COST_BASELINE==='1'?await readFile('private/swarm/keyword-cost-before.tsx','utf8'):null;
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'private/swarm/keyword-cost-vite-cache',appType:'custom',plugins:baseline?[{name:'keyword-cost-previous-source',enforce:'pre',load(path){if(path.replaceAll('\\','/').endsWith('/src/components/KeywordResearchPanel.tsx'))return baseline;}}]:[],resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','@ten98/ui']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyword cost acceptance</title><div id="root"></div><script type="module" src="/tests/keyword-cost-library-browser-fixture.tsx"></script></html>');});
let browser,page,context,held=null,role='owner',paused=false,vault=true,value=null,deny=null,holdQuote=false,holdStart=false,loseStart=false;
const calls=[],outbound=[],errors=[],json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const totalDeadline=setTimeout(()=>{console.error('Keyword cost 120-second deadline exceeded');process.exitCode=1;void browser?.close();void server.close();},120000);
try{
 await server.listen();const address=server.httpServer.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 browser=await launchChromium();context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!==origin){outbound.push(url.href);return route.abort();}if(!path.startsWith('/api/'))return route.continue();
  calls.push({method:req.method(),path,body:req.postDataJSON()});assert.ok(calls.length<=100,'Synthetic request cap');
  const base='/api/projects/'+pid+'/keyword-research';
  if(path==='/api/projects/'+pid+'/saved-keywords/list'&&req.method()==='POST')return json(route,{role,revision:0,metricRevision:'synthetic',filters:{},total:0,rows:[],tags:[],nextCursor:null,tagsNextCursor:null});
  if(path==='/api/projects/'+pid+'/saved-keywords/refreshes'&&req.method()==='GET')return json(route,{role,plans:[]});
  if(path==='/api/projects/'+pid+'/saved-keywords'&&req.method()==='POST')return json(route,{role,revision:1,metricRevision:'synthetic',replayed:false,ids:[],missingIds:[],inserted:2,existing:0,skippedOlder:0,metricsUpdated:2,affected:2});
  if(path===base&&req.method()==='GET'){
   if(deny){const code=deny;deny=null;return json(route,{error:'Synthetic access denied'},code);}
   return json(route,{role,vaultConfigured:vault,spendingPaused:paused,connections:[{id:cid,name:'Synthetic account',checkStatus:'ok'}],catalog:{updatedAt:at,markets:[{locationCode:2840,locationName:'United States',languageCode:'en',languageName:'English'}]},runs:value?[value]:[]});
  }
  if(path===base+'/quote'&&req.method()==='POST'){
   const quote={id:qid,request:req.postDataJSON(),connectionName:'Synthetic account',estimateUsd:'0.123456',perTaskUsd:'0.010001',perItemUsd:'0.000002',upperItems:100,priceAsOf:at,expiresAt:new Date(Date.now()+300000).toISOString()};
   if(holdQuote){holdQuote=false;held={route,data:{quote}};return;}return json(route,{quote});
  }
  if(path===base+'/runs'&&req.method()==='POST'){
   if(holdStart){holdStart=false;held={route,data:{run:value??original}};return;}
   if(loseStart){loseStart=false;return json(route,{error:'Synthetic lost start response'},503);}return json(route,{run:value??original});
  }
  if(path===base+'/runs/'+rid&&req.method()==='GET')return json(route,{run:value});
  if(path===base+'/runs/'+rid+'/reconcile'&&req.method()==='POST')return json(route,{run:value,reconciliation:{status:'inconclusive',message:'Synthetic free metadata check; charge remains unknown.'}});
  if(path===base+'/runs/'+rid+'/cancel'&&req.method()==='POST'){value={...value,status:'cancelled',chargeStatus:'cancelled',canCancel:false};return json(route,{run:value});}
  // A changed project is intentionally inaccessible; no unexpected API can escape the fixture.
  if(path==='/api/projects/'+id(7)+'/keyword-research')return json(route,{error:'Synthetic other project denied'},404);
  outbound.push(req.method()+' '+path);return route.abort();
 });
 const button=name=>page.getByRole('button',{name,exact:true}),cost=title=>page.getByRole('region',{name:title,exact:true});
 const fresh=async(options={})=>{
  if(held){await held.route.abort().catch(()=>{});held=null;}await page?.close();
  role=options.role??'owner';paused=options.paused??false;vault=options.vault??true;value=options.value??null;deny=options.deny??null;loseStart=false;holdQuote=false;holdStart=false;
  page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date()});await page.goto(origin);if(options.deny===401){await page.getByRole('heading',{name:'Fixture signed out'}).waitFor();return;}await page.getByRole('heading',{name:'Keyword research',exact:true}).waitFor();await button('Reload access').waitFor();
  if(!options.deny)await page.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
 };
 const fill=async()=>{await page.getByLabel('Keywords (one per line)',{exact:true}).fill('Native Keyword\nSecond Keyword');await page.getByLabel('Country or territory and language',{exact:true}).selectOption('2840|en');};
 const showCost=async()=>{const summary=page.locator('summary').filter({hasText:/^Request details$/});await summary.waitFor();if(!await summary.evaluate(element=>element.parentElement.open))await summary.click();await cost('Run cost').waitFor();};
 const prepare=async()=>{await fill();await button('Run').click();await showCost();};
 const open=async run=>{await fresh({value:run});await button('View').click();await showCost();};
 const expire=async()=>{await page.clock.setSystemTime(new Date(Date.now()+360000));await page.clock.runFor(1100);};
 const names=['zulu keyword','alpha keyword','unknown keyword'],metrics=names.map((keyword,index)=>({keyword,searchVolume:index===2?null:index===1?900:0,cpcUsd:index===2?null:index===1?'1.250000':'0.000000',competition:null,competitionLevel:null,keywordDifficulty:index===2?null:index===1?75:0,intent:index===2?null:index===1?'commercial':'informational',metricsUpdatedAt:null,intentUpdatedAt:null,monthlySearches:[]}));
 await open({...original,keywords:names,request:{...request,keywords:names},status:'completed',diagnostic:null,actualUsd:'0.123456',result:{retrievedAt:at,source:'DataForSEO Labs / Google',missingKeywords:[],totalCount:3,limited:false,rows:metrics}});
 const table=page.getByRole('region',{name:'Keyword data table',exact:true}),beforeFilter=calls.length;
 for(const label of ['Include keyword text','Exclude keyword text','Keyword intent'])assert.ok(await page.getByLabel(label,{exact:true}).evaluate(element=>element.getBoundingClientRect().height)>=44,'Keyword filters meet the app touch-target contract');
 await page.getByLabel('Include keyword text',{exact:true}).fill('KEYWORD');await page.getByLabel('Exclude keyword text',{exact:true}).fill('unknown');
 assert.equal(await table.getByRole('checkbox',{name:'Select research keyword unknown keyword',exact:true}).count(),0);
 await page.getByLabel('Keyword intent',{exact:true}).selectOption('commercial');assert.equal(await table.getByRole('checkbox').count(),2);
 await table.getByRole('checkbox',{name:'Select research keyword alpha keyword',exact:true}).check();
 await page.getByText('Metric ranges',{exact:true}).click();
 await page.getByLabel('Keyword intent',{exact:true}).selectOption('');await page.getByLabel('Max monthly volume',{exact:true}).fill('0');
 assert.equal(await table.getByRole('checkbox',{name:'Select research keyword alpha keyword',exact:true}).count(),0);await button('Select all filtered results').click();
 await page.getByText(/2 selected · 1 hidden by keyword filters/).waitFor();
 await page.getByLabel('Min monthly volume',{exact:true}).fill('1');await page.getByText('Maximum must be at least the minimum.',{exact:true}).waitFor();assert.equal(await button('Select all filtered results').isDisabled(),true);
 await page.getByLabel('Min monthly volume',{exact:true}).fill('invalid');assert.equal(await page.getByLabel('Min monthly volume',{exact:true}).inputValue(),'invalid');await page.getByText('Use a whole number from 0 to 9007199254740991.',{exact:true}).waitFor();
 await button('Reset keyword filters').click();await page.getByLabel('Min historical CPC (USD)',{exact:true}).fill('0.000001');assert.equal(await table.getByRole('checkbox',{name:'Select research keyword zulu keyword',exact:true}).count(),0);
 await page.getByLabel('Max historical CPC (USD)',{exact:true}).fill('1.250000');await page.getByLabel('Min organic difficulty',{exact:true}).fill('75');await page.getByLabel('Max organic difficulty',{exact:true}).fill('75');assert.equal(await table.getByRole('checkbox').count(),2);
 await page.getByLabel('Include keyword text',{exact:true}).fill('nothing matches');await table.getByText('No matching keyword results',{exact:true}).waitFor();await button('Reset keyword filters').click();
 assert.equal(await table.getByRole('checkbox',{name:'Select research keyword alpha keyword',exact:true}).isChecked(),true);assert.equal(await table.getByRole('checkbox',{name:'Select research keyword zulu keyword',exact:true}).isChecked(),true);
 await table.getByPlaceholder('Search retained keywords…').fill('alpha keyword');await table.getByRole('checkbox',{name:'Select research keyword alpha keyword',exact:true}).check();assert.equal(await table.getByRole('checkbox',{name:'Select research keyword zulu keyword',exact:true}).count(),0);
 await table.getByPlaceholder('Search retained keywords…').fill('');await table.getByRole('button',{name:'Sort by Keyword',exact:true}).click();assert.equal(await table.getByRole('checkbox',{name:'Select research keyword alpha keyword',exact:true}).isChecked(),true);await table.getByRole('checkbox',{name:'Select research keyword zulu keyword',exact:true}).check();assert.equal(calls.length,beforeFilter,'Retained filtering, sorting and selection make no API request.');
 assert.ok((await table.getByRole('row').filter({hasText:'unknown keyword'}).innerText()).includes('Unavailable'));assert.ok((await table.getByRole('row').filter({hasText:'zulu keyword'}).innerText()).includes('0'));
 await button('Save 2 selected keywords').click();await page.getByRole('heading',{name:'Save 2 research keywords',exact:true}).waitFor();await button('Save keywords').click();await page.getByText('Keywords saved.',{exact:true}).waitFor();assert.deepEqual(calls.filter(call=>call.path==='/api/projects/'+pid+'/saved-keywords'&&call.method==='POST').at(-1).body.source,{type:'run',runId:rid,rowIndexes:[1,0]});assert.equal(calls.slice(beforeFilter).some(call=>call.path.endsWith('/quote')||call.path.endsWith('/runs')),false);
 console.log('PASS retained result search/sort preserves original row identities through saved-keyword handoff without provider work; zero and unavailable stay distinct.');
 await fresh();await fill();holdStart=true;const beforeRun=calls.length;await button('Run').focus();await page.keyboard.press('Enter');for(let i=0;!held&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert.ok(held,'The one-action Run reached Start');
 const initialStart=calls.filter(c=>c.path.endsWith('/runs')&&c.method==='POST').at(-1);assert.match(initialStart.body.requestKey,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.deepEqual(initialStart.body,{quoteId:qid,requestKey:initialStart.body.requestKey});assert.equal(await button('Run').isDisabled(),true);assert.equal(await page.getByLabel('Keywords (one per line)',{exact:true}).isDisabled(),true);assert.equal(await cost('Quote cost').count(),0);assert.equal(await button('Prepare quote').count(),0);await page.keyboard.press('Enter');assert.equal(calls.slice(beforeRun).filter(c=>c.path.endsWith('/quote')).length,1);assert.equal(calls.slice(beforeRun).filter(c=>c.path.endsWith('/runs')&&c.method==='POST').length,1);const pendingStart=held;held=null;await json(pendingStart.route,pendingStart.data);await page.waitForFunction(()=>document.activeElement?.textContent==='Keyword overview results');assert.equal(await page.getByRole('heading',{name:'Keyword overview results',exact:true}).evaluate(e=>e===document.activeElement),true);await showCost();assert.ok((await cost('Run cost').innerText()).includes('$0.000000'));assert.ok((await cost('Run cost').innerText()).includes('A failed run can still be charged'));
 console.log('PASS one keyboard Run prepares and starts exactly once, freezes inputs, hides quote UI and opens the saved result.');

 await fresh();await fill();loseStart=true;await button('Run').click();await button('Retry same request').waitFor();await expire();assert.equal(await cost('Quote cost').count(),0);assert.equal(await button('Retry same request').isEnabled(),true);assert.equal(await page.getByLabel('Keywords (one per line)',{exact:true}).isDisabled(),true);
 const first=calls.filter(c=>c.path.endsWith('/runs')&&c.method==='POST').at(-1),quotesBeforeRetry=calls.filter(c=>c.path.endsWith('/quote')).length;await button('Retry same request').click();await showCost();assert.deepEqual(calls.filter(c=>c.path.endsWith('/runs')&&c.method==='POST').at(-1).body,first.body);assert.equal(calls.filter(c=>c.path.endsWith('/quote')).length,quotesBeforeRetry);
 await fresh({paused:true});await fill();assert.equal(await button('Run').isDisabled(),true);await page.getByText(/Spending is paused for this workspace/).waitFor();await fresh({vault:false});await page.getByText(/Credential storage is not configured/).waitFor();
 console.log('PASS lost-start retries preserve the original identity after expiry without another preparation; manual pause blocks new work.');

 await open({...original,status:'uncertain',chargeStatus:'uncertain',actualUsd:'0.000000'});assert.ok((await cost('Run cost').innerText()).includes('Settled amount unknown'));assert.equal(await cost('Run cost').getByText('$0.000000',{exact:true}).count(),0);await page.getByText('Check provider charge (owner)',{exact:true}).click();await button('Check provider charge').click();await page.getByText('Synthetic free metadata check; charge remains unknown.',{exact:true}).waitFor();assert.equal(calls.filter(c=>c.path.endsWith('/reconcile')).at(-1).body.connectionId,cid);
 await open({...original,status:'cancelled',chargeStatus:'cancelled',actualUsd:null});assert.ok((await cost('Run cost').innerText()).includes('Charge cancelled; no settled charge reported.'));
 await open({...original,status:'completed',chargeStatus:'settled',actualUsd:null});assert.ok((await cost('Run cost').innerText()).includes('Settled amount unknown'));assert.equal(await cost('Run cost').getByText('$0.000000',{exact:true}).count(),0);
 await open({...original,status:'completed',actualUsd:'0.654321',resultExpired:true});assert.ok((await cost('Run cost').innerText()).includes('$0.654321'));await page.getByText(/charge record above is unaffected/).waitFor();
 await open({...original,status:'queued',chargeStatus:'reserved',actualUsd:null,canCancel:true});assert.ok((await cost('Run cost').innerText()).includes('no settled charge yet'));await button('Cancel run').click();await page.getByRole('dialog',{name:'Cancel this queued run?',exact:true}).getByRole('button',{name:'Cancel run',exact:true}).click();await page.getByText('Charge cancelled; no settled charge reported.',{exact:true}).waitFor();
 console.log('PASS uncertain wins over zero, free owner metadata reconciliation, known cancellation, unknown versus zero, pending and retained cost after result expiry.');

 await fresh({role:'viewer',value:original});assert.equal(await button('Run').count(),0);await button('View').click();await showCost();assert.equal(await button('Check provider charge').count(),0);deny=403;await button('Check status').click();await page.getByText(/Access unavailable/).waitFor();assert.equal(await cost('Run cost').count(),0);
 await fresh({deny:401});await page.getByRole('heading',{name:'Fixture signed out'}).waitFor();
 await fresh();await page.getByLabel('Keywords (one per line)',{exact:true}).fill('native keyword');await page.getByLabel('Country or territory and language',{exact:true}).selectOption('2840|en');holdQuote=true;await button('Run').click();await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));for(let i=0;!held&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert.ok(held);await page.evaluate(projectId=>window.keywordCostFixture.scope({projectId}),id(7));await page.getByText(/Access unavailable/).waitFor();const old=held;held=null;await json(old.route,old.data).catch(()=>{});assert.equal(await cost('Quote cost').count(),0);
 console.log('PASS viewer/current access gates, denied-data purge, sign-out and late quote cannot cross a changed project.');

 // Inspect rendered HTML text with its actual computed colors and ancestor backgrounds.
 const contrast=async region=>region.evaluate(element=>{
  const rgba=text=>{const m=text.match(/[\d.]+/g);if(!m)return [0,0,0,0];return [Number(m[0]),Number(m[1]),Number(m[2]),m[3]===undefined?1:Number(m[3])];};
  const mix=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3]));
  const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),failures=[];let count=0,node;
  while(node=walker.nextNode()){
   if(!node.textContent.trim())continue;const el=node.parentElement,s=getComputedStyle(el);if(!el.getClientRects().length||s.visibility!=='visible'||s.display==='none')continue;
   let bg=[255,255,255],ancestors=[];for(let p=el;p;p=p.parentElement)ancestors.push(p);for(const p of ancestors.reverse())bg=mix(rgba(getComputedStyle(p).backgroundColor),bg);
   const fg=mix(rgba(s.color),bg),a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);count++;if(ratio<4.5)failures.push({text:node.textContent.trim(),ratio,color:s.color,bg});
  }return {count,failures};
 });
 const visual=[];
 for(const theme of ['light','dark'])for(const width of [320,1440]){
  await fresh();await page.emulateMedia({colorScheme:theme});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.fontSize='200%';},theme);await setViewport(page,{width,height:1000});await prepare();
  const region=cost('Run cost');await region.scrollIntoViewIfNeeded();await page.evaluate(async()=>{getComputedStyle(document.documentElement).color;await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().iterations)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme}/${width} has page overflow`);
  const result=await contrast(region);assert.ok(result.count>10);assert.deepEqual(result.failures,[],`${theme}/${width} contrast`);
  visual.push({theme,width,textNodes:result.count,background:await region.evaluate(e=>getComputedStyle(e).backgroundColor)});
 }
 assert.notEqual(visual[0].background,visual[2].background,'The theme must change actual rendered colors');
 assert.deepEqual(outbound,[]);assert.deepEqual(errors,[]);assert.ok(Date.now()-started<120000);
 console.log('PASS 320/1440 light/dark at 200% font, actual rendered text contrast >=4.5, zero page overflow; '+JSON.stringify(visual));
 console.log(JSON.stringify({syntheticRequests:calls.length,contexts:1,externalRequests:outbound.length,seconds:(Date.now()-started)/1000,baseline:!!baseline}));
}finally{clearTimeout(totalDeadline);if(held)await held.route.abort().catch(()=>{});await browser?.close();await server.close();}
