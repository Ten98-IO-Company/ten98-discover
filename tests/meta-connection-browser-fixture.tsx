import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {MetaConnectionPanel} from '../src/components/MetaConnectionPanel.tsx';
import '../src/styles.css';

const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
function Panel(){
 const [current,setCurrent]=React.useState(scope),[unauthorized,setUnauthorized]=React.useState(false),[appSetup,setAppSetup]=React.useState(0);
 (window as any).metaPanelFixture={scope:(next:Partial<typeof scope>)=>setCurrent(old=>({...old,...next})),read:()=>({unauthorized,appSetup})};
 return unauthorized?<h1>Fixture signed out</h1>:<><p data-testid="app-setup-count">App setup navigation: {appSetup}</p><MetaConnectionPanel {...current} onUnauthorized={()=>setUnauthorized(true)} onOpenAppSetup={()=>setAppSetup(n=>n+1)}/></>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1000,margin:'24px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture Meta</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel});
const elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
const router=createRouter({routeTree:root.addChildren([index,elsewhere])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
