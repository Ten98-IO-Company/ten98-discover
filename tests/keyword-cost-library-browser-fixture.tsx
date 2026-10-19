import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {KeywordResearchPanel} from '../src/components/KeywordResearchPanel';
import '../src/styles.css';
const initial={userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'};
function Fixture(){
 const [scope,setScope]=React.useState(initial),[unauthorized,setUnauthorized]=React.useState(false);
 Object.assign(window,{keywordCostFixture:{scope:(value:Partial<typeof initial>)=>setScope(old=>({...old,...value}))}});
 return unauthorized?<h1>Fixture signed out</h1>:<KeywordResearchPanel {...scope} onUnauthorized={()=>setUnauthorized(true)}/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
