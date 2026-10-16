import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {BoardsPanel} from '../src/components/BoardsPanel';
import {RevenuePanel} from '../src/components/RevenuePanel';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {parseNavigation} from '../src/lib/navigation';
import '../src/styles.css';

type Scope={workspaceId:string;userId:string;query:string;readOwner:string;readEnabled:boolean;mode?:'boards'|'revenue'};
declare global{interface Window{boardsScope?:Scope;boardsFixture:{set:(value:Partial<Scope>)=>void}}}
const initial:Scope={workspaceId:'61000000-0000-4000-8000-000000000001',userId:'61000000-0000-4000-8000-000000000002',query:'',readOwner:'entry-0',readEnabled:true};
function Fixture(){
 const [scope,setScope]=React.useState(()=>window.boardsScope??initial),[callbacks,setCallbacks]=React.useState(0),[signedOut,setSignedOut]=React.useState(false),[shown,setShown]=React.useState(true),entry=React.useRef(0);
 React.useEffect(()=>{window.boardsFixture={set:value=>setScope(old=>({...old,...value}))};},[]);
 return <main className="stack" style={{maxWidth:1240,margin:'20px auto',padding:'0 16px',minWidth:0,gridTemplateColumns:'minmax(0,1fr)'}}>
  <p className="hint">Synthetic board API and native report-shaped bodies. Actual source components; no database, native authorization, collection, paid work or compiled application proof.</p>
  <button className="btn" onClick={()=>setShown(value=>!value)}>{shown?'Unmount boards':'Mount boards'}</button><output aria-label="Unauthorized callbacks">{callbacks}</output><output aria-label="Fixture applied query" style={{overflowWrap:'anywhere',maxWidth:'100%',minWidth:0}}>{scope.query}</output>
  {signedOut?<h1>Fixture signed out</h1>:shown?<BoardsPanel {...scope} projects={[{id:'61000000-0000-4000-8000-000000000003',name:'Main website'},{id:'61000000-0000-4000-8000-000000000004',name:'Second website'}]} onNavigate={query=>setScope(old=>({...old,query,readOwner:'entry-'+(++entry.current)}))} onUnauthorized={()=>{setCallbacks(value=>value+1);setSignedOut(true);}}/>:<p>Boards unmounted</p>}
 </main>;
}
function RevenueFixture(){
 const search=revenueIndex.useSearch(),navigate=revenueIndex.useNavigate(),[signedOut,setSignedOut]=React.useState(false);
 return <><p className="hint">Legacy actual RevenuePanel extraction regression; native router, synthetic report response only.</p>{signedOut?<h1>Fixture signed out</h1>:<RevenuePanel projectId={search.project??'61000000-0000-4000-8000-000000000003'} userId={window.boardsScope?.userId??initial.userId} search={search} onNavigate={next=>void navigate({search:{workspace:search.workspace,project:search.project,view:'revenue',...next}})} onUnauthorized={()=>setSignedOut(true)}/>}</>;
}
const revenueRoot=createRootRoute({component:()=> <main style={{maxWidth:1240,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const revenueIndex=createRoute({getParentRoute:()=>revenueRoot,path:'/',validateSearch:parseNavigation,component:RevenueFixture});
const revenueRouter=createRouter({routeTree:revenueRoot.addChildren([revenueIndex])});
createRoot(document.getElementById('root')!).render(window.boardsScope?.mode==='revenue'?<RouterProvider router={revenueRouter}/>:<Fixture/>);
