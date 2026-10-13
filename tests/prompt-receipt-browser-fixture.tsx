import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {PromptExecutionsPanel,type ExecutionEntry} from '../src/components/PromptExecutionsPanel';
import '../src/styles.css';
const initial={userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'};
function Fixture(){
 const [scope,setScope]=React.useState(initial),[entry,setEntry]=React.useState<ExecutionEntry>({kind:'receipt',comparisonId:'40000000-0000-4000-8000-000000000001',promptId:'50000000-0000-4000-8000-000000000001'}),[back,setBack]=React.useState(false),[unauthorized,setUnauthorized]=React.useState(false);
 (window as any).receiptFixture={scope:(value:Partial<typeof initial>)=>setScope(old=>({...old,...value})),entry:setEntry};
 return unauthorized?<h1>Fixture signed out</h1>:back?<h1>Returned to insights</h1>:<PromptExecutionsPanel {...scope} entry={entry} onBack={()=>setBack(true)} onUnauthorized={()=>setUnauthorized(true)} backLabel="Back to AI insights"/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
