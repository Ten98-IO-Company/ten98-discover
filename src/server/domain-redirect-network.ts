import http from 'node:http';
import https from 'node:https';
import {Resolver} from 'node:dns/promises';
import {isIP} from 'node:net';
import {performance} from 'node:perf_hooks';
import {toUSVString} from 'node:util';
import {normalizePublicHostname} from './domains.ts';
import {addressKey,publicNetworkAddress} from './public-network.ts';

const URL_LIMIT=2048, HEADER_LIMIT=16384, HOP_MS=5000, TOTAL_MS=30000;
const redirects=new Set([301,302,303,307,308]);
type Address={address:string;family:4|6};
export type RedirectHop={url:string;status:number;durationMs:number;location:string|null};
export type RedirectObservation={outcome:'response'|'blocked'|'unavailable'|'timeout'|'loop'|'hop_limit';hops:RedirectHop[];finalUrl:string|null;targetMatches:boolean|null;durationMs:number};
export type RedirectTransport={resolve:(hostname:string,signal:AbortSignal)=>Promise<Address[]>;request:(url:URL,address:Address,signal:AbortSignal)=>Promise<{status:number;location:string|null}>};
class RedirectFailure extends Error {
  outcome:RedirectObservation['outcome'];
  constructor(outcome:RedirectObservation['outcome']){super('Redirect observation unavailable.');this.outcome=outcome;}
}

/** URLs are transient; only cleanUrl output may enter evidence or diagnostics. */
export function redirectUrl(raw:string,base?:URL):URL {
  if(typeof raw!=='string'||!raw||Buffer.byteLength(raw)>URL_LIMIT||toUSVString(raw)!==raw||/[\u0000-\u0020\u007f\\]/u.test(raw))throw new RedirectFailure('blocked');
  let url:URL;
  try{url=new URL(raw,base);}catch{throw new RedirectFailure('blocked');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||Buffer.byteLength(url.href)>URL_LIMIT)throw new RedirectFailure('blocked');
  // Reject URL-parser shorthand and encoded authorities, including numeric/hex/octal IPv4.
  const authority=/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(raw)?.[1];
  if(authority!==undefined){
    const host=authority.replace(/:(?:80|443)$/,'');
    if(authority.includes('%')||!host)throw new RedirectFailure('blocked');
    const literal=host.replace(/^\[|\]$/g,'');
    try{
      if(isIP(literal)?addressKey(literal)!==addressKey(url.hostname.replace(/^\[|\]$/g,'')):normalizePublicHostname(host)!==url.hostname)throw new Error();
    }catch{throw new RedirectFailure('blocked');}
  }else if(/^[a-z][a-z0-9+.-]*:/i.test(raw))throw new RedirectFailure('blocked');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(isIP(hostname)){if(!publicNetworkAddress(hostname))throw new RedirectFailure('blocked');}
  else {try{if(normalizePublicHostname(hostname)!==hostname)throw new Error();}catch{throw new RedirectFailure('blocked');}}
  url.hash='';
  return url;
}
function cleanUrl(url:URL){return `${url.origin}${url.pathname}`;}

