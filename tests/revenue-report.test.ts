import assert from'node:assert/strict';
import{test}from'node:test';
import{revenueDecimal,revenueUnits,revenueAverage,revenueChannel,revenueMoneyChange,revenueCountChange}from'../src/lib/revenue.ts';
import{revenueQuery}from'../src/server/revenue.ts';
test('exact report money, zero/refund/round ties and recorded tag evidence',()=>{
 assert.equal(revenueDecimal(revenueUnits('0.1000')+revenueUnits('0.2000')),'0.3000');assert.equal(revenueDecimal(revenueUnits('999999999999999.9999')*100n),'99999999999999999.9900');assert.equal(revenueAverage('0.0001',2),'0.0001');assert.equal(revenueAverage('-0.0001',2),'-0.0001');assert.equal(revenueAverage('0.0000',0),null);assert.equal(revenueAverage('3.0000',2),'1.5000');
 for(const value of['1','1e4','01.0000','-0.0000','1.0000\n','0.00001'])assert.throws(()=>revenueUnits(value));
 assert.equal(revenueChannel('CPC','anything','google.evil'),'tagged_paid');assert.equal(revenueChannel(null,'google',null),'other_tagged');assert.equal(revenueChannel(' cpc',null,null),'other_tagged');assert.equal(revenueChannel(null,null,null),'not_recorded');assert.equal(revenueChannel(null,null,'search.test'),'referrer_only');
});
test('closed report query requires pinned currency, atomic dates and scoped canonical cursor',()=>{
 const base={from:'2026-10-10',to:'2026-10-10',timeZone:'UTC',currency:'USD'};assert.equal(revenueQuery(new URLSearchParams(base)).pageSize,50);
 for(const extra of([{compare:'custom'},{currency:'usd'},{currency:'XXX'},{pageSize:'01'},{pageSize:'101'},{groupBy:'path'},{limit:'5'},{cursor:'e30'},{search:'\0'}] as Record<string,string>[]))assert.throws(()=>revenueQuery(new URLSearchParams({...base,...extra})));
 for(const key of Object.keys(base)){const p=new URLSearchParams(base);p.delete(key);assert.throws(()=>revenueQuery(p));}const duplicate=new URLSearchParams(base);duplicate.append('currency','EUR');assert.throws(()=>revenueQuery(duplicate));
 assert.throws(()=>revenueQuery(new URLSearchParams({...base,search:'x'}),'detail','a'.repeat(64)));assert.throws(()=>revenueQuery(new URLSearchParams(base),'detail','not-a-key'));
});
test('comparison stays opt-in and report-only with derived Gregorian endpoints',()=>{
 const base={from:'2025-02-28',to:'2026-02-28',timeZone:'Pacific/Apia',currency:'USD'};assert.equal(Object.hasOwn(revenueQuery(new URLSearchParams(base)),'compare'),false);
 for(const compare of ['prev','yoy']){const params=new URLSearchParams({...base,compare});assert.equal(revenueQuery(params).compare,compare);for(const route of ['sessions','detail'] as const)assert.throws(()=>revenueQuery(params,route,'a'.repeat(64)));}
 for(const compare of ['', 'previous','yoy\n'])assert.throws(()=>revenueQuery(new URLSearchParams({...base,compare})));
 const duplicate=new URLSearchParams({...base,compare:'prev'});duplicate.append('compare','yoy');assert.throws(()=>revenueQuery(duplicate));
 assert.throws(()=>revenueQuery(new URLSearchParams({...base,from:'1970-01-01',to:'1970-01-01',compare:'prev'})));
});
test('exact signed changes round half away from zero and retain wide derived results',()=>{
 assert.deepEqual(revenueMoneyChange('0.0000','3.0000'),{absolute:'-3.0000',percent:'-100.0000'});assert.deepEqual(revenueMoneyChange('1.0000','0.0000'),{absolute:'1.0000',percent:null});assert.deepEqual(revenueMoneyChange('-1.0000','-2.0000'),{absolute:'1.0000',percent:null});assert.deepEqual(revenueMoneyChange(null,'1.0000'),{absolute:null,percent:null});assert.deepEqual(revenueCountChange(1,3),{absolute:-2,percent:'-66.6667'});
 assert.equal(revenueMoneyChange('1.0000','64.0000').percent,'-98.4375');assert.deepEqual(revenueCountChange(0,0),{absolute:0,percent:null});
 const maximum='9'.repeat(40)+'.9999',extreme=revenueMoneyChange('-'+maximum,'0.0001');assert.equal(extreme.absolute,'-1'+'0'.repeat(40)+'.0000');assert.equal(extreme.percent,'-1'+'0'.repeat(46)+'.0000');assert.equal(revenueMoneyChange(maximum,'-'+maximum).absolute,'1'+'9'.repeat(40)+'.9998');assert.throws(()=>revenueUnits(extreme.absolute!));assert.throws(()=>revenueMoneyChange('01.0000','0.0000'));
});
