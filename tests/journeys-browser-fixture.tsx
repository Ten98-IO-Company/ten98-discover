import * as React from 'react';
import {AppShell,AppTopbar,AccountMenu,SidebarNav,SidebarFooter,SidebarStatus,WorkspaceProjectSwitcher,SearchField,PageHeader,SectionNav,Stack} from '@ten98/ui';
import {AppBrand} from '@ten98/ui/app';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {JourneysPanel,readJourneysResult} from '../src/components/JourneysPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
Object.assign(window,{__readJourneys:(data:unknown,query:string,id:string)=>{try{readJourneysResult(data,query,id);return true;}catch{return false;}}});
const sharedShell=window.location.hash==='#shared-shell';
// Native shared components and representative Discover props; data and authority remain synthetic.
function SharedShell({children}:{children:React.ReactNode}){
 const [open,setOpen]=React.useState(false),[query,setQuery]=React.useState('');
 return <AppShell sidebarLabel="Application navigation" skipLinkLabel="Skip to main content" mainLabel="Main content" navigation={{open,onOpenChange:setOpen}} sidebar={<>
  <AppBrand product="Discover"/>
  <WorkspaceProjectSwitcher workspaces={[{id:workspace,name:'Ten98 IO',initials:'TE',roleLabel:'owner workspace'}]} projects={[{id:project,name:'QA E2E 2026-11-02'}]} workspaceId={workspace} projectId={project} onWorkspaceChange={()=>{}} onProjectChange={()=>{}} create={{label:'Add website',href:'#shared-shell'}} labels={{project:'Website',choose:'Choose a website',loading:'Loading websites…'}}/>
  <SidebarNav label="Sections" groups={[{id:'sections',items:[{id:'overview',label:'Overview',icon:'home',href:'#shared-shell'},{id:'behaviour',label:'Behaviour',icon:'users',href:'#shared-shell',current:true},{id:'conversions',label:'Conversions',icon:'target',href:'#shared-shell'},{id:'search',label:'Search',icon:'search',href:'#shared-shell'},{id:'ai',label:'AI visibility',icon:'compass',href:'#shared-shell'},{id:'reports',label:'Reports',icon:'grid',href:'#shared-shell'}]}]}/>
  <SidebarFooter version="Synthetic fixture"><SidebarStatus tone="idle" label="Retained visits available"/><a className="nav-item" href="#shared-shell">Settings</a></SidebarFooter>
 </>} topbar={<AppTopbar wrap menuToggle menuLabel="Menu" breadcrumb={{icon:'folder',scope:'QA E2E 2026-11-02',current:'Journeys'}} search={<SearchField variant="topbar" label="Find a tool" hideLabel placeholder="Find a tool…" value={query} onValueChange={setQuery} onClear={()=>setQuery('')} clearLabel="Show all tools"/>} badge={{label:'Development preview',hideOnMobile:true}} actions={<AccountMenu name="Mustafa Guest" email="fixture@example.test"><a href="#shared-shell">Profile</a></AccountMenu>}/>}><Stack gap={6}><PageHeader title="Behaviour" description="⁨QA E2E 2026-11-02⁩ · ⁨http://127.0.0.1:3013⁩"/><SectionNav label="Behaviour pages" items={['Visitors','Journeys','Returning visitors','Recordings','Heatmaps'].map(label=>({id:label,label,href:'#shared-shell',current:label==='Journeys'}))}/>{children}</Stack></AppShell>;
}
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);const target=(id=project):NavigationSearch=>({workspace,project:id,view:'journeys'});
 return <>{!sharedShell&&<nav aria-label="Fixture scope"><Link to="/" search={target()}>Fixture first project</Link> <Link to="/" search={target(other)}>Fixture other project</Link> <Link to="/" search={{workspace,project,view:'project'}}>Fixture Analytics</Link> <button className="btn" type="button" onClick={()=>setUser(value=>value.endsWith('1')?'30000000-0000-4000-8000-000000000002':'30000000-0000-4000-8000-000000000001')}>Fixture change account</button></nav>}{signedOut?<h1>Fixture signed out</h1>:search.view==='journeys'?<JourneysPanel projectId={search.project??project} userId={user} search={search} onNavigate={value=>void navigate({search:{...target(search.project),...value}})} onUnauthorized={()=>setSignedOut(true)}/>:<h1>Fixture Analytics</h1>}</>;
}
const root=createRootRoute({component:()=> sharedShell?<SharedShell><Outlet/></SharedShell>:<main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
