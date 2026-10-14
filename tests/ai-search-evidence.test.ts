import assert from 'node:assert/strict';
import test from 'node:test';
import {matchAnswer,type MentionMethod,type MentionSubject} from '../src/server/answer-mentions.ts';
import {
 normalizeDfsChatgptSearchEvidence as normalize,deriveSearchQueries,
 SearchEvidenceError,searchEvidenceVersion,queryDerivationVersion,queryWordsVersion,
 type SearchEvidence,type SearchDerivation,
} from '../src/server/ai-search-evidence.ts';

const errorMessage='The search evidence is invalid or exceeds its limit.';
const subject=(values:Partial<MentionSubject>={}):MentionSubject=>({id:'brand',name:'Acme',aliases:[],domains:['example.com'],...values});
const contentUnavailable={state:'unavailable',reason:'body_corpus_not_recorded'};
const emptyWords={cloud:[],added:[],dropped:[],preserved:[]};
const unknownAnswer={state:'not_recorded',text:null,basis:null};
const invalidAnswer={state:'invalid',text:null,basis:null};
const unknownQueries={state:'not_recorded',values:null};
const invalidQueries={state:'invalid',values:null};
const row=(word:string,count=1,isStop=false)=>({word,count,isStop});
const args=(evidence:SearchEvidence,values:Record<string,unknown>={})=>({
 evidence,capturedPrompt:'Which speakers?',subjects:[subject()],method:'unicode-boundary-v1' as MentionMethod,...values,
});
const derive=(raw:unknown,capturedPrompt='Which speakers?',method:MentionMethod='unicode-boundary-v1',subjects=[subject()])=>
 deriveSearchQueries({evidence:normalize(raw),capturedPrompt,subjects,method});
const rejects=(action:()=>unknown)=>assert.throws(action,(error:unknown)=>
 error instanceof SearchEvidenceError&&error.message===errorMessage);
