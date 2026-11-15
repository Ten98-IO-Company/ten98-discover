import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

// @ten98/ui starts every confirm on Cancel since 0.39.1 (a typed or checkbox confirm starts on its field), so a held or
// repeated Enter on the control that opened the dialog cannot confirm it. Only `initialFocus: 'confirm'` undoes that; it is
// meant for flows where Enter accepts, such as voucher entry. Every Discover confirm guards a destructive, publishing or paid
// action or discards edits, so none may start on Confirm. This walks the parsed source, so multi-line option objects and new
// call sites are covered, not just a grep.
const require=createRequire(resolve('package.json'));
const {parseAst}=createRequire(require.resolve('vite/package.json'))('rolldown/parseAst') as {parseAst:(code:string,options:{lang:'tsx'})=>unknown};

type Node={type:string;[key:string]:unknown};
const isNode=(value:unknown):value is Node=>!!value&&typeof value==='object'&&typeof (value as Node).type==='string';
function walk(node:unknown,visit:(node:Node)=>void){
 if(Array.isArray(node)){for(const item of node)walk(item,visit);return;}
 if(!isNode(node))return;
 visit(node);
 for(const value of Object.values(node))if(value&&typeof value==='object')walk(value,visit);
}
const keyName=(property:Node)=>{const key=property.key as Node|undefined;return key?.type==='Identifier'?key.name as string:key?.type==='Literal'?String(key.value):undefined;};
const property=(object:Node,name:string)=>(object.properties as Node[]).find(item=>item.type==='Property'&&keyName(item)===name);
const stringValue=(node:Node|undefined):unknown=>node?.type==='JSXExpressionContainer'?stringValue(node.expression as Node):node?.type==='Literal'?node.value:undefined;
const line=(code:string,node:Node)=>code.slice(0,node.start as number).split('\n').length;

// Every option object and <ConfirmDialog> whose initialFocus is anything but the literal 'cancel' (the default), and the number of confirm hooks seen.
function focusPins(code:string,file:string){
 const pins:string[]=[];let hooks=0;
 walk(parseAst(code,{lang:'tsx'}),node=>{
  if(node.type==='CallExpression'&&(node.callee as Node).type==='Identifier'&&(node.callee as Node).name==='useConfirmDialog')hooks++;
  else if(node.type==='ObjectExpression'){
   const pin=property(node,'initialFocus');
   if(pin&&stringValue(pin.value as Node)!=='cancel')pins.push(`${file}:${line(code,pin)} initialFocus is not cancel`);
  }else if(node.type==='JSXOpeningElement'&&(node.name as Node).type==='JSXIdentifier'&&(node.name as Node).name==='ConfirmDialog'){
   const pin=(node.attributes as Node[]).find(item=>item.type==='JSXAttribute'&&(item.name as Node).name==='initialFocus');
   if(pin&&stringValue(pin.value as Node)!=='cancel')pins.push(`${file}:${line(code,pin)} <ConfirmDialog> initialFocus is not cancel`);
  }
 });
 return {pins,hooks};
}

test('no confirm in the app starts focus on Confirm',async()=>{
 const files=(await readdir('src',{recursive:true})).map(name=>'src/'+name.replaceAll('\\','/')).filter(name=>name.endsWith('.tsx')||name.endsWith('.ts'));
 const pins:string[]=[];let hooks=0;
 for(const file of files){
  const code=await readFile(file,'utf8');
  if(!/useConfirmDialog|ConfirmDialog/.test(code))continue;
  const found=focusPins(code,file);pins.push(...found.pins);hooks+=found.hooks;
 }
 assert.ok(hooks>=30,'the scan finds the app confirm hooks ('+hooks+')');
 assert.deepEqual(pins,[]);
});

test('the scan flags a confirm that starts on Confirm and accepts the default and Cancel',()=>{
 const flagged=focusPins(`async function offenders(){
  const [confirm]=useConfirmDialog({danger:true,initialFocus:'confirm'});
  await confirm({title:'t',description:'d',
    initialFocus:'confirm'});
  await confirm({title:'t',description:'d',initialFocus:focus});
  return <ConfirmDialog initialFocus="confirm" open title="t" description="d" onConfirm={run} onOpenChange={close}/>;
 }`,'inline.tsx');
 assert.equal(flagged.hooks,1);
 assert.deepEqual(flagged.pins.map(pin=>pin.split(' ')[0]),['inline.tsx:2','inline.tsx:4','inline.tsx:5','inline.tsx:6'],'the hook default, the multi-line option, the dynamic option and the dialog prop');
 assert.deepEqual(focusPins(`async function allowed(){
  await confirm({title:'t',description:'d'});
  await confirm({title:'t',description:'d',initialFocus:'cancel'});
  return <ConfirmDialog initialFocus="cancel" open title="t" description="d" onConfirm={run} onOpenChange={close}/>;
 }`,'inline.tsx').pins,[]);
});
