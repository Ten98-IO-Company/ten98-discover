import {toUSVString} from 'node:util';
import {parseGoogleSearchQuery} from './citation-taxonomy.ts';

const controls=/[\u0000-\u001f\u007f-\u009f]/u;

function retainedHttps(raw:string):URL|null {
 if(typeof raw!=='string'||!raw||raw.length>2048||toUSVString(raw)!==raw||controls.test(raw)||raw.includes('\\')||raw.trim()!==raw)return null;
 try {
  const url=new URL(raw);
  return url.protocol==='https:'&&!url.username&&!url.password?url:null;
 } catch {return null;}
}

/** Extracts a community from the actual Reddit pathname; never from query/fragment text. */
export function parseCitationRedditCommunity(retainedUrl:string):string|null {
 const url=retainedHttps(retainedUrl);if(!url)return null;
 const host=url.hostname.toLowerCase().replace(/\.$/u,'');
 if(host!=='reddit.com'&&!host.endsWith('.reddit.com'))return null;
 if(host.length>253||host.split('.').some(label=>!label||label.length>63||/[^a-z0-9-]/u.test(label)||label.startsWith('-')||label.endsWith('-')))return null;
 if(url.pathname.slice(0,3).toLowerCase()!=='/r/')return null;
 try {
  const community=decodeURIComponent(url.pathname.slice(3).split('/',1)[0]);
  return community.length>=1&&community.length<=64&&!/[^A-Za-z0-9_]/u.test(community)?community.toLowerCase():null;
 } catch {return null;}
}

/** Caller must first admit sourceType=google_search using the shared classifier.
 * This only validates the first form-decoded q component; it does not classify hosts.
 */
export function parseCitationSearchQuery(retainedUrl:string):string|null {
 const url=retainedHttps(retainedUrl);if(!url)return null;
 for(const component of url.search.slice(1).split('&')) {
  const separator=component.indexOf('='),key=separator<0?component:component.slice(0,separator);
  let decodedKey:string;
  try {decodedKey=decodeURIComponent(key.replace(/\+/g,' '));}catch{continue;}
  if(decodedKey!=='q')continue;
  try {
   const value=decodeURIComponent((separator<0?'':component.slice(separator+1)).replace(/\+/g,' '));
   if(controls.test(value))return null;
   return parseGoogleSearchQuery(retainedUrl);
  } catch {return null;}
 }
 return null;
}
