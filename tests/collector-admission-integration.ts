import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {collectorLimits,handleApi} from '../src/server/api.ts';
import {clientLimitKey} from '../src/server/client-rate-limit.ts';

export type MakeRequest=(path:string,init?:RequestInit)=>Request;
// Runs the work with Requests carrying a real loopback Node transport, as srvx supplies it. `via(address)` adds a forwarded
// client address, which counts only while loopback is a configured trusted proxy.
export async function withTransport<T>(appUrl:string,work:(peer:MakeRequest,via:(address:string)=>MakeRequest)=>Promise<T>):Promise<T>{
  let outcome:{value:T}|{error:unknown}|undefined;
  const server=createServer((req,res)=>{
    const make=(forwardedFor?:string):MakeRequest=>(path,init={})=>{const headers=new Headers(init.headers);if(forwardedFor)headers.set('x-forwarded-for',forwardedFor);return Object.assign(new Request(new URL(path,appUrl),{...init,headers}),{runtime:{name:'node',node:{req}}});};
    work(make(),make).then(value=>{outcome={value};},error=>{outcome={error};}).finally(()=>res.end('ok'));
  });
  await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  try{await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).text();}
  finally{server.closeAllConnections();await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
  assert.ok(outcome,'The transport request did not complete.');
  if('error' in outcome)throw outcome.error;
  return outcome.value;
}

