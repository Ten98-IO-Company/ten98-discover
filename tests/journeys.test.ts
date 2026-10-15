import assert from 'node:assert/strict';
import {test} from 'node:test';
import {journeysQuery} from '../src/server/journeys.ts';
import {journeyStepSchema,journeysLimits,journeysMethod} from '../src/lib/journeys.ts';

test('Journeys owns a closed bounded query while reusing local-calendar/exact/typed/advanced scope',()=>{
 const input=journeysQuery(new URLSearchParams(),new Date('2026-10-15T12:00:00Z'));assert.equal(input.steps,3);assert.equal(input.start,null);assert.equal(input.end,null);assert.equal(input.scope.timeZone,'UTC');assert.equal(input.scope.kind,'all');assert.equal(input.scope.from,'2026-10-09');assert.equal(input.scope.to,'2026-10-15');
 for(const steps of ['2','7'])assert.equal(journeysQuery(new URLSearchParams({steps})).steps,Number(steps));
 const invalid:Record<string,string>[]=[{steps:'1'},{steps:'8'},{steps:'3.0'},{steps:'03'},{steps:'3\n'},{groupBy:'path'},{limit:'100'},{cursor:'anything'},{startKind:'pageview'},{endValue:'/end'},{startKind:'custom',startValue:'page_view'},{from:'2024-01-01',to:'2025-01-01'},{timeZone:'not/a/zone'},{startKind:'pageview',startValue:'/path?query'},{endKind:'custom',endValue:'a'.repeat(65)}];
 for(const params of invalid)assert.throws(()=>journeysQuery(new URLSearchParams(params)),{status:400});
 assert.throws(()=>journeysQuery(new URLSearchParams('steps=3&steps=4')),{status:400});assert.throws(()=>journeysQuery(new URLSearchParams({path:'a'.repeat(21000)})),{status:400});assert.throws(()=>journeysQuery(new URLSearchParams({unknown:'a'.repeat(65537)})),{status:400});
 const selected=journeysQuery(new URLSearchParams({from:'2026-10-01',to:'2026-10-15',timeZone:'Asia/Dubai',kind:'pageviews',startKind:'custom',startValue:'signup',endKind:'pageview',endValue:'/thanks',path:'/literal%25',propertyKey:'plan',propertyType:'string',propertyValue:'"team"'}));assert.deepEqual(selected.start,{kind:'custom',value:'signup'});assert.deepEqual(selected.end,{kind:'pageview',value:'/thanks'});assert.equal(selected.scope.filters.path,'/literal%25');assert.deepEqual(selected.scope.property,{key:'plan',type:'string',value:'team'});assert.equal(selected.scope.timeZone,'Asia/Dubai');
});
test('Typed steps preserve literals and do not accept untrusted objects or new observation fields',()=>{
 assert.equal(journeyStepSchema.safeParse({kind:'pageview',value:'/'+'a'.repeat(2047)}).success,true);assert.equal(journeyStepSchema.safeParse({kind:'custom',value:'a'.repeat(64)}).success,true);
 for(const value of [{kind:'pageview',value:'a'},{kind:'pageview',value:'/a#hash'},{kind:'pageview',value:'/\0'},{kind:'pageview',value:'/\ud800'},{kind:'pageview',value:'/'+'a'.repeat(2048)},{kind:'custom',value:'a\n'},{kind:'custom',value:'purchase',path:'/'},{kind:'pageview',value:'/',origin:'https://test.invalid'},null,[]])assert.equal(journeyStepSchema.safeParse(value).success,false);
 assert.deepEqual(journeyStepSchema.parse({kind:'pageview',value:'/"true"'}),{kind:'pageview',value:'/"true"'});assert.equal(journeysMethod.historyComplete,false);assert.equal(journeysMethod.captureCoverage,'unknown');assert.equal(journeysLimits.paths,100);assert.equal(journeysLimits.responseBytes,12582912);
});
