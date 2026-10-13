import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import type {MetaReportDefinition} from './meta-imports.ts';
import type {MetaDailyRow} from './meta-report-rows.ts';

type Filters={referenceImportId:string;report:'account_daily'|'campaign_daily';from:string;to:string};
export type MetaLatestDay={date:string;state:'rows'|'empty'|'missing'|'expired'|'deleted'|'incompatible';importId:string|null;requestedAt:string|null;completedAt:string|null;rowCount:number|null};
export type MetaLatestRow={importId:string;requestedAt:string;completedAt:string;row:MetaDailyRow};
export type MetaLatestReport={role:ContentProject['role'];connectionId:string;referenceImportId:string;source:MetaReportDefinition;from:string;to:string;asOf:string;selectionRevision:string;coverage:MetaLatestDay[];rows:MetaLatestRow[];totalRows:number;nextCursor:string|null};
const uuid=z.uuid().transform(v=>v.toLowerCase()),hex=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const filterShape={referenceImportId:uuid,report:z.enum(['account_daily','campaign_daily']),from:z.iso.date(),to:z.iso.date()};
const scopeSchema=z.object(filterShape).strict().refine(v=>!v.from.startsWith('0000')&&!v.to.startsWith('0000')&&v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=30*86400000);
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Choose a report, a retained reference import and at most 31 calendar days.');return result.data;}
function query(params:URLSearchParams){const input:Record<string,string>={};for(const [key,value]of params){if(![...Object.keys(filterShape),'cursor'].includes(key)||Object.hasOwn(input,key))throw new FoundationError(400,'Check the Meta report filters.');input[key]=value;}
 const {cursor,...rest}=input;return {filters:parse(scopeSchema,rest),cursor:cursor??null};}
function unavailable():never{throw new FoundationError(404,'Meta report not found or unavailable.');}
function queryError(error:unknown):never{if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'This Meta report took too long. Narrow the dates.');throw error;}
const stamp=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const profile="COALESCE(i.definition_key,CASE WHEN i.source IS NOT NULL THEN encode(sha256(convert_to((i.source-'accountName')::text,'UTF8')),'hex') END)";
// The signed deletion fence is authoritative before keyless physical cleanup.
const deleted=`(i.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM meta_oauth_flow f JOIN meta_deletion_request d
 ON d.registration_id=f.registration_id AND d.subject_hash=f.subject_hash
 WHERE f.id=i.grant_id AND (d.status<>'local_deleted' OR d.fence_epoch>f.start_epoch)))`;
type Chosen={date:string;id:string|null;key:string|null;requestedAt:string|null;completedAt:string|null;storedRows:number|null;deleted:boolean|null;expired:boolean|null;incompatible:boolean};
type Selection={report:MetaLatestReport;definitionKey:string;scope:string;chosen:Chosen[];available:{date:string;importId:string}[]};

/** Local-only, current membership admission and one repeatable-read snapshot.
 * A complete import replaces the WHOLE day, including absent campaign keys.
 * Selection precedes masking: a newer expired/deleted winner never falls back.
 * Partial/failed/active receipts cannot establish complete daily coverage.
 */
