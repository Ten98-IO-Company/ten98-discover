import React from 'react';
import {createRoot,hydrateRoot} from 'react-dom/client';
import {createRootRoute,createRouter,Outlet,RouterProvider,useLocation} from '@tanstack/react-router';
import {Route as applicationRoute} from '../src/routes/index';
import {SharedTrackedAssetPanel} from '../src/components/TrackedAssetsPanel';
import type {NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';

// Actual root route/App and public-entry decision; only the document shell is a fixture.
function Shell(){
 const location=useLocation();
 React.useEffect(()=>{document.documentElement.dataset.trackedAssetsFixture='ready';},[]);
 return <><output aria-label="Fixture applied navigation" style={{display:'block',overflowWrap:'anywhere',minWidth:0,maxWidth:'100%'}}>{location.searchStr}</output><Outlet/></>;
}
const root=createRootRoute({component:Shell});
const index=applicationRoute.update({id:'/',path:'/',getParentRoute:()=>root} as any);
const router=createRouter({routeTree:root.addChildren([index])});
declare global{interface Window{trackedAssetsFixture:{navigate:(search:NavigationSearch)=>Promise<void>};trackedAssetsHydrationErrors:{name:string;message:string;cause:string|null;componentStack:string;characterSet:string;serverText:string}[]}}
window.trackedAssetsFixture={navigate:search=>router.navigate({to:'/',search,hash:''})};
function HydratedShare(){
 React.useEffect(()=>{document.documentElement.dataset.trackedAssetsFixture='ready';},[]);
 return <SharedTrackedAssetPanel search={window.location.search} fragment={window.location.hash} entry="hydration-fixture"/>;
}
const container=document.getElementById('root')!;
if(container.dataset.hydrateShared==='true'){
 window.trackedAssetsHydrationErrors=[];
 const diagnostic=(value:unknown,limit=3000)=>{let text=value instanceof Error?value.message:typeof value==='string'?value:String(value??'');const fragment=window.location.hash.slice(1);if(fragment)text=text.replaceAll(fragment,'[fragment]');return text.replace(/https?:\/\/[^\s<>"')]+/g,'[url]').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').slice(0,limit);},serverText=diagnostic(container.textContent,256);
 hydrateRoot(container,<HydratedShare/>,{onRecoverableError:(error,info)=>window.trackedAssetsHydrationErrors.push({name:diagnostic(error instanceof Error?error.name:'Error',80),message:diagnostic(error),cause:error instanceof Error&&error.cause!==undefined?diagnostic(error.cause,1000):null,componentStack:diagnostic(info.componentStack,2000),characterSet:document.characterSet,serverText})});
}else createRoot(container).render(<RouterProvider router={router}/>);
