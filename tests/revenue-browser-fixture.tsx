import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link,useLocation,useRouter} from '@tanstack/react-router';
import {RevenuePanel,readRevenueResult} from '../src/components/RevenuePanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
// Reader accepts unchanged SQL DTOs; browser routing rebinds only projectId explicitly.
Object.assign(window,{__readRevenue:(data:unknown,query:string,id:string,expectedRoute?:'report'|'sessions'|'detail')=>{try{readRevenueResult(data,query,id,expectedRoute??(data as {route?:'report'|'sessions'|'detail'}).route??'report',(data as {detail?:{visitorKey:string}|null}).detail?.visitorKey??null,(data as {sessions:{search:string}}).sessions.search,(data as {paging:{limit:number}}).paging.limit);return true;}catch{return false;}}});
function Fixture(){const current=useLocation(),router=useRouter();const search=index.useSearch(),navigate=index.useNavigate(),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[signedOut,setSignedOut]=React.useState(false);const target=(id=project):NavigationSearch=>({workspace,project:id,view:'revenue'});
 return <><nav aria-label="Fixture scope"><Link to="/" search={target()}>Fixture first project</Link> <Link to="/" search={target(other)}>Fixture other project</Link> <Link to="/" search={{workspace,project,view:'project'}}>Fixture Analytics</Link> <button className="btn" type="button" data-entry={current.state.__TSR_key} onClick={()=>router.history.push(current.href)}>Fixture same scope entry</button> <button className="btn" type="button" onClick={()=>setUser(value=>value.endsWith('1')?'30000000-0000-4000-8000-000000000002':'30000000-0000-4000-8000-000000000001')}>Fixture change account</button></nav>{signedOut?<h1>Fixture signed out</h1>:search.view==='revenue'?<RevenuePanel projectId={search.project??project} userId={user} search={search} onNavigate={value=>void navigate({search:{...target(search.project),...value}})} onUnauthorized={()=>setSignedOut(true)}/>:<h1>Fixture Analytics</h1>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
