import assert from 'node:assert/strict';
import test from 'node:test';
import {trackedAssetInput,trackedShareInput} from '../src/lib/tracked-assets.ts';
import {trackedDestination,trackedParams,trackedReportQuery,trackedRequestRefused,trackedHttpResponse,trackedPixelBytes} from '../src/server/tracked-assets.ts';

const collection={enabled:false,captureReferrer:false,captureGeography:false,excludeBots:true};
test('closed asset and share DTOs keep kind, explicit HTTP measurement and sections separate',()=>{
 assert.equal(trackedAssetInput.parse({kind:'pixel',name:'Image',active:true,collection}).collection.enabled,false);
 for(const value of [{kind:'pixel',name:'Image',active:true,collection,destination:'https://example.com'},{kind:'link',name:'Link',active:true,collection},{kind:'pixel',name:'Image',active:true,collection:{...collection,consent:true}},{kind:'pixel',name:'\ud800',active:true,collection}])assert.equal(trackedAssetInput.safeParse(value).success,false);
 const share={requestId:'43a53aef-48a2-4b5e-904c-6603eb3acff0',assetRevision:1,label:'Summary',scope:'from=2026-01-01&to=2026-01-02&timeZone=UTC',sections:['summary'],expiresAt:'2026-12-01T00:00:00Z',token:'A'.repeat(43)};
 assert.equal(trackedShareInput.safeParse(share).success,true);for(const sections of [['summary','summary'],['sessions'],[]])assert.equal(trackedShareInput.safeParse({...share,sections}).success,false);
});
test('HTTPS destinations reject credential, control, malformed wire, private hosts and direct loops before URL normalization',()=>{
 assert.equal(trackedDestination('https://EXAMPLE.com/a?literal=%25#section','https://app.example.com'),'https://example.com/a?literal=%25#section');
 assert.equal(trackedDestination('https://example.com/%EF%BF%BD','https://app.example.com'),'https://example.com/%EF%BF%BD');
 for(const value of ['http://example.com','javascript:alert(1)','https://a:b@example.com','https://example.com/a\n','https://example.com/%GG','https://example.com/%ED%A0%80','https://example.com/%0d%0aLocation:x','https://127.0.0.1','https://localhost','https://service.internal','https://app.example.com/api/track/link/key','https://app.example.com./api/track/link/key','https://example.com\\@evil.com','https://example.com/'+'é'.repeat(400)])assert.throws(()=>trackedDestination(value,'https://app.example.com'));
});
test('strict raw scopes preserve valid literals, typed locations and explicit missing without widening website filters',()=>{
 const scope='from=2026-01-01&to=2026-01-02&timeZone=UTC';
 assert.equal(trackedReportQuery(scope+'&referrerMissing=1&dimension=channel').filters.referrerMissing,'1');
 assert.equal(trackedReportQuery(scope+'&referrer=REFERRER.EXAMPLE.COM').filters.referrer,'referrer.example.com');
 assert.equal(trackedParams('value=%EF%BF%BD').get('value'),'�');
 assert.equal(trackedParams('referrer=%25').get('referrer'),'%');
 for(const suffix of ['&referrer=%','&referrer=%GG','&referrer=%ED%A0%80','&referrer=127.0.0.1','&referrer=https%3A%2F%2Fexample.com%2Fprivate%3Fsecret','&from=2026-01-01','&path=%2Fprivate','&propertyKey=secret','&channel=paidAds','&referrerMissing=1&referrer=x','&dimension=hostname','&limit=101'])assert.throws(()=>trackedReportQuery(scope+suffix));
 const country=JSON.stringify({state:'known',country:'DE'});assert.equal(trackedReportQuery(scope+'&country='+encodeURIComponent(country)).filters.country,country);
});
test('privacy refusals and fixed GET/HEAD response bytes do not claim consent or email opens',async()=>{
 const refusedHeaders:Record<string,string>[]=[{dnt:'1'},{'sec-gpc':'1'},{purpose:'prefetch'},{'sec-purpose':'prefetch;prerender'},{'user-agent':'Example crawler'}];for(const headers of refusedHeaders)assert.equal(trackedRequestRefused(new Request('https://app.example.com',{headers}),true),true);
 assert.equal(trackedRequestRefused(new Request('https://app.example.com',{'headers':{'user-agent':'Example browser'}}),true),false);
 const names=['ANALYTICS_NETWORK_MODE','ANALYTICS_EXCLUDED_IPS'] as const,saved=names.map(name=>process.env[name]);
 try{process.env.ANALYTICS_NETWORK_MODE='direct';process.env.ANALYTICS_EXCLUDED_IPS='203.0.113.0/24';
  assert.equal(trackedRequestRefused(new Request('https://app.example.com'),false,'203.0.113.9'),true);assert.equal(trackedRequestRefused(new Request('https://app.example.com'),false,'198.51.100.7'),false);assert.equal(trackedRequestRefused(new Request('https://app.example.com'),false),false,'A plain request has no peer and is never excluded.');
 }finally{names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});}
 const pixel=trackedHttpResponse('pixel',null),body=Buffer.from(await pixel.arrayBuffer());assert.deepEqual(body,trackedPixelBytes);assert.equal(body.toString('ascii',0,6),'GIF89a');assert.equal(body.readUInt16LE(6),1);assert.equal(body.readUInt16LE(8),1);assert.equal(pixel.headers.get('cache-control'),'no-store');assert.equal(pixel.headers.has('set-cookie'),false);assert.equal(pixel.headers.get('cross-origin-resource-policy'),'cross-origin');
 assert.equal((await trackedHttpResponse('pixel',null,true).arrayBuffer()).byteLength,0);const link=trackedHttpResponse('link','https://example.com/saved');assert.equal(link.status,302);assert.equal(link.headers.get('location'),'https://example.com/saved');assert.equal(await link.text(),'');assert.equal(link.headers.get('referrer-policy'),'no-referrer');
});
