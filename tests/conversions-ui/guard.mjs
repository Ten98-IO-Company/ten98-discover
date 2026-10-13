import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const evidenceDir=resolve(root,'test-results/conversions-ui');
export const appUrl=process.env.APP_URL;
export function fixtureGuard({manifest=true}={}){
  assert.equal(resolve(process.cwd()),root,'Run from this repository root.');
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  assert.equal(process.env.TEN98_CONVERSIONS_BROWSER,'1');
  assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply an installed Playwright module explicitly.');
  assert.ok(!process.env.DATABASE_URL_FILE,'Use one explicit fixture DATABASE_URL.');
  const app=new URL(appUrl),database=new URL(process.env.DATABASE_URL);
  const local=['localhost','127.0.0.1','[::1]'];
  assert.ok(['http:','https:'].includes(app.protocol)&&local.includes(app.hostname));
  assert.ok(!app.username&&!app.password&&!app.search&&!app.hash&&app.pathname==='/'&&app.origin===appUrl);
  assert.equal(process.env.BASE_URL,appUrl);
  assert.ok(['postgres:','postgresql:'].includes(database.protocol)&&local.includes(database.hostname));
  assert.ok(!database.search&&!database.hash,'Database connection overrides are forbidden.');
  assert.match(database.pathname,/^\/ten98_funnels_[a-z0-9_]+$/);
  const identity={database:database.pathname.slice(1),appUrl};
  if(manifest){
    const saved=JSON.parse(readFileSync(resolve(evidenceDir,'manifest.json'),'utf8'));
    assert.equal(saved.database,identity.database);assert.equal(saved.appUrl,appUrl);assert.equal(saved.synthetic,true);
  }
  return identity;
}
