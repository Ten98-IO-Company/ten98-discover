import assert from 'node:assert/strict';
import test from 'node:test';
import {contentSupportIdentity,boundedSupport,getContentSupport} from '../src/server/ai-content-support.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import {contentSupportDisposition} from '../src/server/ai-content-support-worker.ts';
import {nativeOpenApi} from '../src/server/openapi.ts';
import {createHash,randomUUID} from 'node:crypto';
import {readSupportPayload} from '../src/server/ai-content-support.ts';
import {prepareContentSupportQuote} from '../src/server/ai-content-support-quote.ts';
import {contentSupportQueryId} from '../src/server/ai-content-support-input.ts';
import {executionActor} from '../src/server/openrouter.ts';
import {openRouterTextProfile} from '../src/lib/openrouter-models.ts';
import {usd,usdMicros} from '../src/server/providers.ts';

test('semantic ledger identity binds native source clocks, actor/key, route, policy, request and explicit cap separately from payload',()=>{
 const q={id:'quote',workspace_id:'workspace',project_id:'project',user_id:'actor',request_id:'request',connection_id:'connection',connection_revision:1,request_actor:'a'.repeat(64),key_fingerprint:'b'.repeat(64),payload_hash:'c'.repeat(64),schema_hash:'d'.repeat(64),query_receipt_hash:'e'.repeat(64),corpus_receipt_hash:'f'.repeat(64),source_input:{source:{kind:'capture'},selectedQueryIds:['query'],selectedPageIds:['page']},dependencies:[{quoteCreatedAt:'2026-10-15T00:00:00.000001Z'}],source_context_revision:1,source_profile_hash:'profile',retention_revision:1,raw_days_at_quote:90,derived_days_at_quote:365,raw_anchor:'2026-10-15T00:00:00.000001Z',derived_anchor:'2026-10-15T00:00:00.000001Z',route:{model:'author/model',tag:'leaf',providerName:'Provider',promptPrice:'0.000001'},estimate_micros:'13',max_spend_micros:'1000000',quote_created:'2026-10-15T00:00:01.000001Z',quote_expires:'2026-10-15T00:05:01.000001Z'};
 const hash=contentSupportIdentity(q);assert.notEqual(hash,q.payload_hash);assert.equal(contentSupportIdentity(structuredClone(q)),hash);
 for(const field of Object.keys(q)){const copy=structuredClone(q) as Record<string,unknown>;copy[field]=typeof copy[field]==='number'?Number(copy[field])+1:typeof copy[field]==='object'?{changed:copy[field]}:String(copy[field])+'changed';assert.notEqual(contentSupportIdentity(copy),hash,field);}
 const oneMicrosecond={...q,raw_anchor:'2026-10-15T00:00:00.000000Z'};assert.notEqual(contentSupportIdentity(oneMicrosecond),hash);
 const ref={pages:[{id:'page',url:'https://example.test/page',observedAt:'2026-10-15T00:00:00.000001Z'}]};assert.notEqual(contentSupportIdentity({...q,snapshot:{selection:ref}}),contentSupportIdentity({...q,snapshot:{selection:{pages:[{...ref.pages[0],url:'https://different.test/page'}]}}}),'Copied display references are bound as well as model text.');
 assert.equal(contentSupportIdentity({...q,lastReadAt:'ignored',leaseOwner:'ignored'}),hash,'Only immutable quote identity belongs in the ledger hash.');
});
test('unknown charges stay uncertain; invalid output and lost authority cannot become a completed assessment',()=>{
 for(const current of [false,true])for(const valid of [false,true])assert.equal(contentSupportDisposition(null,valid,current),'uncertain');
 for(const amount of ['0.000000','0.000013']){assert.equal(contentSupportDisposition(amount,true,true),'completed');assert.equal(contentSupportDisposition(amount,false,true),'failed');assert.equal(contentSupportDisposition(amount,true,false),'failed');assert.equal(contentSupportDisposition(amount,false,false),'failed');}
});
test('complete 2 MiB responses refuse the whole value and the browser inventory grants no bearer scope',()=>{
 const value={value:'a'.repeat(2_097_140)};assert.equal(Buffer.byteLength(JSON.stringify(value)),2_097_152);assert.equal(boundedSupport(value),value);assert.throws(()=>boundedSupport({value:value.value+'a'}),{status:413});
 assert.equal(Object.keys(nativeOpenApi.paths).some(path=>path.includes('ai-content-support')),false);const inventory=nativeOpenApi['x-ten98-browser-operations'];assert.match(inventory.authority,/bare Bearer403/);assert.equal(inventory['/api/projects/{projectId}/ai-content-support/quote'].post.bodyMaxBytes,32768);assert.equal(inventory['/api/projects/{projectId}/ai-content-support/runs/{runId}/export'].post.responseMaxBytes,2_097_152);
});
test('stored raw and derived anchors must equal the earliest native query/audit dependency even if a tampered quote recomputes its own hash',()=>{
 const keys=['APP_URL','DATABASE_URL','AUTH_SECRET','BOOTSTRAP_TOKEN'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{APP_URL:'http://127.0.0.1:3111',DATABASE_URL:'postgres://unused@127.0.0.1:55501/offline',AUTH_SECRET:'a'.repeat(64),BOOTSTRAP_TOKEN:'b'.repeat(64)});
 try{
  const id=randomUUID(),user=randomUUID(),project=randomUUID(),workspace=randomUUID(),capture=randomUUID(),sourceQuote=randomUUID(),audit=randomUUID(),page=randomUUID(),connection=randomUUID(),request=randomUUID(),hash='a'.repeat(64),body='Solar energy',bodyHash=createHash('sha256').update(body).digest('hex'),query={id:contentSupportQueryId('solar'),key:'solar'},older='2026-10-13T00:00:00.000001Z',newer='2026-10-14T00:00:00.000001Z';
  const source={kind:'capture' as const,selection:{captureId:capture,auditRunId:audit,pages:{coverage:null,resourceKind:'html' as const,search:'',searchIn:'url' as const,sort:'url' as const,order:'asc' as const,expectedSelectionRevision:hash}}},input={requestId:request,connectionId:connection,model:'author/model',fundedCredits:true,evaluation:true,maxSpendUsd:'0.030000',source,expectedQueryReceiptHash:hash,expectedCorpusReceiptHash:hash,selectedQueryIds:[query.id],selectedPageIds:[page]};
  const route={model:'author/model',tag:'provider/leaf',providerName:'Provider',profile:openRouterTextProfile,contextLength:16384,promptCapacity:8192,completionCapacity:4096,promptPrice:'0.000000001',completionPrice:'0.000000001',requestPrice:'0',estimateMicros:'11'},prepared=prepareContentSupportQuote({derivationVersion:'immutable-prompt-trim-lower-v1',source:{kind:'capture',queryReceiptHash:hash,corpusReceiptHash:hash},queries:[query],pages:[{id:page,bodySha256:bodyHash,body}],exclusions:{queries:0,pages:0}},route,input.maxSpendUsd);
  const q={id,workspace_id:workspace,project_id:project,user_id:user,request_id:request,connection_id:connection,connection_revision:1,request_actor:executionActor(user),key_fingerprint:hash,payload_hash:prepared.payloadHash,schema_hash:prepared.schemaHash,source_kind:'capture',audit_run_id:audit,query_receipt_hash:hash,corpus_receipt_hash:hash,source_input:input,snapshot:{evidence:prepared.snapshot,selection:{queries:[query],pages:[{id:page,auditRunId:audit,url:'https://example.test/',bodySha256:bodyHash,bodyLength:body.length,observedAt:newer,extractionVersion:'static-dom-body-v1'}],exclusions:{queries:0,pages:0}}},messages:prepared.messages,dependencies:[{kind:'query',captureId:capture,quoteId:sourceQuote,quoteCreatedAt:older,inputHash:hash,inputFingerprint:hash,resultHash:hash},{kind:'body',pageId:page,auditRunId:audit,auditCompletedAt:newer,observedAt:newer,bodySha256:bodyHash}],source_context_revision:null,source_profile_hash:null,retention_revision:1,raw_days_at_quote:90,derived_days_at_quote:1,raw_anchor:older,derived_anchor:older,route,estimate_micros:'11',max_spend_micros:'30000',quote_created:'2026-10-15T00:00:00.000001Z',quote_expires:'2026-10-15T00:05:00.000001Z',input_hash:''};q.input_hash=contentSupportIdentity(q);assert.equal(readSupportPayload(q).snapshot.pages[0].body,body);
  for(const field of ['raw_anchor','derived_anchor']as const){const changed={...q,[field]:newer};changed.input_hash=contentSupportIdentity(changed);assert.throws(()=>readSupportPayload(changed),{status:409});}
  // Owner decision D3: a quote written since D3 records the quoted estimate where the chosen ceiling used to be; it verifies like the historical row above.
  const recorded=usd(BigInt(route.estimateMicros)),e=prepared.snapshot,current=prepareContentSupportQuote({derivationVersion:e.derivationVersion,source:e.source,queries:e.queries,pages:e.pages,exclusions:e.exclusions},route,recorded),fresh={...q,source_input:{...input,maxSpendUsd:recorded},payload_hash:current.payloadHash,messages:current.messages,max_spend_micros:usdMicros(recorded).toString()};fresh.input_hash=contentSupportIdentity(fresh);
  assert.equal(fresh.max_spend_micros,fresh.estimate_micros);assert.equal(current.schemaHash,prepared.schemaHash);assert.notEqual(fresh.input_hash,q.input_hash);assert.equal(readSupportPayload(fresh).snapshot.pages[0].body,body);
  for(const drift of [{max_spend_micros:'30000'},{source_input:input}]){const changed={...fresh,...drift};changed.input_hash=contentSupportIdentity(changed);assert.throws(()=>readSupportPayload(changed),{status:409});}
 }finally{for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});
test('the content assessment list reads a 20-row page in a constant number of statements without row locks',async()=>{
 const keys=['APP_URL','DATABASE_URL','AUTH_SECRET','BOOTSTRAP_TOKEN'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{APP_URL:'http://127.0.0.1:3111',DATABASE_URL:'postgres://unused@127.0.0.1:55501/offline',AUTH_SECRET:'a'.repeat(64),BOOTSTRAP_TOKEN:'b'.repeat(64)});
 const project=randomUUID(),workspace=randomUUID(),user=randomUUID(),hash='a'.repeat(64),stamp=(s:number)=>`2026-10-15T00:00:${String(s).padStart(2,'0')}.000001Z`;
 const route={model:'author/model',tag:'provider/leaf',providerName:'Provider',profile:openRouterTextProfile,contextLength:16384,promptCapacity:8192,completionCapacity:4096,promptPrice:'0.000000001',completionPrice:'0.000000001',requestPrice:'0',estimateMicros:'11'};
 const fixture=(count:number)=>Array.from({length:count},(_,i)=>({id:randomUUID(),quote_id:randomUUID(),request_id:randomUUID(),status:'cancelled',charge_status:'cancelled',estimate_micros:'11',actual_micros:null,generation_id:null,diagnostic:null,proposal:null,result_purged_at:null,created_at:new Date(Date.UTC(2026,9,15,0,0,59-i)),run_created:stamp(59-i),run_dispatched:null,run_completed:stamp(59-i)}));
 const pool=getDatabase().pool,connect=pool.connect;let statements:string[]=[],rows:ReturnType<typeof fixture>=[],latched:unknown;
 const client={release(){},query:async(sql:string,values:unknown[]=[])=>{statements.push(sql);
  if(sql.startsWith('SELECT workspace_id FROM project'))return{rows:[{workspace_id:workspace}]};
  if(sql.includes('FROM project WHERE id=$1 AND workspace_id=$2'))return{rows:[{id:project,workspaceId:workspace,origin:'https://example.test'}]};
  if(sql.includes('SELECT role FROM membership'))return{rows:[{role:'owner'}]};
  if(sql.includes('FROM ai_content_support_run r JOIN provider_request'))return{rows};
  if(sql.startsWith('UPDATE ai_content_support_quote q')){latched=values[3];return{rows:[]};}
  if(sql.includes('FROM ai_content_support_quote q WHERE'))return{rows:rows.filter(r=>(values[1] as string[]).includes(r.quote_id)).map(r=>({id:r.quote_id,request_id:r.request_id,input_hash:hash,payload_hash:hash,schema_hash:hash,query_receipt_hash:hash,corpus_receipt_hash:hash,route,raw_expired_at:new Date(),input_purged_at:null,snapshot:null,source_input:null}))};
  return{rows:[]};}};
 pool.connect=(async()=>client) as unknown as typeof pool.connect;
 try{
  const read=async(count:number)=>{rows=fixture(count);statements=[];latched=undefined;const list=await getContentSupport(project,user);return {list,statements:[...statements],latched};};
  const one=await read(1),page=await read(21);
  assert.equal(page.list.runs.length,20);assert.deepEqual(page.list.runs.map(r=>r.id),rows.slice(0,20).map(r=>r.id),'Page order follows the native (created_at,id) order.');
  assert.ok(page.list.nextCursor);assert.equal(one.list.nextCursor,null);assert.deepEqual(page.latched,rows.slice(0,20).map(r=>r.quote_id),'Only the visible page is latched.');
  assert.ok(page.list.runs.every(r=>r.inputExpired&&r.resultExpired&&r.selection===null),'A latched expiry stays unavailable, never an empty selection.');
  assert.equal(page.statements.length,one.statements.length,'Statement count is independent of page size.');assert.ok(page.statements.length<=11,`${page.statements.length} statements for a 20-row page`);
  const body=page.statements.slice(page.statements.findIndex(s=>s.includes('SELECT role FROM membership'))+1);assert.equal(body.some(s=>s.includes('FOR UPDATE')),false,'A list read takes no row locks beyond workspace admission.');
  rows=fixture(0);statements=[];const empty=await getContentSupport(project,user);assert.deepEqual(empty.runs,[]);assert.equal(statements.some(s=>s.startsWith('UPDATE ai_content_support_quote')),false);
 }finally{pool.connect=connect;await closeDatabase();for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});
