import * as React from 'react';
import {ToastProvider} from '@ten98/ui';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {AnalyticsSettingsPanel} from '../src/components/AnalyticsSettingsPanel';
import {AnalyticsPanel} from '../src/components/AnalyticsPanel';
import {analyticsNavigation,parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
function Fixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);
 const [applied,setApplied]=React.useState<{userId:string;projectId:string;from:string;to:string}|null>(null),[,bump]=React.useState(0);
 const rememberRange=React.useCallback((userId:string,projectId:string,range:{from:string;to:string})=>setApplied(previous=>previous?.userId===userId&&previous.projectId===projectId&&previous.from===range.from&&previous.to===range.to?previous:{userId,projectId,...range}),[]);
 const target=(value:Partial<NavigationSearch>={}):NavigationSearch=>({workspace,project,view:'compare',...value});
 const reportTarget=(view:'project'|'compare'):NavigationSearch=>{const{analyticsCompare,...report}=analyticsNavigation(search),range=applied?.userId===user&&applied.projectId===(search.project??project)?{analyticsFrom:applied.from,analyticsTo:applied.to}:{};return {...target({project:search.project??project,view}),...range,...report,...view==='compare'&&analyticsCompare?{analyticsCompare}:{}};};
 return <><nav aria-label="Fixture scope"><Link to="/" search={reportTarget('project')}>Fixture Analytics</Link> <Link to="/" search={reportTarget('compare')}>Fixture Compare</Link> <Link to="/" search={target({project:other})}>Fixture other project</Link> <Link to="/" search={target({view:'explore'})}>Fixture unrelated</Link> <Link to="/" search={target({view:'collection'})}>Fixture collection</Link> <button className="btn" type="button" onClick={()=>setUser('30000000-0000-4000-8000-000000000002')}>Fixture change account</button><button className="btn" type="button" onClick={()=>bump(n=>n+1)}>Fixture rerender</button></nav>{signedOut?<h1>Fixture signed out</h1>:search.view==='collection'?<AnalyticsSettingsPanel projectId={search.project??project} userId={user} onUnauthorized={()=>setSignedOut(true)}/>:search.view==='explore'?<h1>Fixture unrelated view</h1>:<><h1>{search.view==='compare'?'Compare analytics':'Web analytics'}</h1><AnalyticsPanel projectId={search.project??project} userId={user} compareView={search.view==='compare'} onAppliedRange={rememberRange} search={search} onNavigate={value=>void navigate({search:{...target({project:search.project??project,view:search.view}),...value}})} onUnauthorized={()=>setSignedOut(true)}/></>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<ToastProvider>{<RouterProvider router={router}/>}</ToastProvider>);
