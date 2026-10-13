import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import {performance} from 'node:perf_hooks';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {redirectUrl,resolveRedirectHost} from './domain-redirect-network.ts';
import {addressKey,publicNetworkAddress} from './public-network.ts';

export type CrawlDocumentKind='html'|'robots'|'sitemap';
export type CrawlDownloadReason='blocked'|'dns_error'|'network_error'|'peer_mismatch'|'timeout'|'aborted'|'invalid_response'|'redirect'|'http_status'|'bodyless'|'partial_response'|'unsupported_mime'|'unsupported_encoding'|'wire_limit'|'expanded_limit'|'incomplete_body'|'invalid_compression';
export type CrawlResponseHeaders={contentType:string|null;contentEncoding:string|null;location:string|null;retryAfter:string|null;challenge:boolean;link:string[];xRobotsTag:string[]};
type Observation={status:number|null;headers:CrawlResponseHeaders;wireBytes:number;httpDecodedBytes:number;decodedBytes:number;dnsMs:number|null;headersMs:number|null;durationMs:number};
export type CrawlDocumentObservation=Observation&({complete:true;body:Buffer;reason:null}|{complete:false;body:null;reason:CrawlDownloadReason});
const capacities={html:1024*1024,robots:512*1024,sitemap:5*1024*1024};
const HEADER_LIMIT=16384,URL_LIMIT=2048,TOTAL_MS=15000;
class DownloadFailure extends Error {
  reason:CrawlDownloadReason;
  constructor(reason:CrawlDownloadReason){super('Crawl document unavailable.');this.reason=reason;}
}
const failure=(reason:CrawlDownloadReason)=>new DownloadFailure(reason);
const gzipMagic=(bytes:Buffer)=>bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b;

function headersFrom(raw:string[]):{headers:CrawlResponseHeaders;length:bigint|null;transfer:string|null} {
  if(!Array.isArray(raw)||raw.length%2!==0)throw failure('invalid_response');
  const values=new Map<string,string[]>();let size=0;
  for(let i=0;i<raw.length;i+=2){
    const name=raw[i],value=raw[i+1];
    if(typeof name!=='string'||typeof value!=='string'||!name||/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name)||/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))throw failure('invalid_response');
    size+=Buffer.byteLength(name)+Buffer.byteLength(value)+4;if(size>HEADER_LIMIT)throw failure('invalid_response');
    const key=name.toLowerCase();
    if(['content-type','content-encoding','location','retry-after','cf-mitigated','link','x-robots-tag','content-length','transfer-encoding'].includes(key))values.set(key,[...(values.get(key)??[]),value.trim()]);
  }
  const single=(key:string)=>{const entries=values.get(key)??[];if(entries.length>1)throw failure('invalid_response');return entries[0]??null;};
  const headers={contentType:single('content-type'),contentEncoding:single('content-encoding'),location:single('location'),retryAfter:single('retry-after'),challenge:single('cf-mitigated')==='challenge',link:values.get('link')??[],xRobotsTag:values.get('x-robots-tag')??[]};
  if(headers.location!==null&&Buffer.byteLength(headers.location)>URL_LIMIT)throw failure('invalid_response');
  const length=single('content-length'),transfer=single('transfer-encoding');
  if(length!==null&&(!/^[0-9]{1,20}$/.test(length)||values.has('transfer-encoding')))throw failure('invalid_response');
  return {headers,length:length===null?null:BigInt(length),transfer};
}

/** One bounded async decoder. Every byte of every stage is counted before retention. */
async function gunzipFile(body:Buffer,limit:number,signal:AbortSignal,onBytes:(count:number)=>void):Promise<Buffer> {
  const output=Buffer.alloc(limit);let count=0;
  const sink=new Writable({write(chunk:Buffer,_encoding,callback){
    count+=chunk.length;onBytes(count);
    if(count>limit){callback(failure('expanded_limit'));return;}
    chunk.copy(output,count-chunk.length);callback();
  }});
  const decoder=createGunzip();
  try{
    await pipeline(Readable.from([body]),decoder,sink,{signal});signal.throwIfAborted();
    if(decoder.bytesWritten!==body.length)throw failure('invalid_compression');
    return output.subarray(0,count);
  }catch(error){if(error instanceof DownloadFailure||signal.aborted)throw error;throw failure('invalid_compression');}
}

