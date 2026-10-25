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

// Phone widths are touch screens: @ten98/ui sizes controls 36px for a fine pointer and 44px for `pointer: coarse`.
export const PHONE_MAX_WIDTH = 760;
const touchSessions = new WeakMap();

// The one way browser suites resize a page. At phone width it turns on Chromium touch emulation (the same CDP
// override as a `hasTouch` context, which makes `pointer: coarse` match); wider sizes return to the fine pointer
// unless the context itself was created with touch.
export async function setViewport(page, size) {
  await page.setViewportSize(size);
  const phone = size.width <= PHONE_MAX_WIDTH;
  let session = touchSessions.get(page);
  if (!phone && !session) return;
  if (!session) {
    session = await page.context().newCDPSession(page);
    touchSessions.set(page, session);
  }
  await session.send('Emulation.setTouchEmulationEnabled', phone ? {enabled: true, maxTouchPoints: 5} : {enabled: false});
}
