import {createMcpHandler} from '@modelcontextprotocol/server';
import {authenticateApiKey,parseApiKeyHeaders} from './api-keys.ts';
import {FoundationError} from './auth.ts';
import {InputError,readJson} from './validation.ts';
import {createNativeMcpServer,mcpTools,mcpResponseBytes,type McpLimit} from './mcp-tools.ts';

function failure(status:number,code:number,message:string,id:string|number|null=null){
  return Response.json({jsonrpc:'2.0',id,error:{code,message}},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...(status===405?{allow:'POST'}:{})}});
}
export function mcpOriginAllowed(headers:Headers,appUrl:string){return !headers.has('origin')||headers.get('origin')===appUrl;}
export async function handleMcp(request:Request,appUrl:string,limit:McpLimit):Promise<Response>{
  let id:string|number|null=null;
  try{
    if(request.method!=='POST')return failure(405,-32600,'Use POST for stateless MCP.');
    if(new URL(request.url).search)return failure(400,-32600,'MCP does not accept URL parameters.');
    if(!mcpOriginAllowed(request.headers,appUrl))return failure(403,-32600,'Origin is not allowed.');
    const token=parseApiKeyHeaders(request.headers);
    if(!token)throw new FoundationError(401,'A native Bearer API key is required.');
    const principal=await authenticateApiKey(token);
    await limit(`api-key:${principal.id}`,120);
    const body=await readJson(request,262144);
    if(!body||typeof body!=='object'||Array.isArray(body))return failure(400,-32600,'Use one JSON-RPC object, not an array.');
    const message=body as Record<string,unknown>;
    if(Object.hasOwn(message,'id')){
      if(!(typeof message.id==='string'&&message.id.length<=128||typeof message.id==='number'&&Number.isSafeInteger(message.id)))return failure(400,-32600,'Use a bounded string or safe integer request ID.');
      id=message.id;
    }
    if(message.jsonrpc!=='2.0'||typeof message.method!=='string'||message.method.length>128)return failure(400,-32600,'Use a valid JSON-RPC request.');
    if(message.method==='tools/call'){
      const params=message.params as {name?:unknown;arguments?:unknown}|null;
      const tool=mcpTools.find(item=>item.name===params?.name);
      if(!tool||!tool.schema.safeParse(params?.arguments??{}).success)return failure(400,-32602,'Unknown tool or invalid tool arguments.',id);
    }
    const state={principal,committed:false},controller=new AbortController();
    const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
    const handler=createMcpHandler(()=>createNativeMcpServer(token,state,limit),{legacy:'stateless',responseMode:'auto',maxRequestBodySize:262144,maxSubscriptions:0,keepAliveMs:0});
    try{
      const response=await handler.fetch(new Request(request.url,{method:'POST',headers:request.headers,signal:controller.signal}),{parsedBody:body});
      const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      if(reader)try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>mcpResponseBytes){await reader.cancel();return failure(503,-32603,'The complete response is too large. Narrow the read selection.',id);}chunks.push(next.value);}}finally{reader.releaseLock();}
      if(!state.committed){
        // Publishing discovery/whoami/read responses is a fresh authority decision;
        // it cannot retract bytes delivered by earlier requests.
        const current=await authenticateApiKey(token);
        if(current.userId!==principal.userId||current.workspaceId!==principal.workspaceId||current.role!==principal.role||JSON.stringify(current.scopes)!==JSON.stringify(principal.scopes))throw new FoundationError(403,'Authority changed.');
      }
      const headers=new Headers(response.headers);headers.set('cache-control','no-store');headers.set('x-content-type-options','nosniff');
      return new Response(response.body===null?null:Buffer.concat(chunks),{status:response.status,headers});
    }finally{request.signal.removeEventListener('abort',abort);controller.abort();await handler.close();}
  }catch(error){
    const status=error instanceof FoundationError||error instanceof InputError?error.status:500;
    return failure(status,status===400?-32700:-32603,status===401?'A valid native Bearer API key is required.':status===403?'The current key authority does not permit this request.':status===413?'The request body exceeds 262144 UTF-8 bytes.':status===415?'Use application/json.':status===429?'Too many requests. Wait a minute and retry.':status===400?'Malformed JSON, UTF-8 or request headers.':'The MCP request could not be completed. For writes retry the identical request ID.',id);
  }
}
