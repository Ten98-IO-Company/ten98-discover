// Synthetic wire only. Real component and application/library styles; no Google authorization proof.
import {ToastProvider} from '@ten98/ui';
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {GoogleReportsPanel} from '../src/components/GoogleReportsPanel';
import '../src/styles.css';
type Scope={projectId:string;userId:string};
declare global{interface Window{googleLibraryScope:Scope;googleLibraryFixture:{setScope:(scope:Scope)=>void;unauthorized:()=>number}}}
function Fixture(){
 const [scope,setScope]=React.useState(window.googleLibraryScope),[signedOut,setSignedOut]=React.useState(false),unauthorized=React.useRef(0);
 window.googleLibraryFixture={setScope:next=>{setSignedOut(false);setScope(next);},unauthorized:()=>unauthorized.current};
 return <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Google reports</h1>{signedOut?<p role="status">Fixture signed out</p>:<GoogleReportsPanel {...scope} onUnauthorized={()=>{unauthorized.current++;setSignedOut(true);}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<ToastProvider>{<Fixture/>}</ToastProvider>);
