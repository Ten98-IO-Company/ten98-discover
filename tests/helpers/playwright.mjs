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
const touchState = new WeakMap();

// The one way browser suites resize a page. At phone width it turns on Chromium touch emulation (the same CDP
// override as a `hasTouch` context, which makes `pointer: coarse` match). Wider sizes turn off only the emulation
// this helper turned on; a context created with `hasTouch` already has touch and is never overridden.
export async function setViewport(page, size) {
  await page.setViewportSize(size);
  const phone = size.width <= PHONE_MAX_WIDTH;
  let state = touchState.get(page);
  if (!state) {
    if (!phone) return;
    // Checked before this helper ever emulates touch, so it reflects the context's own hasTouch option.
    const nativeTouch = await page.evaluate(() => navigator.maxTouchPoints > 0);
    state = {nativeTouch, session: null, enabled: false};
    touchState.set(page, state);
  }
  if (state.nativeTouch || phone === state.enabled) return;
  state.session ??= await page.context().newCDPSession(page);
  await state.session.send('Emulation.setTouchEmulationEnabled', phone ? {enabled: true, maxTouchPoints: 5} : {enabled: false});
  state.enabled = phone;
}
