import assert from'node:assert/strict';
import test from'node:test';
import{normalizeProperties}from'../src/server/analytics-input.ts';
import{normalizeRevenueProperties,revenueCurrencies,revenueCurrencyCatalogVersion,revenuePropertyNames}from'../src/lib/revenue.ts';
const tuple=(amount:unknown='49.5',kind:unknown='sale',currency:unknown='USD')=>({ten98_revenue_version:'1',ten98_revenue_kind:kind,ten98_revenue_amount:amount,ten98_revenue_currency:currency});
const normalize=(properties:unknown,name='revenue.sale')=>normalizeRevenueProperties(name,normalizeProperties(properties));
test('explicit native revenue is exact positive decimal text; refunds preserve positive amount and ordinary properties',()=>{
 for(const[input,expected]of[['1','1.0000'],['0.1','0.1000'],['0.0001','0.0001'],['123.4500','123.4500'],['999999999999999.9999','999999999999999.9999']])assert.equal(normalize(tuple(input)).ten98_revenue_amount.value,expected);
 const raw={...tuple('12.34','refund','KWD'),plan:'team',nested:{zero:0},flag:false};const normalized=normalize(raw,'custom_refund');assert.equal(normalized.ten98_revenue_kind.value,'refund');assert.equal(normalized.ten98_revenue_amount.value,'12.3400');assert.deepEqual(normalized.plan,{type:'string',value:'team'});assert.deepEqual(normalized['nested.zero'],{type:'number',value:0});assert.deepEqual(normalized.flag,{type:'boolean',value:false});
 const generic=normalizeProperties({value:'49.5',currency:'USD',revenue:49.5,transactionId:'existing-developer-value'});assert.equal(normalizeRevenueProperties('purchase',generic),generic);assert.deepEqual(normalizeRevenueProperties('page_view',{}),{});
 const extra=Object.fromEntries(Array.from({length:46},(_,i)=>['p'+i,i]));assert.equal(Object.keys(normalize({...tuple(),...extra})).length,50);assert.throws(()=>normalize({...tuple(),...extra,overflow:1}));
 const a=normalize(tuple('0.1')).ten98_revenue_amount.value as string,b=normalize(tuple('0.2')).ten98_revenue_amount.value as string;assert.equal(BigInt(a.replace('.',''))+BigInt(b.replace('.','')),3000n);assert.equal(BigInt((normalize(tuple('999999999999999.9999')).ten98_revenue_amount.value as string).replace('.','')),9999999999999999999n);
 assert.equal(revenueCurrencyCatalogVersion,'node24.19.0-icu78.3-currency-v1');assert.equal(new Set(revenueCurrencies).size,revenueCurrencies.length);for(const code of['USD','AED','EUR','JPY','KWD'])assert.ok(revenueCurrencies.includes(code));assert.ok(!revenueCurrencies.includes('XXX'));assert.ok(!revenueCurrencies.includes('XTS'));
});
test('declared tuples fail closed without changing generic input limits or accepting numeric coercion',()=>{
 for(const amount of['0','0.0000','-1','+1','01','00.1','.1','1.','1.00000','1000000000000000','1e3',' 1','1 ','1\n','NaN','Infinity',1,0.1,null,true,[],{amount:'1'}])assert.throws(()=>normalize(tuple(amount)));
 for(const kind of['','SALE','chargeback',1,null])assert.throws(()=>normalize(tuple('1',kind)));
 for(const currency of['usd','USD\n',' USD','XXX','XTS','ZZZ','US','USDD',1,null])assert.throws(()=>normalize(tuple('1','sale',currency)));
 for(const key of revenuePropertyNames){const raw:Record<string,unknown>=tuple();delete raw[key];assert.throws(()=>normalize(raw));assert.throws(()=>normalize({...tuple(),[key]:1}));}
 for(const extra of['ten98_revenue_extra','ten98_revenue_','ten98_revenue_amount.part'])assert.throws(()=>normalize({...tuple(),[extra]:'hidden'}));assert.throws(()=>normalize({ten98_revenue_extra:'1'}));assert.throws(()=>normalize({...tuple(),ten98_revenue_version:'2'}));assert.throws(()=>normalize(tuple(),'page_view'));
 assert.throws(()=>normalize({...tuple(),bad:'x'.repeat(1001)}));assert.throws(()=>normalize({...tuple(),bad:'\0'}));assert.throws(()=>normalize({...tuple(),bad:JSON.parse('{"__proto__":{"polluted":true}}')}));
 const ordinary=normalizeProperties({ten98_revenue:'ordinary',customer_plan:'free'});assert.equal(normalizeRevenueProperties('purchase',ordinary),ordinary);
});
