import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveAuditCandidate,resolveRobotsRedirect,planAuditRequest,type AuditExclusion} from '../src/server/site-audit-policy.ts';

const origin='https://example.com',base=`${origin}/Dir/page.html`;
function accepted(raw:string,url:string){assert.deepEqual(resolveAuditCandidate(raw,base,origin),{status:'accepted',url});}
function excluded(raw:string,reason:AuditExclusion){assert.deepEqual(resolveAuditCandidate(raw,base,origin),{status:'excluded',reason});}
const now=Date.UTC(2026,9,13,12,0,0);
const schedule=(retryAfter?:string|null,nextRequestAtMs:number|null=null,deadlineMs=now+60_000)=>planAuditRequest({nowMs:now,nextRequestAtMs,deadlineMs,retryAfter});

test('exact-origin resolution preserves case, escaping and slashes; fragments do not create queries',()=>{
  accepted('Next/','https://example.com/Dir/Next/');
  accepted('../A%2fb%3Fc%20D','https://example.com/A%2fb%3Fc%20D');
  accepted('/A//B/','https://example.com/A//B/');
  accepted('/A#ignored?query','https://example.com/A');
  accepted('#?ignored','https://example.com/Dir/page.html');
  accepted('https://EXAMPLE.com:443/Path','https://example.com/Path');
  accepted('/a%25b','https://example.com/a%25b');
  accepted('/café','https://example.com/caf%C3%A9');
  assert.notDeepEqual(resolveAuditCandidate('/a',base,origin),resolveAuditCandidate('/A',base,origin));
  assert.notDeepEqual(resolveAuditCandidate('/a/',base,origin),resolveAuditCandidate('/a',base,origin));
  for(const raw of ['/a?','/a?x=1','?'])excluded(raw,'query');
  excluded('/?a#fragment','query');
  excluded('https://other.com/a','outside_origin');excluded('http://example.com/a','outside_origin');
});

test('untrusted syntax fails before URL normalization and never echoes rejected inputs',()=>{
  for(const raw of ['',' '.repeat(1)])excluded(raw,raw?'invalid_characters':'invalid_input');
  for(const raw of ['/a\\b','/a\n','/a%00','/a%0a','/a%5C','/a%C2%85'])excluded(raw,'invalid_characters');
  for(const raw of ['/a%','/a%2','/a%GG','/%FF','/%C0%AF','/%ED%A0%80','/#%FF'])excluded(raw,'invalid_percent_encoding');
  excluded('/a\ud800','invalid_unicode');excluded('/a\udc00','invalid_unicode');
  for(const raw of ['https://name:password@example.com/','https://@example.com/','//name@example.com/'])excluded(raw,'userinfo');
  for(const raw of ['https://%65xample.com/','https:example.com','https:///example.com','file:///etc/passwd','https://example.com:444/'])excluded(raw,'blocked_url');
  // Encoded delimiters are path data; percent decoding is validation, never an output rewrite.
  accepted('/%2f%3f%23%40','https://example.com/%2f%3f%23%40');
  accepted('/user@name','https://example.com/user@name');
});

test('2 KiB cap applies before and after resolution; scope and base cannot smuggle authority',()=>{
  const full=origin+'/'+ 'a'.repeat(2048-origin.length-1);
  accepted(full,full);excluded(full+'a','too_long');
  excluded('/'+ 'a'.repeat(2047),'blocked_url'); // Raw fits; its absolute URL does not.
  excluded('/'+ 'é'.repeat(1024),'too_long');
  for(const scope of [origin+'/',origin+'/path',origin+'?',origin+'#x','https://EXAMPLE.com','http://example.com','https://127.0.0.1','https://1.1.1.1','https://localhost'])assert.equal(resolveAuditCandidate('/a',base,scope).status,'excluded');
  for(const foreignBase of ['https://other.com/a',origin+'/a?',origin+'/a%FF','https://user@example.com/'])assert.deepEqual(resolveAuditCandidate('/a',foreignBase,origin),{status:'excluded',reason:'invalid_base'});
  assert.deepEqual(resolveAuditCandidate('/a','https://xn--bcher-kva.de/','https://xn--bcher-kva.de'),{status:'accepted',url:'https://xn--bcher-kva.de/a'});
});

test('robots redirects permit only public URL syntax, preserve original policy origin and do not grant page scope',()=>{
  assert.deepEqual(resolveRobotsRedirect('http://other.com/robots.txt#fragment?',origin+'/robots.txt',origin),{status:'accepted',url:'http://other.com/robots.txt',policyOrigin:origin});
  assert.deepEqual(resolveRobotsRedirect('/policy','http://other.com/robots.txt',origin),{status:'accepted',url:'http://other.com/policy',policyOrigin:origin});
  assert.deepEqual(resolveAuditCandidate('http://other.com/policy',base,origin),{status:'excluded',reason:'outside_origin'});
  assert.equal(resolveRobotsRedirect('https://1.1.1.1/robots.txt',base,origin).status,'accepted');
  for(const raw of ['https://127.0.0.1/','https://127.1/','https://2130706433/','http://[::ffff:1.1.1.1]/','https://a.internal/','https://other.com:444/','https://other.com/a%FF','https://other.com/robots.txt?'])assert.equal(resolveRobotsRedirect(raw,base,origin).status,'excluded',raw);
  assert.deepEqual(resolveRobotsRedirect('/x','http://other.com/?',origin),{status:'excluded',reason:'invalid_base'});
});

