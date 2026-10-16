import assert from 'node:assert/strict';
import test from 'node:test';
import {parseHostedBoardShare,scrubMalformedHostedBoardShareFragment} from '../src/lib/boards.ts';
test('Hosted board capabilities are canonical fragments only; malformed URL channels never yield a read credential',()=>{
 const path='/share/boards/quarterly-board-45000000-0000-4000-8000-000000000001',token='A'.repeat(43),expected={shareId:'45000000-0000-4000-8000-000000000001',token};
 assert.deepEqual(parseHostedBoardShare(path,'','#'+token),expected);
 assert.deepEqual(parseHostedBoardShare(path,'',token),expected);
 for(const fragment of ['',token+'=',token.slice(1),'#'+token+'x','%41'.repeat(43),'A'.repeat(42)+'B',token+'\n'])assert.equal(parseHostedBoardShare(path,'',fragment),null);
 for(const search of ['?token='+token,'?','?view=board-share'])assert.equal(parseHostedBoardShare(path,search,'#'+token),null);
 for(const invalid of [path+'/',path+'/read',path.replace('/boards/','/'),path.replace('quarterly-board','%71uarterly'),path.replace('45000000','not-an-id'),path.replace('quarterly-board','-board')])assert.equal(parseHostedBoardShare(invalid,'','#'+token),null);
});
test('Hosted board preflight discards only invalid raw fragments before router canonicalization without retaining tokens',()=>{
 const pathname='/share/boards/quarterly-board-45000000-0000-4000-8000-000000000001',token='A'.repeat(43),state={unchanged:'entry'},calls:Array<{state:unknown;url:string|URL|null|undefined}>=[];
 const history={state,replaceState:(value:unknown,unused:string,url?:string|URL|null)=>{assert.equal(unused,'');calls.push({state:value,url});}};
 for(const hash of ['#'+token,''])scrubMalformedHostedBoardShareFragment({pathname,search:'',hash},history);
 for(const path of ['/','/account','/share/tracked','/share/boards'])scrubMalformedHostedBoardShareFragment({pathname:path,search:'',hash:'#%41'},history);
 assert.equal(calls.length,0);
 for(const hash of ['#'+'%41'.repeat(43),'#'+token+'=','#'+'A'.repeat(42)+'B','#%GG','#invalid']){
  scrubMalformedHostedBoardShareFragment({pathname,search:'',hash},history);
  assert.equal(calls.at(-1)!.state,state);assert.equal(calls.at(-1)!.url,pathname);
 }
 assert.equal(calls.length,5);
 scrubMalformedHostedBoardShareFragment({pathname,search:'?not-allowed=1',hash:'#'+token},history);
 assert.equal(calls.length,6);assert.equal(calls.at(-1)!.state,state);assert.equal(calls.at(-1)!.url,pathname+'?not-allowed=1');
});
