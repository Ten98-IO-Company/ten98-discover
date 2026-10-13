import {createSyntheticProviderFetch} from './provider.mjs';
globalThis.fetch=createSyntheticProviderFetch();
