import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {parse as parseHtml, serialize, type DefaultTreeAdapterTypes as Html} from 'parse5';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {readJson} from './validation.ts';

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const svgNamespace = 'http://www.w3.org/2000/svg';
const htmlTags = new Set('html head body title style main article section header footer nav aside div span p h1 h2 h3 h4 h5 h6 br hr strong em b i u s small sub sup mark blockquote pre code kbd samp var abbr time address dl dt dd ul ol li table caption colgroup col thead tbody tfoot tr th td figure figcaption img a'.split(' '));
const svgTags = new Set('svg g path rect circle ellipse line polyline polygon text tspan title desc defs linearGradient radialGradient stop clipPath'.split(' '));
const commonAttrs = new Set('id class style title lang dir role aria-label aria-hidden'.split(' '));
const svgAttrs = new Set('viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill stroke stroke-width stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity transform text-anchor dominant-baseline font-size font-family font-weight dx dy offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod clip-path preserveAspectRatio'.split(' '));
const structuralAttrs: Record<string, Set<string>> = {
  th: new Set(['colspan','rowspan','scope','headers']), td: new Set(['colspan','rowspan','headers']),
  col: new Set(['span']), colgroup: new Set(['span']), ol: new Set(['start','reversed','type']), li: new Set(['value']),
  img: new Set(['src','alt','width','height']), time: new Set(['datetime']),
};

function badInput(): never { throw new FoundationError(400, 'Check the report fields and try again.'); }
function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> { const result=schema.safeParse(value); if (!result.success) badInput(); return result.data; }
function unavailable(): never { throw new FoundationError(404, 'Report not found or unavailable.'); }
const idInput=z.uuid();
const validText=(value:string)=>toUSVString(value)===value&&!value.includes('\0');
const nameInput=z.string().trim().min(1).max(120).refine(validText);
const revisionInput=z.number().int().positive().max(2147483646);
const reportInput=z.object({title:nameInput,html:z.string().min(1).max(1048576)}).strict();
const templateInput=z.object({name:nameInput,brief:z.string().trim().min(1).max(20000).refine(validText)}).strict();
const cursorInput=z.object({at:z.iso.datetime(),id:idInput}).strict();
type Role='owner'|'admin'|'editor'|'viewer';
type PageRow={id:string;createdAt:Date};

function rasterData(value:string) {
  const match=/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0]!==value || match[2].length%4!==0) return false;
  const bytes=Buffer.from(match[2],'base64');
  if (bytes.toString('base64')!==match[2]) return false;
  return match[1]==='png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    match[1]==='jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255])) :
    match[1]==='gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) :
    bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP';
}

/** Preserve authored source separately. Only this static allowlist is rendered. */
export function sanitizeReportHtml(source:string):string {
  if (typeof source!=='string' || !source.trim() || Buffer.byteLength(source)>1048576 || !validText(source)) badInput();
  const document=parseHtml(source,{scriptingEnabled:false});
  const pending:Array<{node:Html.ParentNode;depth:number}>=[{node:document,depth:0}];
  let count=0;
  while (pending.length) {
    const {node,depth}=pending.pop()!;
    if (depth>128) throw new FoundationError(400,'Report nesting is too deep. Simplify the HTML.');
    node.childNodes=node.childNodes.filter(child=>{
      if (++count>20000) throw new FoundationError(400,'Report contains too many elements. Simplify the HTML.');
      if (child.nodeName==='#text') return true;
      if (!('tagName' in child)) return false;
      const svg=child.namespaceURI===svgNamespace;
      if (!(svg ? svgTags.has(child.tagName) : child.namespaceURI===htmlNamespace && htmlTags.has(child.tagName))) return false;
      child.attrs=child.attrs.filter(attr=>{
        if (attr.namespace || attr.prefix || !(commonAttrs.has(attr.name) || (svg ? svgAttrs.has(attr.name) : structuralAttrs[child.tagName]?.has(attr.name)))) return false;
        return attr.name!=='src' || (child.tagName==='img' && rasterData(attr.value));
      });
      pending.push({node:child,depth:depth+1});
      return true;
    });
  }
  // CSP (including sandbox) is an HTTP header, not user-controlled markup or meta.
  const result='<!DOCTYPE html>\n'+serialize(document);
  if (Buffer.byteLength(result)>1048576) throw new FoundationError(400,'Rendered report is too large. Simplify the HTML.');
  return result;
}

