import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeMetaRows,type MetaReportScope} from '../src/server/meta-report-rows.ts';

// Independent golden vectors for the public pure contract. No provider, clock or database.
const id='9'.repeat(39)+'7';
const scope:MetaReportScope={report:'account_daily',accountId:id,currency:'AED',from:'2024-02-01',to:'2024-02-29'};
const campaignScope:MetaReportScope={...scope,report:'campaign_daily'};
const base=()=>({account_id:id,account_currency:'AED',date_start:'2024-02-29',date_stop:'2024-02-29'});
const campaign=(campaignId='9007199254740993')=>({...base(),campaign_id:campaignId,campaign_name:'Same name'});
const message='Meta returned an invalid report page.';
function invalid(value:unknown,s:unknown=scope){assert.throws(()=>normalizeMetaRows(value,s as MetaReportScope),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal(error.message,message);assert.equal(Object.hasOwn(error,'cause'),false);return true;});}

test('Meta daily golden rows preserve exact numbers, fractional actions and independent attribution fields',()=>{
 const input=[{...base(),account_name:'An account label',impressions:'9007199254740993',clicks:'0',spend:'9007199254740993.012300',actions:[{action_type:'purchase',value:'1.2500','7d_click':'0.7500','1d_view':null}],action_values:[{action_type:'purchase',value:'000'}]}];
 invalid(input);input[0].action_values[0].value='12.3400';
 assert.deepEqual(normalizeMetaRows(input,scope),[{date:'2024-02-29',accountId:id,campaignId:null,campaignName:null,impressions:'9007199254740993',clicks:'0',spend:'9007199254740993.012300',actions:[{type:'purchase',value:'1.2500',windows:{'7d_click':'0.7500','1d_view':null}}],actionValues:[{type:'purchase',value:'12.3400',windows:{}}]}]);
 const left='9'.repeat(39)+'1',right='9'.repeat(39)+'2';
 assert.deepEqual(normalizeMetaRows([campaign(right),campaign(left)],campaignScope).map(r=>[r.campaignId,r.campaignName]),[[right,'Same name'],[left,'Same name']]);
 assert.equal(Object.hasOwn(normalizeMetaRows(input,scope)[0],'account_name'),false);
});

test('Meta omitted/null/empty values stay distinct from explicit zeros and no row is fabricated',()=>{
 assert.deepEqual(normalizeMetaRows([],scope),[]);
 const missing=normalizeMetaRows([base()],scope)[0];
 for(const field of ['impressions','clicks','spend','actions','actionValues'] as const)assert.equal(missing[field],null);
 const empty=normalizeMetaRows([{...base(),account_name:null,campaign_id:null,campaign_name:null,impressions:null,clicks:null,spend:null,actions:[],action_values:[]}],scope)[0];
 assert.deepEqual(empty.actions,[]);assert.deepEqual(empty.actionValues,[]);assert.equal(empty.spend,null);
 const zero=normalizeMetaRows([{...base(),impressions:'0',clicks:'0',spend:'0.00',actions:[{action_type:'zero',value:'0','1d_click':null},{action_type:'not_reported'}],action_values:null}],scope)[0];
 assert.equal(zero.spend,'0.00');assert.deepEqual(zero.actions,[{type:'zero',value:'0',windows:{'1d_click':null}},{type:'not_reported',value:null,windows:{}}]);assert.equal(zero.actionValues,null);
 assert.equal(normalizeMetaRows([{...campaign(),campaign_name:null}],campaignScope)[0].campaignName,null);
 for(const input of [undefined,null,{},'[]',0,false])invalid(input);
});

test('Meta scope and daily grain reject mismatched authority and every unexpected row dimension',()=>{
 for(const field of ['report','accountId','currency','from','to']){const missing={...scope};delete (missing as Record<string,unknown>)[field];invalid([],missing);}
 for(const s of [{...scope,report:'ad_daily'},{...scope,extra:true},{...scope,from:'2024-03-01'},[],null])invalid([],s);
 for(const row of [{...base(),account_id:'2'},{...base(),account_currency:'USD'},{...base(),date_start:'2024-02-28'},{...base(),date_start:'2024-03-01',date_stop:'2024-03-01'},{...base(),campaign_id:'1'},{...base(),campaign_name:'Unexpected campaign'}])invalid([row]);
 invalid([base()],campaignScope);invalid([{...campaign(),campaign_id:null}],campaignScope);
 for(const key of ['ad_id','adset_id','age','gender','country','device_platform','unknown_metric','paging','__proto__','constructor']){
  const row={...base()};Object.defineProperty(row,key,{value:'unexpected-provider-content',enumerable:true});invalid([row]);
 }
 for(const field of ['account_id','account_currency','date_start','date_stop']){const row={...base()};delete (row as Record<string,unknown>)[field];invalid([row]);}
});

