import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicAnalyticsSettings} from '../src/server/native-analytics.ts';

test('privacy settings reject control suffixes and malformed path encodings', () => {
  const settings={enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};
  for(const path of ['/private\n','/private\r','/private\0','/private\u007f','/%ff','/%','/\ud800']) {
    assert.throws(()=>publicAnalyticsSettings({...settings,excludedPaths:[path]}));
  }
  assert.deepEqual(publicAnalyticsSettings({...settings,excludedPaths:['/café','/caf%C3%A9','/private area']}).excludedPaths,
    ['/café','/caf%C3%A9','/private area']);
});
