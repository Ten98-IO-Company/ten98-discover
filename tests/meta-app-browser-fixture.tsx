import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {MetaAppPanel} from '../src/components/MetaAppPanel.tsx';
import '../src/styles.css';

function Panel(){
 const [userId,setUserId]=React.useState('10000000-0000-4000-8000-000000000001'),[unauthorized,setUnauthorized]=React.useState(false),[back,setBack]=React.useState(false);
 (window as any).metaAppFixture={user:(id:string)=>setUserId(id),read:()=>({unauthorized,back})};
 return unauthorized?<h1>Fixture signed out</h1>:back?<h1 tabIndex={-1}>Fixture returned</h1>:<MetaAppPanel userId={userId} onUnauthorized={()=>setUnauthorized(true)} onBack={()=>setBack(true)} backLabel="Back to connections"/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1000,margin:'24px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture app</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel});
const elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
const router=createRouter({routeTree:root.addChildren([index,elsewhere])});
createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router}/></React.StrictMode>);
