import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,Link} from '@tanstack/react-router';
import {AiSuggestionsPanel} from '../src/components/AiSuggestionsPanel';
import {PromptsPanel} from '../src/components/PromptsPanel';
import '../src/styles.css';
const initial={workspaceId:'00000000-0000-4000-8000-000000000001',projectId:'00000000-0000-4000-8000-000000000002',userId:'00000000-0000-4000-8000-000000000003'};
declare global{interface Window{suggestionFixture:{scope:(value:Partial<typeof initial>)=>void}}}
function Fixture(){
 const [scope,setScope]=React.useState(initial),[closed,setClosed]=React.useState(false),[unauthorized,setUnauthorized]=React.useState(false);
 window.suggestionFixture={scope:value=>setScope(old=>({...old,...value}))};
 if(unauthorized)return <h1>Fixture signed out</h1>;if(closed)return <h1>Returned to library</h1>;
 return new URLSearchParams(location.search).has('direct')?<AiSuggestionsPanel {...scope} onBack={()=>setClosed(true)} onUnauthorized={()=>setUnauthorized(true)}/>:<PromptsPanel {...scope} onUnauthorized={()=>setUnauthorized(true)}/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><Link to="/" search={{view:'context'}}>Fixture global navigation</Link><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