export function reportDocument(source:string,status=200) {
  return new Response(sanitizeReportHtml(source),{status,headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive','cross-origin-resource-policy':'same-origin',
    'content-security-policy':"sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }});
}

async function transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await getDatabase().pool.connect();
  try { await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

async function projectRole(projectId:string,userId:string,client?:PoolClient,capability:'read'|'edit'|'share'='read'):Promise<Role> {
  input(idInput,projectId); input(idInput,userId);
  if (client) {
    const target=await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId]);
    if (!target.rows[0]) unavailable();
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[target.rows[0].workspace_id]);
  }
  const result=await (client??getDatabase().pool).query<{role:Role}>(
    'SELECT m.role FROM project p JOIN membership m ON m.workspace_id=p.workspace_id WHERE p.id=$1 AND m.user_id=$2',[projectId,userId]);
  const role=result.rows[0]?.role;
  if (!role) unavailable();
  if (capability==='edit' && role==='viewer' || capability==='share' && !['owner','admin'].includes(role)) throw new FoundationError(403,'Your current role cannot perform this report action.');
  return role;
}

function cursor(value:unknown) {
  if (value===undefined || value===null) return null;
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) badInput();
  try { return input(cursorInput,JSON.parse(Buffer.from(value,'base64url').toString('utf8'))); } catch { badInput(); }
}
function page<T extends PageRow>(rows:T[]) {
  const visible=rows.slice(0,50), last=visible.at(-1);
  return {items:visible,nextCursor:rows.length>50 && last ? Buffer.from(JSON.stringify({at:last.createdAt.toISOString(),id:last.id})).toString('base64url'):null};
}
const reportColumns='id,title,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
const templateColumns='id,name,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
const shareColumns='id,label,report_revision AS "reportRevision",created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt"';

