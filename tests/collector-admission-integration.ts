import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// Requests refused before a configured website origin is identified must not count toward the shared collection budget.
export async function runCollectorAdmissionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();
  for(const url of [config.appUrl,config.databaseUrl])assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const {pool}=getDatabase(),keys=['collector:global'];
  // Seed the current and next minute well below the limits so a minute boundary cannot flake the comparison.
  const seed=()=>pool.query("INSERT INTO request_limit(key,minute,count) SELECT k,floor(extract(epoch FROM now())/60)+n,100 FROM unnest($1::text[]) k,generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=100",[keys]);
  const total=async(key:string)=>Number((await pool.query('SELECT COALESCE(sum(count),0)::int AS total FROM request_limit WHERE key=$1 AND minute>=floor(extract(epoch FROM now())/60)-1',[key])).rows[0].total);
  try{
    await seed();
    const unconfigured=`https://unconfigured-${randomUUID().slice(0,8)}.example.com`,before=await total('collector:global');
    const options=await handleApi(new Request(config.appUrl+'/api/collect',{method:'OPTIONS',headers:{origin:unconfigured}}));
    assert.equal(options.status,403);
    const post=await handleApi(new Request(config.appUrl+'/api/collect',{method:'POST',headers:{origin:unconfigured,'content-type':'application/json'},body:JSON.stringify({siteKey:randomUUID(),eventId:randomUUID(),name:'pageview',url:unconfigured+'/'})}));
    assert.equal(post.status,403);
    assert.equal(await total('collector:global'),before,'Requests from an unconfigured origin counted toward the shared collection budget.');
  }finally{await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[keys]);}
  return {groups:['unconfigured collection origins leave the shared collection budget untouched']};
}
if(process.env.TEN98_INTEGRATION_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{console.log(await runCollectorAdmissionChecks());}finally{await closeDatabase();}
