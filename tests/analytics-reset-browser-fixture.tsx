import React from 'react';
import {ToastProvider} from '@ten98/ui';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,Outlet,RouterProvider} from '@tanstack/react-router';
import {AnalyticsResetPanel} from '../src/components/AnalyticsResetPanel';
import {AnalyticsSettingsPanel} from '../src/components/AnalyticsSettingsPanel';
import '../src/styles.css';
const project='20000000-0000-4000-8000-000000000001',user='30000000-0000-4000-8000-000000000001';
function Fixture(){
 const [account,setAccount]=React.useState(user),[current,setProject]=React.useState(project),[mounted,setMounted]=React.useState(true),[denied,setDenied]=React.useState(0),[resets,setResets]=React.useState(0),[,render]=React.useState(0),lease=React.useRef({entry:0,enabled:true});
 const entry=lease.current.entry,isCurrent=()=>lease.current.entry===entry&&lease.current.enabled;
 (window as unknown as {analyticsResetFixture:{deny:()=>void}}).analyticsResetFixture={deny:()=>{lease.current.entry++;lease.current.enabled=false;render(n=>n+1);}};
 const full=new URLSearchParams(location.search).get('parent')==='1',props={projectId:current,userId:account,readOwner:String(entry),readEnabled:lease.current.enabled,isCurrent,onUnauthorized:()=>setDenied(n=>n+1)};
 return <><nav aria-label="Synthetic identity controls" className="row" style={{flexWrap:'wrap'}}><button className="btn" onClick={()=>{lease.current.entry++;setAccount(value=>value===user?user.replace(/1$/,'2'):user);}}>Change account</button><button className="btn" onClick={()=>{lease.current.entry++;setProject(value=>value===project?project.replace(/1$/,'2'):project);}}>Change project</button><button className="btn" onClick={()=>{lease.current.entry++;setMounted(false);}}>Unmount reset</button></nav><output aria-label="Unauthorized callbacks">{denied}</output><output aria-label="Accepted callbacks">{resets}</output><main className="card stack" style={{maxWidth:900,margin:'16px auto',minWidth:0}}><h1>Website data</h1><p>Synthetic component fixture. No real reset or database is connected.</p>{mounted&&(full?<AnalyticsSettingsPanel {...props}/>:<AnalyticsResetPanel {...props} authorityOwner={String(entry)} onReset={()=>setResets(n=>n+1)}/>)}</main></>;
}
// WebsiteSharePanel registers a navigation blocker, so the full settings panel needs a router.
const root=createRootRoute({component:()=><Outlet/>}),index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
createRoot(document.getElementById('root')!).render(<ToastProvider>{<RouterProvider router={createRouter({routeTree:root.addChildren([index])})}/>}</ToastProvider>);
