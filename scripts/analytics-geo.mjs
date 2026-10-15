import {createHash,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {lstat,mkdir,open,rename,unlink,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {geographyFileLimit,loadGeographyDatabase} from '../src/server/analytics-geography.ts';

const pageUrl='https://db-ip.com/db/download/ip-to-city-lite';
class InstallError extends Error {}
const fail=message=>{throw new InstallError(message);};
async function regularOrMissing(path){try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail('The managed geography destination must be a regular file.');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function get(url){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(180000)});if(response.status!==200||!response.body){await response.body?.cancel().catch(()=>{});fail('The named official geography release is unavailable.');}return response;}
function bounded(limit,onChunk=()=>{}){let bytes=0;return new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>limit)return done(new InstallError('The geography download exceeds its byte limit.'));onChunk(chunk);done(null,chunk);}});}

/** Explicit operator action only. No arbitrary URL, scheduled download or application credentials. */
export async function installGeography(release,directory=resolve('data/geography')){
 if(typeof release!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(release)||release<'1970-01'||release>'9998-12')fail('Choose a named geography release in YYYY-MM format.');
 const root=resolve(directory),target=resolve(root,'city.mmdb'),receipt=resolve(root,'city.json'),nonce=randomUUID(),temporary=resolve(root,`.geo-${nonce}.mmdb`),temporaryReceipt=resolve(root,`.geo-${nonce}.json`);
 await mkdir(root,{recursive:true,mode:0o755});const storage=await lstat(root);if(!storage.isDirectory()||storage.isSymbolicLink())fail('Use a real geography data directory.');
 await regularOrMissing(target);await regularOrMissing(receipt);
 try{
  const pageResponse=await get(pageUrl),chunks=[];await pipeline(Readable.fromWeb(pageResponse.body),bounded(2*1024*1024),new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}}));
  const html=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),artifact=`https://download.db-ip.com/free/dbip-city-lite-${release}.mmdb.gz`,marker=html.indexOf(artifact);
  if(marker<0)fail('This named release and its checksum are not on the official download page.');
  const section=html.slice(Math.max(0,html.lastIndexOf('MMDB',marker)),marker),publishedSha1=section.match(/(?:SHA1SUM|SHA1)[\s\S]{0,350}?\b([a-f0-9]{40})\b/i)?.[1]?.toLowerCase();
  if(!publishedSha1)fail('The official MMDB checksum could not be verified.');
  const sha1=createHash('sha1'),sha256=createHash('sha256');let bytes=0;
  const response=await get(artifact);await pipeline(Readable.fromWeb(response.body),bounded(geographyFileLimit),createGunzip(),bounded(geographyFileLimit,chunk=>{bytes+=chunk.length;sha1.update(chunk);sha256.update(chunk);}),createWriteStream(temporary,{flags:'wx',mode:0o644}));
  const digest=sha256.digest('hex');if(sha1.digest('hex')!==publishedSha1)fail('The uncompressed geography checksum does not match. The installed database was preserved.');
  const candidate=await loadGeographyDatabase(temporary),database=candidate.database;
  if(database.status!=='ready'||database.databaseSha256!==digest||database.bytes!==bytes||new Date(database.databaseBuild*1000).toISOString().slice(0,7)!==release)fail('The geography file is not a valid matching City Lite release. The installed database was preserved.');
  const provenance={source:'DB-IP City Lite',release,sourceUrl:pageUrl,artifactUrl:artifact,license:'CC-BY-4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'IP location data by DB-IP',checksumTarget:'uncompressed-mmdb',publishedSha1,sha256:digest,bytes,databaseBuild:database.databaseBuild,verifiedAt:new Date().toISOString()};
  const file=await open(temporary,'r+');try{await file.sync();}finally{await file.close();}
  await writeFile(temporaryReceipt,JSON.stringify(provenance,null,2)+'\n',{flag:'wx',mode:0o644});
  // The web process reads only the verified data file; the receipt is not its authority.
  await regularOrMissing(target);await regularOrMissing(receipt);await rename(temporary,target);await rename(temporaryReceipt,receipt);
  return provenance;
 }finally{
  for(const path of[temporary,temporaryReceipt]){if(dirname(path)!==root||!basename(path).startsWith(`.geo-${nonce}.`))throw Error('Invalid temporary geography path.');await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{if(process.argv.length<3||process.argv.length>4)fail('Usage: node scripts/analytics-geo.mjs YYYY-MM [data-directory]');const result=await installGeography(process.argv[2],process.argv[3]);console.log(JSON.stringify(result,null,2));console.log('Verified geography installed. Restart web with compose.geo.yaml; the worker does not need it.');}
 catch(error){console.error(error instanceof InstallError?error.message:'Geography installation failed. Check connectivity, storage and file permissions; the service was not restarted.');process.exitCode=1;}
}
