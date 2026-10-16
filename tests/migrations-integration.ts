import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase, migrationSource, migrationSources } from '../src/server/db.ts';
import { saveAnalysis } from '../src/server/funnels.ts';
import {saveSavedKeywords} from '../src/server/saved-keywords.ts';
import {assertProviderAccountIdentityReadable,getProviderAccountIdentityKey} from '../src/server/provider-account-identity.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import pg from 'pg';
import {canonicalHash} from '../src/server/context-input.ts';
import {aiSearchProfileId,aiSearchPriceEvidence,aiSearchSnapshotSchema} from '../src/lib/ai-search.ts';

// This consumes a separate empty local database and retains its synthetic fixtures.
// It never drops a schema/database or clears existing data.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Set TEN98_INTEGRATION_TEST=1 for an isolated migration test database.');
const config = (() => {
  try { return getConfig(); }
  catch {
    console.error('Migration test configuration is invalid; credentials are redacted.');
    process.exit(1);
  }
})();
const databaseUrl=new URL(config.databaseUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'Migration tests require a local database.');
assert.equal(databaseUrl.search,'');assert.equal(databaseUrl.hash,'');
const isolatedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&databaseUrl.pathname==='/ten98_upgrade';
assert.equal(databaseUrl.port,isolatedCi?'5432':'55501');assert.ok(isolatedCi||/^\/ten98_upgrade_[a-f0-9]{12}$/.test(databaseUrl.pathname));
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
const { pool } = getDatabase();
const checkout = process.cwd();
const cli = join(checkout, 'src/server/cli.ts');
let stage = 'empty-database safety check';
let brokenCheckout: string | undefined;
const migrationCliExits: number[] = [];

function runMigrate(expected: number, cwd = checkout) {
  migrationCliExits.push(expected);
  const result = spawnSync(process.execPath, [cli, 'migrate'], { cwd, env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 512_000 });
  assert.equal(result.status, expected, `${stage}: migration CLI exit status`);
  for (const secret of [config.authSecret, config.bootstrapToken, config.databaseUrl]) {
    assert.ok(!(result.stdout + result.stderr).includes(secret), 'Migration output must not expose configuration secrets.');
  }
  return result.stdout + result.stderr;
}

