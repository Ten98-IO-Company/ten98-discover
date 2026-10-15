import assert from 'node:assert/strict';
import {test} from 'node:test';
import {googleInspectionInput,googleInspectionResponse,inspectionUrlInProperty} from '../src/server/google-inspection-input.ts';
import {safeGoogleString} from '../src/server/google-reports.ts';
import {googleRequest,withGoogleTransportForTests} from '../src/server/google-http.ts';

test('inspection validates an explicit bounded batch and canonical language without accepting alternate fields',()=>{
  assert.deepEqual(googleInspectionInput.parse({urls:['https://EXAMPLE.test/a'],languageCode:'ar-ae'}),{urls:['https://example.test/a'],languageCode:'ar-AE'});
  for(const input of [{urls:[]},{urls:Array(11).fill('https://example.test/a')},{urls:['https://example.test/a','https://EXAMPLE.test/a']},{urls:['https://example.test/'],siteUrl:'sc-domain:other.test'},{urls:['https://example.test/'],languageCode:'bad_language'}])assert.equal(googleInspectionInput.safeParse(input).success,false);
  for(const value of ['file:///secret','javascript:alert(1)','https://user:pass@example.test/','https://example.test/#fragment','https://example.test/a#','https://example.test/a b','https://example.test/\\a','https://example.test/\0','https://example.test/\ud800'])assert.equal(googleInspectionInput.safeParse({urls:[value]}).success,false);
  assert.equal(googleInspectionInput.safeParse({urls:['https://example.test/'+'ع'.repeat(1000)]}).success,false,'Encoded canonical URLs must fit before any provider request.');
});

test('browser-safe inspection strings keep the existing exact UTF-16 and scalar contract',()=>{
  for(const text of ['', '  no trimming  ', 'مرحبا 😀', '\ud800', '\udfff', 'a\0b', 'x'.repeat(4096), 'x'.repeat(4097), '😀'.repeat(2048), '😀'.repeat(2049)]){
    const expected=safeGoogleString(4096).safeParse(text),actual=googleInspectionResponse.safeParse({inspectionResult:{indexStatusResult:{coverageState:text}}});
    assert.equal(actual.success,expected.success);
    if(actual.success)assert.equal(actual.data.inspectionResult.indexStatusResult?.coverageState,text);
  }
});

test('shared Google transport refuses malformed UTF-8 and preserves valid astral JSON without network',async()=>{
  const saved={...process.env};
  try{
    for(const key of ['DATABASE_URL_FILE','AUTH_SECRET_FILE','BOOTSTRAP_TOKEN_FILE'])delete process.env[key];
    Object.assign(process.env,{TEN98_INTEGRATION_TEST:'1',APP_URL:'http://127.0.0.1:3111',DATABASE_URL:'postgres://fixture:fixture@127.0.0.1:55501/ten98_gsc_pure_unused',AUTH_SECRET:'pure-fixture-not-a-secret-'.repeat(3),BOOTSTRAP_TOKEN:'pure-fixture-not-a-token-'.repeat(3)});
    let calls=0;
    await withGoogleTransportForTests(async(target,init)=>{
      calls++;assert.equal(target,'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');assert.equal(init.redirect,'error');assert.ok(init.signal);
      return new Response(calls===1?new Uint8Array([123,34,120,34,58,34,255,34,125]):JSON.stringify({x:'مرحبا 😀'}));
    },async()=>{
      await assert.rejects(googleRequest('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect#','synthetic',{}),/Invalid Google endpoint/);assert.equal(calls,0,'An empty endpoint fragment must fail before transport.');
      await assert.rejects(googleRequest('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect','synthetic',{}),e=>e instanceof Error&&'status'in e&&e.status===502);
      assert.deepEqual(await googleRequest('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect','synthetic',{}),{x:'مرحبا 😀'});
      assert.equal(calls,2);
    });
  }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

test('saved Search Console domain and URL-prefix boundaries reject sibling hosts and escaped path confusion',()=>{
  for(const value of ['https://example.test/','http://sub.example.test/a?x=1','https://deep.sub.example.test/a'])assert.equal(inspectionUrlInProperty(value,'sc-domain:example.test'),true);
  for(const value of ['https://notexample.test/','https://example.test.evil.test/','https://example.test@evil.test/','https://other.test/'])assert.equal(inspectionUrlInProperty(value,'sc-domain:example.test'),false);
  assert.equal(inspectionUrlInProperty('https://xn--bcher-kva.test/a','sc-domain:bücher.test'),true);
  assert.equal(inspectionUrlInProperty('https://example.test/blog/post?x=1','https://example.test/blog/'),true);
  for(const value of ['http://example.test/blog/post','https://sub.example.test/blog/','https://example.test:444/blog/','https://example.test/blogger/','https://example.test/blog/../private','https://example.test/blog/%2e%2e/private','https://example.test/blog%2fprivate'])assert.equal(inspectionUrlInProperty(value,'https://example.test/blog/'),false);
  for(const property of ['sc-domain:example.test@evil.test','sc-domain:example.test/a','sc-domain:example.test:443','https://example.test/blog','https://example.test/?x=/'])assert.equal(inspectionUrlInProperty('https://example.test/blog/post',property),false);
});

test('inspection preserves missing modules, unknown provider states and source URLs; rejects unsafe provider output',()=>{
  assert.deepEqual(googleInspectionResponse.parse({inspectionResult:{}}),{inspectionResult:{}});
  const result={indexStatusResult:{verdict:'FUTURE_STATE',coverageState:'Excluded',lastCrawlTime:'2026-10-01T01:02:03.123456789Z',sitemap:['https://example.test/sitemap.xml']},richResultsResult:{verdict:'FAIL',detectedItems:[{richResultType:'Product',items:[{name:'Pump',issues:[{severity:'ERROR',issueMessage:'Missing price'}]}]}]}};
  assert.deepEqual(googleInspectionResponse.parse({inspectionResult:result}),{inspectionResult:result});
  for(const result of [{inspectionResultLink:'https://evil.test/'},{inspectionResultLink:'http://search.google.com/'},{inspectionResultLink:'https://search.google.com/search-console/inspect#'},{indexStatusResult:{googleCanonical:'javascript:alert(1)'}},{indexStatusResult:{googleCanonical:'https://example.test/a#'}},{indexStatusResult:{lastCrawlTime:'not a date'}},{indexStatusResult:{lastCrawlTime:'2026-02-30T01:02:03Z'}},{richResultsResult:{detectedItems:[{items:'invalid'}]}}])assert.equal(googleInspectionResponse.safeParse({inspectionResult:result}).success,false);
  assert.equal(googleInspectionResponse.safeParse({}).success,false);
});
