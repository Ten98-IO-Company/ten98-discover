import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {requestRedirectHeaders} from '../src/server/domain-redirect-network.ts';

assert.equal(process.env.TEN98_PROXY_FIXTURE,'1');
let trapRequests=0,directAttempts=0,hold=false;
const trap=http.createServer((_request,response)=>{trapRequests++;response.writeHead(502).end();});
trap.on('connect',(_request,socket)=>{trapRequests++;socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
await new Promise<void>(resolve=>trap.listen(0,'127.0.0.1',resolve));
const bound=trap.address();assert.ok(bound&&typeof bound!=='string');
const proxy=`http://127.0.0.1:${bound.port}`;
for(const name of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'])process.env[name]=proxy;
process.env.NO_PROXY='';process.env.no_proxy='';
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(this:net.Socket,...args:unknown[]){
  const options=(Array.isArray(args[0])?args[0][0]:args[0]) as any;
  // Only the owned loopback trap may open a socket. Every public request is intercepted before DNS/connect.
  if(options?.host==='127.0.0.1'&&Number(options.port)===bound.port)return original.apply(this,args as any);
  directAttempts++;
  assert.equal(options.host,'alias.example.com');assert.equal(options.family,4);
  options.lookup('alias.example.com',{all:false},(error:unknown,address:string,family:number)=>{assert.equal(error,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);});
  if(!hold)queueMicrotask(()=>this.destroy(new Error('Synthetic socket refused before network.')));
  return this;
} as typeof original;
try{
  for(const scheme of ['https:','http:'])await assert.rejects(requestRedirectHeaders(new URL(`${scheme}//alias.example.com/path?private=value`),{address:'1.1.1.1',family:4},AbortSignal.timeout(1000)),/Redirect observation unavailable/);
  hold=true;
  await assert.rejects(requestRedirectHeaders(new URL('https://alias.example.com/'),{address:'1.1.1.1',family:4},AbortSignal.timeout(30)),/Redirect observation unavailable/);
  assert.equal(directAttempts,3);assert.equal(trapRequests,0);
  console.log('PASS contained native no-proxy and header-stall timeout');
}finally{
  net.Socket.prototype.connect=original;trap.closeAllConnections();await new Promise<void>(resolve=>trap.close(()=>resolve()));
}
