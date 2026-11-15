import assert from 'node:assert/strict';
import test from 'node:test';
import {readdir,readFile} from 'node:fs/promises';
import {csvCell as runtimeCsvCell} from '@ten98/runtime';
import {csvCell} from '../src/server/explorer-input.ts';

// Discover's CSV exports use the maintained @ten98/runtime csvCell. The server adapter only chooses the text for
// missing cells, and no source module doubles quotes for CSV on its own.
test('the server csvCell is the runtime csvCell with Unavailable for missing cells',()=>{
 const values=[null,undefined,'','plain','a,"b"\nc','=1+1','+1','-1','@SUM(A1)','\t=1','\r=1','\n=1',' \t=1','\ufeff=1','\u00a0@x',0,-0,12.5,10n,false,['=1',null],{key:'=1'}];
 for(const [index,value]of values.entries())assert.equal(csvCell(value),runtimeCsvCell(value,{missing:'Unavailable'}),'value '+index);
});

test('no source module carries its own CSV quote doubling',async()=>{
 const doubling=/\.replace(?:All)?\(\s*(?:\/"\/g|'"'|"\\"")\s*,\s*(?:'""'|"\\"\\"")\s*\)/u;
 const names=(await readdir('src',{recursive:true})).map(name=>name.replaceAll('\\','/')).filter(name=>/\.tsx?$/u.test(name));
 const sources=await Promise.all(names.map(name=>readFile('src/'+name,'utf8')));
 // Quoting a SQL identifier doubles quotes too; it is not a CSV cell.
 const copies=names.filter((name,index)=>doubling.test(sources[index])&&name!=='server/account-closure-retention.ts');
 assert.deepEqual(copies,[],'Use the @ten98/runtime csvCell or toCsv for CSV text.');
});

test('browser CSV downloads import the runtime helper from its Node-free entry',async()=>{
 for(const file of ['components/AnalyticsPanel.tsx','components/GeographyCard.tsx','lib/ai-search-analysis-csv.ts'])
  assert.match(await readFile('src/'+file,'utf8'),/import\s*\{[^}]*\b(?:toCsv|csvCell)\b[^}]*\}\s*from\s*'@ten98\/runtime\/browser'/u,file);
});