async function requestDocument(url:URL,address:{address:string;family:4|6},kind:CrawlDocumentKind,signal:AbortSignal,observation:Observation):Promise<Buffer> {
  const client=url.protocol==='https:'?https:http;
  const agent=url.protocol==='https:'?new https.Agent({keepAlive:false,proxyEnv:{}}):new http.Agent({keepAlive:false,proxyEnv:{}});
  const started=performance.now(),limit=capacities[kind],hostname=url.hostname.replace(/^\[|\]$/g,'');
  return new Promise<Buffer>((resolve,reject)=>{
    let settled=false,peerChecked=false,response:http.IncomingMessage|undefined;
    const finish=(error?:unknown,body?:Buffer)=>{
      if(settled)return;settled=true;signal.removeEventListener('abort',abort);
      response?.destroy();request.destroy();agent.destroy();
      if(error)reject(error);else resolve(body!);
    };
    const abort=()=>{request.destroy();if(response)response.destroy(failure('aborted'));else finish(failure('aborted'));};
    const request=client.request(url,{
      method:'GET',agent,signal,maxHeaderSize:HEADER_LIMIT,insecureHTTPParser:false,family:address.family,
      ...(url.protocol==='https:'?{servername:isIP(hostname)?'':hostname,rejectUnauthorized:true}:{}),
      headers:{accept:kind==='html'?'text/html,application/xhtml+xml':'*/*','accept-encoding':'gzip, identity','user-agent':'TenMonitorBot/1.0',connection:'close'},
      lookup:(name,options,callback)=>{
        if(name!==hostname){callback(new Error('Pinned hostname mismatch.'),'',0);return;}
        if(options.all)callback(null,[address]);else callback(null,address.address,address.family);
      },
    },incoming=>{
      response=incoming;observation.headersMs=Math.round(performance.now()-started);
      if(settled){incoming.destroy();return;}
      // A response without the exact connected peer is never consumed, including mocked/misbehaving sockets.
      if(!peerChecked){finish(failure('peer_mismatch'));return;}
      const consume=async()=>{
        const status=incoming.statusCode;
        if(!status||status<200||status>599)throw failure('invalid_response');
        observation.status=status;
        const parsed=headersFrom(incoming.rawHeaders);observation.headers=parsed.headers;
        if(status===204||status===205||status===304)throw failure('bodyless');
        if(status>=300&&status<400)throw failure('redirect');
        if(status===206)throw failure('partial_response');
        if(status<200||status>=300)throw failure('http_status');
        const mime=parsed.headers.contentType?.split(';',1)[0].trim().toLowerCase();
        if(kind==='html'&&mime!=='text/html'&&mime!=='application/xhtml+xml')throw failure('unsupported_mime');
        if(parsed.transfer!==null&&parsed.transfer.toLowerCase()!=='chunked')throw failure('unsupported_encoding');
        const encoding=parsed.headers.contentEncoding?.toLowerCase()??'identity';
        if(encoding!=='gzip'&&encoding!=='identity')throw failure('unsupported_encoding');
        const wire=new Transform({transform(chunk:Buffer,_encoding,callback){
          observation.wireBytes+=chunk.length;
          if(observation.wireBytes>limit){callback(failure('wire_limit'));return;}
          callback(null,chunk);
        }});
        // The response is part of the same pipeline so abort/limit destroys the actual native download.
        const output=Buffer.alloc(limit);let count=0;
        const sink=new Writable({write(chunk:Buffer,_encoding,callback){
          count+=chunk.length;observation.httpDecodedBytes=count;observation.decodedBytes=count;
          if(count>limit){callback(failure('expanded_limit'));return;}
          chunk.copy(output,count-chunk.length);callback();
        }});
        const decoder=encoding==='gzip'?createGunzip():null;
        try{await pipeline(decoder?[incoming,wire,decoder,sink]:[incoming,wire,sink],{signal});}
        catch(error){
          if(error instanceof DownloadFailure||signal.aborted)throw error;
          throw failure(!incoming.complete?'incomplete_body':encoding==='gzip'?'invalid_compression':'network_error');
        }
        if(!incoming.complete||(parsed.length!==null&&parsed.length!==BigInt(observation.wireBytes)))throw failure('incomplete_body');
        if(decoder&&decoder.bytesWritten!==observation.wireBytes)throw failure('invalid_compression');
        signal.throwIfAborted();
        let body:Buffer=output.subarray(0,count);
        if(gzipMagic(body)){
          if(kind!=='sitemap')throw failure('unsupported_encoding');
          // A .gz suffix is not evidence of another layer. Only post-HTTP gzip bytes enable the file decoder.
          body=await gunzipFile(body,limit,signal,bytes=>{observation.decodedBytes=bytes;});
          if(gzipMagic(body))throw failure('unsupported_encoding');
        }
        signal.throwIfAborted();return body;
      };
      void consume().then(body=>finish(undefined,body),error=>finish(error));
    });
    request.on('error',(error:NodeJS.ErrnoException)=>{
      if(settled)return;
      if(response){if(!response.complete)response.destroy(failure('incomplete_body'));}
      else finish(failure(error.code?.startsWith('HPE_')?'invalid_response':'network_error'));
    });
    request.once('upgrade',(_response,socket)=>{socket.destroy();finish(failure('invalid_response'));});
    request.once('socket',socket=>socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>{
      const remote=socket.remoteAddress?.replace(/^::ffff:/,'');
      if(!remote||addressKey(remote)!==addressKey(address.address)){finish(failure('peer_mismatch'));return;}
      peerChecked=true;
    }));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();else request.end();
  }).finally(()=>agent.destroy());
}

