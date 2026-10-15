import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import type {PoolClient} from 'pg';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,migrationSources,assertSchema} from '../src/server/db.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {apiKeyScopes,createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {changeRole,removeMember} from '../src/server/teams.ts';
import {mcpTools} from '../src/server/mcp-tools.ts';

export async function runMcpChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_MCP_TEST,'1');
  const config=getConfig(),database=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
  assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55501');assert.match(database.pathname,/^\/ten98_mcp_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(config.appUrl,origin);
  for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
  const {pool}=getDatabase();assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');for(const source of await migrationSources()){await client.query(source.sql);await client.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}await initializeProviderAccountIdentity(client,true);await client.query('COMMIT');}finally{client.release();}await assertSchema();
  const server=createServer(async(req,res)=>{try{
    const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
    const response=await handleApi(new Request(origin+req.url,{method:req.method,headers,...['GET','HEAD'].includes(req.method!)?{}:{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'}}as RequestInit));
    res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body as any).pipe(res);else res.end();
  }catch{res.writeHead(500);res.end();}});
  const http=(path:string,headers:Record<string,string>={},body?:unknown,method=body===undefined?'GET':'POST',raw?:Buffer)=>new Promise<{status:number;wire:any;headers:Record<string,any>;bytes:number;complete:boolean}>((resolve,reject)=>{
    const bytes=raw??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));const req=httpRequest(origin+path,{method,agent:false,headers:{...bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{},...headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.complete,true);const text=Buffer.concat(chunks).toString('utf8'),line=text.split('\n').find(x=>x.startsWith('data: {'));resolve({status:res.statusCode!,wire:text?JSON.parse(line?line.slice(6):text):null,headers:res.headers,bytes:Buffer.byteLength(text),complete:res.complete});}catch(error){reject(error);}});
    });req.setTimeout(15000,()=>req.destroy(new Error('Fixture HTTP deadline.')));req.on('error',error=>reject(new Error(`Fixture HTTP ${method} ${(body as {method?:string;id?:number}|undefined)?.method??'raw'} id=${(body as {id?:number}|undefined)?.id??'none'} bytes=${bytes?.length??0} failed: ${(error as {code?:string}).code??error.name}`)));req.end(bytes);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(3111,'127.0.0.1',resolve);});
  try{
    const setup=await http('/api/setup',{origin},{token:config.bootstrapToken,name:'MCP fixture',email:randomUUID()+'@mcp.test',password:randomBytes(32).toString('hex'),workspaceName:'MCP synthetic'});assert.equal(setup.status,200);
    const owner=(await pool.query("SELECT user_id,workspace_id FROM membership WHERE role='owner'")).rows[0],workspace=owner.workspace_id as string,ownerId=owner.user_id as string,project=randomUUID(),visitor='a'.repeat(64);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'MCP project','https://mcp.test',gen_random_uuid(),'infinity')",[project,workspace]);
    await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,clock_timestamp(),clock_timestamp())',[project,visitor]);
    await pool.query("INSERT INTO event(id,project_id,event_name,path,source,metric_version,collection_basis,visitor_id,visit_id) VALUES($1,$2,'page_view','/mcp','browser','native-v1','cookieless',$3,$4)",[randomUUID(),project,visitor,'b'.repeat(64)]);
    const all=await createApiKey(workspace,ownerId,{name:'MCP all',scopes:[...apiKeyScopes]}),read=await createApiKey(workspace,ownerId,{name:'MCP read',scopes:['prompts:read']}),write=await createApiKey(workspace,ownerId,{name:'MCP write',scopes:['prompts:write']});
    let sequence=0;
    function rpc(method:string,params:Record<string,unknown>={},token=all.token,modern=true,headers:Record<string,string>={}){
      const meta=modern?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}:{};
      return http('/api/mcp',{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':modern?'2026-07-28':'2025-11-25',...modern?{'mcp-method':method,...method==='tools/call'?{'mcp-name':String(params.name)}:{}}:{},...headers},{jsonrpc:'2.0',id:++sequence,method,params:{...params,...meta}});
    }
    const call=(name:string,args:Record<string,unknown>,token=all.token,modern=true)=>rpc('tools/call',{name,arguments:args},token,modern);
    const data=(response:Awaited<ReturnType<typeof rpc>>)=>{assert.equal(response.status,200,JSON.stringify(response.wire));assert.equal(response.wire.result?.isError,undefined,JSON.stringify(response.wire));assert.ok(response.bytes<=8*1024*1024);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['mcp-session-id'],undefined);const result=response.wire.result;assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);return result.structuredContent;};
    for(const modern of [true,false]){
      const listed=await rpc('tools/list',{},all.token,modern);assert.equal(listed.status,200);assert.deepEqual(listed.wire.result.tools.map((x:any)=>x.name),mcpTools.map(t=>t.name));assert.equal(listed.headers['mcp-session-id'],undefined);
      const who=data(await call('ten98_whoami',{},all.token,modern));assert.equal(who.workspaceId,workspace);assert.equal(who.userId,ownerId);assert.equal(who.tools.length,13);
    }
    const discovery=await rpc('server/discover');assert.equal(discovery.status,200);assert.equal(discovery.wire.result.capabilities.tools.listChanged,false);for(const cap of ['tasks','resources','prompts','sampling'])assert.equal(discovery.wire.result.capabilities[cap],undefined);
    const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native-protocol-fixture',version:'1'}},all.token,false);assert.equal(init.status,200);assert.equal(init.wire.result.protocolVersion,'2025-11-25');
    const subscription=await rpc('subscriptions/listen',{subscriptions:[]});assert.equal(subscription.status,200);assert.ok(subscription.wire.error);assert.equal(subscription.complete,true);
    console.log('PASS actual HTTP modern/legacy discovery, safe whoami, finite transports and no advertised extra capabilities');

    const date=(await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS date")).rows[0].date,calendar={from:date,to:date,timeZone:'UTC'};
    assert.equal(data(await call('ten98_read_analytics',{projectId:project,query:{from:date,to:date,compare:'prev',geoDetail:'city',geoSearch:'',geoPeriod:'comparison'}})).totals.pageViews,1);
    assert.equal(data(await call('ten98_read_realtime',{projectId:project})).totals.pageViews,1);
    assert.equal(data(await call('ten98_list_sessions',{projectId:project,query:calendar})).rows.length,1);
    assert.equal(data(await call('ten98_read_session',{projectId:project,visitorKey:visitor,query:calendar})).activity.length,1);
    assert.equal(data(await call('ten98_read_linked_activity',{projectId:project,visitorKey:visitor,query:calendar})).selection.status,'unavailable');
    const batch={projectId:project,requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'MCP authored '+i}))};
    const created=data(await call('ten98_create_prompts',batch,write.token));assert.equal(created.committed,true);assert.equal(created.items.length,100);assert.equal(created.replayed,false);assert.equal(created.items[0].text,undefined);
    const replay=data(await call('ten98_create_prompts',batch,write.token,false));assert.equal(replay.replayed,true);assert.deepEqual(replay.items,created.items);
    const promptId=created.items[0].id,list=data(await call('ten98_list_prompts',{projectId:project},read.token));assert.equal(list.items.length,50);assert.ok(list.nextCursor);
    assert.equal(data(await call('ten98_list_prompts',{projectId:project,query:{cursor:list.nextCursor}},read.token)).items.length,50);
    assert.equal(data(await call('ten98_read_prompt',{projectId:project,promptId},read.token)).prompt.text,'MCP authored 0');
    const update={projectId:project,promptId,requestId:randomUUID(),revision:1,text:'MCP edited'};
    assert.equal(data(await call('ten98_update_prompt',update,write.token)).items[0].revision,2);assert.equal(data(await call('ten98_update_prompt',update,write.token)).replayed,true);
    assert.deepEqual(data(await call('ten98_list_prompt_versions',{projectId:project,promptId},read.token)).versions.map((x:any)=>x.number),[2,1]);
    assert.ok(data(await call('ten98_archive_prompt',{projectId:project,promptId,requestId:randomUUID(),revision:2},write.token)).items[0].archivedAt);
    assert.equal(data(await call('ten98_restore_prompt',{projectId:project,promptId,requestId:randomUUID(),revision:3},write.token)).items[0].archivedAt,null);
    const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM project_prompt WHERE project_id=$1) AS prompts,(SELECT count(*)::int FROM prompt_text_version WHERE project_id=$1) AS versions,(SELECT count(*)::int FROM project_content_request WHERE project_id=$1) AS receipts`,[project])).rows[0];
    assert.deepEqual(await counts(),{prompts:100,versions:101,receipts:4});
    const concurrent={projectId:project,requestId:randomUUID(),prompts:[{text:'MCP concurrent'}]},both=await Promise.all([call('ten98_create_prompts',concurrent),call('ten98_create_prompts',concurrent)]);assert.deepEqual(both.map(r=>data(r).replayed).sort(),[false,true]);
    const before=await counts();const conflict=await call('ten98_create_prompts',{projectId:project,requestId:randomUUID(),prompts:[{text:'Rollback me'},{text:'MCP authored 1'}]});assert.equal(conflict.wire.result.structuredContent.error.status,409);assert.deepEqual(await counts(),before);
    assert.equal((await call('ten98_create_prompts',{...batch,prompts:[{text:'Changed receipt'}]})).wire.result.structuredContent.error.status,409);
    console.log('PASS all 13 actual native tools, null/zero semantics, 100 atomic prompts, pagination, receipts and concurrent replay');

    for(const [token,count]of [[read.token,4],[write.token,5]]as const)assert.equal((await rpc('tools/list',{},token)).wire.result.tools.length,count);
    assert.ok((await call('ten98_read_prompt',{projectId:project,promptId},write.token)).wire.error);assert.ok((await call('ten98_create_prompts',concurrent,read.token)).wire.error);
    const foreignWorkspace=randomUUID(),foreignProject=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign')",[foreignWorkspace]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Foreign','https://foreign-mcp.test',gen_random_uuid())",[foreignProject,foreignWorkspace]);
    for(const name of ['ten98_read_analytics','ten98_list_prompts','ten98_create_prompts']){const denied=await call(name,{projectId:foreignProject,...name==='ten98_create_prompts'?{requestId:randomUUID(),prompts:[{text:'Never'}]}:{}});assert.equal(denied.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(denied.wire).includes(foreignProject),false);}
    for(const headers of [{cookie:'session=fake'},{'x-api-key':'fake'},{authorization:'Basic nope'}]as Record<string,string>[])assert.ok([400,401].includes((await rpc('tools/list',{},all.token,true,headers)).status));
    for(const value of ['', 'null','http://127.0.0.1:3112','https://127.0.0.1:3111',origin+'/',origin+', '+origin])assert.equal((await rpc('tools/list',{},all.token,true,{origin:value})).status,403);
    assert.equal((await rpc('tools/list',{},all.token,true,{origin})).status,200);
    for(const headers of [{'mcp-protocol-version':'2025-11-25'},{'mcp-method':'ping'},{'mcp-protocol-version':''},{'mcp-method':''}]as Record<string,string>[])assert.equal((await rpc('tools/list',{},all.token,true,headers)).status,400);
    assert.equal((await rpc('tools/call',{name:'ten98_whoami',arguments:{}},all.token,true,{'mcp-name':'different'})).status,400);
    for(const payload of [[],null,42,{jsonrpc:'2.0',id:'x'.repeat(129),method:'tools/list'},{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'constructor',arguments:{}}}])assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},payload)).status,400);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},undefined,'POST',Buffer.from([0xc3,0x28]))).status,400);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},undefined,'POST',Buffer.alloc(262145,0x20))).status,413);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token,'content-type':'text/plain'},{})).status,415);
    for(const method of ['GET','DELETE','OPTIONS'])assert.equal((await http('/api/mcp',{},undefined,method)).status,405);
    assert.equal((await http('/api/mcp?token=forbidden',{},{})).status,400);
    for(const [name,args]of [['ten98_read_realtime',{projectId:project,query:{}}],['ten98_read_analytics',{projectId:project,query:{from:'2025-02-30',to:'2025-03-01'}}],['ten98_list_sessions',{projectId:project,query:{...calendar,groupBy:'country'}}],['ten98_create_prompts',{projectId:project,requestId:randomUUID(),prompts:[{text:'x',execute:true}]}]]as const){const denied=await call(name,args);assert.ok(denied.status===400||denied.wire.result?.structuredContent?.error?.status===400);}
    console.log('PASS scoped discovery, tenant boundaries, Origin/auth rejection, protocol metadata and strict native input limits');

    async function actor(){const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'MCP actor\',$2)',[userId,userId+'@mcp.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,userId]);return {userId,...await createApiKey(workspace,userId,{name:'MCP delayed authority',scopes:[...apiKeyScopes]})};}
    async function waiting(lock:PoolClient,pattern:string){const end=Date.now()+4000;while(Date.now()<end){await lock.query('SELECT pg_stat_clear_snapshot()');if((await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",[pattern])).rowCount)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Real HTTP work did not reach the expected lock.');}
    for(const writeMode of [false,true])for(const action of ['expiry','revocation','demotion','removal']as const){
      const key=await actor(),lock=await pool.connect(),before=await counts();let pending:ReturnType<typeof call>|undefined,mutation:Promise<void>|undefined;
      try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
        if(action!=='expiry'){mutation=action==='revocation'?revokeApiKey(workspace,ownerId,key.key.id):action==='demotion'?changeRole(workspace,ownerId,key.userId,{role:'viewer'}):removeMember(workspace,ownerId,key.userId);void mutation.catch(()=>{});await waiting(lock,action==='revocation'?'SELECT id FROM workspace WHERE id=$1 FOR UPDATE':'SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE');}
        pending=call(writeMode?'ten98_create_prompts':'ten98_list_prompts',{projectId:project,...writeMode?{requestId:randomUUID(),prompts:[{text:'Denied '+randomUUID()}]}:{}},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR % OF w');
        if(action==='expiry')await pool.query("UPDATE api_key SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[key.key.id]);
        await lock.query('COMMIT');await mutation;const result=await pending;assert.equal(result.status,action==='demotion'?403:401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);assert.deepEqual(await counts(),before);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await mutation?.catch(()=>{});await pending?.catch(()=>{});}
    }
    console.log('PASS eight real admission waits deny expiry/revocation/demotion/removal without disclosure or new receipts');

    for(const writeMode of [false,true]){
      const key=await actor(),lock=await pool.connect(),before=await counts();let pending:ReturnType<typeof call>|undefined;
      try{await lock.query('BEGIN');await lock.query(writeMode?'LOCK TABLE project_content_request IN SHARE MODE':'LOCK TABLE project_prompt IN ACCESS EXCLUSIVE MODE');pending=call(writeMode?'ten98_create_prompts':'ten98_read_prompt',{projectId:project,...writeMode?{requestId:randomUUID(),prompts:[{text:'Late rollback '+randomUUID()}]}:{promptId}},key.token);void pending.catch(()=>{});await waiting(lock,writeMode?'INSERT INTO project_content_request%':'SELECT p.id,p.revision,%');
        await pool.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[key.key.id]);await lock.query('SELECT pg_sleep(0.2)');await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.deepEqual(await counts(),before);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
    }
    for(const method of ['tools/list','server/discover','tools/call']){
      const key=await actor(),lock=await pool.connect();let pending:ReturnType<typeof rpc>|undefined;
      try{await lock.query('BEGIN');await lock.query('LOCK TABLE request_limit IN ACCESS EXCLUSIVE MODE');pending=rpc(method,method==='tools/call'?{name:'ten98_whoami',arguments:{}}:{},key.token);void pending.catch(()=>{});await waiting(lock,'WITH expired AS%');await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.equal(result.wire.result,undefined);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
    }
    console.log('PASS late mutation rollback and fresh discovery/whoami publication authority after actual HTTP waits');
    await pool.query("INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),120) ON CONFLICT(key,minute) DO UPDATE SET count=120",['api-key:'+all.key.id]);assert.equal((await rpc('tools/list')).status,429);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS shared rate budget and zero provider/probe work or idle transactions');
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
if(process.env.TEN98_MCP_TEST==='1')runMcpChecks().catch(error=>{console.error('FAIL MCP integration',error instanceof Error?{name:error.name,message:error.message}:{name:'UnknownError'});process.exitCode=1;}).finally(closeDatabase);
