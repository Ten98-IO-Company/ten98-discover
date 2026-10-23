import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {collectorLimits,handleApi} from '../src/server/api.ts';
import {clientRateKey} from '../src/server/client-rate-limit.ts';

// Runs the work with Requests carrying a real loopback Node transport, as srvx supplies it, so they resolve to a known client.
// The forwarded address is used only when the installation trusts loopback as its proxy; otherwise the loopback peer is the client.
async function withTransportClient<T>(appUrl:string,work:(request:(path:string,init?:RequestInit)=>Request)=>Promise<T>):Promise<T>{
  let outcome:{value:T}|{error:unknown}|undefined;
  const server=createServer((req,res)=>{
    const request=(path:string,init:RequestInit={})=>{const headers=new Headers(init.headers);headers.set('x-forwarded-for','198.51.100.7');return Object.assign(new Request(new URL(path,appUrl),{...init,headers}),{runtime:{name:'node',node:{req}}});};
    work(request).then(value=>{outcome={value};},error=>{outcome={error};}).finally(()=>res.end('ok'));
  });
  await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  try{await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).text();}
  finally{server.closeAllConnections();await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
  assert.ok(outcome,'The transport request did not complete.');
  if('error' in outcome)throw outcome.error;
  return outcome.value;
}

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// Collection admission counts per client, then per site by internal project id, then the shared ceiling; refused requests stop early.
export async function runCollectorAdmissionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();
  for(const url of [config.appUrl,config.databaseUrl])assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const {pool}=getDatabase(),workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID(),origin=`https://collector-${randomUUID().slice(0,8)}.integration.test`;
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Collector admission fixture')",[workspace]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Collector admission fixture',$3,$4,'infinity')",[project,workspace,origin,siteKey]);
  // A plain Request has no transport peer, so it uses the conservative unknown-client key.
  const unknownClient='collector:client:unknown',siteKeys=['collector','heatmap','replay','tracking-config'].map(scope=>`${scope}:${project}`);
  const keys=['collector:global',unknownClient,...siteKeys];
  // Seed the current and next minute so a minute boundary cannot flake the comparison.
  const seed=(key:string,count:number)=>pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,$2 FROM generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=$2",[key,count]);
  const total=async(key:string)=>Number((await pool.query('SELECT COALESCE(sum(count),0)::int AS total FROM request_limit WHERE key=$1 AND minute>=floor(extract(epoch FROM now())/60)-1',[key])).rows[0].total);
  const snapshot=async()=>new Map((await pool.query<{key:string;total:number}>('SELECT key,sum(count)::int AS total FROM request_limit GROUP BY key')).rows.map(row=>[row.key,row.total]));
  const post=(path:string,body:unknown,from:(path:string,init?:RequestInit)=>Request=(p,init)=>new Request(config.appUrl+p,init))=>handleApi(from(path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
  const pageView=(key:string)=>({siteKey:key,eventId:randomUUID(),name:'page_view',url:origin+'/'});
  const consent={analytics:true,epoch:randomUUID()};
  const bodies:[string,(key:string)=>unknown,number][]=[
    ['/api/collect',pageView,403],
    ['/api/replay/begin',key=>({siteKey:key,requestId:randomUUID(),url:origin+'/page',consent:{...consent,replay:true}}),403],
    ['/api/heatmaps/begin',key=>({siteKey:key,requestId:randomUUID(),url:origin+'/page',consent}),403],
    ['/api/tracking-config',key=>({siteKey:key,environment:'live'}),404],
  ];
  let transportKey:string|undefined;
  try{
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[keys]);
    const globalBefore=await total('collector:global');
    const unconfigured=`https://unconfigured-${randomUUID().slice(0,8)}.example.com`;
    const options=await handleApi(new Request(config.appUrl+'/api/collect',{method:'OPTIONS',headers:{origin:unconfigured}}));
    assert.equal(options.status,403);
    const refusedOrigin=await handleApi(new Request(config.appUrl+'/api/collect',{method:'POST',headers:{origin:unconfigured,'content-type':'application/json'},body:JSON.stringify({siteKey:randomUUID(),eventId:randomUUID(),name:'pageview',url:unconfigured+'/'})}));
    assert.equal(refusedOrigin.status,403);
    assert.equal(await total('collector:global'),globalBefore,'Requests from an unconfigured origin counted toward the shared collection budget.');
    assert.equal(await total(unknownClient),0,'Requests from an unconfigured origin counted toward a client limit.');

    // One client at its limit is refused before its site and the shared ceiling are counted; another client is still admitted.
    await seed(unknownClient,collectorLimits.client);
    assert.equal((await post('/api/collect',pageView(siteKey))).status,429);
    assert.equal(await total('collector:global'),globalBefore,'A client over its own limit counted toward the shared collection budget.');
    assert.equal(await total(`collector:${project}`),0,'A client over its own limit counted toward the site limit.');
    const admitted=await withTransportClient(config.appUrl,async request=>{
      transportKey=clientRateKey(request('/api/collect'),'collector');
      return (await post('/api/collect',pageView(siteKey),request)).status;
    });
    assert.ok(transportKey&&transportKey!==unknownClient,'The transport request must resolve to a known client.');
    assert.equal(admitted,202,'A second client is admitted while the first is limited.');
    assert.equal(await total(transportKey),1);
    assert.equal(await total(`collector:${project}`),1,'The site limit is keyed by the internal project id.');
    assert.equal(await total('collector:global'),globalBefore+1);

    // The other collection routes key their site limit by the internal project id, never the public site key.
    await pool.query('DELETE FROM request_limit WHERE key=$1',[unknownClient]);
    for(const [path,body] of bodies.slice(1))assert.ok(![400,429].includes((await post(path,body(siteKey))).status),`${path} admits a valid site request.`);
    for(const key of siteKeys)assert.equal(await total(key),1,`${key} counts one admitted request.`);
    assert.equal((await pool.query('SELECT 1 FROM request_limit WHERE position($1::text IN key)>0',[siteKey])).rowCount,0,'No limit key contains the public site key.');

    // Unknown site keys are refused before any site or shared limit, so they create no limit rows of their own.
    await pool.query('DELETE FROM request_limit WHERE key=$1',[unknownClient]);
    const before=await snapshot(),random:string[]=[];
    for(const [path,body,status] of bodies){const key=randomUUID();random.push(key);assert.equal((await post(path,body(key))).status,status,`${path} refuses an unknown site key.`);}
    const after=await snapshot();
    for(const key of random)assert.equal((await pool.query('SELECT 1 FROM request_limit WHERE position($1::text IN key)>0',[key])).rowCount,0,'An unknown site key created a limit row.');
    const changed=[...after].filter(([key,count])=>before.get(key)!==count).map(([key])=>key);
    assert.deepEqual(changed,[unknownClient],'Only the client limit counts requests for unknown site keys.');
    assert.equal(after.get(unknownClient),bodies.length);
  }finally{await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[transportKey?[...keys,transportKey]:keys]);}
  return {groups:['unconfigured collection origins leave the shared collection budget untouched','a limited client leaves the site and shared limits untouched while another client is admitted','site limits use the internal project id and unknown site keys create no limit rows']};
}
if(process.env.TEN98_INTEGRATION_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{console.log(await runCollectorAdmissionChecks());}finally{await closeDatabase();}
