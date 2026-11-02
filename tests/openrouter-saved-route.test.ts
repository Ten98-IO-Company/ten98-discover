import assert from 'node:assert/strict';
import test from 'node:test';
import {openRouterRouteIdentity,openRouterSavedProvider} from '../src/lib/openrouter-models.ts';

test('saved v1 route preserves provider identity without admitting it for new execution',()=>{
 const historical=Object.freeze({model:'vendor/text-v1',tag:'vendor/exact',providerName:'Original Provider',profile:'openrouter-api-text-no-search-v1',contextLength:128000,promptCapacity:128000,completionCapacity:4096,promptPrice:'0.0001',completionPrice:'0.0002',requestPrice:'0',estimateMicros:'17'});
 const original=JSON.stringify(historical);
 assert.equal(openRouterSavedProvider(historical),'Original Provider');
 assert.equal(openRouterRouteIdentity(historical),false);
 assert.equal(JSON.stringify(historical),original);
 for(const patch of [{profile:'unknown-profile'},{providerName:'bad\n'},{tag:'vendor/../other'},{contextLength:0},{promptCapacity:128001},{model:'auto'}])assert.equal(openRouterSavedProvider({...historical,...patch}),null);
});
