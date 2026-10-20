import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {BoardsPanel,BoardShareManager} from '../src/components/BoardsPanel';
import type {BoardItem,BoardRole} from '../src/lib/boards';
import {ApiError} from '../src/lib/api';
import '../src/styles.css';
const w='46000000-0000-4000-8000-000000000001',u='46000000-0000-4000-8000-000000000002',a='46000000-0000-4000-8000-000000000003',card='46000000-0000-4000-8000-000000000005';
const scope='from=2026-10-01&to=2026-10-01&timeZone=UTC';
// Explicit synthetic decoded-body seam: an actual fulfilled Response reader has reached done;
// hold only its completed read before the existing component decoder/publication. No backend proof.
let holdNext=false,decodedHeld=false,releaseAtUnauthorized=false,releaseDecoded:(()=>void)|null=null;
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const response=await nativeFetch(input,init);
 if(!holdNext||init?.method!=='POST'||!String(input).endsWith('/shares')||!response.body)return response;
 holdNext=false;
 return new Proxy(response,{get(target,key){
  if(key==='body')return{getReader(){const reader=target.body!.getReader();return{async read(){const part=await reader.read();if(part.done){decodedHeld=true;await new Promise<void>(resolve=>{releaseDecoded=resolve;});decodedHeld=false;releaseDecoded=null;}return part;},cancel(reason?:unknown){return reader.cancel(reason);}};}};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
};
function Fixture(){
 const[state,setState]=React.useState({id:a,user:u,role:'owner' as BoardRole,enabled:true,revision:3,owner:1}),[denied,setDenied]=React.useState(0),accessEpoch=React.useRef(0);
 const item:BoardItem={id:state.id,workspaceId:w,revision:state.revision,definition:{schemaVersion:1,name:state.id===a?'Board A':'Board B',description:'Synthetic source fixture',defaultEntity:null,scope,rows:[{id:'46000000-0000-4000-8000-000000000006',minHeight:150,cards:[{id:card,type:'TextBlock',text:'Private saved note'}]}]},createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
 window.boardShareOwnerFixture={set:patch=>setState(old=>({...old,...patch,owner:old.owner+1})),holdAck:(releaseOnUnauthorized=false)=>{holdNext=true;releaseAtUnauthorized=releaseOnUnauthorized;},heldAck:()=>decodedHeld,releaseAck:()=>releaseDecoded?.()};
 if(new URLSearchParams(location.search).has('parent'))return <main className="stack"><p data-fixture-ready>Actual BoardsPanel parent · synthetic API and decoded seam</p><output data-denied>{denied}</output><BoardsPanel workspaceId={w} userId={state.user} projects={[]} query={'board='+state.id} readOwner={String(state.owner)} readEnabled={state.enabled} onNavigate={query=>setState(old=>({...old,id:new URLSearchParams(query).get('board')??old.id,owner:old.owner+1}))} onUnauthorized={()=>{setDenied(n=>n+1);if(releaseAtUnauthorized)releaseDecoded?.();}}/></main>;
 return <main className="stack"><p data-fixture-ready>Actual owner component · synthetic API</p><output data-denied>{denied}</output><h2>{item.definition.name}</h2><section className="boards-panel stack"><BoardShareManager key={state.user} accessEpoch={accessEpoch} workspaceId={w} userId={state.user} item={item} currentRole={state.role} owner={String(state.owner)} enabled={state.enabled} onRole={role=>setState(old=>({...old,role}))} onAccessLoss={cause=>{if(cause instanceof ApiError&&[401,403,404].includes(cause.status))accessEpoch.current++;setDenied(n=>n+1);}}/></section></main>;
}
declare global{interface Window{boardShareOwnerFixture:{set:(patch:Partial<{id:string;user:string;role:BoardRole;enabled:boolean;revision:number}>)=>void;holdAck:(releaseOnUnauthorized?:boolean)=>void;heldAck:()=>boolean;releaseAck:()=>void}}}
const parentRouter=createRouter({routeTree:createRootRoute({component:Fixture})});
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('parent')?<RouterProvider router={parentRouter}/>:<Fixture/>);