async function select(client:PoolClient,p:ContentProject,connectionId:string,filters:Filters):Promise<Selection>{
 await client.query("SET LOCAL statement_timeout='5s'");
 const ref=(await client.query<{source:MetaReportDefinition|null;key:string;deleted:boolean;asOf:string}>(`SELECT i.source,${profile} AS key,${deleted} AS deleted,${stamp('transaction_timestamp()')} AS "asOf"
  FROM meta_import i WHERE i.id=$1 AND i.project_id=$2 AND i.connection_id=$3 AND i.report=$4`,[filters.referenceImportId,p.id,connectionId,filters.report])).rows[0];
 if(!ref)unavailable();if(!ref.source||ref.deleted)throw new FoundationError(409,'This reference import was deleted. Choose another retained receipt.');
 const chosen=(await client.query<Chosen>(`WITH candidates AS MATERIALIZED (
  SELECT i.id,i.date_from,i.date_to,i.created_at,i.completed_at,${profile} AS key,i.row_count,${deleted} AS deleted,
   (i.data_expired_at IS NOT NULL OR i.completed_at<=transaction_timestamp()-make_interval(days=>w.derived_history_days)) AS expired
  FROM meta_import i JOIN workspace w ON w.id=i.workspace_id WHERE i.project_id=$1 AND i.connection_id=$2 AND i.report=$3 AND i.status='completed' AND i.date_from<=$5::date AND i.date_to>=$4::date
 ),days AS (SELECT ($4::date+n)::date AS date FROM generate_series(0,$5::date-$4::date)n)
 SELECT d.date::text,date_winner.id,date_winner.key,${stamp('date_winner.created_at')} AS "requestedAt",${stamp('date_winner.completed_at')} AS "completedAt",date_winner.row_count AS "storedRows",date_winner.deleted,date_winner.expired,
  EXISTS(SELECT 1 FROM candidates other WHERE d.date BETWEEN other.date_from AND other.date_to AND other.key IS DISTINCT FROM $6) AS incompatible
 FROM days d LEFT JOIN LATERAL(SELECT c.* FROM candidates c WHERE d.date BETWEEN c.date_from AND c.date_to AND (c.key=$6 OR (c.key IS NULL AND c.deleted)) ORDER BY c.created_at DESC,c.id DESC LIMIT 1) date_winner ON true ORDER BY d.date`,[p.id,connectionId,filters.report,filters.from,filters.to,ref.key])).rows;
 const available=chosen.filter(c=>c.id&&!c.deleted&&!c.expired).map(c=>({date:c.date,importId:c.id!}));
 const unique=new Map(chosen.filter(c=>c.id&&!c.deleted&&!c.expired).map(c=>[c.id!,c.storedRows!]));
 if([...unique.values()].reduce((a,b)=>a+b,0)>25000)throw new FoundationError(413,'The selected imports contain more than 25,000 rows. Narrow the dates.');
 const counts=available.length?(await client.query<{date:string;count:number}>(`SELECT picked.date,count(*)::integer AS count FROM jsonb_to_recordset($1::jsonb) AS picked(date text,"importId" uuid)
  JOIN meta_import_page page ON page.import_id=picked."importId" AND page.project_id=$2 CROSS JOIN LATERAL jsonb_array_elements(page.rows) item
  WHERE item->>'date'=picked.date GROUP BY picked.date`,[JSON.stringify(available),p.id])).rows:[];
 const coverage:MetaLatestDay[]=chosen.map(c=>{const rowCount=c.id&&!c.deleted&&!c.expired?(counts.find(n=>n.date===c.date)?.count??0):null;
  return {date:c.date,state:!c.id?(c.incompatible?'incompatible':'missing'):c.deleted?'deleted':c.expired?'expired':rowCount?'rows':'empty',importId:c.id,requestedAt:c.requestedAt,completedAt:c.completedAt,rowCount};});
 const scope=canonicalHash({projectId:p.id,connectionId,...filters,definitionKey:ref.key});
 const selectionRevision=canonicalHash({scope,days:coverage.map((day,index)=>({...day,definitionKey:chosen[index].key}))});
 return {definitionKey:ref.key,scope,chosen,available,report:{role:p.role,connectionId,referenceImportId:filters.referenceImportId,source:ref.source,from:filters.from,to:filters.to,asOf:ref.asOf,selectionRevision,coverage,rows:[],totalRows:counts.reduce((sum,n)=>sum+n.count,0),nextCursor:null}};
}

const cursorSchema=z.object({scope:hex,revision:hex,date:z.iso.date(),campaignId:z.string().regex(/^(?:[1-9][0-9]{0,39})?$(?![\s\S])/)}).strict();
function readCursor(value:string|null,selection:Selection){if(value===null)return null;let decoded:unknown;try{if(value.length>1024||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))throw new Error();decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new FoundationError(400,'Reload the Meta report before loading another page.');}
 const result=cursorSchema.safeParse(decoded);if(!result.success||result.data.scope!==selection.scope)throw new FoundationError(400,'This Meta report page belongs to different filters.');
 if(result.data.revision!==selection.report.selectionRevision)throw new FoundationError(409,'Daily coverage changed. Reload the Meta report.');return result.data;
}
// Both page reads and exports expand only the already-selected, available import
// IDs in the same snapshot. Decimal strings and action windows are never summed.
const rowsSql=`SELECT page.import_id AS "importId",item AS row FROM meta_import_page page
 CROSS JOIN LATERAL jsonb_array_elements(page.rows) item JOIN jsonb_to_recordset($1::jsonb) AS picked(date text,"importId" uuid)
 ON picked."importId"=page.import_id AND picked.date=item->>'date' WHERE page.project_id=$2
 AND ($3::text IS NULL OR ((item->>'date') COLLATE "C",COALESCE(item->>'campaignId','') COLLATE "C")>($3 COLLATE "C",$4 COLLATE "C"))
 ORDER BY (item->>'date') COLLATE "C",COALESCE(item->>'campaignId','') COLLATE "C"`;
