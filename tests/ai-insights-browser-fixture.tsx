import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {AIInsightsPanel} from '../src/components/AIInsightsPanel.tsx';
import '../src/styles.css';

function Fixture(){
 const [scope,setScope]=React.useState({userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'});
 const [receipt,setReceipt]=React.useState(false);
 const [destination,setDestination]=React.useState(''),[opened,setOpened]=React.useState<string[]>([]);
 (window as any).aiInsightsFixture={scope:(patch:Partial<typeof scope>)=>{setDestination('');setScope(old=>({...old,...patch}));},receipt:setReceipt,read:()=>({destination,opened})};
 return <main style={{maxWidth:1200,margin:'24px auto',padding:'0 16px',minWidth:0}}>{destination?<h1>{destination}</h1>:<AIInsightsPanel {...scope} onUnauthorized={()=>setDestination('Fixture signed out')} onBack={()=>setDestination('Fixture project')} backLabel="Back to project" onOpenComparison={receipt?undefined:(comparisonId,promptId)=>{setOpened([comparisonId,promptId]);setDestination('Fixture comparison');}}/>}</main>;
}
const root=createRootRoute({component:()=> <Outlet/>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
