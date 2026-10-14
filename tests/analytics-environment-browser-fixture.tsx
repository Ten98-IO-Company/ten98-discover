import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {AnalyticsPanel} from '../src/components/AnalyticsPanel';
import {ExplorerPanel} from '../src/components/ExplorerPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
function Fixture(){
  const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);
  const target=(value:Partial<NavigationSearch>={}):NavigationSearch=>({workspace,project,view:'project',...value});
  return <><nav aria-label="Fixture scope"><Link to="/" search={target()}>Fixture first project</Link> <Link to="/" search={target({project:other})}>Fixture other project</Link> <Link to="/" search={target({view:'explore'})}>Fixture Explore</Link> <button type="button" className="btn" onClick={()=>setUser('30000000-0000-4000-8000-000000000002')}>Fixture change account</button></nav>{signedOut?<h1>Fixture signed out</h1>:search.view==='explore'?<ExplorerPanel projectId={search.project??project} userId={user} onUnauthorized={()=>setSignedOut(true)}/>:<AnalyticsPanel projectId={search.project??project} userId={user} search={search} onNavigate={value=>void navigate({search:{...target({project:search.project??project}),...value}})} onUnauthorized={()=>setSignedOut(true)}/>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
