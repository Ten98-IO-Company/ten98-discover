import { detectOS, parseUserAgent } from 'detect-browser';
import UAParser from 'ua-parser-js';
import { toUSVString } from 'node:util';
import { environmentCatalog, environmentVersion } from '../lib/analytics-environment.ts';

const desktopSystems = new Set(['Windows 3.11','Windows 95','Windows 98','Windows 2000','Windows XP','Windows Server 2003','Windows Vista','Windows 7','Windows 8','Windows 8.1','Windows 10','Windows ME','Open BSD','Sun OS','Linux','Mac OS','BeOS','OS/2','Chrome OS']);
export function analyticsEnvironment(userAgent: string, screenWidth?: number) {
  const unknown = { browser: 'unknown', os: 'unknown', device: 'unknown', environmentVersion };
  if (!userAgent || userAgent.length > 1024 || toUSVString(userAgent) !== userAgent || /[\x00-\x1f\x7f]/.test(userAgent)) return unknown;
  const parsed = parseUserAgent(userAgent), detectedOs = detectOS(userAgent);
  const browser = parsed && (environmentCatalog.browser as readonly string[]).includes(parsed.name) ? parsed.name : 'unknown';
  const os = detectedOs && (environmentCatalog.os as readonly string[]).includes(detectedOs) ? detectedOs : 'unknown';
  // v1 truncates internally at 500 characters: do not infer a desktop from a
  // truncated mobile hint. The browser/OS detector still has the 1024-char bound.
  const type = userAgent.length <= 500 ? new UAParser(userAgent).getDevice().type : undefined;
  let device = type && (environmentCatalog.device as readonly string[]).includes(type) ? type : 'unknown';
  // ponytail: laptop is the pinned Umami width heuristic, not hardware detection.
  // UA-only desktop fallback requires a recognized desktop OS; unknown stays unknown.
  if (userAgent.length <= 500 && !type && desktopSystems.has(os) && !['unknown','curl','bot','searchbot','phantomjs'].includes(browser)) {
    device = Number.isInteger(screenWidth) && screenWidth! >= 1 && screenWidth! <= 1920 ? 'laptop' : 'desktop';
  }
  return { browser, os, device, environmentVersion };
}
