import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation} from '@tanstack/react-router';
import {PromptExecutionsPanel,type ExecutionEntry} from '../src/components/PromptExecutionsPanel';
import '../src/styles.css';
import {PromptsPanel} from '../src/components/PromptsPanel';
import {parseNavigation,canonicalNavigation,navigationKey,type PromptNavigation} from '../src/lib/navigation';
const initial={userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'};
function NavigationFixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),location=useLocation();
 const [unauthorized,setUnauthorized]=React.useState(false);
 const [readiness,setReadiness]=React.useState({pending:false,workspaceId:initial.workspaceId,projectId:initial.projectId});
 const scopeMatches=search.workspace===readiness.workspaceId&&search.project===readiness.projectId;
 const canonical=canonicalNavigation(location.searchStr,search);
 const committed=navigationKey(parseNavigation(location.search))===navigationKey(search);
 React.useEffect(()=>{if(!readiness.pending&&scopeMatches&&committed&&!canonical)void navigate({search:parseNavigation(search),replace:true});},[readiness.pending,scopeMatches,committed,canonical,location.searchStr]);
 const change=(value:PromptNavigation)=>void navigate({search:{workspace:search.workspace,project:search.project,view:'prompts',...value}});
 (window as any).receiptNavigation=(value:Record<string,unknown>)=>void navigate({search:{...search,...value}});
 (window as any).receiptReadiness=(value:Partial<typeof readiness>)=>setReadiness(old=>({...old,...value}));
 return unauthorized?<h1>Fixture signed out</h1>:<><div style={{minHeight:140}}><h1>Saved answers · synthetic shell spacing</h1></div><PromptsPanel workspaceId={readiness.workspaceId} projectId={readiness.projectId} userId={initial.userId} navigation={search} readEnabled={!readiness.pending&&scopeMatches&&canonical} onNavigate={change} onUnauthorized={()=>setUnauthorized(true)}/></>;
}
function Fixture(){
 const [scope,setScope]=React.useState(initial),[entry,setEntry]=React.useState<ExecutionEntry>({kind:'receipt',comparisonId:'40000000-0000-4000-8000-000000000001',promptId:'50000000-0000-4000-8000-000000000001'}),[back,setBack]=React.useState(false),[unauthorized,setUnauthorized]=React.useState(false);
 (window as any).receiptFixture={scope:(value:Partial<typeof initial>)=>setScope(old=>({...old,...value})),entry:setEntry};
 return unauthorized?<h1>Fixture signed out</h1>:back?<h1>Returned to insights</h1>:<PromptExecutionsPanel {...scope} entry={entry} onBack={()=>setBack(true)} onUnauthorized={()=>setUnauthorized(true)} backLabel="Back to AI insights"/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:()=> (window as any).promptNavigationFixture?<NavigationFixture/>:<Fixture/>});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
