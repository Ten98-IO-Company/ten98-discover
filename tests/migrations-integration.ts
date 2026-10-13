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
const { pool } = getDatabase();
const checkout = process.cwd();
const cli = join(checkout, 'src/server/cli.ts');
let stage = 'empty-database safety check';
let brokenCheckout: string | undefined;

function runMigrate(expected: number, cwd = checkout) {
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
  assert.deepEqual(sources.map(({ version }) => version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024', '0025', '0026']);
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
  async function featureRecords() {const snapshot:Record<string,unknown>={};for(const table of preservedTables)snapshot[table]=(await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t`)).rows;return snapshot;}
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
  stage = 'upgrade original,0022 features and0023 rank data through0024';
  runMigrate(0);
  await assertSchema();
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
  for(const table of ['meta_app_registration','meta_connection','meta_oauth_flow','meta_deletion_request'])assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount,0,'Upgrade adds Meta storage without inventing registrations, grants or callbacks.');
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
  runMigrate(0);
  assert.deepEqual(await history(), upgradedHistory);
  assert.deepEqual(await schemaSnapshot(), upgradedSchema);
  assert.deepEqual(await records(), upgradedRecords);
  await assertSchema();
  assert.deepEqual(await featureRecords(),featureSnapshot);
  assert.deepEqual(await rankRecords(),rankAfter,'No-op migration preserves authored revision and every prior rank field.');
  assert.deepEqual((await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q')).rows[0].data,quoteAfter);
  assert.equal((await pool.query('SELECT 1 FROM meta_import UNION ALL SELECT 1 FROM meta_import_page')).rowCount,0,'Upgrade must not schedule or synthesize Meta imports.');
  console.log('PASS prior0022 feature evidence and0023 rank identity, approval, pin and quote survive0026; authored revision initializes once; identity capsule preserved; no implicit paid work or Meta grants/imports');
  console.log('PASS original owner, credentials, sessions, workspace, project and event preserved; no operator grants; repeat migration is idempotent');
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
