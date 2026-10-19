import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {KeywordResearchPanel} from '../src/components/KeywordResearchPanel';
import {DomainResearchPanel} from '../src/components/DomainResearchPanel';
import '../src/styles.css';

const initial={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
declare global{interface Window{domainOverviewFixture:{scope:(value:Partial<typeof initial>)=>void;unauthorized:number}}}
function Fixture(){
 const Panel=new URLSearchParams(location.search).get('fixture')==='keywords'?KeywordResearchPanel:DomainResearchPanel;
 const [scope,setScope]=React.useState(initial),[denied,setDenied]=React.useState(0);
 window.domainOverviewFixture={scope:value=>setScope(old=>({...old,...value})),unauthorized:denied};
 return <main style={{maxWidth:1160,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Domain SEO synthetic component fixture</h1><p>Successful API responses in this fixture are synthetic; no provider, database or compiled API proof.</p><Panel {...scope} onUnauthorized={()=>setDenied(n=>n+1)}/></main>;
}
const route=createRootRoute({component:Fixture}),router=createRouter({routeTree:route});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
