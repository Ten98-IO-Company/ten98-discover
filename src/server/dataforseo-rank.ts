import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {dataforseoJson,type DataforseoResponse} from './dataforseo-transport.ts';
import {parseKeywordAccount} from './dataforseo-keywords.ts';
import {getProviderAccountIdentityKey} from './provider-account-identity.ts';
import {keywordAccountEndpoint,providerMicros,validText} from './keyword-research-input.ts';
import {rankLanguagePattern,rankSerpEndpoints,rankSerpPayload,type RankMethod,type RankSerpRequest} from './rank-serp-input.ts';

type ObjectValue=Record<string,unknown>;
const object=(v:unknown):v is ObjectValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw new Error('Unsupported DataForSEO rank response.');}
function bad():never{throw new FoundationError(400,'Check the rank request or catalog selection.');}
const code=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const taskIdPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function freeRows(response:DataforseoResponse,url:string,maximum:number){
  const body=response.body;
  if(response.httpStatus!==200||!object(body)||body.status_code!==20000||providerMicros(body.cost)!==0n||body.tasks_count!==1||body.tasks_error!==0||!Array.isArray(body.tasks)||body.tasks.length!==1)invalid();
  const task=body.tasks[0];
  const expectedPath=new URL(url).pathname.slice(1).split('/');
  if(!object(task)||task.status_code!==20000||providerMicros(task.cost)!==0n||!Array.isArray(task.path)||task.path.length!==expectedPath.length||!task.path.every((part:unknown,index:number)=>part===expectedPath[index])||!Array.isArray(task.result)||task.result.length>maximum||task.result_count!==task.result.length)invalid();
  return task.result as unknown[];
}
export type RankLocation={code:number;name:string;parentCode:number|null;countryIso:string;type:string;countryCode:number};
export type RankLanguage={code:string;name:string};
export type RankLocationCoverage={grouping:'country_iso_code';receivedRows:number;selectableRows:number;missingParentRows:number;unavailableGroups:{countryIso:string;rows:number;reason:'provider_unsupported'|'missing_root'|'unsupported_root_type'}[]};
export type RankCatalog={locations:RankLocation[];countries:RankLocation[];languages:RankLanguage[];coverage:RankLocationCoverage};

