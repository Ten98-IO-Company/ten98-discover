import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCitationClassifier,groupCitationUrl,googleDomainsVersion} from '../src/server/citation-classification.ts';

const plain=()=>createCitationClassifier({brandDomains:[],competitors:[],overrides:[]});

test('citation facets retain upstream source/page heuristics independently of tracked ownership',()=>{
  const classify=createCitationClassifier({brandDomains:['forbes.com'],competitors:[{id:'peer',domains:['amazon.com']}],overrides:[]});
  const cases=[
    ['https://www.forbes.com/sites/test/2026/story','News','editorial','article'],
    ['https://amazon.com/dp/B089','A product','ecommerce','product'],
    ['https://github.com/example/repo','A repository','developer','other'],
    ['https://reddit.com/r/example/comments/abc/title','Discussion','social','forum'],
    ['https://www.britannica.com/topic/mezcal','Mezcal','reference','article'],
    ['https://nasa.gov/science/story','Science','institutional','article'],
    ['https://synthetic-unknown-citation.com/docs/api','API reference','developer','doc'],
    ['https://synthetic-unknown-citation.com/story','10 best runners','editorial','listicle'],
    // Upstream treats otherwise unlisted .org hosts as institutional; this is a heuristic.
    ['https://synthetic-unknown-citation.org/docs/api','API reference','institutional','doc'],
  ] as const;
  for(const [url,title,category,pageType] of cases){
    const row=classify(url,title);
    assert.equal(row.classification.publisherCategory,category,url);
    assert.equal(row.classification.pageType,pageType,url);
    assert.equal(row.classification.sourceType,'publisher');
    assert.equal(row.classification.publisherBasis,'elmo-automatic');
  }
  assert.deepEqual(classify(cases[0][0],cases[0][1]).classification.ownership,{brand:true,competitorIds:[],ambiguous:false});
  assert.deepEqual(classify(cases[1][0],cases[1][1]).classification.ownership,{brand:false,competitorIds:['peer'],ambiguous:false});
});

test('citation ownership preserves all overlapping identities, normalizes hosts, and never unwraps destinations',()=>{
  const classify=createCitationClassifier({brandDomains:['WWW.Acme.org.','bücher.de'],competitors:[
    {id:'z',domains:['docs.acme.org','www.acme.org']},{id:'a',domains:['acme.org']},
  ],overrides:[]});
  const hit=classify('https://deep.docs.acme.org/page',null);
  assert.deepEqual(hit.classification.ownership,{brand:true,competitorIds:['a','z'],ambiguous:true});
  assert.equal(hit.hostname,'deep.docs.acme.org');
  assert.equal(classify('https://xn--bcher-kva.de./',null).classification.ownership.brand,true);
  for(const url of ['https://notacme.org/','https://acme.org.evil.net/','https://www.google.com/url?url=https%3A%2F%2Facme.org']){
    assert.deepEqual(classify(url,null).classification.ownership,{brand:false,competitorIds:[],ambiguous:false});
  }
});

test('exact-host publisher overrides cannot rewrite page type, automatic category or ownership',()=>{
  const input={brandDomains:['forbes.com'],competitors:[]};
  const classify=createCitationClassifier({...input,overrides:[{domain:'WWW.FORBES.COM.',category:'other'}]});
  const url='https://www.forbes.com/ambiguous';
  const original=plain()(url,null),overridden=classify(url,null);
  assert.equal(overridden.classification.publisherCategory,'other');
  assert.equal(overridden.classification.publisherBasis,'override');
  assert.equal(overridden.classification.automaticPublisherCategory,'editorial');
  assert.equal(overridden.classification.pageType,original.classification.pageType);
  assert.equal(overridden.classification.pageType,'article');
  assert.equal(overridden.classification.ownership.brand,true);
  for(const host of ['forbes.com','x.www.forbes.com'])assert.equal(classify(`https://${host}/ambiguous`,null).classification.publisherBasis,'elmo-automatic');
  assert.equal(createCitationClassifier({...input,overrides:[]})(url,null).classification.publisherCategory,'editorial');
});

