import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {SiteAuditAccessPanel} from '../src/components/SiteAuditAccessPanel.tsx';
import {Stack,Heading,Text} from '@ten98/ui';
import '../src/styles.css';
function Fixture(){
 const [signedOut,setSignedOut]=React.useState(false),[changes,setChanges]=React.useState(0),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001');
 React.useEffect(()=>{Object.assign(window,{accessFixture:{user:setUser}});},[]);
 return <Stack gap={4}><Heading level={1}>Synthetic crawler access</Heading>{signedOut?<Heading level={2}>Fixture signed out</Heading>:<SiteAuditAccessPanel projectId="20000000-0000-4000-8000-000000000001" userId={user} onUnauthorized={()=>setSignedOut(true)} onChanged={()=>setChanges(value=>value+1)}/>}<Text>Confirmed changes: {changes}</Text></Stack>;
}
const rootRoute=createRootRoute({component:()=> <Outlet/>});
const fixtureRoute=createRoute({getParentRoute:()=>rootRoute,path:'/',component:Fixture});
const router=createRouter({routeTree:rootRoute.addChildren([fixtureRoute])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
