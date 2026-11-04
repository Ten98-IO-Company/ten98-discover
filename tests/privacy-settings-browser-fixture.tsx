import {createRoot} from 'react-dom/client';
import {createRootRoute, createRoute, createRouter, Outlet, RouterProvider} from '@tanstack/react-router';
import {ToastProvider} from '@ten98/ui';
import {AnalyticsSettingsPanel} from '../src/components/AnalyticsSettingsPanel';
import '../src/styles.css';
const root=createRootRoute({component:()=> <main style={{maxWidth:900,margin:'16px auto',padding:'0 16px',minWidth:0}}><h1>Privacy</h1><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:()=> <AnalyticsSettingsPanel projectId="synthetic-project" userId="synthetic-user" onUnauthorized={()=>{throw Error('Unexpected authorization callback');}}/>});
createRoot(document.getElementById('root')!).render(<ToastProvider><RouterProvider router={createRouter({routeTree:root.addChildren([index])})}/></ToastProvider>);
