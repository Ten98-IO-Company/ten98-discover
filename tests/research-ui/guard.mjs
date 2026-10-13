import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const evidenceDir=resolve(root,'test-results/research-ui');
export const appUrl=process.env.APP_URL;
export function fixtureGuard({manifest=true}={}){
  assert.equal(resolve(process.cwd()),root,'Run from this repository root.');
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  assert.equal(process.env.TEN98_RESEARCH_BROWSER,'1');
  assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply the installed Playwright module through PLAYWRIGHT_MODULE.');
  const app=new URL(appUrl),database=new URL(process.env.DATABASE_URL);
  assert.ok(['http:','https:'].includes(app.protocol)&&['localhost','127.0.0.1','[::1]'].includes(app.hostname));
  assert.ok(!app.username&&!app.password&&!app.search&&!app.hash&&app.pathname==='/'&&app.origin===appUrl);
  assert.equal(process.env.BASE_URL,appUrl);
  assert.ok(['postgres:','postgresql:'].includes(database.protocol)&&['localhost','127.0.0.1','[::1]'].includes(database.hostname));
  assert.ok(!database.search&&!database.hash,'Database connection overrides and fragments are forbidden.');
  assert.match(database.pathname,/^\/ten98_research_ui_[a-z0-9_]+$/);
  if(manifest){
    const saved=JSON.parse(readFileSync(resolve(evidenceDir,'manifest.json'),'utf8'));
    assert.equal(saved.database,database.pathname.slice(1));assert.equal(saved.appUrl,appUrl);assert.equal(saved.synthetic,true);
  }
  return {database:database.pathname.slice(1),appUrl};
}
