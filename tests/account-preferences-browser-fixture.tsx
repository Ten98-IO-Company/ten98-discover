import {createRoot} from 'react-dom/client';
import {ToastProvider} from '@ten98/ui';
import {createRootRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {Route as applicationRoute} from '../src/routes/index';
import '../src/styles.css';

// Mount the actual App/controller and native menu, not a parallel preferences owner.
// This is the same file-route update used by routeTree.gen; replace only the document root.
const root=createRootRoute({component:()=> <Outlet/>});
const index=applicationRoute.update({id:'/',path:'/',getParentRoute:()=>root} as any);
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<ToastProvider><RouterProvider router={router}/></ToastProvider>);