export async function listReports(projectId:string,userId:string,after?:unknown,templates=false) {
  const role=await projectRole(projectId,userId), start=cursor(after);
  const result=await getDatabase().pool.query<PageRow>(`SELECT ${templates?templateColumns:reportColumns} FROM ${templates?'report_template':'report'} WHERE project_id=$1
    AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[projectId,start?.at??null,start?.id??null]);
  const resultPage=page(result.rows);
  return templates ? {role,templates:resultPage.items,nextCursor:resultPage.nextCursor} : {role,reports:resultPage.items,nextCursor:resultPage.nextCursor};
}

export async function getReport(projectId:string,userId:string,reportId:string,templates=false) {
  input(idInput,reportId);
  const role=await projectRole(projectId,userId);
  const result=await getDatabase().pool.query(`SELECT ${templates?templateColumns+',brief':reportColumns+',source_html AS html'} FROM ${templates?'report_template':'report'} WHERE project_id=$1 AND id=$2`,[projectId,reportId]);
  if (!result.rows[0]) unavailable();
  return {role,[templates?'template':'report']:result.rows[0]};
}

export async function saveReport(projectId:string,userId:string,body:unknown,reportId?:string,templates=false) {
  if (reportId) input(idInput,reportId);
  const schema=templates?templateInput:reportInput;
  const parsed=input(reportId?schema.extend({revision:revisionInput}):schema,body);
  if ('html' in parsed) sanitizeReportHtml(parsed.html);
  return transaction(async client=>{
    await projectRole(projectId,userId,client,'edit');
    const table=templates?'report_template':'report', names=templates?'name,brief':'title,source_html';
    const values='html' in parsed?[parsed.title,parsed.html]:[parsed.name,parsed.brief];
    let result;
    if (reportId) {
      const current=await client.query(`SELECT revision FROM ${table} WHERE project_id=$1 AND id=$2 FOR UPDATE`,[projectId,reportId]);
      if (!current.rows[0]) unavailable();
      if (current.rows[0].revision!==('revision' in parsed?parsed.revision:undefined)) throw new FoundationError(409,'This report changed. Reload the saved version before saving again.');
      const fields=names.split(',');
      result=await client.query(`UPDATE ${table} SET ${fields[0]}=$3,${fields[1]}=$4,revision=revision+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 RETURNING ${templates?templateColumns+',brief':reportColumns+',source_html AS html'}`,[projectId,reportId,...values]);
    } else result=await client.query(`INSERT INTO ${table}(id,project_id,${names}) VALUES($1,$2,$3,$4) RETURNING ${templates?templateColumns+',brief':reportColumns+',source_html AS html'}`,[randomUUID(),projectId,...values]);
    return {[templates?'template':'report']:result.rows[0]};
  });
}

export async function deleteReport(projectId:string,userId:string,reportId:string,body:unknown,templates=false) {
  input(idInput,reportId); const {revision}=input(z.object({revision:revisionInput}).strict(),body);
  return transaction(async client=>{
    await projectRole(projectId,userId,client,'edit');
    const table=templates?'report_template':'report';
    const current=await client.query(`SELECT revision FROM ${table} WHERE project_id=$1 AND id=$2 FOR UPDATE`,[projectId,reportId]);
    if (!current.rows[0]) unavailable();
    if (current.rows[0].revision!==revision) throw new FoundationError(409,'This report changed. Reload the saved version before deleting it.');
    await client.query(`DELETE FROM ${table} WHERE project_id=$1 AND id=$2`,[projectId,reportId]); return {ok:true};
  });
}

export async function listReportShares(projectId:string,userId:string,reportId:string,after?:unknown) {
  input(idInput,reportId); await projectRole(projectId,userId,undefined,'share'); const start=cursor(after);
  if (!(await getDatabase().pool.query('SELECT 1 FROM report WHERE project_id=$1 AND id=$2',[projectId,reportId])).rowCount) unavailable();
  const result=await getDatabase().pool.query<PageRow>(`SELECT ${shareColumns} FROM report_share WHERE report_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[reportId,start?.at??null,start?.id??null]);
  const resultPage=page(result.rows); return {shares:resultPage.items,nextCursor:resultPage.nextCursor};
}

