import assert from 'node:assert/strict';
import {test} from 'node:test';
import {googleAdsColumnLabel,googleAdsCost} from '../src/lib/google-report-display.ts';

test('Ads cost uses exact account-currency micros beyond safe Number precision',()=>{
  assert.equal(googleAdsCost('9007199254740993','AED'),'AED 9,007,199,254.740993');
  assert.equal(googleAdsCost('9007199254740994','AED'),'AED 9,007,199,254.740994');
  assert.equal(googleAdsCost('0','JPY'),'JPY 0.000000');
  assert.equal(googleAdsCost('1','EUR'),'EUR 0.000001');
  assert.equal(googleAdsCost('999999999999999999999999999999','KWD'),'KWD 999,999,999,999,999,999,999,999.999999');
  assert.equal(googleAdsCost('1000000','USD'),'USD 1.000000');
  for(const currency of [null,undefined,'','usd','ZZZ','AED\n',42])assert.equal(googleAdsCost('1000000',currency),'1.000000 (currency unavailable)');
});
test('Unavailable/invalid amounts never become zero or a guessed currency',()=>{
  for(const value of [null,undefined,'','-1','01','1.0','1e6','1000000\n',' 1000000',1000000,9007199254740993,'1'.repeat(31)])assert.equal(googleAdsCost(value,'AED'),'Unavailable');
});
test('Ads columns are readable without changing raw provider field identities',()=>{
  for(const [field,label] of Object.entries({date:'Date',customerId:'Account ID',campaignId:'Campaign ID',campaignName:'Campaign',campaignStatus:'Campaign status',adGroupId:'Ad group ID',adGroupName:'Ad group',adGroupStatus:'Ad group status',impressions:'Impressions',clicks:'Clicks',costMicros:'Cost',conversions:'Conversions',conversionsValue:'Conversion value'}))assert.equal(googleAdsColumnLabel(field),label);
  assert.equal(googleAdsColumnLabel('futureField'),'futureField');assert.equal(googleAdsColumnLabel('constructor'),'constructor');
});
