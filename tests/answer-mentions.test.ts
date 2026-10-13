import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {matchAnswer,AnswerMentionError,type MentionMethod,type MentionSubject} from '../src/server/answer-mentions.ts';

const subject=(values:Partial<MentionSubject>={}):MentionSubject=>({id:'brand',name:'Acme',aliases:['Acme Group'],domains:['example.com'],...values});
const run=(text:string,method:MentionMethod='unicode-boundary-v1',subjects=[subject()],citationUrls:string[]=[])=>matchAnswer({text,method,subjects,citationUrls});
const invalid=(input:unknown)=>assert.throws(()=>matchAnswer(input as any),error=>error instanceof AnswerMentionError&&error.message==='The answer matching input is invalid or exceeds its limit.');
const base=()=>({text:'Acme',subjects:[subject()],citationUrls:[],method:'unicode-boundary-v1'});

test('literal mentions are boolean, deterministic, independent of sentiment and never infer citations',()=>{
 for(const method of ['elmo-substring-v1','unicode-boundary-v1']as const){
  assert.deepEqual(run('Acme Group is poor; ACME and Acme repeat.',method),[{id:'brand',mentioned:true,matchedTerm:'Acme',cited:false,citationIndexes:[]}]);
  assert.deepEqual(run('No named provider here.',method),[{id:'brand',mentioned:false,matchedTerm:null,cited:false,citationIndexes:[]}]);
  assert.equal(run('Acme Group first, then Acme.',method)[0].matchedTerm,'Acme');
  assert.equal(run('The other supplier works.',method,[subject({aliases:['other supplier']})])[0].matchedTerm,'other supplier');
 }
 assert.deepEqual(run('', 'unicode-boundary-v1',[],[]),[]);
});

test('explicit matcher versions preserve substring baseline while separating URLs, emails and word boundaries',()=>{
 const short=[subject({name:'AI',aliases:[],domains:[]})];
 assert.equal(run('Paid service','elmo-substring-v1',short)[0].mentioned,true);
 assert.equal(run('Paid service','unicode-boundary-v1',short)[0].mentioned,false);
 for(const text of ['preAcme','Acme_post','Acme123','Acme\u0301'])assert.equal(run(text)[0].mentioned,false,text);
 for(const text of ['https://host.test/Acme','WWW.host.test/Acme','Acme@example.net']){
  assert.equal(run(text,'elmo-substring-v1')[0].mentioned,true,text);
  assert.equal(run(text)[0].mentioned,false,text);
 }
 assert.equal(run('https://host.test/Acme and Acme afterward')[0].mentioned,true);
 assert.equal(run('example.com only','elmo-substring-v1')[0].matchedTerm,'example.com');
 assert.equal(run('example.com only')[0].mentioned,false);
 for(const text of ['(AI)','AI.','A'])assert.equal(run(text,'unicode-boundary-v1',[subject({name:text==='A'?'A':'AI',aliases:[],domains:[]})])[0].mentioned,true);
});

test('Unicode canonical forms, literal punctuation and flexible whitespace have declared semantics',()=>{
 const unicode=[subject({name:'Café',aliases:[],domains:[]})];
 assert.equal(run('CAFE\u0301','unicode-boundary-v1',unicode)[0].mentioned,true);
 assert.equal(run('CAFE\u0301','elmo-substring-v1',unicode)[0].mentioned,false);
 assert.equal(run('Cafe','unicode-boundary-v1',unicode)[0].mentioned,false);
 assert.equal(run('İ','unicode-boundary-v1',[subject({name:'İ',aliases:[],domains:[]})])[0].mentioned,true);
 assert.equal(run('İ','unicode-boundary-v1',[subject({name:'I',aliases:[],domains:[]})])[0].mentioned,false);
 assert.equal(run('Acme\n \tGroup','unicode-boundary-v1',[subject({name:'Acme Group',aliases:[],domains:[]})])[0].mentioned,true);
 assert.equal(run('Acme\n Group','elmo-substring-v1',[subject({name:'Acme Group',aliases:[],domains:[]})])[0].mentioned,false);
 for(const name of ['C++','A.B','(Acme)','Acme[1]','a|b','.*']){
  assert.equal(run('Use '+name+' today','unicode-boundary-v1',[subject({name,aliases:[],domains:[]})])[0].mentioned,true,name);
  assert.equal(run('Unrelated product','unicode-boundary-v1',[subject({name,aliases:[],domains:[]})])[0].mentioned,false,name);
 }
 assert.equal(run('شركة أكمي ممتازة','unicode-boundary-v1',[subject({name:'أكمي',aliases:[],domains:[]})])[0].mentioned,true);
});

