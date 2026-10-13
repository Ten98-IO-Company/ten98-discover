import {FoundationError,getAuth} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {readJson} from './validation.ts';
import {disableMetaApp,disconnectMeta,getMetaApp,getMetaConnection,inspectMetaAccount,listMetaAccounts,listMetaConnections,metaCallback,saveMetaApp,selectMetaAccount,startMetaConnect} from './meta-auth.ts';
import {acceptMetaDeletion,getMetaDeletionStatus} from './meta-callbacks.ts';
import {cancelMetaImport,enqueueMetaImport,listMetaImports,readMetaImport} from './meta-imports.ts';

const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value:unknown,status=200,extra?:Record<string,string>)=>Response.json(value,{status,headers:{...headers,...extra}});
async function limit(key:string,maximum:number){
 const row=await getDatabase().pool.query(`INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),1)
 ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`,[key,maximum]);
 if(row.rows[0].count>maximum)throw new FoundationError(429,'Too many Meta connection requests. Wait a minute and try again.');
}

/** Native form decoding after byte/deadline enforcement; never trust Content-Length alone. */
export async function readMetaDeletionForm(request:Request):Promise<string>{
 const type=request.headers.get('content-type');
 if(!type||!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?\s*$/i.test(type))throw new FoundationError(415,'Use the Meta signed-request form.');
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^[0-9]+$/.test(length)||!Number.isSafeInteger(Number(length))))throw new FoundationError(400,'Invalid Meta callback body.');
 if(length!==null&&Number(length)>32768)throw new FoundationError(413,'Meta callback body is too large.');
 if(!request.body)throw new FoundationError(400,'Invalid Meta callback body.');
 let size=0;
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]);
 const stream=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
  size+=chunk.byteLength;if(size>32768)throw new FoundationError(413,'Meta callback body is too large.');controller.enqueue(chunk);
 }}),{signal});
 try{
  const form=await new Response(stream,{headers:{'content-type':type}}).formData(),entries=[...form];
  if(entries.length!==1||entries[0][0]!=='signed_request'||typeof entries[0][1]!=='string'||!entries[0][1].length||entries[0][1].length>24576)throw new FoundationError(400,'Invalid Meta callback body.');
  return entries[0][1];
 }catch(error){if(error instanceof FoundationError)throw error;throw new FoundationError(signal.aborted?408:400,'The Meta callback body could not be read.');}
}

export async function handleMeta(request:Request):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname.replace(/\/$/,''),project=path.match(new RegExp(`^/api/projects/(${uuid})/meta(?:/(.*))?$`));
 if(!project&&!path.startsWith('/api/meta/'))return null;
 if(path==='/api/meta/callback'){
  if(request.method!=='GET')return json({error:'Method not allowed.'},405);
  await limit('meta:oauth-callback',300);return metaCallback(request);
 }
 const deletion=path.match(new RegExp(`^/api/meta/apps/(${uuid})/delete-data$`));
 if(deletion){
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  if(url.searchParams.size)throw new FoundationError(400,'Meta callback parameters belong in the form.');
  await limit('meta:deletion-callback',300);
  return json(await acceptMetaDeletion(deletion[1],await readMetaDeletionForm(request)));
 }
 const status=path.match(/^\/api\/meta\/deletion-status\/([A-Za-z0-9_-]{43})$/);
 if(status){
  if(request.method!=='GET')return json({error:'Method not allowed.'},405);
  if(url.searchParams.size)throw new FoundationError(400,'Invalid deletion-status request.');
  await limit('meta:deletion-status',600);const result=await getMetaDeletionStatus(status[1]);
  if(request.headers.get('accept')?.includes('text/html')){
   // All text is closed application copy, never provider or account content.
   const message=result.status==='local_deleted'?'Local application data has been removed. Server backups follow the operator’s separate backup policy.':'Local application data removal is in progress.';
   return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meta data deletion</title><main><h1>Meta data deletion</h1><p>${message}</p></main></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
  }
  return json(result);
 }
 if(path.startsWith('/api/meta/deletion-status/'))return json({error:'Deletion status not found or unavailable.'},404);
 if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
 if(request.method==='POST'&&request.headers.get('origin')!==getConfig().appUrl)throw new FoundationError(403,'This action must originate from the application.');
 const session=await getAuth().api.getSession({headers:request.headers});if(!session)throw new FoundationError(401,'Sign in to continue.');
 await limit(`meta:${request.method==='GET'?'read':'write'}:${session.user.id}`,request.method==='GET'?120:30);
 if(path==='/api/meta/app'&&request.method==='GET')return json(await getMetaApp(session.user.id,url.searchParams));
 if(!project&&url.searchParams.size)throw new FoundationError(400,'Unexpected Meta setup parameters.');
 if(path==='/api/meta/app')return json(await saveMetaApp(session.user.id,await readJson(request)));
 const disable=path.match(new RegExp(`^/api/meta/apps/(${uuid})/disable$`));
 if(disable)return request.method==='POST'?json(await disableMetaApp(session.user.id,disable[1],await readJson(request))):json({error:'Method not allowed.'},405);
 if(!project)return json({error:'Not found.'},404);
 const [,projectId,operation='']=project;
 if(operation===''&&request.method==='GET')return json(await listMetaConnections(projectId,session.user.id,url.searchParams));
 const imports=operation.match(new RegExp(`^connections/(${uuid})/imports$`));
 if(imports){
  if(request.method==='GET')return json(await listMetaImports(projectId,session.user.id,imports[1],url.searchParams));
  if(url.searchParams.size)throw new FoundationError(400,'Unexpected Meta import parameters.');
  return json(await enqueueMetaImport(projectId,session.user.id,imports[1],await readJson(request,32768)));
 }
 const imported=operation.match(new RegExp(`^imports/(${uuid})(/cancel)?$`));
 if(imported){
  if(!imported[2]&&request.method==='GET')return json(await readMetaImport(projectId,session.user.id,imported[1],url.searchParams));
  if(imported[2]&&request.method==='POST'){
   if(url.searchParams.size)throw new FoundationError(400,'Unexpected Meta import parameters.');
   return json(await cancelMetaImport(projectId,session.user.id,imported[1],await readJson(request,32768)));
  }
  return json({error:'Method not allowed.'},405);
 }
 if(url.searchParams.size)throw new FoundationError(400,'Unexpected Meta connection parameters.');
 if(operation==='connect'&&request.method==='POST'){
  const {cookie,...body}=await startMetaConnect(projectId,session,await readJson(request));return json(body,200,{'set-cookie':cookie});
 }
 const connection=operation.match(new RegExp(`^connections/(${uuid})(?:/(accounts|inspect|select|disconnect))?$`));
 if(connection){
  const [,connectionId,action]=connection;
  if(!action&&request.method==='GET')return json(await getMetaConnection(projectId,session.user.id,connectionId));
  if(action&&request.method==='POST'){
   const body=await readJson(request,32768);
   if(action==='accounts')return json(await listMetaAccounts(projectId,session.user.id,connectionId,body));
   if(action==='inspect')return json(await inspectMetaAccount(projectId,session.user.id,connectionId,body));
   if(action==='select')return json(await selectMetaAccount(projectId,session.user.id,connectionId,body));
   return json(await disconnectMeta(projectId,session.user.id,connectionId,body));
  }
  return json({error:'Method not allowed.'},405);
 }
 return json({error:'Not found.'},404);
}