test('Meta Gregorian dates include early years and leap days with exact31-day inclusive boundaries',()=>{
 for(const day of ['0001-01-01','0096-02-29','0099-12-31','2000-02-29','2024-02-29','9999-12-31']){
  assert.equal(normalizeMetaRows([{...base(),date_start:day,date_stop:day}],{...scope,from:day,to:day})[0].date,day);
 }
 for(const day of ['0000-01-01','0099-02-29','1900-02-29','2023-02-29','2024-04-31','2024-00-01','2024-13-01','2024-01-00','2024-2-01','2024-02-29T00:00:00Z','2024-02-29\n'])invalid([],{...scope,from:day,to:day});
 assert.deepEqual(normalizeMetaRows([],{...scope,from:'2024-01-31',to:'2024-03-01'}),[]);
 invalid([],{...scope,from:'2024-01-31',to:'2024-03-02'});
 invalid([],{...scope,from:'2024-03-01',to:'2024-02-29'});
 invalid([{...base(),date_start:'2024-02-30',date_stop:'2024-02-30'}]);
});

test('Meta numeric formats never coerce, round, trim or accept a terminal line break',()=>{
 const maximum='9'.repeat(30)+'.'+'1'.repeat(18);
 assert.equal(normalizeMetaRows([{...base(),impressions:'9'.repeat(30),spend:maximum}],scope)[0].spend,maximum);
 const bad=[0,1,NaN,Infinity,{},[],true,false,'','00','01','-1','+1','1e3','1E3','1,000',' 1','1 ','1\n','1\r','1\u2028','1\u2029','１','١','0x1','1_000'];
 for(const value of [...bad,'1.0','.1','1.','9'.repeat(31)])for(const field of ['impressions','clicks'])invalid([{...base(),[field]:value}]);
 for(const value of [...bad,'.1','1.','9'.repeat(31),'0.'+'1'.repeat(19)]){
  invalid([{...base(),spend:value}]);invalid([{...base(),actions:[{action_type:'purchase',value}]}]);invalid([{...base(),action_values:[{action_type:'purchase','7d_click':value}]}]);
 }
 for(const value of ['0','01',1,'1\n','1\u2028','1'.repeat(41),'١'])invalid([],{...scope,accountId:value});
 for(const value of ['usd','US','USDD','AED\n','ＡＥＤ','AED\u2028'])invalid([],{...scope,currency:value});
 invalid([{...campaign(),campaign_id:'1\n'}],campaignScope);
});

test('Meta action shapes reject unsupported breakdowns and duplicates without merging safe literal labels',()=>{
 const windows={'1d_click':'1','7d_click':'2','28d_click':'3','1d_view':'4','7d_view':'5','28d_view':null};
 const rows=normalizeMetaRows([{...base(),actions:[{action_type:'__proto__',...windows},{action_type:'constructor',value:'2'},{action_type:'Purchase'},{action_type:'purchase'}],action_values:[{action_type:'__proto__',value:'3'}]}],scope);
 assert.deepEqual(rows[0].actions?.map(a=>a.type),['__proto__','constructor','Purchase','purchase']);assert.deepEqual(rows[0].actions?.[0].windows,windows);assert.equal(rows[0].actionValues?.[0].value,'3');
 invalid([{...base(),actions:[{action_type:'purchase'},{action_type:'purchase'}]}]);invalid([{...base(),action_values:[{action_type:'purchase'},{action_type:'purchase'}]}]);
 for(const key of ['action_device','action_destination','1d_ev','inline','unknown','__proto__']){const a={action_type:'purchase'};Object.defineProperty(a,key,{value:'1',enumerable:true});invalid([{...base(),actions:[a]}]);}
 for(const a of [null,[],1,'purchase',{}, {action_type:null},{action_type:''},{action_type:'purchase',value:{value:'1'}},{action_type:'purchase','7d_click':['1']}])invalid([{...base(),actions:[a]}]);
 for(const value of [{},'[]',0,false])invalid([{...base(),actions:value}]);
});

