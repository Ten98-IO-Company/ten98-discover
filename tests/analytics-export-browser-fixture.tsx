import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {AnalyticsPanel} from '../src/components/AnalyticsPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
type Scope={projectId:string;userId:string};
declare global{interface Window{analyticsExportFixture:{setScope:(value:Scope)=>Promise<void>;unmount:()=>void;unauthorized:()=>number}}}
const workspace='10460000-0000-4000-8000-000000000001',project='10460000-0000-4000-8000-000000000002',user='10460000-0000-4000-8000-000000000003';
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),[userId,setUser]=React.useState(user),[mounted,setMounted]=React.useState(true),[signedOut,setSignedOut]=React.useState(false),count=React.useRef(0);const target=(extra:Partial<NavigationSearch>={}):NavigationSearch=>({workspace,project,view:'project',...extra});window.analyticsExportFixture={setScope:async value=>{setUser(value.userId);await navigate({search:{...search,project:value.projectId}});},unmount:()=>setMounted(false),unauthorized:()=>count.current};return <>{signedOut?<h1>Fixture signed out</h1>:mounted?<AnalyticsPanel projectId={search.project??project} userId={userId} search={search} onNavigate={value=>void navigate({search:{...target({project:search.project}),...value}})} onUnauthorized={()=>{count.current++;setSignedOut(true);}}/>:<p>Fixture unmounted</p>}</>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Analytics export · synthetic component fixture</h1><Outlet/></main>}),index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);