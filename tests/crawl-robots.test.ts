import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseRobotsPolicy,evaluateRobotsPolicy,ROBOTS_MAX_BYTES,ROBOTS_MAX_MATCH_WORK} from '../src/server/crawl-robots.ts';

const robotsUrl='https://example.test/robots.txt';
const policy=(body:string|Uint8Array,productToken='TenMonitorBot')=>parseRobotsPolicy({robotsUrl,body,productToken});
const decision=(body:string,path:string,productToken='TenMonitorBot')=>evaluateRobotsPolicy(policy(body,productToken),'https://example.test'+path);
const rules=(body:string)=>'User-agent: *\n'+body;

test('exact case-insensitive product groups merge and an empty specific group excludes fallback',()=>{
  const body='User-agent: *\nDisallow: /\nUser-agent: TENMONITORBOT\nDisallow: /private\nUser-agent: TenMonitorBot\nDisallow: /second';
  assert.equal(decision(body,'/private').status,'disallowed');assert.equal(decision(body,'/second').status,'disallowed');assert.equal(decision(body,'/public').status,'allowed');
  assert.equal(decision('User-agent: *\nDisallow: /\nUser-agent: TenMonitorBot','/public').status,'allowed');
  assert.equal(decision('User-agent: TenMonitorBotExtra\nDisallow: /','/public').status,'allowed');
  assert.equal(decision('User-agent: Other\nDisallow: /','/public').status,'allowed');
  assert.equal(policy('', 'Ten98Bot').status,'unavailable');assert.equal(policy('', 'Mozilla/5.0 TenMonitorBot').status,'unavailable');
});

test('BOM, comments, blank lines and observation records preserve group membership',()=>{
  const body='\uFEFFUSER-AGENT: FirstBot\r\nSitemap: https://maps.example.test/map.xml\r\nHost: attacker.test\r\nX-note: ignored\r\nCrawl-delay: 0\r\n# comment\r\n\r\nUser-agent: TenMonitorBot\r\nDisallow: /private # detail\r\nAllow:\r\n';
  assert.equal(decision(body,'/private','FirstBot').status,'disallowed');assert.equal(decision(body,'/private').status,'disallowed');
  const compiled=policy(body);assert.equal(compiled.status,'ready');if(compiled.status==='ready') {assert.deepEqual(compiled.sitemaps,['https://maps.example.test/map.xml']);assert.equal(compiled.origin,'https://example.test');assert.equal(compiled.crawlDelaySeconds,0);}
  assert.equal(decision('Disallow: /\nUser-agent: TenMonitorBot\nAllow: /','/public').status,'allowed');
});

test('unreserved escapes normalize while encoded reserved slash remains distinct',()=>{
  for(const [rule,path] of [['/foo/bar','/foo/%62ar'],['/foo/%62ar','/foo/bar'],['/foo/%7ebar','/foo/~bar'],['/café','/caf%C3%A9'],['/caf%C3%A9','/café']])assert.equal(decision(rules('Disallow: '+rule),path).status,'disallowed');
  assert.equal(decision(rules('Disallow: /foo/bar'),'/foo%2Fbar').status,'allowed');
  assert.equal(decision(rules('Disallow: /foo%2fbar'),'/foo%2Fbar').status,'disallowed');
  assert.equal(decision(rules('Disallow: /caf%C3%A9'),'/CAF%C3%A9').status,'allowed');
});

