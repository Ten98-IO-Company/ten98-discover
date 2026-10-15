import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {geographyName,geographyObservationSchema,geographyKey,parseGeographyKey,serializeGeographyKey,projectGeography,geographyFiltersValid,type GeoField} from '../src/lib/analytics-geography.ts';
import {loadGeographyDatabase,normalizeGeographyLookup,geographyFileLimit} from '../src/server/analytics-geography.ts';
import {normalizeDimensions} from '../src/server/analytics-input.ts';
import {publicAnalyticsSettings,publicTrackingSettings} from '../src/server/native-analytics.ts';

test('geography uses strict provenance, normalized bounded names and qualified categorical keys',()=>{
 const provenance={databaseBuild:1790818881,databaseSha256:'a'.repeat(64)},a=normalizeGeographyLookup({country:{iso_code:'US'},subdivisions:[{iso_code:'CA',names:{en:' California '}}],city:{names:{en:'Cafe\u0301'}}},provenance);
 assert.equal(a.city,'Café');assert.deepEqual(a.region,{code:'US-CA',name:'California'});assert.deepEqual(geographyObservationSchema.parse(a),a);
 for(const field of ['country','region','city']as GeoField[]){const key=geographyKey(field,a),wire=serializeGeographyKey(field,key)!;assert.deepEqual(parseGeographyKey(field,wire),key);for(const invalid of [' '+wire,wire.replace('{','{"extra":true,'),wire.replace('"state":','"state":"known","state":'),wire.replace('US','us')])assert.equal(parseGeographyKey(field,invalid),null);}
 const named=normalizeGeographyLookup({country:{iso_code:'US'},subdivisions:[{names:{en:'Unknown'}}],city:{names:{en:'Example'}}},provenance),other=normalizeGeographyLookup({country:{iso_code:'CA'},subdivisions:[{names:{en:'Unknown'}}],city:{names:{en:'Example'}}},provenance);assert.notDeepEqual(geographyKey('city',named),geographyKey('city',other));assert.deepEqual(geographyKey('region',named),{state:'known',country:'US',region:{kind:'name',value:'Unknown'}});
 assert.deepEqual(geographyKey('country',null),{state:'not-recorded'});assert.deepEqual(geographyKey('country',normalizeGeographyLookup(null,provenance)),{state:'unknown'});
 const noRegion=normalizeGeographyLookup({country:{iso_code:'US'},city:{names:{en:'Example'}}},provenance);assert.deepEqual(geographyKey('city',noRegion),{state:'known',country:'US',region:null,city:'Example'});
 for(const field of ['constructor','__proto__','toString','future'])assert.equal(parseGeographyKey(field as GeoField,'{"state":"unknown"}'),null);
 assert.equal(geographyFiltersValid({country:serializeGeographyKey('country',geographyKey('country',a))!,city:serializeGeographyKey('city',geographyKey('city',other))!}),false);
 assert.equal(geographyFiltersValid({region:serializeGeographyKey('region',geographyKey('region',a))!,city:serializeGeographyKey('city',geographyKey('city',noRegion))!}),false);
 assert.equal(geographyFiltersValid({country:serializeGeographyKey('country',geographyKey('country',a))!,city:'{"state":"not-recorded"}'}),true);
 const countryKey=serializeGeographyKey('country',geographyKey('country',a))!,regionKey=serializeGeographyKey('region',geographyKey('region',a))!,cityKey=serializeGeographyKey('city',geographyKey('city',a))!,noRegionCity=serializeGeographyKey('city',geographyKey('city',noRegion))!;
 for(const state of ['unknown','not-recorded'])for(const child of ['region','city']as const)assert.equal(geographyFiltersValid({country:JSON.stringify({state}),[child]:child==='region'?regionKey:cityKey}),false);
 assert.equal(geographyFiltersValid({region:'{"state":"unknown"}',city:cityKey}),false);assert.equal(geographyFiltersValid({region:'{"state":"unknown"}',city:noRegionCity}),true);assert.equal(geographyFiltersValid({region:'{"state":"not-recorded"}',city:noRegionCity}),false);assert.equal(geographyFiltersValid({country:countryKey,region:'{"state":"not-recorded"}',city:'{"state":"unknown"}'}),true);
 for(const bad of [{...a,version:'future'},{...a,databaseBuild:'1'},{...a,databaseSha256:'A'.repeat(64)},{...a,country:null},{...a,region:{code:'CA-ON',name:null}},{...a,region:{code:null,name:null}},{...a,city:'Cafe\u0301'},{...a,city:' x '},{...a,coordinates:[1,2]}])assert.equal(projectGeography(bad),null);
 for(const value of ['x'.repeat(129),'\ud800','a\n','x\u0080'])assert.equal(geographyName(value),null);assert.equal(geographyName('😀'.repeat(128))?.length,256);
 for(const raw of [{geography:a},{country:'US'},{region:'US-CA'},{city:'Example'}])assert.throws(()=>normalizeDimensions(raw));
 const legacy={enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]};assert.equal(publicAnalyticsSettings(legacy).captureGeography??false,false);assert.deepEqual(publicTrackingSettings({...legacy,captureGeography:true}),{...legacy,collectionMode:'consent-first'});for(const captureGeography of [null,1,'true'])assert.throws(()=>publicAnalyticsSettings({...legacy,captureGeography}));
});

test('a POSIX FIFO is rejected without waiting for a writer at web startup',{skip:process.platform==='win32'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ten98-geo-fifo-')),path=join(directory,'fifo');
 try{assert.equal(spawnSync('mkfifo',[path],{timeout:2000}).status,0);const entry=pathToFileURL(resolve('src/server/analytics-geography.ts')).href,source=`import{loadGeographyDatabase}from${JSON.stringify(entry)};const r=await loadGeographyDatabase(${JSON.stringify(path)});console.log(JSON.stringify(r.database));`,result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:3000});assert.equal(result.status,0,'FIFO must not block the loader.');assert.deepEqual(JSON.parse(result.stdout),{status:'unavailable',reason:'invalid'});
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('ten98-geo-fifo-'));await rm(directory,{recursive:true,force:true});}
});

test('file readiness fails locally without lookups/retries for missing, corrupt, empty or oversized artifacts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ten98-geo-file-'));
 try{assert.deepEqual((await loadGeographyDatabase()).database,{status:'unavailable',reason:'not-configured'});assert.equal((await loadGeographyDatabase(join(directory,'missing'))).database.status,'unavailable');await writeFile(join(directory,'corrupt'),'not MMDB');assert.equal((await loadGeographyDatabase(join(directory,'corrupt'))).database.status,'unavailable');await writeFile(join(directory,'empty'),'');assert.equal((await loadGeographyDatabase(join(directory,'empty'))).database.status,'unavailable');const file=await open(join(directory,'oversized'),'wx');try{await file.truncate(geographyFileLimit+1);}finally{await file.close();}const reader=await loadGeographyDatabase(join(directory,'oversized'));assert.deepEqual(reader.database,{status:'unavailable',reason:'too-large'});assert.equal(reader.lookup('8.8.8.8'),null);
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('ten98-geo-file-'));await rm(directory,{recursive:true,force:true});}
});
