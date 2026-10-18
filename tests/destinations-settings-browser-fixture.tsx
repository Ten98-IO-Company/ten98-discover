import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {DestinationsPanel} from '../src/components/DestinationsPanel';
import '../src/styles.css';
declare global{interface Window{destinationSettingsFixture:{project:(id:string)=>void;revoke:()=>void;logout:()=>void}}}
function Fixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),[project,setProject]=React.useState('55000000-0000-4000-8000-000000000001'),[allowed,setAllowed]=React.useState(true),[signedOut,setSignedOut]=React.useState(false);
 window.destinationSettingsFixture={project:setProject,revoke:()=>setAllowed(false),logout:()=>{flushSync(()=>setSignedOut(true));void navigate({search:{view:'project'}});}};
 return <main style={{maxWidth:1100,margin:'20px auto',padding:16}}><p>Synthetic destination settings transport; actual component and router. No authorization, database or live vendor proof.</p><nav aria-label="Fixture sidebar"><Link to="/" search={{view:'destinations'}}>Destinations</Link>{' '}<Link to="/" search={{view:'project'}}>Analytics</Link></nav>{signedOut?<h1>Fixture signed out</h1>:!allowed?<h1>Access removed</h1>:search.view==='project'?<h1>Other view</h1>:<DestinationsPanel key={project} projectId={project} userId="55000000-0000-4000-8000-000000000002" onUnauthorized={()=>setSignedOut(true)}/>}</main>;
}
const root=createRootRoute({component:()=> <Outlet/>}),index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:(input:Record<string,unknown>)=>({view:input.view==='project'?'project':'destinations'}),component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
