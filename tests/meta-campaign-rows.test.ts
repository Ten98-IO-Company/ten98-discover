import assert from 'node:assert/strict';
import test from 'node:test';
import {MetaCampaignRowsError,normalizeMetaCampaigns} from '../src/server/meta-campaign-rows.ts';

// Independent contract vectors. No provider, database, clock or application state.
const account='9'.repeat(39)+'7',message='Meta returned an unsupported campaign inventory.';
const campaign=(id='9007199254740993')=>({id,account_id:account});
function invalid(value:unknown,...scope:unknown[]){assert.throws(()=>normalizeMetaCampaigns(value,(scope.length?scope[0]:account) as string),(error:unknown)=>{assert.ok(error instanceof MetaCampaignRowsError);assert.equal(error.message,message);assert.equal(Object.hasOwn(error,'cause'),false);return true;});}

test('campaign inventory preserves exact large IDs, provider order and independent configured/effective status',()=>{
 const first='9'.repeat(39)+'2',second='9'.repeat(39)+'1';
 const result=normalizeMetaCampaigns([{...campaign(first),name:'Same label',status:'PAUSED',effective_status:'ACTIVE'},{...campaign(second),name:'Same label',status:'ACTIVE',effective_status:'WITH_ISSUES'}],account);
 assert.deepEqual(result,[{id:first,accountId:account,name:'Same label',status:'PAUSED',effectiveStatus:'ACTIVE'},{id:second,accountId:account,name:'Same label',status:'ACTIVE',effectiveStatus:'WITH_ISSUES'}]);
 assert.equal(normalizeMetaCampaigns([{id:'1',account_id:'1'}],'1')[0].accountId,'1');
 for(const row of result)assert.deepEqual(Object.keys(row).sort(),['accountId','effectiveStatus','id','name','status']);
});

test('campaign inventory distinguishes absent/null metadata from empty name and preserves unknown statuses',()=>{
 assert.deepEqual(normalizeMetaCampaigns([],account),[]);
 for(const extra of [{},{name:null,status:null,effective_status:null},{name:undefined,status:undefined,effective_status:undefined}]){
  assert.deepEqual(normalizeMetaCampaigns([{...campaign(),...extra}],account),[{id:'9007199254740993',accountId:account,name:null,status:null,effectiveStatus:null}]);
 }
 assert.deepEqual(normalizeMetaCampaigns([{...campaign(),name:'',status:'FUTURE_PROVIDER_STATE',effective_status:'UNKNOWN_STATE'}],account)[0],{id:'9007199254740993',accountId:account,name:'',status:'FUTURE_PROVIDER_STATE',effectiveStatus:'UNKNOWN_STATE'});
 assert.equal(normalizeMetaCampaigns([{...campaign(),name:'   '}],account)[0].name,'   ');
 for(const value of [0,false,{},[],new String('ACTIVE')]){invalid([{...campaign(),name:value}]);invalid([{...campaign(),status:value}]);invalid([{...campaign(),effective_status:value}]);}
});

test('campaign IDs reject coercion, alternate spellings, line terminators and cross-account rows',()=>{
 const rejected=[undefined,null,0,1,NaN,Infinity,false,{},[],new String('1'),'','0','01','-1','+1','1.0','1e3','0x1','1_000','1,000','act_1',' 1','1 ','1\n','1\r','1\r\n','1\u2028','1\u2029','١','１','9'.repeat(41)];
 for(const value of rejected){invalid([],value);invalid([{...campaign(),id:value}]);invalid([{...campaign(),account_id:value}]);}
 invalid([{...campaign(),account_id:'2'}]);invalid([{account_id:account}]);invalid([{id:'1'}]);
 invalid([campaign('1'),{...campaign('2'),account_id:'2'}]);
});

test('campaign pages enforce100 records, reject sparse/invalid records and duplicate IDs without a partial result',()=>{
 const input=Array.from({length:100},(_,i)=>campaign(String(i+1)));assert.equal(normalizeMetaCampaigns(input,account).length,100);invalid([...input,campaign('101')]);
 for(const value of [undefined,null,false,0,'[]',{},new Set()])invalid(value);
 for(const value of [null,undefined,[],0,false,'campaign'])invalid([campaign('1'),value]);
 invalid(new Array(1));const sparse=[campaign('1'),campaign('2')];delete sparse[1];invalid(sparse);
 invalid([campaign('1'),campaign('1')]);invalid([campaign('1'),{...campaign('1'),name:'Different label',status:'PAUSED'}]);
 assert.deepEqual(normalizeMetaCampaigns([campaign('12'),campaign('2'),campaign('1')],account).map(c=>c.id),['12','2','1']);
});

