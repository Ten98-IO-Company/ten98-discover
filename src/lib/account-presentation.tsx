import {createContext,useContext} from 'react';
import {ApiError} from './api';
import {accountPreferencesWireDtoSchema,type AccountPreferencesDto} from './account-preferences';

export type AccountPresentation = {
  data:AccountPreferencesDto|null;
  loading:boolean;
  error:string;
  reload:()=>Promise<void>;
  accept:(value:AccountPreferencesDto)=>boolean;
  unavailable:(message:string)=>void;
};
export const AccountPresentationContext=createContext<AccountPresentation|null>(null);
export const useAccountPresentation=()=>useContext(AccountPresentationContext);

// Shared by the actual shell read and explicit profile save; no browser persistence.
export async function requestAccountPreferences(callerSignal:AbortSignal,body?:unknown):Promise<AccountPreferencesDto> {
  const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(15000)]);
  try {
  let response:Response;
  try {response=await fetch('/api/account/preferences',{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',signal,headers:{accept:'application/json',...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}});}
  catch(error){if(signal.aborted)throw error;throw new ApiError('The request could not be confirmed. Reload saved preferences before trying again.');}
  if([401,403,404].includes(response.status)){
    void response.body?.cancel().catch(()=>{});const error=new ApiError(response.status===401?'Your session ended. Sign in again.':'Your account preferences are unavailable. Reload them to continue.');error.status=response.status;throw error;
  }
  if(response.ok&&response.status!==200){await response.body?.cancel();throw new Error('The account response could not be verified. Reload saved preferences.');}
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new Error('The account response could not be verified. Reload saved preferences.');}
  const length=response.headers.get('content-length');
  const identity=!response.headers.get('content-encoding')||response.headers.get('content-encoding')?.toLowerCase()==='identity';
  if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||identity&&Number(length)>8192)){await response.body?.cancel();throw new Error('The account response exceeded its limit. Reload saved preferences.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('The account response was empty. Reload saved preferences.');
  const parts:Uint8Array[]=[];let bytes=0;
  try{for(;;){let chunk:ReadableStreamReadResult<Uint8Array>;try{chunk=await reader.read();}catch(error){if(signal.aborted)throw error;throw new ApiError('The request could not be confirmed. Reload saved preferences before trying again.');}const {done,value}=chunk;if(done)break;bytes+=value.byteLength;if(bytes>8192){await reader.cancel();throw new Error('The account response exceeded its limit. Reload saved preferences.');}parts.push(value);}}
  finally{reader.releaseLock();}
  if(length!==null&&identity&&Number(length)!==bytes)throw new Error('The account response was incomplete. Reload saved preferences.');
  const whole=new Uint8Array(bytes);let offset=0;for(const part of parts){whole.set(part,offset);offset+=part.byteLength;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(whole));}catch{throw new Error('The account response could not be verified. Reload saved preferences.');}
  if(!response.ok){const error=new ApiError(typeof value==='object'&&value!==null&&'error'in value&&typeof value.error==='string'?value.error:'Account preferences could not be saved. Reload them before trying again.');error.status=response.status;throw error;}
  const parsed=accountPreferencesWireDtoSchema.safeParse(value);if(!parsed.success)throw new Error('The account response could not be verified. Reload saved preferences.');return parsed.data;
  } catch(error) {
    if(!callerSignal.aborted&&signal.aborted)throw new ApiError('The request timed out and could not be confirmed. Reload saved preferences before trying again.');
    throw error;
  }
}
