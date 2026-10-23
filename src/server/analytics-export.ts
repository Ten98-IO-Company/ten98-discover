import {crc32} from 'node:zlib';
import {z} from 'zod';
import {getDatabase} from './db.ts';
import {FoundationError} from './auth.ts';
import {csvCell,explorerQuery} from './explorer-input.ts';
import {analyticsPopulation} from './analytics-population.ts';
import {analyticsDimensionValueSql} from './analytics-dimensions.ts';
import {serializeGeographyKey,type GeoCountryKey} from '../lib/analytics-geography.ts';

export const analyticsExportFiles=['events.csv','pages.csv','referrers.csv','browsers.csv','os.csv','devices.csv','countries.csv'] as const;
export const analyticsExportLimits={bytes:16*1024*1024,groupsPerFile:10000,groupsTotal:25000,bodyBytes:32768,totalMs:15000} as const;
const invalid=()=>new FoundationError(400,'Choose an explicit supported analytics export scope.');
const capacity=()=>new FoundationError(413,'The complete analytics archive exceeds capacity. Narrow its dates or filters.');
export function analyticsExportInput(raw:unknown){
 const input=z.object({scope:z.string().min(1).max(20000)}).strict().safeParse(raw);if(!input.success)throw invalid();
 try{decodeURIComponent(input.data.scope.replace(/\+/g,' '));}catch{throw invalid();}
 if(/[\u0000\uD800-\uDFFF]/u.test(input.data.scope))throw invalid();const params=new URLSearchParams(input.data.scope);
 if(!['from','to','timeZone'].every(key=>params.has(key))||['kind','groupBy','groupProperty','fields','cohortId','cohortRevision','predicates'].some(key=>params.has(key)))throw invalid();
 const query=explorerQuery(params);return{scope:input.data.scope,query};
}
/** Seven fixed ASCII filenames, stored ZIP32 only; no compression, paths, ZIP64 or dynamic entries. */
export function analyticsExportZip(contents:readonly Buffer[],check:()=>void=()=>{}){
 if(contents.length!==7)throw invalid();if(contents.reduce((n,b)=>n+b.length,0)+22+analyticsExportFiles.reduce((n,name)=>n+76+2*Buffer.byteLength(name),0)>analyticsExportLimits.bytes)throw capacity();const locals:Buffer[]=[],central:Buffer[]=[];let offset=0,centralBytes=0;
 for(let i=0;i<7;i++){
  check();const name=Buffer.from(analyticsExportFiles[i]),data=contents[i],crc=crc32(data),local=Buffer.alloc(30),entry=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(0x21,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
  locals.push(local,name,data);central.push(entry,name);offset+=local.length+name.length+data.length;centralBytes+=entry.length+name.length;if(offset+centralBytes+22>analyticsExportLimits.bytes)throw capacity();
 }
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(7,8);end.writeUInt16LE(7,10);end.writeUInt32LE(centralBytes,12);end.writeUInt32LE(offset,16);check();const result=Buffer.concat([...locals,...central,end],offset+centralBytes+end.length);check();return result;
}
type ExportRow={dataset:number;value:unknown;observations:number;identified:number;visitors:number|null};
const rowSchema=z.object({dataset:z.number().int().min(0).max(6),value:z.unknown(),observations:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),identified:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),visitors:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()}).strict();
/** Country groups are closed geography keys: absence reads Unavailable, a completed lookup without a country reads Unknown, known rows read the ISO code. */
function exportValue(dataset:number,value:unknown):[state:string,value:unknown]{
 if(dataset!==6)return[value===null?'not-recorded':'recorded',value];
 if(serializeGeographyKey('country',value)===null)throw new FoundationError(503,'Analytics counts cannot be exported safely.');const key=value as GeoCountryKey;
 return key.state==='known'?['recorded',key.country]:key.state==='unknown'?['unknown','Unknown']:['not-recorded',null];
}
type ExportWindow={asOf:string;retainedFrom:string;start:string;end:string;coverage:'complete'|'partial'|'unavailable'};
export function analyticsExportCsv(rows:readonly ExportRow[],window:ExportWindow,scope:string,check:()=>void=()=>{}){
 if(rows.length>analyticsExportLimits.groupsTotal)throw capacity();const groups=Array.from({length:7},()=>[] as ExportRow[]);for(const raw of rows){check();const parsed=rowSchema.safeParse(raw);if(!parsed.success)throw new FoundationError(503,'Analytics counts cannot be exported safely.');const row=parsed.data;if(row.identified>row.observations||row.visitors!==null&&row.visitors>row.identified)throw new FoundationError(503,'Analytics counts cannot be exported safely.');groups[row.dataset].push(row);}
 let bytes=0;return groups.map((items,index)=>{if(items.length>analyticsExportLimits.groupsPerFile)throw capacity();const lines:Buffer[]=[];const line=(cells:unknown[])=>{check();const part=Buffer.from(cells.map(csvCell).join(',')+'\r\n');bytes+=part.length;if(bytes>analyticsExportLimits.bytes)throw capacity();lines.push(part);};
  line(['record_type','as_of','scope','start','end','retained_from','coverage','value_state','value',index===0?'custom_events':'pageviews','identified_pageviews','estimated_visitors']);
  line(['metadata',window.asOf,scope,window.start,window.end,window.retainedFrom,window.coverage,'','','','','']);
  for(const row of items)line(['row',window.asOf,scope,window.start,window.end,window.retainedFrom,window.coverage,...exportValue(index,row.value),row.observations,index===0?null:row.identified,index===0?null:row.visitors]);return Buffer.concat(lines);
 });
}
export async function exportAnalytics(projectId:string,userId:string,raw:unknown,signal?:AbortSignal):Promise<Response>{
 if(!z.uuid().safeParse(projectId).success)throw invalid();const input=analyticsExportInput(raw),started=Date.now();
 const check=()=>{if(signal?.aborted)throw new FoundationError(499,'Export cancelled.');if(Date.now()-started>analyticsExportLimits.totalMs)throw new FoundationError(503,'The export took too long. Narrow the dates.');};check();const client=await getDatabase().pool.connect();
 try{
  check();await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='250ms'");
  const hint=(await client.query<{workspace_id:string}>('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0];if(!hint)throw new FoundationError(404,'Project not found or unavailable.');
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint.workspace_id]);if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR SHARE',[projectId,hint.workspace_id])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
  const gateSql=`WITH clock AS MATERIALIZED(SELECT clock_timestamp()AS at)SELECT m.role,w.retention_revision,w.raw_analytics_days,p.analytics_retained_from::text AS watermark,p.analytics_epoch::text AS epoch,
   c.at::text AS as_of,GREATEST(p.analytics_retained_from,c.at-w.raw_analytics_days*interval '24 hours')::text AS cutoff
   FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN membership m ON m.workspace_id=w.id AND m.user_id=$2 CROSS JOIN clock c WHERE p.id=$1 AND m.role IN('owner','admin','editor','viewer')FOR SHARE OF p,m`;
  const gate=(await client.query<{role:string;retention_revision:number;raw_analytics_days:number;watermark:string|null;epoch:string|null;as_of:string;cutoff:string}>(gateSql,[projectId,userId])).rows[0];if(!gate)throw new FoundationError(404,'Project not found or unavailable.');check();
  if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[input.query.timeZone])).rowCount)throw invalid();
  const {ctes,values,population}=analyticsPopulation(projectId,userId,input.query,null,false);values.push(gate.cutoff,gate.as_of);
  const dimensions=[['0',"to_jsonb(s.event_name)"],['1',analyticsDimensionValueSql("'path'",'s')],['2',analyticsDimensionValueSql("'referrer'",'s')],['3',analyticsDimensionValueSql("'browser'",'s')],['4',analyticsDimensionValueSql("'os'",'s')],['5',analyticsDimensionValueSql("'device'",'s')],['6',analyticsDimensionValueSql("'country'",'s')]];
  const sql=`${ctes},retained AS MATERIALIZED(SELECT * FROM ${population} WHERE received_at>=$13::timestamptz AND received_at<$14::timestamptz),
   cells AS(SELECT d.dataset,d.value,s.visitor_id FROM retained s CROSS JOIN LATERAL(VALUES ${dimensions.map(([id,value])=>`(${id},${value})`).join(',')})d(dataset,value)WHERE(d.dataset=0 AND s.event_name<>'page_view')OR(d.dataset<>0 AND s.event_name='page_view')),
   grouped AS(SELECT dataset,value,count(*)::bigint AS observations,count(visitor_id)::bigint AS identified,CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id)END AS visitors FROM cells GROUP BY dataset,value),
   ranked AS(SELECT *,row_number()OVER(PARTITION BY dataset ORDER BY observations DESC,value::text COLLATE "C" NULLS LAST)AS position FROM grouped),
   picked AS MATERIALIZED(SELECT * FROM ranked WHERE position<=${analyticsExportLimits.groupsPerFile+1}),
   capacity AS(SELECT COALESCE(bool_or(position>${analyticsExportLimits.groupsPerFile}),false)OR count(*)>${analyticsExportLimits.groupsTotal} OR COALESCE(sum(octet_length(value::text)),0)>${analyticsExportLimits.bytes} AS too_large FROM picked)
   SELECT b.start::text,b.finish::text AS finish,CASE WHEN b.finish<=$13::timestamptz THEN 'unavailable'WHEN b.start<$13::timestamptz THEN 'partial'ELSE 'complete'END AS coverage,
   (SELECT min(received_at)::text FROM retained)AS oldest,c.too_large,CASE WHEN c.too_large THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('dataset',dataset,'value',value,'observations',observations,'identified',identified,'visitors',visitors)ORDER BY dataset,position)FROM picked),'[]'::jsonb)END AS rows FROM bounds b CROSS JOIN capacity c`;
  const result=(await client.query<{start:string;finish:string;coverage:ExportWindow['coverage'];oldest:string|null;too_large:boolean;rows:ExportRow[]}>(sql,values)).rows[0];check();if(result.too_large)throw capacity();
  const csv=analyticsExportCsv(result.rows,{asOf:gate.as_of,retainedFrom:gate.cutoff,start:result.start,end:result.finish,coverage:result.coverage},input.scope,check),zip=analyticsExportZip(csv,check);
  const current=(await client.query(gateSql,[projectId,userId])).rows[0];check();if(!current)throw new FoundationError(404,'Project not found or unavailable.');
  if(current.retention_revision!==gate.retention_revision||current.raw_analytics_days!==gate.raw_analytics_days||current.watermark!==gate.watermark||current.epoch!==gate.epoch)throw new FoundationError(409,'Retention changed. Request a fresh export.');
  if(result.oldest!==null&&!(await client.query('SELECT $1::timestamptz >= $2::timestamptz AS retained',[result.oldest,current.cutoff])).rows[0].retained)throw new FoundationError(409,'The retained export window advanced. Request a fresh export.');
  check();await client.query('COMMIT');check();return new Response(new Uint8Array(zip),{headers:{'content-type':'application/zip','content-disposition':'attachment; filename="analytics.zip"','content-length':String(zip.length),'x-export-as-of':gate.as_of,'x-export-role':current.role,'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'}});
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Analytics export is busy. Narrow its dates or retry.');throw error;}finally{client.release();}
}