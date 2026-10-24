import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseWebsiteAddress} from '../src/lib/website-address.ts';

test('a bare domain or a pasted page link becomes the site origin',()=>{
  assert.deepEqual(parseWebsiteAddress(' example.com '),{origin:'https://example.com'});
  assert.deepEqual(parseWebsiteAddress('www.example.com'),{origin:'https://www.example.com'},'www. is kept: the tracker matches the exact host.');
  assert.deepEqual(parseWebsiteAddress('https://shop.example.com/pricing?ref=x#top'),{origin:'https://shop.example.com'});
  assert.deepEqual(parseWebsiteAddress('http://localhost:3000/'),{origin:'http://localhost:3000'});
});

test('empty, non-web, credentialed and partial addresses are refused with a plain reason',()=>{
  for(const raw of ['','   ','ftp://example.com','https://user:pass@example.com','example','https://'])assert.ok(parseWebsiteAddress(raw).error,raw);
});
