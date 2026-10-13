import assert from 'node:assert/strict';
import {test} from 'node:test';
import {equalCellMean,comparisonDelta} from '../src/server/prompt-insights-comparison.ts';

test('equal-cell means distinguish missing data, measured zero and pooled-answer rates',()=>{
 assert.equal(equalCellMean([]),null);
 assert.deepEqual(equalCellMean([{numerator:0,denominator:12}]),{numerator:'0',denominator:'1'});
 const current=equalCellMean([{numerator:2,denominator:2},{numerator:0,denominator:1}]);
 const previous=equalCellMean([{numerator:0,denominator:1},{numerator:1,denominator:1}]);
 assert.deepEqual(current,{numerator:'1',denominator:'2'}); // The pooled answer rate would be2/3.
 assert.deepEqual(previous,current);
 assert.deepEqual(comparisonDelta(current,previous),{numerator:'0',denominator:'1'});
 assert.equal(comparisonDelta(current,null),null);
 assert.equal(comparisonDelta(null,previous),null);
 assert.deepEqual(equalCellMean(Array.from({length:1000},()=>({numerator:1,denominator:1}))),{numerator:'1',denominator:'1'});
});

test('fraction means and signed changes retain exact rational values',()=>{
 const current=equalCellMean([{numerator:1,denominator:2},{numerator:1,denominator:3},{numerator:1,denominator:7}]);
 assert.deepEqual(current,{numerator:'41',denominator:'126'});
 const previous={numerator:'5',denominator:'6'};
 assert.deepEqual(comparisonDelta(current,previous),{numerator:'-32',denominator:'63'});
 assert.deepEqual(comparisonDelta(previous,current),{numerator:'32',denominator:'63'});
 assert.deepEqual(comparisonDelta({numerator:'1',denominator:'1'},{numerator:'0',denominator:'1'}),{numerator:'1',denominator:'1'});
 assert.deepEqual(comparisonDelta({numerator:'0',denominator:'1'},{numerator:'1',denominator:'1'}),{numerator:'-1',denominator:'1'});
 assert.deepEqual(comparisonDelta({numerator:'9007199254740993',denominator:'9007199254740994'},{numerator:'9007199254740992',denominator:'9007199254740994'}),{numerator:'1',denominator:'9007199254740994'});
});

test('order, equivalent fractions and repeated cells do not alter equal weighting',()=>{
 const parts=Object.freeze([Object.freeze({numerator:1,denominator:3}),Object.freeze({numerator:2,denominator:5}),Object.freeze({numerator:7,denominator:11})]);
 const expected=equalCellMean([...parts]);
 assert.deepEqual(equalCellMean([...parts].reverse()),expected);
 assert.deepEqual(equalCellMean([...parts,...parts]),expected);
 assert.deepEqual(equalCellMean(parts.map(p=>({numerator:p.numerator*7,denominator:p.denominator*7}))),expected);
 // Independent cross-multiplication oracle exceeds Number precision. It does
 // not repeat the implementation's iterative reduction algorithm.
 const denominators=[97,89,83,79,73,71,67,61,59,53];
 const actual=equalCellMean(denominators.map(denominator=>({numerator:1,denominator})))!;
 const product=denominators.reduce((n,d)=>n*BigInt(d),1n);
 assert.ok(product>BigInt(Number.MAX_SAFE_INTEGER));
 const sum=denominators.reduce((n,d)=>n+product/BigInt(d),0n);
 assert.equal(BigInt(actual.numerator)*product*BigInt(denominators.length),sum*BigInt(actual.denominator));
});

test('invalid and unbounded populations cannot silently become rates',()=>{
 for(const part of [{numerator:0,denominator:0},{numerator:-1,denominator:1},{numerator:2,denominator:1},{numerator:1.5,denominator:2},{numerator:1,denominator:1001},{numerator:NaN,denominator:1},{numerator:0,denominator:Infinity}])assert.throws(()=>equalCellMean([part]),RangeError);
 assert.throws(()=>equalCellMean(Array.from({length:1001},()=>({numerator:0,denominator:1}))),RangeError);
 for(const value of [{numerator:'-1',denominator:'2'},{numerator:'01',denominator:'2'},{numerator:'1',denominator:'0'},{numerator:'2',denominator:'1'},{numerator:'1\n',denominator:'2'},{numerator:'1',denominator:'2\n'},{numerator:'1',denominator:'9'.repeat(4097)}])assert.throws(()=>comparisonDelta(value,{numerator:'0',denominator:'1'}),RangeError);
});
