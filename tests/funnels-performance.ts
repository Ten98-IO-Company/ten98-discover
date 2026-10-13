import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {runAnalysis,saveAnalysis,type AnalysisItem} from '../src/server/funnels.ts';

// Optional, substantial local load. Fixtures remain for inspection; never run on
// a shared application database or automatically as part of the unit/CI suite.
export async function runFunnelPerformanceChecks(){
  assert.equal(process.env.TEN98_PERFORMANCE_TEST,'1','Explicit performance-test opt-in required.');
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1','Explicit integration-test opt-in required.');
  const config=getConfig(),database=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  assert.ok(local.includes(database.hostname)&&local.includes(new URL(config.appUrl).hostname),'Use loopback app and database addresses.');
  assert.equal(database.search,'','Database connection overrides are forbidden.');assert.equal(database.hash,'');
  assert.match(database.pathname,/^\/ten98_funnels_performance_[a-z0-9_]+(?![\s\S])/,'Use a dedicated performance database.');
  const deadline=setTimeout(()=>{console.error('FAIL funnel performance deadline; synthetic fixtures retained.');process.exit(124);},120_000);deadline.unref();
  const originalFetch=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw new Error('External requests are forbidden in this fixture.');};
  try{
    await assertSchema();const {pool}=getDatabase();
    const occupied=await pool.query('SELECT EXISTS(SELECT 1 FROM "user") OR EXISTS(SELECT 1 FROM project) AS occupied');
    assert.equal(occupied.rows[0].occupied,false,'Provision a fresh, migrated database; this runner never clears existing data.');
    const owner=randomUUID(),workspace=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Performance fixture\',$2)',[owner,owner+'@performance.invalid']);
    await pool.query("INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,'Funnel performance fixture',3650)",[workspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
    const query=(cursor?:string)=>new URLSearchParams({revision:'1',from:'2026-01-31',to:'2026-01-31',timeZone:'UTC',...(cursor?{cursor}:{})});
    const timing=(name:string,start:number)=>console.log(JSON.stringify({check:name,milliseconds:Math.round(performance.now()-start)}));
    async function seed(name:string,eventCount:number,visitors:number){
      const project=randomUUID(),start=performance.now(),client=await pool.connect();
      try{
        await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='20s'");
        await client.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[project,workspace,name,'https://'+project+'.performance.invalid',randomUUID()]);
        await client.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) SELECT $1,repeat(md5(n::text),2),'2026-01-31T00:00:00Z','2026-01-31T23:59:59Z' FROM generate_series(1,$2::integer) n",[project,visitors]);
        await client.query(`INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,source,metric_version,properties,dimensions)
          SELECT gen_random_uuid(),$1,'Step'||(((n-1)%8)+1)::text,'/step/'||(((n-1)%8)+1)::text,
            '2026-01-31T12:00:00Z'::timestamptz+((CASE WHEN $3::integer=1 THEN n-1 ELSE (n-1)%8 END)::double precision*interval '0.25 seconds'),
            repeat(md5((CASE WHEN $3::integer=1 THEN 1 ELSE ((n-1)/8)+1 END)::text),2),repeat(md5('visit'||(CASE WHEN $3::integer=1 THEN 1 ELSE ((n-1)/8)+1 END)::text),2),
            'browser','native-v1','{"plan":{"type":"string","value":"pro"},"amount":{"type":"number","value":42}}',
            jsonb_build_object('origin',$4::text,'language','en','referrerHost','search.example','campaign',jsonb_build_object('source','email'))
          FROM generate_series(1,$2::integer) n`,[project,eventCount,visitors,'https://'+project+'.performance.invalid']);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
      await pool.query('ANALYZE event');timing(name+' seed',start);return project;
    }
    async function definition(project:string,dense=false):Promise<AnalysisItem>{
      const response=await saveAnalysis(project,owner,'funnel',{requestId:randomUUID(),definition:{kind:'funnel',name:dense?'Dense repeated activity':'Distributed activity',windowMinutes:dense?1440:5,
        steps:Array.from({length:8},(_,i)=>({type:'event',match:dense?'contains':'exact',value:dense?'Step':'Step'+(i+1)}))}});
      assert.ok(response.item);return response.item;
    }
    const distributed=await seed('100k distributed',100_000,12_500),item=await definition(distributed);
    let start=performance.now();
    const result=await runAnalysis(distributed,owner,'funnel',item.id,query());
    assert.deepEqual(result.steps.map(s=>s.visitors),Array(8).fill(12_500));assert.equal(result.coverage.status,'complete');timing('100k eight-step counts',start);
    let cursor:string|undefined;const seen=new Set<string>();
    for(let page=1;page<=2;page++){
      start=performance.now();const params=query(cursor);params.set('step','8');
      const witnesses=await runAnalysis(distributed,owner,'funnel',item.id,params,true);
      assert.deepEqual(witnesses.steps.map(s=>s.visitors),Array(8).fill(12_500));assert.equal(witnesses.witnesses.length,50);assert.ok(witnesses.nextCursor);cursor=witnesses.nextCursor;
      const ids=witnesses.witnesses.flatMap(w=>w.events.map(e=>e.id));
      const rows=(await pool.query<{id:string;visitor_id:string;project_id:string}>('SELECT id,visitor_id,project_id FROM event WHERE id=ANY($1::uuid[])',[ids])).rows;
      const actual=new Map(rows.map(row=>[row.id,row])),serialized=JSON.stringify(witnesses);
      for(const witness of witnesses.witnesses){
        assert.equal(witness.events.length,8);assert.deepEqual(witness.events.map(e=>e.eventName),Array.from({length:8},(_,i)=>'Step'+(i+1)));
        const first=actual.get(witness.events[0].id);assert.ok(first,'Witness must reference an inserted event.');
        const visitor=first.visitor_id;assert.ok(!seen.has(visitor),'Witness pages must not repeat a visitor.');seen.add(visitor);
        assert.ok(!serialized.includes(visitor),'Browser evidence must not expose visitor hashes.');
        for(const [i,event]of witness.events.entries()){
          const row=actual.get(event.id);assert.ok(row&&row.project_id===distributed&&row.visitor_id===visitor,'Witness events must share the actual project and visitor.');
          if(i){const gap=Date.parse(event.receivedAt)-Date.parse(witness.events[i-1].receivedAt);assert.ok(gap>0&&gap<=300_000,'Every witness must obey the strict adjacent window.');}
        }
      }
      timing('100k witness page '+page,start);
    }
    assert.equal(seen.size,100);
    const dense=await seed('10k dense all-match',10_000,1),denseItem=await definition(dense,true);start=performance.now();
    const denseResult=await runAnalysis(dense,owner,'funnel',denseItem.id,query());
    assert.deepEqual(denseResult.steps.map(s=>s.visitors),Array(8).fill(1));timing('10k dense eight-step counts with 1440-minute window',start);
    assert.equal(outgoing,0);console.log('PASS funnel performance: exact counts and 100 real witnesses; fixtures retained.');
  }finally{clearTimeout(deadline);globalThis.fetch=originalFetch;await closeDatabase();}
}

if(import.meta.main){try{await runFunnelPerformanceChecks();}catch(error){console.error(error instanceof assert.AssertionError?error.message:'FAIL funnel performance; inspect the dedicated database and query deadline.');process.exitCode=1;}}
