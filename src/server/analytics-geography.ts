import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {Reader,type CityResponse} from 'mmdb-lib';
import {publicNetworkAddress} from './public-network.ts';
import {geographyName,geographyVersion,type GeographyObservation,type GeographyReadiness} from '../lib/analytics-geography.ts';

export const geographyFileLimit=256*1024*1024;
type Database=GeographyReadiness['database'];
export type GeographyReader={readonly database:Database;lookup:(address:string|null)=>GeographyObservation|null};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function normalizeGeographyLookup(value:unknown,provenance:{databaseBuild:number;databaseSha256:string}):GeographyObservation{
 const result=object(value),countryValue=object(result?.country)?.iso_code,country=typeof countryValue==='string'&&/^[A-Z]{2}$/.test(countryValue)?countryValue:null;
 const subdivision=Array.isArray(result?.subdivisions)?object(result.subdivisions[0]):null,rawCode=subdivision?.iso_code;
 const qualified=country&&typeof rawCode==='string'?(rawCode.includes('-')?rawCode:country+'-'+rawCode):null;
 const code=qualified&&qualified.length<=32&&/^[A-Z]{2}-[A-Z0-9-]+$/.test(qualified)&&qualified.startsWith(country+'-')?qualified:null;
 const name=country?geographyName(object(subdivision?.names)?.en):null,city=country?geographyName(object(object(result?.city)?.names)?.en):null;
 return{version:geographyVersion,databaseBuild:provenance.databaseBuild,databaseSha256:provenance.databaseSha256,country,region:country&&(code||name)?{code,name}:null,city};
}

/** Local trusted operator artifact only; a file cap cannot bound malicious MMDB decoder amplification. */
export async function loadGeographyDatabase(path?:string):Promise<GeographyReader>{
 let state:Database={status:'unavailable',reason:'not-configured'},reader:Reader<CityResponse>|null=null;
 if(path){
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
   file=await open(path,process.platform==='win32'?constants.O_RDONLY:constants.O_RDONLY|constants.O_NONBLOCK);const stat=await file.stat();
   if(!stat.isFile())state={status:'unavailable',reason:'invalid'};
   else if(stat.size>geographyFileLimit)state={status:'unavailable',reason:'too-large'};
   else if(stat.size===0)state={status:'unavailable',reason:'invalid'};
   else{
    const bytes=Buffer.allocUnsafe(stat.size);let offset=0;
    while(offset<bytes.length){const result=await file.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw Error('Invalid geography file.');offset+=result.bytesRead;}
    const after=await file.stat();if((await file.read(Buffer.alloc(1),0,1,offset)).bytesRead!==0||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Invalid geography file.');
    const databaseSha256=createHash('sha256').update(bytes).digest('hex'),candidate=new Reader<CityResponse>(bytes),metadata=candidate.metadata,databaseBuild=metadata.buildEpoch.getTime()/1000;
    if(metadata.databaseType!=='DBIP-City-Lite'||metadata.binaryFormatMajorVersion!==2||![24,28,32].includes(metadata.recordSize)||![4,6].includes(metadata.ipVersion)||!Number.isSafeInteger(databaseBuild)||databaseBuild<1||databaseBuild>253402300799||!Number.isSafeInteger(metadata.nodeCount)||metadata.nodeCount<1||metadata.searchTreeSize+16>=bytes.length)throw Error('Invalid geography database.');
    // ponytail: one resident immutable Buffer per web process; measure capacity before adding hot reload or a separate service.
    reader=candidate;state={status:'ready',databaseBuild,databaseSha256,bytes:bytes.length};
   }
  }catch(error){const code=(error as{code?:string}).code;state={status:'unavailable',reason:code==='ENOENT'?'missing':['EACCES','EPERM','EISDIR'].includes(code??'')?'unreadable':'invalid'};}
  finally{await file?.close().catch(()=>{});}
 }
 return{get database(){return{...state};},lookup(address){
  if(!reader||state.status!=='ready'||address===null||!publicNetworkAddress(address))return null;
  try{return normalizeGeographyLookup(reader.get(address),state);}catch{reader=null;state={status:'unavailable',reason:'lookup-failed'};return null;}
 }};
}

let active:GeographyReader={database:{status:'unavailable',reason:'not-configured'},lookup:()=>null},initializing:Promise<void>|undefined;
/** Web startup only: collection never opens a file or initiates retries. Restart to replace a database. */
export function initializeAnalyticsGeography(path=process.env.ANALYTICS_GEO_DB_FILE):Promise<void>{return initializing??=loadGeographyDatabase(path).then(reader=>{active=reader;});}
export function collectGeography(address:string|null):GeographyObservation|null{return active.lookup(address);}
export function geographyReadiness(capture:boolean,networkMode=process.env.ANALYTICS_NETWORK_MODE??'off'):GeographyReadiness{
 const database=active.database;return{status:!capture?'disabled':networkMode==='off'?'network-off':database.status==='unavailable'?'database-unavailable':'ready',database};
}
