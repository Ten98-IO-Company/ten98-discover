import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseIdentifyInput,identifyBodyLimit} from '../src/server/identify-input.ts';
import {InputError,readJson} from '../src/server/validation.ts';
const siteKey='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333';
const valid=()=>({type:'identify',siteKey,requestId,sentAt:'2026-10-14T16:20:30.12+04:00',url:'https://example.test/page',properties:{}});
const rejects=(value:unknown)=>assert.throws(()=>parseIdentifyInput(value),(error:unknown)=>error instanceof InputError&&error.status===400&&!error.message.includes('secret-sentinel'));

test('identify canonicalizes immutable sentAt and typed patches without copying identity into properties',()=>{
  const properties={empty:'',zero:0,off:false,nil:null,date:'2024-02-29T23:59:59.123456789+04:00',array:[1,'1',null,false],nested:{id:'caller metadata',value:2},'nested.value':3};
  const raw={...valid(),properties,dimensions:{distinctId:'explicit-id'},context:'opaque',consent:{analytics:true,epoch}};
  const result=parseIdentifyInput(raw);
  assert.equal(result.sentAt,'2026-10-14T12:20:30.120Z');assert.deepEqual(result.dimensions,{distinctId:'explicit-id'});assert.equal(result.properties.id,undefined);
  assert.deepEqual(result.properties,{empty:{type:'string',value:''},zero:{type:'number',value:0},off:{type:'boolean',value:false},nil:{type:'null',value:null},date:{type:'date',value:'2024-02-29T19:59:59.123456789Z'},array:{type:'array',value:[1,'1',null,false]},'nested.id':{type:'string',value:'caller metadata'},'nested.value':{type:'number',value:2},'nested\\.value':{type:'number',value:3}});
  assert.deepEqual(result.consent,{analytics:true,epoch});assert.equal(result.context,'opaque');assert.equal(raw.sentAt,'2026-10-14T16:20:30.12+04:00');
  assert.deepEqual(parseIdentifyInput({...raw,sentAt:'2026-10-14T12:20:30.120Z'}),result,'Equivalent timestamp spellings define the same normalized operation.');
  properties.array[0]=9;assert.deepEqual(result.properties.array,{type:'array',value:[1,'1',null,false]});
  assert.deepEqual(parseIdentifyInput({...valid(),dimensions:{distinctId:'only-id'}}).properties,{});
  assert.equal(Object.hasOwn(parseIdentifyInput(valid()),'dimensions'),false);assert.equal(Object.hasOwn(parseIdentifyInput(valid()),'consent'),false);
});

test('sentAt is bounded millisecond RFC3339 syntax, and pure parsing never checks current age or consent',()=>{
  const now=Date.now;Date.now=()=>{throw new Error('The pure parser must not read the clock.');};
  try{for(const sentAt of ['1970-01-01T00:00:00Z','2099-12-31T23:59:59.999Z','9998-12-31T23:59:59.999Z'])assert.equal(parseIdentifyInput({...valid(),sentAt}).sentAt,new Date(sentAt).toISOString());}finally{Date.now=now;}
  assert.equal(parseIdentifyInput({...valid(),sentAt:'1969-12-31T23:00:00-01:00'}).sentAt,'1970-01-01T00:00:00.000Z');
  for(const sentAt of [0,new Date(),'', '2026-10-14','2026-10-14T12:00:00','2026-10-14T12:00:00-00:00','2026-10-14t12:00:00z','2026-02-30T12:00:00Z','2026-10-14T12:00:60Z','2026-10-14T12:00:00.1234Z','1969-12-31T23:59:59.999Z','9999-01-01T00:00:00Z','2026-10-14T12:00:00+24:00','2026-10-14T12:00:00Z\n'])rejects({...valid(),sentAt});
});

