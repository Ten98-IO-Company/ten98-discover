import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useNavigate,useSearch} from '@tanstack/react-router';
import {SessionExplorerPanel} from '../src/components/SessionExplorerPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const project='20000000-0000-4000-8000-000000000001',user='30000000-0000-4000-8000-000000000001';
declare global{interface Window{sessionFixture:{scope:(value:{projectId?:string;userId?:string})=>void}}}
function Fixture(){const search=useSearch({strict:false}) as NavigationSearch,navigate=useNavigate(),[scope,setScope]=React.useState({projectId:project,userId:user}),[denied,setDenied]=React.useState(false);window.sessionFixture={scope:value=>setScope(old=>({...old,...value}))};return denied?<h1>Fixture signed out</h1>:<SessionExplorerPanel {...scope} search={search} onNavigate={value=>void navigate({to:'/',search:{workspace:search.workspace,project:scope.projectId,view:'sessions',...value}})} onUnauthorized={()=>setDenied(true)}/>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
