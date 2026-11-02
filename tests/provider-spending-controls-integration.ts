import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {claimInstallation} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {getConfig} from '../src/server/config.ts';
import {decryptCredentials} from '../src/server/credential-vault.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {listProviders,providerTransaction,revokeProvider,saveProviderRequestControls,saveProvider} from '../src/server/providers.ts';
import {cancelRequest,dispatchRequest,requestHash,reserveRequest,reserveRequestInTransaction,settleRequest} from '../src/server/provider-requests.ts';
import {createWorkspace} from '../src/server/teams.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
const gate=(error:unknown)=>fail(409)(error)&&(error as {code?:unknown}).code==='PROVIDER_REQUESTS_PAUSED';
function assertNoApiMoney(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const forbidden = new Set(['budget','estimateUsd','actualUsd','spentUsd','reservedUsd','uncertainUsd','estimateMicros','actualMicros','estimate_micros','actual_micros','cost','price','monthlyLimitUsd','maxSpendUsd','fundedCredits','chargeStatus']);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, 'Provider activity must expose requests without financial fields: ' + key);
    assertNoApiMoney(child);
  }
}

export async function runProviderSpendingControlsChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROVIDER_SPENDING_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_spending_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_spending_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,0,'Use a fresh empty owned fixture.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
  const originalFetch=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw new Error('External requests forbidden in spending-controls acceptance.');};
  try{
    const email=randomUUID()+'@spending.test',password=randomBytes(24).toString('base64url');
    await claimInstallation({name:'Spending fixture',email,password,workspaceName:'Spending fixture'});
    const owner=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id as string;
    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email,password})}));
    assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
    const ownedWorkspaces:string[]=[];
    const workspace=async()=>{const id=(await createWorkspace(owner,{name:'Provider request controls fixture'})).workspace.id;ownedWorkspaces.push(id);return id;};
    const credentials={apiKey:'synthetic-'+randomUUID()};
    const connect=async(wid:string)=>(await saveProvider(wid,owner,{name:'Synthetic connection',provider:'openrouter',credentials})).connection;
    const row=async(id:string)=>(await pool.query('SELECT * FROM provider_connection WHERE id=$1',[id])).rows[0];
    const requestCount=async(wid:string)=>(await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1',[wid])).rows[0].n;
    const request=(connectionId:string)=>({connectionId,requestKey:randomUUID(),operation:'fixture.request',inputHash:requestHash('synthetic input')});
    async function settle(wid:string,id:string,known:boolean,reference:string|null=null){const client=await pool.connect();try{await client.query('BEGIN');const result=await settleRequest(client,wid,id,{known,providerReference:reference});await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
    async function http(path:string,status:number,body:unknown,options:{cookie?:string;origin?:string;token?:string;method?:string;raw?:string}={}){
      const headers:Record<string,string>={origin:options.origin??config.appUrl,'content-type':'application/json'};
      if(options.token)headers.authorization='Bearer '+options.token;else if(options.cookie!==null)headers.cookie=options.cookie??cookie;
      const response=await handleApi(new Request(config.appUrl+path,{method:options.method??'POST',headers,...(options.method==='GET'?{}:{body:options.raw??JSON.stringify(body)})}));
      assert.equal(response.status,status,path);const text=await response.text();assert.ok(!text.includes(credentials.apiKey)&&!text.includes('encrypted_credentials')&&!text.includes('ciphertext'));const value=text?JSON.parse(text):{};assertNoApiMoney(value);return value;
    }
    // Manual control changes must pass the same native HTTP authorization and input guards.
    const wid=await workspace(),a=await connect(wid),b=await connect(wid),route=`/api/workspaces/${wid}/provider-requests/control`,edit={paused:true};
    await http(`/api/workspaces/${wid}/providers/${a.id}/limit`,404,{revision:a.revision,expectedMonthlyLimitUsd:'10',monthlyLimitUsd:'12.000001'});
    await http(route.replace('/provider-requests/control','/budget'),404,edit);
    await http(route,401,edit,{cookie:''});await http(route,403,edit,{origin:'https://foreign.spending.test'});await http(route,404,{}, {method:'GET'});
    for(const bad of [{paused:'no'},{paused:false,monthlyLimitUsd:'1'},{...edit,credentials:{}}])await http(route,400,bad);
    await http(route,413,{}, {raw:JSON.stringify({padding:'x'.repeat(40_000)})});
    const token=(await createApiKey(wid,owner,{name:'Read-only fixture',scopes:['analytics:read']})).token;await http(route,403,edit,{token});
    const passwordHash=await hashPassword(password);
    for(const role of ['admin','editor','viewer']){
      const id=randomUUID(),memberEmail=id+'@spending.test';await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,role,memberEmail]);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,passwordHash]);
      await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[wid,id,role]);
      const signed=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:memberEmail,password})}));assert.equal(signed.status,200);
      await http(route,404,edit,{cookie:signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')});
    }
    const foreign=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign spending fixture')",[foreign]);
    await http(`/api/workspaces/${foreign}/provider-requests/control`,404,edit);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_provider_control WHERE workspace_id=ANY($1::text[])',[[wid,foreign]])).rows[0].n,0,'Refused pause requests write no manual control row.');
    await http(`/api/workspaces/${wid}/providers`,400,{name:'Synthetic connection',provider:'openrouter',credentials,monthlyLimitUsd:'10'});
    await http(`/api/workspaces/${wid}/providers/${a.id}/update`,400,{name:'Synthetic connection',credentials,monthlyLimitUsd:'10'});
    await pool.query("UPDATE provider_connection SET check_status='ok',diagnostic='Synthetic check evidence',last_checked_at=clock_timestamp() WHERE id=$1",[a.id]);
    const before=await row(a.id);assert.equal(Object.hasOwn(before,'monthly_limit_micros'),false);
    assert.deepEqual(await http(route,200,{paused:true}),{ok:true});assert.equal((await listProviders(wid,owner)).requestControls.paused,true);
    assert.deepEqual(await http(route,200,{paused:false}),{ok:true});assert.equal((await listProviders(wid,owner)).requestControls.paused,false);
    assert.deepEqual(await row(a.id),before,'A pause toggle changes no connection column or encrypted byte.');
    assert.deepEqual(decryptCredentials(before.encrypted_credentials,{id:a.id,workspaceId:wid,provider:'openrouter',revision:a.revision}),credentials);
    console.log('PASS actual API owner/session/origin/key/body guards on the pause route, removed cap route and fields (D3), encrypted bytes and check evidence preserved');

    const keys=process.env.CREDENTIAL_KEYS,active=process.env.CREDENTIAL_ACTIVE_KEY;
    try{delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
      await saveProviderRequestControls(wid,owner,{paused:true});await assert.rejects(saveProviderRequestControls(wid,owner,{paused:false}),fail(503));
    }finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
    await saveProviderRequestControls(wid,owner,{paused:false});
    // Owner decision D3: a workspace without a manual control row is unpaused, so its first reservation needs no owner action.
    const fresh=await workspace(),freshConnection=await connect(fresh);
    assert.equal((await pool.query('SELECT 1 FROM workspace_provider_control WHERE workspace_id=$1',[fresh])).rowCount,0);
    const freshActivity=await listProviders(fresh,owner);assertNoApiMoney(freshActivity);assert.deepEqual(freshActivity.requestControls,{paused:false});assert.deepEqual(freshActivity.requests,[]);
    assert.equal((await reserveRequest(fresh,owner,request(freshConnection.id))).created,true,'A new workspace starts unpaused.');
    assert.equal((await pool.query('SELECT 1 FROM workspace_provider_control WHERE workspace_id=$1',[fresh])).rowCount,0,'Reserving writes no implicit manual control row.');
    // Distinct request identities commit independently on the same connection.
    const uncapped=[...await Promise.all([reserveRequest(wid,owner,request(a.id)),reserveRequest(wid,owner,request(a.id))]),await reserveRequest(wid,owner,request(a.id))];
    assert.ok(uncapped.every(saved=>saved.created));assert.equal(new Set(uncapped.map(saved=>saved.id)).size,3);assertNoApiMoney(await listProviders(wid,owner));
    for(const saved of uncapped)await cancelRequest(wid,owner,saved.id);
    const same=request(a.id);let enqueued=0;
    const twins=await Promise.all([reserveRequest(wid,owner,same,async()=>{enqueued++;}),reserveRequest(wid,owner,same,async()=>{enqueued++;})]);
    assert.deepEqual(twins.map(saved=>saved.created).sort(),[false,true]);assert.equal(twins[0].id,twins[1].id);assert.equal(enqueued,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1 AND request_key=$2',[wid,same.requestKey])).rows[0].n,1);
    await cancelRequest(wid,owner,twins[0].id);
    // Independent requests retain separate unknown receipts without blocking each other.
    const lost=()=>providerTransaction(wid,owner,['owner'],async client=>{const saved=await reserveRequestInTransaction(client,wid,owner,request(a.id));await client.query("UPDATE provider_request SET status='uncertain' WHERE id=$1",[saved.id]);return saved;});
    const race=await Promise.allSettled([lost(),lost()]);assert.equal(race.filter(v=>v.status==='fulfilled').length,2);assert.ok(race.every(v=>v.status==='fulfilled'),'An unrelated unknown outcome must not block another request.');
    await settle(wid,(race.find(v=>v.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value.id,true);
    console.log('PASS no-vault pause rule, unpaused new workspace, no connection cap (D3) and serialized idempotent reservations');

    const beforeRotation=await row(a.id);
    await http(`/api/workspaces/${wid}/providers/${a.id}/update`,400,{name:'Stale rotation',credentials:{apiKey:'different-synthetic'},monthlyLimitUsd:'10'});assert.deepEqual(await row(a.id),beforeRotation);
    const rotated=(await saveProvider(wid,owner,{name:'New credential',credentials},a.id)).connection;assert.equal(rotated.revision,2);assert.equal(rotated.name,'New credential');assert.equal(rotated.checkStatus,'untested');assert.equal(Object.hasOwn(rotated,'monthlyLimitUsd'),false);
    assert.deepEqual(decryptCredentials((await row(a.id)).encrypted_credentials,{id:a.id,workspaceId:wid,provider:'openrouter',revision:2}),credentials);
    const concurrent=await connect(wid),stale=await reserveRequest(wid,owner,request(concurrent.id));
    const rotations=await Promise.all(['First rotation','Second rotation'].map(name=>saveProvider(wid,owner,{name,credentials},concurrent.id)));
    assert.deepEqual(rotations.map(saved=>saved.connection.revision).sort(),[2,3]);const rotatedRow=await row(concurrent.id);assert.equal(rotatedRow.revision,3);
    assert.deepEqual(decryptCredentials(rotatedRow.encrypted_credentials,{id:concurrent.id,workspaceId:wid,provider:'openrouter',revision:3}),credentials);
    assert.throws(()=>decryptCredentials(rotatedRow.encrypted_credentials,{id:concurrent.id,workspaceId:wid,provider:'openrouter',revision:2}),fail(503));
    await assert.rejects(dispatchRequest(wid,owner,stale.id),(error:unknown)=>fail(409)(error)&&/Provider credentials changed/.test((error as Error).message));
    await revokeProvider(wid,owner,concurrent.id);await assert.rejects(reserveRequest(wid,owner,request(concurrent.id)),fail(404));await assert.rejects(saveProvider(wid,owner,{name:'Revoked rotation',credentials},concurrent.id),fail(404));
    console.log('PASS concurrent rotation preserves credential revision, authenticated encryption and revoked boundaries; removed cap field refused (D3)');

    const fixed=request(a.id);let enqueues=0;const reserved=await reserveRequest(wid,owner,fixed,async()=>{enqueues++;});
    await saveProviderRequestControls(wid,owner,{paused:true});assert.equal((await reserveRequest(wid,owner,fixed,async()=>{enqueues++;})).created,false);assert.equal(enqueues,1);
    await assert.rejects(reserveRequest(wid,owner,{...fixed,inputHash:requestHash('changed request')}),fail(409));await assert.rejects(reserveRequest(wid,owner,request(a.id)),gate,'The manual pause refuses new work.');
    // The current manual pause is checked before execution-specific preparation.
    let prepared=0;await assert.rejects(dispatchRequest(wid,owner,reserved.id,async()=>{prepared++;}),gate);assert.equal(prepared,0);
    await saveProviderRequestControls(wid,owner,{paused:false});await dispatchRequest(wid,owner,reserved.id,async()=>{prepared++;});assert.equal(prepared,1);
    await assert.rejects(dispatchRequest(wid,owner,reserved.id,async()=>{prepared++;}),fail(409));assert.equal(prepared,1,'A reservation dispatches once.');
    await saveProviderRequestControls(wid,owner,{paused:true});
    await settle(wid,reserved.id,true,'original-reference');await settle(wid,reserved.id,true,'original-reference');await assert.rejects(settle(wid,reserved.id,true,'changed-reference'),fail(409));await assert.rejects(settle(wid,reserved.id,false,'original-reference'),fail(409));assert.deepEqual((await pool.query('SELECT status,estimate_micros,actual_micros,provider_reference FROM provider_request WHERE id=$1',[reserved.id])).rows[0],{status:'settled',estimate_micros:null,actual_micros:null,provider_reference:'original-reference'});
    await saveProviderRequestControls(wid,owner,{paused:false});
    // An unknown outcome stays recoverable on its original request; unrelated work continues.
    const unknownInput=request(b.id),unknown=await reserveRequest(wid,owner,unknownInput);await dispatchRequest(wid,owner,unknown.id);await settle(wid,unknown.id,false);
    assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[unknown.id])).rows[0].status,'uncertain');assert.equal((await listProviders(wid,owner)).requestControls.paused,false);
    const replay=await reserveRequest(wid,owner,unknownInput);assert.equal(replay.id,unknown.id);assert.equal(replay.created,false);assert.equal(replay.status,'uncertain');
    await assert.rejects(dispatchRequest(wid,owner,unknown.id),fail(409),'An uncertain original request cannot be dispatched again.');
    const unrelated=await reserveRequest(wid,owner,{...request(a.id),operation:'fixture.unrelated'});assert.equal(unrelated.created,true);await dispatchRequest(wid,owner,unrelated.id);await settle(wid,unrelated.id,true);
    assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[unknown.id])).rows[0].status,'uncertain','Unrelated success does not erase the original unknown outcome.');await assert.rejects(cancelRequest(wid,owner,unknown.id),fail(409));
    await settle(wid,unknown.id,true,'recovered-original');const confirmed=await reserveRequest(wid,owner,request(b.id));await dispatchRequest(wid,owner,confirmed.id);await settle(wid,confirmed.id,true,'confirmed-original');
    assert.deepEqual((await pool.query('SELECT status,estimate_micros,actual_micros FROM provider_request WHERE id=$1',[confirmed.id])).rows[0],{status:'settled',estimate_micros:null,actual_micros:null});assert.equal((await listProviders(wid,owner)).requestControls.paused,false);
    const next=await reserveRequest(wid,owner,request(b.id));assert.equal(next.created,true,'A verified outcome does not block the next request.');await cancelRequest(wid,owner,next.id);
    console.log('PASS exact replay, manual pause at reserve and dispatch, immutable outcomes and independent work during original-request recovery');

    const atomic=await workspace(),child=await connect(atomic);assert.match(atomic,/^[0-9a-f-]{36}$/);
    // A test-only manual stop after the first child exercises atomic rollback through the real gate.
    await pool.query(`CREATE FUNCTION request_fixture_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id=TG_ARGV[0] AND NEW.operation<>'test.sentinel' AND (SELECT count(*) FROM provider_request WHERE workspace_id=NEW.workspace_id AND operation<>'test.sentinel')=TG_ARGV[1]::int THEN
        INSERT INTO workspace_provider_control(workspace_id,paused) VALUES(NEW.workspace_id,true)
          ON CONFLICT(workspace_id) DO UPDATE SET paused=true;
      END IF; RETURN NULL; END $$`);
    try{
      await pool.query(`CREATE TRIGGER request_fixture_sentinel AFTER INSERT ON provider_request FOR EACH ROW EXECUTE FUNCTION request_fixture_sentinel('${atomic}','1')`);
      await assert.rejects(providerTransaction(atomic,owner,['owner'],async client=>{await reserveRequestInTransaction(client,atomic,owner,request(child.id));await reserveRequestInTransaction(client,atomic,owner,request(child.id));}),gate);
    }finally{await pool.query('DROP TRIGGER IF EXISTS request_fixture_sentinel ON provider_request');await pool.query('DROP FUNCTION request_fixture_sentinel()');}
    assert.equal(await requestCount(atomic),0,'The rollback removes the children and the manual-stop sentinel.');
    const reused=request(child.id);
    await assert.rejects(providerTransaction(atomic,owner,['owner'],async client=>{await reserveRequestInTransaction(client,atomic,owner,reused);await reserveRequestInTransaction(client,atomic,owner,{...request(child.id),requestKey:reused.requestKey,inputHash:requestHash('different work')});}),(error:unknown)=>fail(409)(error)&&/already used for different work/.test((error as Error).message));
    assert.equal(await requestCount(atomic),0);
    const outstanding=await reserveRequest(atomic,owner,request(child.id));await pool.query("UPDATE provider_request SET created_at=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date WHERE id=$1",[outstanding.id]);
    const originalIdentity=(await pool.query('SELECT id,request_key,input_hash,connection_id,connection_revision,created_at,budget_month FROM provider_request WHERE id=$1',[outstanding.id])).rows[0];
    assert.equal(originalIdentity.budget_month,null);
    assert.equal((await listProviders(atomic,owner)).requests.find(row=>row.id===outstanding.id)?.status,'reserved','Prior-month requests remain visible by their original identity.');
    await reserveRequest(atomic,owner,request(child.id));assert.equal(await requestCount(atomic),2);
    await dispatchRequest(atomic,owner,outstanding.id);
    assert.deepEqual((await pool.query('SELECT id,request_key,input_hash,connection_id,connection_revision,created_at,budget_month FROM provider_request WHERE id=$1',[outstanding.id])).rows[0],originalIdentity,'Dispatch preserves cross-month request identity without billing periods.');
    const controlRows=async()=>(await pool.query('SELECT * FROM workspace_provider_control WHERE workspace_id=$1',[atomic])).rows,controlsBefore=await controlRows();
    const holder=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{await holder.query('BEGIN');await holder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[atomic]);const blocker=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[atomic,owner]);
      waiting=saveProviderRequestControls(atomic,owner,{paused:true});void waiting.catch(()=>undefined);
      const deadline=Date.now()+3000;let observed=false;while(Date.now()<deadline){observed=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[blocker])).rowCount;if(observed)break;await delay(10);}assert.equal(observed,true,'Observe actual workspace gate contention.');
      await holder.query('COMMIT');await assert.rejects(waiting,fail(404));
    }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await waiting?.catch(()=>undefined);}
    assert.deepEqual(await controlRows(),controlsBefore,'The refused pause leaves the manual control state unchanged.');
    const requestsWithoutMoney=(await pool.query('SELECT estimate_micros,actual_micros,budget_month FROM provider_request WHERE workspace_id=ANY($1::text[])',[ownedWorkspaces])).rows;assert.ok(requestsWithoutMoney.length>0);assert.ok(requestsWithoutMoney.every(row=>row.estimate_micros===null&&row.actual_micros===null&&row.budget_month===null),'Every new provider request leaves legacy financial columns NULL.');
    assertNoApiMoney(await listProviders(wid,owner));
    assert.equal(outgoing,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS atomic multi-child rollback through the real manual-stop gate, cross-month request identity and observed gate wait with fresh role denial (D3)');
  }finally{globalThis.fetch=originalFetch;await closeDatabase();}
}

if(process.env.TEN98_PROVIDER_SPENDING_TEST==='1')await runProviderSpendingControlsChecks();