test('literal special characters differ from rule wildcard and end syntax',()=>{
  for(const [rule,path] of [['/file-%2A.html','/file-*.html'],['/foo-%24','/foo-$'],['/foo-$bar','/foo-$bar'],['/foo-%23bar','/foo-%23bar'],['/encoded%25','/encoded%25'],['/quote"','/quote%22'],['/bracket[','/bracket%5B'],['/back\\slash','/back%5Cslash']])assert.equal(decision(rules('Disallow: '+rule),path).status,'disallowed');
  assert.equal(decision(rules('Disallow: /file-%2A.html'),'/file-abc.html').status,'allowed');
  assert.equal(decision(rules('Disallow: /*.php$'),'/dir/file.php').status,'disallowed');
  assert.equal(decision(rules('Disallow: /*.php$'),'/dir/file.php?q=a').status,'allowed');
  assert.equal(decision(rules('Disallow: /foo*bar'),'/foobar/extra').status,'disallowed');
  assert.equal(decision(rules('Disallow: /foo*bar$'),'/foobar/extra').status,'allowed');
  assert.equal(decision(rules('Disallow: /foo**bar$'),'/foo/bar').status,'disallowed');
});

test('longest normalized rule wins, allow wins ties and robots is implicitly allowed',()=>{
  assert.equal(decision(rules('Disallow: /\nAllow: /public\nDisallow: /public/private'),'/public/private').status,'disallowed');
  assert.equal(decision(rules('Disallow: /same\nAllow: /same'),'/same').status,'allowed');
  assert.equal(decision(rules('Allow: /same\nDisallow: /same'),'/same').status,'allowed');
  assert.equal(decision(rules('Allow: /foo/bar\nDisallow: /foo/%62ar'),'/foo/bar').status,'allowed');
  assert.equal(decision(rules('Disallow: /'),'/robots.txt').reason,'implicit_robots');
  assert.equal(decision(rules('Disallow: /'),'/robots.txt?different=1').status,'disallowed');
  assert.equal(decision(rules('Disallow: /foo$'),'/foo#section').status,'disallowed');
});

test('trailing wildcard preserves match set but full-pattern length still determines priority',()=>{
  for(const path of ['/topic','/topic/article','/topic.html']) {
    assert.equal(decision(rules('Disallow: /topic'),path).status,decision(rules('Disallow: /topic*'),path).status);
    assert.equal(decision(rules('Allow: /topic\nDisallow: /topic*'),path).status,'disallowed');
    assert.equal(decision(rules('Allow: /topic*\nDisallow: /topic'),path).status,'allowed');
  }
  assert.equal(decision(rules('Allow: /foo*******\nDisallow: /foo/private'),'/foo/private').status,'disallowed');
  assert.equal(decision(rules('Allow: /foo********\nDisallow: /foo/private'),'/foo/private').status,'allowed');
  assert.equal(decision(rules('Allow: /foo*********\nDisallow: /foo/private'),'/foo/private').status,'allowed');
  assert.equal(decision('User-agent: TenMonitorBot/1.0\nDisallow: /restricted','/restricted').status,'allowed');
  assert.equal(decision('User-agent: TenMonitorBot*\nDisallow: /restricted','/restricted').status,'allowed');
});

test('invalid or foreign URL authorities never yield permission',()=>{
  const compiled=policy('');
  for(const url of ['https:example.test/x','https:///example.test/x','https://@example.test/x','http://example.test/x','https://other.test/x','https://example.test:8443/x','https://user:secret@example.test/x','file:///x','/relative','https://example.test/x\n','https://example.test\\private','https://example.test/%zz','https://example.test/'+ 'a'.repeat(2048),'https://example.test/\uD800'])assert.equal(evaluateRobotsPolicy(compiled,url).status,'unavailable',url);
  assert.equal(evaluateRobotsPolicy(compiled,'https://EXAMPLE.test:443/x').status,'allowed');
  assert.equal(parseRobotsPolicy({robotsUrl:'https://example.test/not-robots',body:'',productToken:'TenMonitorBot'}).status,'unavailable');
});

