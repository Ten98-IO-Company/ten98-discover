import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation,useRouter} from '@tanstack/react-router';
import {AISearchPanel} from '../src/components/AISearchPanel';
import {AIContentCoveragePanel} from '../src/components/AIContentCoveragePanel';
import {readContentCoverageReport} from '../src/lib/ai-content-coverage';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
type Config={workspaceId:string;projectId:string;userId:string;captureId:string;mode:'parent'|'standalone'};
const fixture=window as unknown as {coverageConfig:Config;coverageReader:(v:unknown,p:string,i:unknown)=>boolean;coverageEntry:()=>void};
fixture.coverageReader=(v,p,i)=>{try{readContentCoverageReport(v,p,i as Parameters<typeof readContentCoverageReport>[2]);return true;}catch{return false;}};
function Fixture(){
 const location=useLocation(),router=useRouter(),search=index.useSearch(),navigate=index.useNavigate(),[entry,setEntry]=React.useState(0),[closed,setClosed]=React.useState(false),[denied,setDenied]=React.useState(false),[signedOut,setSignedOut]=React.useState(false),config=fixture.coverageConfig,current=React.useRef('');
 const key=`${config.workspaceId}:${config.projectId}:${config.userId}:${config.captureId}:${entry}:${location.state.__TSR_key}`;current.current=key;fixture.coverageEntry=()=>{current.current='';setEntry(n=>n+1);};
 const target:NavigationSearch={workspace:config.workspaceId,project:config.projectId,view:'ai-search'};
 return <><h1>AI search</h1><nav aria-label="Fixture navigation"><button className="btn" type="button" onClick={()=>router.history.push(location.href)}>Fixture new same-scope entry</button><button className="btn" type="button" onClick={()=>fixture.coverageEntry()}>Fixture replace entry</button></nav>{signedOut?<p>Fixture signed out</p>:denied?<p role="alert">Fixture access purged</p>:closed?<p>Fixture comparison closed</p>:config.mode==='parent'?<AISearchPanel workspaceId={config.workspaceId} projectId={config.projectId} userId={config.userId} search={search} onNavigate={value=>void navigate({search:{...target,...value}})} onUnauthorized={()=>setSignedOut(true)} onPrompts={()=>{throw Error('Unexpected prompt navigation');}} onProviders={()=>{throw Error('Unexpected provider navigation');}}/>:<AIContentCoveragePanel key={key} workspaceId={config.workspaceId} projectId={config.projectId} captureId={config.captureId} alive={()=>current.current===key} onRole={()=>{}} onUnauthorized={()=>setSignedOut(true)} onDenied={()=>setDenied(true)} onClose={()=>setClosed(true)}/>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
