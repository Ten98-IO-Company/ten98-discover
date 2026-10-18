import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {Resolver} from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema} from '../src/server/db.ts';
import {getBoss,stopJobs,startWorker} from '../src/server/jobs.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {addDomain,issueDomainChallenge,verifyDomain,revokeDomain,updateDomain,removeDomain} from '../src/server/domains.ts';
import {getDomainRedirectChecks,startDomainRedirectCheck,executeDomainRedirectCheck,reconcileDomainRedirectChecks,expireDomainRedirectEvidence} from '../src/server/domain-redirects.ts';
import {runRetentionBatch,previewRetention,getRetention} from '../src/server/retention.ts';
import type {RedirectTransport} from '../src/server/domain-redirect-network.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
export async function runDomainRedirectChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  const config=getConfig();assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));await assertSchema();
  const pool=getDatabase().pool,owner=randomUUID(),admin=randomUUID(),viewer=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),foreignProject=randomUUID();
  const email=`${owner}@redirect.integration.test`,password=randomBytes(32).toString('base64url');
  for(const [id,name] of [[owner,'Owner'],[admin,'Admin'],[viewer,'Viewer']])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,`${id}@redirect.integration.test`]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
  for(const id of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Redirect fixtures')",[id]);
  for(const [user,role] of [[owner,'owner'],[admin,'admin'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,owner]);
  for(const [id,wid] of [[project,workspace],[foreignProject,foreignWorkspace]])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Redirect fixtures','https://canonical.example.com',$3,'infinity')",[id,wid,randomUUID()]);
  let requests=0;
  const transport:RedirectTransport={resolve:async()=>[{address:'1.1.1.1',family:4}],request:async url=>{requests++;return url.hostname==='canonical.example.com'?{status:200,location:null}:{status:301,location:'https://canonical.example.com/final?must_not_store=secret#private'};}};
  async function alias(pid=project){
    const hostname=`a-${randomUUID()}.example.com`,state=await addDomain(pid,owner,{hostname,role:'redirect_alias'}),row=state.domains.find(d=>d.hostname===hostname)!;
    const proof=await issueDomainChallenge(pid,owner,row.id,{});await verifyDomain(pid,owner,row.id,{},async()=>[[proof.challenge.value]]);return row.id;
  }
  const start=async(id:string,user=owner,requestId=randomUUID(),pid=project)=>(await startDomainRedirectCheck(pid,user,id,{requestId})).check;
  const read=async(id:string,pid=project)=>getDomainRedirectChecks(pid,owner,id);
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External fetch forbidden in synthetic redirect checks.');};
  try{
    const id=await alias(),requestId=randomUUID();
    await assert.rejects(start(id,viewer),{status:404});await assert.rejects(start(id,owner,randomUUID(),foreignProject),{status:404});
    await assert.rejects(startDomainRedirectCheck(project,owner,id,{requestId,url:'http://127.0.0.1'}),{status:400});
    const [first,retry]=await Promise.all([start(id,owner,requestId),start(id,owner,requestId)]);assert.equal(first.id,retry.id);
    assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[first.id])).rowCount,1);
    await assert.rejects(start(id),{status:409});
    await Promise.all([executeDomainRedirectCheck(first.id,transport),executeDomainRedirectCheck(first.id,transport)]);
    assert.equal(requests,2);let checked=(await read(id)).checks[0];assert.equal(checked.status,'completed');assert.equal(checked.currentConfiguration,true);assert.equal(checked.observation.targetMatches,true);
    assert.ok(!JSON.stringify(checked).includes('must_not_store'));assert.ok(!JSON.stringify(checked).includes('secret'));assert.ok(!JSON.stringify(checked).includes('#private'));
    await executeDomainRedirectCheck(first.id,transport);assert.equal(requests,2);assert.equal((await start(id,owner,requestId)).id,first.id);await assert.rejects(start(id),{status:409});
    await pool.query("UPDATE domain_redirect_check SET created_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[first.id]);
    const next=await start(id);assert.notEqual(next.id,first.id);await executeDomainRedirectCheck(next.id,transport);
    const another=await alias();await assert.rejects(start(another,owner,requestId),{status:409});
    console.log('PASS exact tenant/role/input boundaries, immutable proof snapshot, idempotency, one active job and five-minute cooldown');

    const rollbackAlias=await alias(),boss=await getBoss(),send=boss.send.bind(boss);let queueId:string|undefined;
    boss.send=(async(...args:Parameters<typeof boss.send>)=>{const result=await (send as any)(...args);queueId=result??undefined;throw new Error('Synthetic failure after queue insertion');}) as unknown as typeof boss.send;
    try{await assert.rejects(start(rollbackAlias));}finally{boss.send=send;}
    assert.ok(queueId);assert.equal((await pool.query('SELECT 1 FROM pgboss.job WHERE id=$1',[queueId])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM domain_redirect_check WHERE domain_id=$1',[rollbackAlias])).rowCount,0);
    console.log('PASS actual queue insert and application receipt roll back atomically');

    for(const change of ['revoke','proof','target','role','remove','membership'] as const){
      const item=await alias(),run=await start(item,admin);const before:number=requests;
      if(change==='revoke')await revokeDomain(project,owner,item,{});
      if(change==='proof')await issueDomainChallenge(project,owner,item,{});
      if(change==='target'){await updateDomain(project,owner,item,{role:'redirect_alias',expectedTargetHost:'other.example.com'});await updateDomain(project,owner,item,{role:'redirect_alias',expectedTargetHost:'canonical.example.com'});}
      if(change==='role')await updateDomain(project,owner,item,{role:'serving'});
      if(change==='remove')await removeDomain(project,owner,item,{});
      if(change==='membership')await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);
      await executeDomainRedirectCheck(run.id,transport);assert.equal(requests,before);assert.equal((await pool.query('SELECT status FROM domain_redirect_check WHERE id=$1',[run.id])).rows[0].status,'stale');
      if(change==='membership')await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace,admin]);
    }
    const during=await alias(),duringRun=await start(during),entered=deferred(),release=deferred();
    const work=executeDomainRedirectCheck(duringRun.id,{...transport,resolve:async()=>{entered.resolve();await release.promise;return [{address:'1.1.1.1',family:4}];}});
    await entered.promise;await revokeDomain(project,owner,during,{});release.resolve();await work;
    checked=(await read(during)).checks[0];assert.equal(checked.status,'stale');assert.equal(checked.observation,null);assert.equal(checked.currentConfiguration,false);
    console.log('PASS queued authority/proof/configuration invalidation and held-network publication revocation');

    const interrupted=await alias(),interruptedRun=await start(interrupted),paused=deferred(),resume=deferred();
    const late=executeDomainRedirectCheck(interruptedRun.id,{...transport,resolve:async()=>{paused.resolve();await resume.promise;return [{address:'1.1.1.1',family:4}];}});
    await paused.promise;await pool.query("UPDATE domain_redirect_check SET started_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[interruptedRun.id]);await reconcileDomainRedirectChecks();resume.resolve();await late;
    assert.equal((await read(interrupted)).checks[0].status,'failed');assert.equal((await read(interrupted)).checks[0].observation,null);
    for(const queueState of ['failed','cancelled','completed','deleted'] as const){
      const item=await alias(),run=await start(item);
      if(queueState==='deleted')await pool.query('DELETE FROM pgboss.job WHERE id=$1',[run.id]);else await pool.query('UPDATE pgboss.job SET state=$2 WHERE id=$1',[run.id,queueState]);
      await reconcileDomainRedirectChecks();assert.equal((await read(item)).checks[0].status,'failed');
    }
    console.log('PASS missing/terminal queue failure and stale worker results cannot manufacture or resurrect an observation');

    const cutoff=new Date('2026-01-01T00:00:00Z'),client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[project]);
      await client.query('UPDATE domain_redirect_check SET completed_at=$2 WHERE id=$1',[next.id,cutoff]);
      await expireDomainRedirectEvidence(client,project,cutoff);assert.ok((await client.query('SELECT observation FROM domain_redirect_check WHERE id=$1',[next.id])).rows[0].observation);
      await expireDomainRedirectEvidence(client,project,new Date(cutoff.getTime()+1));assert.equal((await client.query('SELECT observation FROM domain_redirect_check WHERE id=$1',[next.id])).rows[0].observation,null);
      await client.query('ROLLBACK');assert.ok((await read(id)).checks.find(c=>c.id===next.id)!.observation);
    }finally{client.release();}
    const foreign=await alias(foreignProject),foreignRun=await start(foreign,owner,randomUUID(),foreignProject);await executeDomainRedirectCheck(foreignRun.id,transport);
    await pool.query("UPDATE domain_redirect_check SET completed_at=clock_timestamp()-interval '91 days' WHERE id=ANY($1::uuid[])",[[first.id,next.id,foreignRun.id]]);
    const policy=await getRetention(workspace,owner),preview=await previewRetention(workspace,owner,{revision:policy.revision,settings:policy.settings});assert.equal(preview.redirectEstimate.checks,2);
    const receipt=(await pool.query('SELECT id,request_id,domain_revision,hostname,expected_target_host,status FROM domain_redirect_check WHERE id=$1',[next.id])).rows[0];
    assert.equal((await runRetentionBatch(project))?.expiredDomainRedirects,2);
    checked=(await read(id)).checks.find(c=>c.id===next.id)!;assert.equal(checked.observation,null);assert.equal(checked.evidenceExpired,true);assert.deepEqual((await pool.query('SELECT id,request_id,domain_revision,hostname,expected_target_host,status FROM domain_redirect_check WHERE id=$1',[next.id])).rows[0],receipt);assert.ok((await read(foreign,foreignProject)).checks[0].observation);
    assert.equal((await start(id,owner,requestId)).id,first.id);
    console.log('PASS raw-evidence cutoff, exact boundary, rollback, workspace isolation, expired receipt and request replay');

    const workerAlias=await alias(),workerRun=await start(workerAlias);let nativeRequests=0;
    const mocks=[
      mock.method(Resolver.prototype,'resolve4',(async()=>['1.1.1.1']) as any),
      mock.method(Resolver.prototype,'resolve6',(async()=>{throw Object.assign(new Error('No synthetic IPv6'),{code:'ENODATA'});}) as any),
      mock.method(http,'request',(()=>{throw new Error('Unexpected HTTP request forbidden.');}) as any),
      mock.method(https,'request',((url:URL,_options:unknown,callback:(response:unknown)=>void)=>{
        nativeRequests++;assert.ok(url.hostname.endsWith('.example.com'));
        const request=new EventEmitter() as EventEmitter&{end:()=>void};
        request.end=()=>queueMicrotask(()=>callback({statusCode:url.hostname==='canonical.example.com'?200:301,
          rawHeaders:url.hostname==='canonical.example.com'?[]:['Location','https://canonical.example.com/'],destroy:()=>{}}));return request;
      }) as any),
    ];
    try{
      assert.equal((await pool.query('SELECT retry_limit FROM pgboss.job WHERE id=$1',[workerRun.id])).rows[0].retry_limit,0);
      await pool.query('UPDATE pgboss.job SET priority=100 WHERE id=$1',[workerRun.id]);await startWorker();
      const deadline=Date.now()+15000;while((await read(workerAlias)).checks[0].status!=='completed'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal((await read(workerAlias)).checks[0].status,'completed');assert.equal(nativeRequests,2);
    }finally{await stopJobs();for(const item of mocks)item.mock.restore();}
    console.log('PASS actual durable worker executes one synthetic headers-only redirect chain with retries disabled');

    const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email,password})}));assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),endpoint=`${config.appUrl}/api/projects/${project}/domains/${id}/redirect-checks`;
    assert.equal((await handleApi(new Request(endpoint))).status,401);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,200);
    assert.equal((await handleApi(new Request(endpoint+'?url=http://127.0.0.1',{headers:{cookie}}))).status,400);
    assert.equal((await handleApi(new Request(endpoint,{method:'POST',headers:{cookie,origin:'https://foreign.example.com','content-type':'application/json'},body:JSON.stringify({requestId:randomUUID()})}))).status,403);
    const token=await createApiKey(workspace,owner,{name:'No redirect scope',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token.token}}))).status,403);
    // domains:read admits only the receipt read: equal to the direct and cookie reads, no start, bounded by the 5 s content gate.
    const reader=await createApiKey(workspace,owner,{name:'Redirect receipt reader',scopes:['domains:read']}),keyed=(url:string,init:RequestInit={})=>handleApi(new Request(url,{...init,headers:{authorization:'Bearer '+reader.token,...init.headers as Record<string,string>}}));
    const keyedRead=await keyed(endpoint);assert.equal(keyedRead.status,200);const keyedBody=await keyedRead.json();
    assert.deepEqual(keyedBody,JSON.parse(JSON.stringify(await getDomainRedirectChecks(project,owner,id,reader.token))));
    assert.deepEqual(keyedBody,await (await handleApi(new Request(endpoint,{headers:{cookie}}))).json());assert.ok(keyedBody.checks.length>0);
    const receipts=(await pool.query('SELECT count(*)::int AS n FROM domain_redirect_check WHERE domain_id=$1',[id])).rows[0].n;
    assert.equal((await keyed(endpoint,{method:'POST',headers:{'content-type':'application/json',origin:config.appUrl},body:JSON.stringify({requestId:randomUUID()})})).status,403);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM domain_redirect_check WHERE domain_id=$1',[id])).rows[0].n,receipts,'A key starts no redirect check.');
    assert.equal((await keyed(endpoint+'?url=http://127.0.0.1')).status,400);
    assert.equal((await keyed(`${config.appUrl}/api/projects/${foreignProject}/domains/${id}/redirect-checks`)).status,404,'A project of another workspace is not reachable.');
    const holder=await pool.connect();
    try{
      await holder.query('BEGIN');await holder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
      const started=Date.now(),busy=await keyed(endpoint);assert.equal(busy.status,503,'A bearer read waits at most the 5 s lock bound, then answers 503.');assert.deepEqual(Object.keys(await busy.json()),['error']);assert.ok(Date.now()-started>=4500);
    }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
    assert.equal((await keyed(endpoint)).status,200,'The read succeeds once the workspace lock is released.');
    console.log('PASS domains:read redirect receipts equal the direct and cookie reads, no start under a key, strict query, foreign 404 and a 503 after the bounded workspace wait');
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);
    console.log('PASS cookie/Origin/bearer/current-membership API gates; no external transport calls');
  }finally{globalThis.fetch=originalFetch;await stopJobs();}
}
if(import.meta.main){try{await runDomainRedirectChecks();}finally{await closeDatabase();}}