function observed(selection:Selection,entry:{importId:string;row:MetaDailyRow}):MetaLatestRow{const day=selection.chosen.find(d=>d.date===entry.row.date)!;return {...entry,requestedAt:day.requestedAt!,completedAt:day.completedAt!};}

export async function getLatestMetaReport(projectId:string,userId:string,connectionId:string,params=new URLSearchParams()):Promise<MetaLatestReport>{
 connectionId=parse(uuid,connectionId);const input=query(params);
 return withContentProject(projectId,userId,false,async(client,p)=>{const selection=await select(client,p,connectionId,input.filters),after=readCursor(input.cursor,selection);
  const found=selection.available.length?(await client.query<{importId:string;row:MetaDailyRow}>(rowsSql+' LIMIT 51',[JSON.stringify(selection.available),p.id,after?.date??null,after?.campaignId??null])).rows:[];
  selection.report.rows=found.slice(0,50).map(entry=>observed(selection,entry));const last=selection.report.rows.at(-1);
  if(found.length>50&&last)selection.report.nextCursor=Buffer.from(JSON.stringify({scope:selection.scope,revision:selection.report.selectionRevision,date:last.row.date,campaignId:last.row.campaignId??''})).toString('base64url');return selection.report;
 }).catch(queryError);
}

/** Atomic local export. The expected revision rejects coverage changes instead of
 * silently exporting a different selection. Coverage records distinguish unavailable
 * days from observed empty days; measurement blanks mean null, never invented zero.
 */
export async function exportLatestMetaReport(projectId:string,userId:string,connectionId:string,raw:unknown,signal?:AbortSignal){
 connectionId=parse(uuid,connectionId);const {expectedSelectionRevision,...fields}=parse(z.object({...filterShape,expectedSelectionRevision:hex}).strict(),raw),filters=parse(scopeSchema,fields),started=Date.now();
 const check=()=>{if(signal?.aborted)throw new FoundationError(499,'Export cancelled.');if(Date.now()-started>30000)throw new FoundationError(503,'Export took too long. Narrow the dates.');};check();
 return withContentProject(projectId,userId,false,async(client,p)=>{check();const selection=await select(client,p,connectionId,filters);check();const report=selection.report;
  if(report.selectionRevision!==expectedSelectionRevision)throw new FoundationError(409,'Daily coverage changed. Reload the Meta report before exporting.');
  let bytes=0,rowCount=0;const lines:string[]=[];
  const line=(values:unknown[])=>{check();const value=values.map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(value);if(bytes>16*1024*1024)throw new FoundationError(413,'Export exceeds 16 MiB. Narrow the dates.');lines.push(value);};
  line(['Record type','As of','Connection ID','Reference import ID','Definition key','Report','Account ID','Reference account name','Currency','Time zone','Definition JSON','Date','Coverage','Import ID','Requested at','Completed at','Row count','Campaign ID','Campaign name','Impressions','Clicks','Spend','Actions JSON','Action values JSON']);
  const prefix=[report.asOf,connectionId,filters.referenceImportId,selection.definitionKey,filters.report,report.source.accountId,report.source.accountName,report.source.currency,report.source.timeZone,JSON.stringify(report.source)];
  for(const day of report.coverage)line(['coverage',...prefix,day.date,day.state,day.importId??'',day.requestedAt??'',day.completedAt??'',day.rowCount??'','','','','','','','']);
  if(selection.available.length){
   // Native PostgreSQL cursor bounds application memory even for action-heavy pages.
   await client.query('DECLARE meta_export NO SCROLL CURSOR FOR '+rowsSql,[JSON.stringify(selection.available),p.id,null,null]);
   while(true){check();const rows=(await client.query<{importId:string;row:MetaDailyRow}>('FETCH FORWARD 50 FROM meta_export')).rows;check();if(!rows.length)break;
    for(const entry of rows){const value=observed(selection,entry),row=value.row;line(['row',...prefix,row.date,'rows',entry.importId,value.requestedAt,value.completedAt,'',row.campaignId??'',row.campaignName??'',row.impressions??'',row.clicks??'',row.spend??'',JSON.stringify(row.actions),JSON.stringify(row.actionValues)]);rowCount++;}
   }await client.query('CLOSE meta_export');
  }
  check();return {role:p.role,filename:'meta-latest-'+filters.report+'.csv',contentType:'text/csv; charset=utf-8',body:lines.join(''),rowCount,asOf:report.asOf,selectionRevision:report.selectionRevision};
 }).catch(queryError);
}
