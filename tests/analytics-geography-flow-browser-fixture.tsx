import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {ExplorerPanel} from '../src/components/ExplorerPanel';
import {RealtimePanel} from '../src/components/RealtimePanel';
import {SessionExplorerPanel} from '../src/components/SessionExplorerPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001';
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false),active=search.project??project,target=(view:NavigationSearch['view']):NavigationSearch=>({workspace,project:active,view});const unauthorized=()=>setSignedOut(true);return <><nav aria-label="Flow fixture"><Link to="/" search={target('explore')}>Flow Explore</Link> <Link to="/" search={target('realtime')}>Flow Realtime</Link> <Link to="/" search={target('sessions')}>Flow Sessions</Link> <Link to="/" search={{...target(search.view),project:'20000000-0000-4000-8000-000000000002'}}>Flow other project</Link><button type="button" className="btn" onClick={()=>setUser('30000000-0000-4000-8000-000000000002')}>Flow account</button></nav>{signedOut?<h1>Flow signed out</h1>:search.view==='realtime'?<RealtimePanel projectId={active} userId={user} origin="https://realtime.example" onUnauthorized={unauthorized} onOpenSession={value=>void navigate({search:{...target('sessions'),...value}})}/>:search.view==='sessions'?<SessionExplorerPanel projectId={active} userId={user} search={search} onUnauthorized={unauthorized} onNavigate={value=>void navigate({search:{...target('sessions'),...value}})}/>:<ExplorerPanel projectId={active} userId={user} onUnauthorized={unauthorized}/>}</>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
