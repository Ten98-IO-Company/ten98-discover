import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {GoogleReportsPanel} from '../src/components/GoogleReportsPanel';
import '../src/styles.css';

type Scope={projectId:string;userId:string};
declare global{interface Window{googleOrganicScope:Scope;googleOrganicFixture:{setScope:(scope:Scope)=>void;unauthorized:()=>number}}}
function Fixture(){
 const [scope,setScope]=React.useState(window.googleOrganicScope),[signedOut,setSignedOut]=React.useState(false),unauthorized=React.useRef(0);
 window.googleOrganicFixture={setScope:next=>{setSignedOut(false);setScope(next);},unauthorized:()=>unauthorized.current};
 return <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Google reports</h1>{signedOut?<p role="status">Fixture signed out</p>:<GoogleReportsPanel {...scope} onUnauthorized={()=>{unauthorized.current++;setSignedOut(true);}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
