import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parseSitemap,sitemapLimits} from '../src/server/crawl-sitemap.ts';

const ns='http://www.sitemaps.org/schemas/sitemap/0.9',documentUrl='https://example.test/sitemap.xml';
const begin=`<urlset xmlns="${ns}">`,end='</urlset>';
const record=(url:string)=>`<url><loc>${url}</loc></url>`;
const parse=(xml:string,url=documentUrl)=>parseSitemap({documentUrl:url,chunks:[Buffer.from(xml)]});
const unavailable=(result:ReturnType<typeof parse>,reason:string)=>{
  assert.equal(result.status,'unavailable');assert.deepEqual(result.reasons,[reason]);
  assert.equal(result.kind,null);assert.equal(result.entriesComplete,false);assert.deepEqual(result.entries,[]);
  assert.deepEqual(result.counts,{seen:0,accepted:0,invalid:0,omitted:0,foreignOrigin:0});
};

// Hostile/large input never runs in the test coordinator. Also remove inherited Node preload/options.
function probe(name:string){
  const result=spawnSync(process.execPath,['--max-old-space-size=256',fileURLToPath(import.meta.url),'--sitemap-probe',name],{
    timeout:15_000,maxBuffer:16_384,windowsHide:true,env:{SystemRoot:process.env.SystemRoot??'',PATH:process.env.PATH??'',TEMP:process.env.TEMP??''},encoding:'utf8',
  });
  assert.equal(result.error,undefined,`contained probe ${name} exceeded its process limit`);
  assert.equal(result.status,0,`contained probe ${name} failed (signal ${result.signal??'none'})`);
  return JSON.parse(result.stdout) as {status:string;reasons:string[];bytesRead:number;retained:number;counts:{seen:number;accepted:number;invalid:number;omitted:number;foreignOrigin:number};entriesComplete:boolean;elapsedMs:number;maxRssKiB:number};
}

