import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {WebPerformancePanel} from '../src/components/WebPerformancePanel';
import '../src/styles.css';

type Scope={projectId:string;userId:string;query:string;readOwner:string;readEnabled:boolean};
declare global{interface Window{webPerformanceScope?:Scope;webPerformanceFixture:{set:(value:Partial<Scope>)=>void}}}
const initial:Scope={projectId:'40000000-0000-4000-8000-000000000001',userId:'40000000-0000-4000-8000-000000000002',query:'from=2026-10-01&to=2026-10-03&metric=lcp&percentile=75&breakdown=path',readOwner:'initial-entry',readEnabled:true};
function Fixture(){
  const [scope,setScope]=React.useState(()=>window.webPerformanceScope??initial),[callbacks,setCallbacks]=React.useState(0),[settings,setSettings]=React.useState(0),[signedOut,setSignedOut]=React.useState(false),[shown,setShown]=React.useState(true);
  React.useEffect(()=>{window.webPerformanceFixture={set:value=>setScope(old=>({...old,...value}))};},[]);
  return <main className="stack" style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}>
    <p className="hint">Synthetic performance transport fixture. Real source component; no collector, database, authenticated session or compiled application proof.</p>
    <button className="btn" type="button" onClick={()=>setShown(value=>!value)}>{shown?'Unmount performance':'Mount performance'}</button>
    <output aria-label="Unauthorized callbacks">{callbacks}</output><output aria-label="Settings callbacks">{settings}</output><output aria-label="Fixture applied query" style={{overflowWrap:'anywhere',maxWidth:'100%',minWidth:0}}>{scope.query}</output>
    {signedOut?<h1>Fixture signed out</h1>:shown?<WebPerformancePanel {...scope} onNavigate={query=>setScope(old=>({...old,query}))} onUnauthorized={()=>{setCallbacks(value=>value+1);setSignedOut(true);}} onSettings={()=>setSettings(value=>value+1)}/>:<p>Performance unmounted</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
