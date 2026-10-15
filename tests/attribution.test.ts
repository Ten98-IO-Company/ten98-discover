import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attributionQuery} from '../src/server/attribution.ts';
import {journeyStepSchema} from '../src/lib/journeys.ts';
import {attributionFields,attributionLimits,attributionMethod} from '../src/lib/attribution.ts';

test('Attribution owns closed model/typed conversion and reuses bounded local-calendar filters',()=>{
 const base={conversionKind:'custom',conversionValue:'purchase'},parse=(extra:Record<string,string>={})=>attributionQuery(new URLSearchParams({...base,...extra}),new Date('2026-10-15T12:00:00Z'));
 assert.equal(parse().model,'first-click');assert.deepEqual(parse().conversion,{kind:'custom',value:'purchase'});assert.equal(parse().scope.from,'2026-10-09');assert.equal(parse({model:'last-click'}).model,'last-click');
 const q=parse({from:'2026-10-01',to:'2026-10-15',timeZone:'Asia/Dubai',kind:'pageviews',path:'/literal%25',propertyKey:'plan',propertyType:'string',propertyValue:'"team"'});assert.equal(q.scope.timeZone,'Asia/Dubai');assert.deepEqual(q.scope.property,{key:'plan',type:'string',value:'team'});assert.equal(q.scope.filters.path,'/literal%25');assert.equal(q.scope.kind,'pageviews');
 const invalidCases:Record<string,string>[]=[{model:'first'},{model:'last-click\n'},{conversionKind:'event'},{conversionValue:'page_view'},{conversionKind:'pageview',conversionValue:'/path?query'},{conversionValue:'a'.repeat(65)},{groupBy:'path'},{cursor:'x'},{limit:'20'},{sort:'asc'},{currency:'USD'},{from:'2024-01-01',to:'2025-01-01'},{timeZone:'bad/zone'},{path:'a'.repeat(21000)}];for(const invalid of invalidCases)assert.throws(()=>parse(invalid),{status:400});
 for(const raw of ['','conversionKind=custom','conversionValue=purchase','conversionKind=custom&conversionValue=purchase&model=first-click&model=last-click'])assert.throws(()=>attributionQuery(new URLSearchParams(raw)),{status:400});
 assert.equal(journeyStepSchema.safeParse({kind:'pageview',value:'/\ud800'}).success,false);assert.equal(parse({conversionKind:'pageview',conversionValue:'/\ud800'}).conversion.value,'/�');
 assert.throws(()=>parse({unknown:'x'.repeat(65537)}),{status:400});assert.equal(parse({conversionKind:'pageview',conversionValue:'/'+'a'.repeat(2047)}).conversion.value.length,2048);
});
test('Attribution publishes explicit observed-key semantics and bounded fixed metadata dimensions',()=>{
 assert.deepEqual(attributionFields,['referrer','campaignSource','campaignMedium','campaignName','campaignContent','campaignTerm']);assert.equal(attributionLimits.values,20);assert.equal(attributionLimits.responseBytes,2097152);assert.equal(attributionMethod.historyComplete,false);assert.equal(attributionMethod.captureCoverage,'unknown');assert.equal(attributionMethod.referrers,'recorded-hosts-including-self');assert.equal(attributionMethod.last,'latest-timestamp-strictly-before-latest-matching-conversion');
});
