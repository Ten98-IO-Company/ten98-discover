import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalHash} from '../src/server/context-input.ts';
import {queryDerivationVersion} from '../src/server/ai-search-evidence.ts';
import {createContentSupportSnapshot,contentSupportMessages,contentSupportQueryId,contentSupportSchema,contentSupportLimits,parseContentSupportProposal,type ContentSupportSnapshot} from '../src/server/ai-content-support-input.ts';

const sha=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const query=(key='coffee')=>({id:canonicalHash({derivationVersion:queryDerivationVersion,key}),key});
const page=(body='  Café\n😀 coffee and شاي.  ')=>(()=>({id:randomUUID(),bodySha256:sha(body),body}))();
const selection=()=>({derivationVersion:queryDerivationVersion,source:{kind:'capture' as 'capture'|'project',queryReceiptHash:'a'.repeat(64),corpusReceiptHash:'b'.repeat(64)},queries:[query()],pages:[page()],exclusions:{queries:4,pages:7}});
const snapshot=()=>createContentSupportSnapshot(selection());
const citation=(s:ContentSupportSnapshot,start=0,end=s.pages[0].body.length)=>({pageId:s.pages[0].id,bodySha256:s.pages[0].bodySha256,start,end,quote:s.pages[0].body.slice(start,end)});
const proposal=(s:ContentSupportSnapshot)=>({version:1,rows:s.queries.map(q=>({queryId:q.id,state:'supported',rationale:'  Unverified model explanation.  ',citations:[citation(s)]}))});
const read=(s:ContentSupportSnapshot,p:unknown,reason='stop')=>parseContentSupportProposal(JSON.stringify(p),s,reason);

test('closed-corpus snapshot preserves original evidence bytes and deterministic derived IDs without claiming authority',()=>{
 const input=selection(),before=structuredClone(input),s=createContentSupportSnapshot(input),messages=contentSupportMessages(s);assert.deepEqual(input,before);assert.deepEqual(JSON.parse(messages[1].content),s);assert.equal(s.pages[0].body,input.pages[0].body);assert.equal(s.queries[0].id,contentSupportQueryId('coffee'));assert.deepEqual(s.exclusions,{queries:4,pages:7});
 assert.equal(s.purpose,'website-content-support');assert.match(messages[0].content,/untrusted reference data/);assert.match(messages[0].content,/unverified model judgments/);assert.equal(messages.length,2);assert.deepEqual(Object.keys(messages[0]).sort(),['content','role']);
 input.pages[0].body='later mutation';assert.notEqual(s.pages[0].body,input.pages[0].body);
 for(const mutate of [(v:ReturnType<typeof selection>)=>Object.assign(v,{extra:true}),(v:ReturnType<typeof selection>)=>{v.source.queryReceiptHash='no';},(v:ReturnType<typeof selection>)=>{v.pages[0].body+='changed';},(v:ReturnType<typeof selection>)=>{v.queries[0].key='changed';},(v:ReturnType<typeof selection>)=>{v.queries[0]=query(' COFFEE ');},(v:ReturnType<typeof selection>)=>{v.pages[0]=page('broken\ud800');},(v:ReturnType<typeof selection>)=>{v.pages[0]=page('null\0');}]){const v=selection();mutate(v);assert.throws(()=>createContentSupportSnapshot(v),{status:400});}
 const v=selection();v.queries=[query('i\u0307'.repeat(2000))];assert.equal(createContentSupportSnapshot(v).queries[0].key.length,4000);v.queries=[query('x'.repeat(4001))];assert.throws(()=>createContentSupportSnapshot(v),{status:400});
});

test('one to five queries and one to twenty pages are explicit and unique; empty-only evidence refuses before quote',()=>{
 const v=selection();v.queries=Array.from({length:5},(_,i)=>query('query '+i));v.pages=Array.from({length:20},()=>page('text'));assert.equal(createContentSupportSnapshot(v).queries.length,5);assert.equal(createContentSupportSnapshot(v).pages.length,20);
 for(const change of [(x:typeof v)=>{x.queries=[];},(x:typeof v)=>{x.queries.push(query('sixth'));},(x:typeof v)=>{x.queries[1]=x.queries[0];},(x:typeof v)=>{x.pages=[];},(x:typeof v)=>{x.pages.push(page('extra'));},(x:typeof v)=>{x.pages[1]=x.pages[0];}]){const x=structuredClone(v);change(x);assert.throws(()=>createContentSupportSnapshot(x),{status:400});}
 for(const body of ['',' \r\n\t\u2003']){const x=selection();x.pages=[page(body)];assert.throws(()=>createContentSupportSnapshot(x),{status:400});}
 const x=selection();x.pages=[page(''),page('actual text')];assert.equal(createContentSupportSnapshot(x).pages[0].body,'');
});

test('complete body and message/schema limits count UTF-8 without excerpting or truncating',()=>{
 const v=selection();v.pages=[page('😀'.repeat(16384))];const s=createContentSupportSnapshot(v);assert.equal(Buffer.byteLength(s.pages[0].body),65_536);assert.deepEqual(JSON.parse(contentSupportMessages(s)[1].content).pages,s.pages);
 v.pages=[page('😀'.repeat(16384)+'x')];assert.throws(()=>createContentSupportSnapshot(v),{status:413});
 v.pages=[page('x'.repeat(32768)),page('y'.repeat(32768))];assert.equal(createContentSupportSnapshot(v).pages.length,2);v.pages.push(page('z'));assert.throws(()=>createContentSupportSnapshot(v),{status:413});
 const escaped=selection();escaped.pages=[page('x'+'\u0001'.repeat(15000))];const base=createContentSupportSnapshot(escaped),initial=contentSupportMessages(base),bytes=Buffer.byteLength(JSON.stringify({messages:initial,schema:contentSupportSchema})),filler=contentSupportLimits.messageSchemaBytes-bytes;assert.ok(filler>0);escaped.pages=[{...escaped.pages[0],body:escaped.pages[0].body+'x'.repeat(filler),bodySha256:''}];escaped.pages[0].bodySha256=sha(escaped.pages[0].body);assert.ok(Buffer.byteLength(escaped.pages[0].body)<65_536);
 const exact=createContentSupportSnapshot(escaped);assert.equal(Buffer.byteLength(JSON.stringify({messages:contentSupportMessages(exact),schema:contentSupportSchema})),131_072);escaped.pages[0].body+='x';escaped.pages[0].bodySha256=sha(escaped.pages[0].body);assert.throws(()=>contentSupportMessages(createContentSupportSnapshot(escaped)),{status:413});
});