// Official free catalog contract: https://docs.dataforseo.com/v3/serp/google/locations/
// Keep every validated row server-side; never label a truncated response complete.
export function parseRankLocations(response:DataforseoResponse):Omit<RankCatalog,'languages'>{
  const raw=freeRows(response,rankSerpEndpoints.locations,300_000);if(!raw.length)invalid();
  const rows:RankLocation[]=[],byCode=new Map<number,RankLocation>(),countries=new Map<string,RankLocation>(),groups=new Map<string,{rows:number;hasRoot:boolean}>();
  for(const value of raw){
    if(!object(value)||!code(value.location_code)||!validText(value.location_name,200)||!validText(value.location_type,80)||typeof value.country_iso_code!=='string'||!/^[A-Z]{2}$/.test(value.country_iso_code)||(value.location_code_parent!==null&&!code(value.location_code_parent)))invalid();
    const row:RankLocation={code:value.location_code,name:value.location_name,parentCode:value.location_code_parent,type:value.location_type,countryIso:value.country_iso_code,countryCode:0};
    if(byCode.has(row.code))invalid();byCode.set(row.code,row);rows.push(row);
    const group=groups.get(row.countryIso)??{rows:0,hasRoot:false};group.rows++;group.hasRoot ||= row.parentCode===null;groups.set(row.countryIso,group);
    if(row.type==='Country'&&row.parentCode!==null)invalid();
    if(row.parentCode===null&&(row.type==='Country'||row.type==='Region')){
      if(countries.has(row.countryIso))invalid();countries.set(row.countryIso,row);
    }
  }
  if(groups.size>300)invalid();
  // Validate present edges in linear work; ISO grouping does not assert a complete tree.
  const checked=new Set<number>();let missingParentRows=0;
  for(const row of rows)if(row.parentCode!==null&&!byCode.has(row.parentCode))missingParentRows++;
  for(const row of rows){
    const chain:RankLocation[]=[],seen=new Set<number>();let current:RankLocation|undefined=row;
    while(current&&!checked.has(current.code)){
      if(seen.has(current.code)||current.countryIso!==row.countryIso)invalid();
      seen.add(current.code);chain.push(current);
      const parent:RankLocation|undefined=current.parentCode===null?undefined:byCode.get(current.parentCode);if(parent&&parent.countryIso!==row.countryIso)invalid();current=parent;
    }
    for(const child of chain)checked.add(child.code);
  }
  const unavailableGroups:RankLocationCoverage['unavailableGroups']=[];
  for(const [countryIso,group]of groups){
    const reason=countryIso==='RU'||countryIso==='BY'?'provider_unsupported':!countries.has(countryIso)?group.hasRoot?'unsupported_root_type':'missing_root':null;
    if(reason){unavailableGroups.push({countryIso,rows:group.rows,reason});countries.delete(countryIso);}
  }
  const locations=rows.filter(row=>{const root=countries.get(row.countryIso);if(!root)return false;row.countryCode=root.code;return true;}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.code-b.code);
  unavailableGroups.sort((a,b)=>a.countryIso.localeCompare(b.countryIso));
  return {locations,countries:locations.filter(row=>row.code===row.countryCode),coverage:{grouping:'country_iso_code',receivedRows:rows.length,selectableRows:locations.length,missingParentRows,unavailableGroups}};
}
export function parseRankLanguages(response:DataforseoResponse):RankLanguage[]{
  const rows=freeRows(response,rankSerpEndpoints.languages,200);if(!rows.length)invalid();
  const seen=new Set<string>();
  return rows.map(row=>{
    if(!object(row)||!validText(row.language_name,80)||typeof row.language_code!=='string'||!rankLanguagePattern.test(row.language_code)||seen.has(row.language_code))invalid();
    seen.add(row.language_code);return {code:row.language_code,name:row.language_name};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.code<b.code?-1:a.code>b.code?1:0);
}
export async function readRankCatalog(credentials:unknown,send:typeof fetch=fetch):Promise<RankCatalog>{
  try{
    const locations=parseRankLocations(await dataforseoJson(rankSerpEndpoints.locations,credentials,'GET',undefined,send));
    const languages=parseRankLanguages(await dataforseoJson(rankSerpEndpoints.languages,credentials,'GET',undefined,send));
    return {...locations,languages};
  }catch{throw new FoundationError(502,'Could not load rank locations and languages. Check the connection and try again.');}
}
const pageInput=z.object({kind:z.enum(['countries','local']),countryCode:z.number().int().min(1).max(2147483647).optional(),query:z.string().max(100).refine(value=>value===''||validText(value,100)).default(''),offset:z.number().int().min(0).max(300_000).default(0),limit:z.number().int().min(1).max(50).default(50)}).strict();
export function pageRankLocations(catalog:RankCatalog,raw:unknown){
  const parsed=pageInput.safeParse(raw);if(!parsed.success)bad();const p=parsed.data;
  if(p.kind==='local'?!catalog.countries.some(row=>row.code===p.countryCode):p.countryCode!==undefined)bad();
  const query=p.query.trim().toLowerCase();
  const selected=(p.kind==='countries'?catalog.countries:catalog.locations.filter(row=>row.code!==row.countryCode&&row.countryCode===p.countryCode)).filter(row=>row.name.toLowerCase().includes(query));
  const rows=selected.slice(p.offset,p.offset+p.limit);
  return {rows,total:selected.length,nextOffset:p.offset+rows.length<selected.length?p.offset+rows.length:null};
}
export function validateRankCatalogSelection(catalog:RankCatalog,raw:unknown){
  const parsed=z.object({countryCode:z.number().int().positive(),locationCode:z.number().int().positive(),languageCode:z.string()}).strict().safeParse(raw);
  if(!parsed.success)bad();const p=parsed.data,country=catalog.countries.find(row=>row.code===p.countryCode),location=catalog.locations.find(row=>row.code===p.locationCode),language=catalog.languages.find(row=>row.code===p.languageCode);
  if(!country||!location||location.countryCode!==country.code||!language)bad();
  return {country,location,language};
}
export function parseRankAccount(response:DataforseoResponse,binding:{key:string;version:2}){
  const rows=freeRows(response,keywordAccountEndpoint,1);
  if(rows.length!==1||!object(rows[0])||!object(rows[0].price)||binding.version!==2||typeof binding.key!=='string'||binding.key.length<32)invalid();
  const {fingerprint}=parseKeywordAccount(response,undefined,binding);
  // Return neither the account login nor unrelated wallet/profile metadata.
  // Price interpretation is deliberately owned by the separately tested helper.
  return {fingerprint,price:rows[0].price};
}
export async function readRankAccount(credentials:unknown,send:typeof fetch=fetch){
  const key=await getProviderAccountIdentityKey(2);
  try{return parseRankAccount(await dataforseoJson(keywordAccountEndpoint,credentials,'GET',undefined,send),{key,version:2});}
  catch{throw new FoundationError(502,'Could not verify the DataForSEO rank account. Check the connection and try again.');}
}

export type RankDispatchTask={id:string;request:RankSerpRequest};
// Authorization, account checks and spending reservation are the service's job.
// This function permits only one live task or up to100 standard queued tasks.
export async function requestRankTasks(credentials:unknown,method:RankMethod,tasks:readonly RankDispatchTask[],send:typeof fetch=fetch):Promise<DataforseoResponse>{
  if((method!=='live'&&method!=='queued')||!Array.isArray(tasks)||tasks.length<1||tasks.length>(method==='live'?1:100))bad();
  const ids=new Set<string>(),payload=[];
  for(const task of tasks){
    if(!object(task)||Object.keys(task).length!==2||typeof task.id!=='string'||ids.has(task.id.toLowerCase()))bad();
    const item=rankSerpPayload(task.request as RankSerpRequest,task.id,method);ids.add(task.id.toLowerCase());payload.push(item);
  }
  return dataforseoJson(rankSerpEndpoints[method],credentials,'POST',payload,send);
}
// Provider IDs are UUID-shaped but their version/variant bits are not RFC4122.
// This endpoint's reported cost belongs to the original task; GET adds no charge.
export async function readRankTask(credentials:unknown,providerTaskId:string,send:typeof fetch=fetch):Promise<DataforseoResponse>{
  if(typeof providerTaskId!=='string'||!taskIdPattern.test(providerTaskId))bad();
  return dataforseoJson(rankSerpEndpoints.task+providerTaskId,credentials,'GET',undefined,send);
}
export async function readRankReconciliation(credentials:unknown,input:{dispatchedAt:Date;offset?:number},send:typeof fetch=fetch,now=new Date()):Promise<DataforseoResponse>{
  if(!object(input)||Object.keys(input).some(key=>!['dispatchedAt','offset'].includes(key))||!(input.dispatchedAt instanceof Date)||!Number.isFinite(input.dispatchedAt.getTime())||!Number.isFinite(now.getTime()))bad();
  const offset=input.offset??0,at=input.dispatchedAt.getTime(),end=now.getTime();
  if(!Number.isInteger(offset)||offset<0||offset>9000||offset%1000!==0||at>end||end-at>28*86400000)bad();
  const stamp=(value:number)=>new Date(value).toISOString().slice(0,19).replace('T',' ')+' +00:00';
  const response=await dataforseoJson(rankSerpEndpoints.reconcile,credentials,'POST',[{datetime_from:stamp(at-60_000),datetime_to:stamp(Math.min(end,at+120_000)),limit:1000,offset,sort:'asc',include_metadata:true}],send);
  freeRows(response,rankSerpEndpoints.reconcile,1000);
  // At1000 rows this page may be truncated. The coordinator must not interpret
  // missing/ambiguous metadata as a zero charge or silently restart paid work.
  return response;
}
