import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyticsResetInput,analyticsResetState,analyticsResetResult} from '../src/lib/analytics-reset.ts';
import {analyticsIdentity,trackingConsentEpoch} from '../src/server/native-analytics.ts';
const id='10000000-0000-4000-8000-000000000001',epoch='20000000-0000-4000-8000-000000000001',next='20000000-0000-4000-8000-000000000002';
test('reset requires one exact irreversible confirmation, bounded current revision and immutable request identity',()=>{
 const input={requestId:id,revision:1,confirmation:'RESET'};assert.deepEqual(analyticsResetInput.parse(input),input);
 for(const value of [null,{}, {...input,confirmation:'reset'},{...input,confirmation:'RESET '},{...input,confirmation:'RESET\n'},{...input,revision:0},{...input,revision:2147483647},{...input,requestId:'invalid'},{...input,cutoff:'2099-01-01'}])assert.equal(analyticsResetInput.safeParse(value).success,false);
});
test('reset receipt remains bounded, exact microseconds and current authority are separate from original acceptance',()=>{
 const state={projectId:id,name:'Website',role:'admin',revision:4,retainedFrom:'2026-10-16T10:00:00.000900Z',cleanup:'pending'},ack={projectId:id,requestId:epoch,appliedRevision:2,cutoff:'2026-10-16T10:00:00.000100Z'};
 assert.deepEqual(analyticsResetResult.parse({state,ack,replayed:true}),{state,ack,replayed:true});
 for(const value of [{...state,role:'editor'},{...state,retainedFrom:'2026-10-16T10:00:00.000Z'},{...state,cleanup:'deleted'},{...state,extra:true}])assert.equal(analyticsResetState.safeParse(value).success,false);
 assert.equal(analyticsResetResult.safeParse({state:{...state,revision:1},ack,replayed:true}).success,false);
 assert.equal(analyticsResetResult.safeParse({state,ack:{...ack,projectId:next},replayed:true}).success,false);
});
test('epoch revokes old signed context without inventing a new monthly visitor hash',()=>{
 const base={projectId:id,ip:'192.0.2.1',userAgent:'Synthetic browser',secret:'synthetic-secret-at-least32characters',now:new Date('2026-10-16T10:59:00Z')};
 const before=analyticsIdentity({...base,epoch})!;const continued=analyticsIdentity({...base,now:new Date('2026-10-16T11:00:00Z'),context:before.context,epoch})!;
 assert.equal(continued.context,before.context);assert.equal(continued.visit,before.visit);
 const after=analyticsIdentity({...base,now:new Date('2026-10-16T11:00:00Z'),context:before.context,epoch:next})!;
 assert.equal(after.visitor,before.visitor);assert.notEqual(after.visit,before.visit);assert.notEqual(after.context,before.context);
 assert.notEqual(trackingConsentEpoch(epoch,null),trackingConsentEpoch(next,null));
 const legacy=analyticsIdentity(base)!;assert.equal(analyticsIdentity({...base,context:legacy.context})!.context,legacy.context,'Omitted epoch retains the existing pure helper contract.');
 assert.notEqual(analyticsIdentity({...base,context:legacy.context,epoch})!.context,legacy.context);
});
