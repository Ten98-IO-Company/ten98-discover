import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {PoolClient} from 'pg';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase,migrationSources} from '../src/server/db.ts';
import {createAssistantConversation,listAssistantConversations,getAssistantConversation,appendAssistantUserTurn} from '../src/server/project-assistant.ts';
import {expireAssistantPayloads,previewAssistantRetention} from '../src/server/project-assistant-retention.ts';
import {getRetention,previewRetention,saveRetention,runRetentionBatch} from '../src/server/retention.ts';
import {closeAccount,type StepUpProof} from '../src/server/account-closure.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_ASSISTANT_TEST,'1');
const database=new URL(getConfig().databaseUrl);
assert.equal(database.hostname,'127.0.0.1');
const ci=process.env.GITHUB_ACTIONS==='true',fixture=process.env.TEN98_ASSISTANT_FIXTURE;
if(ci){
 assert.equal(process.env.TEN98_ISOLATED_CI_DATABASE,'1');assert.equal(database.port,'5432');
 assert.ok(fixture==='fresh'||fixture==='upgrade','Select the exact assistant CI fixture.');
 assert.equal(database.pathname,fixture==='fresh'?'/ten98_assistant_ci':'/ten98_upgrade');
}else{
 assert.equal(fixture,undefined);assert.equal(database.port,'55503');assert.match(database.pathname,/^\/ten98_assistant_[a-z0-9_]+$/);
}
assert.equal(database.search,'');assert.equal(database.hash,'');
for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
await assertSchema();
const {pool}=getDatabase(),owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),otherProject=randomUUID();
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
let checks=0;
async function check(name:string,run:()=>Promise<void>){await run();checks++;console.log(`PASS ${name}`);}
async function transaction<T>(run:(c:PoolClient)=>Promise<T>,rollback=false){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await c.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[project]);const result=await run(c);await c.query(rollback?'ROLLBACK':'COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function settings(days:number){const current=await getRetention(workspace,owner);const preview=await previewRetention(workspace,owner,{revision:current.revision,settings:{...current.settings,derivedHistoryDays:days}});await saveRetention(workspace,owner,{previewToken:preview.previewToken});return preview;}
async function aged(count:number,ageDays:number){const conversation=await createAssistantConversation(project,owner,randomUUID());const ids=Array.from({length:count},()=>randomUUID());await pool.query(`INSERT INTO assistant_event(id,project_id,conversation_id,sequence,actor_id,payload_sha256,payload_bytes,created_at)
 SELECT id,$2,$3,ordinality,$4,$5,3,clock_timestamp()-$6::integer*interval '24 hours' FROM unnest($1::uuid[])WITH ORDINALITY AS t(id,ordinality)`,[ids,project,conversation.conversationId,owner,sha('old'),ageDays]);
 await pool.query("INSERT INTO assistant_event_payload(event_id,project_id,exact_text)SELECT id,$2,'old' FROM unnest($1::uuid[])id",[ids,project]);await pool.query('UPDATE assistant_conversation SET revision=$2 WHERE id=$1',[conversation.conversationId,count]);return {...conversation,ids};}
try{
 if(ci){
  const sources=await migrationSources();
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_version ORDER BY version')).rows,sources.map(({version,checksum})=>({version,checksum})));
  if(fixture==='fresh'){
   for(const table of ['user','project','assistant_conversation','assistant_event','assistant_event_payload'])assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM "${table}"`)).rows[0].n,0,'Fresh CI starts with fully migrated, empty application data.');
  }
  console.log(`PASS ${fixture} CI full migration history and checksums`);
 }
 for(const id of [owner,editor,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,$2,$3)',[id,'Assistant fixture',`${id}@assistant.invalid`]);
 await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Assistant fixture')",[workspace]);
 for(const [id,role] of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[workspace,id,role]);
 for(const id of [project,otherProject])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Assistant fixture',$3,$4,'infinity')",[id,workspace,`https://${id}.invalid`,randomUUID()]);
 const providerBefore=(await pool.query('SELECT count(*)::integer AS n FROM provider_request')).rows[0].n;
 const jobsExistBefore=(await pool.query("SELECT to_regclass('pgboss.job') IS NOT NULL AS present")).rows[0].present as boolean;
 const jobsBefore=jobsExistBefore?(await pool.query('SELECT count(*)::integer AS n FROM pgboss.job')).rows[0].n:null;
 const requestId=randomUUID(),conversation=await createAssistantConversation(project,owner,requestId);
 const input={conversationId:conversation.conversationId,requestId:randomUUID(),expectedRevision:0,text:' Exact é🌍\ntext '};
 const first=await appendAssistantUserTurn(project,owner,input);
 await check('exact UTF8, hash, receipt replay and current authorization',async()=>{
  assert.equal((await createAssistantConversation(project,owner,requestId)).conversationId,conversation.conversationId);
  assert.equal((await appendAssistantUserTurn(project,owner,input)).eventId,first.eventId);
  await assert.rejects(appendAssistantUserTurn(project,editor,input));
  await assert.rejects(appendAssistantUserTurn(project,owner,{...input,text:'changed'}));
  assert.equal((await getAssistantConversation(project,owner,conversation.conversationId)).events[0].text,input.text);
  const row=(await pool.query('SELECT payload_sha256,payload_bytes FROM assistant_event WHERE id=$1',[first.eventId])).rows[0];assert.equal(row.payload_sha256,sha(input.text));assert.equal(row.payload_bytes,Buffer.byteLength(input.text));
  await assert.rejects(createAssistantConversation(project,viewer,randomUUID()));await assert.rejects(getAssistantConversation(project,outsider,conversation.conversationId));await assert.rejects(getAssistantConversation(otherProject,owner,conversation.conversationId));
 });
 await check('concurrent CAS admits exactly one and replay precedes current revision',async()=>{
  const results=await Promise.allSettled([1,2].map(n=>appendAssistantUserTurn(project,owner,{...input,requestId:randomUUID(),expectedRevision:1,text:`next${n}`})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await appendAssistantUserTurn(project,owner,input)).revision,1);
 });
 await check('text boundaries and immutable safe tenant identities',async()=>{
  await appendAssistantUserTurn(project,owner,{...input,requestId:randomUUID(),expectedRevision:2,text:'é'.repeat(65536)});
  for(const text of ['é'.repeat(65536)+'x','bad\0text','\ud800'])await assert.rejects(appendAssistantUserTurn(project,owner,{...input,requestId:randomUUID(),expectedRevision:3,text}));
  await assert.rejects(pool.query("UPDATE assistant_event_payload SET exact_text='changed' WHERE event_id=$1",[first.eventId]));
  await assert.rejects(pool.query('UPDATE assistant_event SET sequence=99 WHERE id=$1',[first.eventId]));
  await assert.rejects(pool.query('UPDATE assistant_conversation SET revision=9007199254740992 WHERE id=$1',[conversation.conversationId]));
  await assert.rejects(pool.query('INSERT INTO assistant_event(id,project_id,conversation_id,sequence,actor_id,payload_sha256,payload_bytes)VALUES($1,$2,$3,4,$4,$5,1)',[randomUUID(),otherProject,conversation.conversationId,owner,sha('x')]));
 });
 await check('bounded conversation and event pages',async()=>{
  for(let n=0;n<21;n++)await createAssistantConversation(project,owner,randomUUID());
  const page=await listAssistantConversations(project,owner);assert.equal(page.conversations.length,20);assert.ok(page.nextCursor);assert.ok((await listAssistantConversations(project,owner,page.nextCursor)).conversations.length>0);
  const large=await aged(101,0);const pageEvents=await getAssistantConversation(project,owner,large.conversationId);assert.equal(pageEvents.events.length,100);assert.equal((await getAssistantConversation(project,owner,large.conversationId,pageEvents.nextSequence!)).events.length,1);
 });
 await check('preview, natural expiry then expansion, shorten-raise, and absent bytes',async()=>{
  const natural=await aged(1,400);assert.equal((await getAssistantConversation(project,owner,natural.conversationId)).events[0].availability,'expired');
  const preview=await settings(730);assert.ok(preview.assistantEstimate.payloads!>=1);assert.equal((await getAssistantConversation(project,owner,natural.conversationId)).events[0].text,null);
  const shortened=await aged(1,30);await settings(7);await settings(365);assert.equal((await getAssistantConversation(project,owner,shortened.conversationId)).events[0].text,null);
  await pool.query('DELETE FROM assistant_event_payload WHERE event_id=$1',[natural.ids[0]]);
  const estimate=await transaction(c=>previewAssistantRetention(c,workspace,365));assert.equal(estimate.payloads,1);
 });
 await check('100-row retention batches, rollback and native runner integration',async()=>{
  const oldBatch=await aged(205,400);const before=(await pool.query('SELECT count(*)::integer AS n FROM assistant_event_payload WHERE project_id=$1',[project])).rows[0].n;
  const cutoff=new Date(Date.now()-7*86400000);
  const rolled=await transaction(c=>expireAssistantPayloads(c,project,cutoff),true);assert.equal(rolled.expiredPayloads,100);assert.equal(rolled.pending,true);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM assistant_event_payload WHERE project_id=$1',[project])).rows[0].n,before);
  const batch=await runRetentionBatch(project);assert.equal(batch?.expiredAssistantPayloads,100);
  for(const present of [false,true]){
   const selected=(await pool.query(`SELECT e.sequence FROM assistant_event e LEFT JOIN assistant_event_payload b ON b.event_id=e.id AND b.project_id=e.project_id
    WHERE e.conversation_id=$1 AND(b.event_id IS NOT NULL)=$2 ORDER BY e.sequence LIMIT 1`,[oldBatch.conversationId,present])).rows[0];
   assert.ok(selected,'The native retention batch must leave both purged and pending expired payloads.');
   const event=(await getAssistantConversation(project,owner,oldBatch.conversationId,Number(selected.sequence)-1)).events[0];
   assert.equal(event.availability,present?'expired':'purged');assert.equal(event.text,null);
  }
  // A retained identifier-only receipt must never recreate bytes, irrespective of when deletion occurred.
  await pool.query('DELETE FROM assistant_event_payload WHERE event_id=$1',[first.eventId]);
  const revisionBeforeReplay=(await getAssistantConversation(project,owner,conversation.conversationId)).revision;
  assert.equal((await appendAssistantUserTurn(project,owner,input)).eventId,first.eventId);
  const replayed=await getAssistantConversation(project,owner,conversation.conversationId);
  assert.equal(replayed.revision,revisionBeforeReplay);assert.equal(replayed.events[0].availability,'purged');assert.equal(replayed.events[0].text,null);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM assistant_event_payload WHERE event_id=$1',[first.eventId])).rows[0].n,0);
 });
 await check('native account closure retains provenance and revokes access',async()=>{
  const authored=await createAssistantConversation(project,editor,randomUUID());await appendAssistantUserTurn(project,editor,{conversationId:authored.conversationId,requestId:randomUUID(),expectedRevision:0,text:'authored'});
  await transaction(c=>closeAccount(c,editor,{kind:'self',userId:editor},{userId:editor,method:'password'} as StepUpProof));
  await assert.rejects(getAssistantConversation(project,editor,authored.conversationId));assert.equal((await getAssistantConversation(project,owner,authored.conversationId)).events[0].authorId,editor);
  assert.equal((await pool.query('SELECT name FROM "user" WHERE id=$1',[editor])).rows[0].name,'Closed account');
 });
 await check('fresh migration against native text-key schema and no provider work',async()=>{
  await transaction(async c=>{await c.query('CREATE SCHEMA assistant_fresh_fixture');await c.query('SET LOCAL search_path TO assistant_fresh_fixture');await c.query('CREATE TABLE "user"(id text PRIMARY KEY);CREATE TABLE project(id text PRIMARY KEY)');await c.query(readFileSync(new URL('../migrations/0086_project_assistant.sql',import.meta.url),'utf8'));assert.equal((await c.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='assistant_fresh_fixture' AND table_name LIKE 'assistant_%'")).rows[0].n,3);},true);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM provider_request')).rows[0].n,providerBefore);
  assert.equal((await pool.query("SELECT to_regclass('pgboss.job') IS NOT NULL AS present")).rows[0].present,jobsExistBefore);
  if(jobsExistBefore)assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pgboss.job')).rows[0].n,jobsBefore);
 });
 await check('workspace deletion cascades all assistant payload and identity rows',async()=>{
  await pool.query('DELETE FROM workspace WHERE id=$1',[workspace]);
  for(const table of ['assistant_conversation','assistant_event','assistant_event_payload'])assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE project_id=$1`,[project])).rows[0].n,0);
 });
 console.log(JSON.stringify({status:'PASS',checks,fixture:ci?`CI ${fixture} PostgreSQL; no provider work`:'owned local PostgreSQL; no provider work'}));
}finally{await closeDatabase();}
