import {definePlugin} from 'nitro';
import {initializeAnalyticsGeography} from './analytics-geography.ts';

export default definePlugin(async()=>{await initializeAnalyticsGeography();});
