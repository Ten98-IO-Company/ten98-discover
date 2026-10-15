import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {createRequire} from 'node:module';
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
  // Use the production server's lazy Node request adapter; eager toWeb consumes bodies even when headers reject them.
  const {toNodeHandler}=createRequire(import.meta.resolve('nitro/package.json'))('srvx/node');
  const server=createServer(toNodeHandler(handleApi));
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
      const who=data(await call('ten98_whoami',{},all.token,modern));assert.equal(who.workspaceId,workspace);assert.equal(who.userId,ownerId);assert.equal(who.tools.length,16);
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
    for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS'])assert.equal((await http('/api/mcp',{},undefined,method)).status,405);
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
    // Additive report-tool acceptance; the six original groups remain unchanged.
    {
      const {createHash}=await import('node:crypto'),{writeFileSync}=await import('node:fs');
      const {projectJourneys}=await import('../src/server/journeys.ts');
      const {projectRetentionReport,retentionReportCsv}=await import('../src/server/retention-report.ts');
      const {projectAttribution}=await import('../src/server/attribution.ts');
      const {saveCohort}=await import('../src/server/cohorts.ts');
      const {readRetentionReport,retentionReportVersion}=await import('../src/lib/retention-report.ts');
      const {serializeGeographyKey}=await import('../src/lib/analytics-geography.ts');
      const {environmentVersion}=await import('../src/lib/analytics-environment.ts');
      const output=process.env.TEN98_MCP_REPORT_SNAPSHOTS;assert.ok(output);
      const reportEvidence:any={phase:'started',groups:[],reports:[],waits:[],cleanup:[],originalRows:null};
      const persist=()=>writeFileSync(output,JSON.stringify(reportEvidence,null,2)+'\n');persist();
      const originalRows:Record<string,string[]>={},keys:string[]=[],ownedProjects:string[]=[];
      const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'request_limit' ORDER BY tablename")).rows.map((r:any)=>r.tablename as string);
      const rows=async(table:string)=>{assert.match(table,/^[A-Za-z_][A-Za-z0-9_]*$/);return(await pool.query('SELECT to_jsonb(t)::text AS row FROM "'+table+'" t ORDER BY 1')).rows.map((r:any)=>r.row as string);};
      for(const table of tables)originalRows[table]=await rows(table);
      const originalHash=createHash('sha256').update(JSON.stringify(originalRows)).digest('hex');
      const rw=randomUUID(),ru=randomUUID();
      await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Report MCP owner\',$2)',[ru,ru+'@mcp-report.test']);
      await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Report MCP fixture')",[rw]);
      await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[rw,ru]);
      const makeKey=async(userId=ru,scopes:any=['analytics:read'])=>{const value=await createApiKey(rw,userId,{name:'Report gate',scopes});keys.push(value.key.id);return value;};
      const reportKey=await makeKey(),limitedKey=await makeKey(ru,['events:write']);
      const makeProject=async()=>{const id=randomUUID();ownedProjects.push(id);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Report gate',$3,gen_random_uuid(),'infinity')",[id,rw,'https://'+id+'.mcp-report.test']);return id;};
      const p=await makeProject(),empty=await makeProject(),unknown=await makeProject(),expired=await makeProject(),calendarProject=await makeProject(),wide=await makeProject();
      const a='c'.repeat(64),v='d'.repeat(64),geo={version:'dbip-city-lite-v1',databaseBuild:1790818881,databaseSha256:'a'.repeat(64),country:'AE',region:{code:null,name:'Dubai'},city:'Dubai'};
      const dims={origin:'https://fixture.mcp-report.test',referrerHost:'search.test',language:'en',browser:'chrome',os:'Windows 10',device:'desktop',environmentVersion,campaign:{source:'source-a',medium:'organic',campaign:'MCP'},geography:geo};
      const event=async(pid:string,name:string,path:string,at:string,key:string|null=a,visit:string|null=v)=>{
        if(key)await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,$3,$3)ON CONFLICT DO NOTHING',[pid,key,at]);
        await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,source,metric_version,collection_basis,properties,dimensions)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),pid,name,path,at,key,visit,key?'browser':'api',key?'umami-3.4-hour-cache-v1':'observations-v2',key?'consent':null,JSON.stringify({plan:{type:'string',value:'team'}}),JSON.stringify(dims)]);
      };
      try{
        await event(p,'page_view','/entry','2024-03-10T07:00:00.000Z');await event(p,'signup','/entry','2024-03-10T07:00:01.000Z');await event(p,'page_view','/return','2024-03-11T07:00:00.000Z',a,'e'.repeat(64));
        await event(unknown,'signup','/entry','2024-03-10T07:00:00.000Z',null,null);
        await pool.query("UPDATE project SET analytics_retained_from='2024-04-01T00:00:00Z' WHERE id=$1",[expired]);
        for(const at of ['2024-03-10T04:59:59.999Z','2024-03-10T05:00:00.000Z','2024-03-11T03:59:59.999Z','2024-03-11T04:00:00.000Z'])await event(calendarProject,'page_view','/dst',at);
        const common={from:'2024-03-10',to:'2024-03-11',timeZone:'UTC'};
        const cases:{name:string;path:string;read:(id:string,authority:{kind:'api-key';token:string},params:URLSearchParams)=>Promise<any>;query:Record<string,string>}[]=[{name:'ten98_read_journeys',path:'journeys',read:projectJourneys,query:{...common,steps:'2',startKind:'pageview',startValue:'/entry',endKind:'custom',endValue:'signup'}},
          {name:'ten98_read_retention',path:'retention-report',read:projectRetentionReport,query:{month:'2024-03',timeZone:'UTC',path:'/entry'}},
          {name:'ten98_read_attribution',path:'attribution',read:projectAttribution,query:{...common,conversionKind:'custom',conversionValue:'signup',model:'last-click'}}];
        function stable(value:any){
          assert.match(value.asOf,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/);assert.ok(Number.isFinite(Date.parse(value.asOf)));
          const copy=structuredClone(value);delete copy.asOf;
          if(value.version===retentionReportVersion){
            assert.deepEqual(readRetentionReport(value,value.query,value.projectId),value);assert.equal(value.csv,retentionReportCsv(value));
            const line='"Report generated","'+value.asOf+'"';assert.equal(copy.csv.split(line).length,2);copy.csv=copy.csv.replace(line,'"Report generated","<per-call clock>"');
            assert.equal(value.range.observedEnd,value.range.end,'Only completed historical months are compared here.');
          }
          return copy;
        }
        async function equivalent(spec:typeof cases[number],pid:string,query:Record<string,string>,tag:string){
          const params=new URLSearchParams(query),direct=await spec.read(pid,{kind:'api-key',token:reportKey.token},params),native=await http('/api/projects/'+pid+'/'+spec.path+'?'+params,{authorization:'Bearer '+reportKey.token});
          assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(stable(native.wire),stable(direct));
          const results=[];for(const modern of [true,false]){const result=data(await call(spec.name,{projectId:pid,query},reportKey.token,modern));assert.deepEqual(stable(result),stable(direct));results.push(result);}
          reportEvidence.reports.push({tag,tool:spec.name,projectId:pid,query,direct,native:native.wire,modern:results[0],legacy:results[1]});persist();return results[0];
        }
        const base=[];for(const spec of cases)base.push(await equivalent(spec,p,{...spec.query},'base'));
        assert.deepEqual(base[0].paths[0].items,[{kind:'pageview',value:'/entry'},{kind:'custom',value:'signup'}]);assert.equal(base[0].ranking.matchingObservedVisits,1);
        assert.equal(base[1].identity.entryEvents,2);assert.equal(base[1].rows[9].cells.find((c:any)=>c.offset===1).returnedKeys,1);assert.equal(base[1].rows.length,31);
        assert.equal(base[2].measurement.conversionEvents,1);assert.equal(base[2].dimensions.referrer.rows[0].value,'search.test');
        const cohort=await saveCohort(p,ru,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Report qualification',query:new URLSearchParams({...common,timeZone:'Asia/Dubai',path:'/entry'}).toString()}});assert.ok(cohort.item);
        const filters:Record<string,string>={kind:'all',origin:dims.origin,referrer:'search.test',language:'en',browser:'chrome',os:'Windows 10',device:'desktop',campaignSource:'source-a',campaignMedium:'organic',campaignName:'MCP',country:serializeGeographyKey('country',{state:'known',country:'AE'})!,region:serializeGeographyKey('region',{state:'known',country:'AE',region:{kind:'name',value:'Dubai'}})!,city:serializeGeographyKey('city',{state:'known',country:'AE',region:{kind:'name',value:'Dubai'},city:'Dubai'})!,propertyKey:'plan',propertyType:'string',propertyValue:'"team"',predicates:JSON.stringify({version:1,match:'all',fields:[{field:'path',operator:'neq',value:'/never'}],properties:[]}),cohortId:cohort.item.id,cohortRevision:String(cohort.item.revision)};
        for(const spec of cases){const result=await equivalent(spec,p,{...spec.query,...filters},'full-filter-cohort');assert.equal(result.cohort.item.id,cohort.item.id);assert.equal(result.geographyProvenance.databaseCount,1);assert.equal(result.query.filters.city,filters.city);}
        reportEvidence.groups.push('three-reader-modern-legacy-native-direct-equivalence');console.log('PASS additive three-report complete native/direct/modern/legacy equivalence with typed filters and saved cohort');

        for(const spec of cases){
          const none=await equivalent(spec,empty,{...spec.query},'empty'),noIdentity=await equivalent(spec,unknown,{...spec.query},'unkeyed'),gone=await equivalent(spec,expired,{...spec.query},'expired');
          assert.equal(none.selection.status,'available');assert.equal(noIdentity.selection.status,'unavailable');assert.equal(gone.selection.status,'unavailable');
          if(spec.path==='journeys'){assert.deepEqual(none.paths,[]);assert.equal(none.measurement.matchingEvents,0);assert.equal(noIdentity.measurement.matchingEvents,1);assert.equal(noIdentity.paths,null);assert.equal(gone.measurement.matchingEvents,null);}
          else if(spec.path==='retention-report'){assert.equal(none.identity.entryEvents,0);assert.equal(none.identity.observedKeys,0);assert.equal(noIdentity.identity.entryEvents,1);assert.equal(noIdentity.identity.observedKeys,null);assert.equal(gone.identity.entryEvents,null);}
          else{assert.equal(none.measurement.conversionEvents,0);assert.equal(noIdentity.measurement.conversionEvents,1);assert.equal(noIdentity.measurement.convertedObservedKeys,null);assert.equal(gone.measurement.conversionEvents,null);}
        }
        const dst=await equivalent(cases[0],calendarProject,{from:'2024-03-10',to:'2024-03-10',timeZone:'America/New_York',steps:'2'},'dst');assert.equal(dst.range.start,'2024-03-10T05:00:00.000Z');assert.equal(dst.range.end,'2024-03-11T04:00:00.000Z');assert.equal(dst.measurement.matchingEvents,2);
        const leap=await equivalent(cases[1],empty,{month:'2024-02',timeZone:'UTC'},'leap');assert.equal(leap.rows.length,29);
        const skip=await equivalent(cases[1],empty,{month:'2011-12',timeZone:'Pacific/Apia'},'skipped');assert.equal(skip.rows[29].skipped,true);assert.equal(skip.rows[29].cohortKeys,null);
        for(const spec of cases){const result=await call(spec.name,{projectId:p,query:{...spec.query,cohortId:cohort.item.id,cohortRevision:'2'}},reportKey.token);assert.equal(result.status,200);assert.equal(result.wire.result.structuredContent.error.status,409);}
        assert.equal((await call(cases[0].name,{projectId:p,query:{...common,startKind:'pageview'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        assert.equal((await call(cases[2].name,{projectId:p,query:{...common,conversionKind:'custom',conversionValue:'bad name'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        assert.equal((await call(cases[1].name,{projectId:p,query:{month:'1969-12',timeZone:'UTC'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        for(const spec of cases)assert.equal((await call(spec.name,{projectId:p,query:{...spec.query,cursor:'forbidden'}},reportKey.token)).status,400);
        reportEvidence.groups.push('calendar-unknown-retention-strict-input');console.log('PASS additive calendar/DST/leap/skipped dates, empty versus unknown versus expired and closed native input');

        assert.equal((await rpc('tools/list',{},reportKey.token)).wire.result.tools.length,9);
        assert.deepEqual((await rpc('tools/list',{},limitedKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami']);
        const reportActor=async(role='admin')=>{const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Report actor\',$2)',[userId,userId+'@mcp-report.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'admin')",[rw,userId]);const value=await makeKey(userId);if(role!=='admin')await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[rw,userId,role]);return{userId,...value};};
        for(const role of ['admin','editor','viewer']){const key=await reportActor(role);for(const spec of cases){const result=data(await call(spec.name,{projectId:p,query:spec.query},key.token));assert.equal(result.projectId,p);if(spec.path==='retention-report')assert.equal(result.role,role);}assert.equal((await rpc('tools/list',{},key.token)).wire.result.tools.length,9);}
        for(const spec of cases){const denied=await call(spec.name,{projectId:p,query:spec.query},limitedKey.token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);const foreign=await call(spec.name,{projectId:foreignProject,query:spec.query},reportKey.token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
        // These direct fixture authority updates intentionally bypass workspace SHARE serialization;
        // they test the final publication gate, not an application member-mutation race.
        for(const spec of cases)for(const action of ['expiry','revocation','scope','removal']as const){
          const key=await reportActor(),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
          try{
            await lock.query('BEGIN');await lock.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');const blocker=(await lock.query('SELECT pg_backend_pid()AS pid')).rows[0].pid;
            pending=call(spec.name,{projectId:p,query:spec.query},key.token);void pending.catch(()=>{});
            const until=Date.now()+2000;let observed:any=null;
            while(Date.now()<until){await lock.query('SELECT pg_stat_clear_snapshot()');const candidate=(await lock.query("SELECT pid,wait_event_type,pg_blocking_pids(pid)AS blockers FROM pg_stat_activity WHERE datname=current_database()AND pid<>pg_backend_pid()AND query LIKE 'WITH RECURSIVE target AS MATERIALIZED%'AND wait_event_type='Lock'AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rows[0];if(candidate){observed=candidate;break;}await new Promise(r=>setTimeout(r,2));}
            assert.ok(observed,'Actual report SQL must wait on this exact blocker; native 250ms Retention bound remains unchanged.');
            if(action==='expiry')await pool.query("UPDATE api_key SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[key.key.id]);
            if(action==='revocation')await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);
            if(action==='scope')await pool.query("UPDATE api_key SET scopes=ARRAY['events:write']::text[]WHERE id=$1",[key.key.id]);
            if(action==='removal')await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[rw,key.userId]);
            await lock.query('COMMIT');const result=await pending;assert.equal(result.status,action==='scope'?403:401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
            reportEvidence.waits.push({tool:spec.name,action,blocker,reader:observed.pid,waitEvent:observed.wait_event_type,blockers:observed.blockers,status:result.status});persist();
          }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
        }
        reportEvidence.groups.push('discovery-roles-tenant-scopes-twelve-waits');console.log('PASS additive scoped discovery, all read roles, foreign tenancy and twelve observed report authority waits');

        await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2024-03-10','2024-03-10')",[wide,a]);
        await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,source)SELECT gen_random_uuid(),$1,'page_view','/'||repeat(chr(1),2030)||lpad(v::text,4,'0')||lpad(s::text,2,'0'),'2024-03-10T12:00:00Z'::timestamptz+s*interval '1 second',$2,md5(v::text)||md5(v::text),'browser'FROM generate_series(1,100)v CROSS JOIN generate_series(1,7)s",[wide,a]);
        const largeQuery={from:'2024-03-10',to:'2024-03-10',timeZone:'UTC',steps:'7'},large=await projectJourneys(wide,{kind:'api-key',token:reportKey.token},new URLSearchParams(largeQuery));assert.equal(large.paths!.length,100);assert.ok(Buffer.byteLength(JSON.stringify(large))>8*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(large))<12*1024*1024);
        for(const modern of [true,false]){const result=await call(cases[0].name,{projectId:wide,query:largeQuery},reportKey.token,modern);assert.equal(result.status,200);assert.equal(result.wire.result.isError,true);assert.equal(result.wire.result.structuredContent.error.status,503);assert.equal(result.wire.result.structuredContent.paths,undefined);assert.ok(result.bytes<4096);}
        const rateKey=await reportActor();for(const spec of cases){const prefix=spec.path==='retention-report'?'retention-report':spec.path;await pool.query("INSERT INTO request_limit(key,minute,count)VALUES($1,floor(extract(epoch FROM now())/60),30)ON CONFLICT(key,minute)DO UPDATE SET count=30",[prefix+':'+rateKey.userId]);const denied=await call(spec.name,{projectId:p,query:spec.query},rateKey.token);assert.equal(denied.wire.result.structuredContent.error.status,429);const native=await http('/api/projects/'+p+'/'+spec.path+'?'+new URLSearchParams(spec.query),{authorization:'Bearer '+rateKey.token});assert.equal(native.status,429);}
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);
        reportEvidence.large={nativeBytes:Buffer.byteLength(JSON.stringify(large)),nativePaths:large.paths!.length,mcp:'whole-error-no-prefix'};
        reportEvidence.groups.push('whole-result-cap-shared-native-rates-zero-provider');console.log('PASS additive complete MCP envelope refuses large native report, shared native rate keys and zero provider work');reportEvidence.phase='passed';
      }catch(error){reportEvidence.phase='failed';reportEvidence.failure={name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message.slice(0,2000):'Unknown failure'};throw error;}
      finally{
        try{await pool.query('UPDATE api_key SET revoked_at=COALESCE(revoked_at,clock_timestamp())WHERE id=ANY($1::uuid[])',[keys]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM api_key WHERE id=ANY($1::uuid[])AND revoked_at IS NULL',[keys])).rows[0].n,0);reportEvidence.cleanup.push('all additive keys revoked');
          for(const table of tables){const current=new Set(await rows(table));for(const row of originalRows[table])assert.ok(current.has(row),'Original '+table+' row changed.');}
          reportEvidence.originalRows={sha256:originalHash,count:Object.values(originalRows).reduce((n,r)=>n+r.length,0),unchanged:true};
        }catch(error){reportEvidence.phase='failed';reportEvidence.cleanup.push({failure:error instanceof Error?error.message:'Unknown cleanup failure'});throw error;}finally{persist();}
      }
    }

    await pool.query("INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),120) ON CONFLICT(key,minute) DO UPDATE SET count=120",['api-key:'+all.key.id]);assert.equal((await rpc('tools/list')).status,429);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS shared rate budget and zero provider/probe work or idle transactions');
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
if(process.env.TEN98_MCP_TEST==='1')runMcpChecks().catch(error=>{console.error('FAIL MCP integration',error instanceof Error?{name:error.name,message:error.message}:{name:'UnknownError'});process.exitCode=1;}).finally(closeDatabase);
