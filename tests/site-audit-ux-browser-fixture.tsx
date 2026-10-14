import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {SiteAuditPanel} from '../src/components/SiteAuditPanel.tsx';
import {createRootRoute,createRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {parseNavigation} from '../src/lib/navigation.ts';
import '../src/styles.css';

function Fixture(){
  const search=fixtureRoute.useSearch(),navigate=fixtureRoute.useNavigate();
  const [destination,setDestination]=React.useState('');
  const [scope,setScope]=React.useState({projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'});
  React.useEffect(()=>{Object.assign(window,{auditFixture:{scope:setScope}});},[]);
  return <div className="shell">
    <aside className="side"><p>Audit test workspace</p></aside>
    <main className="main">
      <header className="app-bar">Synthetic project</header>
      <div className="page-content"><h1>Site audits</h1>
        {destination?<h2>{destination}</h2>:<SiteAuditPanel
          projectId={scope.projectId}
          userId={scope.userId}
          {...search.view==='audits'?{search,onNavigate:(value:import('../src/lib/navigation.ts').AuditNavigation,replace?:boolean)=>{void navigate({search:{workspace:search.workspace,project:scope.projectId,view:'audits',...value},replace});}}:{}}
          onUnauthorized={()=>setDestination('Fixture signed out')}
          onOpenDomains={()=>setDestination('Fixture domains')}
          onOpenRetention={()=>setDestination('Fixture retention')}/>}
      </div>
    </main>
  </div>;
}
const rootRoute=createRootRoute({component:()=> <Outlet/>});
const fixtureRoute=createRoute({getParentRoute:()=>rootRoute,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:rootRoute.addChildren([fixtureRoute])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
