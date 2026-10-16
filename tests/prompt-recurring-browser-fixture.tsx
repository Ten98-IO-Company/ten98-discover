import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {PromptRecurringPanel} from '../src/components/PromptRecurringPanel';
import {PromptExecutionsPanel} from '../src/components/PromptExecutionsPanel';
import '../src/styles.css';
const project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',user='30000000-0000-4000-8000-000000000001';
function Fixture(){
 const[scope,setScope]=React.useState(project),[role,setRole]=React.useState<'owner'|'admin'|'editor'|'viewer'>('owner'),[shown,setShown]=React.useState(true),[denied,setDenied]=React.useState(false),[callbacks,setCallbacks]=React.useState(0);
 const quote={id:'40000000-0000-4000-8000-000000000001',expiresAt:new Date(Date.now()+300000).toISOString(),estimateUsd:'0.050000',input:{promptId:'50000000-0000-4000-8000-000000000001',versionId:'60000000-0000-4000-8000-000000000001',models:['openai/gpt-4o-mini','openai/gpt-4o'],systemText:'Exact recurring system',maxCompletionTokens:64,reuseCached:false}};
 if(new URLSearchParams(location.search).get('parent')==='1')return <main style={{maxWidth:1100,margin:'20px auto',padding:16,minWidth:0}}><PromptExecutionsPanel projectId={project} workspaceId="80000000-0000-4000-8000-000000000001" userId={user} entry={{kind:'configure',promptId:quote.input.promptId,versionId:quote.input.versionId,authoredText:'Authored recurring parent fixture'}} onBack={()=>{}} onUnauthorized={()=>setDenied(true)}/></main>;
 return <main className="research-panel stack" style={{maxWidth:1100,margin:'20px auto',padding:16,minWidth:0}}><h1>Recurring synthetic transport fixture</h1><p>Actual component; manually authored native-shaped responses. No database, authenticated API or provider acceptance.</p><nav className="row" aria-label="Fixture controls"><button className="btn" onClick={()=>setScope(value=>value===project?other:project)}>Change project</button><button className="btn" onClick={()=>setRole('owner')}>Use owner role</button><button className="btn" onClick={()=>setRole('viewer')}>Use viewer role</button><button className="btn" onClick={()=>setShown(value=>!value)}>{shown?'Unmount tracking':'Mount tracking'}</button></nav><output aria-label="Unauthorized callbacks">{callbacks}</output><output aria-label="Current fixture role">{role}</output>{denied?<h2>Fixture signed out</h2>:shown?<PromptRecurringPanel key={scope} projectId={scope} userId={user} role={role} quote={scope===project?quote:null} onUnauthorized={()=>{setCallbacks(value=>value+1);setDenied(true);}} onRole={setRole} onOpenComparison={()=>{}}/>:<p>Tracking unmounted</p>}</main>;
}
const root=createRootRoute({component:()=> <Outlet/>}),index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