test('pacing preserves persisted cooldown, minimum interval, strict deadline and past-date floor',()=>{
  assert.deepEqual(schedule(),{status:'ready',nextRequestAtMs:now+1000,retryAfter:'absent'});
  assert.deepEqual(schedule('0',now+30_000),{status:'ready',nextRequestAtMs:now+30_000,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('00002'),{status:'ready',nextRequestAtMs:now+2000,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('60'),{status:'cannot_fit',nextRequestAtMs:now+60_000,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('61'),{status:'cannot_fit',nextRequestAtMs:now+61_000,retryAfter:'delta_seconds'});
  assert.equal(schedule(null,now+60_000).status,'cannot_fit');
  assert.equal(schedule(undefined,null,now+1000).status,'cannot_fit');
  assert.equal(schedule(undefined,null,now-1).status,'cannot_fit');
  assert.deepEqual(schedule('Sun, 06 Nov 1994 08:49:37 GMT'),{status:'ready',nextRequestAtMs:now+1000,retryAfter:'http_date'});
});

test('Retry-After accepts all three HTTP-date wire forms and only their actual calendar values',()=>{
  const expected={status:'ready',nextRequestAtMs:now+30_000,retryAfter:'http_date'};
  for(const raw of ['Tue, 13 Oct 2026 12:00:30 GMT','Tuesday, 13-Oct-26 12:00:30 GMT','Tue Oct 13 12:00:30 2026',' \tTue, 13 Oct 2026 12:00:30 GMT\t '])assert.deepEqual(schedule(raw),expected,raw);
  for(const raw of ['Wed, 13 Oct 2026 12:00:30 GMT','Tue, 32 Oct 2026 12:00:30 GMT','Tue, 13 Oct 2026 24:00:30 GMT','Tue, 13 Oct 2026 12:60:30 GMT','Tue, 13 Oct 2026 12:00:61 GMT','Tue, 13 Oct 2026 12:00:30 UTC','tue, 13 Oct 2026 12:00:30 GMT','2026-10-13T12:00:30Z','Tue, 13  Oct 2026 12:00:30 GMT','Sat, 29 Feb 2025 12:00:30 GMT','Mon, 01 Jan 1800 12:00:30 GMT'])assert.deepEqual(schedule(raw),{status:'ready',nextRequestAtMs:now+1000,retryAfter:'malformed'},raw);
  assert.deepEqual(schedule('Tue, 13 Oct 2026 12:00:60 GMT'),{status:'cannot_fit',nextRequestAtMs:now+60_000,retryAfter:'http_date'});
  const earlier=Date.UTC(2026,9,6,12);
  assert.equal(planAuditRequest({nowMs:earlier,nextRequestAtMs:null,deadlineMs:earlier+60_000,retryAfter:'Tue Oct  6 12:00:30 2026'}).status,'ready');
});

test('obsolete two-digit years obey the fifty-year future boundary, including a century change',()=>{
  const centuryNow=Date.UTC(2090,0,1),future=Date.UTC(2101,0,1),past=Date.UTC(2001,0,1);
  const date=new Date(future),day=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()];
  const result=planAuditRequest({nowMs:centuryNow,nextRequestAtMs:null,deadlineMs:future+1000,retryAfter:`${day}, 01-Jan-01 00:00:00 GMT`});
  assert.deepEqual(result,{status:'ready',nextRequestAtMs:future,retryAfter:'http_date'});assert.ok(future>past);
  const pivotNow=Date.UTC(2026,0,1),horizon=Date.UTC(2076,0,1),older=Date.UTC(1976,0,2);
  assert.deepEqual(planAuditRequest({nowMs:pivotNow,nextRequestAtMs:null,deadlineMs:horizon+1000,retryAfter:'Wednesday, 01-Jan-76 00:00:00 GMT'}),{status:'ready',nextRequestAtMs:horizon,retryAfter:'http_date'});
  assert.equal(new Date(older).getUTCDay(),5);
  assert.deepEqual(planAuditRequest({nowMs:pivotNow,nextRequestAtMs:null,deadlineMs:horizon+1000,retryAfter:'Friday, 02-Jan-76 00:00:00 GMT'}),{status:'ready',nextRequestAtMs:pivotNow+1000,retryAfter:'http_date'});
});

test('malformed fallback is explicit and bounded; huge valid delays and corrupt clocks never retry early',()=>{
  for(const raw of ['', '1.5','-1','+1','1e2','1, 2','1\n','1\r\n','1\u0000','\u00a01','1\t2'])assert.deepEqual(schedule(raw,now+2000),{status:'ready',nextRequestAtMs:now+2000,retryAfter:'malformed'});
  assert.deepEqual(schedule(' \t2\t '),{status:'ready',nextRequestAtMs:now+2000,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('9'.repeat(16384)),{status:'cannot_fit',nextRequestAtMs:null,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('0'.repeat(16384)),{status:'ready',nextRequestAtMs:now+1000,retryAfter:'delta_seconds'});
  assert.deepEqual(schedule('0'.repeat(16385)),{status:'cannot_fit',nextRequestAtMs:null,retryAfter:'capacity_exceeded'});
  for(const bad of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER])assert.deepEqual(planAuditRequest({nowMs:bad,nextRequestAtMs:null,deadlineMs:now}),{status:'invalid_input'});
  assert.deepEqual(planAuditRequest({nowMs:now,nextRequestAtMs:NaN,deadlineMs:now+1000}),{status:'invalid_input'});
  assert.deepEqual(planAuditRequest({nowMs:now,nextRequestAtMs:null,deadlineMs:now+1000,retryAfter:['3'] as unknown as string}),{status:'invalid_input'});
  assert.deepEqual(planAuditRequest({nowMs:8_640_000_000_000_000,nextRequestAtMs:null,deadlineMs:8_640_000_000_000_000}),{status:'cannot_fit',nextRequestAtMs:null,retryAfter:'absent'});
});
