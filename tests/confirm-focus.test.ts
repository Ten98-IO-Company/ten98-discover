import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

// Since @ten98/ui 0.38.0 a non-danger confirm opens focused on Confirm, so a held or repeated Enter on the control that
// opened it can confirm it. Every confirm in the app must therefore be danger (which opens on Cancel) or say where focus
// starts. This walks the parsed source, so multi-line option objects and new call sites are covered, not just a grep.
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
const isTrue=(node:Node|undefined)=>node?.type==='Literal'&&node.value===true;
const line=(code:string,node:Node)=>code.slice(0,node.start as number).split('\n').length;

async function confirmSites(){
 const files=(await readdir('src',{recursive:true})).map(name=>'src/'+name.replaceAll('\\','/')).filter(name=>name.endsWith('.tsx')||name.endsWith('.ts'));
 const unguarded:string[]=[];let hooks=0,options=0,dialogs=0;
 for(const file of files){
  const code=await readFile(file,'utf8');
  if(!/useConfirmDialog|ConfirmDialog/.test(code))continue;
  walk(parseAst(code,{lang:'tsx'}),node=>{
   if(node.type==='CallExpression'&&(node.callee as Node).type==='Identifier'&&(node.callee as Node).name==='useConfirmDialog'){
    hooks++;const [config]=node.arguments as Node[];
    if(!config||config.type!=='ObjectExpression'||!(isTrue(property(config,'danger')?.value as Node)||property(config,'initialFocus')))unguarded.push(`${file}:${line(code,node)} useConfirmDialog without danger:true or initialFocus`);
   }else if(node.type==='ObjectExpression'&&property(node,'danger')){
    options++;const danger=property(node,'danger')!.value as Node;
    if(!isTrue(danger)&&!property(node,'initialFocus'))unguarded.push(`${file}:${line(code,node)} danger is not true and initialFocus is missing`);
   }else if(node.type==='JSXOpeningElement'&&(node.name as Node).type==='JSXIdentifier'&&(node.name as Node).name==='ConfirmDialog'){
    dialogs++;const attributes=(node.attributes as Node[]).filter(item=>item.type==='JSXAttribute');
    const named=(name:string)=>attributes.find(item=>(item.name as Node).name===name);
    const danger=named('danger');const dangerTrue=danger&&(danger.value===null||isTrue(((danger.value as Node)?.expression) as Node));
    if(!dangerTrue&&!named('initialFocus'))unguarded.push(`${file}:${line(code,node)} <ConfirmDialog> without danger or initialFocus`);
   }
  });
 }
 return {unguarded,hooks,options,dialogs};
}

test('every confirm is danger or declares where focus starts',async()=>{
 const {unguarded,hooks,options}=await confirmSites();
 assert.ok(hooks>=30,'the scan finds the app confirm hooks ('+hooks+')');
 assert.ok(options>=9,'the scan finds per-call danger options ('+options+')');
 assert.deepEqual(unguarded,[]);
});