function freeze<T>(value:T):T{
 if(value!==null&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}
function exactProjection(result:SearchDerivation){
 assert.deepEqual(Object.keys(result).sort(),['version','wordsVersion','matcher','queryState','rawQueryCount','blankIndexes','echoIndexes','queries','words','answerState','answerMentions','websiteContentCoverage'].sort());
 assert.equal(result.version,'immutable-prompt-trim-lower-v1');
 assert.equal(result.wordsVersion,'elmo-ascii-words-3c673d0-v1');
 assert.deepEqual(result.websiteContentCoverage,contentUnavailable);
 for(const match of result.answerMentions??[])assert.deepEqual(Object.keys(match).sort(),['id','matchedTerm','mentioned']);
}

test('only reported result-level queries are evidence; missing, empty and malformed remain distinct',()=>{
 assert.equal(searchEvidenceVersion,'dfs-chatgpt-reported-fields-v1');
 assert.equal(queryDerivationVersion,'immutable-prompt-trim-lower-v1');
 assert.equal(queryWordsVersion,'elmo-ascii-words-3c673d0-v1');
 const result={markdown:'Acme answer',fan_out_queries:['best speakers'],
  sources:[{url:'https://example.com/?q=not-a-reported-query',title:'another query'}],
  search_results:[{url:'https://search.example/?q=invented',title:'inferred'}],
  queries:['alias'],follow_up_questions:['suggestion'],cost:123,model:'untrusted',secret:'DO_NOT_COPY'};
 assert.deepEqual(normalize(result),{version:searchEvidenceVersion,answer:{state:'available',text:'Acme answer',basis:'markdown'},queries:{state:'reported',values:['best speakers']}});
 assert.deepEqual(normalize({tasks:[{result:[result]}]}),{version:searchEvidenceVersion,answer:unknownAnswer,queries:unknownQueries});
 for(const raw of [{},{fan_out_queries:null}]){
  const n=normalize(raw),d=deriveSearchQueries(args(n));assert.deepEqual(n.queries,unknownQueries);
  assert.equal(d.queryState,'not_recorded');assert.equal(d.rawQueryCount,null);assert.equal(d.queries,null);
  assert.equal(d.words,null);assert.equal(d.blankIndexes,null);assert.equal(d.echoIndexes,null);exactProjection(d);
 }
 const empty=derive({fan_out_queries:[]});
 assert.equal(empty.queryState,'reported_empty');assert.equal(empty.rawQueryCount,0);
 assert.deepEqual(empty.queries,[]);assert.deepEqual(empty.blankIndexes,[]);assert.deepEqual(empty.echoIndexes,[]);assert.deepEqual(empty.words,emptyWords);
 const blank=derive({fan_out_queries:['','  ','\u00a0']});
 assert.equal(blank.queryState,'reported');assert.equal(blank.rawQueryCount,3);assert.deepEqual(blank.blankIndexes,[0,1,2]);assert.deepEqual(blank.queries,[]);assert.deepEqual(blank.words,emptyWords);
 for(const field of ['best speakers',false,1,{},['okay',3],['okay',null],new Array(1)]){
  const n=normalize({markdown:'Acme',fan_out_queries:field});assert.deepEqual(n.queries,invalidQueries);
  assert.deepEqual(n.answer,{state:'available',text:'Acme',basis:'markdown'});
  const d=deriveSearchQueries(args(n));assert.equal(d.queries,null);assert.equal(d.words,null);assert.equal(d.rawQueryCount,null);
  assert.deepEqual(d.answerMentions,[{id:'brand',mentioned:true,matchedTerm:'Acme'}]);
 }
 assert.deepEqual(normalize(Object.create({markdown:'inherited',fan_out_queries:['not own'],items:[{markdown:'also inherited'}]})),{version:searchEvidenceVersion,answer:unknownAnswer,queries:unknownQueries});
 const inheritedValues=new Array(1),arrayPrototype=Object.create(Array.prototype);arrayPrototype[0]='inherited';Object.setPrototypeOf(inheritedValues,arrayPrototype);
 assert.deepEqual(normalize({fan_out_queries:inheritedValues}).queries,invalidQueries,'An inherited array entry does not fill an evidence hole.');
});

test('raw query provenance survives duplicate grouping and immutable-prompt echo exclusion without decoding',()=>{
 const values=[' Best Speakers ',' C++ %20 + ','c++ %20 +','  ','unavailable','C++  %20 +'];
 const n=normalize({fan_out_queries:values}),d=deriveSearchQueries(args(n,{capturedPrompt:' Best speakers '}));
 assert.deepEqual(n.queries,{state:'reported',values});assert.equal(d.rawQueryCount,6);
 assert.deepEqual(d.echoIndexes,[0]);assert.deepEqual(d.blankIndexes,[3]);
 assert.deepEqual(d.queries,[{key:'c++ %20 +',firstIndex:1,indexes:[1,2]},{key:'unavailable',firstIndex:4,indexes:[4]},{key:'c++  %20 +',firstIndex:5,indexes:[5]}]);
 const captured={evidence:n,capturedPrompt:' Best speakers ',subjects:[subject()],method:'unicode-boundary-v1' as const};
 let currentPrompt=' Best speakers ';const before=deriveSearchQueries(captured);currentPrompt='C++ %20 +';
 assert.notEqual(currentPrompt,captured.capturedPrompt);assert.deepEqual(deriveSearchQueries(captured),before);
 const unicode=derive({fan_out_queries:['\u00a0CAFÉ\u00a0','cafe\u0301','ＣＡＦÉ','İ','i\u0307','Q+X','Q%2BX','q x']});
 assert.deepEqual(unicode.queries,[
  {key:'café',firstIndex:0,indexes:[0]},{key:'cafe\u0301',firstIndex:1,indexes:[1]},
  {key:'ｃａｆé',firstIndex:2,indexes:[2]},{key:'i\u0307',firstIndex:3,indexes:[3,4]},
  {key:'q+x',firstIndex:5,indexes:[5]},{key:'q%2bx',firstIndex:6,indexes:[6]},{key:'q x',firstIndex:7,indexes:[7]},
 ]);
 const echo=derive({fan_out_queries:['Which speakers?',' WHICH SPEAKERS? ']});
 assert.equal(echo.queryState,'reported');assert.deepEqual(echo.echoIndexes,[0,1]);assert.deepEqual(echo.queries,[]);assert.deepEqual(echo.words,emptyWords);
});

test('brand matches belong to associated answers and preserve existing matcher versions, not query or citation guesses',()=>{
 assert.deepEqual(derive({markdown:'A different company',fan_out_queries:['Acme speakers']}).answerMentions,[{id:'brand',mentioned:false,matchedTerm:null}]);
 assert.deepEqual(derive({markdown:'Acme',fan_out_queries:['speakers']}).answerMentions,[{id:'brand',mentioned:true,matchedTerm:'Acme'}]);
 for(const markdown of ['', ' \n\t',null,12,'\uD800'])assert.equal(derive({markdown,fan_out_queries:['Acme']}).answerMentions,null);
 assert.deepEqual(derive({markdown:'Acme'}).answerMentions,[{id:'brand',mentioned:true,matchedTerm:'Acme'}]);
 const subjects=[subject(),subject({id:'beta',name:'Beta',aliases:['Other name'],domains:[]})];
 for(const method of ['elmo-substring-v1','unicode-boundary-v1']as const){
  for(const text of ['Acmeology','https://host.test/Acme','Acme@example.net','example.com only','Other name and Acme\nGroup','Acme Beta']){
   const d=derive({markdown:text,fan_out_queries:['unrelated'],sources:[{url:'https://example.com/'}]},'Which speakers?',method,subjects);
   const expected=matchAnswer({text,subjects,citationUrls:[],method}).map(({id,mentioned,matchedTerm})=>({id,mentioned,matchedTerm}));
   assert.deepEqual(d.answerMentions,expected);assert.equal(d.matcher,method);exactProjection(d);
  }
 }
 assert.equal(derive({markdown:'Acmeology'},'Which speakers?','elmo-substring-v1').answerMentions![0].mentioned,true);
 assert.equal(derive({markdown:'Acmeology'}).answerMentions![0].mentioned,false);
 assert.deepEqual(derive({markdown:'Acme'},'Which speakers?','unicode-boundary-v1',[]).answerMentions,[]);
});

test('word clouds count token occurrences while changes cast one distinct-token vote per execution/query',()=>{
 const d=derive({fan_out_queries:['red red boots','red red boots','best shoes reviews']},'best red red shoes');
 assert.equal(d.queries!.length,2);
 assert.deepEqual(d.words,{
  cloud:[row('red',2),row('best'),row('boots'),row('reviews'),row('shoes')],
  added:[row('boots'),row('reviews')],
  dropped:[row('best'),row('red'),row('shoes')],
  preserved:[row('best'),row('red'),row('shoes')],
 });
 assert.deepEqual(derive({fan_out_queries:['red boots']},'the red shoes').words,{
  cloud:[row('boots'),row('red')],added:[row('boots')],dropped:[row('shoes'),row('the',1,true)],preserved:[row('red')],
 });
 assert.deepEqual(derive({fan_out_queries:['the the best vs 2026 café x g2 reviews']},'東京').words,{
  cloud:[row('2026'),row('best'),row('caf'),row('g2'),row('reviews'),row('vs')],
  added:[row('2026'),row('best'),row('caf'),row('g2'),row('reviews'),row('the',1,true),row('vs')],
  dropped:[],preserved:[],
 });
 const nonLatin=derive({fan_out_queries:['東京','أكمي']},'中文');
 assert.equal(nonLatin.queries!.length,2);assert.deepEqual(nonLatin.words,emptyWords);
 const words=Array.from({length:70},(_,i)=>`term${i.toString().padStart(2,'0')}`).join(' ');
 assert.equal(derive({fan_out_queries:[words]},'😀').words!.cloud.length,70,'No hidden top48/top60 truncation.');
});

test('markdown extraction distinguishes absent and explicit blank answers, validates fallback blocks and preserves inert text',()=>{
 const text='  <script>not executable</script>\n**Acme**\r\n\tend  ';
 assert.deepEqual(normalize({markdown:text,items:[null],fan_out_queries:[]}).answer,{state:'available',text,basis:'markdown'});
 assert.deepEqual(normalize({markdown:text,items:Array(1001).fill(null)}).answer,{state:'available',text,basis:'markdown'},'Unused fallback must not be scanned.');
 for(const top of [{},{markdown:null},{markdown:' \n '}]){
  assert.deepEqual(normalize({...top,items:[{markdown:'  First  '},{markdown:' '},{unused:'not text'},{markdown:null},{markdown:'\nSecond\t'}]}).answer,{state:'available',text:'First\n\nSecond',basis:'items'});
 }
 for(const raw of [{},{markdown:null},{items:null},{items:[]},{items:[{}, {markdown:null}]},{items:[Object.create({markdown:'inherited'})]}])assert.deepEqual(normalize(raw).answer,unknownAnswer);
 for(const items of [undefined,null,[],[{}]]){
  const raw=items===undefined?{markdown:' \t\n '}:{markdown:' \t\n ',items};
  assert.deepEqual(normalize(raw).answer,{state:'empty',text:' \t\n ',basis:'markdown'});
 }
 for(const raw of [{items:[{markdown:''}]},{markdown:' \t',items:[{markdown:' \n '},{markdown:''}]}])assert.deepEqual(normalize(raw).answer,{state:'empty',text:'',basis:'items'});
 for(const markdown of [1,false,[],{},'\uD800','invalid\0text','bad\u0085']){
  const n=normalize({markdown,items:[{markdown:'do not mask malformed top'}],fan_out_queries:['real query']});
  assert.deepEqual(n.answer,invalidAnswer);assert.deepEqual(n.queries,{state:'reported',values:['real query']});
 }
 for(const items of [false,'blocks',{},[null],[[]],[42],[{markdown:4}],[{markdown:'\uDC00'}],[{markdown:'bad\u007f'}],new Array(1)])assert.deepEqual(normalize({items}).answer,invalidAnswer);
 for(const items of [[{markdown:'valid first block'},null],[null,{markdown:'valid later block'}]]){
  const result=normalize({items,fan_out_queries:['retained query']});
  assert.deepEqual(result.answer,invalidAnswer,'Malformed blocks must not publish a partial available answer.');
  assert.deepEqual(result.queries,{state:'reported',values:['retained query']});
 }
 assert.deepEqual(normalize({markdown:'literal �',fan_out_queries:['�']}).answer,{state:'available',text:'literal �',basis:'markdown'});
});

test('wire and retained JSON boundaries enforce exact caps, own fields, controls and coherent truth states with fixed errors',()=>{
 for(const raw of [null,[],0,false,'secret payload',undefined])rejects(()=>normalize(raw));
 for(const char of ['\0','\u0008','\u000b','\u000c','\u001f','\u007f','\u0085','\u009f','\uD800','\uDC00']){
  assert.deepEqual(normalize({markdown:`x${char}`,fan_out_queries:[`x${char}`]}).answer,invalidAnswer);
  assert.deepEqual(normalize({fan_out_queries:[`x${char}`]}).queries,invalidQueries);
  if(char==='\0'||char==='\uD800'||char==='\uDC00')rejects(()=>derive({},`x${char}`));
  else assert.equal(derive({},`x${char}y`).queryState,'not_recorded','Previously valid authored controls remain admissible.');
 }
 for(const char of ['\n','\r','\t']){
  assert.equal(normalize({markdown:`x${char}y`}).answer.state,'available');
  assert.deepEqual(normalize({fan_out_queries:[`x${char}y`]}).queries,invalidQueries);
  assert.equal(derive({},`x${char}y`).queryState,'not_recorded');
 }
 assert.deepEqual(normalize({fan_out_queries:['literal �']}).queries,{state:'reported',values:['literal �']});
 assert.equal(normalize({fan_out_queries:Array(100).fill('q')}).queries.state,'reported');
 rejects(()=>normalize({fan_out_queries:[null,...Array(100).fill('q')]}));
 for(const query of ['x'.repeat(2000),'😀'.repeat(2000)])assert.equal(normalize({fan_out_queries:[query]}).queries.state,'reported');
 for(const query of ['x'.repeat(2001),'😀'.repeat(2001)])rejects(()=>normalize({fan_out_queries:[query]}));
 assert.equal(derive({fan_out_queries:Array(100).fill('😀'.repeat(2000))}).rawQueryCount,100);
 assert.equal(normalize({items:Array.from({length:1000},()=>({markdown:''}))}).answer.state,'empty');
 rejects(()=>normalize({items:[null,...Array(1000).fill({})]}));
 assert.equal(normalize({markdown:'x'.repeat(250000)}).answer.state,'available');
 rejects(()=>normalize({markdown:'x'.repeat(250001)}));
 assert.deepEqual(normalize({items:[{markdown:'x'.repeat(124999)},{markdown:'y'.repeat(124999)}]}).answer,{state:'available',text:'x'.repeat(124999)+'\n\n'+'y'.repeat(124999),basis:'items'});
 rejects(()=>normalize({items:[{markdown:'x'.repeat(125000)},{markdown:'y'.repeat(124999)}]}));
 for(const prompt of ['x'.repeat(2000),'😀'.repeat(1000),'😀'.repeat(999)+'xy'])assert.equal(derive({},prompt).queryState,'not_recorded');
 for(const prompt of ['', ' \t\n', 'x'.repeat(2001),'😀'.repeat(1000)+'x','😀'.repeat(1001),'\uD800'])rejects(()=>derive({},prompt));
 const evidence=normalize({markdown:'Acme',fan_out_queries:['query']});
 const invalidEvidence:unknown[]=[null,[],{}, {...evidence,version:'future'}, {...evidence,extra:'secret'},
  {...evidence,answer:{...evidence.answer,extra:1}},{...evidence,queries:{...evidence.queries,extra:1}},
  {...evidence,queries:{state:'reported_empty',values:['q']}},{...evidence,queries:{state:'reported',values:[]}},
  {...evidence,queries:{state:'not_recorded',values:[]}},{...evidence,queries:{state:'invalid',values:['q']}},
  {...evidence,queries:{state:'reported',values:new Array(1)}},{...evidence,queries:{state:'reported',values:['bad\nquery']}},
  {...evidence,queries:{state:'reported',values:['x'.repeat(2001)]}},{...evidence,queries:{state:'reported',values:['😀'.repeat(2001)]}},{...evidence,queries:{state:'reported',values:Array(101).fill('q')}},
  {...evidence,answer:{state:'available',text:' ',basis:'markdown'}},{...evidence,answer:{state:'empty',text:'nonblank',basis:'items'}},
  {...evidence,answer:{state:'not_recorded',text:'Acme',basis:null}},{...evidence,answer:{state:'invalid',text:null,basis:'markdown'}},
  {...evidence,answer:{state:'available',text:'Acme',basis:'search_results'}},{...evidence,answer:{state:'available',text:'bad\0text',basis:'markdown'}},
  {...evidence,answer:{state:'available',text:'x'.repeat(250001),basis:'markdown'}},
 ];
 for(const value of invalidEvidence)rejects(()=>deriveSearchQueries(args(value as SearchEvidence)));
 const inherited=Object.create({version:searchEvidenceVersion,answer:evidence.answer,queries:evidence.queries});
 rejects(()=>deriveSearchQueries(args(inherited)));
 rejects(()=>deriveSearchQueries(Object.create(args(evidence))));
 rejects(()=>deriveSearchQueries(args({...evidence,queries:Object.create(evidence.queries)})));
 for(const input of [null,[],{}, {...args(evidence),extra:'secret'},{...args(evidence),method:'guess'},{...args(evidence),subjects:[subject(),subject()]},
  {...args(normalize({})),subjects:[subject({name:''})]},{...args(normalize({})),subjects:[subject({aliases:['x'.repeat(513)]})]}])rejects(()=>deriveSearchQueries(input as Parameters<typeof deriveSearchQueries>[0]));
});

test('outputs are deterministic and detached; exact matcher and word-list limits reject rather than sample',()=>{
 const raw=freeze({markdown:'Acme and Beta',fan_out_queries:['red red boots',' RED RED BOOTS ','blue shoes'],secret:'not output'});
 const before=structuredClone(raw),evidence=normalize(raw),subjects=freeze([subject(),subject({id:'beta',name:'Beta',domains:[]})]);
 const input=freeze({evidence,capturedPrompt:'red shoes',subjects,method:'unicode-boundary-v1' as const});
 const first=deriveSearchQueries(input),second=deriveSearchQueries(input);
 assert.deepEqual(first,second);assert.deepEqual(raw,before);exactProjection(first);
 assert.equal(JSON.stringify(evidence).includes('secret'),false);
 first.queries![0].indexes.push(99);first.words!.cloud[0].count=900;first.answerMentions![0].mentioned=false;
 assert.deepEqual(deriveSearchQueries(input),second);assert.deepEqual(raw,before);
 const normalizedAgain=normalize(raw);if(normalizedAgain.queries.values)normalizedAgain.queries.values[0]='changed';
 assert.deepEqual(raw,before);assert.deepEqual(normalize(raw),evidence);
 const many=Array.from({length:101},(_,i)=>subject({id:String(i),name:`Term${i}`,aliases:[],domains:[]}));
 assert.equal(derive({markdown:'x'.repeat(200000)},'prompt','unicode-boundary-v1',many.slice(0,100)).answerMentions!.length,100);
 rejects(()=>derive({markdown:'x'.repeat(200000)},'prompt','unicode-boundary-v1',many));
 const queries=Array.from({length:100},(_,group)=>Array.from({length:100},(_,i)=>`w${String(group*100+i).padStart(5,'0')}`).join(' '));
 const atCap=derive({fan_out_queries:queries},'😀');
 assert.equal(atCap.words!.cloud.length,10000);assert.equal(atCap.words!.added.length,10000);
 assert.deepEqual(atCap.words!.dropped,[]);assert.deepEqual(atCap.words!.preserved,[]);
 rejects(()=>derive({fan_out_queries:queries},'seedword'));
});

test('query-weighted answer rates remain distinct from reporting coverage and unavailable website-content coverage',()=>{
 const runs=[derive({markdown:'Acme',fan_out_queries:['q1','q1','q2']}),
  derive({markdown:'Other product',fan_out_queries:['q1']}),derive({fan_out_queries:['q1']})];
 const stats=new Map<string,{observations:number;eligible:number;mentions:number}>();
 for(const run of runs){
  assert.deepEqual(run.websiteContentCoverage,contentUnavailable);
  for(const query of run.queries??[]){
   const value=stats.get(query.key)??{observations:0,eligible:0,mentions:0};value.observations++;
   if(run.answerMentions!==null){value.eligible++;value.mentions+=Number(run.answerMentions[0].mentioned);}stats.set(query.key,value);
  }
 }
 assert.deepEqual([...stats],[['q1',{observations:3,eligible:2,mentions:1}],['q2',{observations:1,eligible:1,mentions:1}]]);
 assert.equal(runs.reduce((n,r)=>n+(r.queries?.length??0),0),4);
 assert.equal(runs.filter(r=>r.queries?.length).length,3);
 assert.equal([...stats.values()].reduce((n,r)=>n+r.mentions,0),2);
 assert.equal([...stats.values()].reduce((n,r)=>n+r.eligible,0),3);
 assert.equal(runs.filter(r=>r.answerMentions!==null).length,2);
 assert.equal(runs.filter(r=>r.answerMentions?.[0].mentioned).length,1);
 const missing=derive({markdown:'Acme',sources:[{url:'https://example.com/'}],search_results:[{title:'Acme'}]});
 const empty=derive({markdown:'Acme',fan_out_queries:[]});
 assert.equal(missing.queries,null);assert.deepEqual(empty.queries,[]);
 assert.equal(missing.answerMentions![0].mentioned,true);
 assert.equal([...runs,missing,empty].filter(r=>r.queryState==='reported'||r.queryState==='reported_empty').length,4);
 for(const result of [...runs,missing,empty]){exactProjection(result);assert.equal('win' in result,false);assert.equal('coverageRate' in result,false);}
});
