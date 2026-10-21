import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Single Playwright entry for browser tests: module from PLAYWRIGHT_MODULE, browser channel from PLAYWRIGHT_CHANNEL.
export async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE;
  return import(spec ? (spec.startsWith('file:') ? spec : pathToFileURL(resolve(spec)).href) : 'playwright');
}

export async function launchChromium(options = {}) {
  const {chromium} = await loadPlaywright();
  return chromium.launch({headless: true, ...options, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge'});
}