test('UTF8 validation and exact byte limit fail closed without truncating restrictive tails',()=>{
  const prefix='User-agent: *\n#',suffix='\nDisallow: /hidden';
  const body=prefix+'a'.repeat(ROBOTS_MAX_BYTES-prefix.length-suffix.length)+suffix;
  assert.equal(Buffer.byteLength(body),ROBOTS_MAX_BYTES);assert.equal(decision(body,'/hidden').status,'disallowed');
  assert.equal(policy(body+'a').status,'unavailable');
  assert.equal(policy(new Uint8Array([0xc3,0x28])).status,'unavailable');assert.equal(policy('\uD800').status,'unavailable');
  assert.equal(decision('User-agent: *\nDisallow: /blocked\nDisallow: /\u0000','/blocked').status,'disallowed');
  assert.equal(evaluateRobotsPolicy(policy(new TextEncoder().encode('User-agent: *\nDisallow: /café')),'https://example.test/caf%C3%A9').status,'disallowed');
  assert.equal(policy('é'.repeat(ROBOTS_MAX_BYTES/2+1)).status,'unavailable');
});

test('malformed ordinary lines are ignored but unsupported applicable URI patterns stop evaluation',()=>{
  const valid=rules('Disallow: /blocked\n');
  for(const line of ['Disallow: not-a-path','Disallow: /space here','User-agent: Invalid/1.0','garbage','X-note: \u0000','Sitemap: https://user:secret@example.test/map'])assert.equal(decision(valid+line,'/blocked').status,'disallowed');
  assert.equal(decision(rules('Disallow: /blocked # \u0000'),'/blocked').status,'disallowed');
  assert.equal(decision('User-agent: FirstBot\nDisallow: not-a-path\nUser-agent: TenMonitorBot\nDisallow: /blocked','/blocked','FirstBot').status,'disallowed');
  assert.equal(decision(rules('Disallow: /bad%escape'),'/').status,'unavailable');
  assert.equal(decision('User-agent: Other\nDisallow: not-a-path\nUser-agent: TenMonitorBot\nDisallow: /private','/public').status,'allowed');
});

test('crawl delay is a bounded observation requiring explicit capacity, with no scope expansion',()=>{
  const compiled=policy('User-agent: *\nCrawl-delay: 0.25\nCrawl-delay: 2\nAllow: /\nHost: other.test');
  assert.equal(evaluateRobotsPolicy(compiled,'https://example.test/').reason,'crawl_delay_not_supported');
  assert.equal(evaluateRobotsPolicy(compiled,'https://example.test/',{maxCrawlDelaySeconds:2}).status,'allowed');
  assert.equal(evaluateRobotsPolicy(compiled,'https://other.test/',{maxCrawlDelaySeconds:2}).reason,'origin_mismatch');
  assert.equal(evaluateRobotsPolicy(compiled,'https://example.test/',{maxCrawlDelaySeconds:Infinity}).status,'unavailable');
  for(const value of ['-1','Infinity','NaN','1e3','9'.repeat(400),''])assert.equal(policy('User-agent: *\nCrawl-delay: '+value).status,'unavailable');
  const invalidMap=policy('Sitemap: https://user:secret@example.test/map.xml');assert.equal(invalidMap.status,'ready');if(invalidMap.status==='ready')assert.deepEqual(invalidMap.sitemaps,[]);
  assert.equal(policy(('Sitemap: https://example.test/map.xml\n').repeat(101)).status,'unavailable');
});

test('wildcard work is deterministic, cumulative and cannot return a partial allow decision',()=>{
  const hostile=policy(rules('Allow: /\nDisallow: /'+'*'.repeat(500_000)+'z$'));
  assert.equal(hostile.status,'ready');
  const first=evaluateRobotsPolicy(hostile,'https://example.test/'+'a'.repeat(1000));
  assert.equal(first.status,'unavailable');assert.equal(first.reason,'match_work_limit');assert.equal(first.work,ROBOTS_MAX_MATCH_WORK);
  assert.deepEqual(evaluateRobotsPolicy(hostile,'https://example.test/'+'a'.repeat(1000)),first);
  const aggregate=policy(rules(('Disallow: /'+'*'.repeat(100)+'z$\n').repeat(40)));
  assert.equal(evaluateRobotsPolicy(aggregate,'https://example.test/'+'a'.repeat(1000)).reason,'match_work_limit');
});
