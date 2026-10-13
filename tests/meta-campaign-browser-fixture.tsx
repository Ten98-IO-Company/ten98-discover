import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {MetaCampaignPanel} from '../src/components/MetaCampaignPanel.tsx';
import {MetaImportPanel} from '../src/components/MetaImportPanel.tsx';
import '../src/styles.css';
const defaults={userId:'30000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',connectionId:'40000000-0000-4000-8000-000000000001'};
function Fixture({parent=false}:{parent?:boolean}){const [scope,setScope]=React.useState(defaults),[signedOut,setSignedOut]=React.useState(false),[left,setLeft]=React.useState('');
 (window as any).metaCampaignFixture={scope:(value:Partial<typeof defaults>)=>setScope(s=>({...s,...value}))};
 if(signedOut)return <h1>Fixture signed out</h1>;if(left)return <h1>{left}</h1>;
 return parent?<MetaImportPanel {...scope} onUnauthorized={()=>setSignedOut(true)} onConnections={()=>setLeft('Fixture connections')}/>:<MetaCampaignPanel {...scope} onUnauthorized={()=>setSignedOut(true)} onBack={()=>setLeft('Fixture reports')}/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1120,margin:'24px auto',padding:'0 16px',minWidth:0}}><nav className="row"><Link<AnyRouter> to="/">Fixture inventory</Link><Link<AnyRouter> to="/imports">Fixture reports parent</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:()=> <Fixture/>}),imports=createRoute({getParentRoute:()=>root,path:'/imports',component:()=> <Fixture parent/>}),elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
const router=createRouter({routeTree:root.addChildren([index,imports,elsewhere])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
