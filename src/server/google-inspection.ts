import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {googleInput,googleScopes} from './google-reports.ts';
import {activeGoogleApp,googleAccessToken,googleConnection,googleProjectTransaction,refreshGoogleConnection} from './google.ts';
import {googleRequest,GoogleRequestError} from './google-http.ts';
import {googleInspectionBatch,googleInspectionInput,googleInspectionResponse,inspectionUrlInProperty,type GoogleInspectionBatch} from './google-inspection-input.ts';

/** Indexed evidence only. No crawling, indexing requests, job, stored history or retry. */
export async function inspectGoogleUrls(projectId:string,userId:string,connectionId:string,value:unknown,callerSignal?:AbortSignal):Promise<GoogleInspectionBatch>{
  const input=googleInput(googleInspectionInput,value);
  // This bounds provider work, including refresh; waiting for database locks is not a total-request deadline.
  const deadline=AbortSignal.timeout(30_000),signal=callerSignal?AbortSignal.any([callerSignal,deadline]):deadline;
  type Binding={revision:number;appRevision:number;propertyId:string};
  let binding:Binding|undefined;
  const current=async(client:PoolClient)=>{
    const row=await googleConnection(client,projectId,connectionId),app=await activeGoogleApp(client);
    if(row.provider!=='gsc')throw new FoundationError(400,'URL inspection requires a Search Console source.');
    if(row.status!=='ready'||!row.property_id||row.app_revision!==app.revision||!Array.isArray(row.scopes)||!row.scopes.includes(googleScopes.gsc))throw new FoundationError(409,'Reconnect this Search Console source and select its property before inspecting URLs.');
    if(binding&&(row.revision!==binding.revision||app.revision!==binding.appRevision||row.property_id!==binding.propertyId))throw new FoundationError(409,'The Search Console source changed. Refresh status before inspecting again.');
    if(!input.urls.every(url=>inspectionUrlInProperty(url,row.property_id!)))throw new FoundationError(400,'Every URL must belong to this source’s saved Search Console property.');
    return {row,app};
  };
  binding=await googleProjectTransaction(projectId,userId,true,async client=>{
    const {row,app}=await current(client);
    return {revision:row.revision,appRevision:app.revision,propertyId:row.property_id!};
  });
  if(!signal.aborted){
    try{await refreshGoogleConnection(projectId,userId,connectionId,signal,binding);}
    catch(error){if(!signal.aborted||!(error instanceof GoogleRequestError)||error.status===409)throw error;}
  }
  const results:GoogleInspectionBatch['results']=[];
  const skipped=(url:string)=>({url,attempted:false as const,result:null,error:'Not attempted: the inspection was cancelled or its provider-work deadline elapsed.'});
  const result=():GoogleInspectionBatch=>({projectId,connectionId,revision:binding!.revision,propertyId:binding!.propertyId,languageCode:input.languageCode,checkedAt:new Date().toISOString(),indexedVersion:true,results});
  for(const url of input.urls){
    if(signal.aborted){results.push(skipped(url));continue;}
    // ponytail: one workspace lock per bounded15s provider call; use reviewed revocable leases if volume outgrows serialization.
    const outcome=await googleProjectTransaction(projectId,userId,true,async client=>{
      const {row,app}=await current(client);
      if(signal.aborted)return skipped(url);
      const token=await googleAccessToken(client,row,app);
      if(signal.aborted)return skipped(url);
      try{
        const raw=await googleRequest('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',token,{inspectionUrl:url,siteUrl:binding!.propertyId,languageCode:input.languageCode},undefined,signal);
        const parsed=googleInspectionResponse.safeParse(raw);
        if(!parsed.success)throw new GoogleRequestError(502);
        return {url,attempted:true as const,result:parsed.data.inspectionResult,error:null};
      }catch(error){
        // Lost Google authority invalidates the whole batch, including earlier results.
        if(error instanceof GoogleRequestError&&error.reauthorize){await client.query("UPDATE google_connection SET status='reconnect',updated_at=now() WHERE id=$1",[row.id]);return error;}
        if(!(error instanceof GoogleRequestError)||error.status===409)throw error;
        return {url,attempted:true as const,result:null,error:signal.aborted?'Inspection interrupted: no result was confirmed.':error.status===429?'Google quota is exhausted. Wait before inspecting again.':'Google did not return a usable inspection. Try this URL again later.'};
      }
    });
    if(outcome instanceof GoogleRequestError)throw outcome;
    results.push(outcome);
    if(Buffer.byteLength(JSON.stringify(result()),'utf8')>2_097_152)throw new FoundationError(503,'The complete inspection is too large. Inspect fewer URLs.');
  }
  await googleProjectTransaction(projectId,userId,true,current);
  const response=googleInspectionBatch.parse(result());
  if(Buffer.byteLength(JSON.stringify(response),'utf8')>2_097_152)throw new FoundationError(503,'The complete inspection is too large. Inspect fewer URLs.');
  return response;
}
