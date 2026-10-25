import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';

// Source contracts for #457 feedback controls. The browser suites exercise the rendered behaviour; these checks keep the
// canonical @ten98/ui controls in place and the irreversible-action contracts unchanged.
const source=(name:string)=>readFile(name,'utf8');
const components=async()=>(await readdir('src',{recursive:true})).map(name=>name.replaceAll('\\','/')).filter(name=>name.endsWith('.tsx'));

test('the root route provides transient notifications to every page',async()=>{
 const root=await source('src/routes/__root.tsx');
 assert.match(root,/import \{ToastProvider\} from '@ten98\/ui';/);
 assert.match(root,/<body><ToastProvider><Outlet \/><\/ToastProvider><Scripts \/><\/body>/);
});

test('copy-link controls use the shared CopyButton instead of raw clipboard writes',async()=>{
 for(const name of ['src/components/TrackedAssetsPanel.tsx','src/components/BoardsPanel.tsx','src/components/ReportsPanel.tsx']){
  const code=await source(name);
  assert.doesNotMatch(code,/navigator\.clipboard/,name+' must not write the clipboard itself');
  assert.match(code,/<CopyButton value=\{[^}]+\} label='Copy link' messages=\{\{copied:'Link copied\.'/,name+' uses the canonical copy-link control');
 }
});

test('transient confirmations are toasts while new links and unconfirmed retries stay inline',async()=>{
 const reports=await source('src/components/ReportsPanel.tsx');
 for(const message of ["'Template saved.'","'Template deleted.'","'Link revoked. New visits cannot read this snapshot.'"])assert.match(reports,new RegExp('toast\\([^;]*'+message.replace(/[.?]/g,'\\$&')),message+' is a toast');
 assert.match(reports,/setNotice\('Link created\. Copy it now; the full URL is shown only once\.'\)/,'A one-time link stays inline');
 const boards=await source('src/components/BoardsPanel.tsx');
 assert.match(boards,/toast\('Board deleted\.'\)/);
 assert.match(boards,/toast\('Shared link revoked\.'\)/);
 assert.match(boards,/New shared-board URL/,'A new shared link stays inline');
 assert.match(boards,/Retry same shared-link request/,'An unconfirmed shared-link request keeps its inline retry');
 assert.match(boards,/Retry same board request/,'An unconfirmed board request keeps its inline retry');
 const tracked=await source('src/components/TrackedAssetsPanel.tsx');
 assert.match(tracked,/New share link/,'A new tracked share link stays inline');
});

test('board revoke and delete ask through a danger confirmation dialog',async()=>{
 const boards=await source('src/components/BoardsPanel.tsx');
 assert.match(boards,/useConfirmDialog\(\{danger:true\}\)/);
 assert.match(boards,/confirmAction\(\{title:'Revoke this shared link\?'[^}]*confirmLabel:'Revoke link'\}\)\)start\('revoke',row\)/);
 assert.match(boards,/confirmAction\(\{title:'Delete this board\?'[^}]*confirmLabel:'Delete board'\}\)\)startWrite\('delete'\)/);
 assert.doesNotMatch(boards,/confirm\('(?:Revoke|Delete) this/,'Revoke and delete never use the native confirm');
});

test('website delete and analytics reset keep exact-retry contracts inside DangerZoneFlow',async()=>{
 const del=await source('src/components/ProjectDeletePanel.tsx'),reset=await source('src/components/AnalyticsResetPanel.tsx');
 assert.match(del,/<DangerZoneFlow /);
 assert.match(del,/id:'delete-website',title:'Delete website',description:'[^']+',confirmLabel:'Delete website',confirmationText:'DELETE',retryOnly:true/);
 assert.match(del,/unconfirmed=\{attempt\?/);
 // A retry reuses the stored request: same request ID, revision and confirmation, never a new one.
 assert.match(del,/const input=write\?pendingRequest\.current\?\?projectDeleteInput\.parse\(\{requestId:crypto\.randomUUID\(\),revision:verified!\.item!\.revision,confirmation:'DELETE'\}\)/);
 assert.match(reset,/<DangerZoneFlow /);
 assert.match(reset,/id:'reset-analytics',title:'Reset analytics',description:'[^']+',confirmLabel:'Permanently reset analytics',confirmationText:'RESET',retryOnly:true/);
 assert.match(reset,/unconfirmed=\{attempt\?/);
 assert.match(reset,/const input=write\?pending\.current\?\?analyticsResetInput\.parse\(\{requestId:crypto\.randomUUID\(\),revision:verified!\.revision,confirmation:'RESET'\}\)/);
 for(const code of [del,reset])assert.doesNotMatch(code,/Type (?:DELETE|RESET) to confirm<input/,'The typed phrase lives in the confirmation dialog');
});

test('raw disclosure, toggle-group and load-more markup is replaced by the shared controls',async()=>{
 for(const name of await components()){
  if(!name.startsWith('components/')||['components/AccountPreferencesPanel.tsx','components/TeamPanel.tsx','components/ApiKeysPanel.tsx'].includes(name))continue;
  // Plain and card-level disclosures use Disclosure. Details that carry app classes, refs, focus targets or controlled state remain until
  // their styling and focus behaviour move to the shared component.
  assert.doesNotMatch(await source('src/'+name),/<details(?: open| className="card(?: stack)?"| style=\{\{[^{}]*\}\}| key=\{[^{}]*\})*>\s*<summary(?: style=\{[^>]*\}| className="[^"]*")?>/,name+' uses Disclosure');
 }
 for(const name of ['ReportsPanel','RevenuePanel','AIQueryAnalysisPanel','KeywordResearchPanel']){
  const code=await source('src/components/'+name+'.tsx');
  assert.match(code,/<SegmentedControl label=/,name+' uses SegmentedControl');
  assert.doesNotMatch(code,/aria-pressed/,name+' keeps no hand-built toggle group');
 }
 assert.match(await source('src/components/SiteAuditPanel.tsx'),/<SegmentedControl label="Link direction"/);
 const annotations=await source('src/components/AnnotationsPanel.tsx'),reports=await source('src/components/ReportsPanel.tsx');
 assert.match(annotations,/<LoadMore hasMore=\{cursor!==null\} busy=\{busy\} shown=\{rows\.length\} itemLabel="notes" label="Load more notes"/);
 assert.match(reports,/<LoadMore hasMore=\{next!==null\}/);
 assert.match(reports,/<LoadMore hasMore=\{sharesNext!==null\}/);
});
