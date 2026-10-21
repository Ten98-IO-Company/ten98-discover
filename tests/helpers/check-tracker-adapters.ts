import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,sep,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const root=fileURLToPath(new URL('../../',import.meta.url));
const project=join(root,'tsconfig.tracker.json');
const compilerPackage=join(root,'node_modules/typescript/package.json');
export const adapterSpecs={
 replay:{file:'public/replay.js',marker:'// App adapter appended inside the private CommonJS closure around pinned rrweb.',prefixBytes:568348,prefixSha256:'887f6391b50223b3cb4e2e4188b53059d040d98de09ec8dc4bcb736474475a18',footerBase64:'Cn0pKCk7Cg==',parameter:'module',contract:'ReplayCoreModule'},
 performance:{file:'public/performance.js',marker:'var h = window.__ten98FoundationHub;',prefixBytes:9275,prefixSha256:'93ad1d8248b3d566a5211047dacb92e7a5c95b670edf016688db1dc6c536ceda',footerBase64:'Cn0pKCk7Cg==',parameter:'webVitals',contract:'WebVitalsAdapter'},
} as const;
export type AdapterName=keyof typeof adapterSpecs;
const names=Object.keys(adapterSpecs) as AdapterName[];

export function deriveAdapter(name:AdapterName,bytes:Buffer){
 const spec=adapterSpecs[name],marker=Buffer.from(spec.marker),at=bytes.indexOf(marker);
 assert.ok(at>=0 && bytes.indexOf(marker,at+marker.length)===-1,`${spec.file}: adapter marker must occur exactly once.`);
 assert.equal(at,spec.prefixBytes,`${spec.file}: vendor boundary moved.`);
 assert.equal(createHash('sha256').update(bytes.subarray(0,at)).digest('hex'),spec.prefixSha256,`${spec.file}: pinned vendor prefix changed.`);
 const footer=Buffer.from(spec.footerBase64,'base64');
 assert.ok(bytes.subarray(bytes.length-footer.length).equals(footer),`${spec.file}: exact outer footer is missing.`);
 const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at,bytes.length-footer.length));
 const originalLine=bytes.subarray(0,at).toString('utf8').split('\n').length;
 // These parameters provide only the lexical private vendor objects from the immutable prefix.
 const header=`/** @param {Ten98Tracker.${spec.contract}} ${spec.parameter} */\nexport function checked${name}(${spec.parameter}) {\n`;
 return {source:header+body+'\n}\n',originalLine,bodyStartLine:3,file:spec.file,prefixSha256:spec.prefixSha256};
}

function nativeCompiler(){
 const pkg=JSON.parse(readFileSync(compilerPackage,'utf8')) as {name?:unknown;version?:unknown;type?:unknown;imports?:Record<string,unknown>};
 assert.equal(pkg.name,'typescript');assert.equal(pkg.version,'7.0.2','Review the pinned resolver before changing compiler versions.');assert.equal(pkg.type,'module');
 assert.equal(pkg.imports?.['#getExePath'],'./lib/getExePath.js');
 // Internal resolver coupling is pinned to TypeScript 7.0.2; delegate its platform resolution unchanged.
 const requireCompiler=createRequire(compilerPackage),resolved=requireCompiler.resolve('#getExePath');
 assert.equal(realpathSync(resolved),realpathSync(join(dirname(compilerPackage),'lib/getExePath.js')));
 const loaded:unknown=requireCompiler('#getExePath');assert.ok(loaded && typeof loaded==='object');
 const resolver=(loaded as {default?:unknown}).default;assert.equal(typeof resolver,'function');
 const executable:unknown=(resolver as ()=>unknown)();assert.ok(typeof executable==='string' && isAbsolute(executable));
 assert.equal(basename(executable),process.platform==='win32'?'tsc.exe':'tsc');assert.ok(statSync(executable).isFile());return executable;
}

