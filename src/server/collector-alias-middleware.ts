import { defineHandler } from 'nitro/h3';
import trackerScript from '../../public/tracker.js?raw';
import { handleApi } from './api.ts';
import { collectorAliasResponse } from './collector-alias.ts';

// Serves the optional COLLECT_PATH_ALIAS and TRACKER_SCRIPT_ALIAS; any other request continues unchanged.
export default defineHandler(event => collectorAliasResponse(event.req, trackerScript, handleApi));
