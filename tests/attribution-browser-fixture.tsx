import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link,useRouter,useLocation} from '@tanstack/react-router';
import {AttributionPanel,readAttributionResult} from '../src/components/AttributionPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
Object.assign(window,{__readAttribution:(data:unknown,query:string,id:string)=>{try{readAttributionResult(data,query,id);return true;}catch{return false;}}});
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),current=useLocation(),router=useRouter(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);const target=(id=project):NavigationSearch=>({workspace,project:id,view:'attribution'});
 return <><nav aria-label="Fixture scope"><button type="button" data-entry={current.state.__TSR_key} onClick={()=>router.history.push(current.href)}>Fixture new history entry</button><Link to="/" search={target()}>Fixture first project</Link> <Link to="/" search={target(other)}>Fixture other project</Link> <Link to="/" search={{workspace,project,view:'project'}}>Fixture Analytics</Link> <button className="btn" type="button" onClick={()=>setUser(value=>value.endsWith('1')?'30000000-0000-4000-8000-000000000002':'30000000-0000-4000-8000-000000000001')}>Fixture change account</button></nav>{signedOut?<h1>Fixture signed out</h1>:search.view==='attribution'?<AttributionPanel projectId={search.project??project} userId={user} search={search} onNavigate={value=>void navigate({search:{...target(search.project),...value}})} onUnauthorized={()=>setSignedOut(true)}/>:<h1>Fixture Analytics</h1>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
