import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {GoogleReportsPanel} from '../src/components/GoogleReportsPanel';
import '../src/styles.css';

declare global{interface Window{__inspectionFixture:{projectId:string;userId:string};__inspectionActor:(userId:string)=>void;__inspectionProject:(projectId:string)=>void;}}
function Fixture(){
 const [userId,setUserId]=React.useState(window.__inspectionFixture.userId),[projectId,setProjectId]=React.useState(window.__inspectionFixture.projectId),[unauthorized,setUnauthorized]=React.useState(false);
 window.__inspectionActor=setUserId;
 window.__inspectionProject=setProjectId;
 return <main style={{maxWidth:1000,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Google reports</h1>{unauthorized?<p role="alert">Fixture signed out</p>:<GoogleReportsPanel projectId={projectId} userId={userId} onUnauthorized={()=>setUnauthorized(true)}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
