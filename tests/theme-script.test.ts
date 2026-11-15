import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';

// The pre-paint theme script paints the cache that the shell's useTheme keeps, so only the app shell route (/) may carry it.
// The root route would put it on every document, and the public share pages (/share/boards/*, /share/websites/*) keep the
// sharer's theme on a light canvas. The compiled-document check is in tests/integration.ts; this one runs without a server.
const source=(name:string)=>readFile(name,'utf8');

test('only the app shell route paints the cached theme before the first frame',async()=>{
 // Routes, components and shared client code; server modules never render the document head.
 const files:string[]=[];
 for(const dir of ['src/routes','src/components','src/lib'])for(const name of await readdir(dir,{recursive:true}))if(/\.tsx?$/.test(name))files.push(dir+'/'+name.replaceAll('\\','/'));
 const users:string[]=[];
 for(const name of files)if(/\bcreateThemeScript\b/.test(await source(name)))users.push(name);
 assert.deepEqual(users,['src/routes/index.tsx'],'createThemeScript belongs to the shell route only');
 assert.match(await source('src/routes/index.tsx'),/head: \(\) => \(\{ scripts: \[\{ children: createThemeScript\(\) \}\] \}\)/,'the shell route adds the script to its own head, where the router adds the CSP nonce');
});
