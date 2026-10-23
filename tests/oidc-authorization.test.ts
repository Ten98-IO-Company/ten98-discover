import assert from 'node:assert/strict';
import {test} from 'node:test';
import {authorizationRedirect,navigableHttpUrl} from '../src/lib/oidc-authorization.ts';

const origin='https://id.example.test';
const good=`${origin}/application/o/authorize/?client_id=c&state=s&redirect_uri=${encodeURIComponent('https://app.example.test/api/auth/oidc/callback')}`;

test('authorization redirects stay on the provider origin without credentials or fragments',()=>{
  assert.equal(authorizationRedirect(good,origin),good);
  assert.equal(authorizationRedirect('http://127.0.0.1:9000/authorize?x=1','http://127.0.0.1:9000'),'http://127.0.0.1:9000/authorize?x=1');
  assert.equal(authorizationRedirect('http://[::1]:9000/authorize','http://[::1]:9000'),'http://[::1]:9000/authorize');
  for(const [url,expected] of [
    [`${good}#fragment`,origin],[`${good}#`,origin],
    ['https://user:pass@id.example.test/authorize',origin],['https://user@id.example.test/authorize',origin],['https://:pass@id.example.test/authorize',origin],
    ['https://evil.example.test/authorize',origin],['https://id.example.test:8443/authorize',origin],['https://id.example.test.evil.test/authorize',origin],
    ['http://id.example.test/authorize','http://id.example.test'],['http://10.0.0.1/authorize','http://10.0.0.1'],
    ['javascript:alert(1)',origin],['data:text/html,x',origin],['//id.example.test/authorize',origin],['/authorize',origin],['not a url',origin],
    [good,undefined],[good,''],[good,`${origin}/`],[good,null],
  ] as const)assert.equal(authorizationRedirect(url,expected),null,`${url} @ ${String(expected)}`);
  assert.equal(authorizationRedirect(undefined,origin),null);assert.equal(authorizationRedirect(42,origin),null);
});

test('navigable http URLs keep the loopback-only plain-http rule and now refuse credentials and fragments',()=>{
  for(const url of ['https://id.example.test/authorize','http://localhost:3000/a','http://127.0.0.1/a','http://[::1]/a'])assert.equal(navigableHttpUrl(url),new URL(url).href,url);
  for(const url of ['http://id.example.test/a','http://127.0.0.2/a','ftp://id.example.test/a','https://u:p@id.example.test/a','https://id.example.test/a#x','https://id.example.test/a#',''])assert.equal(navigableHttpUrl(url),null,url);
});
