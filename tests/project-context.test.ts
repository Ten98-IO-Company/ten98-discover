import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {canonicalHash,citationPublisherCategories,classifyPrompt,contextHost,keyPageUrl,parse,contextPatch,promptBatch,promptPatch} from '../src/server/context-input.ts';
import {contentCursor,readContentCursor} from '../src/server/project-context.ts';

test('context metadata preserves exact hosts, schemes and meaningful query URLs without credentials',()=>{
  assert.equal(contextHost('BÜCHER.example.com.'),'xn--bcher-kva.example.com');
  assert.notEqual(contextHost('www.example.com'),contextHost('example.com'));
  assert.equal(keyPageUrl('http://www.example.com/p?q=one#fragment'),'http://www.example.com/p?q=one');
  for(const host of ['localhost','127.0.0.1','2130706433','0x7f000001','example.com:443','https://example.com','a..example.com','*.example.com','x.local','example.com/path']) assert.throws(()=>contextHost(host));
  for(const url of ['https://user:pass@example.com/a','javascript:alert(1)','https://example.com/a\nb','https://localhost/a','https://example.com/\0']) assert.throws(()=>keyPageUrl(url));
});
test('strict bounded context input distinguishes absent fields from explicit clearing',()=>{
  const base={revision:1,requestId:randomUUID()};
  const input=parse(contextPatch,{...base,updates:[{kind:'competitor',primaryDomain:'example.com',notes:''},{kind:'key-page',url:'https://example.com/',topic:''}]});
  assert.equal('name' in input.updates[0],false);assert.equal((input.updates[0] as {notes:string}).notes,'');
  for(const op of [{kind:'section',key:'current_goal',content:'x'.repeat(4001)},{kind:'section',key:'custom:bad_slug',content:'x'},{kind:'research',summary:'\0'},{kind:'research',summary:'x',createdBy:'forged'},{kind:'profile',aliases:Array(21).fill('Alias')}]) assert.throws(()=>parse(contextPatch,{...base,updates:[op]}));
  assert.throws(()=>parse(contextPatch,{...base,updates:Array(51).fill({kind:'research',summary:'x'})}));
  assert.throws(()=>parse(contextPatch,{...base,updates:[{kind:'research',summary:'\ud800'}]}));
});
test('citation context operations normalize exact hosts and distinguish explicit other from removing an override',()=>{
  const base={revision:1,requestId:randomUUID()};
  assert.deepEqual(citationPublisherCategories,['editorial','reviews','ecommerce','social','developer','pr','reference','institutional','other']);
  const result=parse(contextPatch,{...base,updates:[{kind:'citation-brand-domain',domain:' BÜCHER.example.com. ',action:'add'},{kind:'citation-category',domain:'WWW.example.com',category:'other'},{kind:'citation-category',domain:'example.com',category:null}]});
  assert.deepEqual(result.updates,[{kind:'citation-brand-domain',domain:'xn--bcher-kva.example.com',action:'add'},{kind:'citation-category',domain:'www.example.com',category:'other'},{kind:'citation-category',domain:'example.com',category:null}]);
  for(const op of [
    {kind:'citation-brand-domain',domain:'example.com',action:'verify'},
    {kind:'citation-brand-domain',domain:'example.com',action:'add',verified:true},
    {kind:'citation-brand-domain',domain:'127.0.0.1',action:'add'},
    {kind:'citation-brand-domain',domain:'https://example.com',action:'remove'},
    {kind:'citation-category',domain:'example.com',category:'editorial\n'},
    {kind:'citation-category',domain:'example.com',category:undefined},
    {kind:'citation-category',domain:'*.example.com',category:'social'},
    {kind:'citation-category',domain:'example.com',category:'other',projectId:randomUUID()},
  ]) assert.throws(()=>parse(contextPatch,{...base,updates:[op]}));
});
test('prompt text remains exact after trim, user tags normalize, and system fields are not writable',()=>{
  const result=parse(promptBatch,{requestId:randomUUID(),prompts:[{text:'  Exact CASE?\nSecond line.  ',tags:['TOPIC','topic','branded']}]});
  assert.equal(result.prompts[0].text,'Exact CASE?\nSecond line.');assert.deepEqual(result.prompts[0].tags,['topic','branded']);
  for(const entry of [{text:'x',systemTags:['branded']},{text:'x'.repeat(2001)},{text:' '},{text:'x',tags:['x'.repeat(81)]}]) assert.throws(()=>parse(promptBatch,{requestId:randomUUID(),prompts:[entry]}));
  assert.throws(()=>parse(promptPatch,{revision:1,requestId:randomUUID()}));
});
test('documented Elmo substring classifier preserves manual override matrix and alias behavior',()=>{
  const classify=(value:string,tags:string[]=[])=>classifyPrompt(value,'Acme Corp','https://www.acmecorp.com',['Acme Inc.'],tags);
  assert.equal(classify('ACME CORP products').isBranded,true);
  assert.equal(classify('acmecorp alternatives').isBranded,true);
  assert.equal(classify('Acme Inc. pricing').isBranded,true);
  assert.equal(classify('generic shoes').isBranded,false);
  assert.deepEqual(classify('generic shoes',['branded']),{isBranded:true,systemIsBranded:false,isOverridden:true,version:'elmo-substring-v1'});
  assert.equal(classify('Acme Corp',['unbranded']).isBranded,false);
  assert.equal(classify('Acme Corp',['branded','unbranded']).isBranded,true);
  assert.equal(classify('generic shoes',['branded','unbranded']).isBranded,false);
  assert.equal(classifyPrompt('chair','AI','https://brand.example.com',[],[]).isBranded,true,'Substring false positives remain an explicitly versioned heuristic.');
});
test('content fingerprints are order-stable and page cursors are project/filter bound',()=>{
  assert.equal(canonicalHash({a:1,b:[2,3]}),canonicalHash({b:[2,3],a:1}));
  assert.notEqual(canonicalHash({b:[2,3]}),canonicalHash({b:[3,2]}));
  const scope={projectId:randomUUID(),status:'active'},cursor=contentCursor({id:randomUUID(),createdAt:new Date()},scope);
  assert.ok(readContentCursor(cursor,scope));
  assert.throws(()=>readContentCursor(cursor,{...scope,status:'archived'}));
  assert.throws(()=>readContentCursor(cursor,{...scope,projectId:randomUUID()}));
  for(const value of ['@','eA','x'.repeat(513)]) assert.throws(()=>readContentCursor(value,scope));
});
