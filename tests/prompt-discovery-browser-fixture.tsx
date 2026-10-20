import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,Link,Outlet,RouterProvider} from '@tanstack/react-router';
import {PromptsPanel} from '../src/components/PromptsPanel';
import '../src/styles.css';

type Scope={workspaceId:string;projectId:string;userId:string};
declare global {interface Window {promptDiscoveryScope?:Scope;promptDiscoveryFixture:{set:(value:Partial<Scope>)=>void}}}
const initial:Scope={workspaceId:'71000000-0000-4000-8000-000000000001',projectId:'71000000-0000-4000-8000-000000000002',userId:'synthetic-prompt-user'};
function Fixture(){
 const[scope,setScope]=useState(()=>window.promptDiscoveryScope??initial),[unauthorized,setUnauthorized]=useState(0),[captures,setCaptures]=useState<[string,string|null,boolean][]>([]);
 useEffect(()=>{window.promptDiscoveryFixture={set:value=>setScope(old=>({...old,...value}))};},[]);
 return <main className="stack" style={{maxWidth:1100,margin:'20px auto',padding:20}}>
  <p>Synthetic prompt discovery fixture: actual source UI, no database, real authentication, measured searches or provider calls.</p>
  <Link to={'/away' as never} search={{} as never}>Leave prompts</Link><output aria-label="Fixture project">{scope.projectId}</output><output aria-label="Unauthorized callbacks">{unauthorized}</output><output aria-label="AI search callbacks">{JSON.stringify(captures)}</output>
  {unauthorized?<h1>Fixture signed out</h1>:<PromptsPanel {...scope} onAISearch={(...args)=>setCaptures(old=>[...old,args])} onUnauthorized={()=>setUnauthorized(value=>value+1)}/>}
 </main>;
}
// The application globally registers its router; these casts scope Link typing to this fixture's real runtime routes.
const root=createRootRoute({component:()=> <Outlet/>}),index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture}),away=createRoute({getParentRoute:()=>root,path:'/away',component:()=> <main><h1>Fixture away</h1><Link to='/' search={{} as never}>Return to prompts</Link></main>});
const router=createRouter({routeTree:root.addChildren([index,away])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
