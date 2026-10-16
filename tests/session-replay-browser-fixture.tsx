import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionReplayPanel} from '../src/components/SessionReplayPanel';
import '../src/styles.css';
type Scope={projectId:string;userId:string;query:string;readOwner:string;readEnabled:boolean};
declare global{interface Window{sessionReplayScope?:Scope;sessionReplayFixture:{set:(value:Partial<Scope>)=>void}}}
const initial:Scope={projectId:'41000000-0000-4000-8000-000000000001',userId:'41000000-0000-4000-8000-000000000002',query:'',readOwner:'initial-entry',readEnabled:true};
function Fixture(){
 const [scope,setScope]=React.useState(()=>window.sessionReplayScope??initial),[callbacks,setCallbacks]=React.useState(0),[settings,setSettings]=React.useState(0),[signedOut,setSignedOut]=React.useState(false),[shown,setShown]=React.useState(true);
 React.useEffect(()=>{window.sessionReplayFixture={set:value=>setScope(old=>({...old,...value}))};},[]);
 return <main className="stack" style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0,gridTemplateColumns:'minmax(0,1fr)'}}>
  <p className="hint">Synthetic replay transport and player-peer fixture. Real source component; no collector, rrweb playback, database, native authentication or compiled application proof.</p>
  <button type="button" className="btn" onClick={()=>setShown(value=>!value)}>{shown?'Unmount replay':'Mount replay'}</button>
  <output aria-label="Unauthorized callbacks">{callbacks}</output><output aria-label="Settings callbacks">{settings}</output><output aria-label="Fixture applied query" style={{overflowWrap:'anywhere',minWidth:0,maxWidth:'100%'}}>{scope.query}</output>
  {signedOut?<h1>Fixture signed out</h1>:shown?<SessionReplayPanel {...scope} onNavigate={query=>setScope(old=>({...old,query}))} onUnauthorized={()=>{setCallbacks(value=>value+1);setSignedOut(true);}} onSettings={()=>setSettings(value=>value+1)}/>:<p>Replay unmounted</p>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);