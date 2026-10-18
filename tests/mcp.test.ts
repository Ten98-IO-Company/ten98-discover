import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createMcpHandler,PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {mcpTools,availableTools,mcpResult,mcpResponseBytes,mcpToolError,createNativeMcpServer} from '../src/server/mcp-tools.ts';
import {handleMcp,mcpOriginAllowed} from '../src/server/mcp.ts';
import {apiKeyScopes,type ApiKeyPrincipal} from '../src/server/api-keys.ts';
import {contextOp} from '../src/server/context-input.ts';
import {savedKeywordFilterKeys} from '../src/server/saved-keyword-input.ts';

const principal:ApiKeyPrincipal={id:randomUUID(),userId:randomUUID(),workspaceId:randomUUID(),role:'owner',scopes:[...apiKeyScopes]};
test('fixed native catalog, strict bounded schemas and scope separation',()=>{
  assert.equal(mcpTools.length,38);assert.equal(new Set(mcpTools.map(t=>t.name)).size,38);
  const original=['ten98_whoami','ten98_read_analytics','ten98_read_realtime','ten98_list_sessions','ten98_read_session','ten98_read_linked_activity','ten98_list_prompts','ten98_read_prompt','ten98_list_prompt_versions','ten98_create_prompts','ten98_update_prompt','ten98_archive_prompt','ten98_restore_prompt'];
  assert.deepEqual(mcpTools.filter(tool=>original.includes(tool.name)).map(tool=>tool.name),original);
  assert.equal(availableTools({...principal,scopes:['analytics:read']}).length,9);
  assert.equal(availableTools({...principal,scopes:['prompts:read']}).length,4);
  assert.equal(availableTools({...principal,scopes:['prompts:write']}).length,5);
  assert.equal(availableTools({...principal,scopes:['context:read']}).length,3);
  assert.equal(availableTools({...principal,scopes:['context:write']}).length,2);
  assert.equal(availableTools({...principal,scopes:['segments:read']}).length,3);
  assert.equal(availableTools({...principal,scopes:['annotations:read']}).length,2);
  assert.equal(availableTools({...principal,scopes:['rank:read']}).length,8);
  assert.equal(availableTools({...principal,scopes:['keywords:read']}).length,3);
  assert.deepEqual(availableTools({...principal,scopes:['google:read']}).map(t=>t.name),['ten98_whoami','ten98_list_google_sources','ten98_read_google_snapshot']);
  assert.deepEqual(availableTools({...principal,scopes:['domains:read']}).map(t=>t.name),['ten98_whoami','ten98_list_domains','ten98_list_domain_redirect_checks']);
  assert.deepEqual(availableTools({...principal,scopes:['audits:read']}).map(t=>t.name),['ten98_whoami','ten98_list_site_audits','ten98_read_site_audit','ten98_list_site_audit_issues']);
  // The content slices' thirteen scopes still reach exactly their thirty-one tools (twenty-eight plus the three rank-history readers), and 0066's fifteen reach thirty-five.
  assert.equal(availableTools({...principal,scopes:apiKeyScopes.filter(scope=>scope!=='google:read'&&scope!=='domains:read'&&scope!=='audits:read')}).length,31);
  assert.equal(availableTools({...principal,scopes:apiKeyScopes.filter(scope=>scope!=='audits:read')}).length,35);
  // No retrogrant at discovery: the seven pre-increment scopes still reach exactly the sixteen pre-increment tools, and the context slice's nine reach nineteen.
  assert.equal(availableTools({...principal,scopes:['projects:read','projects:write','analytics:read','events:write','team:read','prompts:read','prompts:write']}).length,16);
  assert.equal(availableTools({...principal,scopes:['projects:read','projects:write','analytics:read','events:write','team:read','prompts:read','prompts:write','context:read','context:write']}).length,19);
  for(const tool of mcpTools)if(tool.scope!==null)assert.equal(availableTools({...principal,scopes:[tool.scope]}).every(item=>item.scope===null||item.scope===tool.scope),true,tool.name);
  assert.deepEqual(availableTools({...principal,scopes:[]}).map(t=>t.name),['ten98_whoami']);
  for(const tool of mcpTools)assert.equal(tool.schema.safeParse({execute:true,token:'not accepted'}).success,false);
  const bulk=mcpTools.find(t=>t.name==='ten98_create_prompts')!.schema;
  const input={projectId:randomUUID(),requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'Prompt '+i}))};
  assert.equal(bulk.safeParse(input).success,true);assert.equal(bulk.safeParse({...input,prompts:[...input.prompts,{text:'101'}]}).success,false);
  assert.equal(mcpTools.find(t=>t.name==='ten98_read_realtime')!.schema.safeParse({projectId:input.projectId,query:{}}).success,false);
  const update=mcpTools.find(t=>t.name==='ten98_update_context')!.schema as any,kinds=contextOp.options.map(option=>option.shape.kind.value);
  assert.deepEqual(update.shape.updates.element.shape.kind.options,kinds);assert.equal(kinds.length,11);
  const context={projectId:input.projectId,requestId:randomUUID(),revision:1,updates:Array.from({length:50},(_,i)=>({kind:kinds[i%kinds.length],anyField:i}))};
  assert.equal(update.safeParse(context).success,true);
  for(const bad of [{...context,updates:[]},{...context,updates:[...context.updates,{kind:'research',summary:'51'}]},{...context,updates:[{kind:'delete-everything'}]},{...context,updates:[{summary:'no kind'}]},{...context,execute:true},{...context,revision:0},{...context,revision:2147483647}])assert.equal(update.safeParse(bad).success,false);
  // The saved-keyword filter keys derive from the native parser; the matrix requires its device and keeps runLimit a native wire string.
  const savedKeywords=mcpTools.find(t=>t.name==='ten98_list_saved_keywords')!.schema as any,matrix=mcpTools.find(t=>t.name==='ten98_read_rank_matrix')!.schema as any,trackerId=randomUUID();
  assert.deepEqual(Object.keys(savedKeywords.shape.filters.unwrap().shape),[...savedKeywordFilterKeys]);assert.equal(savedKeywordFilterKeys.length,15);
  assert.equal(savedKeywords.safeParse({projectId:input.projectId,filters:{search:'x',tagIds:[]},pageSize:250,cursor:'c'}).success,true);
  for(const bad of [{projectId:input.projectId,pageSize:25},{projectId:input.projectId,filters:{unknown:1}},{projectId:input.projectId,cursor:'c'.repeat(513)},{projectId:input.projectId,requestId:randomUUID()}])assert.equal(savedKeywords.safeParse(bad).success,false);
  assert.equal(matrix.safeParse({projectId:input.projectId,trackerId,query:{device:'desktop',runLimit:'26',pinned:'true',search:'',cursor:'c'}}).success,true);
  for(const bad of [{projectId:input.projectId,trackerId},{projectId:input.projectId,trackerId,query:{}},{projectId:input.projectId,trackerId,query:{device:'both'}},{projectId:input.projectId,trackerId,query:{device:'desktop',runLimit:12}},{projectId:input.projectId,trackerId,query:{device:'desktop',runLimit:'0'}},{projectId:input.projectId,trackerId,query:{device:'desktop',runLimit:'100'}}])assert.equal(matrix.safeParse(bad).success,false);
  // The snapshot offset stays a canonical wire string; the native coerce parser keeps the 10000 cap.
  const snapshot=mcpTools.find(t=>t.name==='ten98_read_google_snapshot')!.schema,importId=randomUUID(),domainId=randomUUID();
  for(const good of [{projectId:input.projectId,importId},{projectId:input.projectId,importId,query:{}},{projectId:input.projectId,importId,query:{offset:'0'}},{projectId:input.projectId,importId,query:{offset:'10000'}}])assert.equal(snapshot.safeParse(good).success,true);
  for(const bad of [{projectId:input.projectId},{projectId:input.projectId,importId,query:{offset:0}},{projectId:input.projectId,importId,query:{offset:'01'}},{projectId:input.projectId,importId,query:{offset:'-1'}},{projectId:input.projectId,importId,query:{offset:'100000'}},{projectId:input.projectId,importId,query:{offset:'0',limit:'50'}},{projectId:input.projectId,importId:'not-a-uuid'}])assert.equal(snapshot.safeParse(bad).success,false);
  for(const name of ['ten98_list_google_sources','ten98_list_domains'])assert.equal(mcpTools.find(t=>t.name===name)!.schema.safeParse({projectId:input.projectId,query:{}}).success,false,name);
  const redirects=mcpTools.find(t=>t.name==='ten98_list_domain_redirect_checks')!.schema;
  assert.equal(redirects.safeParse({projectId:input.projectId,domainId}).success,true);for(const bad of [{projectId:input.projectId},{projectId:input.projectId,domainId,query:{}}])assert.equal(redirects.safeParse(bad).success,false);
  // Rank history tools take exactly the native query keys of their routes; the keyword history also needs its keyword ID.
  const schema=(name:string)=>mcpTools.find(t=>t.name===name)!.schema as any,keywordId=randomUUID();
  for(const [name,args] of [['ten98_list_rank_runs',{query:{cursor:'c'}}],['ten98_read_rank_results',{query:{cursor:'c',device:'both',search:'',pinned:'false'}}],['ten98_read_rank_keyword_history',{keywordId,query:{cursor:'c',device:'mobile'}}]] as const)assert.equal(schema(name).safeParse({projectId:input.projectId,trackerId,...args}).success,true,name);
  // Audit tools take exactly the native query keys of their three admitted routes; limit stays a native wire string.
  const runId=randomUUID();
  for(const [name,args] of [['ten98_list_site_audits',{}],['ten98_list_site_audits',{query:{cursor:'c',limit:'100'}}],['ten98_read_site_audit',{runId}],['ten98_list_site_audit_issues',{runId,query:{cursor:'c',limit:'1',code:'missing-title',severity:'info',pageId:runId}}]] as const)assert.equal(schema(name).safeParse({projectId:input.projectId,...args}).success,true,name);
  for(const [name,args] of [['ten98_list_site_audits',{query:{limit:50}}],['ten98_list_site_audits',{query:{limit:'0'}}],['ten98_list_site_audits',{query:{limit:'1000'}}],['ten98_list_site_audits',{query:{code:'missing-title'}}],['ten98_list_site_audits',{runId}],['ten98_read_site_audit',{}],['ten98_read_site_audit',{runId,query:{}}],['ten98_list_site_audit_issues',{query:{}}],['ten98_list_site_audit_issues',{runId,query:{severity:'error'}}],['ten98_list_site_audit_issues',{runId,query:{pageId:'bad'}}],['ten98_list_site_audit_issues',{runId,query:{search:'x'}}],['ten98_list_site_audit_issues',{runId,query:{cursor:'c'.repeat(513)}}]] as const)assert.equal(schema(name).safeParse({projectId:input.projectId,...args}).success,false,name);
  for(const [name,args] of [['ten98_list_rank_runs',{query:{device:'desktop'}}],['ten98_read_rank_results',{query:{limit:'50'}}],['ten98_read_rank_results',{query:{device:'tablet'}}],['ten98_read_rank_keyword_history',{}],['ten98_read_rank_keyword_history',{keywordId,query:{search:'x'}}],['ten98_list_rank_runs',{query:{cursor:'c'.repeat(513)}}]] as const)assert.equal(schema(name).safeParse({projectId:input.projectId,trackerId,...args}).success,false,name);
});
test('every scoped tool has its own explicit case and the switch default throws instead of routing',()=>{
  const source=readFileSync(new URL('../src/server/mcp-tools.ts',import.meta.url),'utf8');
  for(const tool of mcpTools)if(tool.scope!==null)assert.ok(source.includes(`case '${tool.name}'`),tool.name);
  assert.match(source,/default:throw new FoundationError\(500,/);
});
test('complete UTF-8 result counts both copies and committed receipt stays small',()=>{
  const result=mcpResult({missing:null,zero:0,text:'🙂é'});assert.deepEqual(JSON.parse((result.content![0]as {text:string}).text),result.structuredContent);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<mcpResponseBytes);
  assert.throws(()=>mcpResult({text:'🙂'.repeat(1_100_000)}),/complete result is too large/);
  const receipt=mcpResult({committed:true,requestId:randomUUID(),replayed:false,items:Array.from({length:100},()=>({id:randomUUID(),revision:2147483646,currentVersionId:randomUUID(),archivedAt:'9998-12-31T23:59:59.999Z'}))});
  assert.ok(Buffer.byteLength(JSON.stringify(receipt))<65536);
  assert.equal(JSON.stringify(mcpToolError(new Error('secret SQL/token 127.0.0.1'))).includes('secret'),false);
});
test('exact Origin and stateless methods reject before database access',async()=>{
  const origin='http://127.0.0.1:3111';assert.ok(mcpOriginAllowed(new Headers(),origin));assert.ok(mcpOriginAllowed(new Headers({origin}),origin));
  for(const value of ['', 'null','http://127.0.0.1:3112','https://127.0.0.1:3111',origin+'/',origin+', '+origin])assert.equal(mcpOriginAllowed(new Headers({origin:value}),origin),false);
  for(const method of ['GET','DELETE','OPTIONS'])assert.equal((await handleMcp(new Request(origin+'/api/mcp',{method}),origin,async()=>assert.fail())).status,405);
  assert.equal((await handleMcp(new Request(origin+'/api/mcp',{method:'POST',headers:{origin:'null'}}),origin,async()=>assert.fail())).status,403);
});
test('official SDK emits finite modern and legacy catalog responses without sessions/subscriptions',async()=>{
  for(const modern of [true,false]){
    const handler=createMcpHandler(()=>createNativeMcpServer('unused', {principal,committed:false},async()=>assert.fail()),{legacy:'stateless',responseMode:'auto',maxSubscriptions:0,keepAliveMs:0,maxRequestBodySize:262144});
    try{
      const body={jsonrpc:'2.0',id:1,method:'tools/list',params:modern?{_meta:{[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_CAPABILITIES_META_KEY]:{}}}:{}};
      const headers:Record<string,string>={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':modern?'2026-07-28':'2025-11-25',...modern?{'mcp-method':'tools/list'}:{}};
      const response=await handler.fetch(new Request('http://127.0.0.1:3111/api/mcp',{method:'POST',headers,body:JSON.stringify(body)}));
      assert.equal(response.status,200);assert.equal(response.headers.has('mcp-session-id'),false);
      const text=await response.text(),wire=JSON.parse(modern?text:text.split('\n').find(line=>line.startsWith('data: {'))!.slice(6));
      assert.equal(wire.result.tools.length,38);assert.ok(wire.result.tools.every((tool:any)=>tool.annotations.openWorldHint===false));
      assert.ok(wire.result.tools.every((tool:any)=>tool.inputSchema.additionalProperties===false));
    }finally{await handler.close();}
  }
});
