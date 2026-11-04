import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {SiteAuditPanel} from '../src/components/SiteAuditPanel.tsx';
import '../src/styles.css';
function Fixture(){
 const [signedOut,setSignedOut]=React.useState(false);
 return <main className="main"><div className="page-content"><h1>Synthetic protected audits</h1>{signedOut?<h2>Fixture signed out</h2>:<SiteAuditPanel projectId="20000000-0000-4000-8000-000000000001" userId="30000000-0000-4000-8000-000000000001" onUnauthorized={()=>setSignedOut(true)} onOpenDomains={()=>{}} onOpenRetention={()=>{}}/>}</div></main>;
}
const rootRoute=createRootRoute({component:()=> <Outlet/>});
const fixtureRoute=createRoute({getParentRoute:()=>rootRoute,path:'/',component:Fixture});
const router=createRouter({routeTree:rootRoute.addChildren([fixtureRoute])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
