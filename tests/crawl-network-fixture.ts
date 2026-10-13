import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {gzipSync} from 'node:zlib';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {Resolver} from 'node:dns/promises';
import {fetchCrawlDocument} from '../src/server/crawl-network.ts';

assert.equal(process.env.TEN98_CRAWL_FIXTURE,'1');
if(process.argv[2]==='fragmented'){
  net.Socket.prototype.connect=function(){throw new Error('No socket allowed in fragmented fixture.');} as typeof net.Socket.prototype.connect;
  Resolver.prototype.resolve4=(async()=>['1.1.1.1']) as unknown as typeof Resolver.prototype.resolve4;
  Resolver.prototype.resolve6=(async()=>[]) as unknown as typeof Resolver.prototype.resolve6;
  const count=1024*1024;let remaining=count,reads=0;
  https.request=((_url:URL,_options:any,callback:(response:any)=>void)=>{
    const request=new EventEmitter() as any;request.destroy=()=>{};
    request.end=()=>queueMicrotask(()=>{
      const socket=new EventEmitter() as any;socket.remoteAddress='1.1.1.1';request.emit('socket',socket);socket.emit('secureConnect');
      const response=new Readable({read(){
        reads++;
        if(remaining-- >0)this.push(Buffer.from('x'));
        else {response.complete=true;this.push(null);}
      }}) as Readable&{complete:boolean;statusCode:number;rawHeaders:string[]};
      response.complete=false;response.statusCode=200;response.rawHeaders=['Content-Type','text/html'];callback(response);
    });return request;
  }) as typeof https.request;
  const result=await fetchCrawlDocument('https://crawl.example.com/','html');
  assert.equal(result.complete,true);assert.equal(result.body?.length,count);assert.equal(result.body?.buffer.byteLength,count);
  assert.equal(result.body?.[0],120);assert.equal(result.body?.[count-1],120);assert.equal(result.wireBytes,count);assert.ok(reads>=count);
  console.log('PASS contained fragmented one-byte body within 192 MiB heap');
}else{
let trapRequests=0,directAttempts=0,hold=false,serve=false,maskPeer=true;
const sockets=new Set<net.Socket>();
const site=net.createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.once('data',bytes=>{
    const path=bytes.toString('latin1').split(' ')[1];
    const zipped=gzipSync('<html/>');
    if(path==='/ok')socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 7\r\nConnection: close\r\n\r\n<html/>');
    else if(path==='/short')socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort');
    else if(path==='/chunk')socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n7\r\n<html/>\r\n');
    else if(path==='/gzip')socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: ${zipped.length-1}\r\nConnection: close\r\n\r\n`),zipped.subarray(0,-1)]));
    else if(path==='/large')socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Fill: '+ 'x'.repeat(16384)+'\r\n\r\n');
    else if(path==='/duplicate')socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx');
    else socket.destroy();
  });
});
await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
const siteBound=site.address();assert.ok(siteBound&&typeof siteBound!=='string');
const trap=http.createServer((_request,response)=>{trapRequests++;response.writeHead(502).end();});
trap.on('connect',(_request,socket)=>{trapRequests++;socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
await new Promise<void>(resolve=>trap.listen(0,'127.0.0.1',resolve));
const bound=trap.address();assert.ok(bound&&typeof bound!=='string');
const proxy=`http://127.0.0.1:${bound.port}`;
for(const name of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'])process.env[name]=proxy;
process.env.NO_PROXY='';process.env.no_proxy='';
const original=net.Socket.prototype.connect,resolve4=Resolver.prototype.resolve4,resolve6=Resolver.prototype.resolve6;
Resolver.prototype.resolve4=(async()=>['1.1.1.1']) as unknown as typeof resolve4;
Resolver.prototype.resolve6=(async()=>[]) as unknown as typeof resolve6;
net.Socket.prototype.connect=function(this:net.Socket,...args:unknown[]){
  const options=(Array.isArray(args[0])?args[0][0]:args[0]) as any;
  // No external native connection can leave this child, including failed assertions/cleanup paths.
  if(options?.host==='127.0.0.1'&&Number(options.port)===bound.port)return original.apply(this,args as any);
  directAttempts++;
  assert.equal(options.host,'crawl.example.com');assert.equal(options.family,4);
  options.lookup('crawl.example.com',{all:false},(error:unknown,address:string,family:number)=>{assert.equal(error,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);});
  if(serve){
    // Only this fixture maps a vetted address to its owned loopback server; production has no override.
    if(maskPeer)this.once('connect',()=>Object.defineProperty(this,'remoteAddress',{value:'1.1.1.1',configurable:true}));
    return original.call(this,{...options,host:'127.0.0.1',port:siteBound.port,lookup:undefined});
  }
  if(!hold)queueMicrotask(()=>this.destroy(new Error('Synthetic refusal before network.')));
  return this;
} as typeof original;
try{
  for(const scheme of ['https:','http:'])assert.equal((await fetchCrawlDocument(`${scheme}//crawl.example.com/`,'html')).reason,'network_error');
  hold=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30);
  try{assert.equal((await fetchCrawlDocument('https://crawl.example.com/','html',controller.signal)).reason,'aborted');}finally{clearTimeout(timer);}
  assert.equal(directAttempts,3);assert.equal(trapRequests,0);serve=true;
  assert.equal((await fetchCrawlDocument('http://crawl.example.com/ok','html')).body?.toString(),'<html/>');
  for(const path of ['short','chunk'])assert.equal((await fetchCrawlDocument(`http://crawl.example.com/${path}`,'html')).reason,'incomplete_body');
  assert.equal((await fetchCrawlDocument('http://crawl.example.com/gzip','html')).reason,'invalid_compression');
  for(const path of ['large','duplicate'])assert.equal((await fetchCrawlDocument(`http://crawl.example.com/${path}`,'html')).reason,'invalid_response');
  maskPeer=false;assert.equal((await fetchCrawlDocument('http://crawl.example.com/ok','html')).reason,'peer_mismatch');
  assert.equal(trapRequests,0);console.log('PASS contained native no-proxy, framing, header limits, peer and abort');
}finally{
  // Stop owned native resources before restoring containment hooks.
  for(const socket of sockets)socket.destroy();
  await new Promise<void>(resolve=>site.close(()=>resolve()));
  trap.closeAllConnections();await new Promise<void>(resolve=>trap.close(()=>resolve()));
  net.Socket.prototype.connect=original;Resolver.prototype.resolve4=resolve4;Resolver.prototype.resolve6=resolve6;
}
}
