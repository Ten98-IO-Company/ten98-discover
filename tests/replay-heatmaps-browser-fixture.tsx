import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionReplayPanel} from '../src/components/SessionReplayPanel';
import {HeatmapsPanel} from '../src/components/HeatmapsPanel';
import {AnalyticsSettingsPanel} from '../src/components/AnalyticsSettingsPanel';
import '../src/styles.css';

type Scope={projectId:string;userId:string;query:string;readOwner:string;readEnabled:boolean;mode:'replay'|'heatmap'|'settings'};
declare global{interface Window{replayHeatmapsScope?:Scope;replayHeatmapsFixture:{set:(value:Partial<Scope>)=>void}}}
const initial:Scope={projectId:'51000000-0000-4000-8000-000000000001',userId:'51000000-0000-4000-8000-000000000002',query:'',readOwner:'entry-0',readEnabled:true,mode:'replay'};
function Fixture(){
 const [scope,setScope]=React.useState(()=>window.replayHeatmapsScope??initial),[callbacks,setCallbacks]=React.useState(0),[settings,setSettings]=React.useState(0),[signedOut,setSignedOut]=React.useState(false),[shown,setShown]=React.useState(true),entry=React.useRef(0);
 React.useEffect(()=>{window.replayHeatmapsFixture={set:value=>setScope(old=>({...old,...value}))};},[]);
 const props={...scope,onNavigate:(query:string)=>setScope(old=>({...old,query,readOwner:'entry-'+(++entry.current)})),onUnauthorized:()=>{setCallbacks(value=>value+1);setSignedOut(true);},onSettings:()=>setSettings(value=>value+1)};
 return <main className="stack" style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0,gridTemplateColumns:'minmax(0,1fr)'}}>
  <p className="hint">Synthetic saved-name and numeric-heatmap transport. Actual source components; no collector, native authentication, database, live background, replay playback or compiled application proof.</p>
  <button className="btn" type="button" onClick={()=>setShown(value=>!value)}>{shown?'Unmount view':'Mount view'}</button>
  <output aria-label="Unauthorized callbacks">{callbacks}</output><output aria-label="Settings callbacks">{settings}</output><output aria-label="Fixture applied query" style={{overflowWrap:'anywhere',maxWidth:'100%',minWidth:0}}>{scope.query}</output>
  {signedOut?<h1>Fixture signed out</h1>:shown?scope.mode==='settings'?<AnalyticsSettingsPanel projectId={scope.projectId} userId={scope.userId} onUnauthorized={props.onUnauthorized}/>:scope.mode==='replay'?<SessionReplayPanel {...props}/>:<HeatmapsPanel {...props}/>:<p>View unmounted</p>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
