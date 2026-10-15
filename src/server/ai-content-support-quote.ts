import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {moneyInput,usd,usdMicros} from './providers.ts';
import {decimalSumMicros,type RouteSnapshot} from './openrouter-input.ts';
import {openRouterRouteIdentity,openRouterTextProfile} from '../lib/openrouter-models.ts';
import {executionRequestBody} from './openrouter.ts';
import {createContentSupportSnapshot,contentSupportMessages,contentSupportSchema,contentSupportPurpose,contentSupportLimits} from './ai-content-support-input.ts';

const routeFields=['model','tag','providerName','promptCapacity','completionCapacity','promptPrice','completionPrice','requestPrice','estimateMicros','profile','contextLength'];
/** Internal payload construction only. Receipt strings do not establish source authority.
 * payloadHash is NOT a ledger input identity: a future current-authority quote must
 * additionally bind actor/project/connection/key identities and original source clocks. */
export function prepareContentSupportQuote(selection:unknown,capturedRoute:unknown,maximumUsd:unknown){
 const snapshot=createContentSupportSnapshot(selection),messages=contentSupportMessages(snapshot),maxSpendUsd=parse(moneyInput,maximumUsd);
 if(usdMicros(maxSpendUsd)===0n)throw new FoundationError(400,'Choose a positive per-request spending ceiling.');
 if(!openRouterRouteIdentity(capturedRoute)||capturedRoute.profile!==openRouterTextProfile||Object.keys(capturedRoute).length!==routeFields.length||routeFields.some(k=>!Object.hasOwn(capturedRoute,k)))throw new FoundationError(409,'The captured model route is unsupported. Prepare a new quote.');
 const route=structuredClone(capturedRoute) as RouteSnapshot;let estimateMicros:bigint;
 try{estimateMicros=decimalSumMicros([{price:route.promptPrice,count:route.promptCapacity},{price:route.completionPrice,count:contentSupportLimits.outputTokens},{price:route.requestPrice,count:1}]);}
 catch{throw new FoundationError(409,'The captured endpoint prices cannot bound this request. Prepare a new quote.');}
 if(estimateMicros<1n||estimateMicros>1_000_000_000_000n||estimateMicros.toString()!==route.estimateMicros)throw new FoundationError(409,'The captured reservation does not match the complete request. Prepare a new quote.');
 if(estimateMicros>usdMicros(maxSpendUsd))throw new FoundationError(409,'The verified reservation exceeds the selected per-request ceiling.');
 // UUID and keyed actor hashes have fixed lengths; this preflight is not a dispatched request.
 const body=executionRequestBody(messages,route,contentSupportLimits.outputTokens,'00000000-0000-4000-8000-000000000000','0'.repeat(64),contentSupportPurpose);
 const value={snapshot,messages,route,maxSpendUsd,outputTokens:contentSupportLimits.outputTokens,schemaHash:canonicalHash(contentSupportSchema)};
 return {...value,payloadHash:canonicalHash(value),requestBytes:Buffer.byteLength(JSON.stringify(body),'utf8'),estimateMicros:estimateMicros.toString(),estimateUsd:usd(estimateMicros)};
}
