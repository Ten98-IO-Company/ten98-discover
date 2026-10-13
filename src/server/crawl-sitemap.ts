import {toUSVString} from 'node:util';
import {SaxesParser} from 'saxes';

export const sitemapLimits=Object.freeze({bytes:50*1024*1024,entries:50_000,retainedUrlBytes:8*1024*1024,depth:32,elements:1_000_000,attributes:32,name:256,attributeBytes:8192,urlBytes:2048,writeBytes:16384});
export type SitemapAnalysis={
  status:'complete'|'partial'|'unavailable';reasons:string[];kind:'urlset'|'sitemapindex'|null;
  entries:{url:string}[];counts:{seen:number;accepted:number;invalid:number;omitted:number;foreignOrigin:number};
  bytesRead:number;entriesComplete:boolean;
};
const namespace='http://www.sitemaps.org/schemas/sitemap/0.9';
const emptyCounts=()=>({seen:0,accepted:0,invalid:0,omitted:0,foreignOrigin:0});

// Discovery evidence only. Neither this normalization nor the document's origin grants fetch authority.
function webUrl(value:string):URL|null {
  if(typeof value!=='string'||value.length>sitemapLimits.urlBytes||toUSVString(value)!==value||Buffer.byteLength(value)>sitemapLimits.urlBytes||!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f\\]/u.test(value)||/%(?![a-f0-9]{2})/iu.test(value))return null;
  try {
    const url=new URL(value),authority=value.slice(value.indexOf('//')+2).split(/[/?#]/,1)[0];
    return authority&&!authority.includes('@')&&!url.username&&!url.password&&!value.includes('#')&&Buffer.byteLength(url.href)<=sitemapLimits.urlBytes?url:null;
  }catch{return null;}
}

/** Pure XML analysis. Live use MUST run in a separate heap/deadline-limited process:
 * saxes buffers unfinished tokens before our event limits can run. No entries survive a failed document. */
export function parseSitemap(input:{documentUrl:string;chunks:Iterable<Uint8Array>}):SitemapAnalysis {
  let bytesRead=0,kind:SitemapAnalysis['kind']=null,failure='invalid_xml';
  const unavailable=(reason:string):SitemapAnalysis=>({status:'unavailable',reasons:[reason],kind:null,entries:[],counts:emptyCounts(),bytesRead,entriesComplete:false});
  const base=webUrl(input.documentUrl);
  if(!base)return unavailable('invalid_document_url');
  const reasons=new Set<string>(),entries:{url:string}[]=[],counts=emptyCounts();
  let depth=0,elements=0,attributes=0,retainedBytes=0;
  let entry:{locs:number;loc:string;bad:boolean}|null=null,collecting=false;
  const stop=(reason:string):never=>{failure=reason;throw new Error('Sitemap unavailable');};
  const parser=new SaxesParser({xmlns:true,fragment:false,defaultXMLVersion:'1.0',forceXMLVersion:true});
  parser.on('xmldecl',decl=>{if(decl.version!=='1.0'||decl.encoding&&decl.encoding.toLowerCase()!=='utf-8')stop('unsupported_xml_declaration');});
  parser.on('doctype',()=>stop('doctype_forbidden'));
  parser.on('opentagstart',tag=>{
    if(++elements>sitemapLimits.elements)stop('element_limit');
    if(++depth>sitemapLimits.depth)stop('depth_limit');
    if(tag.name.length>sitemapLimits.name)stop('name_limit');
    attributes=0;
  });
  parser.on('attribute',attr=>{
    if(++attributes>sitemapLimits.attributes)stop('attribute_limit');
    if(attr.name.length>sitemapLimits.name)stop('name_limit');
    if(Buffer.byteLength(attr.value)>sitemapLimits.attributeBytes)stop('attribute_value_limit');
  });
  parser.on('opentag',tag=>{
    if(depth===1){
      if(tag.uri!==namespace||tag.local!=='urlset'&&tag.local!=='sitemapindex')stop('unsupported_format');
      kind=tag.local==='urlset'?'urlset':'sitemapindex';return;
    }
    if(depth===2&&tag.uri===namespace&&tag.local===(kind==='urlset'?'url':'sitemap')){
      if(++counts.seen>sitemapLimits.entries)stop('entry_limit');
      entry={locs:0,loc:'',bad:false};return;
    }
    if(entry&&depth===3&&tag.uri===namespace&&tag.local==='loc'){
      entry.locs++;collecting=true;return;
    }
    if(collecting&&entry)entry.bad=true;
    if(tag.uri===namespace&&(depth===2||['url','sitemap','loc'].includes(tag.local)))reasons.add('invalid_structure');
  });
  const text=(value:string)=>{
    if(collecting&&entry&&depth===3){
      // ponytail: keep only one short loc; oversized values are invalid entries, never truncated URLs.
      if(entry.loc.length+value.length>sitemapLimits.urlBytes)entry.bad=true;
      else entry.loc+=value;
    }else if(depth<=2&&/[^ \t\r\n]/u.test(value))reasons.add('invalid_structure');
  };
  parser.on('text',text);parser.on('cdata',text);
  parser.on('closetag',()=>{
    if(depth===3)collecting=false;
    if(depth===2&&entry){
      const raw=entry.loc.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,''),url=entry.bad||entry.locs!==1||Array.from(raw).length>=2048?null:webUrl(raw);
      if(!url){counts.invalid++;reasons.add('invalid_entry');}
      else {
        counts.accepted++;
        if(url.origin!==base.origin){counts.foreignOrigin++;reasons.add('foreign_origin');}
        else if(kind==='urlset'&&!url.pathname.startsWith(base.pathname.slice(0,base.pathname.lastIndexOf('/')+1)))reasons.add('outside_document_directory');
        const size=Buffer.byteLength(url.href);
        // ponytail: bounded retained observations until the crawl frontier can spool validated entries.
        if(retainedBytes+size>sitemapLimits.retainedUrlBytes){counts.omitted++;reasons.add('retained_url_limit');}
        else {entries.push({url:url.href});retainedBytes+=size;}
      }
      entry=null;
    }
    depth--;
  });
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try {
    // Iterator errors are deliberately indistinguishable from other incomplete input to callers.
    failure='input_error';
    for(const chunk of input.chunks){
      if(!(chunk instanceof Uint8Array))stop('invalid_chunk');
      if(chunk.byteLength>sitemapLimits.bytes-bytesRead)stop('body_limit');
      for(let offset=0;offset<chunk.byteLength;offset+=sitemapLimits.writeBytes){
        const slice=chunk.subarray(offset,offset+sitemapLimits.writeBytes);bytesRead+=slice.byteLength;
        failure='invalid_utf8';const value=decoder.decode(slice,{stream:true});
        failure='invalid_xml';parser.write(value);
      }
      failure='input_error';
    }
    failure='invalid_utf8';const tail=decoder.decode();
    failure='invalid_xml';parser.write(tail).close();
    return {status:reasons.size?'partial':'complete',reasons:[...reasons],kind,entries,counts,bytesRead,entriesComplete:counts.omitted===0&&counts.invalid===0&&!reasons.has('invalid_structure')};
  }catch{return unavailable(failure);}
}
