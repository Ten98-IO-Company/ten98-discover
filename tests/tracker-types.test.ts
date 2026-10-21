import {adapterSpecs,deriveAdapter,checkTrackerAdapters,runTypeScript,type AdapterName} from '../tests/helpers/check-tracker-adapters.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const project=join(root,'tsconfig.tracker.json');
const destinations=join(root,'public/destinations.js');
const declarations=join(root,'tests/tracker-contracts.d.ts');
const tracker=join(root,'public/tracker.js');
function check(args:string[]){
 return runTypeScript(args,120000);
}

test('maintained destinations and main tracker are included in a strict checked-JavaScript project',()=>{
 const shown=check(['--project',project,'--showConfig']);assert.equal(shown.status,0,shown.output);
 const config=JSON.parse(shown.output) as {compilerOptions:Record<string,unknown>;files:string[]};
 for(const option of ['strict','allowJs','checkJs','noEmit'])assert.equal(config.compilerOptions[option],true,option);
 for(const option of ['noImplicitAny','strictNullChecks'])assert.notEqual(config.compilerOptions[option],false,option);
 assert.ok(config.files.some(path=>resolve(root,path)===resolve(destinations)),'The served coordinator itself must be checked.');
 assert.ok(config.files.some(path=>resolve(root,path)===resolve(tracker)),'The served main tracker itself must be checked.');
 const result=check(['--project',project]);assert.equal(result.status,0,result.output);
});

function rejectMutation(marker:string,replacement:string,diagnostic:RegExp,expected:RegExp,file=destinations){
 const source=readFileSync(file,'utf8');
 assert.equal(source.split(marker).length,2,'The negative control must mutate the real producer.');
 const folder=mkdtempSync(join(tmpdir(),'ten98-tracker-types-'));
 try{
  const invalid=join(folder,basename(file,'.js')+'-invalid.js'),config=join(folder,'tsconfig.json');
  writeFileSync(invalid,source.replace(marker,replacement));
  writeFileSync(config,JSON.stringify({extends:project,compilerOptions:{typeRoots:[join(root,'node_modules/@types'),join(root,'node_modules')]},files:[invalid,declarations],include:[],exclude:[]}));
  const result=check(['--project',config]);assert.notEqual(result.status,0,'Invalid production source must not pass.');
  assert.ok(result.output.includes(basename(invalid)));assert.match(result.output,diagnostic);assert.match(result.output,expected);
 }finally{
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep),'Only the newly created test directory may be removed.');
  rmSync(folder,{recursive:true,force:true});
 }
}

test('an invalid consent assignment in the actual coordinator fails the compiler',()=>{
 rejectMutation('state.consent = value;',"state.consent = 'invalid';",/TS2322/,/Consent/);
});

test('decoded configuration stays unknown until validation and rejects unknown fields',()=>{
 rejectMutation('state.config = value; state.expires = Date.parse(value.validUntil);',
  'state.config = value; state.expires = Date.parse(value.invalidUntil);',/TS(?:2339|2551)/,/invalidUntil/);
});

test('an invalid native generation in the actual main tracker fails the compiler',()=>{
 rejectMutation('state.nativeGeneration = (state.nativeGeneration || 0) + 1;',
  "state.nativeGeneration = 'invalid';",/TS2322/,/number/,tracker);
});
test('the actual shipped replay and performance adapters are strictly checked and temporary views are removed',async()=>{
 const result=await checkTrackerAdapters();
 assert.equal(result.status,0,result.output);
 assert.deepEqual(result.adapters.map(adapter=>adapter.file).sort(),['public/performance.js','public/replay.js']);
 assert.ok(result.originalFiles.includes(resolve(root,'tests/helpers/check-tracker-adapters.ts')),'The checker itself must be checked.');
 assert.equal(existsSync(result.temporaryDirectory),false,'Checked views are derived per run and removed.');
});

for(const name of ['replay','performance'] as const){
 test(`an invalid vendor option in the actual ${name} adapter fails semantic checking`,async()=>{
  const spec=adapterSpecs[name],source=readFileSync(join(root,spec.file),'utf8');
  const marker=name==='replay'?/maskAllInputs\s*:\s*true/g:/reportAllChanges\s*:\s*true/g;
  assert.equal([...source.matchAll(marker)].length,1,'The negative probe must mutate one actual producer.');
  const invalid=source.replace(marker,name==='replay'?"maskAllInputs: 'invalid'":"reportAllChanges: 'invalid'");
  const result=await checkTrackerAdapters({[name]:Buffer.from(invalid)});
  assert.notEqual(result.status,0,'Invalid served adapter source must not pass.');
  assert.match(result.output,/TS2322/);assert.match(result.output,/boolean/);assert.ok(result.output.includes(spec.file));
  assert.equal(existsSync(result.temporaryDirectory),false,'Failed semantic checks must also remove their owned views.');
 });
}

test('adapter source derivation rejects a changed vendor prefix, duplicate marker and missing footer',()=>{
 for(const name of Object.keys(adapterSpecs) as AdapterName[]){
  const spec=adapterSpecs[name],source=readFileSync(join(root,spec.file));
  const prefix=Buffer.from(source);prefix[0]^=1;
  assert.throws(()=>deriveAdapter(name,prefix),/vendor prefix/);
  assert.throws(()=>deriveAdapter(name,Buffer.concat([source,Buffer.from(spec.marker)])),/exactly once/);
  assert.throws(()=>deriveAdapter(name,Buffer.concat([source,Buffer.from('unexpected();')])),/outer footer/);
 }
});
test('the native compiler deadline bounds a real temporary compile and cleans its owned input',()=>{
 const folder=mkdtempSync(join(tmpdir(),'ten98-compiler-deadline-'));
 try{
  const input=join(folder,'input.ts'),config=join(folder,'tsconfig.json');
  writeFileSync(input,Array.from({length:20000},(_,i)=>`export const value${i}:number=${i};`).join('\n'));
  writeFileSync(config,JSON.stringify({extends:project,compilerOptions:{types:[]},files:[input],include:[],exclude:[]}));
  assert.throws(()=>runTypeScript(['--project',config,'--pretty','false'],1),(error:unknown)=>{
   assert.ok(error instanceof Error);assert.equal((error.cause as NodeJS.ErrnoException|undefined)?.code,'ETIMEDOUT');return true;
  });
 }finally{
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true});
 }
 assert.equal(existsSync(folder),false);
});