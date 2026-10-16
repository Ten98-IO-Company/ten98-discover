import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {DomainResearchPanel} from '../src/components/DomainResearchPanel';
import '../src/styles.css';

const initial={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
declare global{interface Window{backlinkFixture:{scope:(value:Partial<typeof initial>)=>void;unauthorized:number}}}
function Fixture(){
 const [scope,setScope]=React.useState(initial),[denied,setDenied]=React.useState(0);
 window.backlinkFixture={scope:value=>setScope(old=>({...old,...value})),unauthorized:denied};
 return <main style={{maxWidth:1160,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Backlink research synthetic component fixture</h1><p>Successful API/CSV bodies are synthetic; no database, provider, billing or compiled API proof.</p><DomainResearchPanel {...scope} onUnauthorized={()=>setDenied(n=>n+1)}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
