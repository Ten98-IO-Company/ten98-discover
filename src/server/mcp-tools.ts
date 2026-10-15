import {z} from 'zod';
import {McpServer,type CallToolResult} from '@modelcontextprotocol/server';
import {authenticateApiKey,authorizeApiKey,type ApiKeyPrincipal,type ApiKeyScope} from './api-keys.ts';
import {FoundationError} from './auth.ts';
import {InputError} from './validation.ts';
import {getDatabase} from './db.ts';
import {projectAnalytics} from './analytics.ts';
import {projectRealtime} from './realtime.ts';
import {projectJourneys} from './journeys.ts';
import {projectRetentionReport} from './retention-report.ts';
import {projectAttribution} from './attribution.ts';
import {listSessions,getSessionDetail,getLinkedSessionActivity} from './session-explorer.ts';
import {listPrompts,getPrompt,promptVersions,createPrompts,updatePrompt,setPromptArchived} from './prompts.ts';
import {explorerFilters} from './explorer-input.ts';

export const mcpResponseBytes=8*1024*1024;
const id=z.uuid(),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),key=z.string().length(64).regex(/^[a-f0-9]+$/);
const optionalStrings=(keys:readonly string[],max:number)=>Object.fromEntries(keys.map(name=>[name,z.string().max(max).optional()]));
const dates={from:date.optional(),to:date.optional()};
const overview=z.strictObject({...dates,compare:z.enum(['prev','yoy']).optional(),...optionalStrings(['browser','os','device','country','region','city'],2048),geoDetail:z.enum(['region','city']).optional(),geoPeriod:z.enum(['current','comparison']).optional(),geoSearch:z.string().max(2048).optional()});
const calendar={from:date,to:date,timeZone:z.string().min(1).max(80)};
const paging={pageSize:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),cursor:z.string().max(2048).optional()};
const activity=z.strictObject({...calendar,...paging});
const sessions=z.strictObject({...calendar,...paging,...optionalStrings(explorerFilters,2048),kind:z.enum(['all','pageviews','custom']).optional(),visitorKey:key.optional(),...optionalStrings(['propertyKey','propertyType','propertyValue','predicates','cohortId','cohortRevision'],20000)});
const population=sessions.omit({pageSize:true,cursor:true,visitorKey:true}).partial({from:true,to:true,timeZone:true});
const journeys=population.extend({steps:z.enum(['2','3','4','5','6','7']).optional(),startKind:z.enum(['pageview','custom']).optional(),startValue:z.string().max(2048).optional(),endKind:z.enum(['pageview','custom']).optional(),endValue:z.string().max(2048).optional()});
const retention=population.omit({from:true,to:true,timeZone:true}).extend({month:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),timeZone:calendar.timeZone});
const attribution=population.extend({model:z.enum(['first-click','last-click']).optional(),conversionKind:z.enum(['pageview','custom']),conversionValue:z.string().min(1).max(2048)});
const promptQuery=z.strictObject({status:z.enum(['active','archived','all']).optional(),q:z.string().max(200).optional(),tag:z.string().max(80).optional(),classification:z.enum(['branded','unbranded','']).optional(),cursor:z.string().max(512).optional()});
const promptFields={text:z.string().min(1).max(2000),topic:z.string().min(1).max(100).optional(),tags:z.array(z.string().min(1).max(80)).max(20).optional(),enabled:z.boolean().optional()};
const action={requestId:id,revision:z.number().int().min(1).max(2147483646)};
const prompt=z.strictObject({projectId:id,promptId:id});
// Wire schemas have no transforms. Native parsers remain authoritative for dates,
// canonical composite keys, Unicode, predicates, cursor binding and receipt payloads.
export const mcpTools=[
  {name:'ten98_whoami',scope:null,description:'Read current user/workspace IDs, effective key scopes and available tool names. No credentials or member profiles.',schema:z.strictObject({})},
  {name:'ten98_read_analytics',scope:'analytics:read',description:'Read retained analytics; optional UTC calendar comparison and region/city search (at most 500 returned rows). Null is unavailable, not zero. Counts estimate rotating keys, not people. asOf is report time, not an event fence.',schema:z.strictObject({projectId:id,query:overview.optional()})},
  {name:'ten98_read_realtime',scope:'analytics:read',description:'Read the fixed rolling 30-minute snapshot, 5-minute active-key estimate and at most 100 real activity rows. Totals cover the full retained population.',schema:z.strictObject({projectId:id})},
  {name:'ten98_list_sessions',scope:'analytics:read',description:'List retained observed rotating visitor keys, with explicit calendar dates/timezone and scoped paging. Query values use native URL wire strings; predicates/propertyValue are JSON text. No identity means unavailable.',schema:z.strictObject({projectId:id,query:sessions})},
  {name:'ten98_read_session',scope:'analytics:read',description:'Read one observed key and retained activity. Explicit dates/timezone required; cursor pages are current per page. Keys are not persistent people or complete sessions.',schema:prompt.omit({promptId:true}).extend({visitorKey:key,query:activity})},
  {name:'ten98_read_linked_activity',scope:'analytics:read',description:'Read retained explicitly evidenced linked activity for an observed key. No inferred identity joins or complete-history claim.',schema:z.strictObject({projectId:id,visitorKey:key,query:activity})},
  {name:'ten98_read_journeys',scope:'analytics:read',description:'Read up to 100 observed native visit prefixes after full-population aggregation. Query uses native URL strings; steps is 2–7 (default 3), start/end each require kind and value together. Edges are next matching observations, not causal transitions or proven exits. Missing history/identity stays explicit; the complete MCP reply may refuse a large native report.',schema:z.strictObject({projectId:id,query:journeys.optional()})},
  {name:'ten98_read_retention',scope:'analytics:read',description:'Read every local date and ten exact return offsets within one explicit month/timeZone, including same-snapshot CSV. Entry filters select first retained matching activity; returns include any activity. Rotating keys are not first-ever people. Incomplete assignment suppresses rates; unknown is not zero.',schema:z.strictObject({projectId:id,query:retention})},
  {name:'ten98_read_attribution',scope:'analytics:read',description:'Read first-click (default) or last-click observed source credits for an explicit typed conversionKind/conversionValue. Full converted-key totals precede each top20 list. Conversion filters do not narrow the touch pool. Missing/empty sources and incomplete evidence remain explicit; no paid-click or causal inference.',schema:z.strictObject({projectId:id,query:attribution})},
  {name:'ten98_list_prompts',scope:'prompts:read',description:'List/search up to 50 saved authored prompts with a scoped nextCursor. Reads saved data; never executes or schedules a prompt.',schema:z.strictObject({projectId:id,query:promptQuery.optional()})},
  {name:'ten98_read_prompt',scope:'prompts:read',description:'Read one saved prompt and current classification. Never executes or schedules it.',schema:prompt},
  {name:'ten98_list_prompt_versions',scope:'prompts:read',description:'Read up to 50 immutable text versions with a scoped nextCursor.',schema:prompt.extend({query:z.strictObject({cursor:z.string().max(512).optional()}).optional()})},
  {name:'ten98_create_prompts',scope:'prompts:write',write:true,description:'Save 1–100 prompts atomically, without execution or scheduling. Explicit requestId makes identical normalized retries replay safely; changed payload conflicts. Returns a bounded committed receipt with IDs/current revisions, not authored text.',schema:z.strictObject({projectId:id,requestId:id,prompts:z.array(z.strictObject(promptFields)).min(1).max(100)})},
  {name:'ten98_update_prompt',scope:'prompts:write',write:true,description:'Update a saved prompt with current revision and requestId; at least one editable field required. Text changes append a version. No execution. Returns a committed receipt; identical retry replays current state.',schema:prompt.extend({...action,...promptFields,text:promptFields.text.optional()})},
  {name:'ten98_archive_prompt',scope:'prompts:write',write:true,description:'Archive a saved prompt without deleting versions. Requires current revision and requestId. Returns a committed receipt; identical retry replays current state.',schema:prompt.extend(action)},
  {name:'ten98_restore_prompt',scope:'prompts:write',write:true,description:'Restore a saved prompt, refusing an active exact-text collision. Requires current revision and requestId. Returns a committed receipt; no execution.',schema:prompt.extend(action)},
] as const;
export function availableTools(principal:ApiKeyPrincipal){return mcpTools.filter(tool=>tool.scope===null||principal.scopes.includes(tool.scope));}
export function mcpToolError(error:unknown):CallToolResult {
  const status=error instanceof FoundationError||error instanceof InputError?error.status:error instanceof z.ZodError?400:500;
  const message=status===400?'Check the tool fields, dates, filters and cursors.':status===401?'The API key is invalid, expired or unavailable.':status===403?'The API key does not permit this action.':status===404?'The requested item is not found or unavailable.':status===409?'The saved state or request ID conflicts. Read current state and use the original request ID only for an identical retry.':status===429?'Too many requests. Wait a minute and retry.':status===503?'The operation is unavailable or its complete result is too large. Narrow read dates/page size. For writes retry the identical request ID.':'The operation could not be completed. For writes retry the identical request ID to resolve its receipt.';
  return {isError:true,content:[{type:'text',text:message}],structuredContent:{error:{status,message}}};
}
export function mcpResult(value:unknown):CallToolResult {
  const text=JSON.stringify(value),structuredContent=JSON.parse(text) as Record<string,unknown>;
  const result:CallToolResult={content:[{type:'text',text}],structuredContent};
  // Reserve space for bounded request ID, SDK metadata and finite legacy SSE framing.
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>mcpResponseBytes-8192)throw new FoundationError(503,'The complete result is too large.');
  return result;
}
export type McpRequestState={principal:ApiKeyPrincipal;committed:boolean};
export type McpLimit=(key:string,maximum:number)=>Promise<void>;
export function createNativeMcpServer(token:string,state:McpRequestState,limit:McpLimit){
  const server=new McpServer({name:'ten98-monitor',version:'0.0.0-foundation'},{capabilities:{tools:{listChanged:false}},maxToolInputElements:10000});
  for(const tool of availableTools(state.principal))server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema,
    annotations:{readOnlyHint:!('write'in tool),destructiveHint:'write'in tool,idempotentHint:true,openWorldHint:false}},async(raw:unknown)=>{
    try{
      const principal=tool.scope===null?await authenticateApiKey(token):await authorizeApiKey(token,state.principal.workspaceId,tool.scope as ApiKeyScope);
      if(principal.userId!==state.principal.userId||principal.workspaceId!==state.principal.workspaceId)throw new FoundationError(401,'Authority changed.');
      if(tool.name==='ten98_whoami')return mcpResult({userId:principal.userId,workspaceId:principal.workspaceId,scopes:principal.scopes,tools:availableTools(principal).map(item=>item.name)});
      const args=raw as {projectId:string;promptId?:string;visitorKey?:string;query?:Record<string,string>;requestId?:string};
      const target=await getDatabase().pool.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2',[args.projectId,principal.workspaceId]);
      if(!target.rowCount)throw new FoundationError(404,'Project not found or unavailable.');
      const query=new URLSearchParams(args.query),authority={kind:'api-key' as const,token};
      let result:unknown;
      switch(tool.name){
        case 'ten98_read_analytics':result=await projectAnalytics(args.projectId,principal.userId,query,principal.id);break;
        case 'ten98_read_realtime':await limit(`realtime:${principal.userId}`,60);result=await projectRealtime(args.projectId,authority,query);break;
        case 'ten98_list_sessions':await limit(`sessions:${principal.userId}`,30);result=await listSessions(args.projectId,authority,query);break;
        case 'ten98_read_session':await limit(`sessions:${principal.userId}`,30);result=await getSessionDetail(args.projectId,args.visitorKey!,authority,query);break;
        case 'ten98_read_linked_activity':await limit(`sessions:${principal.userId}`,30);result=await getLinkedSessionActivity(args.projectId,args.visitorKey!,authority,query);break;
        case 'ten98_read_journeys':await limit(`journeys:${principal.userId}`,30);result=await projectJourneys(args.projectId,authority,query);break;
        case 'ten98_read_retention':await limit(`retention-report:${principal.userId}`,30);result=await projectRetentionReport(args.projectId,authority,query);break;
        case 'ten98_read_attribution':await limit(`attribution:${principal.userId}`,30);result=await projectAttribution(args.projectId,authority,query);break;
        case 'ten98_list_prompts':result=await listPrompts(args.projectId,principal.userId,query,token);break;
        case 'ten98_read_prompt':result=await getPrompt(args.projectId,principal.userId,args.promptId,token);break;
        case 'ten98_list_prompt_versions':result=await promptVersions(args.projectId,principal.userId,args.promptId,query,token);break;
        default:{
          const {projectId,promptId,...input}=raw as Record<string,unknown>;
          const saved=tool.name==='ten98_create_prompts'?await createPrompts(projectId,principal.userId,input,token):tool.name==='ten98_update_prompt'?await updatePrompt(projectId,principal.userId,promptId,input,token):await setPromptArchived(projectId,principal.userId,promptId,tool.name==='ten98_archive_prompt',input,token);
          // Native transaction already committed with its final authority check. This
          // bounded projection never echoes authored text or reports a false rollback.
          state.committed=true;
          const items='items'in saved?saved.items:[saved.prompt];
          return mcpResult({committed:true,requestId:args.requestId,replayed:saved.replayed,items:items.map(item=>({id:item.id,revision:item.revision,currentVersionId:item.currentVersionId,archivedAt:item.archivedAt}))});
        }
      }
      const response=mcpResult(result);
      await authorizeApiKey(token,principal.workspaceId,tool.scope as ApiKeyScope);
      return response;
    }catch(error){return mcpToolError(error);}
  });
  return server;
}
