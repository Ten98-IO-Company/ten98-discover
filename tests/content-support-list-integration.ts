import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {PoolClient} from 'pg';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {insertPromptInTransaction} from '../src/server/prompts.ts';
import {executionActor} from '../src/server/openrouter.ts';
import {openRouterTextProfile} from '../src/lib/openrouter-models.ts';
import {aiSearchProfileId,aiSearchPriceEvidence} from '../src/lib/ai-search.ts';
import {contentSupportQueryId} from '../src/server/ai-content-support-input.ts';
import {prepareContentSupportQuote} from '../src/server/ai-content-support-quote.ts';
import {contentSupportIdentity,getContentSupport,getContentSupportRun} from '../src/server/ai-content-support.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation. Fixtures are retained.
// The content assessment list verifies its page's sources in the same transaction as detail would,
// without row locks, in a statement count bounded by distinct live sources rather than rows.
export async function runContentSupportListChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();
  for(const url of [config.appUrl,config.databaseUrl])assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const {pool}=getDatabase(),owner=randomUUID(),auditor=randomUUID(),workspace=randomUUID(),project=randomUUID(),origin=`https://${randomUUID().slice(0,8)}.content-list.integration.test`;
  const openrouter=randomUUID(),dataforseo=randomUUID(),capture=randomUUID(),searchQuote=randomUUID(),audit=randomUUID(),page=randomUUID(),hash='a'.repeat(64);
  // Native to_char(...,'US') clocks: six fractional digits.
  const clock=(ms:number)=>new Date(ms).toISOString().replace(/\.(\d{3})Z$/,'.$1000Z'),now=Date.now(),capturedAt=clock(now-2*86400000),auditAt=clock(now-86400000);
  const tx=async<T>(work:(c:PoolClient)=>Promise<T>)=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await work(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
  const route={model:'author/model',tag:'provider/leaf',providerName:'Provider',profile:openRouterTextProfile,contextLength:16384,promptCapacity:8192,completionCapacity:4096,promptPrice:'0.000000001',completionPrice:'0.000000001',requestPrice:'0',estimateMicros:'11'};
  const runs:string[]=await tx(async c=>{
    await c.query('INSERT INTO "user"(id,name,email)VALUES($1,$2,$3),($4,$5,$6)',[owner,'List owner',owner+'@content-list.test',auditor,'Former audit manager',auditor+'@content-list.test']);
    await c.query("INSERT INTO workspace(id,name)VALUES($1,'Content list fixture')",[workspace]);
    // The audit's author was demoted after the quote, so its audit authority no longer holds.
    await c.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner'),($1,$3,'viewer')",[workspace,owner,auditor]);
    await c.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Content list fixture',$3,$4,'infinity')",[project,workspace,origin,randomUUID()]);
    await c.query("INSERT INTO provider_connection(id,workspace_id,provider,name)VALUES($1,$2,'openrouter','Synthetic OpenRouter'),($3,$2,'dataforseo','Synthetic DataForSEO')",[openrouter,workspace,dataforseo]);
    const prompt=await insertPromptInTransaction(c,project,owner,{text:'Content list prompt',enabled:false}),price=aiSearchPriceEvidence(),request=randomUUID();
    await c.query(`INSERT INTO ai_search_quote(id,workspace_id,project_id,user_id,request_id,prompt_id,version_id,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,input_hash,profile_id,price_version,price_mode,price_source,price_checked_on,estimate_micros,input,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,2,$9,$10,$11,$12,$13,$14,4000,'{}',$15,$15::timestamptz+interval '5 minutes')`,[searchQuote,workspace,project,owner,request,prompt.id,prompt.versionId,dataforseo,hash,aiSearchProfileId,price.version,price.mode,price.sourceUrl,price.checkedOn,capturedAt]);
    await c.query("INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month)VALUES($1,$2,$3,1,$4,$5,'ai.search.capture',$6,4000,0,'settled',current_date)",[capture,workspace,dataforseo,owner,request,hash]);
    await c.query("INSERT INTO ai_search_run(id,quote_id,workspace_id,project_id,user_id,request_id,status,payload_hash,result,created_at,completed_at,settled_at)VALUES($1,$2,$3,$4,$5,$6,'completed',$7,'{}',$8,$8,$8)",[capture,searchQuote,workspace,project,owner,request,hash,capturedAt]);
    await c.query(`INSERT INTO site_audit_run(id,workspace_id,project_id,user_id,request_id,request_hash,origin,config,status,created_at,completed_at,deadline_at,queue_job_id)VALUES($1,$2,$3,$4,$5,$6,$7,'{"mode":"static","retainBodyText":true}','completed',$8,$8,$8::timestamptz+interval '30 minutes',$9)`,[audit,workspace,project,auditor,randomUUID(),hash,origin,auditAt,randomUUID()]);
    const ids:string[]=[],body='Solar energy',bodyHash=createHash('sha256').update(body).digest('hex'),query={id:contentSupportQueryId('solar'),key:'solar'};
    const prepared=prepareContentSupportQuote({derivationVersion:'immutable-prompt-trim-lower-v1',source:{kind:'capture',queryReceiptHash:hash,corpusReceiptHash:hash},queries:[query],pages:[{id:page,bodySha256:bodyHash,body}],exclusions:{queries:0,pages:0}},route,'0.030000');
    // 21 live runs on one source, newest first; the oldest stays off page one for the detail comparison.
    for(let i=0;i<21;i++){
      const id=randomUUID(),quote=randomUUID(),requestId=randomUUID(),created=clock(now-60000*(i+1));
      const input={requestId,connectionId:openrouter,model:route.model,fundedCredits:true,evaluation:true,maxSpendUsd:'0.030000',source:{kind:'capture' as const,selection:{captureId:capture,auditRunId:audit,pages:{coverage:null,resourceKind:'html' as const,search:'',searchIn:'url' as const,sort:'url' as const,order:'asc' as const,expectedSelectionRevision:hash}}},expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash,selectedQueryIds:[query.id],selectedPageIds:[page]};
      const q={id:quote,workspace_id:workspace,project_id:project,user_id:owner,request_id:requestId,connection_id:openrouter,connection_revision:1,request_actor:executionActor(owner),key_fingerprint:hash,payload_hash:prepared.payloadHash,schema_hash:prepared.schemaHash,source_kind:'capture',audit_run_id:audit,query_receipt_hash:hash,corpus_receipt_hash:hash,source_input:input,snapshot:{evidence:prepared.snapshot,selection:{queries:[query],pages:[{id:page,auditRunId:audit,url:origin+'/',bodySha256:bodyHash,bodyLength:body.length,observedAt:auditAt,extractionVersion:'static-dom-body-v1'}],exclusions:{queries:0,pages:0}}},messages:prepared.messages,dependencies:[{kind:'query',captureId:capture,quoteId:searchQuote,quoteCreatedAt:capturedAt,inputHash:hash,inputFingerprint:hash,resultHash:hash},{kind:'body',pageId:page,auditRunId:audit,auditCompletedAt:auditAt,observedAt:auditAt,bodySha256:bodyHash}],source_context_revision:null,source_profile_hash:null,retention_revision:1,raw_days_at_quote:90,derived_days_at_quote:365,raw_anchor:capturedAt,derived_anchor:capturedAt,route,estimate_micros:'11',max_spend_micros:'30000',quote_created:created,quote_expires:clock(now-60000*(i+1)+300000)};
      await c.query(`INSERT INTO ai_content_support_quote(id,workspace_id,project_id,user_id,request_id,connection_id,connection_revision,request_actor,key_fingerprint,purpose,prompt_version,schema_version,method,derivation_version,source_kind,audit_run_id,input_hash,payload_hash,schema_hash,query_receipt_hash,corpus_receipt_hash,retention_revision,raw_days_at_quote,derived_days_at_quote,raw_anchor_at,derived_anchor_at,dependencies,source_input,snapshot,messages,route,estimate_micros,max_spend_micros,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'website-content-support','closed-corpus-support-v1',1,'closed-corpus-model-judgment-v1','immutable-prompt-trim-lower-v1','capture',$9,$10,$11,$12,$8,$8,1,90,365,$13,$13,$14,$15,$16,$17,$18,11,30000,$19,$19::timestamptz+interval '5 minutes')`,
        [quote,workspace,project,owner,requestId,openrouter,q.request_actor,hash,audit,contentSupportIdentity(q),prepared.payloadHash,prepared.schemaHash,capturedAt,JSON.stringify(q.dependencies),JSON.stringify(input),JSON.stringify(q.snapshot),JSON.stringify(prepared.messages),JSON.stringify(route),created]);
      await c.query("INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)VALUES($1,$2,$3,1,$4,$5,'ai.content.support',$6,11,'cancelled',current_date)",[id,workspace,openrouter,owner,requestId,hash]);
      await c.query("INSERT INTO ai_content_support_run(id,quote_id,workspace_id,project_id,user_id,request_id,status,completed_at,created_at)VALUES($1,$2,$3,$4,$5,$6,'cancelled',$7,$7)",[id,quote,workspace,project,owner,requestId,created]);
      ids.push(id);
    }
    return ids;
  });
  const state=async(run:string)=>(await pool.query<{reason:string|null}>('SELECT q.unavailable_reason AS reason FROM ai_content_support_quote q JOIN ai_content_support_run r ON r.quote_id=q.id WHERE r.id=$1',[run])).rows[0].reason;
  assert.equal(await state(runs[0]),null,'Fixture quotes start available, so only source verification can change them.');
  // Detail on the oldest run marks its source change through the single-row path.
  const detail=await getContentSupportRun(project,owner,runs[20]);assert.equal(detail.run.inputExpired,true);assert.equal(await state(runs[20]),'source_changed');
  // Count the statements of one list request on its own pooled client.
  const counted=async<T>(work:()=>Promise<T>)=>{
    const connect=pool.connect,statements:string[]=[];
    pool.connect=(async()=>{const c=await (connect as ()=>Promise<PoolClient>).call(pool),query=c.query.bind(c),release=c.release.bind(c);
      c.query=((sql:unknown,...rest:unknown[])=>{statements.push(typeof sql==='string'?sql:String((sql as {text?:string}).text));return (query as (...a:unknown[])=>unknown)(sql,...rest);}) as typeof c.query;
      c.release=((error?:Error|boolean)=>{c.query=query;c.release=release;return release(error);}) as typeof c.release;return c;}) as typeof pool.connect;
    try{return {value:await work(),statements};}finally{pool.connect=connect;}
  };
  const {value:list,statements}=await counted(()=>getContentSupport(project,owner));
  assert.deepEqual(list.runs.map(r=>r.id),runs.slice(0,20));assert.ok(list.nextCursor);
  const visible=(r:typeof detail.run)=>({status:r.status,chargeStatus:r.chargeStatus,inputExpired:r.inputExpired,resultExpired:r.resultExpired,selection:r.selection,proposal:r.proposal,resultHash:r.resultHash,canCancel:r.canCancel,canReconcile:r.canReconcile});
  assert.deepEqual(visible(list.runs[0]),visible(detail.run),'The list shows the same stale-source state as detail.');
  for(const run of runs.slice(0,20))assert.equal(await state(run),'source_changed');
  const listBody=statements.slice(statements.findIndex(s=>s.includes('FROM ai_content_support_run r JOIN provider_request')));
  assert.equal(listBody.some(s=>/FOR UPDATE/.test(s)),false,'The list takes no row locks beyond workspace admission.');
  assert.ok(statements.length<=18,`${statements.length} statements for a 20-row page on one live source`);
  // Already-unavailable rows cost no source verification.
  const repeat=await counted(()=>getContentSupport(project,owner));
  assert.equal(repeat.statements.length,11);assert.equal(repeat.statements.some(s=>s.startsWith('SELECT * FROM site_audit_run')),false);
  return {groups:['the content assessment list verifies live sources without row locks and matches detail stale-source state']};
}
if(process.env.TEN98_INTEGRATION_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{console.log(await runContentSupportListChecks());}finally{await closeDatabase();}