export async function resolveRedirectHost(hostname:string,signal:AbortSignal):Promise<Address[]> {
  if(isIP(hostname))return [{address:hostname,family:isIP(hostname) as 4|6}];
  const resolver=new Resolver({timeout:HOP_MS,tries:1});
  const cancel=()=>resolver.cancel();signal.addEventListener('abort',cancel,{once:true});
  try{
    signal.throwIfAborted();
    const values=await Promise.allSettled([resolver.resolve4(hostname),resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    const result:Address[]=[];
    for(const [i,value] of values.entries()){
      if(value.status==='rejected'){if(value.reason?.code!=='ENODATA')throw new RedirectFailure('unavailable');continue;}
      for(const address of value.value)result.push({address,family:i===0?4:6});
    }
    return result;
  }finally{signal.removeEventListener('abort',cancel);resolver.cancel();}
}

/** No global agent or environment proxy; each request resolves through the vetted, pinned address only. */
export async function requestRedirectHeaders(url:URL,address:Address,signal:AbortSignal):Promise<{status:number;location:string|null}> {
  redirectUrl(url.href);
  if(isIP(address.address)!==address.family||!publicNetworkAddress(address.address))throw new RedirectFailure('blocked');
  const client=url.protocol==='https:'?https:http;
  const agent=url.protocol==='https:'?new https.Agent({keepAlive:false,proxyEnv:{}}):new http.Agent({keepAlive:false,proxyEnv:{}});
  return new Promise((resolve,reject)=>{
    let done=false;
    const fail=()=>{if(!done){done=true;agent.destroy();reject(new RedirectFailure(signal.aborted?'timeout':'unavailable'));}};
    const request=client.request(url,{
      method:'GET',agent,signal,maxHeaderSize:HEADER_LIMIT,insecureHTTPParser:false,
      family:address.family,
      ...(url.protocol==='https:'?{servername:isIP(url.hostname.replace(/^\[|\]$/g,''))?'':url.hostname,rejectUnauthorized:true}:{}),
      headers:{accept:'*/*','user-agent':'ten98-monitor/redirect-check','connection':'close'},
      lookup:(hostname,options,callback)=>{
        if(hostname!==url.hostname.replace(/^\[|\]$/g,'')){callback(new Error('Pinned hostname mismatch.'),'',0);return;}
        if(options.all)callback(null,[address]);else callback(null,address.address,address.family);
      },
    },response=>{
      // Capture only bounded status/location; never consume HTML, refresh tags or response cookies.
      const locations=response.rawHeaders.filter((_,i,a)=>i%2===1&&a[i-1].toLowerCase()==='location');
      const status=response.statusCode,location=locations.length===1?locations[0]:null;
      if(done){response.destroy();return;}
      if(!status||status<200||status>599||locations.length>1||(location!==null&&Buffer.byteLength(location)>URL_LIMIT)){response.destroy();fail();return;}
      done=true;response.destroy();agent.destroy();resolve({status,location});
    });
    request.once('error',fail);
    request.once('upgrade',(_response,socket)=>{socket.destroy();fail();});
    request.once('socket',socket=>socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>{
      const remote=socket.remoteAddress?.replace(/^::ffff:/,'');
      if(!remote||addressKey(remote)!==addressKey(address.address)){request.destroy();fail();}
    }));
    request.end();
  });
}

export async function observeDomainRedirect(hostname:string,expectedHostname:string,transport:RedirectTransport={resolve:resolveRedirectHost,request:requestRedirectHeaders}):Promise<RedirectObservation> {
  const started=performance.now(),controller=new AbortController();
  const total=setTimeout(()=>controller.abort(),TOTAL_MS);
  const hops:RedirectHop[]=[],visited=new Set<string>();
  let current:URL;
  const finish=(outcome:RedirectObservation['outcome'],final:URL|null=null):RedirectObservation=>({outcome,hops,finalUrl:final?cleanUrl(final):null,targetMatches:outcome==='response'&&final?final.hostname===expectedHostname:null,durationMs:Math.round(performance.now()-started)});
  try{
    current=redirectUrl(`https://${normalizePublicHostname(hostname)}/`);normalizePublicHostname(expectedHostname);
    for(let index=0;index<=8;index++){
      controller.signal.throwIfAborted();
      if(visited.has(current.href))return finish('loop',current);visited.add(current.href);
      const hopStarted=performance.now(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(HOP_MS)]);
      const host=current.hostname.replace(/^\[|\]$/g,''),addresses=await transport.resolve(host,signal);
      signal.throwIfAborted();
      if(!Array.isArray(addresses)||addresses.length<1||addresses.length>32||addresses.some(a=>!a||isIP(a.address)!==a.family||!publicNetworkAddress(a.address)))return finish('blocked');
      const response=await transport.request(current,addresses[0],signal);
      signal.throwIfAborted();
      const hop:RedirectHop={url:cleanUrl(current),status:response.status,durationMs:Math.round(performance.now()-hopStarted),location:null};hops.push(hop);
      if(!redirects.has(response.status))return finish('response',current);
      if(!response.location)return finish('unavailable',current);
      const next=redirectUrl(response.location,current);hop.location=cleanUrl(next);
      if(index===8)return finish('hop_limit',current);
      current=next;
    }
    return finish('hop_limit');
  }catch(error){return finish(controller.signal.aborted||(error as Error)?.name==='TimeoutError'||(error as Error)?.name==='AbortError'?'timeout':error instanceof RedirectFailure?error.outcome:'unavailable');}
  finally{clearTimeout(total);}
}