/** Transient bytes/headers only: this neither follows redirects nor establishes crawl permission or scope. */
export async function fetchCrawlDocument(rawUrl:string,kind:CrawlDocumentKind,signal?:AbortSignal):Promise<CrawlDocumentObservation> {
  const started=performance.now(),controller=new AbortController();let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},TOTAL_MS);
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const observation:Observation={status:null,headers:{contentType:null,contentEncoding:null,location:null,retryAfter:null,challenge:false,link:[],xRobotsTag:[]},wireBytes:0,httpDecodedBytes:0,decodedBytes:0,dnsMs:null,headersMs:null,durationMs:0};
  try{
    controller.signal.throwIfAborted();
    if(typeof kind!=='string'||!Object.hasOwn(capacities,kind))throw failure('blocked');
    let url:URL;try{url=redirectUrl(rawUrl);}catch{throw failure('blocked');}
    const dnsStarted=performance.now();let addresses:{address:string;family:4|6}[];
    try{addresses=await resolveRedirectHost(url.hostname.replace(/^\[|\]$/g,''),controller.signal);}catch{throw failure('dns_error');}
    finally{observation.dnsMs=Math.round(performance.now()-dnsStarted);}
    controller.signal.throwIfAborted();
    if(addresses.length<1||addresses.length>32||addresses.some(a=>isIP(a.address)!==a.family||!publicNetworkAddress(a.address)))throw failure('blocked');
    const body=await requestDocument(url,addresses[0],kind,controller.signal,observation);
    controller.signal.throwIfAborted();
    return {...observation,durationMs:Math.round(performance.now()-started),complete:true,body,reason:null};
  }catch(error){
    const reason=signal?.aborted?'aborted':timedOut?'timeout':error instanceof DownloadFailure?error.reason:'network_error';
    return {...observation,durationMs:Math.round(performance.now()-started),complete:false,body:null,reason};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
}