test('exact multilingual/UTF-16 citations and rationale remain untouched while semantic judgment stays unverified',()=>{
 const s=snapshot(),p=proposal(s),before=structuredClone(p),out=read(s,p);assert.deepEqual(p,before);assert.deepEqual(out.rows,p.rows);assert.equal(out.semanticConclusions,'unverified');assert.equal(out.evidenceValidation,'exact-supplied-spans-v1');
 const emoji=s.pages[0].body.indexOf('😀');p.rows[0].citations=[citation(s,emoji,emoji+2)];assert.equal(read(s,p).rows[0].citations[0].quote,'😀');
 // A valid but irrelevant quote verifies provenance, never the model's semantic conclusion.
 p.rows[0].rationale='The moon is made of cheese.';assert.equal(read(s,p).semanticConclusions,'unverified');
 const two=selection();two.source.kind='project';two.queries=[query('coffee'),query('شاي')];const paired=createContentSupportSnapshot(two),both=proposal(paired);both.rows.reverse();assert.equal(read(paired,both).rows.length,2);
});

test('strict complete output rejects unknown, missing, duplicate or foreign rows and unsupported conclusions',()=>{
 const s=snapshot(),p=proposal(s);
 for(const value of [{...p,extra:true},{...p,version:2},{...p,rows:[]},{...p,rows:[p.rows[0],p.rows[0]]},{...p,rows:[{...p.rows[0],queryId:'f'.repeat(64)}]},{...p,rows:[{...p.rows[0],extra:true}]},{...p,rows:[{...p.rows[0],state:'true'}]},{...p,rows:[{...p.rows[0],rationale:' '}]},{...p,rows:[{...p.rows[0],rationale:'x'.repeat(281)}]},{...p,rows:[{...p.rows[0],rationale:'bad\ud800'}]}])assert.throws(()=>read(s,value),{status:502});
 for(const state of ['supported','partly_supported']){const v=proposal(s);v.rows[0].state=state;v.rows[0].citations=[];assert.throws(()=>read(s,v),{status:502});}
 for(const state of ['not_supported_in_supplied_text','insufficient_evidence']){const v=proposal(s);v.rows[0].state=state;v.rows[0].citations=[];assert.equal(read(s,v).rows[0].state,state);}
 const v=selection();v.queries=[query('one'),query('two')];const two=createContentSupportSnapshot(v),bad=proposal(two);bad.rows[1]=bad.rows[0];assert.throws(()=>read(two,bad),{status:502});bad.rows.pop();assert.throws(()=>read(two,bad),{status:502});
});

test('all citation IDs, hashes, exact whitespace, ranges and surrogate boundaries are verified as a whole',()=>{
 const s=snapshot(),p=proposal(s),c=citation(s),emoji=s.pages[0].body.indexOf('😀');
 for(const bad of [{...c,pageId:randomUUID()},{...c,bodySha256:'f'.repeat(64)},{...c,extra:true},{...c,quote:c.quote.trim()},{...c,start:-1},{...c,start:0.5},{...c,start:c.end},{...c,end:c.end+1},{...c,end:Number.MAX_SAFE_INTEGER+1},{...c,quote:''},{...c,quote:'x'.repeat(281)},{...c,start:emoji+1,quote:s.pages[0].body.slice(emoji+1,c.end)},{...c,end:emoji+1,quote:s.pages[0].body.slice(0,emoji+1)}]){const v=structuredClone(p);v.rows[0].citations=[bad];assert.throws(()=>read(s,v),{status:502});}
 const v=structuredClone(p);v.rows[0].citations=[c,c,c,c];assert.throws(()=>read(s,v),{status:502});const changed=structuredClone(s);changed.pages[0].body+='x';assert.throws(()=>read(changed,p),{status:502});
});

test('provider completion and whole local output limits fail closed without manufacturing a measured zero',()=>{
 const s=snapshot(),p=proposal(s),raw=JSON.stringify(p);for(const reason of ['length','content_filter','tool_calls','error',''])assert.throws(()=>parseContentSupportProposal(raw,s,reason),{status:502});
 for(const invalid of ['not JSON',raw.slice(0,-1),'[]','null',raw+'\0','{"version":1,"rows":[],"extra":true}'])assert.throws(()=>parseContentSupportProposal(invalid,s,'stop'),{status:502});
 const padding=65_536-Buffer.byteLength(raw);assert.ok(padding>0);assert.equal(parseContentSupportProposal(raw+' '.repeat(padding),s,'stop').rows.length,1);assert.throws(()=>parseContentSupportProposal(raw+' '.repeat(padding+1),s,'stop'),{status:502});
 assert.deepEqual(contentSupportLimits,{queries:5,pages:20,bodyBytes:65_536,messageSchemaBytes:131_072,requestBytes:163_840,outputTokens:2048,resultBytes:65_536,transportBytes:2_097_152});
});
