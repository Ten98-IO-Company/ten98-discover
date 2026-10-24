import {createRoot} from 'react-dom/client';
import {ToastProvider} from '@ten98/ui';
import {createRootRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {Route as applicationRoute} from '../src/routes/index';
import type {NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
// Actual application router and AnalyticsSettingsPanel parent; only transport/document are synthetic.
const root=createRootRoute({component:()=> <Outlet/>});
const index=applicationRoute.update({id:'/',path:'/',getParentRoute:()=>root} as any);
const router=createRouter({routeTree:root.addChildren([index])});
declare global{interface Window{websiteShareExitFixture:{navigate:(search:NavigationSearch)=>Promise<void>}}}
window.websiteShareExitFixture={navigate:search=>router.navigate({to:'/',search,hash:''})};
createRoot(document.getElementById('root')!).render(<ToastProvider>{<RouterProvider router={router}/>}</ToastProvider>);
