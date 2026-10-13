import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet} from '@tanstack/react-router';
import {CitationAnalysisPanel} from '../src/components/CitationAnalysisPanel.tsx';
import {AIInsightsPanel} from '../src/components/AIInsightsPanel.tsx';
import '../src/styles.css';
function Fixture():React.ReactElement{
 const [scope,setScope]=React.useState({userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'}),[destination,setDestination]=React.useState(''),[parent,setParent]=React.useState(false);
 (window as any).citationFixture={scope:(patch:Partial<typeof scope>)=>{setDestination('');setScope(old=>({...old,...patch}));},parent:()=>{setDestination('');setParent(true);}};
 const common={...scope,onUnauthorized:()=>setDestination('Fixture signed out'),onBack:()=>setDestination('Fixture outside citations')};
 return <main style={{maxWidth:1200,margin:'24px auto',padding:'0 16px',minWidth:0}}><Link<typeof router,string,'/away'> to="/away">Fixture route away</Link>{destination?<h1>{destination}</h1>:parent?<AIInsightsPanel {...common} backLabel="Fixture Back" onOpenComparison={()=>setDestination('Unexpected external receipt navigation')}/>:<CitationAnalysisPanel {...common} filters={{from:'2025-01-08',to:'2025-01-14',timeZone:'UTC',model:null,promptId:null,tag:null}} filtersLabel="8–14 January 2025 · UTC · All models · All prompts"/>}</main>;
}
const rootRoute=createRootRoute({component:Outlet}),index=createRoute({getParentRoute:()=>rootRoute,path:'/',component:Fixture}),away=createRoute({getParentRoute:()=>rootRoute,path:'/away',component:()=> <h1>Fixture route left</h1>});
const router=createRouter({routeTree:rootRoute.addChildren([index,away])});
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
