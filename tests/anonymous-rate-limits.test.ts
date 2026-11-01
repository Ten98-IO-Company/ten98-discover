import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {createServer,Socket} from 'node:net';

// Security regression (review 2026-10-22): anonymous sign-in, second-factor and password-recovery limits must not be one
// instance-wide bucket. One client exhausting that bucket must not refuse a different client's first attempt.
// No PostgreSQL is needed: the database endpoint is a local listener that closes every connection, so any request that
// passes the limiter fails fast with a connection error instead of reaching a real database.
const refuse=createServer(socket=>socket.destroy());
await new Promise<void>(resolve=>refuse.listen(0,'127.0.0.1',resolve));
const {port}=refuse.address() as {port:number};
Object.assign(process.env,{APP_URL:'http://localhost:3000',DATABASE_URL:`postgresql://synthetic:synthetic@127.0.0.1:${port}/unused_rate_limit_unit`,AUTH_SECRET:'rate-limit-unit-auth-only-'.repeat(3),BOOTSTRAP_TOKEN:'rate-limit-unit-bootstrap-only-'.repeat(3),ANALYTICS_NETWORK_MODE:'off'});
for(const name of ['AUTH_SECRET_FILE','BOOTSTRAP_TOKEN_FILE','DATABASE_URL_FILE','SMTP_HOST','EMAIL_TRANSPORT'])delete process.env[name];
const {handleAccountSecurity}=await import('../src/server/account-security.ts');
const {FoundationError}=await import('../src/server/auth.ts');
const {closeDatabase}=await import('../src/server/db.ts');
after(async()=>{await closeDatabase().catch(()=>undefined);await new Promise(resolve=>refuse.close(resolve));});

// Same contract as api.ts limit(): per key and minute, the request that exceeds the maximum is refused with 429.
function memoryLimit(){
  const counts=new Map<string,number>();
  return async(key:string,maximum:number)=>{const count=(counts.get(key)??0)+1;counts.set(key,count);if(count>maximum)throw new FoundationError(429,'Too many requests. Wait a minute and try again.');};
}
// The srvx Node transport shape that extractAnalyticsPeer reads, so a peer-keyed limit can tell the two clients apart.
function from(address:string,path:string,body:unknown,headers:Record<string,string>={}){
  const request=new Request('http://localhost:3000'+path,{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json',...headers},body:JSON.stringify(body)});
  const socket=new Socket();Object.defineProperty(socket,'remoteAddress',{value:address});
  Object.defineProperty(request,'runtime',{value:{name:'node',node:{req:{socket}}}});
  return request;
}
async function status(work:Promise<Response|null>){
  try{const response=await work;return response?.status??null;}
  catch(error){return error instanceof FoundationError?error.status:'internal';}
}
const attacker='198.51.100.66',victim='203.0.113.7';

test('one client exhausting password sign-in attempts does not refuse another client signing in',async()=>{
  const limit=memoryLimit();
  const attempts=await Promise.all(Array.from({length:61},(_,i)=>status(handleAccountSecurity(from(attacker,'/api/auth/sign-in/email',{email:`attacker-${i}@example.test`,password:'not-the-password'}),limit))));
  assert.equal(attempts.filter(value=>value===429).length,1,'The attacker must exhaust the per-client sign-in limit.');
  assert.notEqual(await status(handleAccountSecurity(from(victim,'/api/auth/sign-in/email',{email:'member@example.test',password:'members-password'}),limit)),429,
    'A different client\'s first sign-in attempt was refused because an anonymous instance-wide bucket was exhausted.');
});

test('one client exhausting second-factor attempts does not refuse another client\'s challenge',async()=>{
  const limit=memoryLimit();
  const attempts=await Promise.all(Array.from({length:61},(_,i)=>status(handleAccountSecurity(from(attacker,'/api/auth/two-factor/verify-totp',{code:'000000'},{cookie:`better-auth.two_factor=junk-${i}.sig`}),limit))));
  assert.equal(attempts.filter(value=>value===429).length,1,'The attacker must exhaust the per-client second-factor limit.');
  assert.notEqual(await status(handleAccountSecurity(from(victim,'/api/auth/two-factor/verify-totp',{code:'123456'},{cookie:'better-auth.two_factor=member.sig'}),limit)),429,
    'A different client\'s first second-factor attempt was refused because an anonymous instance-wide bucket was exhausted.');
});

test('one client exhausting password recovery does not refuse another client\'s recovery request or reset',async()=>{
  const limit=memoryLimit();
  const requests=await Promise.all(Array.from({length:21},(_,i)=>status(handleAccountSecurity(from(attacker,'/api/auth/request-password-reset',{email:`attacker-${i}@example.test`}),limit))));
  assert.equal(requests.filter(value=>value===429).length,1,'The attacker must exhaust the per-client recovery request limit.');
  assert.notEqual(await status(handleAccountSecurity(from(victim,'/api/auth/request-password-reset',{email:'member@example.test'}),limit)),429,
    'A different client\'s recovery request was refused because an anonymous instance-wide bucket was exhausted.');
  const resets=await Promise.all(Array.from({length:61},(_,i)=>status(handleAccountSecurity(from(attacker,'/api/auth/reset-password',{token:String(i).padStart(24,'A'),newPassword:'a-new-long-password'}),limit))));
  assert.equal(resets.filter(value=>value===429).length,1,'The attacker must exhaust the per-client password reset limit.');
  assert.notEqual(await status(handleAccountSecurity(from(victim,'/api/auth/reset-password',{token:'A'.repeat(24),newPassword:'a-new-long-password'}),limit)),429,
    'A different client\'s password reset was refused because an anonymous instance-wide bucket was exhausted.');
});
