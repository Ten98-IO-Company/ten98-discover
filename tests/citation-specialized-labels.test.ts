import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCitationRedditCommunity as reddit,parseCitationSearchQuery as search} from '../src/server/citation-specialized-labels.ts';

test('Reddit communities use exact normalized host and one actual pathname segment',()=>{
 for(const [url,expected] of [
  ['https://reddit.com/r/Tech/comments/one','tech'],
  ['https://OLD.REDDIT.COM./R/TeCh?next=/r/Other#r/Fake','tech'],
  ['https://www.reddit.com/r/%74ech','tech'],
  ['https://reddit.com/r/a','a'],
  [`https://reddit.com/r/${'A_'.repeat(32)}`,'a_'.repeat(32)],
  ['https://reddit.com/r/123_community/trailing%FF','123_community'],
 ]as const)assert.equal(reddit(url),expected,url);
 for(const url of [
  'https://notreddit.com/r/Fake','https://reddit.com.evil.example/r/Fake','https://redd.it/r/Fake',
  'https://.reddit.com/r/Fake','https://bad..reddit.com/r/Fake','https://-bad.reddit.com/r/Fake',
  'https://reddit.com../r/Fake','https://reddit.com/x/r/Fake','https://reddit.com/user/person?community=r/Hidden',
  'https://reddit.com/search?next=https://reddit.com/r/Fake','https://reddit.com/#/r/Fake',
  'https://reddit.com/%72/Tech','https://reddit.com/r/','https://reddit.com/r//Tech',
  `https://reddit.com/r/${'a'.repeat(65)}`,
 ])assert.equal(reddit(url),null,url);
});

test('Reddit rejects decoded separators, controls and invalid UTF-8 without double decoding',()=>{
 for(const segment of ['Tech%2FFake','Tech%5CFake','%252F','Tech%00','Tech%0A','Tech%7F','Tech%C2%80','Tech%C2%9F','Tech%20','caf%C3%A9','%EF%BF%BD','%FF','%C0%AF','%ED%A0%80','%E2%82','%','%2','%GG','%2531','a-b','a.b'])
  assert.equal(reddit(`https://reddit.com/r/${segment}/comments/id`),null,segment);
 assert.equal(reddit('https://reddit.com/r/%31_Valid'), '1_valid');
 assert.equal(reddit('https://reddit.com/r/Valid?next=%FF#%00'),'valid','Unrelated query/fragment bytes cannot invent or invalidate a community.');
});

test('search preserves form semantics, first q and inherited trim/placeholder behavior',()=>{
 for(const [query,expected] of [
  ['q=C%2B%2B','C++'],['q=C++','C'],['q=%2520','%20'],['q=first&q=second','first'],
  ['%71=first&q=second','first'],['q=first&%71=second','first'],['Q=ignored&q=chosen','chosen'],
  ['q=+%20hello+world%20+','hello world'],['q=a=b','a=b'],['q=one%26q%3Dtwo','one&q=two'],
  ['q=%E2%9C%93+%F0%9F%98%80','✓ 😀'],['q=caf%C3%A9','café'],['q=%00safe&q=later',null],
  ['q=&q=later',null],['q&q=later',null],['q=+PrOdUcT+&q=later',null],['q=++',null],['other=word',null],
  ['%FF=ignored&q=valid','valid'],['other=%FF&q=valid','valid'],['q=valid&q=%FF','valid'],
 ]as const)assert.equal(search(`https://www.google.com/search?${query}`),expected,query);
 assert.equal(search('https://google.com/search?q=before#q=after'),'before');
 assert.equal(search('https://google.com/search#q=fragment'),null);
 assert.equal(search('https://example.com/?q=literal'),'literal','Host admission belongs to the shared classifier, not this label helper.');
});

test('search rejects the first q malformed encoding and every decoded C0/C1 control',()=>{
 for(const encoded of ['%','%2','%GG','%FF','%C0%AF','%ED%A0%80','%E2%82','%F4%90%80%80'])
  assert.equal(search(`https://google.com/search?q=${encoded}&q=valid`),null,encoded);
 for(const code of [...Array.from({length:32},(_,i)=>i),...Array.from({length:33},(_,i)=>127+i)])
  assert.equal(search(`https://google.com/search?q=before${encodeURIComponent(String.fromCharCode(code))}after`),null,String(code));
 assert.equal(search('https://google.com/search?q=%EF%BF%BD'),'�','Valid encoded replacement character is not malformed UTF-8.');
 assert.equal(search('https://google.com/search?q=�'),'�');
 assert.equal(search('https://google.com/search?q=%25FF'),'%FF','A valid literal percent sequence is not decoded twice.');
 assert.equal(search('https://google.com/search?q=%2500'),'%00');
 assert.equal(search('https://google.com/search?q=%252B'),'%2B');
});

test('both helpers reject unsafe/malformed retained URLs and enforce the exact 2048-character bound',()=>{
 for(const parse of [reddit,search])for(const value of [
  null,undefined,{},'', '/r/Tech?q=term','http://reddit.com/r/Tech?q=term','ftp://reddit.com/r/Tech?q=term',
  'https://user@reddit.com/r/Tech?q=term','https://user:secret@reddit.com/r/Tech?q=term',
  'https://reddit.com\\r\\Tech?q=term',' https://reddit.com/r/Tech?q=term','https://reddit.com/r/Tech?q=term ',
  'https://reddit.com/r/Te\nch?q=term','https://reddit.com/r/Tech?q=te\trm','https://reddit.com/r/Tech?q=\u0085',
  'https://reddit.com/r/Tech?q=\uD800','https://[invalid/r/Tech?q=term',
 ])assert.equal(parse(value as string),null,String(value));
 const redditPrefix='https://reddit.com/r/Tech?padding=',searchPrefix='https://google.com/search?q=';
 const redditLimit=redditPrefix+'x'.repeat(2048-redditPrefix.length),searchLimit=searchPrefix+'x'.repeat(2048-searchPrefix.length);
 assert.equal(reddit(redditLimit),'tech');assert.equal(reddit(redditLimit+'x'),null);
 assert.equal(search(searchLimit),'x'.repeat(2048-searchPrefix.length));assert.equal(search(searchLimit+'x'),null);
});
