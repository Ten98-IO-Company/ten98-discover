import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {closeDatabase,getDatabase} from '../src/server/db.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';

// Independent adversarial review, run only against the already migrated, owned
// schedule fixture. Every write rolls back; this script never migrates or drops.
// node --env-file=<synthetic schedule env> tests/rank-schema-review.ts
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const url=new URL(getConfig().databaseUrl);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
const hostedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_schedule_ci';
assert.equal(url.port,hostedCi?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');
assert.match(url.pathname,/^\/ten98_rank_schedule_[a-z0-9_]+$/);
const {pool}=getDatabase(),failures:string[]=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Network forbidden in rank schema review.');};
async function check(label:string,work:()=>Promise<void>){
  try{await work();console.log('PASS '+label);}
  catch(error){
    failures.push(label);
    const line=error instanceof Error?error.stack?.match(/rank-schema-review\.ts:\d+:\d+/)?.[0]:undefined;
    const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'unknown';
    console.error('FAIL '+label+' ['+code+(line?' '+line:'')+']');
  }
}
async function next(interval:string,zone:string,after:string,weekday:number|null=null){
  const row=(await pool.query<{due:Date}>('SELECT rank_next_due($1,$2,9,0,$3,$4::timestamptz) AS due',[interval,zone,weekday,after])).rows[0];
  return row.due.toISOString();
}
try{
  assert.equal((await pool.query("SELECT 1 FROM schema_version WHERE version='0023'")).rowCount,1);
  await check('weekly shifted occurrence remains due after skipped-date transition',async()=>{
    const native=(await pool.query("SELECT timestamp '2011-12-30 09:00:00' AT TIME ZONE 'Pacific/Apia' AS due")).rows[0].due as Date;
    assert.equal(native.toISOString(),'2011-12-30T19:00:00.000Z');
    assert.equal(await next('weekly','Pacific/Apia','2011-12-30T12:00:00Z',5),'2011-12-30T19:00:00.000Z');
    assert.equal(await next('weekly','Pacific/Apia','2011-12-30T19:00:00Z',5),'2012-01-05T19:00:00.000Z');
  });
  await check('prior month end remains due after skipped-date transition',async()=>{
    const native=(await pool.query("SELECT timestamp '1994-12-31 09:00:00' AT TIME ZONE 'Pacific/Kiritimati' AS due")).rows[0].due as Date;
    assert.equal(native.toISOString(),'1994-12-31T19:00:00.000Z');
    assert.equal(await next('monthly','Pacific/Kiritimati','1994-12-31T12:00:00Z'),'1994-12-31T19:00:00.000Z');
    assert.equal(await next('monthly','Pacific/Kiritimati','1994-12-31T19:00:00Z'),'1995-01-30T19:00:00.000Z');
  });
  await check('converging daily dates produce one strictly future UTC occurrence',async()=>{
    assert.equal(await next('daily','Pacific/Kiritimati','1994-12-31T12:00:00Z'),'1994-12-31T19:00:00.000Z');
    assert.equal(await next('daily','Pacific/Kiritimati','1994-12-31T19:00:00Z'),'1995-01-01T19:00:00.000Z');
    await assert.rejects(next('daily','XYZ-24XYZ-48,M1.1.0,M12.1.0','2026-01-01T00:00:00Z'),error=>error instanceof Error&&error.message==='Invalid rank schedule');
  });
  await check('standing approval, cross-project scope and expiry constraints',async()=>{
    const c=await pool.connect();await c.query('BEGIN');
    try{
      const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),other=randomUUID(),connection=randomUUID(),config=randomUUID();
      await c.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Schema review\',$2)',[owner,owner+'@rank-schema.integration.test']);
      await c.query("INSERT INTO workspace(id,name) VALUES($1,'Schema review')",[workspace]);
      for(const id of [project,other])await c.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Schema review',$3,$4)",[id,workspace,'https://'+id+'.rank-schema.integration.test',randomUUID()]);
      await c.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Synthetic only')",[connection,workspace]);
      await c.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
        VALUES($1,$2,$3,'Schema review','rank-schema.integration.test',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'both',100,1)`,[config,workspace,project]);
      async function reject(sql:string,values:unknown[],code:string){
        await c.query('SAVEPOINT rejected_change');
        try{await assert.rejects(c.query(sql,values),error=>!!error&&typeof error==='object'&&'code'in error&&error.code===code);}
        finally{await c.query('ROLLBACK TO SAVEPOINT rejected_change');}
      }
      await reject('UPDATE rank_config SET schedule_enabled=true WHERE id=$1',[config],'23514');
      await reject("INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword) VALUES($1,$2,$3,$4,'wrong project')",[randomUUID(),workspace,other,config],'23503');
      await c.query(`UPDATE rank_config SET schedule_interval='daily',schedule_timezone='UTC',schedule_hour=9,schedule_minute=0,
        approval_id=$2,approval_user_id=$3,approval_config_revision=1,approval_keywords_revision=1,approval_request_hash=$4,
        approval_connection_id=$5,approval_connection_revision=1,approval_account_fingerprint=$4,approval_account_fingerprint_version=2,
        approval_max_micros=10000,approved_at=clock_timestamp(),next_due_at=clock_timestamp()+interval '1 day',schedule_enabled=true WHERE id=$1`,[config,randomUUID(),owner,'a'.repeat(64),connection]);
      await reject('UPDATE rank_config SET revision=2 WHERE id=$1',[config],'23514');
      await reject('UPDATE rank_config SET keywords_revision=2 WHERE id=$1',[config],'23514');
      await reject('UPDATE rank_config SET archived_at=clock_timestamp() WHERE id=$1',[config],'23514');
      await reject('UPDATE rank_config SET approval_user_id=NULL WHERE id=$1',[config],'23514');
      await c.query('UPDATE rank_config SET schedule_enabled=false,next_due_at=NULL,revision=2,archived_at=clock_timestamp() WHERE id=$1',[config]);
      // Reuse only a synthetic existing task; the transaction preserves its fixture.
      const task=(await c.query("SELECT id FROM rank_task WHERE result_status='ranked' LIMIT 1")).rows[0];
      assert.ok(task,'The schedule suite must have left its ranked synthetic task.');
      await c.query('UPDATE rank_task SET position=NULL,rank_basis=NULL,absolute_position=NULL,ranking_url=NULL,serp_features=NULL,raw_evidence=NULL,data_expired_at=clock_timestamp(),raw_expired_at=clock_timestamp() WHERE id=$1',[task.id]);
      await reject('UPDATE rank_task SET raw_evidence=\'{"synthetic":true}\' WHERE id=$1',[task.id],'23514');
      await reject('UPDATE rank_task SET position=1,rank_basis=\'organic\',ranking_url=\'https://rank-schema.integration.test/\' WHERE id=$1',[task.id],'23514');
      assert.equal((await c.query('SELECT result_status FROM rank_task WHERE id=$1',[task.id])).rows[0].result_status,'ranked');
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await check('rank-only financial history prevents account-identity replacement',async()=>{
    const c=await pool.connect();await c.query('BEGIN');
    try{
      assert.equal((await c.query('SELECT 1 FROM keyword_quote UNION ALL SELECT 1 FROM saved_keyword_refresh_plan LIMIT 1')).rowCount,0,'This group requires the rank-only schedule fixture.');
      assert.ok((await c.query('SELECT 1 FROM rank_run LIMIT 1')).rowCount);
      await c.query("UPDATE installation SET provider_account_identity=NULL WHERE id='instance'");
      await assert.rejects(initializeProviderAccountIdentity(c),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===503);
    }finally{await c.query('ROLLBACK');c.release();}
  });
}finally{globalThis.fetch=originalFetch;await closeDatabase();}
if(failures.length)throw new Error('Rank schema review failed: '+failures.join('; '));