if(process.argv[2]==='--sitemap-probe'){
  const name=process.argv[3];
  function* chunks():Generator<Uint8Array>{
    const emit=(text:string)=>Buffer.from(text);
    if(name==='body-exact'||name==='body-over'){
      yield emit(begin+record('https://example.test/'));
      let left=sitemapLimits.bytes-Buffer.byteLength(begin+record('https://example.test/')+end)+(name==='body-over'?1:0);
      const comment='<!--'+'x'.repeat(1000)+'-->';
      while(left>=comment.length){yield emit(comment);left-=comment.length;}
      yield emit(' '.repeat(left));yield emit(end);return;
    }
    if(['unfinished-comment','unfinished-attribute','unfinished-doctype','unfinished-text','unfinished-cdata','unfinished-name'].includes(name)){
      yield emit(name==='unfinished-comment'?begin+'<!--':name==='unfinished-attribute'?begin+'<x a="':name==='unfinished-doctype'?'<!DOCTYPE urlset [':name==='unfinished-cdata'?begin+'<![CDATA[':name==='unfinished-name'?begin+'<':begin+'<url><loc>');
      const part=emit('x'.repeat(16384));for(let n=0;n<1024;n++)yield part;return;
    }
    if(name==='huge-attribute'){
      yield emit(begin+'<x a="');const part=emit('x'.repeat(16384));for(let n=0;n<1024;n++)yield part;yield emit('"/>'+end);return;
    }
    yield emit(begin);
    if(name==='entries-exact'||name==='entries-over'){
      for(let n=0;n<sitemapLimits.entries+(name==='entries-over'?1:0);n++)yield emit(record('https://example.test/'));
    }else if(name==='retained-limit'||name==='retained-invalid-tail'){
      // Each serialized URL is exactly1024bytes:8192 fit, then accepted observations are omitted.
      for(let n=0;n<8194;n++)yield emit(record('https://example.test/'+ 'a'.repeat(1024-21)));
    }else if(name==='element-limit'){
      yield emit(record('https://example.test/'));for(let n=0;n<sitemapLimits.elements;n++)yield emit('<x xmlns="urn:extension"/>');
    }else if(name==='depth-exact')yield emit('<e:x xmlns:e="urn:extension">'.repeat(31)+'</e:x>'.repeat(31));
    else if(name==='attributes-exact')yield emit('<x xmlns="urn:extension" '+Array.from({length:31},(_,i)=>`a${i}="v"`).join(' ')+'/>');
    else if(name==='attribute-value-exact')yield emit('<x xmlns="urn:extension" a="'+'x'.repeat(8192)+'"/>');
    else if(name==='name-exact')yield emit('<'+'x'.repeat(256)+' xmlns="urn:extension"/>');
    else if(name==='depth')yield emit('<x>'.repeat(32)+'</x>'.repeat(32));
    else if(name==='attributes')yield emit('<x '+Array.from({length:33},(_,i)=>`a${i}="v"`).join(' ')+'/>');
    else if(name==='attribute-value')yield emit('<x a="'+'x'.repeat(8193)+'"/>');
    else if(name==='name')yield emit('<'+'x'.repeat(257)+'/>');
    else if(name==='recursive-entity'){yield emit('<!DOCTYPE urlset [<!ENTITY x "&x;">]><url><loc>&x;</loc></url>');}
    else throw new Error('Unknown test probe');
    yield emit(name==='retained-invalid-tail'?'</broken>':end);
  }
  const started=performance.now(),result=parseSitemap({documentUrl,chunks:chunks()});
  process.stdout.write(JSON.stringify({status:result.status,reasons:result.reasons,counts:result.counts,retained:result.entries.length,bytesRead:result.bytesRead,entriesComplete:result.entriesComplete,elapsedMs:Math.round(performance.now()-started),maxRssKiB:process.resourceUsage().maxRSS}));
}else{
  test('sitemap namespace, entities, UTF-8 and CDATA survive byte-at-a-time decoding',()=>{
    const xml=`<?xml version="1.0" encoding="UTF-8"?><s:urlset xmlns:s="${ns}"><s:url><s:loc>https://example.test/café?q=a&amp;b=&#x1F41F;<![CDATA[&c=3]]></s:loc></s:url></s:urlset>`;
    const expected=parse(xml),bytes=Buffer.from('\uFEFF'+xml);
    const split=parseSitemap({documentUrl,chunks:Array.from(bytes,b=>Uint8Array.of(b))});
    assert.equal(expected.status,'complete');assert.equal(split.status,'complete');assert.deepEqual(split.entries,expected.entries);
    assert.deepEqual(expected.entries,[{url:'https://example.test/caf%C3%A9?q=a&b=%F0%9F%90%9F&c=3'}]);
    assert.equal(expected.entriesComplete,true);assert.equal(expected.counts.accepted,1);
  });
  test('sitemap indexes observe targets; extension namespaces cannot inject locs',()=>{
    const result=parse(`<sitemapindex xmlns="${ns}" xmlns:e="urn:extension"><e:sitemap><loc>https://evil.test/</loc></e:sitemap><sitemap><e:loc>https://evil.test/</e:loc><loc>https://example.test/one.xml</loc><lastmod>not a freshness guarantee</lastmod></sitemap></sitemapindex>`);
    assert.equal(result.kind,'sitemapindex');assert.deepEqual(result.entries,[{url:'https://example.test/one.xml'}]);assert.equal(result.counts.seen,1);
    const rebound=parse(`${begin}<url><loc xmlns="urn:extension">https://evil.test/</loc></url>${end}`);
    assert.equal(rebound.status,'partial');assert.equal(rebound.counts.invalid,1);assert.deepEqual(rebound.entries,[]);
    unavailable(parse('<urlset><url><loc>https://example.test/</loc></url></urlset>'),'unsupported_format');
    unavailable(parse('<feed xmlns="http://www.w3.org/2005/Atom"/>'),'unsupported_format');
  });
  test('only one direct loc contributes; missing, duplicate, nested and malformed URLs are counted',()=>{
    const cases=['<url/>','<url><loc>https://example.test/</loc><loc>https://example.test/a</loc></url>','<url><x><loc>https://example.test/</loc></x></url>','<url><loc>https://example.test/<x/>tail</loc></url>',...['/relative','file:///etc/passwd','data:text/plain,hi','https://user:pass@example.test/','https://@example.test/','https://example.test/a#fragment','https://example.test/a\\b','https://example.test/a%GG','https://example.test/a&#xA;b','https://example.test/a b','\u00a0https://example.test/a'].map(record)];
    const result=parse(begin+cases.join('')+record(' \t\nhttps://example.test/good\r\n ')+end);
    assert.equal(result.status,'partial');assert.equal(result.counts.invalid,cases.length);assert.deepEqual(result.entries,[{url:'https://example.test/good'}]);assert.equal(result.entriesComplete,false);
  });
  test('document URL is a bounded exact HTTP(S) observation, never a relative base or credential carrier',()=>{
    for(const url of ['//example.test/map.xml','https://@example.test/map.xml','https://example.test/map.xml#','https://example.test/\uD800','https://example.test/'+ 'a'.repeat(2048)])unavailable(parse(begin+end,url),'invalid_document_url');
  });
  test('foreign origins and URLs above the document directory are explicit partial observations',()=>{
    const result=parse(begin+record('https://example.test/other')+record('https://cdn.example.test/a')+record('http://example.test/a')+record('https://example.test/catalog/a')+end,'https://example.test/catalog/map.xml');
    assert.equal(result.status,'partial');assert.deepEqual(new Set(result.reasons),new Set(['outside_document_directory','foreign_origin']));assert.equal(result.counts.foreignOrigin,2);assert.equal(result.counts.accepted,4);assert.equal(result.entries.length,4);assert.equal(result.entriesComplete,true);
  });
  test('only XML whitespace is ignorable structural text; Unicode spaces cannot claim complete coverage',()=>{
    assert.equal(parse(begin+' \t\r\n'+record('https://example.test/')+end).status,'complete');
    for(const whitespace of ['\u00a0','\u2003','\uFEFF']){
      for(const body of [whitespace+record('https://example.test/'),`<url>${whitespace}<loc>https://example.test/</loc></url>`]){
        const result=parse(begin+body+end);assert.equal(result.status,'partial');assert.deepEqual(result.reasons,['invalid_structure']);
        assert.equal(result.entriesComplete,false);assert.deepEqual(result.entries,[{url:'https://example.test/'}]);
      }
    }
  });
  test('late parse, DTD, entity, declaration and UTF-8 failures discard every earlier observation',()=>{
    unavailable(parse(begin+record('https://example.test/')+'</broken>'),'invalid_xml');
    for(const dtd of ['<!DOCTYPE urlset>','<!DOCTYPE urlset SYSTEM "file:///secret">','<!DOCTYPE urlset [<!ENTITY x SYSTEM "https://example.test/no-request">]>'])unavailable(parse(dtd+begin+end),'doctype_forbidden');
    unavailable(parse(begin+record('https://example.test/&undefined;')+end),'invalid_xml');
    unavailable(parse(begin+record('https://example.test/&#0;')+end),'invalid_xml');
    for(const declaration of ['<?xml version="1.1"?>','<?xml version="1.0" encoding="ISO-8859-1"?>'])unavailable(parse(declaration+begin+end),'unsupported_xml_declaration');
    for(const tail of [[0xc3],[0xff],[0xed,0xa0,0x80]])unavailable(parseSitemap({documentUrl,chunks:[Buffer.from(begin+record('https://example.test/')),Uint8Array.from(tail)]}),'invalid_utf8');
  });
  test('failed or ill-typed input iteration never leaks a valid prefix',()=>{
    function* broken(){yield Buffer.from(begin+record('https://example.test/'));throw new Error('private diagnostic');}
    unavailable(parseSitemap({documentUrl,chunks:broken()}),'input_error');
    unavailable(parseSitemap({documentUrl,chunks:['not bytes' as unknown as Uint8Array]}),'invalid_chunk');
  });
  test('loc character and UTF-8 URL byte limits do not truncate or normalize into an accepted prefix',()=>{
    const prefix='https://example.test/';
    const result=parse(begin+record(prefix+'x'.repeat(2047-prefix.length))+record(prefix+'x'.repeat(2048-prefix.length))+record(prefix+'é'.repeat(700))+end);
    assert.equal(result.status,'partial');assert.equal(result.counts.accepted,1);assert.equal(result.counts.invalid,2);assert.equal(result.entries[0].url.length,2047);
  });
  test('contained format boundaries accept 50 MiB and 50,000 entries, then fail closed',t=>{
    const bytes=probe('body-exact'),entries=probe('entries-exact');
    assert.equal(bytes.status,'complete');assert.equal(bytes.bytesRead,sitemapLimits.bytes);assert.equal(bytes.retained,1);
    assert.equal(entries.status,'complete');assert.equal(entries.counts.seen,50_000);assert.equal(entries.retained,50_000);
    for(const [name,reason] of [['body-over','body_limit'],['entries-over','entry_limit']]){const result=probe(name);assert.equal(result.status,'unavailable');assert.deepEqual(result.reasons,[reason]);assert.equal(result.retained,0);assert.equal(result.counts.seen,0);}
    t.diagnostic(`50 MiB: ${bytes.elapsedMs} ms / ${bytes.maxRssKiB} KiB maxRSS; 50,000 entries: ${entries.elapsedMs} ms / ${entries.maxRssKiB} KiB maxRSS (local fixture, not a capacity guarantee).`);
  });
  test('contained retained-output ceiling is partial, and even a later invalid tail clears it',()=>{
    const result=probe('retained-limit');assert.equal(result.status,'partial');assert.deepEqual(result.reasons,['retained_url_limit']);assert.equal(result.retained,8192);assert.equal(result.counts.accepted,8194);assert.equal(result.counts.omitted,2);assert.equal(result.entriesComplete,false);
    const tail=probe('retained-invalid-tail');assert.equal(tail.status,'unavailable');assert.equal(tail.retained,0);assert.equal(tail.counts.accepted,0);
  });
  test('contained extension resource bounds and hostile unfinished XML never publish entries',()=>{
    for(const name of ['depth-exact','attributes-exact','attribute-value-exact','name-exact'])assert.equal(probe(name).status,'complete',name);
    const cases=[['depth','depth_limit'],['attributes','attribute_limit'],['attribute-value','attribute_value_limit'],['name','name_limit'],['element-limit','element_limit'],['huge-attribute','attribute_value_limit'],['unfinished-comment','invalid_xml'],['unfinished-attribute','invalid_xml'],['unfinished-doctype','invalid_xml'],['unfinished-text','invalid_xml'],['unfinished-cdata','invalid_xml'],['unfinished-name','invalid_xml'],['recursive-entity','invalid_xml']];
    for(const [name,reason] of cases){const result=probe(name);assert.equal(result.status,'unavailable',name);assert.deepEqual(result.reasons,[reason],name);assert.equal(result.retained,0);}
  });
}
