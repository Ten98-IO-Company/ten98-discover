import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation} from '@tanstack/react-router';
import {JourneysPanel} from '../src/components/JourneysPanel';
import {AIQueryAnalysisPanel} from '../src/components/AIQueryAnalysisPanel';
import {parseNavigation,readAISearchIntent,aiSearchIntentQuery} from '../src/lib/navigation';
import '../src/styles.css';
import '../src/components/ai-search.css';
const projectId='00000000-0000-4000-8000-000000000001',workspaceId='00000000-0000-4000-8000-000000000009';
function Fixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),location=useLocation(),scope=location.href,live=React.useRef(scope),[denied,setDenied]=React.useState(false);live.current=scope;
 return denied?<h1>Access denied fixture</h1>:search.view==='journeys'?<JourneysPanel projectId={projectId} userId="00000000-0000-4000-8000-000000000008" search={search} onNavigate={value=>void navigate({search:{...search,...value}})} onUnauthorized={()=>setDenied(true)}/>:<section className="ai-search stack"><AIQueryAnalysisPanel key={scope} workspaceId={workspaceId} projectId={projectId} intent={readAISearchIntent(search.aiSearchQuery)!} alive={()=>live.current===scope} onNavigate={intent=>void navigate({search:{...search,aiSearchQuery:aiSearchIntentQuery(intent)}})} onUnauthorized={()=>setDenied(true)} onDenied={()=>setDenied(true)} onRole={()=>{}}/></section>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
