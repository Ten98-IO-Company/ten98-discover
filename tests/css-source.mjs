import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Expand local/package CSS imports for the isolated HTTP fixtures. Browsers cannot
// resolve bare package specifiers; no network or application server is involved.
export async function readCssSource(file, ancestors = new Set()) {
 const url = file instanceof URL ? file : pathToFileURL(resolve(file));
 if (url.protocol !== 'file:' || ancestors.has(url.href)) throw new Error('Invalid or circular CSS import: '+url.href);
 const parents = new Set([...ancestors, url.href]);
 let css = await readFile(url, 'utf8');
 for (const match of [...css.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*;/g)]) {
  const imported = match[2].startsWith('.') ? new URL(match[2], url) : new URL(import.meta.resolve(match[2]));
  css = css.replace(match[0], await readCssSource(imported, parents));
 }
 if (/@import\b/.test(css)) throw new Error('Unsupported CSS import in '+url.href);
 return css;
}
