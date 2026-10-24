import { defineHandler } from 'nitro/h3';
import trackerScript from '../../public/tracker.js?raw';
import { handleApi } from './api.ts';
import { collectorResponse } from './collector-alias.ts';

// Serves the public collector endpoints and the optional COLLECT_PATH_ALIAS and TRACKER_SCRIPT_ALIAS; any other request continues unchanged.
export default defineHandler(event => collectorResponse(event.req, trackerScript, handleApi));
