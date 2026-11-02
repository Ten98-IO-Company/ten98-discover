import {FoundationError} from './auth.ts';
import {canonicalHash} from './context-input.ts';
import {type RouteSnapshot} from './openrouter-input.ts';
import {openRouterRouteIdentity,openRouterTextProfile} from '../lib/openrouter-models.ts';
import {executionRequestBody} from './openrouter.ts';
import {createContentSupportSnapshot,contentSupportMessages,contentSupportSchema,contentSupportPurpose,contentSupportLimits} from './ai-content-support-input.ts';

const routeFields=['model','tag','providerName','promptCapacity','completionCapacity','profile','contextLength'];
// Payload identity binds the complete selected evidence and model route; dispatch separately rechecks authority.
export function prepareContentSupportRequest(selection:unknown,capturedRoute:unknown){
 const snapshot=createContentSupportSnapshot(selection),messages=contentSupportMessages(snapshot);
 if(!openRouterRouteIdentity(capturedRoute)||capturedRoute.profile!==openRouterTextProfile||Object.keys(capturedRoute).length!==routeFields.length||routeFields.some(k=>!Object.hasOwn(capturedRoute,k)))throw new FoundationError(409,'The captured model route is unsupported. Prepare the request again.');
 const route=structuredClone(capturedRoute) as RouteSnapshot;
 if(route.completionCapacity<contentSupportLimits.outputTokens||route.promptCapacity>(route.contextLength??0)||(route.contextLength??0)<=contentSupportLimits.outputTokens)throw new FoundationError(409,'The complete request exceeds the selected model capacity.');
 const body=executionRequestBody(messages,route,contentSupportLimits.outputTokens,'00000000-0000-4000-8000-000000000000','0'.repeat(64),contentSupportPurpose);
 const value={snapshot,messages,route,outputTokens:contentSupportLimits.outputTokens,schemaHash:canonicalHash(contentSupportSchema)};
 return {...value,payloadHash:canonicalHash(value),requestBytes:Buffer.byteLength(JSON.stringify(body),'utf8')};
}
