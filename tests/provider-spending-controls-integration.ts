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
import {listProviders,providerTransaction,revokeProvider,saveBudget,saveProvider,saveProviderLimit,usd} from '../src/server/providers.ts';
import {cancelReservation,dispatchSpend,requestHash,reserveSpend,reserveSpendInTransaction,settleSpend} from '../src/server/spending.ts';
import {createWorkspace} from '../src/server/teams.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
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
    await claimInstallation({token:config.bootstrapToken,name:'Spending fixture',email,password,workspaceName:'Spending fixture'});
    const owner=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id as string;
    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email,password})}));
    assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
    const workspace=async()=>(await createWorkspace(owner,{name:'Spending controls fixture'})).workspace.id;
    const credentials={apiKey:'synthetic-'+randomUUID()};
    const connect=async(wid:string,limit='10')=>(await saveProvider(wid,owner,{name:'Synthetic connection',provider:'openrouter',credentials,monthlyLimitUsd:limit})).connection;
    const row=async(id:string)=>(await pool.query('SELECT * FROM provider_connection WHERE id=$1',[id])).rows[0];
    const cap=async(wid:string,id:string,amount:string)=>{const saved=await row(id);return saveProviderLimit(wid,owner,id,{revision:saved.revision,expectedMonthlyLimitUsd:usd(saved.monthly_limit_micros),monthlyLimitUsd:amount});};
    const request=(connectionId:string,estimateUsd='6')=>({connectionId,estimateUsd,requestKey:randomUUID(),operation:'fixture.spending',inputHash:requestHash('synthetic input')});
    async function settle(wid:string,id:string,amount:string|null){const client=await pool.connect();try{await client.query('BEGIN');const result=await settleSpend(client,wid,id,amount);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
    async function http(path:string,status:number,body:unknown,options:{cookie?:string;origin?:string;token?:string;method?:string;raw?:string}={}){
      const headers:Record<string,string>={origin:options.origin??config.appUrl,'content-type':'application/json'};
      if(options.token)headers.authorization='Bearer '+options.token;else if(options.cookie!==null)headers.cookie=options.cookie??cookie;
      const response=await handleApi(new Request(config.appUrl+path,{method:options.method??'POST',headers,...(options.method==='GET'?{}:{body:options.raw??JSON.stringify(body)})}));
      assert.equal(response.status,status,path);const text=await response.text();assert.ok(!text.includes(credentials.apiKey)&&!text.includes('encrypted_credentials')&&!text.includes('ciphertext'));return text?JSON.parse(text):{};
    }
    const wid=await workspace(),a=await connect(wid),b=await connect(wid),route=`/api/workspaces/${wid}/providers/${a.id}/limit`;
    const edit={revision:a.revision,expectedMonthlyLimitUsd:'10',monthlyLimitUsd:'12.000001'};
    await http(route,401,edit,{cookie:''});await http(route,403,edit,{origin:'https://foreign.spending.test'});await http(route,405,{}, {method:'GET'});
    for(const bad of [{...edit,credentials:{}},{...edit,revision:0},{...edit,monthlyLimitUsd:'NaN'},{...edit,expectedMonthlyLimitUsd:'-1'}])await http(route,400,bad);
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
    await http(`/api/workspaces/${await workspace()}/providers/${a.id}/limit`,404,edit);
    await pool.query("UPDATE provider_connection SET check_status='ok',diagnostic='Synthetic check evidence',last_checked_at=clock_timestamp() WHERE id=$1",[a.id]);
    const before=await row(a.id);const result=await http(route,200,edit);assert.equal(result.connection.monthlyLimitUsd,'12.000001');
    const after=await row(a.id);for(const key of Object.keys(before).filter(k=>!['monthly_limit_micros','updated_at'].includes(k)))assert.deepEqual(after[key],before[key],key+' preserved');
    assert.deepEqual(decryptCredentials(after.encrypted_credentials,{id:a.id,workspaceId:wid,provider:'openrouter',revision:a.revision}),credentials);
    assert.deepEqual(await http(route,200,{...edit,expectedMonthlyLimitUsd:'12.000001'}),result,'Same-value edit is a no-op.');
    await http(route,409,edit);
    console.log('PASS actual API owner/session/origin/key/body guards, strict cap CAS, encrypted bytes and check evidence preserved');

    const keys=process.env.CREDENTIAL_KEYS,active=process.env.CREDENTIAL_ACTIVE_KEY;
    try{delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
      await http(route,200,{revision:1,expectedMonthlyLimitUsd:'12.000001',monthlyLimitUsd:'0'});await saveBudget(wid,owner,{paused:true});await assert.rejects(saveBudget(wid,owner,{paused:false}),fail(503));
    }finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
    await cap(wid,a.id,'10');await saveBudget(wid,owner,{monthlyLimitUsd:'999999',paused:false});
    const budget=(await listProviders(wid,owner)).budget;assert.equal(budget.monthlyLimitUsd,'0.000000');assert.equal(budget.monthlyLimitEnforced,false);assert.equal(budget.paused,false);
    await pool.query('UPDATE workspace_budget SET monthly_limit_micros=1 WHERE workspace_id=$1',[wid]);await saveBudget(wid,owner,{monthlyLimitUsd:'0',paused:false});assert.equal((await listProviders(wid,owner)).budget.monthlyLimitUsd,'0.000001');
    const independent=await Promise.all([reserveSpend(wid,owner,request(a.id)),reserveSpend(wid,owner,request(b.id))]);assert.equal(independent.length,2,'Each connection is independent of aggregate historical cap.');
    await assert.rejects(reserveSpend(wid,owner,request(a.id,'5')),fail(409));
    for(const saved of independent)await cancelReservation(wid,owner,saved.id);
    const race=await Promise.allSettled([reserveSpend(wid,owner,request(a.id)),reserveSpend(wid,owner,request(a.id))]);assert.equal(race.filter(v=>v.status==='fulfilled').length,1);assert.ok(race.some(v=>v.status==='rejected'&&fail(409)(v.reason)));
    await cancelReservation(wid,owner,(race.find(v=>v.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value.id);
    console.log('PASS no-vault cap edit, compatible pause API, ignored preserved workspace amount, independent connections and atomic same-connection cap');

    const competing=await Promise.allSettled(['11','12'].map(amount=>saveProviderLimit(wid,owner,a.id,{revision:1,expectedMonthlyLimitUsd:'10.000000',monthlyLimitUsd:amount})));
    assert.equal(competing.filter(v=>v.status==='fulfilled').length,1);assert.ok(competing.some(v=>v.status==='rejected'&&fail(409)(v.reason)));
    await cap(wid,a.id,'20');const beforeRotation=await row(a.id);
    await assert.rejects(saveProvider(wid,owner,{name:'Stale rotation',credentials:{apiKey:'different-synthetic'},monthlyLimitUsd:'10'},a.id),fail(409));assert.deepEqual(await row(a.id),beforeRotation);
    const rotated=(await saveProvider(wid,owner,{name:'New credential',credentials},a.id)).connection;assert.equal(rotated.monthlyLimitUsd,'20.000000');assert.equal(rotated.revision,2);assert.equal(rotated.checkStatus,'untested');
    await assert.rejects(saveProviderLimit(wid,owner,a.id,{revision:1,expectedMonthlyLimitUsd:'20',monthlyLimitUsd:'30'}),fail(409));
    await saveProvider(wid,owner,{name:'Equal legacy cap',credentials,monthlyLimitUsd:'20.0'},a.id);
    const concurrent=await connect(wid);const mixed=await Promise.allSettled([saveProviderLimit(wid,owner,concurrent.id,{revision:1,expectedMonthlyLimitUsd:'10',monthlyLimitUsd:'25'}),saveProvider(wid,owner,{name:'Concurrent rotation',credentials},concurrent.id)]);
    assert.equal(mixed[1].status,'fulfilled');const mixedRow=await row(concurrent.id);assert.equal(mixedRow.revision,2);assert.equal(mixedRow.monthly_limit_micros,mixed[0].status==='fulfilled'?'25000000':'10000000');assert.deepEqual(decryptCredentials(mixedRow.encrypted_credentials,{id:concurrent.id,workspaceId:wid,provider:'openrouter',revision:2}),credentials);
    if(mixed[0].status==='rejected')assert.ok(fail(409)(mixed[0].reason));
    await revokeProvider(wid,owner,concurrent.id);await assert.rejects(cap(wid,concurrent.id,'1'),fail(404));
    console.log('PASS concurrent cap CAS and rotation preserve live cap, credential revision, authenticated encryption and revoked boundaries');

    await cap(wid,a.id,'4');const fixed=request(a.id,'3');let enqueues=0;const reserved=await reserveSpend(wid,owner,fixed,async()=>{enqueues++;});
    await cap(wid,a.id,'2');await saveBudget(wid,owner,{paused:true});assert.equal((await reserveSpend(wid,owner,fixed,async()=>{enqueues++;})).created,false);assert.equal(enqueues,1);
    await assert.rejects(reserveSpend(wid,owner,{...fixed,estimateUsd:'2'}),fail(409));await assert.rejects(dispatchSpend(wid,owner,reserved.id),fail(409));await saveBudget(wid,owner,{paused:false});
    let prepared=0;await assert.rejects(dispatchSpend(wid,owner,reserved.id,async()=>{prepared++;}),fail(409));assert.equal(prepared,0);
    await cap(wid,a.id,'3');await dispatchSpend(wid,owner,reserved.id,async()=>{prepared++;});assert.equal(prepared,1,'Dispatch excludes its own estimate.');await cap(wid,a.id,'0');await saveBudget(wid,owner,{paused:true});
    await settle(wid,reserved.id,'2.5');await settle(wid,reserved.id,'2.5');await assert.rejects(settle(wid,reserved.id,'2.4'),fail(409));assert.equal((await pool.query('SELECT actual_micros FROM provider_request WHERE id=$1',[reserved.id])).rows[0].actual_micros,'2500000');
    await saveBudget(wid,owner,{paused:false});await assert.rejects(reserveSpend(wid,owner,request(a.id,'0.000001')),fail(409));
    const unknown=await reserveSpend(wid,owner,request(b.id,'1'));await dispatchSpend(wid,owner,unknown.id);await settle(wid,unknown.id,null);assert.equal((await listProviders(wid,owner)).budget.paused,true);
    await saveBudget(wid,owner,{paused:false});await cap(wid,a.id,'100');await assert.rejects(reserveSpend(wid,owner,request(a.id,'1')),fail(409),'Other connection uncertainty blocks workspace.');await assert.rejects(cancelReservation(wid,owner,unknown.id),fail(409));
    await settle(wid,unknown.id,'0.5');const overrun=await reserveSpend(wid,owner,request(b.id,'1'));await dispatchSpend(wid,owner,overrun.id);await settle(wid,overrun.id,'1.1');assert.equal((await listProviders(wid,owner)).budget.paused,true);
    console.log('PASS exact replay, live lowered cap at dispatch, no double count, incurred settlement, immutable receipts and global uncertainty/overrun pause');

    const atomic=await workspace(),child=await connect(atomic,'5');await saveBudget(atomic,owner,{paused:false});
    await assert.rejects(providerTransaction(atomic,owner,['owner'],async client=>{await reserveSpendInTransaction(client,atomic,owner,request(child.id,'3'));await reserveSpendInTransaction(client,atomic,owner,request(child.id,'3'));}),fail(409));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1',[atomic])).rows[0].n,0);
    const outstanding=await reserveSpend(atomic,owner,request(child.id,'4'));await pool.query("UPDATE provider_request SET budget_month=(date_trunc('month',clock_timestamp())-interval '1 month')::date WHERE id=$1",[outstanding.id]);await assert.rejects(reserveSpend(atomic,owner,request(child.id,'2')),fail(409));
    const holder=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{await holder.query('BEGIN');await holder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[atomic]);const blocker=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[atomic,owner]);
      waiting=saveProviderLimit(atomic,owner,child.id,{revision:1,expectedMonthlyLimitUsd:'5',monthlyLimitUsd:'6'});void waiting.catch(()=>undefined);
      const deadline=Date.now()+3000;let observed=false;while(Date.now()<deadline){observed=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[blocker])).rowCount;if(observed)break;await delay(10);}assert.equal(observed,true,'Observe actual workspace gate contention.');
      await holder.query('COMMIT');await assert.rejects(waiting,fail(404));
    }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await waiting?.catch(()=>undefined);}
    assert.equal((await row(child.id)).monthly_limit_micros,'5000000');
    assert.equal(outgoing,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS atomic multi-child rollback, outstanding month rollover and observed gate wait with fresh role denial');
  }finally{globalThis.fetch=originalFetch;await closeDatabase();}
}

if(process.env.TEN98_PROVIDER_SPENDING_TEST==='1')await runProviderSpendingControlsChecks();
