// Opt-in compiled AppShell acceptance with disposable native viewer authentication.
// Feature GET replies below are synthetic presentation evidence, never provider/RBAC acceptance.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {loadNavigationSession} from './fixtures/navigation-review.mjs';
import {launchChromium,setViewport} from './helpers/playwright.mjs';

// The runtime-supplied browser has no installed types; keep this suite's used surface checked.
type Box={x:number;y:number;width:number;height:number};
type RequestRecord={method:string;path:string};
type NativeRead=RequestRecord&{status:number};
type Measurement={viewport:string;answer:Box|null;text:Box|null;recurring:Box|null}|{viewport:string;fit:{document:number;viewport:number}};
type Response={status():number;json():Promise<unknown>};
type Route={request():{url():string;method():string};abort():Promise<void>;continue():Promise<void>;fetch(options:{maxRedirects:number}):Promise<Response>;fulfill(options:{response:Response}|{status:number;contentType:string;body:string}):Promise<void>};
type Locator={getByRole(role:string,options:{name:string;exact?:boolean}):Locator;getByText(text:string|RegExp,options?:{exact:boolean}):Locator;count():Promise<number>;waitFor():Promise<void>;click():Promise<void>;boundingBox():Promise<Box|null>;innerText():Promise<string>};
type Page=Locator&{setDefaultTimeout(milliseconds:number):void;on(event:'pageerror',handler:(error:Error)=>void):void;locator(selector:string):Locator;goto(url:string):Promise<unknown>;url():string;reload():Promise<unknown>;goBack():Promise<unknown>;goForward():Promise<unknown>;evaluate<T>(callback:()=>T):Promise<T>;screenshot(options:{path:string;fullPage:boolean}):Promise<Buffer>};
type Browser={newContext(options:{storageState:unknown;viewport:{width:number;height:number};serviceWorkers:'block';locale:string;timezoneId:string}):Promise<{route(pattern:string,handler:(route:Route)=>Promise<void>):Promise<void>;newPage():Promise<Page>}>;close():Promise<void>};

