import assert from'node:assert/strict';
import{createHash,randomUUID}from'node:crypto';
import{writeFile}from'node:fs/promises';
import pg from'pg';
import{getDatabase,closeDatabase}from'../src/server/db.ts';
import{projectRevenue,listRevenueSessions,getRevenueSession}from'../src/server/revenue.ts';
import{createApiKey}from'../src/server/api-keys.ts';
import{saveCohort}from'../src/server/cohorts.ts';
import{runRevenueReportChecks}from'./revenue-report-integration.ts';
import{revenueComparisonChanges}from'../src/lib/revenue.ts';

export async function runRevenueComparisonChecks(){
 assert.equal(process.env.TEN98_REVENUE_COMPARISON_TEST,'1');
 // This original runner owns the strict fresh55501 prefix, all migrations,
 //22 original reports and4 adversarial reports. No legacy assertion is skipped.
 await runRevenueReportChecks();
 const{pool}=getDatabase(),owner=randomUUID(),viewer=randomUUID(),workspace=randomUUID();
 for(const id of[owner,viewer])await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Revenue comparison\',$2)',[id,id+'@revenue-comparison.test']);
 await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Revenue comparison')",[workspace]);
 for(const[id,role]of[[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,id,role]);
 const project=async()=>{const id=randomUUID();await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Revenue comparison','https://comparison.example',gen_random_uuid(),'infinity')",[id,workspace]);return id;};
 const pid=await project(),key=createHash('sha256').update('comparison-key').digest('hex'),visit=createHash('sha256').update('comparison-visit').digest('hex');
 await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2023-01-01','2026-10-15')",[pid,key]);
 const tuple=(amount:string,kind='sale')=>Object.fromEntries(Object.entries({version:'1',kind,amount,currency:'USD'}).map(([k,value])=>['ten98_revenue_'+k,{type:'string',value}]));
 const add=async(time:string,amount:string,kind='sale',path='/sale')=>{const id=randomUUID();await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,properties,visitor_id,visit_id,source,collection_basis)VALUES($1,$2,'checkout',$3,$4,$5,$6,$7,'browser','consent')",[id,pid,path,time,tuple(amount,kind),key,visit]);return id;};
 const currentId=await add('2024-03-01T12:00:00Z','20.0000'),priorId=await add('2024-02-29T12:00:00Z','10.0000');
 const params=(extra:Record<string,string>={})=>new URLSearchParams({from:'2024-03-01',to:'2024-03-01',timeZone:'UTC',currency:'USD',...extra});
 const read=(extra:Record<string,string>={})=>projectRevenue(pid,{kind:'session',userId:viewer},params(extra));
 const plain=await read(),prev=await read({compare:'prev'});assert.equal(Object.hasOwn(plain,'comparison'),false);assert.equal(prev.comparison!.summary.money!.net,'10.0000');assert.equal(prev.money!.net,'20.0000');assert.deepEqual(prev.comparison!.change.net,{absolute:'10.0000',percent:'100.0000'});assert.equal(prev.asOf,prev.comparison!.summary.asOf);assert.equal(prev.eventBefore,prev.comparison!.summary.eventBefore);assert.equal(prev.retention.policyHash,prev.comparison!.summary.retention.policyHash);
 assert.deepEqual(Object.keys(prev.comparison!.summary).sort(),['asOf','eventBefore','query','range','calendar','coverage','selection','identity','measurement','money','retention'].sort());
 for(const field of['money','daily','series','dimensions','sessions','paging','method']as const)assert.deepEqual(prev[field],plain[field]);
 assert.deepEqual(prev.comparison!.change,revenueComparisonChanges(prev,prev.comparison!.summary));
 for(const route of[listRevenueSessions])await assert.rejects(route(pid,{kind:'session',userId:viewer},params({compare:'prev'})),{status:400});await assert.rejects(getRevenueSession(pid,key,{kind:'session',userId:viewer},params({compare:'yoy'})),{status:400});
 const filtered=await read({compare:'prev',path:'/absent'});assert.equal(filtered.money!.net,'0.0000');assert.equal(filtered.comparison!.summary.money!.net,'0.0000');assert.deepEqual(filtered.comparison!.change.net,{absolute:'0.0000',percent:null});
 const unkeyedId=randomUUID();await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,properties,source)VALUES($1,$2,'unkeyed','/sale','2024-02-29T13:00:00Z',$3,'api')",[unkeyedId,pid,tuple('5.0000')]);const unkeyed=await read({compare:'prev'});assert.equal(unkeyed.comparison!.summary.measurement.unkeyed!.net,'5.0000');assert.equal(unkeyed.comparison!.summary.selection.evidenceIncomplete,true);assert.equal(unkeyed.comparison!.change.net.absolute,null);await pool.query('DELETE FROM event WHERE id=$1',[unkeyedId]);
 console.log('PASS original22+4 reports preserved; opt-in summary-only comparison, identical current material, one precise snapshot/fence and exact filtered deltas');

 const leap=await read({from:'2025-02-28',to:'2026-02-28',compare:'yoy'});assert.deepEqual(leap.comparison!.periods,{currentDays:366,comparisonDays:367,overlapDays:1});assert.equal(leap.comparison!.summary.range.from,'2024-02-28');assert.equal(leap.comparison!.summary.range.to,'2025-02-28');
 const spring=await read({from:'2024-03-10',to:'2024-03-10',timeZone:'America/New_York',compare:'prev'}),fall=await read({from:'2024-11-03',to:'2024-11-03',timeZone:'America/New_York',compare:'prev'}),skipped=await read({from:'2011-12-31',to:'2011-12-31',timeZone:'Pacific/Apia',compare:'prev'});
 assert.equal(Date.parse(spring.range.end)-Date.parse(spring.range.start),23*3600000);assert.equal(Date.parse(fall.range.end)-Date.parse(fall.range.start),25*3600000);assert.equal(skipped.comparison!.summary.range.start,skipped.comparison!.summary.range.end);
 await pool.query("INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)VALUES($1,$2,'plan','{\"type\":\"string\",\"value\":\"team\"}',clock_timestamp())",[pid,key]);
 const predicates=JSON.stringify({version:1,match:'all',fields:[],properties:[],sessionProperties:[{key:'plan',operator:'eq',type:'string',value:'team'}]}),properties=await read({compare:'prev',predicates});assert.equal(properties.sessionProperties!.asOf,properties.comparison!.summary.sessionProperties!.asOf);assert.equal(properties.sessionProperties!.retainedFrom,properties.comparison!.summary.sessionProperties!.retainedFrom);
 const cohort=await saveCohort(pid,owner,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Fixed qualifier',query:new URLSearchParams({from:'2024-02-29',to:'2024-02-29',timeZone:'UTC',eventName:'checkout'}).toString()}}),cohorted=await read({compare:'prev',cohortId:cohort.item!.id,cohortRevision:String(cohort.item!.revision)});assert.deepEqual(cohorted.cohort!.range,cohorted.comparison!.summary.cohort!.range);assert.equal(cohorted.comparison!.summary.money!.net,'10.0000');
 await pool.query('UPDATE project SET session_properties_evidence_lost_at=clock_timestamp()WHERE id=$1',[pid]);const loss=await read({compare:'prev',predicates});assert.equal(loss.selection.evidenceIncomplete,true);assert.ok(Object.values(loss.comparison!.change).every(value=>value.absolute===null&&value.percent===null));
 await pool.query("UPDATE project SET analytics_retained_from='2024-02-29T18:00:00Z'WHERE id=$1",[pid]);const partial=await read({compare:'prev'});assert.equal(partial.comparison!.summary.coverage.status,'partial');assert.ok(Object.values(partial.comparison!.change).every(value=>value.absolute===null&&value.percent===null));
 await pool.query("UPDATE project SET analytics_retained_from='2024-03-01'WHERE id=$1",[pid]);const expired=await read({compare:'prev'});assert.equal(expired.comparison!.summary.money,null);assert.equal(expired.comparison!.change.net.absolute,null);await pool.query('UPDATE project SET analytics_retained_from=NULL,session_properties_evidence_lost_at=NULL WHERE id=$1',[pid]);
 const future=await read({from:'2099-01-01',to:'2099-01-01',compare:'prev'});assert.deepEqual(future.comparison!.calendar,{current:'future',comparison:'future'});assert.equal(future.comparison!.change.net.absolute,null);
 console.log('PASS leap367/overlap, local23/25-hour DST/skipped day, shared current-property cutoff, fixed cohort period, known-loss/partial/expired/provisional suppression');

 const writer=await pool.connect();let coherentReads=0;try{for(let n=1;n<=8;n++){await writer.query('BEGIN');await writer.query("UPDATE event SET properties=jsonb_set(properties,'{ten98_revenue_amount,value}',to_jsonb((CASE WHEN id=$1 THEN $3::numeric*2 ELSE $3::numeric END)::numeric(19,4)::text))WHERE id=ANY($2::uuid[])",[currentId,[currentId,priorId],String(n)]);const pending=read({compare:'prev'});await writer.query('COMMIT');const result=await pending;assert.equal(BigInt(result.money!.net.replace('.','')),2n*BigInt(result.comparison!.summary.money!.net.replace('.','')),'An actual concurrent atomic pair update cannot yield mixed committed periods.');coherentReads++;}}finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();}
 let statements=0;const original=pg.Client.prototype.query;pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){if(typeof args[0]==='string'&&args[0].startsWith('WITH revenue_snapshot AS MATERIALIZED'))statements++;return(original as(...v:unknown[])=>unknown).apply(this,args);}as typeof original;try{await read({compare:'prev'});assert.equal(statements,1);}finally{pg.Client.prototype.query=original;}
 console.log('PASS eight actual concurrent atomic current/prior updates remain coherent and one aggregate statement serves both periods');

 for(const kind of['expiry','revocation','membership']as const){const api=await createApiKey(workspace,owner,{name:'Comparison '+kind,scopes:['analytics:read']}),lock=await pool.connect();let pending:Promise<unknown>|undefined;try{await lock.query('BEGIN');await lock.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');if(kind==='expiry')await pool.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '1 second'WHERE id=$1",[api.key.id]);pending=projectRevenue(pid,{kind:'api-key',token:api.token},params({compare:'prev'}));let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database()AND wait_event_type='Lock'AND query LIKE 'WITH revenue_snapshot AS MATERIALIZED%'")).rowCount;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(waiting,true);if(kind==='expiry')await new Promise(resolve=>setTimeout(resolve,1100));else if(kind==='revocation')await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[api.key.id]);else await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);await lock.query('COMMIT');await assert.rejects(pending,{status:kind==='membership'?404:401});}finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}}
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);
 if(process.env.TEN98_REVENUE_REPORT_SNAPSHOT)await writeFile(process.env.TEN98_REVENUE_REPORT_SNAPSHOT+'.comparison.json',JSON.stringify({projectId:pid,coherentReads,prev,filtered,leap,spring,fall,skipped,properties,cohorted,loss,partial,expired,future},null,2)+'\n');
 console.log('PASS real aggregate lock waits followed by natural expiry/revocation/deleted membership refusal; no provider work');
}
if(import.meta.main)try{await runRevenueComparisonChecks();}finally{await closeDatabase();}