export async function createReportShare(projectId:string,userId:string,reportId:string,body:unknown) {
  input(idInput,reportId);
  const details=input(z.object({label:nameInput,revision:revisionInput,expiresAt:z.iso.datetime({offset:true})}).strict(),body);
  return transaction(async client=>{
    await projectRole(projectId,userId,client,'share');
    const report=await client.query('SELECT source_html,revision FROM report WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,reportId]);
    if (!report.rows[0]) unavailable();
    if (report.rows[0].revision!==details.revision) throw new FoundationError(409,'This report changed. Preview the saved version before sharing it.');
    const count=await client.query(`SELECT count(*)::int AS count,clock_timestamp() AS now FROM report_share WHERE report_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[reportId]);
    const lifetime=Date.parse(details.expiresAt)-count.rows[0].now.getTime();
    if (lifetime<3600000 || lifetime>365*86400000) throw new FoundationError(400,'Choose an expiry between one hour and 365 days from now.');
    if (count.rows[0].count>=20) throw new FoundationError(409,'This report has 20 active links. Revoke a link before creating another.');
    const token=randomBytes(32).toString('base64url'), slug=details.label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'report';
    const result=await client.query(`INSERT INTO report_share(id,report_id,token_hash,slug_label,label,snapshot_html,report_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${shareColumns}`,[randomUUID(),reportId,createHash('sha256').update(token).digest('hex'),slug,details.label,sanitizeReportHtml(report.rows[0].source_html),details.revision,details.expiresAt]);
    return {share:result.rows[0],url:`${getConfig().appUrl}/share/${slug}-${token}`};
  });
}

export async function revokeReportShare(projectId:string,userId:string,reportId:string,shareId:string) {
  input(idInput,reportId); input(idInput,shareId);
  return transaction(async client=>{
    await projectRole(projectId,userId,client,'share');
    if (!(await client.query('SELECT 1 FROM report WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,reportId])).rowCount) unavailable();
    const result=await client.query('UPDATE report_share SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE report_id=$1 AND id=$2',[reportId,shareId]);
    if (!result.rowCount) unavailable(); return {ok:true};
  });
}

export async function handleReportShare(request:Request):Promise<Response> {
  const missing=()=>{
    const response=reportDocument('<!DOCTYPE html><html><head><title>Report unavailable</title></head><body><h1>Report unavailable</h1><p>This link is unavailable or expired.</p></body></html>',404);
    return request.method==='HEAD'?new Response(null,{status:404,headers:response.headers}):response;
  };
  const path=new URL(request.url).pathname;
  const match=/^\/share\/([a-z0-9][a-z0-9-]{0,47})-([A-Za-z0-9_-]{43})$/.exec(path);
  if (request.method!=='GET' && request.method!=='HEAD' || !match || match[0]!==path) return missing();
  try {
    const result=await getDatabase().pool.query('SELECT snapshot_html FROM report_share WHERE token_hash=$1 AND slug_label=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[createHash('sha256').update(match[2]).digest('hex'),match[1]]);
    if (!result.rows[0]) return missing();
    // Apply the current allowlist as well, so a future policy repair covers existing snapshots.
    const response=reportDocument(result.rows[0].snapshot_html);
    return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
  } catch { return missing(); }
}

export async function handleReports(request:Request,userId:string):Promise<Response|null> {
  const url=new URL(request.url), match=/^\/api\/projects\/([0-9a-f-]{36})\/(reports|report-templates)(?:\/([0-9a-f-]{36}))?(?:\/(preview|delete|shares))?(?:\/([0-9a-f-]{36})\/revoke)?$/.exec(url.pathname);
  if (!match) return null;
  const [,projectId,kind,reportId,action,shareId]=match, templates=kind==='report-templates';
  const json=(value:unknown)=>Response.json(value,{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  if (request.method==='GET') {
    if (shareId || templates && action && action!=='delete') unavailable();
    if (!reportId && !action) return json(await listReports(projectId,userId,url.searchParams.get('cursor'),templates));
    if (reportId && !action) return json(await getReport(projectId,userId,reportId,templates));
    if (reportId && action==='shares') return json(await listReportShares(projectId,userId,reportId,url.searchParams.get('cursor')));
    if (reportId && action==='preview') {
      const result=await getReport(projectId,userId,reportId);
      if (url.searchParams.has('revision') && url.searchParams.get('revision')!==String(result.report.revision)) throw new FoundationError(409,'This report changed. Reload the saved version before previewing it.');
      return reportDocument(result.report.html);
    }
  } else if (request.method==='POST') {
    if (request.headers.get('origin')!==getConfig().appUrl) throw new FoundationError(403,'This action must originate from the application.');
    const body=await readJson(request,6_400_000);
    if (!action && !shareId) return json(await saveReport(projectId,userId,body,reportId,templates));
    if (reportId && action==='delete' && !shareId) return json(await deleteReport(projectId,userId,reportId,body,templates));
    if (!templates && reportId && action==='shares') {
      if (shareId) { input(z.object({}).strict(),body); return json(await revokeReportShare(projectId,userId,reportId,shareId)); }
      return json(await createReportShare(projectId,userId,reportId,body));
    }
  }
  unavailable();
}
