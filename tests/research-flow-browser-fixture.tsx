import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation,defaultStringifySearch} from '@tanstack/react-router';
import {AISearchPanel} from '../src/components/AISearchPanel';
import {aiSearchPriceEvidence,aiSearchProfileId} from '../src/lib/ai-search';
import {parseNavigation,readAISearchIntent,aiSearchIntentQuery,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';

// Synthetic UI evidence only: no SQL DTO, native authorization or provider acceptance.
const scope={workspace:'10000000-0000-4000-8000-000000000001',project:'20000000-0000-4000-8000-000000000001',user:'30000000-0000-4000-8000-000000000001'};
const overview={role:'owner',profileId:aiSearchProfileId,price:aiSearchPriceEvidence(),catalog:null,connections:[{id:'40000000-0000-4000-8000-000000000001',name:'Synthetic connection',revision:1,checkStatus:'ok'}],runs:[],nextCursor:null};
(window as unknown as {__researchFixture:unknown}).__researchFixture={scope,overview};
const target=():NavigationSearch=>({workspace:scope.workspace,project:scope.project,view:'ai-search'});
if(!window.location.search){const intent=readAISearchIntent()!;history.replaceState(null,'', '/'+defaultStringifySearch({...target(),aiSearchQuery:aiSearchIntentQuery({...intent,section:'captures',create:true})}));}
function Fixture(){const search=index.useSearch(),navigate=index.useNavigate(),location=useLocation();return <><p>Synthetic task-flow fixture · {location.pathname}</p><AISearchPanel workspaceId={scope.workspace} projectId={scope.project} userId={scope.user} search={search} onNavigate={value=>void navigate({search:{...target(),...value}})} onUnauthorized={()=>{throw Error('Unexpected synthetic authorization change');}} onPrompts={()=>{throw Error('Prompt-library navigation is outside this focused fixture');}} onProviders={()=>{throw Error('Provider navigation is outside this focused fixture');}}/></>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);