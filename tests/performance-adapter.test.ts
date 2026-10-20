import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {adapterSpecs,deriveAdapter} from './helpers/check-tracker-adapters.ts';

type Metric = Ten98Tracker.PerformanceMetric;
type MetricCallback = (metric:Metric)=>void;
type Reporter = Ten98Tracker.VitalReporter;
type StartPerformance = ((callback:MetricCallback)=>void)&{protocolVersion?:number};
const reporters:Reporter[]=['onLCP','onINP','onCLS','onFCP','onTTFB'];
const asset=new URL('../public/performance.js',import.meta.url);

function loadAdapter(bytes:Buffer,withHub=true){
 // Validate the same exact vendor boundary as the semantic check, then execute the served suffix.
 deriveAdapter('performance',bytes);
 const hub:{startPerformance?:StartPerformance}={};
 const registrations:{name:Reporter;callback:MetricCallback;options:{reportAllChanges:boolean}}[]=[];
 const register=(name:Reporter)=>(callback:MetricCallback,options:{reportAllChanges:boolean})=>registrations.push({name,callback,options});
 const webVitals={onLCP:register('onLCP'),onINP:register('onINP'),onCLS:register('onCLS'),onFCP:register('onFCP'),onTTFB:register('onTTFB')};
 const at=bytes.indexOf(adapterSpecs.performance.marker);
 runInNewContext('(function(){\n'+bytes.subarray(at).toString('utf8'),{
  window:withHub?{__ten98FoundationHub:hub}:{},webVitals,
 },{timeout:1000});
 return {hub,registrations};
}

function assertMetricBridge(bytes:Buffer){
 const {hub,registrations}=loadAdapter(bytes);
 assert.equal(registrations.length,0,'Installing the hook must not begin metric collection.');
 const start=hub.startPerformance;
 assert.ok(start,'The actual adapter must install its shared hook.');
 assert.equal(start.protocolVersion,1);
 const received:Metric[]=[];
 const callback:MetricCallback=metric=>{received.push(metric);};
 start(callback);
 assert.deepEqual(registrations.map(item=>item.name),reporters);
 assert.equal(received.length,0,'Registering reporters must not invent metric values.');
 for(const [index,registration] of registrations.entries()){
  assert.equal(registration.callback,callback,'Each reporter must receive the original callback.');
  assert.equal(registration.options.reportAllChanges,true,'reportAllChanges must stay enabled.');
  assert.deepEqual(Object.keys(registration.options),['reportAllChanges']);
  const metric:Metric={name:registration.name.slice(2),value:index,navigationType:'navigate',navigationStartTime:17};
  registration.callback(metric);
  assert.equal(received[index],metric,'Vendor metric identity and navigation evidence must be preserved.');
 }
 assert.equal(received.length,reporters.length);
}

test('the served performance adapter does nothing without the shared hub',()=>{
 const {hub,registrations}=loadAdapter(readFileSync(asset),false);
 assert.equal(hub.startPerformance,undefined);
 assert.equal(registrations.length,0);
});

test('the served performance adapter forwards all five actual vendor callback registrations',()=>{
 assertMetricBridge(readFileSync(asset));
});

test('the performance behavior check rejects a type-valid reporter option regression',()=>{
 const bytes=readFileSync(asset),at=bytes.indexOf(adapterSpecs.performance.marker);
 assert.ok(at>=0);
 const suffix=bytes.subarray(at).toString('utf8'),option='reportAllChanges: true';
 assert.equal(suffix.split(option).length,2,'Mutate exactly one option in the actual app adapter.');
 const changed=Buffer.concat([bytes.subarray(0,at),Buffer.from(suffix.replace(option,'reportAllChanges: false'))]);
 assert.throws(()=>assertMetricBridge(changed),/reportAllChanges must stay enabled/);
});