test('citation evidence uses exact normalized host identity and original annotation indexes',()=>{
 const urls=['https://EXAMPLE.com/path','http://sub.example.com:8080/a','https://example.com.evil.test/','https://example.com@evil.test/','ftp://example.com/','not a URL','https://www.example.com./','https://user:secret@example.com/','https://example.com/again','https://bad..example.com/'];
 for(const method of ['elmo-substring-v1','unicode-boundary-v1']as const){
  assert.deepEqual(run('Unrelated prose',method,[subject()],urls),[{id:'brand',mentioned:false,matchedTerm:null,cited:true,citationIndexes:[0,1,6,8]}]);
  assert.deepEqual(run('Acme',method,[subject()],[])[0].citationIndexes,[]);
 }
 assert.deepEqual(run('', 'unicode-boundary-v1',[subject({domains:['WWW.BÜCHER.example.']})],['https://xn--bcher-kva.example/','https://www.bücher.example/','https://xn--bcher-kva.example.evil/'])[0].citationIndexes,[0,1]);
 const two=run('Acme Beta','unicode-boundary-v1',[subject(),subject({id:'competitor',name:'Beta',aliases:[],domains:['example.com']})],['https://sub.example.com/']);
 assert.deepEqual(two.map(row=>({id:row.id,mentioned:row.mentioned,cited:row.cited})),[{id:'brand',mentioned:true,cited:true},{id:'competitor',mentioned:true,cited:true}]);
});

test('malformed shapes and unsafe identity/domain inputs fail with one safe error',()=>{
 for(const input of [null,[],{}, {...base(),method:'guess'}, {...base(),text:1},{...base(),text:'\uD800'}, {...base(),subjects:new Array(1)},{...base(),citationUrls:new Array(1)},{...base(),subjects:[subject(),subject()]},{...base(),subjects:[null]},{...base(),citationUrls:[null]},{...base(),citationUrls:['x'.repeat(8193)]},{...base(),citationUrls:['\uD800']}])invalid(input);
 for(const value of ['', ' leading','trailing ','new\nline','\uD800','x'.repeat(513)])invalid({...base(),subjects:[subject({name:value})]});
 for(const value of ['', ' leading','trailing ','new\nline','\uD800','x'.repeat(101)])invalid({...base(),subjects:[subject({id:value})]});
 for(const domains of [['https://example.com'],['user@example.com'],['example.com:443'],['example.com/path'],['example.com\\path'],['example.com?x'],['example.com#x'],['%65xample.com'],['example .com'],['example..com'],['-bad.example'],['bad-.example'],['a'.repeat(64)+'.example'],['localhost'],['127.0.0.1'],['[::1]']])invalid({...base(),subjects:[subject({domains})]});
 for(const aliases of [[''],['\uD800'],['x'.repeat(513)],new Array(1),Array.from({length:21},(_,i)=>'Alias'+i)])invalid({...base(),subjects:[subject({aliases})]});
 invalid({...base(),subjects:[subject({domains:Array(5).fill('é'.repeat(46)).join('.') as any})]});
 invalid({...base(),subjects:[subject({domains:[Array(5).fill('é'.repeat(46)).join('.')]})]});
 invalid({...base(),subjects:Array.from({length:102},(_,i)=>subject({id:String(i)}))});invalid({...base(),citationUrls:Array.from({length:101},()=> '')});invalid({...base(),text:'x'.repeat(250001)});
});

test('deduplicated term work limit is enforced before scanning without silent truncation',()=>{
 const input=base();input.text='x'.repeat(250000);input.subjects=[subject({name:'Acme',aliases:Array(20).fill('ACME'),domains:Array(20).fill('EXAMPLE.com')})];assert.equal(matchAnswer(input as any).length,1);
 const subjects=Array.from({length:101},(_,i)=>subject({id:String(i),name:'Term'+i,aliases:[],domains:[]}));
 invalid({...base(),text:'x'.repeat(200000),subjects});
 assert.equal(run('x'.repeat(200000),'unicode-boundary-v1',subjects.slice(0,100)).length,100);
});

test('projection and repeated calls leave caller data intact with no external effects',()=>{
 const input={...base(),ignored:'not output',subjects:[{...subject(),ignored:{secret:'not output'}}]};const before=structuredClone(input);
 Object.freeze(input.subjects[0].aliases);Object.freeze(input.subjects[0].domains);Object.freeze(input.subjects[0]);Object.freeze(input.subjects);Object.freeze(input.citationUrls);Object.freeze(input);
 const first=matchAnswer(input as any),second=matchAnswer(input as any);assert.deepEqual(first,second);assert.deepEqual(input,before);assert.deepEqual(Object.keys(first[0]),['id','mentioned','matchedTerm','cited','citationIndexes']);assert.equal(JSON.stringify(first).includes('secret'),false);
});

test('long invalid address spans stay bounded instead of quadratic backtracking',()=>{
 const module=new URL('../src/server/answer-mentions.ts',import.meta.url).href;
 const code=`import {matchAnswer} from ${JSON.stringify(module)}; for(const text of ['x'.repeat(250000),'x'.repeat(249990)+'@invalid'])matchAnswer({text,subjects:[{id:'b',name:'Brand',aliases:[],domains:[]}],citationUrls:[],method:'unicode-boundary-v1'});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:2500,encoding:'utf8'});
 assert.equal(result.error,undefined,'Address masking exceeded its bounded child-process deadline.');assert.equal(result.status,0,result.stderr);
});
