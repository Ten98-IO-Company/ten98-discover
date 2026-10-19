import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation} from '@tanstack/react-router';
import {AIQueryAnalysisPanel} from '../src/components/AIQueryAnalysisPanel';
import {readAISearchIntent,aiSearchIntentQuery,parseNavigation} from '../src/lib/navigation';
import '../src/styles.css';
const projectId='00000000-0000-4000-8000-000000000001';
function Fixture(){const location=useLocation(),search=index.useSearch(),navigate=index.useNavigate(),intent=readAISearchIntent(search.aiSearchQuery)!,scope=location.href,live=React.useRef(scope),mounted=React.useRef(true),[denied,setDenied]=React.useState(false);live.current=scope;React.useEffect(()=>()=>{mounted.current=false;},[]);return <><button onClick={()=>void navigate({search:{...search,view:search.view==='project'?'ai-search':'project'}})}>Navigate fixture</button>{denied?<h1>Access denied fixture</h1>:search.view==='project'?<h1>Away fixture</h1>:<AIQueryAnalysisPanel key={scope} workspaceId="00000000-0000-4000-8000-000000000009" projectId={projectId} intent={intent} alive={()=>mounted.current&&live.current===scope} onNavigate={value=>void navigate({search:{...search,aiSearchQuery:aiSearchIntentQuery(value)}})} onUnauthorized={()=>setDenied(true)} onDenied={()=>setDenied(true)} onRole={()=>{}}/>}</>;}
const root=createRootRoute({component:()=> <main><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
