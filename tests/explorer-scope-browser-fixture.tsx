import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link,useLocation} from '@tanstack/react-router';
import {AnalyticsPanel,analyticsExplorerQuery} from '../src/components/AnalyticsPanel';
import {ExplorerPanel,readExplorerScope} from '../src/components/ExplorerPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
declare global{interface Window{explorerScopeFixture:{navigate:(value:NavigationSearch)=>Promise<void>;freeze:(value:boolean)=>void;user:(value:string)=>void;read:typeof readExplorerScope;bridge:typeof analyticsExplorerQuery};explorerFetches:{url:string;wire:string;aborted:boolean}[];}}
function Fixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),location=useLocation(),[frozen,setFrozen]=React.useState(false),previous=React.useRef(search),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);
 if(!frozen)previous.current=search;const passed=previous.current,query=analyticsExplorerQuery(passed),base={workspace:passed.workspace,project:passed.project};
 window.explorerScopeFixture={navigate:value=>navigate({search:value}),freeze:setFrozen,user:setUser,read:readExplorerScope,bridge:analyticsExplorerQuery};
 return <><nav aria-label="Fixture navigation"><Link to="/" search={{...base,view:'explore',...(query===null?{exploreInvalid:'1' as const}:{exploreQuery:query})}}>Explore applied analytics</Link><Link to="/" search={{...base,view:'project'}}>Analytics</Link></nav><p>Entry <span id="entry">{location.state.__TSR_key}</span></p>{signedOut?<h1>Fixture signed out</h1>:passed.view==='explore'?<ExplorerPanel projectId={passed.project!} userId={user} search={passed} onNavigate={value=>void navigate({search:{...base,view:'explore',...value}})} onUnauthorized={()=>setSignedOut(true)}/>:<AnalyticsPanel projectId={passed.project!} userId={user} compareView={passed.view==='compare'} search={passed} onNavigate={value=>void navigate({search:{...base,view:passed.view,...value}})} onUnauthorized={()=>setSignedOut(true)}/>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:16}}><Outlet/></main>}),index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