test('identify rejects event fields, persistence metadata, ambiguous identity shortcuts and unknown nested fields',()=>{
  for(const key of ['type','siteKey','requestId','sentAt','url','properties']){const raw:Record<string,unknown>=valid();delete raw[key];rejects(raw);}
  for(const extra of [{type:'event'},{siteKey:'bad'},{requestId:'bad'},{eventId:requestId},{name:'page_view'},{unset:['plan']},{visitorId:'secret-sentinel'},{ip:'secret-sentinel'},{userAgent:'secret-sentinel'},{receivedAt:'2026-10-14T00:00:00Z'},{context:undefined},{consent:{analytics:false,epoch}},{consent:{analytics:true,epoch,advertising:true}},{dimensions:{distinctId:'ok',language:'en'}},{dimensions:{referrer:'https://example.test'}}])rejects({...valid(),...extra});
  for(const id of ['secret-sentinel',null,{},false,undefined])rejects({...valid(),properties:{id}});
  for(const properties of [undefined,null,[],42])rejects({...valid(),properties});
  for(const distinctId of ['',null,undefined,'a'.repeat(257),'\n','\0','\ud800'])rejects({...valid(),dimensions:{distinctId}});
  assert.equal(parseIdentifyInput({...valid(),dimensions:{distinctId:'🐎'.repeat(128)}}).dimensions?.distinctId?.length,256);
  rejects({...valid(),dimensions:{distinctId:'🐎'.repeat(129)}});
});

test('shared URL/context guards retain native limits and reject unsafe or malformed text',()=>{
  for(const url of ['ftp://example.test/','https://user:secret-sentinel@example.test/','not a URL','https://example.test/'+'a'.repeat(2048),'https://example.test/\ud800'])rejects({...valid(),url});
  assert.equal(parseIdentifyInput({...valid(),url:'https://example.test/path?query=value#fragment'}).url,'https://example.test/path?query=value#fragment');
  assert.equal(parseIdentifyInput({...valid(),context:'🐎'.repeat(512)}).context?.length,1024);
  for(const context of ['a'.repeat(1025),'🐎'.repeat(513),'\ud800','\0'])rejects({...valid(),context});
});

test('identify reuses native50-leaf, Unicode, scalar, array, depth and property byte caps',()=>{
  assert.equal(Object.keys(parseIdentifyInput({...valid(),properties:Object.fromEntries(Array.from({length:50},(_,i)=>['k'+i,i]))}).properties).length,50);
  rejects({...valid(),properties:Object.fromEntries(Array.from({length:51},(_,i)=>['k'+i,i]))});
  for(const properties of [{text:'x'.repeat(1001)},{n:1e15+1},{n:Infinity},{n:NaN},{a:Array(51).fill(0)},{a:[{}]},{a:{b:{c:{d:{e:1}}}}},Object.fromEntries(Array.from({length:7},(_,i)=>['k'+i,'x'.repeat(1000)])),{'\ud800':0},{x:'\0'}])rejects({...valid(),properties});
  assert.deepEqual(parseIdentifyInput({...valid(),properties:{text:'🐎'.repeat(500),n:1e15}}).properties.text,{type:'string',value:'🐎'.repeat(500)});
  rejects({...valid(),properties:{text:'🐎'.repeat(501)}});
});

test('data-only parsing rejects accessors, proxies and hidden fields without invoking application hooks',()=>{
  let invoked=0;const getter={get properties(){invoked++;return {};}};
  rejects(Object.defineProperty(valid(),'properties',Object.getOwnPropertyDescriptor(getter,'properties')!));
  const consent=Object.defineProperty({epoch},'analytics',{enumerable:true,get(){invoked++;return true;}});rejects({...valid(),consent});
  const props=Object.defineProperty({},'plan',{enumerable:true,get(){invoked++;return 'pro';}});rejects({...valid(),properties:props});
  rejects({...valid(),dimensions:new Proxy({},{ownKeys(){invoked++;return [];}})});rejects(new Proxy(valid(),{get(){invoked++;return undefined;}}));
  rejects(Object.defineProperty(valid(),'hidden',{value:1}));rejects({...valid(),properties:{toJSON(){invoked++;return {};}}});
  const sparse:unknown[]=[];sparse.length=1;rejects({...valid(),properties:{values:sparse}});assert.equal(invoked,0);
});

test('the identify HTTP seam keeps the existing16KiB decoded body boundary',async()=>{
  const payload=JSON.stringify(valid()),request=(text:string)=>new Request('http://localhost/api/collect',{method:'POST',headers:{'content-type':'application/json'},body:text});
  const atLimit=payload+' '.repeat(identifyBodyLimit-Buffer.byteLength(payload));
  assert.deepEqual(parseIdentifyInput(await readJson(request(atLimit),identifyBodyLimit)),parseIdentifyInput(valid()));
  await assert.rejects(readJson(request(atLimit+' '),identifyBodyLimit),(error:unknown)=>error instanceof InputError&&error.status===413);
});
