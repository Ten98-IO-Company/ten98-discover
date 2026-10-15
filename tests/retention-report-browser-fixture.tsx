import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {RetentionReportPanel} from '../src/components/RetentionReportPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false),target=(view:NavigationSearch['view'],project=search.project)=>({workspace,project,view});return <><nav aria-label="Fixture scope"><Link to="/" search={target('visitor-retention',other)}>Other project</Link> <Link to="/" search={target('explore')}>Explore</Link> <Link to="/" search={target('retention')}>Data retention</Link> <button className="btn" type="button" onClick={()=>setUser('30000000-0000-4000-8000-000000000002')}>Change account</button></nav>{signedOut?<h1>Signed out</h1>:search.view==='visitor-retention'?<><h1>Retention</h1><RetentionReportPanel projectId={search.project??other} userId={user} search={search} onNavigate={(value,replace)=>void navigate({search:{...target('visitor-retention'),...value},replace})} onUnauthorized={()=>setSignedOut(true)} onOpenExplore={()=>void navigate({search:target('explore')})}/></>:<h1>{search.view==='retention'?'Data retention settings':'Explore analytics'}</h1>}</>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