test('Meta valid Unicode is preserved as text while malformed names and action labels fail uniformly',()=>{
 const name='  Launch <img src=x onerror=alert(1)> 🛰️ e\u0301  ';
 assert.equal(normalizeMetaRows([{...campaign(),campaign_name:name,account_name:name}],campaignScope)[0].campaignName,name);
 for(const value of ['\0','\t','\n','\r','\x1f','\x7f','\ud800','\udfff','x\ud800y']){
  invalid([{...base(),account_name:value}]);invalid([{...campaign(),campaign_name:value}],campaignScope);invalid([{...base(),actions:[{action_type:value}]}]);
 }
 assert.equal(normalizeMetaRows([{...campaign(),campaign_name:'🛰'.repeat(256)}],campaignScope)[0].campaignName,'🛰'.repeat(256));
 invalid([{...campaign(),campaign_name:'🛰'.repeat(257)}],campaignScope);invalid([{...base(),account_name:''}]);invalid([{...base(),account_name:'x'.repeat(513)}]);
 assert.equal(normalizeMetaRows([{...base(),actions:[{action_type:'x'.repeat(200)}]}],scope)[0].actions?.[0].type.length,200);invalid([{...base(),actions:[{action_type:'x'.repeat(201)}]}]);
});

test('Meta row/action capacity rejects overflow, sparse arrays and duplicate logical keys',()=>{
 const rows=Array.from({length:500},(_,i)=>campaign(String(i+1)));
 assert.equal(normalizeMetaRows(rows,campaignScope).length,500);invalid([...rows,campaign('501')],campaignScope);
 const actions=Array.from({length:200},(_,i)=>({action_type:'metric.'+i,value:'0'}));
 assert.equal(normalizeMetaRows([{...base(),actions,action_values:actions}],scope)[0].actions?.length,200);
 invalid([{...base(),actions:[...actions,{action_type:'metric.200'}]}]);invalid([{...base(),action_values:[...actions,{action_type:'metric.200'}]}]);
 invalid(new Array(1));invalid([{...base(),actions:new Array(1)}]);invalid([{...base(),action_values:new Array(1)}]);
 invalid([base(),base()]);invalid([campaign(),campaign()],campaignScope);
 assert.equal(normalizeMetaRows([campaign(),{...campaign(),date_start:'2024-02-28',date_stop:'2024-02-28'}],campaignScope).length,2);
});

test('Meta own-property rules never accept inherited scope/identity/action authority or optional evidence',()=>{
 invalid([],Object.create(scope));invalid([Object.create(base())]);
 const inheritedCampaign=Object.assign(Object.create({campaign_id:'1'}),base());invalid([inheritedCampaign],campaignScope);
 invalid([{...base(),actions:[Object.create({action_type:'purchase'})]}]);
 const input=[Object.assign(Object.create({impressions:'999',actions:[{action_type:'forged'}]}),base())];
 try{const row=normalizeMetaRows(input,scope)[0];assert.equal(row.impressions,null);assert.equal(row.actions,null);}catch(error){assert.ok(error instanceof Error);assert.equal(error.message,message);}
 const inheritedAction=Object.assign(Object.create({value:'999','1d_click':'999'}),{action_type:'purchase'});
 try{const row=normalizeMetaRows([{...base(),actions:[inheritedAction]}],scope)[0];assert.equal(row.actions?.[0].value,null);assert.deepEqual(row.actions?.[0].windows,{});}catch(error){assert.ok(error instanceof Error);assert.equal(error.message,message);}
});

test('Meta normalization is immutable and detached, and invalid later rows never return partial success',()=>{
 const action=Object.freeze({action_type:'purchase',value:'2.00','7d_click':'1.25'});
 const actions=Object.freeze([action]);const input=Object.freeze([Object.freeze({...base(),actions,action_values:actions})]);
 const result=normalizeMetaRows(input,scope),before=JSON.stringify(input);
 assert.notEqual(result,input);assert.notEqual(result[0].actions,actions);assert.notEqual(result[0].actions?.[0],action);assert.notEqual(result[0].actions,result[0].actionValues);
 result[0].actions![0].value='777';result[0].actions![0].windows['7d_click']='777';
 assert.equal(JSON.stringify(input),before);assert.equal(result[0].actionValues?.[0].value,'2.00');assert.equal(normalizeMetaRows(input,scope)[0].actions?.[0].windows['7d_click'],'1.25');
 invalid([campaign('1'),{...campaign('2'),spend:'secret-invalid-provider-value'}],campaignScope);
});
