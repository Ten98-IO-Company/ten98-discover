import {fixtureGuard} from './guard.mjs';
// The application and fixture have no outbound HTTP use in this acceptance slice.
fixtureGuard({manifest:false});
globalThis.fetch=async()=>{throw new Error('Outbound fetch is disabled in conversions acceptance.');};
