import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {MetaImportPanel} from '../src/components/MetaImportPanel.tsx';
import '../src/styles.css';

const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
function Fixture(){
 const [current,setCurrent]=React.useState(scope),[unauthorized,setUnauthorized]=React.useState(false),[connections,setConnections]=React.useState(0);
 (window as any).metaImportFixture={scope:(next:Partial<typeof scope>)=>setCurrent(old=>({...old,...next})),read:()=>({unauthorized,connections})};
 return unauthorized?<h1>Fixture signed out</h1>:<><p data-testid="connections-count">Connections navigation: {connections}</p><MetaImportPanel {...current} onUnauthorized={()=>setUnauthorized(true)} onConnections={()=>setConnections(n=>n+1)}/></>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1120,margin:'24px auto',padding:'0 16px',minWidth:0}}><nav className="row"><Link<AnyRouter> to="/">Fixture reports</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
const router=createRouter({routeTree:root.addChildren([index,elsewhere])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
