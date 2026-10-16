import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation} from '@tanstack/react-router';
import {SharedBoardRoute} from '../src/routes/share/boards/$slug';
import '../src/styles.css';
import {scrubMalformedHostedBoardShareFragment} from '../src/lib/boards';
// Diagnostics contain categories/counts/boolean comparisons only, never fragment, URL or history-key values.
type DiagnosticLocation={pathname:string;searchStr:string;hash:string;state:{__TSR_key?:string;key?:string}};
type EntryDiagnostic={stage:string;atMs:number;nativeHashLength:number;nativeHashCategory:string;nativeEntry:number;router:null|{pathMatches:boolean;searchMatches:boolean;hashLength:number;hashCategory:string;rawEqual:boolean;decodedEqual:boolean|null;entry:number};history:null|{pathMatches:boolean;searchMatches:boolean;hashLength:number;hashCategory:string;rawEqual:boolean;decodedEqual:boolean|null;entry:number}};
const events:EntryDiagnostic[]=[],keys:string[]=[];
let routerLocation:(()=>DiagnosticLocation)|null=null;
const strip=(value:string)=>value.startsWith('#')?value.slice(1):value;
const category=(value:string)=>{const raw=strip(value);return!raw?'empty':raw.includes('%')?'percent-encoded':/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(raw)?'canonical-base64url':/^[A-Za-z0-9_-]+$/.test(raw)?'noncanonical-base64url':'other';};
function keyId(state:{__TSR_key?:string;key?:string}|null){const key=state?.__TSR_key??state?.key;if(!key)return 0;let index=keys.indexOf(key);if(index<0){keys.push(key);index=keys.length-1;}return index+1;}
function record(stage:string,rendered?:DiagnosticLocation,history?:DiagnosticLocation){
 if(events.length>=64)return;
 const native=window.location,raw=strip(native.hash);
 const compare=(location:DiagnosticLocation|undefined|null)=>{if(!location)return null;const seen=strip(location.hash);let decodedEqual:boolean|null=null;try{decodedEqual=decodeURIComponent(raw)===seen;}catch{}return{pathMatches:native.pathname===location.pathname,searchMatches:native.search===location.searchStr,hashLength:seen.length,hashCategory:category(seen),rawEqual:raw===seen,decodedEqual,entry:keyId(location.state)};};
 events.push({stage,atMs:Math.round(performance.now()),nativeHashLength:raw.length,nativeHashCategory:category(raw),nativeEntry:keyId(window.history.state),router:compare(rendered??routerLocation?.()),history:compare(history)});
}
record('before-create-router');
function FixtureRoute(){const location=useLocation();React.useLayoutEffect(()=>record('route-layout-commit',location),[location]);return <SharedBoardRoute/>;}
const root=createRootRoute({component:()=> <><p data-fixture-ready>Public route fixture · synthetic responses</p><Outlet/></>});
const shared=createRoute({getParentRoute:()=>root,path:'/share/boards/$slug',component:FixtureRoute});
scrubMalformedHostedBoardShareFragment(window.location,window.history);
const router=createRouter({routeTree:root.addChildren([shared])});
routerLocation=()=>router.state.location;
record('after-create-router');
router.history.subscribe(({location,action})=>record('history-'+action.type,undefined,{pathname:location.pathname,searchStr:location.search,hash:location.hash,state:location.state}));
declare global{interface Window{boardShareInitial?:{atMs:number;hashLength:number;hashCategory:string;hasEntry:boolean};boardShareFixture:{navigate:(href:string)=>Promise<void>;diagnostics:()=>{initial:Window['boardShareInitial'];events:EntryDiagnostic[];readyState:string;loadingShell:boolean;alerts:number;cards:number}}}}
window.boardShareFixture={navigate:async href=>{await router.navigate({href});},diagnostics:()=>{record('snapshot');return{initial:window.boardShareInitial,events:[...events],readyState:document.readyState,loadingShell:document.body.textContent?.includes('Loading shared board…')??false,alerts:document.querySelectorAll('[role="alert"]').length,cards:document.querySelectorAll('.board-result').length};}};
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
