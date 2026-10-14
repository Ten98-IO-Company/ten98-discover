import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {ExplorerPanel} from '../src/components/ExplorerPanel';
import '../src/styles.css';
const initial={projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
declare global{interface Window{cohortsFixture:{scope:(value:Partial<typeof initial>)=>void}}}
function Fixture(){const [scope,setScope]=React.useState(initial),[denied,setDenied]=React.useState(false);window.cohortsFixture={scope:value=>setScope(old=>({...old,...value}))};return denied?<h1>Fixture signed out</h1>:<ExplorerPanel {...scope} onUnauthorized={()=>setDenied(true)}/>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Link to="/" search={{view:'context'}}>Fixture navigation</Link><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
