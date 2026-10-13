import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isKeywordMetricRow} from '../src/lib/keyword-metrics.ts';

const row={keyword:'c++',searchVolume:0,cpcUsd:'0.000001',competition:0,competitionLevel:'LOW',keywordDifficulty:0,intent:null,metricsUpdatedAt:null,intentUpdatedAt:null,monthlySearches:[{year:2026,month:1,searchVolume:0}]};
test('keyword screen metric guard preserves exact decimal, unknown and zero values',()=>{
  assert.ok(isKeywordMetricRow(row));
  assert.ok(isKeywordMetricRow({...row,searchVolume:null,cpcUsd:null,competition:null,competitionLevel:null,keywordDifficulty:null,monthlySearches:[]}));
  assert.equal(row.cpcUsd,'0.000001');
});
test('both keyword screens reject malformed nested provider-display data before rendering',()=>{
  for(const changed of [null,{}, {...row,monthlySearches:[null]}, {...row,monthlySearches:[{year:2026,month:13,searchVolume:0}]}, {...row,intent:{}}, {...row,keyword:{}}, {...row,searchVolume:NaN}, {...row,cpcUsd:0.1}, {...row,cpcUsd:'0.000001\n'}, {...row,metricsUpdatedAt:'yesterday'}])assert.equal(isKeywordMetricRow(changed),false);
});