test('Google source surface recognition uses pinned actual domains and keeps wrappers separate',()=>{
  const classify=plain();
  assert.match(googleDomainsVersion,/^google-supported-2026-10-13-sha256-[a-f0-9]{64}$/);
  for(const host of ['google.com','www.google.ae','google.co.uk','deep.google.co.jp','google.cat']){
    assert.equal(classify(`https://${host}/search?q=product&prds=productid%3A1`,null).classification.sourceType,'google_shopping');
    assert.equal(classify(`https://${host}/search?q=ten98`,null).classification.sourceType,'google_search');
    assert.equal(classify(`https://${host}/url?url=https://acme.org`,null).classification.sourceType,'google_wrapper');
    assert.equal(classify(`https://${host}/alerts`,null).classification.sourceType,'publisher');
  }
  for(const host of ['google.evil.com','google.com.evil.org','notgoogle.com','google.xyz','google.co.evil.uk']){
    for(const path of ['/search?q=product&udm=28','/search?q=ten98','/goto?url=x'])assert.equal(classify(`https://${host}${path}`,null).classification.sourceType,'publisher',host);
  }
});

test('untrackable retained hosts stay visible as unclassified and malformed evidence is rejected',()=>{
  const classify=plain();
  for(const url of ['https://127.0.0.1/a','https://[::1]/a','https://localhost/a','https://service.internal/a','https://foo.test/a']){
    const row=classify(url,null);
    assert.equal(row.hostname,null);assert.equal(row.trackable,false);
    assert.equal(row.classification.sourceType,'unclassified');assert.equal(row.classification.publisherBasis,'unclassified');
    assert.equal(row.classification.publisherCategory,'other');
    assert.equal(groupCitationUrl(`${url}#part`,'retained-fragment-v1'),url);
  }
  for(const url of ['http://acme.org/','javascript:alert(1)','https://user:pass@acme.org/','https://acme.org/\0','https://acme.org/\ud800','https://acme.org/'+ 'a'.repeat(2048)]){
    assert.throws(()=>classify(url,null));assert.throws(()=>groupCitationUrl(url,'retained-fragment-v1'));
  }
  assert.throws(()=>classify('https://acme.org/','\ud800'));
  assert.doesNotThrow(()=>classify('https://acme.org/', '🎉'.repeat(300)));
  assert.throws(()=>createCitationClassifier({brandDomains:['private.internal'],competitors:[],overrides:[]}));
});

test('URL grouping preserves retained distinctions by default and implements exact optional Elmo behavior',()=>{
  const retained='https://www.Acme.org/Path//?q=a%20b&utm_source=openai&utm_source=news#part:~:text=quote&other=1';
  assert.equal(groupCitationUrl(retained,'retained-fragment-v1'),'https://www.acme.org/Path//?q=a%20b&utm_source=openai&utm_source=news');
  assert.equal(groupCitationUrl(retained,'elmo-url-v1'),'https://acme.org/Path/?q=a+b#part&other=1');
  const firstOther='https://www.acme.org/?utm_source=news&utm_source=openai#part';
  assert.equal(groupCitationUrl(firstOther,'elmo-url-v1'),'https://acme.org/?utm_source=news&utm_source=openai#part');
  assert.equal(groupCitationUrl('https://www.acme.org/?utm_source=OpenAI','elmo-url-v1'),'https://acme.org/?utm_source=OpenAI');
  // Verified against the pinned upstream function: the serialized empty fragment remains '#'.
  assert.equal(groupCitationUrl('https://www.acme.org/#:~:text=quote','elmo-url-v1'),'https://acme.org/#');
  assert.equal(retained,'https://www.Acme.org/Path//?q=a%20b&utm_source=openai&utm_source=news#part:~:text=quote&other=1');
});
