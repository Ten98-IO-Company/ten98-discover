import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMcpHandler,PROTOCOL_VERSION_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server';
import {mcpTools,availableTools,createNativeMcpServer} from '../src/server/mcp-tools.ts';
import type {ApiKeyPrincipal} from '../src/server/api-keys.ts';
import {journeysQuery} from '../src/server/journeys.ts';
import {retentionReportQuery} from '../src/server/retention-report-input.ts';
import {attributionQuery} from '../src/server/attribution.ts';

const reports=['ten98_read_journeys','ten98_read_retention','ten98_read_attribution'] as const;
const principal:ApiKeyPrincipal={id:randomUUID(),userId:randomUUID(),workspaceId:randomUUID(),role:'viewer',scopes:['analytics:read']};
const projectId=randomUUID(),now=new Date('2026-10-15T12:00:00Z');
function query(name:typeof reports[number],value:Record<string,string>){
 const parsed=mcpTools.find(tool=>tool.name===name)!.schema.parse({projectId,query:value});
 assert.deepEqual(parsed,{projectId,query:value},'MCP must preserve the native wire strings');return new URLSearchParams(value);
}

test('report tools are discoverable only with analytics read and keep strict native wire contracts',()=>{
 assert.deepEqual(availableTools(principal).filter(tool=>reports.includes(tool.name as typeof reports[number])).map(tool=>tool.name),reports);
 for(const scopes of [[],['prompts:read'],['prompts:write'],['events:write']] as ApiKeyPrincipal['scopes'][])
  assert.equal(availableTools({...principal,scopes}).some(tool=>reports.includes(tool.name as typeof reports[number])),false);
 for(const name of reports){const schema=mcpTools.find(tool=>tool.name===name)!.schema,base=name==='ten98_read_retention'?{month:'2024-02',timeZone:'UTC'}:name==='ten98_read_attribution'?{conversionKind:'custom',conversionValue:'purchase'}:{};
  assert.equal(schema.safeParse({projectId,query:base}).success,true);
  for(const extra of ['groupBy','groupProperty','cursor','pageSize','limit','sort','visitorKey','url','sql','execute'])assert.equal(schema.safeParse({projectId,query:{...base,[extra]:'x'}}).success,false,`${name} ${extra}`);
  for(const value of [null,[],{projectId:'bad',query:base},{projectId,query:base,workspaceId:randomUUID()},{projectId,query:{...base,path:7}}])assert.equal(schema.safeParse(value).success,false);
 }
});

test('all three tools preserve shared literal, property, advanced and cohort scope in the native parser',()=>{
 const predicates=JSON.stringify({version:1,match:'all',fields:[{field:'referrer',operator:'missing'}],properties:[]});
 const common={timeZone:'Asia/Dubai',kind:'pageviews',path:'/literal%25',browser:'chrome',propertyKey:'plan',propertyType:'string',propertyValue:'"team"',predicates,cohortId:randomUUID(),cohortRevision:'7'};
 const calendar={from:'2024-02-01',to:'2024-02-29'};
 const j=journeysQuery(query(reports[0],{...common,...calendar,steps:'7',startKind:'custom',startValue:'signup',endKind:'pageview',endValue:'/thanks'}),now);
 const r=retentionReportQuery(query(reports[1],{...common,month:'2024-02'}),now);
 const a=attributionQuery(query(reports[2],{...common,...calendar,model:'last-click',conversionKind:'custom',conversionValue:'purchase'}),now);
 assert.deepEqual(j.scope,r.scope);assert.deepEqual(j.scope,a.scope);assert.equal(r.scope.to,'2024-02-29');
 assert.deepEqual(j.start,{kind:'custom',value:'signup'});assert.deepEqual(j.end,{kind:'pageview',value:'/thanks'});assert.equal(j.steps,7);
 assert.deepEqual(a.conversion,{kind:'custom',value:'purchase'});assert.equal(a.model,'last-click');
 assert.deepEqual(j.scope.property,{key:'plan',type:'string',value:'team'});assert.deepEqual(j.scope.cohort,{id:common.cohortId,revision:7});assert.equal(j.scope.filters.path,'/literal%25');
 assert.equal(journeysQuery(query(reports[0],{}),now).steps,3);assert.equal(attributionQuery(query(reports[2],{conversionKind:'custom',conversionValue:'purchase'}),now).model,'first-click');
});

test('native parsers still reject invalid calendar, typed pairs and total query bounds',()=>{
 const cases:[typeof reports[number],(params:URLSearchParams,now:Date)=>unknown,Record<string,string>,Record<string,string>[]][]=[
  [reports[0],journeysQuery,{},[{startKind:'custom'},{endValue:'/done'},{startKind:'custom',startValue:'page_view'},{startKind:'pageview',startValue:'/a?b'},{from:'2024-01-01',to:'2025-01-01'},{from:'2024-02-30'}]],
  [reports[1],retentionReportQuery,{month:'2024-02',timeZone:'UTC'},[{month:'1969-12'},{month:'2026-11'},{timeZone:'Bad/Zone'},{propertyKey:'x',propertyType:'boolean',propertyValue:'"true"'}]],
  [reports[2],attributionQuery,{conversionKind:'custom',conversionValue:'purchase'},[{conversionValue:'page_view'},{conversionKind:'pageview',conversionValue:'/bad#fragment'},{conversionValue:'x'.repeat(65)},{timeZone:'Bad/Zone'}]],
 ];
 for(const [name,parse,base,invalid] of cases){for(const patch of invalid){const params=query(name,{...base,...patch});assert.throws(()=>parse(params,now),{status:400});}
  const params=query(name,{...base,propertyKey:'x',propertyType:'string',propertyValue:JSON.stringify('x'.repeat(19990))});assert.throws(()=>parse(params,now),{status:400});
 }
 for(const name of reports){const schema=mcpTools.find(tool=>tool.name===name)!.schema;assert.equal(schema.safeParse({projectId,query:{steps:'07'}}).success,false);}
});

test('official modern and legacy discovery exposes the three finite read-only schemas without provider work',async()=>{
 for(const modern of [true,false]){
  const handler=createMcpHandler(()=>createNativeMcpServer('unused',{principal,committed:false},async()=>assert.fail('Discovery must not run a report')),{legacy:'stateless',responseMode:'auto',maxSubscriptions:0,keepAliveMs:0,maxRequestBodySize:262144});
  try{
   const params=modern?{_meta:{[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_CAPABILITIES_META_KEY]:{}}}:{};
   const response=await handler.fetch(new Request('http://127.0.0.1:3111/api/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':modern?'2026-07-28':'2025-11-25',...modern?{'mcp-method':'tools/list'}:{}},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params})}));
   assert.equal(response.status,200);assert.equal(response.headers.has('mcp-session-id'),false);
   const text=await response.text(),wire=JSON.parse(modern?text:text.split('\n').find(line=>line.startsWith('data: {'))!.slice(6));
   for(const name of reports){const tool=wire.result.tools.find((item:{name:string})=>item.name===name);assert.ok(tool);assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.inputSchema.properties.query.additionalProperties,false);}
  }finally{await handler.close();}
 }
});
