import {analyzeCrawlPage,type CrawlPageInput} from './crawl-analysis.ts';

// One request per child. The supervisor owns the wall-clock deadline and process lifetime.
const inputLimit=7*1024*1024;
let bytes=0;
const chunks:Buffer[]=[];
try {
  for await(const chunk of process.stdin){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;
    if(bytes>inputLimit){process.stdin.destroy();throw new TypeError();}chunks.push(buffer);
  }
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError();
  const analysis=analyzeCrawlPage(value as CrawlPageInput);
  process.stdout.write(JSON.stringify({status:'ok',analysis}));
}catch(error){
  if(error instanceof TypeError||error instanceof SyntaxError)process.stdout.write('{"status":"invalid_input"}');
  else process.exitCode=1;
}