export const networkSettings=['TRUSTED_PROXIES','ANALYTICS_TRUSTED_PROXIES','ANALYTICS_NETWORK_MODE','ANALYTICS_EXCLUDED_IPS'] as const;
export function useNetwork(values:Partial<Record<typeof networkSettings[number],string>>){for(const key of networkSettings){if(values[key]===undefined)delete process.env[key];else process.env[key]=values[key];}}

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// Collection admission counts per client (only where an address identifies one visitor), then per site by internal project id,
// then the shared ceiling; refused requests stop early.
export async function runCollectorAdmissionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();
  for(const url of [config.appUrl,config.databaseUrl])assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const {pool}=getDatabase(),workspace=randomUUID(),secret=process.env.AUTH_SECRET!;
  const site=()=>({project:randomUUID(),siteKey:randomUUID(),origin:`https://collector-${randomUUID().slice(0,8)}.integration.test`});
  const first=site(),second=site(),{project,siteKey,origin}=first;
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Collector admission fixture')",[workspace]);
  for(const fixture of [first,second])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Collector admission fixture',$3,$4,'infinity')",[fixture.project,workspace,fixture.origin,fixture.siteKey]);
  const unknownClient='collector:client:unresolved',loopbackClient=clientLimitKey('collector','127.0.0.1',secret);
  const clientA=clientLimitKey('collector','198.51.100.7',secret),clientB=clientLimitKey('collector','198.51.100.8',secret);
  const siteKeys=['collector','heatmap','replay','tracking-config'].map(scope=>`${scope}:${project}`),fixtureKeys=[...siteKeys,`collector:${second.project}`,clientA,clientB];
  // Seed the current and next minute so a minute boundary cannot flake the comparison.
  const seed=(key:string,count:number)=>pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,$2 FROM generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=$2",[key,count]);
  const total=async(key:string)=>Number((await pool.query('SELECT COALESCE(sum(count),0)::int AS total FROM request_limit WHERE key=$1 AND minute>=floor(extract(epoch FROM now())/60)-1',[key])).rows[0].total);
  const snapshot=async()=>new Map((await pool.query<{key:string;total:number}>('SELECT key,sum(count)::int AS total FROM request_limit GROUP BY key')).rows.map(row=>[row.key,row.total]));
  const plain:MakeRequest=(p,init)=>new Request(config.appUrl+p,init);
  const post=(path:string,body:unknown,from:MakeRequest=plain,fromOrigin=origin)=>handleApi(from(path,{method:'POST',headers:{origin:fromOrigin,'content-type':'application/json'},body:JSON.stringify(body)}));
  const pageView=(key:string,at=origin)=>({siteKey:key,eventId:randomUUID(),name:'page_view',url:at+'/'});
  const consent={analytics:true,epoch:randomUUID()};
  const bodies:[string,(key:string)=>unknown,number][]=[
    ['/api/collect',key=>pageView(key),403],
    ['/api/replay/begin',key=>({siteKey:key,requestId:randomUUID(),url:origin+'/page',consent:{...consent,replay:true}}),403],
    ['/api/heatmaps/begin',key=>({siteKey:key,requestId:randomUUID(),url:origin+'/page',consent}),403],
    ['/api/tracking-config',key=>({siteKey:key,environment:'live'}),404],
  ];
  const savedNetwork=Object.fromEntries(networkSettings.map(key=>[key,process.env[key]]));
  // Shared keys (the unknown client, the loopback client, the global ceiling) carry counts from earlier suite stages, so every
  // assertion on them is a before/after delta. Only this fixture's own keys are compared as absolute values.
  try{
    useNetwork({ANALYTICS_NETWORK_MODE:'off'});
    const unconfigured=`https://unconfigured-${randomUUID().slice(0,8)}.example.com`;
    const globalBefore=await total('collector:global'),unknownBefore=await total(unknownClient);
    const options=await handleApi(new Request(config.appUrl+'/api/collect',{method:'OPTIONS',headers:{origin:unconfigured}}));
    assert.equal(options.status,403);
    const refusedOrigin=await handleApi(new Request(config.appUrl+'/api/collect',{method:'POST',headers:{origin:unconfigured,'content-type':'application/json'},body:JSON.stringify({siteKey:randomUUID(),eventId:randomUUID(),name:'pageview',url:unconfigured+'/'})}));
    assert.equal(refusedOrigin.status,403);
    assert.equal(await total('collector:global'),globalBefore,'Requests from an unconfigured origin counted toward the shared collection budget.');
    assert.equal(await total(unknownClient),unknownBefore,'Requests from an unconfigured origin counted toward a client limit.');

    // No trusted proxy and no direct mode: the peer may be a reverse proxy standing for every visitor, so no per-client key is
    // consulted. The shared peer keys are seeded past their limit (as if this peer had already sent more than the per-client
    // value), and both sites still admit traffic from that one peer.
    await seed(loopbackClient,collectorLimits.client+1);await seed(unknownClient,collectorLimits.client+1);
    const sharedBefore=await snapshot();
    const statuses=await withTransport(config.appUrl,async peer=>{
      const seen:number[]=[];
      for(const fixture of [first,second])for(const from of [peer,plain])for(let n=0;n<3;n++)seen.push((await post('/api/collect',pageView(fixture.siteKey,fixture.origin),from,fixture.origin)).status);
      return seen;
    });
    assert.deepEqual([...new Set(statuses)],[202],'Without a trusted proxy, one shared peer is never limited by a per-client key.');
    const sharedAfter=await snapshot();
    for(const key of [loopbackClient,unknownClient])assert.equal(sharedAfter.get(key),sharedBefore.get(key),`${key} was counted without a trusted proxy.`);
    assert.equal(await total(`collector:${project}`),6);
    assert.equal(await total(`collector:${second.project}`),6);
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[[loopbackClient,unknownClient,...siteKeys]]);

    // A trusted gateway: per-client limits apply to the forwarded client. One client at its limit is refused before its site and
    // the shared ceiling are counted; another client is still admitted; an unresolved client gets no shared key.
    useNetwork({ANALYTICS_NETWORK_MODE:'off',TRUSTED_PROXIES:'127.0.0.1'});
    await seed(clientA,collectorLimits.client);
    const trusted=await withTransport(config.appUrl,async(_peer,via)=>{
      const read=async()=>({unknown:await total(unknownClient),b:await total(clientB),global:await total('collector:global'),site:await total(`collector:${project}`)});
      const start=await read();
      const limited=(await post('/api/collect',pageView(siteKey),via('203.0.113.66, 198.51.100.7'))).status;
      const afterLimited=await read();
      const admitted=(await post('/api/collect',pageView(siteKey),via('198.51.100.8'))).status;
      const afterAdmitted=await read();
      const unresolved=(await post('/api/collect',pageView(siteKey),plain)).status;
      return {start,limited,afterLimited,admitted,afterAdmitted,unresolved,afterUnresolved:await read()};
    });
    assert.equal(trusted.limited,429,'A client at its limit is refused, whatever left-most address it supplies.');
    assert.deepEqual(trusted.afterLimited,trusted.start,'A client over its own limit counted toward the site or shared limits.');
    assert.equal(trusted.admitted,202,'A second client is admitted while the first is limited.');
    assert.deepEqual({b:trusted.afterAdmitted.b-trusted.start.b,global:trusted.afterAdmitted.global-trusted.start.global,site:trusted.afterAdmitted.site},{b:1,global:1,site:1},'The admitted request counts once per client, site and ceiling.');
    assert.equal(trusted.unresolved,202,'An unresolved client relies on the site and shared limits.');
    assert.deepEqual({site:trusted.afterUnresolved.site,unknown:trusted.afterUnresolved.unknown},{site:2,unknown:trusted.afterAdmitted.unknown},'An unresolved client was given a shared key.');

    // The other collection routes key their site limit by the internal project id, never the public site key.
    await withTransport(config.appUrl,async(_peer,via)=>{for(const [path,body] of bodies.slice(1))assert.ok(![400,429].includes((await post(path,body(siteKey),via('198.51.100.8'))).status),`${path} admits a valid site request.`);});
    for(const key of siteKeys.slice(1))assert.equal(await total(key),1,`${key} counts one admitted request.`);
    assert.equal((await pool.query('SELECT 1 FROM request_limit WHERE position($1::text IN key)>0',[siteKey])).rowCount,0,'No limit key contains the public site key.');

    // Unknown site keys are refused before any site or shared limit, so they create no limit rows of their own.
    const before=await snapshot(),random:string[]=[];
    await withTransport(config.appUrl,async(_peer,via)=>{for(const [path,body,status] of bodies){const key=randomUUID();random.push(key);assert.equal((await post(path,body(key),via('198.51.100.8'))).status,status,`${path} refuses an unknown site key.`);}});
    const after=await snapshot();
    for(const key of random)assert.equal((await pool.query('SELECT 1 FROM request_limit WHERE position($1::text IN key)>0',[key])).rowCount,0,'An unknown site key created a limit row.');
    const collectionChanges=[...after].filter(([key,count])=>before.get(key)!==count&&/^(collector|heatmap|replay|tracking-config):/.test(key)).map(([key])=>key);
    assert.deepEqual(collectionChanges,[clientB],'Only the client limit counts requests for unknown site keys.');
    assert.equal(after.get(clientB)!-(before.get(clientB)??0),bodies.length);
  }finally{
    useNetwork(savedNetwork);
    // Removing rows only lowers counts; seeded shared keys are cleared so a failed run cannot leave them at their limit.
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])',[[...fixtureKeys,unknownClient,loopbackClient]]);
  }
  return {groups:['unconfigured collection origins leave the shared collection budget untouched','without a trusted proxy one shared peer is limited only per site and globally across two sites','behind a trusted gateway a limited client leaves the site and shared limits untouched, a spoofed left-most address cannot choose the key, and another client is admitted','site limits use the internal project id and unknown site keys create no limit rows']};
}
if(process.env.TEN98_INTEGRATION_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{console.log(await runCollectorAdmissionChecks());}finally{await closeDatabase();}