async function history() {
  return (await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_version ORDER BY version')).rows;
}

async function schemaSnapshot() {
  const [columns, constraints, indexes] = await Promise.all([
    pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`),
    pool.query(`SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' ORDER BY t.relname, c.conname`),
    pool.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname"),
  ]);
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

const fixtureTables = ['installation', 'user', 'account', 'session', 'workspace', 'membership', 'project', 'event'] as const;
async function records() {
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  for (const table of fixtureTables) snapshot[table] = (await pool.query<{ data: Record<string, unknown> }>(`SELECT row_to_json(t) AS data FROM "${table}" t`)).rows.map((row) => row.data);
  return snapshot;
}

try {
  const existing = await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LIMIT 1`);
  assert.equal(existing.rowCount, 0, 'Use a separate empty test database; existing schemas and data will not be modified.');
  const sources = await migrationSources();
  assert.deepEqual(sources.map(({ version }) => version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024', '0025', '0026', '0027', '0028', '0029', '0030', '0031', '0032', '0033', '0034', '0035', '0036', '0037', '0038', '0039', '0040', '0041', '0042', '0043', '0044', '0045', '0046', '0047', '0048', '0049', '0050', '0051', '0052', '0053']);
  assert.equal(sources.find(m=>m.version==='0029')!.checksum,'8c7559f0e64f899bae4dc36aa9afa521b69624dba7849f28dfc3c1cb730097de','Append0030 without rewriting the published0029 migration.');
  assert.equal(sources.find(m=>m.version==='0030')!.checksum,'87b06aefbfe1b2228bda7fe91a28563265e908b92f07574ad3cb7e5380bbb28e','Append0031 without rewriting the published0030 migration.');
  assert.equal(sources.find(m=>m.version==='0031')!.checksum,'0a5d1fc0ee88c4aad84dbb41b32eb2d80bf0b5d816a907dfabb5a0228925ee65','Append0032 without rewriting published0031.');
  assert.equal(sources.find(m=>m.version==='0033')!.checksum,'5775cdf6cf13130541ed6e93f60705a6f5aebcf51941b3cbf92f8bb685009604','Append0034 without rewriting published0033.');
  assert.equal(sources.find(m=>m.version==='0032')!.checksum,'d929c3457abd3b89dd0b1b428eb259243445db1f915b13672fc12bc16966405e','Append0033 without rewriting published0032.');
  assert.equal(sources.find(m=>m.version==='0034')!.checksum,'ff91095157387da51a86b6682de6126f3accbd557623bf68a5ff45039c7f8e16','Append0035 without rewriting published0034.');
  const foundation = await migrationSource();

  stage = 'seed original foundation schema and data';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE schema_version(version text PRIMARY KEY, checksum text NOT NULL)');
    await client.query(foundation.sql);
    await client.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)', [foundation.version, foundation.checksum]);
    const userId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Preserved owner', `${userId}@migration.test`]);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, await hashPassword(randomBytes(24).toString('base64url'))]);
    await client.query('INSERT INTO session(id,token,"userId","expiresAt","userAgent") VALUES($1,$2,$3,clock_timestamp()+interval \'1 day\',$4)', [randomUUID(), randomBytes(32).toString('base64url'), userId, 'Migration fixture']);
    await client.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspaceId, 'Preserved workspace']);
    await client.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    await client.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [projectId, workspaceId, 'Preserved site', 'https://migration.test', randomUUID()]);
    await client.query("INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,'page_view',$3)", [randomUUID(), projectId, '/preserved-page']);
    await client.query("UPDATE installation SET claimed = true WHERE id = 'instance'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const originalHistory = await history();
  const originalSchema = await schemaSnapshot();
  const originalRecords = await records();
  await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });

  stage = 'reject changed checksums without applying pending migrations';
  await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', ['deliberately-invalid-checksum', '0001']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.deepEqual(await history(), [{ version: '0001', checksum: 'deliberately-invalid-checksum' }]);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally {
    await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', [foundation.checksum, '0001']);
  }

  stage = 'reject unknown future history';
  await pool.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)', ['9999', 'unknown-future-version']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.equal((await history()).length, 2);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally { await pool.query('DELETE FROM schema_version WHERE version=$1', ['9999']); }

  stage = 'reject missing prior migration';
  await pool.query('UPDATE schema_version SET version=$1, checksum=$2 WHERE version=$3', ['0002', sources[1].checksum, '0001']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.deepEqual(await history(), [{ version: '0002', checksum: sources[1].checksum }]);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally {
    await pool.query('UPDATE schema_version SET version=$1, checksum=$2 WHERE version=$3', ['0001', foundation.checksum, '0002']);
  }
  console.log('PASS changed checksum, future version and missing predecessor rejection');

  stage = 'all pending migrations roll back on a later SQL failure';
  brokenCheckout = await mkdtemp(join(tmpdir(), 'ten98-migrations-'));
  await mkdir(join(brokenCheckout, 'migrations'));
  for (const migration of sources) {
    await writeFile(join(brokenCheckout, 'migrations', migration.filename), migration.sql + (migration.version === sources.at(-1)!.version ? '\nSELECT 1 / 0;\n' : ''));
  }
  runMigrate(1, brokenCheckout);
  assert.deepEqual(await history(), originalHistory, 'A later failure must not commit an earlier pending migration.');
  assert.deepEqual(await schemaSnapshot(), originalSchema, 'All pending tables, indexes and constraints must roll back together.');
  assert.deepEqual(await records(), originalRecords, 'Failed migration must preserve original records.');
  console.log('PASS multi-migration transaction rollback');

  stage = 'seed prior Google, financial, keyword, domain, audit and conversion records at 0022';
  const priorAccountKey=randomBytes(32).toString('base64');
  const priorAccountEnvelope=encryptCredentials({version:1,legacyV1:config.authSecret,stableV2:priorAccountKey},{workspaceId:'instance',id:'provider-account-identity',provider:'dataforseo-account',revision:1});
  const upgradeClient=await pool.connect();
  try {
    await upgradeClient.query('BEGIN');
    for(const migration of sources.filter(m=>m.version>'0001'&&m.version<='0022')) {await upgradeClient.query(migration.sql);await upgradeClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
    await upgradeClient.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[priorAccountEnvelope]);
    const owner=originalRecords.user[0].id,workspace=originalRecords.workspace[0].id,project=originalRecords.project[0].id,connection=randomUUID(),report=randomUUID(),provider=randomUUID(),research=randomUUID(),quote=randomUUID();
    await upgradeClient.query("INSERT INTO google_connection(id,workspace_id,project_id,name,provider,revision,app_revision,status) VALUES($1,$2,$3,'Upgrade fixture','gsc',1,1,'disconnected')",[connection,workspace,project]);
    await upgradeClient.query(`INSERT INTO google_import(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,status,pages,row_count,source,quality,completed_at)
      VALUES($1,$2,$3,$4,$5,1,1,'gsc_daily','2026-01-01','2026-01-01','completed',1,1,'{"provider":"gsc"}','{"warnings":[],"metadata":{}}',clock_timestamp())`,[report,connection,project,owner,randomUUID()]);
    await upgradeClient.query(`INSERT INTO google_import_page(import_id,page,rows) VALUES($1,0,'[{"dimensions":["2026-01-01"],"metrics":{"clicks":1}}]')`,[report]);
    await upgradeClient.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Upgrade fixture')",[provider,workspace]);
    await upgradeClient.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month)
      VALUES($1,$2,$3,1,$4,$5,'keyword.overview',$6,12120,12120,'settled','2026-01-01')`,[research,workspace,provider,owner,randomUUID(),'a'.repeat(64)]);
    await upgradeClient.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,12000,120,12120,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
      [quote,workspace,project,owner,provider,JSON.stringify({connectionId:provider,mode:'overview',keywords:['preserved keyword'],locationCode:2840,languageCode:'en',limit:100}),'e'.repeat(64)]);
    await upgradeClient.query(`INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,result,reconciliation_evidence,completed_at)
      VALUES($1,$2,$3,$4,$5,'completed',$6,'{"taskId":"preserved-task","reportedCost":0.01212}','2026-01-01T00:00:00.123456Z')`,
      [research,workspace,project,owner,quote,JSON.stringify({source:'DataForSEO Labs',retrievedAt:'2026-01-01T00:00:00Z',rows:[{keyword:'preserved keyword',searchVolume:0,cpcUsd:'0.000001',competition:0,competitionLevel:null,keywordDifficulty:null,intent:null,monthlySearches:[],metricsUpdatedAt:null,intentUpdatedAt:null}],returnedCount:1,truncated:false,warnings:[]})]);
    const prompt=randomUUID(),version=randomUUID();
    await upgradeClient.query("INSERT INTO project_prompt(id,project_id,current_version_id,topic,enabled) VALUES($1,$2,$3,'Upgrade',false)",[prompt,project,version]);
    await upgradeClient.query("INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by) VALUES($1,$2,$3,1,'Preserved authored prompt','preserved authored prompt',$4)",[version,project,prompt,owner]);
    const domain=randomUUID();
    await upgradeClient.query("INSERT INTO project_domain(id,project_id,hostname,role,expected_target_host,verified_at) VALUES($1,$2,'alias.migration.test','redirect_alias','migration.test',clock_timestamp())",[domain,project]);
    await upgradeClient.query(`INSERT INTO domain_redirect_check(id,workspace_id,project_id,domain_id,user_id,request_id,domain_revision,hostname,expected_target_host,verified_at,status,observation,completed_at)
      SELECT $1,$2,$3,id,$4,$5,redirect_revision,hostname,expected_target_host,verified_at,'completed','{"fixture":"preserved redirect evidence"}'::jsonb,clock_timestamp()
      FROM project_domain WHERE id=$6`,[randomUUID(),workspace,project,owner,randomUUID(),domain]);
    const audit=randomUUID(),page=randomUUID();
    await upgradeClient.query(`INSERT INTO site_audit_run(id,workspace_id,project_id,user_id,request_id,request_hash,origin,config,status,created_at,deadline_at,completed_at,queue_job_id,
      robots_state,robots_body,robots_digest,coverage,summary)
      VALUES($1,$2,$3,$4,$5,$6,'https://migration.test','{"mode":"static","startPath":"/","startUrl":"https://migration.test/","maxPages":50}',
        'completed','2026-01-01T00:00:00Z','2026-01-01T00:30:00Z','2026-01-01T00:01:00Z',$7,'present',$8,$9,
        '{"reasons":[],"discoveryComplete":true,"linksComplete":true,"scopeExclusions":0,"rawEvidenceRecorded":true}','{"findingsComplete":true,"findings":1}')`,
      [audit,workspace,project,owner,randomUUID(),'b'.repeat(64),randomUUID(),Buffer.from('User-agent: *\nAllow: /'),'c'.repeat(64)]);
    await upgradeClient.query(`INSERT INTO site_audit_page(id,run_id,project_id,resource_kind,url,state,fetch_state,analysis_coverage,facts,evidence,evidence_recorded)
      VALUES($1,$2,$3,'html','https://migration.test/','done','ok','analyzed','{"wordCount":42}','{"title":"Preserved audit evidence"}',true)`,[page,audit,project]);
    await upgradeClient.query("INSERT INTO site_audit_edge(id,run_id,source_page_id,kind,target_url,anchor) VALUES($1,$2,$3,'link','https://migration.test/next','Preserved anchor')",[randomUUID(),audit,page]);
    await upgradeClient.query(`INSERT INTO site_audit_issue(id,run_id,page_id,issue_key,rule_version,code,severity,details)
      VALUES($1,$2,$3,$4,'static-html-v1','missing-description','warning','{"fixture":"Preserved finding"}')`,[randomUUID(),audit,page,'d'.repeat(64)]);
    await upgradeClient.query('COMMIT');
  } catch(error) {await upgradeClient.query('ROLLBACK');throw error;} finally {upgradeClient.release();}
  // Exercise actual authored-definition CRUD against the prior schema, retaining its receipts too.
  for(const definition of [
    {kind:'goal' as const,name:'Preserved purchase goal',description:'Authored before saved keywords',condition:{type:'event',match:'exact',value:'purchase'}},
    {kind:'funnel' as const,name:'Preserved checkout funnel',description:'Authored before saved keywords',windowMinutes:60,steps:[{type:'path',match:'exact',value:'/cart'},{type:'event',match:'exact',value:'purchase'}]},
  ]) await saveAnalysis(originalRecords.project[0].id,originalRecords.user[0].id,definition.kind,{requestId:randomUUID(),definition});
  await saveSavedKeywords(originalRecords.project[0].id,originalRecords.user[0].id,{requestId:randomUUID(),revision:1,
    source:{type:'manual',keywords:['preserved authored keyword'],locationCode:2840,languageCode:'en'},tags:['Preserved intent']});
  const preservedTables=['google_connection','google_import','google_import_page','provider_connection','provider_request','keyword_research_run','project_prompt','prompt_text_version','project_content_request','analytics_definition','saved_keyword','saved_keyword_tag','saved_keyword_tag_assignment','project_domain','domain_redirect_check','site_audit_run','site_audit_page','site_audit_edge','site_audit_issue'];
  async function featureRecords() {const snapshot:Record<string,unknown>={};for(const table of preservedTables)snapshot[table]=(await pool.query(`SELECT to_jsonb(t)-'body_capture_state'-'body_extraction_version'-'body_text'${table==='google_connection'?"-'login_customer_id'":''} AS data FROM ${table} t`)).rows;return snapshot;}
  const featureSnapshot=await featureRecords();
  const quoteBefore=(await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q')).rows[0].data;
  const policyBefore=(await pool.query('SELECT raw_analytics_days,replay_days,raw_provider_evidence_days,derived_history_days,retention_revision FROM workspace')).rows;
  const originalDomain=(await pool.query('SELECT row_to_json(d) AS data FROM project_domain d')).rows[0].data;
  stage = 'seed actual0023 rank definitions and captured quote before authored revision';
  assert.equal((await history()).at(-1)?.version,'0022','Keep the historical feature baseline explicit.');
  const rankMigration=sources.find(m=>m.version==='0023')!,rankId=randomUUID(),rankKeyword=randomUUID(),rankRun=randomUUID();
  const owner=originalRecords.user[0].id,workspace=originalRecords.workspace[0].id,project=originalRecords.project[0].id;
  const provider=(await pool.query('SELECT id FROM provider_connection')).rows[0].id;
  const rankClient=await pool.connect();
  try{
    await rankClient.query('BEGIN');await rankClient.query(rankMigration.sql);await rankClient.query('INSERT INTO schema_version VALUES($1,$2)',[rankMigration.version,rankMigration.checksum]);
    await rankClient.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages,revision,keywords_revision,schedule_interval,schedule_timezone,schedule_hour,schedule_minute,schedule_enabled,approval_id,approval_user_id,approval_config_revision,approval_keywords_revision,approval_request_hash,approval_connection_id,approval_connection_revision,approval_account_fingerprint,approval_account_fingerprint_version,approval_max_micros,approved_at,next_due_at)
      VALUES($1,$2,$3,'Preserved rank tracker','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'both',100,3,7,11,'daily','UTC',9,0,true,$4,$5,7,11,$6,$7,1,$6,2,10000,clock_timestamp(),'2027-01-01T09:00:00Z')`,[rankId,workspace,project,randomUUID(),owner,'f'.repeat(64),provider]);
    await rankClient.query("INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case,pinned_at) VALUES($1,$2,$3,$4,'C++ %20',true,'2026-01-01T00:00:00.123456Z')",[rankKeyword,workspace,project,rankId]);
    await rankClient.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,'manual','live','quoted',7,11,$6,1,$7,'Preserved account','{"immutable":"captured quote"}',$7,2,10000,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[rankRun,workspace,project,rankId,owner,provider,'f'.repeat(64)]);
    await rankClient.query('COMMIT');
  }catch(error){await rankClient.query('ROLLBACK');throw error;}finally{rankClient.release();}
  assert.deepEqual(await featureRecords(),featureSnapshot,'Applying0023 must not change existing0022 feature records.');
  const rankTables=['rank_config','rank_keyword','rank_run','rank_dispatch','rank_task'];
  async function rankRecords(){const records:Record<string,Record<string,unknown>[]>={};for(const table of rankTables)records[table]=(await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`)).rows.map(r=>r.data);return records;}
  const rankBefore=await rankRecords();assert.equal(Object.hasOwn(rankBefore.rank_config[0],'authored_revision'),false);
  stage = 'seed actual0026 Meta receipts before profile fingerprint migration';
  const metaClient=await pool.connect(),metaApp=randomUUID(),metaConnection=randomUUID(),metaGrant=randomUUID(),metaIds=[randomUUID(),randomUUID(),randomUUID()];
  const metaDefinition={provider:'meta_ads',accountId:'123',accountName:'Preserved account',currency:'AED',timeZone:'Asia/Dubai',graphVersion:'v26.0',report:'campaign_daily',definitionVersion:1,level:'campaign',breakdowns:[],attribution:{mode:'meta_reported',requestedWindows:['7d_click','1d_view'],reportingPolicy:'meta_mixed',effectiveAdSetSettings:'unknown'}};
  try{
    await metaClient.query('BEGIN');
    for(const migration of sources.filter(m=>m.version>='0024'&&m.version<='0026')){await metaClient.query(migration.sql);await metaClient.query('INSERT INTO schema_version VALUES($1,$2)',[migration.version,migration.checksum]);}
    await metaClient.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,bound_origin,declared_mode)
      VALUES($1,'123','456',1,1,'{"synthetic":"preserved encrypted envelope"}',$2,'development')`,[metaApp,config.appUrl]);
    await metaClient.query("INSERT INTO meta_connection(id,workspace_id,project_id,name,status) VALUES($1,$2,$3,'Preserved source','disconnected')",[metaConnection,workspace,project]);
    await metaClient.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,granted_at,expires_at)
      VALUES($1,$2,1,1,$3,$4,$5,$6,'completed',$7,clock_timestamp(),clock_timestamp())`,[metaGrant,metaApp,workspace,project,owner,metaConnection,'a'.repeat(64)]);
    for(let i=0;i<metaIds.length;i++)await metaClient.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,completed_at,deleted_at,row_count,pages)
      VALUES($1,$2,$3,$4,$5,$6,1,1,$7,'campaign_daily','2020-01-01','2020-01-01',$8,CASE WHEN $10 THEN 'queued' ELSE 'completed' END,CASE WHEN NOT $10 THEN clock_timestamp() END,CASE WHEN $8::jsonb IS NULL THEN clock_timestamp() END,$9,$9)`,[metaIds[i],workspace,project,owner,metaConnection,metaGrant,randomUUID(),i===2?null:{...metaDefinition,accountName:i?'Renamed account':'Preserved account'},i===0?1:0,i===1]);
    await metaClient.query("UPDATE meta_import SET diagnostic_code='app_throttled',next_attempt_at=clock_timestamp()+interval '15 minutes' WHERE id=ANY($1::uuid[])",[metaIds.slice(0,2)]);
    await metaClient.query(`INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,'[{"date":"2020-01-01","accountId":"123","campaignId":"789","campaignName":"Preserved campaign","impressions":"9007199254740993","clicks":null,"spend":"1.2300","actions":null,"actionValues":[]}]',1,$4)`,[metaIds[0],project,workspace,'b'.repeat(64)]);
    await metaClient.query('COMMIT');
  }catch(error){await metaClient.query('ROLLBACK');throw error;}finally{metaClient.release();}
  const metaTables=['meta_app_registration','meta_connection','meta_oauth_flow','meta_deletion_request','meta_import','meta_import_page'];
  async function metaRecords(){const result:Record<string,Record<string,unknown>[]>={};for(const table of metaTables)result[table]=(await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.data);return result;}
  const metaBefore=await metaRecords();assert.equal(Object.hasOwn(metaBefore.meta_import[0],'definition_key'),false);assert.equal((await history()).at(-1)?.version,'0026');
  const profileSource=sources.find(s=>s.version==='0027')!;
  const profileClient=await pool.connect();await profileClient.query('BEGIN');
  try{await profileClient.query(profileSource.sql);await profileClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[profileSource.version,profileSource.checksum]);await profileClient.query('COMMIT');}catch(error){await profileClient.query('ROLLBACK');throw error;}finally{profileClient.release();}
  const meta27=await metaRecords();
  stage = 'seed actual0028 campaign receipts before independent cooldown migration';
  const inventoryMigration=sources.find(s=>s.version==='0028')!,inventoryClient=await pool.connect(),inventoryIds=[randomUUID(),randomUUID()];
  try{
    await inventoryClient.query('BEGIN');await inventoryClient.query(inventoryMigration.sql);await inventoryClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[inventoryMigration.version,inventoryMigration.checksum]);
    for(let n=0;n<2;n++)await inventoryClient.query(`INSERT INTO meta_campaign_inventory(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,source,status,completed_at,pages,row_count,first_fetched_at,last_fetched_at,diagnostic_code,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,CASE WHEN $9 THEN 'queued' ELSE 'completed' END,CASE WHEN NOT $9 THEN clock_timestamp() END,CASE WHEN $9 THEN 0 ELSE 1 END,CASE WHEN $9 THEN 0 ELSE 1 END,CASE WHEN NOT $9 THEN clock_timestamp() END,CASE WHEN NOT $9 THEN clock_timestamp() END,'account_throttled',clock_timestamp()+interval '15 minutes')`,[inventoryIds[n],workspace,project,owner,metaConnection,metaGrant,randomUUID(),{provider:'meta_ads',accountId:'123',accountName:'Preserved account',currency:'AED',timeZone:'Asia/Dubai',graphVersion:'v26.0',definitionVersion:1,kind:'campaign_inventory',effectiveStatuses:['ACTIVE','PAUSED','ARCHIVED','DELETED','IN_PROCESS','WITH_ISSUES']},n===1]);
    await inventoryClient.query(`INSERT INTO meta_campaign_inventory_page(inventory_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,'[{"id":"789","name":"Preserved campaign","configuredStatus":"PAUSED","effectiveStatus":"ACTIVE"}]',1,$4)`,[inventoryIds[0],project,workspace,'c'.repeat(64)]);
    await inventoryClient.query('COMMIT');
  }catch(error){await inventoryClient.query('ROLLBACK');throw error;}finally{inventoryClient.release();}
  assert.deepEqual(await metaRecords(),meta27,'Applying0028 preserves every existing Meta receipt and fingerprint.');
  const inventoryTables=['meta_campaign_inventory','meta_campaign_inventory_page'];
  async function inventoryRecords(){const records:Record<string,Record<string,unknown>[]>={};for(const table of inventoryTables)records[table]=(await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.data);return records;}
  const inventoryBefore=await inventoryRecords();
  stage = 'seed actual0029 project context before citation metadata';
  const contextClient=await pool.connect(),cooldownMigration=sources.find(m=>m.version==='0029')!;
  try{
    await contextClient.query('BEGIN');await contextClient.query(cooldownMigration.sql);await contextClient.query('INSERT INTO schema_version VALUES($1,$2)',[cooldownMigration.version,cooldownMigration.checksum]);
    await contextClient.query(`INSERT INTO project_context(project_id,revision,brand_name,brand_aliases) VALUES($1,17,'Preserved 品牌', '["Alias, one","+literal alias","Exact CASE"]')
      ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,brand_name=EXCLUDED.brand_name,brand_aliases=EXCLUDED.brand_aliases`,[project]);
    await contextClient.query('COMMIT');
  }catch(error){await contextClient.query('ROLLBACK');throw error;}finally{contextClient.release();}
  const contextRecords=async()=>(await pool.query('SELECT row_to_json(c) AS data FROM project_context c ORDER BY project_id')).rows.map(r=>r.data);
  const contextBefore=await contextRecords(),history29=await history();
  assert.equal(history29.at(-1)?.version,'0029');assert.equal(Object.hasOwn(contextBefore[0],'brand_citation_domains'),false);
  const priorBody=await pool.connect();try{await priorBody.query('BEGIN');for(const migration of sources.filter(m=>['0030','0031'].includes(m.version))){await priorBody.query(migration.sql);await priorBody.query('INSERT INTO schema_version VALUES($1,$2)',[migration.version,migration.checksum]);}await priorBody.query('COMMIT');}catch(error){await priorBody.query('ROLLBACK');throw error;}finally{priorBody.release();}
  const audit31=(await pool.query('SELECT to_jsonb(p) AS data FROM site_audit_page p ORDER BY id')).rows.map(r=>r.data),history31=await history();
  assert.equal(history31.at(-1)?.version,'0031');assert.equal(Object.hasOwn(audit31[0],'body_text'),false);
  stage = 'upgrade original,0022 features,0023 rank,0026–29 Meta and authored context through0032';
  const bodyMigration=sources.find(m=>m.version==='0032')!,bodyClient=await pool.connect();
  try{await bodyClient.query('BEGIN');await bodyClient.query(bodyMigration.sql);await bodyClient.query('INSERT INTO schema_version VALUES($1,$2)',[bodyMigration.version,bodyMigration.checksum]);await bodyClient.query('COMMIT');}catch(error){await bodyClient.query('ROLLBACK');throw error;}finally{bodyClient.release();}
  assert.deepEqual((await history()).slice(0,29),history29,'Citation migration preserves every prior applied checksum.');
  for(const table of ['ai_suggestion_quote','ai_suggestion_run'])assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount,0,'Upgrade creates no suggestion generation or paid work.');
  const audit32=(await pool.query('SELECT to_jsonb(p) AS data FROM site_audit_page p ORDER BY id')).rows.map(r=>r.data);
  assert.deepEqual((await history()).slice(0,31),history31);
  assert.deepEqual(audit32.map(({body_capture_state,body_extraction_version,body_text,...old})=>old),audit31,'Body migration preserves exact prior audit fields.');
  for(const row of audit32){assert.equal(row.body_capture_state,'not_recorded');assert.equal(row.body_extraction_version,null);assert.equal(row.body_text,null);}
  await pool.query("UPDATE site_audit_page SET body_capture_state='available',body_extraction_version='static-dom-body-v1',body_text='Preserved schema32 body 🐎'");
  const retained32=(await pool.query('SELECT to_jsonb(p) AS data FROM site_audit_page p ORDER BY id')).rows.map(r=>r.data),history32=await history();assert.equal(history32.at(-1)?.version,'0032');
  stage='upgrade actual schema32 retained body and prior receipts through0033';
  const segmentMigration=sources.find(m=>m.version==='0033')!,segmentClient=await pool.connect();
  try{await segmentClient.query('BEGIN');await segmentClient.query(segmentMigration.sql);await segmentClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[segmentMigration.version,segmentMigration.checksum]);await segmentClient.query('COMMIT');}finally{await segmentClient.query('ROLLBACK').catch(()=>{});segmentClient.release();}
  assert.equal((await pool.query('SELECT 1 FROM analytics_segment')).rowCount,0,'Migration must not invent authored filters.');
  const priorSegmentId=randomUUID();await pool.query("INSERT INTO analytics_segment(id,project_id,name,query,revision,created_at,updated_at) VALUES($1,$2,'Preserved filter 🐎','kind=all&path=%2Fliteral%25_',7,'2026-01-01T00:00:00.123Z','2026-01-02T00:00:00.456Z')",[priorSegmentId,originalRecords.project[0].id]);
  const retained33=(await pool.query('SELECT to_jsonb(s) AS data FROM analytics_segment s ORDER BY id')).rows.map(r=>r.data),history33=await history();
  assert.equal(history33.at(-1)?.version,'0033');stage='upgrade actual schema33 saved filters through0034';
  const annotationMigration=sources.find(m=>m.version==='0034')!,annotationClient=await pool.connect();
  try{await annotationClient.query('BEGIN');await annotationClient.query(annotationMigration.sql);await annotationClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[annotationMigration.version,annotationMigration.checksum]);await annotationClient.query('COMMIT');}finally{await annotationClient.query('ROLLBACK').catch(()=>{});annotationClient.release();}
  assert.equal((await pool.query('SELECT 1 FROM analytics_annotation')).rowCount,0,'Migration must not invent annotations.');
  await pool.query("INSERT INTO analytics_annotation(id,project_id,user_id,date,all_day,note,revision) VALUES($1,$2,$3,'2026-01-02T03:04:05.123Z',false,'Preserved note 🐎',9)",[randomUUID(),originalRecords.project[0].id,originalRecords.user[0].id]);
  const retained34=(await pool.query('SELECT to_jsonb(a) AS data FROM analytics_annotation a ORDER BY id')).rows.map(r=>r.data),history34=await history();
  stage='seed populated0037 identity evidence before forward event proof';
  const identityClient=await pool.connect(),identityVisitor='d'.repeat(64);
  try{
    await identityClient.query('BEGIN');
    for(const migration of sources.filter(m=>['0035','0036','0037'].includes(m.version))){await identityClient.query(migration.sql);await identityClient.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
    await identityClient.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2026-10-01T00:00:00.123456Z','2026-10-02T00:00:00.123456Z')",[project,identityVisitor]);
    await identityClient.query("UPDATE event SET source='browser',visitor_id=$2,visit_id=$3 WHERE project_id=$1",[project,identityVisitor,'e'.repeat(64)]);
    await identityClient.query("UPDATE project SET analytics_settings=jsonb_set(analytics_settings,'{linkIdentities}','true'),identity_links_started_at='2026-10-01T00:00:00.123456Z',identity_links_retained_from='2026-09-01T00:00:00.654321Z',identity_links_evidence_lost_at='2026-10-02T00:00:00.456789Z' WHERE id=$1",[project]);
    await identityClient.query("INSERT INTO analytics_identity_link(project_id,visitor_key,identity_version,key_generation,identity_token,first_accepted_at,last_accepted_at) VALUES($1,$2,1,$3,$4,'2026-10-01T00:00:00.123456Z','2026-10-02T00:00:00.654321Z')",[project,identityVisitor,'f'.repeat(64),'a'.repeat(64)]);
    await identityClient.query("INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at) VALUES($1,$2,'plan','{\"type\":\"string\",\"value\":\"preserved\"}','2026-10-02T00:00:00.123456Z')",[project,identityVisitor]);
    await identityClient.query("INSERT INTO analytics_identify_receipt(project_id,request_id,visitor_key,operation_hash,sent_at,expires_at,accepted_at) VALUES($1,$2,$3,$4,'2026-10-01T00:00:00.123456Z','2026-10-02T00:00:00.123456Z','2026-10-01T00:00:00.654321Z')",[project,randomUUID(),identityVisitor,'b'.repeat(64)]);
    await identityClient.query('COMMIT');
  }finally{await identityClient.query('ROLLBACK').catch(()=>{});identityClient.release();}
  const identityTables=['project','event','analytics_visitor','analytics_identity_link','analytics_session_property','analytics_identify_receipt'];
  async function identityRecords(){const out:Record<string,Record<string,unknown>[]>={};for(const table of identityTables)out[table]=(await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.data);return out;}
  const identity37=await identityRecords(),history37=await history();assert.equal(history37.at(-1)?.version,'0037');await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  stage='upgrade actual schema34 notes and populated0037 evidence through0038';
  const proofMigration=sources.find(m=>m.version==='0038')!,proofClient=await pool.connect();
  try{await proofClient.query('BEGIN');await proofClient.query(proofMigration.sql);await proofClient.query('INSERT INTO schema_version VALUES($1,$2)',[proofMigration.version,proofMigration.checksum]);await proofClient.query('COMMIT');}finally{await proofClient.query('ROLLBACK').catch(()=>{});proofClient.release();}
  assert.deepEqual((await history()).slice(0,37),history37,'Forward event proof preserves every old migration checksum.');
  const identity38=await identityRecords();
  for(const table of identityTables)assert.deepEqual(identity38[table].map(({identity_link_evidence_version,identity_event_evidence_started_at,...prior})=>prior),identity37[table],'Forward proof preserves every old identity, event, settings, epoch and retention value.');
  assert.ok(identity38.event.every(row=>row.identity_link_evidence_version===null));assert.ok(identity38.project.every(row=>row.identity_event_evidence_started_at===null));
  // Existing schema38 proof and every saved setting/epoch survive the default change.
  await pool.query('UPDATE event SET identity_link_evidence_version=1 WHERE project_id=$1',[project]);
  await pool.query("UPDATE project SET identity_event_evidence_started_at='2026-10-03T00:00:00.123456Z' WHERE id=$1",[project]);
  const proven38=await identityRecords(),history38=await history();assert.equal(history38.at(-1)?.version,'0038');
  stage='upgrade populated0038 proof and settings through0041';
  const through41=await pool.connect();
  try{await through41.query('BEGIN');for(const source of sources.filter(source=>source.version>'0038'&&source.version<='0041')){await through41.query(source.sql);await through41.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}await through41.query('COMMIT');}finally{await through41.query('ROLLBACK').catch(()=>{});through41.release();}
  const history41=await history(),schema41=await schemaSnapshot();assert.equal(history41.at(-1)?.version,'0041');
  const tables41=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename);
  async function rows41(){const snapshot:Record<string,unknown[]>={};for(const table of tables41)snapshot[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);return snapshot;}
  const data41=await rows41();stage='upgrade actual populated0041 to0042';
  // The current CLI applies all pending sources; seed ONLY42 natively so the
  // original42-only row/schema/empty-table oracles remain honest and unchanged.
  const searchMigration=sources.find(m=>m.version==='0042')!,searchClient=await pool.connect();
  try{await searchClient.query('BEGIN');await searchClient.query(searchMigration.sql);await searchClient.query('INSERT INTO schema_version VALUES($1,$2)',[searchMigration.version,searchMigration.checksum]);await searchClient.query('COMMIT');}finally{await searchClient.query('ROLLBACK').catch(()=>{});searchClient.release();}
  await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});assert.equal((await history()).at(-1)?.version,'0042');
  assert.deepEqual((await history()).slice(0,41),history41,'0042 preserves every published migration checksum.');
  assert.deepEqual(await rows41(),data41,'0042 preserves every row and field in every prior public table.');
  const schema42=await schemaSnapshot(),newTables=['ai_search_quote','ai_search_run'];
  for(const kind of ['columns','constraints','indexes'] as const)assert.deepEqual(schema42[kind].filter(row=>!newTables.includes(row.table_name??row.tablename)),schema41[kind],'0042 preserves all existing columns, constraints and indexes.');
  for(const table of newTables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'0042 creates no quotes, provider charges or jobs.');
  console.log('PASS actual populated41-to42 preserves all existing tables/rows/checksums/settings/grants and starts with empty AI capture tables');
  stage='seed populated0042 quote evidence before actual CLI0043 upgrade';
  const sourcePrompt=(await pool.query('SELECT p.id AS prompt_id,p.current_version_id AS version_id,v.text FROM project_prompt p JOIN prompt_text_version v ON v.id=p.current_version_id AND v.project_id=p.project_id AND v.prompt_id=p.id WHERE p.project_id=$1 ORDER BY p.id LIMIT 1',[project])).rows[0];assert.ok(sourcePrompt);
  const searchPrice=aiSearchPriceEvidence(),quote42Ids=[randomUUID(),randomUUID()],at42='2026-10-01T00:00:00.123456Z',snapshot42=aiSearchSnapshotSchema.parse({version:1,request:{profileId:aiSearchProfileId,capturedPrompt:sourcePrompt.text,locationCode:2840,languageCode:'en'},promptId:sourcePrompt.prompt_id,versionId:sourcePrompt.version_id,maxSpendUsd:'0.004000',country:{code:2840,name:'United States',countryCode:'US'},language:{code:'en',name:'English'},catalogRevision:'a'.repeat(64),countriesHash:'b'.repeat(64),languagesHash:'c'.repeat(64),preparedAt:at42,price:searchPrice}),quotes42=await pool.connect();
  try{await quotes42.query('BEGIN');for(let index=0;index<quote42Ids.length;index++)await quotes42.query(
    `INSERT INTO ai_search_quote(id,workspace_id,project_id,user_id,request_id,prompt_id,version_id,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,input_hash,profile_id,price_version,price_mode,price_source,price_checked_on,estimate_micros,input,created_at,expires_at,raw_expired_at,input_purged_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,2,$10,$11,$12,$13,$14,$15,4000,$16,$17,$17::timestamptz+interval '5 minutes',CASE WHEN $18 THEN $17::timestamptz+interval '1 day' END,CASE WHEN $18 THEN $17::timestamptz+interval '1 day' END)`,
    [quote42Ids[index],workspace,project,owner,randomUUID(),sourcePrompt.prompt_id,sourcePrompt.version_id,provider,'d'.repeat(64),canonicalHash(snapshot42),aiSearchProfileId,searchPrice.version,searchPrice.mode,searchPrice.sourceUrl,searchPrice.checkedOn,index?null:JSON.stringify(snapshot42),at42,index===1]);await quotes42.query('COMMIT');}finally{await quotes42.query('ROLLBACK').catch(()=>{});quotes42.release();}
  // Only42's new quote table was populated; all old finance and feature snapshots
  // remain untouched. This fixture does not claim a populated AI-search run.
  const history42=await history(),tables42=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename);
  assert.deepEqual(history42,sources.filter(s=>s.version<='0042').map(({version,checksum})=>({version,checksum})));
  async function rows42(){const snapshot:Record<string,unknown[]>={};for(const table of tables42)snapshot[table]=(await pool.query(`SELECT to_jsonb(t)${table==='google_connection'?"-'login_customer_id'":''} AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);return snapshot;}
  const data42=await rows42(),bossSchema42=(await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema;assert.equal(data42.ai_search_quote.length,2);assert.equal(data42.ai_search_run.length,0);
  // Preserve the exact43/44 schema and row checks before the current CLI applies48.
  // Historical actual CLI42-to43 and CLI43-to44 proofs remain separate accepted runs.
  stage='native SQL upgrade populated0042 to0043';const supportMigration=sources.find(m=>m.version==='0043')!,supportClient=await pool.connect();
  try{await supportClient.query('BEGIN');await supportClient.query(supportMigration.sql);await supportClient.query('INSERT INTO schema_version VALUES($1,$2)',[supportMigration.version,supportMigration.checksum]);await supportClient.query('COMMIT');}finally{await supportClient.query('ROLLBACK').catch(()=>{});supportClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,42),history42,'0043 preserves all42 published migration checksums.');assert.deepEqual(await rows42(),data42,'0043 preserves every field in every populated42 public table, including quote payloads/tombstones, original finance, credentials, grants and bodies.');
  const schema43=await schemaSnapshot(),new43Tables=['ai_content_support_quote','ai_content_support_run'];for(const kind of ['columns','constraints','indexes']as const)assert.deepEqual(schema43[kind].filter(row=>!new43Tables.includes(row.table_name??row.tablename)),schema42[kind],'0043 changes no prior column, constraint or index.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),[...tables42,...new43Tables].sort(),'Only the two dedicated43 tables are new.');for(const table of new43Tables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'0043 creates no quote, run, charge or implicit paid work.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'Migration must not start a queue.');
  console.log('PASS native SQL populated42-to43 preserves all42 rows/schema/checksums and retained/purged quote evidence; only two empty support tables are added');
  const history43=await history(),tables43=[...tables42,...new43Tables].sort();
  async function rows44(){const snapshot:Record<string,Record<string,unknown>[]>={};for(const table of tables43)snapshot[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.row);return snapshot;}
  const data43=await rows44();stage='native registered SQL upgrade populated0043 to0044';const adsMigration=sources.find(m=>m.version==='0044')!,adsClient=await pool.connect();
  try{await adsClient.query('BEGIN');await adsClient.query(adsMigration.sql);await adsClient.query('INSERT INTO schema_version VALUES($1,$2)',[adsMigration.version,adsMigration.checksum]);await adsClient.query('COMMIT');}finally{await adsClient.query('ROLLBACK').catch(()=>{});adsClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,43),history43,'0044 preserves all43 published migration checksums.');
  const data44=await rows44();for(const table of tables43){assert.equal(data44[table].length,data43[table].length);assert.deepEqual(data44[table].map(row=>table==='google_connection'?Object.fromEntries(Object.entries(row).filter(([key])=>key!=='login_customer_id')):row),data43[table],'0044 preserves every prior field, body, token, identity and financial row.');}
  assert.ok(data44.google_connection.every(row=>row.login_customer_id===null),'Existing sources gain only a NULL login manager; no account is inferred.');
  const schema44=await schemaSnapshot();assert.deepEqual(schema44.columns.filter(row=>!(row.table_name==='google_connection'&&row.column_name==='login_customer_id')),schema43.columns,'0044 adds only the declared nullable manager column.');assert.deepEqual(schema44.indexes,schema43.indexes);
  const changed44=new Set(['google_connection_provider_check','google_oauth_flow_provider_check','google_import_report_check','google_connection_ads_login_check']);assert.deepEqual(schema44.constraints.filter(row=>!changed44.has(row.name)),schema43.constraints.filter(row=>!changed44.has(row.name)),'Only the declared Google provider/report/login checks change.');assert.deepEqual(schema44.constraints.filter(row=>changed44.has(row.name)).map(row=>row.name).sort(),[...changed44].sort());
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),tables43,'0044 adds no table.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0044 starts no queue.');
  console.log('PASS native registered SQL43-to44 preserves all prior fields/checksums/financial evidence; historical CLI43-to44 proof remains separate');
  const history44=await history(),identity44=await identityRecords();assert.deepEqual(history44,sources.filter(source=>source.version<='0044').map(({version,checksum})=>({version,checksum})));
  // Historical actual CLI44-to45,45-to46 and their no-ops passed separately; current CLI now applies48.
  stage='native registered SQL upgrade populated0044 to0045';const preferenceMigration=sources.find(m=>m.version==='0045')!,preferenceClient=await pool.connect();
  try{await preferenceClient.query('BEGIN');await preferenceClient.query(preferenceMigration.sql);await preferenceClient.query('INSERT INTO schema_version VALUES($1,$2)',[preferenceMigration.version,preferenceMigration.checksum]);await preferenceClient.query('COMMIT');}finally{await preferenceClient.query('ROLLBACK').catch(()=>{});preferenceClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,44),history44,'0045 preserves every published migration checksum through44.');assert.deepEqual(await rows44(),data44,'0045 preserves every field in every old public table, including identity, credentials, source evidence and financial rows.');assert.deepEqual(await identityRecords(),identity44,'0045 preserves all original identity evidence exactly.');
  const schema45=await schemaSnapshot();for(const kind of ['columns','constraints','indexes']as const)assert.deepEqual(schema45[kind].filter(row=>(row.table_name??row.tablename)!=='user_preference'),schema44[kind],'0045 changes no prior column, constraint or index.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),[...tables43,'user_preference'].sort(),'Only user_preference is added by45.');assert.equal((await pool.query('SELECT 1 FROM user_preference')).rowCount,0,'Migration45 creates no preference rows or implicit user changes.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0045 starts no queue.');
  console.log('PASS native registered SQL44-to45 preserves all44 rows/schema/checksums/identity/finance and adds only one empty personal preference table; historical actual CLI proof remains separate');
  const history45=await history(),identity45=await identityRecords(),tables45=[...tables43,'user_preference'].sort();
  async function rows45(){const snapshot:Record<string,unknown[]>={};for(const table of tables45)snapshot[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);return snapshot;}
  const data45=await rows45();assert.deepEqual(history45,sources.filter(source=>source.version<='0045').map(({version,checksum})=>({version,checksum})));
  stage='native registered SQL upgrade populated0045 to0046';const reportMigration=sources.find(m=>m.version==='0046')!,reportClient=await pool.connect();
  try{await reportClient.query('BEGIN');await reportClient.query(reportMigration.sql);await reportClient.query('INSERT INTO schema_version VALUES($1,$2)',[reportMigration.version,reportMigration.checksum]);await reportClient.query('COMMIT');}finally{await reportClient.query('ROLLBACK').catch(()=>{});reportClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,45),history45,'0046 preserves every published migration checksum through45.');assert.deepEqual(await rows45(),data45,'0046 preserves every45 table/row/field, including preferences, source evidence, credentials, identities and financial receipts.');assert.deepEqual(await identityRecords(),identity45);
  const schema46=await schemaSnapshot(),reportCheck=(row:{table_name:string;name:string})=>row.table_name==='google_import'&&row.name==='google_import_report_check';
  assert.deepEqual(schema46.columns,schema45.columns,'0046 adds no column or changes any45 field.');assert.deepEqual(schema46.indexes,schema45.indexes,'0046 changes no45 index.');assert.deepEqual(schema46.constraints.filter(row=>!reportCheck(row)),schema45.constraints.filter(row=>!reportCheck(row)),'0046 changes only the Google report CHECK.');
  const check45=schema45.constraints.find(reportCheck),check46=schema46.constraints.find(reportCheck);assert.ok(check45&&check46);assert.ok(check45.definition.includes("'ga4_events'::text"));assert.deepEqual(check46,{...check45,definition:check45.definition.replace("'ga4_events'::text","'ga4_events'::text, 'ga4_pages'::text, 'ga4_acquisition'::text, 'ga4_key_events'::text")},'0046 broadens only the three declared GA4 report IDs.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),tables45,'0046 adds no table.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0046 starts no queue.');
  console.log('PASS native registered SQL45-to46 preserves all45 rows/schema/checksums/identity/finance and broadens only the declared GA4 report CHECK; historical actual CLI proof remains separate');
  const history46=await history(),data46=await rows45(),identity46=await identityRecords();assert.deepEqual(history46,sources.filter(source=>source.version<='0046').map(({version,checksum})=>({version,checksum})));
  // Historical actual CLI46-to47 and47 no-op proof remains separate. Current CLI targets48.
  stage='native registered SQL upgrade populated0046 to0047';const modelMigration=sources.find(m=>m.version==='0047')!,modelClient=await pool.connect();
  try{await modelClient.query('BEGIN');await modelClient.query(modelMigration.sql);await modelClient.query('INSERT INTO schema_version VALUES($1,$2)',[modelMigration.version,modelMigration.checksum]);await modelClient.query('COMMIT');}finally{await modelClient.query('ROLLBACK').catch(()=>{});modelClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,46),history46,'0047 preserves every published migration checksum through46.');assert.deepEqual(await rows45(),data46,'0047 preserves every46 table/row/field, including source, financial, identity and preference evidence.');assert.deepEqual(await identityRecords(),identity46);
  const schema47=await schemaSnapshot(),positionCheck=(row:{table_name:string;name:string})=>row.table_name==='prompt_execution'&&row.name==='prompt_execution_position_check';
  assert.deepEqual(schema47.columns,schema46.columns,'0047 changes no46 column.');assert.deepEqual(schema47.indexes,schema46.indexes,'0047 changes no46 index.');assert.deepEqual(schema47.constraints.filter(row=>!positionCheck(row)),schema46.constraints.filter(row=>!positionCheck(row)),'0047 changes only the prompt execution position CHECK.');
  const position46=schema46.constraints.find(positionCheck),position47=schema47.constraints.find(positionCheck);assert.ok(position46&&position47);assert.ok(position46.definition.includes('ARRAY[0, 1]'));assert.deepEqual(position47,{...position46,definition:position46.definition.replace('ARRAY[0, 1]','ARRAY[0, 1, 2, 3]')},'0047 broadens only execution positions0,1 to0,1,2,3.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),tables45,'0047 adds no table.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0047 starts no queue.');
  console.log('PASS native registered SQL46-to47 preserves all46 checksums/schema/rows/finance and broadens only the declared prompt position CHECK; historical actual CLI proof remains separate');
  const identity40=await identityRecords();
  for(const table of identityTables)assert.deepEqual(identity40[table].map(({collection_basis,...prior})=>prior),proven38[table],'Cookieless migration preserves every existing row, settings, epoch, revision and forward identity proof.');
  assert.ok(identity40.event.every(row=>row.collection_basis===null));assert.ok(identity40.project.every(row=>!(row.analytics_settings as Record<string,unknown>).collectionMode));
  assert.ok(identity40.project.every(row=>!Object.hasOwn(row.analytics_settings as Record<string,unknown>,'captureGeography')),'0040 must not add geography capture to existing project settings.');
  assert.deepEqual((await history()).slice(0,38),history38);
  assert.deepEqual((await history()).slice(0,34),history34);assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS data FROM analytics_annotation a ORDER BY id')).rows.map(r=>r.data),retained34);assert.equal((await pool.query('SELECT 1 FROM analytics_cohort')).rowCount,0,'Migration must not invent cohorts or membership.');
  assert.deepEqual((await history()).slice(0,33),history33);assert.deepEqual((await pool.query('SELECT to_jsonb(s) AS data FROM analytics_segment s ORDER BY id')).rows.map(r=>r.data),retained33);
  assert.deepEqual((await history()).slice(0,32),history32);assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS data FROM site_audit_page p ORDER BY id')).rows.map(r=>r.data),retained32,'Saved filters preserve every actual schema32 page field and body byte.');
  const contextAfter=await contextRecords();
  assert.deepEqual(contextAfter.map(({brand_citation_domains,citation_category_overrides,...prior})=>prior),contextBefore,'Citation defaults preserve the exact old revision, brand name and ordered aliases.');
  for(const row of contextAfter){assert.deepEqual(row.brand_citation_domains,[]);assert.deepEqual(row.citation_category_overrides,[]);}
  const defaultsClient=await pool.connect();
  try{
    await defaultsClient.query('BEGIN');const defaultsProject=randomUUID();
    await defaultsClient.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Defaults fixture','https://defaults.example.com',$3)",[defaultsProject,workspace,randomUUID()]);
    assert.deepEqual((await defaultsClient.query('SELECT analytics_settings FROM project WHERE id=$1',[defaultsProject])).rows[0].analytics_settings,{enabled:true,consentMode:'builtin',collectionMode:'cookieless',captureReferrer:false,captureCampaigns:false,captureScreen:false,captureGeography:true,excludeBots:true,excludedPaths:[]},'0039/0040 change only future project defaults to cookieless collection and geography capture.');
    for(const values of [['api','consent',null],['browser','unknown',null],['browser','cookieless',1]]){
      await defaultsClient.query('SAVEPOINT rejected_basis');
      await assert.rejects(defaultsClient.query("INSERT INTO event(id,project_id,event_name,path,source,collection_basis,identity_link_evidence_version,visitor_id,visit_id) VALUES($1,$2,'page_view','/',$3,$4,$5,$6,$6)",[randomUUID(),project,values[0],values[1],values[2],identityVisitor]),{code:'23514'});
      await defaultsClient.query('ROLLBACK TO SAVEPOINT rejected_basis');
    }
    await defaultsClient.query("INSERT INTO project_context(project_id,brand_name) VALUES($1,'New context')",[defaultsProject]);
    assert.deepEqual((await defaultsClient.query('SELECT revision,brand_aliases,brand_citation_domains,citation_category_overrides FROM project_context WHERE project_id=$1',[defaultsProject])).rows,[{revision:1,brand_aliases:[],brand_citation_domains:[],citation_category_overrides:[]}],'New rows retain original defaults and gain only empty citation metadata.');
  }finally{await defaultsClient.query('ROLLBACK');defaultsClient.release();}
  assert.deepEqual(await featureRecords(),featureSnapshot);
  const upgradedDomain=(await pool.query('SELECT row_to_json(d) AS data FROM project_domain d')).rows[0].data;
  assert.deepEqual(upgradedDomain,originalDomain,'Domain proof, alias settings and revision survive the saved-keyword upgrade unchanged.');
  assert.equal((await pool.query('SELECT id FROM domain_redirect_check')).rowCount,1,'Upgrade preserves the existing redirect receipt and schedules no extra check.');
  for(const table of ['site_audit_run','site_audit_page','site_audit_edge','site_audit_issue'])assert.equal((await pool.query(`SELECT id FROM ${table}`)).rowCount,1,'Upgrade must preserve existing audit evidence without starting another audit.');
  assert.equal((await pool.query('SELECT id FROM analytics_definition')).rowCount,2,'Upgrade preserves both authored conversions and creates no extra definitions.');
  const quoteAfter=(await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q')).rows[0].data;
  assert.deepEqual(Object.fromEntries(Object.keys(quoteBefore).map(key=>[key,quoteAfter[key]])),quoteBefore,'Prior keyword quote evidence must remain unchanged.');
  assert.equal(quoteAfter.saved_refresh_plan_id,null);assert.equal(quoteAfter.saved_target_ids,null,'Prior research must not become an approved saved refresh.');
  assert.equal(quoteAfter.account_fingerprint_version,1,'Legacy fingerprints retain their explicit version and original hash.');
  await assertProviderAccountIdentityReadable();
  assert.deepEqual((await pool.query("SELECT provider_account_identity FROM installation WHERE id='instance'")).rows[0].provider_account_identity,priorAccountEnvelope,'0024 preserves the exact existing encrypted capsule.');
  assert.equal(await getProviderAccountIdentityKey(1),config.authSecret);assert.equal(await getProviderAccountIdentityKey(2),priorAccountKey);
  assert.deepEqual((await pool.query('SELECT raw_analytics_days,replay_days,raw_provider_evidence_days,derived_history_days,retention_revision FROM workspace')).rows,policyBefore,'Upgrade must preserve retention policy and revision.');
  assert.deepEqual((await pool.query('SELECT saved_keywords_revision,saved_keyword_metrics_revision::text FROM project')).rows,[{saved_keywords_revision:2,saved_keyword_metrics_revision:'1'}]);
  for(const table of ['saved_keyword','saved_keyword_tag','saved_keyword_tag_assignment'])assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount,1,'Upgrade must preserve the authored keyword and tag without inventing another.');
  assert.equal((await pool.query('SELECT 1 FROM saved_keyword_refresh_plan')).rowCount,0,'Upgrade must not invent paid refresh work.');
  const rankAfter=await rankRecords();
  for(const table of rankTables){assert.equal(rankAfter[table].length,rankBefore[table].length,'Upgrade must not invent rank work.');for(let index=0;index<rankBefore[table].length;index++)assert.deepEqual(Object.fromEntries(Object.keys(rankBefore[table][index]).map(key=>[key,rankAfter[table][index][key]])),rankBefore[table][index],'Existing rank identity, approvals, pins and captured quotes must be preserved.');}
  assert.equal(rankAfter.rank_config[0].authored_revision,1);assert.equal(rankAfter.rank_config[0].revision,7);assert.equal(rankAfter.rank_config[0].keywords_revision,11);assert.equal(rankAfter.rank_config[0].schedule_enabled,true);
  const metaAfter=await metaRecords();
  for(const table of metaTables)assert.deepEqual(metaAfter[table].map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['app_cooldown_until','account_cooldown_until'].includes(key)))),meta27[table],'Cooldown schema preserves every existing Meta field.');
  const inventoryAfter=await inventoryRecords();
  for(const table of inventoryTables)assert.deepEqual(inventoryAfter[table].map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['app_cooldown_until','account_cooldown_until'].includes(key)))),inventoryBefore[table],'Cooldown schema preserves existing campaign receipts/pages and does not enqueue work.');
  for(const row of metaAfter.meta_import){assert.equal(row.app_cooldown_until,row.id===metaIds[1]?row.next_attempt_at:null);assert.equal(row.account_cooldown_until,null);}
  for(const row of inventoryAfter.meta_campaign_inventory){assert.equal(row.account_cooldown_until,row.id===inventoryIds[1]?row.next_attempt_at:null);assert.equal(row.app_cooldown_until,null);}
  for(const table of metaTables){assert.equal(metaAfter[table].length,metaBefore[table].length);for(const old of metaBefore[table]){const current=metaAfter[table].find(r=>table==='meta_import_page'?r.import_id===old.import_id:r.id===old.id)!;assert.deepEqual(Object.fromEntries(Object.keys(old).map(key=>[key,current[key]])),old,'Profile backfill must preserve every existing Meta field, including source, deleted receipts and exact pages.');}}
  const profileRows=(await pool.query("SELECT id,definition_key,encode(sha256(convert_to((source-'accountName')::text,'UTF8')),'hex') AS expected FROM meta_import ORDER BY id")).rows;
  for(const row of profileRows)assert.equal(row.definition_key,row.expected);assert.equal(profileRows.find(r=>r.id===metaIds[0]).definition_key,profileRows.find(r=>r.id===metaIds[1]).definition_key,'Account label changes do not change measurement profile.');assert.equal(profileRows.find(r=>r.id===metaIds[2]).definition_key,null,'Already deleted legacy profile stays explicitly unknown.');
  const history47=await history(),data47=await rows45(),identity47=await identityRecords();
  assert.deepEqual(history47,sources.filter(source=>source.version<='0047').map(({version,checksum})=>({version,checksum})));
  // Historical actual47→48/48noop and48→49/49noop receipts remain separate evidence.
  stage='native registered SQL upgrade populated0047 to0048';const domainMigration=sources.find(m=>m.version==='0048')!,domainClient=await pool.connect();
  try{await domainClient.query('BEGIN');await domainClient.query(domainMigration.sql);await domainClient.query('INSERT INTO schema_version VALUES($1,$2)',[domainMigration.version,domainMigration.checksum]);await domainClient.query('COMMIT');}finally{await domainClient.query('ROLLBACK').catch(()=>{});domainClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,47),history47,'0048 preserves every001–047 migration checksum.');
  assert.deepEqual(await rows45(),data47,'0048 preserves every existing47 row and field, including financial receipts, provider identity and preferences.');assert.deepEqual(await identityRecords(),identity47);
  const new48Tables=['domain_research_quote','domain_research_run'],schema48=await schemaSnapshot();
  assert.deepEqual(schema48.columns.filter(row=>!new48Tables.includes(row.table_name)),schema47.columns,'0048 changes no existing47 column.');
  assert.deepEqual(schema48.constraints.filter(row=>!new48Tables.includes(row.table_name)),schema47.constraints,'0048 changes no existing47 constraint.');
  assert.deepEqual(schema48.indexes.filter(row=>!new48Tables.includes(row.tablename)),schema47.indexes,'0048 changes no existing47 index.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),[...tables45,...new48Tables].sort());
  for(const table of new48Tables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'Migration48 creates no research, quote or paid work.');
  assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0048 starts no queue.');
  console.log('PASS native registered SQL47-to48 preserves all47 rows/schema/checksums/identity/finance and adds only two empty Domain SEO tables');
  const history48=await history(),data48=await rows45(),identity48=await identityRecords(),domain48=(await pool.query('SELECT to_jsonb(r) AS row FROM domain_research_run r ORDER BY id')).rows;
  stage='native registered SQL upgrade populated0048 to0049';const organicMigration=sources.find(m=>m.version==='0049')!,organicClient=await pool.connect();
  try{await organicClient.query('BEGIN');await organicClient.query(organicMigration.sql);await organicClient.query('INSERT INTO schema_version VALUES($1,$2)',[organicMigration.version,organicMigration.checksum]);await organicClient.query('COMMIT');}finally{await organicClient.query('ROLLBACK').catch(()=>{});organicClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,48),history48,'0049 preserves every published001–048 checksum.');assert.deepEqual(await rows45(),data48,'0049 preserves every prior row, financial receipt and Google page.');assert.deepEqual(await identityRecords(),identity48);assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS row FROM domain_research_run r ORDER BY id')).rows,domain48);
  const schema49=await schemaSnapshot();assert.deepEqual(schema49.columns,schema48.columns);assert.deepEqual(schema49.indexes,schema48.indexes);assert.deepEqual(schema49.constraints.filter(row=>!reportCheck(row)),schema48.constraints.filter(row=>!reportCheck(row)));
  const check48=schema48.constraints.find(reportCheck),check49=schema49.constraints.find(reportCheck);assert.ok(check48&&check49);assert.deepEqual(check49,{...check48,definition:check48.definition.replace("'ga4_key_events'::text","'ga4_key_events'::text, 'ga4_organic_landing'::text, 'ga4_organic_daily'::text, 'ga4_organic_weekly'::text")},'0049 broadens only three fixed organic report IDs.');
  console.log('PASS native registered SQL48-to49 preserves all48 schema/rows/checksums/finance and broadens only three organic IDs; historical actual CLI proof remains separate');
  const history49=await history(),data49=await rows45(),identity49=await identityRecords();
  stage='seed one synthetic paid legacy execution at schema0049 before cache backfill';
  const paidConnection=randomUUID(),paidQuote=randomUUID(),paidComparison=randomUUID(),paidRun=randomUUID(),paidAt='2026-10-01T00:00:00.123456Z';
  const paidRoute={model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI',promptCapacity:128000,completionCapacity:16384,promptPrice:'0.00000015',completionPrice:'0.0000006',requestPrice:'0',estimateMicros:'20429'};
  const paidResult={text:'Preserved paid legacy answer 🐎',resolvedModel:'openai/gpt-4o-mini',provider:'OpenAI',finishReason:'stop',citations:[{url:'https://migration.test/preserved-source',title:'Preserved source'}],promptTokens:12,completionTokens:20,receivedAt:'2026-10-01T00:00:02.123456Z'};
  const paidClient=await pool.connect();
  try{
    await paidClient.query('BEGIN');
    await paidClient.query("INSERT INTO provider_connection(id,workspace_id,provider,name,created_at,updated_at) VALUES($1,$2,'openrouter','Synthetic legacy paid migration fixture',$3,$3)",[paidConnection,workspace,paidAt]);
    await paidClient.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$14::timestamptz+interval '5 minutes')`,
      [paidQuote,workspace,project,owner,sourcePrompt.prompt_id,sourcePrompt.version_id,paidConnection,'1'.repeat(64),'2'.repeat(64),{connectionId:paidConnection,promptId:sourcePrompt.prompt_id,versionId:sourcePrompt.version_id,models:['openai/gpt-4o-mini'],maxCompletionTokens:2048,fundedCredits:true},JSON.stringify([{role:'user',content:sourcePrompt.text}]),JSON.stringify([paidRoute]),'3'.repeat(64),paidAt]);
    await paidClient.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[paidComparison,paidQuote,workspace,project,owner,randomUUID(),paidAt]);
    await paidClient.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,provider_reference,created_at,updated_at)
      VALUES($1,$2,$3,1,$4,$5,'prompt.execute',$6,20429,13,'settled','2026-10-01','gen-preserved-legacy',$7,$7::timestamptz+interval '2 seconds')`,[paidRun,workspace,paidConnection,owner,randomUUID(),'3'.repeat(64),paidAt]);
    await paidClient.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,evidence,generation_id,dispatched_at,completed_at)
      VALUES($1,$2,$3,$4,0,$5,'completed',$6,'{"reportedCost":"0.000012345","isByok":false,"upstreamReportedCost":"0"}','gen-preserved-legacy',$7::timestamptz+interval '1 second',$7::timestamptz+interval '2 seconds')`,[paidRun,paidComparison,workspace,project,paidRoute,paidResult,paidAt]);
    await paidClient.query('COMMIT');
  }finally{await paidClient.query('ROLLBACK').catch(()=>{});paidClient.release();}
  const paidFixtureIds:Record<string,string>={provider_connection:paidConnection,prompt_execution_quote:paidQuote,prompt_comparison:paidComparison,provider_request:paidRun,prompt_execution:paidRun};
  // Remove only these independently asserted additions when comparing older complete snapshots.
  function withoutPaidFixture(snapshot:Record<string,unknown>){return Object.fromEntries(Object.entries(snapshot).map(([table,rows])=>{
    if(!Object.hasOwn(paidFixtureIds,table))return [table,rows];assert.ok(Array.isArray(rows));
    return [table,rows.filter(row=>{assert.ok(row&&typeof row==='object');const data='data'in row?row.data:row;assert.ok(data&&typeof data==='object'&&'id'in data);return data.id!==paidFixtureIds[table];})];
  }));}
  async function paidFixtureRecords(stripRecurring=false){const out:Record<string,unknown>={};for(const [table,id] of Object.entries(paidFixtureIds)){const projection=`to_jsonb(t)-'cache_key'-'cache_plan'${stripRecurring&&table==='prompt_execution_quote'?"-'recurring_occurrence_id'-'recurring_models_hash'":''}`,rows=(await pool.query(`SELECT ${projection} AS data,encode(sha256(convert_to((${projection})::text,'UTF8')),'hex') AS sha256 FROM ${pg.escapeIdentifier(table)} t WHERE id=$1`,[id])).rows;assert.equal(rows.length,1);out[table]=rows[0];}return out;}
  const paidBefore=await paidFixtureRecords(),keywordLedgerBefore=(await pool.query("SELECT to_jsonb(p) AS data FROM provider_request p WHERE operation='keyword.overview'")).rows;
  assert.equal(keywordLedgerBefore.length,1);assert.equal(keywordLedgerBefore[0].data.actual_micros,12120);assert.equal(keywordLedgerBefore[0].data.status,'settled');
  assert.equal((await pool.query('SELECT to_regclass(\'prompt_comparison_item\')::text AS name')).rows[0].name,null);
  // Preserve the complete populated50-only cache/backfill oracles below. The
  // current CLI applies51; historical actual CLI49-to50 evidence stays separate.
  stage='native registered SQL upgrade populated0049 to0050';const cacheMigration=sources.find(m=>m.version==='0050')!,cacheClient=await pool.connect();
  try{await cacheClient.query('BEGIN');await cacheClient.query(cacheMigration.sql);await cacheClient.query('INSERT INTO schema_version VALUES($1,$2)',[cacheMigration.version,cacheMigration.checksum]);await cacheClient.query('COMMIT');}finally{await cacheClient.query('ROLLBACK').catch(()=>{});cacheClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,49),history49,'0050 preserves every001–049 migration checksum.');assert.deepEqual(withoutPaidFixture(await rows45()),data49,'0050 preserves every existing row and original financial identity.');assert.deepEqual(await identityRecords(),identity49);assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS row FROM domain_research_run r ORDER BY id')).rows,domain48);
  const schema50=await schemaSnapshot(),newCacheTable='prompt_comparison_item',addedColumns=(row:{table_name:string;column_name:string})=>(row.table_name==='prompt_execution_quote'&&row.column_name==='cache_plan')||(row.table_name==='prompt_execution'&&row.column_name==='cache_key'),addedConstraints=['prompt_execution_quote_cache_plan_check','prompt_execution_cache_key_check','prompt_execution_scoped_identity'];
  assert.deepEqual(schema50.columns.filter(row=>row.table_name!==newCacheTable&&!addedColumns(row)),schema49.columns);
  assert.deepEqual(schema50.columns.filter(addedColumns),[{table_name:'prompt_execution',column_name:'cache_key',data_type:'text',is_nullable:'YES',column_default:null},{table_name:'prompt_execution_quote',column_name:'cache_plan',data_type:'jsonb',is_nullable:'YES',column_default:null}]);
  assert.deepEqual(schema50.constraints.filter(row=>row.table_name!==newCacheTable&&!addedConstraints.includes(row.name)),schema49.constraints);assert.deepEqual(schema50.constraints.filter(row=>addedConstraints.includes(row.name)).map(row=>row.name).sort(),[...addedConstraints].sort());
  assert.deepEqual(schema50.indexes.filter(row=>row.tablename!==newCacheTable&&!['prompt_execution_cache_idx','prompt_execution_scoped_identity'].includes(row.indexname)),schema49.indexes);
  const paidItem={id:paidRun,comparison_id:paidComparison,workspace_id:workspace,project_id:project,position:0,execution_id:paidRun,reused:false};
  assert.deepEqual((await pool.query('SELECT * FROM prompt_comparison_item ORDER BY id')).rows,[paidItem],'The single legacy paid run becomes exactly one same-ID, scoped, non-reused ordered item.');
  assert.deepEqual(await paidFixtureRecords(),paidBefore,'Backfill preserves all five complete fixture rows, including original answer, charge and timestamps; only declared new nullable columns are normalized.');
  assert.deepEqual((await pool.query('SELECT id,status,actual_micros FROM provider_request WHERE id=$1',[paidRun])).rows,[{id:paidRun,status:'settled',actual_micros:'13'}]);
  assert.deepEqual((await pool.query('SELECT cache_key FROM prompt_execution WHERE id=$1',[paidRun])).rows,[{cache_key:null}]);assert.deepEqual((await pool.query('SELECT cache_plan FROM prompt_execution_quote WHERE id=$1',[paidQuote])).rows,[{cache_plan:null}]);
  assert.deepEqual((await pool.query("SELECT to_jsonb(p) AS data FROM provider_request p WHERE operation='keyword.overview'")).rows,keywordLedgerBefore,'The original keyword12120µ financial identity is unchanged alongside the separate synthetic13µ prompt charge.');
  console.log('PASS populated legacy paid execution backfills exactly one original-run item with unchanged answer and separate13-micro charge');
  assert.deepEqual((await pool.query("SELECT t.tgname,p.proname,t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='prompt_execution'::regclass AND NOT t.tgisinternal ORDER BY t.tgname")).rows,[{tgname:'prompt_execution_item',proname:'link_prompt_execution_item',tgenabled:'O'}]);
  assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0050 starts no jobs.');
  console.log('PASS native registered SQL49-to50 preserves all49 rows/checksums/finance and adds only cache identity/ordered original-run links and the paid insertion invariant; historical actual CLI proof remains separate');
  const history50=await history(),identity50=await identityRecords(),tables50=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename);
  assert.deepEqual(history50,sources.filter(source=>source.version<='0050').map(({version,checksum})=>({version,checksum})));
  async function all50Rows(stripRecurring=false){const rows:Record<string,unknown[]>={};for(const table of tables50)rows[table]=(await pool.query(`SELECT to_jsonb(t)${stripRecurring&&table==='prompt_execution_quote'?"-'recurring_occurrence_id'-'recurring_models_hash'":''} AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);return rows;}
  const data50=await all50Rows(),financial50=(await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p ORDER BY id')).rows,paidTrigger50=(await pool.query("SELECT t.tgname,p.proname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(p.oid) AS function FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='prompt_execution'::regclass AND NOT t.tgisinternal ORDER BY t.tgname")).rows,recurringTables=['prompt_tracker','prompt_occurrence'];
  for(const table of recurringTables)assert.equal((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name,null,'Recurring tables do not exist at50.');
  stage='native registered SQL upgrade populated0050 to0051';const recurringMigration=sources.find(source=>source.version==='0051')!,recurringClient=await pool.connect();
  try{await recurringClient.query('BEGIN');await recurringClient.query(recurringMigration.sql);await recurringClient.query('INSERT INTO schema_version VALUES($1,$2)',[recurringMigration.version,recurringMigration.checksum]);await recurringClient.query('COMMIT');}finally{await recurringClient.query('ROLLBACK').catch(()=>{});recurringClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,50),history50,'0051 preserves every001–050 published checksum.');assert.deepEqual(await all50Rows(true),data50,'0051 preserves every50 table/row/field; only the two declared NULL quote bindings are projected out.');assert.deepEqual(await identityRecords(),identity50);assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p ORDER BY id')).rows,financial50,'0051 retains the complete13µ prompt and12120µ keyword financial identities unchanged.');assert.deepEqual(await paidFixtureRecords(true),paidBefore);assert.deepEqual((await pool.query('SELECT * FROM prompt_comparison_item ORDER BY id')).rows,[paidItem]);
  assert.deepEqual((await pool.query("SELECT t.tgname,p.proname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(p.oid) AS function FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='prompt_execution'::regclass AND NOT t.tgisinternal ORDER BY t.tgname")).rows,paidTrigger50,'0051 preserves the full paid insertion trigger and function.');
  const schema51=await schemaSnapshot(),recurringColumns=(row:{table_name:string;column_name:string})=>row.table_name==='prompt_execution_quote'&&['recurring_occurrence_id','recurring_models_hash'].includes(row.column_name),recurringConstraints=['prompt_execution_quote_recurring_models_hash_check','prompt_quote_recurring_scope'];
  const prior50Schema={columns:schema51.columns.filter(row=>!recurringTables.includes(row.table_name)&&!recurringColumns(row)),constraints:schema51.constraints.filter(row=>!recurringTables.includes(row.table_name)&&!recurringConstraints.includes(row.name)),indexes:schema51.indexes.filter(row=>!recurringTables.includes(row.tablename)&&row.indexname!=='prompt_quote_recurring_unique')};assert.deepEqual(prior50Schema,schema50,'0051 changes no other50 column, constraint or index.');
  assert.deepEqual(schema51.columns.filter(recurringColumns),[{table_name:'prompt_execution_quote',column_name:'recurring_occurrence_id',data_type:'uuid',is_nullable:'YES',column_default:null},{table_name:'prompt_execution_quote',column_name:'recurring_models_hash',data_type:'text',is_nullable:'YES',column_default:null}]);assert.deepEqual(schema51.constraints.filter(row=>recurringConstraints.includes(row.name)).map(row=>row.name).sort(),[...recurringConstraints].sort());assert.equal(schema51.indexes.filter(row=>row.indexname==='prompt_quote_recurring_unique').length,1);
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),[...tables50,...recurringTables].sort(),'Only two recurring tables are added.');for(const table of recurringTables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'0051 creates no tracker, standing approval or occurrence.');assert.equal(schema51.columns.find(row=>row.table_name==='prompt_tracker'&&row.column_name==='enabled')?.column_default,'false','New trackers are disabled unless explicitly approved.');assert.deepEqual((await pool.query('SELECT recurring_occurrence_id,recurring_models_hash FROM prompt_execution_quote ORDER BY id')).rows,[{recurring_occurrence_id:null,recurring_models_hash:null}],'No original quote becomes recurring.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'0051 starts no queue or paid work.');
  console.log('PASS native registered SQL50-to51 preserves complete populated50 rows/schema/checksums/financial identity and adds only empty default-disabled recurring storage with NULL old quote links; prior actual CLI evidence remains separate');
  const libraryTracker=randomUUID(),libraryInput={...(await pool.query('SELECT input FROM prompt_execution_quote WHERE id=$1',[paidQuote])).rows[0].input,systemText:'Preserved disabled tracker',reuseCached:false};
  await pool.query(`INSERT INTO prompt_tracker(id,workspace_id,project_id,created_request_id,name,input,definition_hash,calendar,maximum_micros) VALUES($1,$2,$3,$4,'Preserved disabled tracker',$5,$6,$7,50000)`,[libraryTracker,workspace,project,randomUUID(),libraryInput,canonicalHash(libraryInput),{interval:'daily',timezone:'UTC',hour:9,minute:0,weekday:null}]);
  const history51=await history(),tables51=[...tables50,...recurringTables].sort();
  async function all51Rows(stripArchive=false){const out:Record<string,unknown[]>={};for(const table of tables51)out[table]=(await pool.query(`SELECT to_jsonb(t)${stripArchive&&table==='prompt_tracker'?"-'archived_at'":''} AS row FROM ${pg.escapeIdentifier(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);return out;}
  const data51=await all51Rows();stage='native registered SQL upgrade populated0051 to0052';const libraryMigration=sources.find(source=>source.version==='0052')!,libraryClient=await pool.connect();
  try{await libraryClient.query('BEGIN');await libraryClient.query(libraryMigration.sql);await libraryClient.query('INSERT INTO schema_version VALUES($1,$2)',[libraryMigration.version,libraryMigration.checksum]);await libraryClient.query('COMMIT');}finally{await libraryClient.query('ROLLBACK').catch(()=>{});libraryClient.release();}await assert.rejects(assertSchema(),{code:'SCHEMA_MISMATCH'});
  assert.deepEqual((await history()).slice(0,51),history51);assert.deepEqual(await all51Rows(true),data51,'0052 preserves every original51 row/field, including a configured disabled tracker.');assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p ORDER BY id')).rows,financial50);assert.deepEqual(await identityRecords(),identity50);
  const schema52=await schemaSnapshot(),libraryColumn=(row:{table_name:string;column_name:string})=>row.table_name==='prompt_tracker'&&row.column_name==='archived_at',libraryConstraints=['prompt_tracker_archived_at_check','prompt_tracker_archived_disabled'];
  assert.deepEqual({columns:schema52.columns.filter(row=>!libraryColumn(row)),constraints:schema52.constraints.filter(row=>!libraryConstraints.includes(row.name)),indexes:schema52.indexes.filter(row=>row.indexname!=='prompt_tracker_library_idx')},schema51,'0052 changes only the declared archive column, checks and page index.');assert.deepEqual(schema52.columns.filter(libraryColumn),[{table_name:'prompt_tracker',column_name:'archived_at',data_type:'timestamp with time zone',is_nullable:'YES',column_default:null}]);assert.deepEqual(schema52.constraints.filter(row=>libraryConstraints.includes(row.name)).map(row=>row.name).sort(),[...libraryConstraints].sort());assert.equal(schema52.indexes.filter(row=>row.indexname==='prompt_tracker_library_idx').length,1);
  assert.deepEqual((await pool.query('SELECT archived_at,enabled,next_due_at,approval_id FROM prompt_tracker WHERE id=$1',[libraryTracker])).rows,[{archived_at:null,enabled:false,next_due_at:null,approval_id:null}]);assert.equal((await pool.query('SELECT 1 FROM prompt_occurrence')).rowCount,0);assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),tables51);assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42);
  await assert.rejects(pool.query('UPDATE prompt_tracker SET archived_at=clock_timestamp(),approval_id=$2,approval_user_id=$3,approval_connection_revision=1,approval_key_fingerprint=$4,approval_models_hash=$4,approved_at=clock_timestamp() WHERE id=$1',[libraryTracker,randomUUID(),owner,'a'.repeat(64)]),{code:'23514'});assert.deepEqual(await all51Rows(true),data51,'Rejected archive/grant combination changes no existing state.');
  console.log('PASS native registered SQL51-to52 preserves complete populated51 rows/checksums/identity/finance and disabled configuration, adding only nullable archive checks/page index with no work or activation; historical actual CLI evidence remains separate');
  const history52=await history(),data52=await all51Rows();stage='actual current CLI upgrade populated0052 to0053';assert.match(runMigrate(0),/Database migrations applied: 0053\./);await assertSchema();
  assert.deepEqual((await history()).slice(0,52),history52);assert.deepEqual(await all51Rows(),data52,'0053 preserves every52 table and row, including retained Google observations and the disabled tracker.');assert.deepEqual(await identityRecords(),identity50);assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p ORDER BY id')).rows,financial50);
  const schema53=await schemaSnapshot();assert.deepEqual(schema53.columns,schema52.columns);assert.deepEqual(schema53.indexes,schema52.indexes);assert.deepEqual(schema53.constraints.filter(row=>!reportCheck(row)),schema52.constraints.filter(row=>!reportCheck(row)));
  const check52=schema52.constraints.find(reportCheck),check53=schema53.constraints.find(reportCheck);assert.ok(check52&&check53);assert.deepEqual(check53,{...check52,definition:check52.definition.replace("'ga4_organic_weekly'::text","'ga4_organic_weekly'::text, 'ga4_ecommerce_items'::text, 'ga4_ecommerce_landing'::text, 'ga4_site_search'::text, 'ga4_audience_device'::text, 'ga4_audience_country'::text, 'ga4_audience_returning'::text")},'0053 broadens only the six declared range-report identifiers.');
  assert.deepEqual((await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_version' ORDER BY tablename")).rows.map(row=>row.tablename),tables51);assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42);
  console.log('PASS actual CLI52-to53 preserves complete populated52 rows/schema/checksums/identity/finance and broadens only six fixed GA4 profile IDs without new work');
  const upgradedHistory = sources.map(({ version, checksum }) => ({ version, checksum }));
  assert.deepEqual(await history(), upgradedHistory);
  const upgradedRecords = await records();
  for (const table of fixtureTables) {
    assert.equal(upgradedRecords[table].length, originalRecords[table].length, `${table} record count must survive upgrade.`);
    for (let index = 0; index < originalRecords[table].length; index++) {
      const expected = originalRecords[table][index];
      const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, upgradedRecords[table][index][key]]));
      assert.deepEqual(actual, expected, `${table} original fields must survive upgrade.`);
    }
  }
  for (const user of upgradedRecords.user) assert.equal(user.twoFactorEnabled, false, 'Existing accounts must not be enrolled in two-factor authentication automatically.');
  for (const session of upgradedRecords.session) assert.equal(session.oidcProviderId, null, 'Existing sessions must remain local sessions after upgrade.');
  for (const table of ['instance_operator', 'instance_operator_audit']) {
    assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0, 'Upgrade must not grant instance authority or record an implicit grant.');
  }
  const upgradedSchema = await schemaSnapshot();
  stage='actual current CLI schema0053 no-op';assert.match(runMigrate(0),/Database migrations already applied; all checksums verified\./);
  assert.deepEqual(await identityRecords(),identity40,'Repeat migration cannot backfill basis or change existing identity evidence.');
  assert.deepEqual(await history(), upgradedHistory);
  const noOp53Schema=await schemaSnapshot();assert.deepEqual(noOp53Schema, upgradedSchema);assert.deepEqual(await all51Rows(),data52,'Actual53 no-op preserves every populated52 row and retained Google observation.');
  assert.deepEqual(await records(), upgradedRecords);
  await assertSchema();
  assert.deepEqual(withoutPaidFixture(await featureRecords()),featureSnapshot);
  assert.deepEqual(await rankRecords(),rankAfter,'No-op migration preserves authored revision and every prior rank field.');
  assert.deepEqual((await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q')).rows[0].data,quoteAfter);
  assert.deepEqual(await metaRecords(),metaAfter,'No-op migration preserves exact Meta fingerprints and immutable receipts/pages.');
  assert.deepEqual(await inventoryRecords(),inventoryAfter,'No-op migration preserves independent cooldowns and every campaign field.');
  assert.deepEqual((await pool.query('SELECT to_jsonb(p) AS data FROM site_audit_page p ORDER BY id')).rows.map(r=>r.data),retained32,'No-op migration preserves exact retained body and prior evidence.');
  assert.deepEqual(await contextRecords(),contextAfter,'No-op migration preserves all authored context and citation defaults exactly.');
  assert.equal((await pool.query("SELECT 1 FROM meta_import WHERE status IN ('queued','submitting','waiting','reading')")).rowCount,1,'Only the prior captured import remains active; migration creates no work.');
  assert.equal((await pool.query("SELECT 1 FROM meta_campaign_inventory WHERE status IN ('queued','reading')")).rowCount,1,'Only the prior captured inventory remains active; migration creates no work.');
  assert.deepEqual((await pool.query('SELECT to_jsonb(s) AS data FROM analytics_segment s ORDER BY id')).rows.map(r=>r.data),retained33,'No-op migration preserves the exact authored schema33 filter.');
  assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS data FROM analytics_annotation a ORDER BY id')).rows.map(r=>r.data),retained34,'No-op migration preserves the exact authored schema34 note.');
  assert.deepEqual(withoutPaidFixture(await rows42()),data42,'No-op53 migration preserves every42 field and retained/purged quote payload exactly.');
  assert.deepEqual(withoutPaidFixture(await rows44()),data44,'Actual53 no-op preserves the complete post44 rows, including NULL login managers.');
  for(const table of new43Tables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)}`)).rowCount,0,'No-op53 migration creates no semantic work.');
  assert.equal((await pool.query('SELECT 1 FROM user_preference')).rowCount,0,'Actual53 no-op creates no preference rows.');assert.deepEqual(withoutPaidFixture(await rows44()),data44,'Actual53 no-op preserves every prior44 row and financial identity.');assert.deepEqual({columns:noOp53Schema.columns.filter(row=>!recurringTables.includes(row.table_name)&&!recurringColumns(row)),constraints:noOp53Schema.constraints.filter(row=>!recurringTables.includes(row.table_name)&&!recurringConstraints.includes(row.name)).map(row=>reportCheck(row)?check52:row),indexes:noOp53Schema.indexes.filter(row=>!recurringTables.includes(row.tablename)&&row.indexname!=='prompt_quote_recurring_unique')},schema50,'Actual53 no-op preserves every original50 schema field.');assert.equal((await pool.query("SELECT to_regnamespace('pgboss')::text AS schema")).rows[0].schema,bossSchema42,'Actual53 no-op starts no queue.');
  assert.deepEqual(withoutPaidFixture(await rows45()),data45,'Actual53 no-op preserves every45 row and field.');assert.deepEqual(await identityRecords(),identity45);
  assert.deepEqual(await paidFixtureRecords(true),paidBefore,'Actual53 no-op preserves every legacy paid source field and charge.');assert.deepEqual((await pool.query('SELECT * FROM prompt_comparison_item ORDER BY id')).rows,[paidItem],'Actual53 no-op neither duplicates nor rewrites the backfilled link.');assert.deepEqual((await pool.query("SELECT to_jsonb(p) AS data FROM provider_request p WHERE operation='keyword.overview'")).rows,keywordLedgerBefore);
  assert.deepEqual(await all50Rows(true),data50,'Actual53 no-op preserves every populated50 row in every original table.');for(const table of recurringTables)assert.equal((await pool.query(`SELECT 1 FROM ${pg.escapeIdentifier(table)} ${table==='prompt_tracker'?'WHERE id<>$1':''}`,table==='prompt_tracker'?[libraryTracker]:[])).rowCount,0,'Actual53 no-op creates no implicit recurring work or approval beyond the declared disabled fixture.');assert.deepEqual(await all51Rows(true),data51,'Actual53 no-op preserves every original51 row including configured disabled tracking.');
  assert.deepEqual((await pool.query("SELECT t.tgname,p.proname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(p.oid) AS function FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='prompt_execution'::regclass AND NOT t.tgisinternal ORDER BY t.tgname")).rows,paidTrigger50,'Actual53 no-op preserves the paid insertion invariant.');
  assert.deepEqual(migrationCliExits,[1,1,1,1,0,0],'Four rejected CLI migrations, one actual52-to53 upgrade and one53 no-op are the entire bounded CLI workload.');
  console.log('PASS actual CLI53 no-op preserves all53 checksums/schema, complete populated52 rows/finance and unchanged disabled recurring fixture');
  console.log('PASS prior0022 feature evidence,0023 rank and0026–28 Meta receipts/pages survive0035; profile and active evidenced cooldown backfills preserve all prior fields and are idempotent; no implicit paid work');
  console.log('PASS actual0029 authored context survives0035 unchanged with empty citation defaults, empty suggestion tables, preserved checksums and idempotent repeat migration');
  console.log('PASS original owner, credentials, sessions, workspace, project and event preserved; no operator grants; repeat migration is idempotent');
  console.log('PASS populated0037 events, assignments, properties, receipts and exact project markers survive0038 unchanged; new proof fields remain NULL and repeat migration is inert');
  console.log('PASS populated0038 proof/settings/epochs survive0039/0040 unchanged; historical basis stays NULL and existing geography setting stays absent, future defaults are cookieless with geography capture, and invalid basis/proof combinations fail');
  console.log('Migration integration checks passed. Synthetic fixtures remain in the isolated database.');
} catch {
  console.error(`Migration integration checks failed during: ${stage}.`);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => { console.error('Migration test database shutdown failed.'); process.exitCode = 1; });
  if (brokenCheckout) {
    const temporaryRoot = resolve(tmpdir()) + sep;
    assert.ok(resolve(brokenCheckout).startsWith(temporaryRoot) && basename(brokenCheckout).startsWith('ten98-migrations-'), 'Temporary migration fixture must stay inside its named temporary directory.');
    await rm(brokenCheckout, { recursive: true, force: true });
  }
}