test('campaign names preserve inert text and valid Unicode at the512 UTF16-unit boundary',()=>{
 for(const name of [' <img src=x onerror=alert(1)> & "quoted" ','=HYPERLINK("https://example.test")','+SUM(1,2)','  إطلاق 東京 e\u0301 🛰️  ','\u2028\u2029','x'.repeat(512),'😀'.repeat(256)])assert.equal(normalizeMetaCampaigns([{...campaign(),name}],account)[0].name,name);
 for(const name of ['x'.repeat(513),'😀'.repeat(257),'x'.repeat(511)+'😀','\ud800','\udfff','x\ud800y','\udc00\ud800'])invalid([{...campaign(),name}]);
 for(let code=0;code<=31;code++)invalid([{...campaign(),name:'safe'+String.fromCharCode(code)+'text'}]);invalid([{...campaign(),name:'safe\x7ftext'}]);
});

test('campaign status grammar preserves reviewed and unfamiliar uppercase labels without trimming or inference',()=>{
 const accepted=['ACTIVE','PAUSED','ARCHIVED','DELETED','IN_PROCESS','WITH_ISSUES','FUTURE_VALUE','_','A'.repeat(64)];
 for(const status of accepted){const row=normalizeMetaCampaigns([{...campaign(),status,effective_status:status}],account)[0];assert.equal(row.status,status);assert.equal(row.effectiveStatus,status);}
 for(const status of ['', 'A'.repeat(65),'Active','active','ACTIVE1','ACTIVE-OTHER',' ACTIVE','ACTIVE ','ACTIVE\n','ACTIVE\r','ACTIVE\u2028','ACTIVE\u2029','ACTÍVE','ＡＣＴＩＶＥ','ACTIVE\0','ACTIVE\x7f'])for(const key of ['status','effective_status'])invalid([{...campaign(),[key]:status}]);
});

test('campaign normalization projects only reviewed fields and leaves input detached and unchanged',()=>{
 const raw={...campaign(),name:'Original',status:'PAUSED',effective_status:'ACTIVE',access_token:'never-return-this',insights:{data:[{spend:'123'}]},extra:['unrelated']};
 Object.defineProperty(raw,'__proto__',{value:{polluted:true},enumerable:true});Object.defineProperty(raw,'constructor',{value:'unrelated',enumerable:true});
 const before=JSON.stringify(raw),input=Object.freeze([Object.freeze(raw)]),result=normalizeMetaCampaigns(input,account);
 assert.notEqual(result,input);assert.notEqual(result[0],raw);assert.deepEqual(result,[{id:'9007199254740993',accountId:account,name:'Original',status:'PAUSED',effectiveStatus:'ACTIVE'}]);
 result[0].name='Changed locally';result[0].status='UNKNOWN';assert.equal(JSON.stringify(raw),before);assert.equal(normalizeMetaCampaigns(input,account)[0].name,'Original');assert.equal(({} as {polluted?:unknown}).polluted,undefined);
 invalid([campaign('1'),{...campaign('2'),status:'secret invalid provider status'}]);
});

test('campaign required and optional evidence comes only from own fields',()=>{
 invalid([Object.create(campaign())]);
 invalid([Object.assign(Object.create({id:'1'}),{account_id:account})]);
 invalid([Object.assign(Object.create({account_id:account}),{id:'1'})]);
 const inherited=Object.assign(Object.create({name:'Forged label',status:'ACTIVE',effective_status:'ACTIVE'}),campaign('1'));
 assert.deepEqual(normalizeMetaCampaigns([inherited],account),[{id:'1',accountId:account,name:null,status:null,effectiveStatus:null}]);
 const explicit=Object.assign(Object.create({name:'Forged label',status:'ACTIVE',effective_status:'ACTIVE'}),campaign('2'),{name:'Own label',status:'PAUSED',effective_status:null});
 assert.deepEqual(normalizeMetaCampaigns([explicit],account),[{id:'2',accountId:account,name:'Own label',status:'PAUSED',effectiveStatus:null}]);
});