export function runTypeScript(args:string[],timeout=90000){
 assert.ok(Number.isInteger(timeout) && timeout>=1 && timeout<=120000,'Compiler deadlines must remain bounded.');
 // Own the native compiler directly; the Windows Node launcher otherwise leaves a native descendant on timeout.
 const result=spawnSync(nativeCompiler(),args,{cwd:root,encoding:'utf8',timeout,killSignal:'SIGKILL',windowsHide:true,maxBuffer:4*1024*1024});
 if(result.error)throw new Error('The native compiler did not complete within its bounded invocation.',{cause:result.error});
 assert.notEqual(result.status,null,'The native compiler must exit normally.');return {status:result.status??1,stdout:result.stdout,output:result.stdout+result.stderr};
}
export async function checkTrackerAdapters(overrides:Partial<Record<AdapterName,Buffer>>={}){
 const shown=runTypeScript(['--project',project,'--showConfig'],10000);
 assert.equal(shown.status,0,shown.output);
 const config=JSON.parse(shown.stdout) as {compilerOptions:Record<string,unknown>;files:string[]};
 assert.ok(config.compilerOptions && Array.isArray(config.files),'The compiler must report its effective project membership.');
 for(const flag of ['strict','allowJs','checkJs','noEmit'])assert.equal(config.compilerOptions[flag],true,`Required option: ${flag}`);
 assert.notEqual(config.compilerOptions.noCheck,true,'Semantic checking cannot be disabled.');
 for(const flag of ['noImplicitAny','strictNullChecks','strictFunctionTypes','strictBindCallApply','strictPropertyInitialization','noImplicitThis','useUnknownInCatchVariables','alwaysStrict','strictBuiltinIteratorReturn'])assert.notEqual(config.compilerOptions[flag],false,`Strict option: ${flag}`);
 const originalFiles=config.files.map(file=>resolve(dirname(project),file));
 for(const required of ['public/tracker.js','public/destinations.js','tests/tracker-contracts.d.ts','tests/helpers/check-tracker-adapters.ts'])assert.ok(originalFiles.includes(resolve(root,required)),`Required checked source: ${required}`);
 const derived=names.map(name=>({name,...deriveAdapter(name,overrides[name]??readFileSync(join(root,adapterSpecs[name].file)))}));
 const temporaryBase=realpathSync(tmpdir()),folder=mkdtempSync(join(temporaryBase,'ten98-tracker-adapters-'));
 try{
  const wrappers=derived.map(adapter=>{const file=join(folder,adapter.name+'-adapter.js');writeFileSync(file,adapter.source);return file;});
  const temporaryProject=join(folder,'tsconfig.json');
  writeFileSync(temporaryProject,JSON.stringify({extends:project,compilerOptions:{typeRoots:[join(root,'node_modules/@types'),join(root,'node_modules')]},files:[...originalFiles,...wrappers],include:[],exclude:[]}));
  const checked=runTypeScript(['--project',temporaryProject,'--pretty','false'],90000);
  const output=checked.output.split('\n').map(line=>line.replace(/^(?:.*[\\/])?(replay|performance)-adapter\.js\((\d+),(\d+)\):/,(match,name:string,row:string,column:string)=>{
   const adapter=derived.find(item=>item.name===name);
   return adapter?`${adapter.file}(${adapter.originalLine+Number(row)-adapter.bodyStartLine},${column}):`:match;
  })).join('\n');
  return {status:checked.status,output,rawOutput:checked.output,originalFiles,temporaryDirectory:folder,adapters:derived.map(({name,file,originalLine,prefixSha256})=>({name,file,originalLine,prefixSha256}))};
 }finally{
  const owned=realpathSync(folder);
  assert.equal(owned,resolve(folder),'Only the newly created directory may be removed.');
  assert.ok(owned.startsWith(temporaryBase+sep),'The owned directory must remain inside the temporary root.');
  rmSync(owned,{recursive:true,force:true});
 }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await checkTrackerAdapters();
 if(result.output)process.stderr.write(result.output);
 process.exitCode=result.status;
}