assert.equal(process.env.TEN98_PROMPT_NAVIGATION_SHELL_BROWSER,'1');
assert.equal(process.env.TEN98_SHELL_FIXTURE,undefined,'Create fresh native authentication; no persisted session.');
const evidence=resolve('private/swarm/ai-native-shell-20261104/captures');
await mkdir(evidence,{recursive:true});
const baseUrl=process.env.BASE_URL??process.env.APP_URL;assert.ok(baseUrl);
const fixture=await loadNavigationSession({baseUrl});
assert.equal(fixture.synthetic,true);assert.equal(fixture.role,'viewer');
const entry=new URL(fixture.url),origin=entry.origin,workspace=entry.searchParams.get('workspace'),project=entry.searchParams.get('project');
assert.ok(workspace);assert.ok(project);
const id=(n:number)=>`${n}0000000-0000-4000-8000-000000000001`,cid=id(4),prompt=id(5),version=id(6),run=id(7),at='2026-10-13T12:00:00.000Z';
const input={connectionId:id(9),promptId:prompt,versionId:version,systemText:'Synthetic copied system',models:['openai/gpt-4o-mini'],maxCompletionTokens:1024};
const original={id:cid,preparationId:id(8),createdAt:at,cancelRequested:false,prompt:{id:prompt,versionId:version,textPreview:'Authored fixture prompt'},canCancel:false,input,messages:[{role:'system',content:input.systemText},{role:'user',content:'Authored fixture prompt'}],inputExpired:false,cache:{reused:false,available:false},answerMode:'individual',runs:[{id:run,model:'openai/gpt-4o-mini',provider:'OpenAI',status:'completed',requestStatus:'settled',dispatchedAt:at,completedAt:at,diagnostic:null,resultExpired:false,result:{text:'Retained fixture answer',resolvedModel:'openai/gpt-4o-mini',provider:'OpenAI',finishReason:'stop',promptTokens:10,completionTokens:5,receivedAt:at},generationId:'gen-synthetic-receipt'}]};
const summary=(value:typeof original)=>({...value,runs:value.runs.map(({result,generationId,...item})=>item)});
const base='/api/projects/'+project+'/prompt-executions';
const href=(values:Record<string,string>)=>origin+'/?'+new URLSearchParams({workspace,project,view:'prompts',...values});
const calls:RequestRecord[]=[],nativeReads:NativeRead[]=[],unexpected:string[]=[],errors:string[]=[],measurements:Measurement[]=[];
let browser:Browser|undefined,page:Page|undefined,detailStatus:number|null=null,stage='startup';
const value=structuredClone(original);
const json=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
const capture=async(name:string)=>{assert.ok(page);return page.screenshot({path:resolve(evidence,name+'.png'),fullPage:true});};
try{
 const launched:Browser=await launchChromium();browser=launched;
 const context=await browser.newContext({storageState:fixture.storageState,viewport:{width:1266,height:712},serviceWorkers:'block',locale:'en-US',timezoneId:'UTC'});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  if(url.origin!==origin){unexpected.push('external request blocked');return route.abort();}
  if(!path.startsWith('/api/')){assert.equal(method,'GET');return route.continue();}
  calls.push({method,path});assert.equal(method,'GET','Saved selection must never issue a feature write.');
  if(['/api/session','/api/me','/api/account/preferences',`/api/workspaces/${workspace}/projects`].includes(path)){
   const response=await route.fetch({maxRedirects:0});assert.equal(response.status(),200);const data=await response.json();
   if(path==='/api/me'){const me=z.object({workspaces:z.array(z.object({id:z.uuid(),role:z.string()}))}).parse(data);assert.equal(me.workspaces.find(item=>item.id===workspace)?.role,'viewer','Native membership remains viewer.');}
   if(path===`/api/workspaces/${workspace}/projects`){const projects=z.object({projects:z.array(z.object({id:z.uuid()}))}).parse(data);assert.ok(projects.projects.some(item=>item.id===project));}
   nativeReads.push({method,path,status:response.status()});return route.fulfill({response});
  }
  if(path===`/api/projects/${project}/events`)return json(route,{events:[],total:0,retainedFrom:null});
  if(path===`/api/projects/${project}/prompts`)return json(route,{role:'viewer',items:[],nextCursor:null});
  if(path===base)return json(route,{role:'viewer',models:['openai/gpt-4o-mini','openai/gpt-4o'],vaultConfigured:false,requestsPaused:true,connections:[],comparisons:[summary(value)],cache:{available:false},scheduling:{available:true,kind:'owner-approved-text-v1'}});
  if(path===base+'/comparisons/'+cid+'/summary'){const status=detailStatus;detailStatus=null;return status?json(route,{error:'Synthetic presentation access denied'},status):json(route,{role:'viewer',comparison:summary(value)});}
  if(path===base+'/runs/'+run)return json(route,{role:'viewer',comparisonId:cid,run:value.runs[0],citations:{count:0,pageSize:20}});
  unexpected.push(method+' '+path);return route.abort();
 });
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const main=page.getByRole('main',{name:'Main content',exact:true}),button=(name:string)=>main.getByRole('button',{name,exact:true});
 const answer=()=>main.getByText('Retained fixture answer',{exact:true}),region=()=>main.getByRole('region',{name:'Answer from GPT-4o-mini',exact:true});
 const recent=()=>main.getByRole('heading',{name:'Recent runs',exact:true});
 const ready=async()=>{await answer().waitFor();await button('Refresh status').waitFor();};
 stage='native shell and history';await page.goto(href({promptView:'history'}));await recent().waitFor();
 assert.equal(await page.locator('header.t98-shell-header--topbar').count(),1);assert.ok(nativeReads.some(item=>item.path==='/api/me'));
 assert.equal(await button('Run answers').count(),0);assert.equal(await button('Stop remaining requests').count(),0);
 console.log('PASS shell: native synthetic viewer and canonical AppShell read-only history.');
 stage='first screen';await button('Open run').click();await ready();
 const receiptUrl=page.url();assert.equal(new URL(receiptUrl).searchParams.get('promptRun'),cid);assert.equal(new URL(receiptUrl).searchParams.get('promptId'),prompt);
 await page.evaluate(()=>scrollTo(0,0));
 const box=await region().boundingBox(),textBox=await answer().boundingBox(),recurring=await main.getByText('Recurring prompt tracking',{exact:true}).boundingBox();
 measurements.push({viewport:'1266x712',answer:box,text:textBox,recurring});
 assert.ok(textBox&&textBox.y>=0&&textBox.y+textBox.height<=712,'Answer text must be fully visible on the first screen.');
 assert.ok(box&&box.height>=20&&box.y+box.height<=712,'The complete one-line retained answer is visible.');
 assert.ok(recurring&&recurring.y>box.y+box.height,'Recurring controls follow the answer.');await capture('desktop-first-screen');
 console.log('PASS shell: 1266x712 first screen shows answer text and recurring controls follow it.');
 stage='reload and history';await page.reload();await ready();assert.equal(page.url(),receiptUrl);await page.goBack();await recent().waitFor();assert.equal(await answer().count(),0);await page.goForward();await ready();assert.equal(page.url(),receiptUrl);
 console.log('PASS shell: saved receipt identity survives refresh back and forward.');
 stage='library return';await button('Back to saved prompts').click();await main.getByRole('heading',{name:'Saved prompts',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.get('promptRun'),null);await page.goBack();await ready();
 console.log('PASS shell: library return clears receipt and back restores the same saved answer.');
 stage='invalid routes';const invalidFeatureReads=calls.filter(item=>item.path.startsWith(base)).length;await page.goto(href({promptView:'run',promptRun:'not-a-run',promptId:prompt}));await main.getByRole('heading',{name:'Saved run unavailable',exact:true}).waitFor();assert.equal(await answer().count(),0);assert.equal(calls.filter(item=>item.path.startsWith(base)).length,invalidFeatureReads);await page.reload();await main.getByRole('heading',{name:'Saved run unavailable',exact:true}).waitFor();assert.equal(calls.filter(item=>item.path.startsWith(base)).length,invalidFeatureReads);
 const duplicateFeatureReads=calls.filter(item=>item.path.startsWith(base)).length;await page.goto(receiptUrl+'&promptView=run');await main.getByRole('heading',{name:'Saved run unavailable',exact:true}).waitFor();assert.equal(await answer().count(),0);assert.equal(calls.filter(item=>item.path.startsWith(base)).length,duplicateFeatureReads);
 console.log('PASS shell: malformed and duplicate routes reject saved answers without feature reads.');
 stage='denied and wrong scope';await page.goto(receiptUrl);await ready();for(const status of [403,404]){detailStatus=status;await button('Refresh status').click();await button('Reload access').waitFor();assert.equal(await answer().count(),0);await button('Reload access').click();await ready();}
 await page.goto(href({project:id(1),promptView:'run',promptRun:cid,promptId:prompt}));await main.getByRole('heading',{name:'Saved run unavailable',exact:true}).waitFor();assert.equal(await answer().count(),0);
 console.log('PASS shell: presentation403404 and inaccessible native project scope clear stale answers.');
 stage='320px long answer';value.runs[0].result.text='Long retained answer '+('continuousword'.repeat(30)+' العربية 中文 ').repeat(60);await setViewport(page,{width:320,height:850});await page.goto(receiptUrl);await region().waitFor();await main.getByText(/^Long retained answer /).waitFor();
 const fit=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));measurements.push({viewport:'320x850',fit});assert.ok(fit.document<=fit.viewport,'Long answer fits 320px without page overflow.');await capture('narrow-long-answer');
 console.log('PASS shell: 320px long continuous multilingual answer fits without page overflow.');
 assert.ok(calls.length<=250);assert.equal(calls.some(item=>item.method!=='GET'),false);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 console.log('PASS shell: zero feature writes provider calls external requests and browser errors.');
}catch(error){await capture('failure').catch(()=>{});console.error(JSON.stringify({stage,url:page?.url(),body:await page?.locator('body').innerText().catch(()=>null)}));throw error;}
finally{await writeFile(resolve(evidence,'presentation-receipt.json'),JSON.stringify({stage,measurements,calls,nativeReads,unexpected,errors,featurePresentationOnly:true,storageStatePersisted:false},null,2));await browser?.close();}
