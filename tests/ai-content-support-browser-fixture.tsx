import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation,useRouter} from '@tanstack/react-router';
import {AISearchPanel} from '../src/components/AISearchPanel';
import {AIContentSupportPanel} from '../src/components/AIContentSupportPanel';
import {readSupportQuote,readSupportRun,supportQueryId,type SupportSourceReport} from '../src/components/ai-content-support-ui';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';

type Config={workspaceId:string;projectId:string;userId:string;report?:SupportSourceReport;mode:'parent'|'assessment'|'history'};
const fixture=window as unknown as {assessmentConfig:Config;assessmentReplace:(next?:Config)=>void;assessmentQueryId:typeof supportQueryId;assessmentReaders:{quote:typeof readSupportQuote;run:typeof readSupportRun}};
fixture.assessmentQueryId=supportQueryId;fixture.assessmentReaders={quote:readSupportQuote,run:readSupportRun};
function Fixture(){
 const location=useLocation(),router=useRouter(),search=index.useSearch(),navigate=index.useNavigate(),[entry,setEntry]=React.useState(0),[closed,setClosed]=React.useState(false),[denied,setDenied]=React.useState(false),[signedOut,setSignedOut]=React.useState(false),config=fixture.assessmentConfig,current=React.useRef('');
 const key=`${config.workspaceId}:${config.projectId}:${config.userId}:${entry}:${location.state.__TSR_key}`;current.current=key;
 fixture.assessmentReplace=next=>{current.current='';if(next)fixture.assessmentConfig=next;setEntry(n=>n+1);};
 const target:NavigationSearch={workspace:config.workspaceId,project:config.projectId,view:'ai-search'};
 return <><h1>AI search · component transport proof</h1><p>Recorded native responses; no database, live provider or semantic-quality evaluation runs here.</p><nav aria-label="Fixture navigation"><button className="btn" type="button" onClick={()=>router.history.push(location.href)}>Fixture new same-scope entry</button><button className="btn" type="button" onClick={()=>fixture.assessmentReplace()}>Fixture replace entry</button><button className="btn" type="button" onClick={()=>{current.current='';setClosed(true);}}>Fixture leave scope</button></nav>{signedOut?<p>Fixture signed out</p>:denied?<p role="alert">Fixture access purged</p>:closed?<p>Fixture assessment closed</p>:config.mode==='parent'?<AISearchPanel key={key} workspaceId={config.workspaceId} projectId={config.projectId} userId={config.userId} search={search} onNavigate={value=>void navigate({search:{...target,...value}})} onUnauthorized={()=>setSignedOut(true)} onPrompts={()=>{throw Error('Unexpected prompt navigation.');}} onProviders={()=>{throw Error('Unexpected provider navigation.');}}/>:<section className="ai-search stack"><AIContentSupportPanel key={key} workspaceId={config.workspaceId} projectId={config.projectId} report={config.mode==='assessment'?config.report:undefined} alive={()=>current.current===key} onRole={()=>{}} onUnauthorized={()=>setSignedOut(true)} onDenied={()=>setDenied(true)} onClose={()=>setClosed(true)}/></section>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
