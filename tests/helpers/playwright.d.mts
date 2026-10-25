// Playwright is supplied at run time through PLAYWRIGHT_MODULE and is not an installed dependency, so its types stay loose.
export function loadPlaywright(): Promise<any>;
export function launchChromium(options?: Record<string, unknown>): Promise<any>;
export const PHONE_MAX_WIDTH: number;
export function setViewport(page: any, size: {width: number; height: number}): Promise<void>;
