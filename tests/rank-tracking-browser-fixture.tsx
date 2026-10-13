import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {RankTrackingPanel} from '../src/components/RankTrackingPanel.tsx';
import '../src/styles.css';

const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
function Panel(){
  const [current,setCurrent]=React.useState(scope),[unauthorized,setUnauthorized]=React.useState(false),[providers,setProviders]=React.useState(0);
  (window as any).rankHarness={scope:(next:Partial<typeof scope>)=>setCurrent(p=>({...p,...next})),read:()=>({unauthorized,providers})};
  return unauthorized?<h1>Fixture signed out</h1>:<><p data-testid="provider-count">Provider navigation: {providers}</p><RankTrackingPanel {...current} origin="https://example.com" onUnauthorized={()=>setUnauthorized(true)} onOpenProviders={()=>setProviders(v=>v+1)}/></>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture trackers</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel});
const elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
const router=createRouter({routeTree:root.addChildren([index,elsewhere])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
