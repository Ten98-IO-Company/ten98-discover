import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMcpHandler,PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {mcpTools,availableTools,mcpResult,mcpResponseBytes,mcpToolError,createNativeMcpServer} from '../src/server/mcp-tools.ts';
import {handleMcp,mcpOriginAllowed} from '../src/server/mcp.ts';
import {apiKeyScopes,type ApiKeyPrincipal} from '../src/server/api-keys.ts';

const principal:ApiKeyPrincipal={id:randomUUID(),userId:randomUUID(),workspaceId:randomUUID(),role:'owner',scopes:[...apiKeyScopes]};
test('fixed native catalog, strict bounded schemas and scope separation',()=>{
  assert.equal(mcpTools.length,16);assert.equal(new Set(mcpTools.map(t=>t.name)).size,16);
  const original=['ten98_whoami','ten98_read_analytics','ten98_read_realtime','ten98_list_sessions','ten98_read_session','ten98_read_linked_activity','ten98_list_prompts','ten98_read_prompt','ten98_list_prompt_versions','ten98_create_prompts','ten98_update_prompt','ten98_archive_prompt','ten98_restore_prompt'];
  assert.deepEqual(mcpTools.filter(tool=>original.includes(tool.name)).map(tool=>tool.name),original);
  assert.equal(availableTools({...principal,scopes:['analytics:read']}).length,9);
  assert.equal(availableTools({...principal,scopes:['prompts:read']}).length,4);
  assert.equal(availableTools({...principal,scopes:['prompts:write']}).length,5);
  assert.deepEqual(availableTools({...principal,scopes:[]}).map(t=>t.name),['ten98_whoami']);
  for(const tool of mcpTools)assert.equal(tool.schema.safeParse({execute:true,token:'not accepted'}).success,false);
  const bulk=mcpTools.find(t=>t.name==='ten98_create_prompts')!.schema;
  const input={projectId:randomUUID(),requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'Prompt '+i}))};
  assert.equal(bulk.safeParse(input).success,true);assert.equal(bulk.safeParse({...input,prompts:[...input.prompts,{text:'101'}]}).success,false);
  assert.equal(mcpTools.find(t=>t.name==='ten98_read_realtime')!.schema.safeParse({projectId:input.projectId,query:{}}).success,false);
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
      assert.equal(wire.result.tools.length,16);assert.ok(wire.result.tools.every((tool:any)=>tool.annotations.openWorldHint===false));
      assert.ok(wire.result.tools.every((tool:any)=>tool.inputSchema.additionalProperties===false));
    }finally{await handler.close();}
  }
});
