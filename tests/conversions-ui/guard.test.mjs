import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const env={TEN98_INTEGRATION_TEST:'1',TEN98_CONVERSIONS_BROWSER:'1',APP_URL:'http://localhost:3900',BASE_URL:'http://localhost:3900',DATABASE_URL:'postgres://synthetic:synthetic@localhost:5432/ten98_funnels_guard',PLAYWRIGHT_MODULE:'unused-in-guard',SystemRoot:process.env.SystemRoot};
function run(patch={}){return spawnSync(process.execPath,['--input-type=module','-e',"import {fixtureGuard} from './tests/conversions-ui/guard.mjs'; fixtureGuard({manifest:false});"],{cwd:root,env:{...env,...patch},encoding:'utf8',timeout:10_000,windowsHide:true});}
test('conversion browser guard admits only explicit local fixture origins and database without overrides',()=>{
  assert.equal(run().status,0);
  for(const patch of [
    {TEN98_CONVERSIONS_BROWSER:'0'},{TEN98_INTEGRATION_TEST:'0'},{PLAYWRIGHT_MODULE:''},
    {DATABASE_URL:'postgres://synthetic:synthetic@localhost:5432/ten98_funnels_guard?host=external.example'},
    {DATABASE_URL:'postgres://synthetic:synthetic@localhost:5432/ten98_funnels_guard#override'},
    {DATABASE_URL:'postgres://synthetic:synthetic@external.example:5432/ten98_funnels_guard'},
    {DATABASE_URL:'postgres://synthetic:synthetic@localhost:5432/production'},
    {DATABASE_URL_FILE:'some-private-file'},
    {APP_URL:'https://external.example',BASE_URL:'https://external.example'},
    {APP_URL:'http://localhost:3900/path',BASE_URL:'http://localhost:3900/path'},
    {BASE_URL:'http://localhost:3901'},
  ])assert.notEqual(run(patch).status,0,'Unsafe fixture environment must fail closed.');
});
