import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectDeletePanel} from '../src/components/ProjectDeletePanel';
import {AnalyticsSettingsPanel} from '../src/components/AnalyticsSettingsPanel';
import type {ProjectDeleteInput} from '../src/lib/project-delete';
import '../src/styles.css';
const workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',user='30000000-0000-4000-8000-000000000001';
function Fixture(){
 const[account,setAccount]=React.useState(user),[current,setProject]=React.useState(project),[wid,setWorkspace]=React.useState(workspace),[mounted,setMounted]=React.useState(true),[denied,setDenied]=React.useState(0),[deleted,setDeleted]=React.useState(0),[,render]=React.useState(0),lease=React.useRef({entry:0,enabled:true}),pending=React.useRef<ProjectDeleteInput|null>(null),identity=React.useRef('');
 const next=JSON.stringify([wid,current,account]);if(identity.current!==next){pending.current=null;identity.current=next;}const entry=lease.current.entry,isCurrent=()=>lease.current.entry===entry&&lease.current.enabled;
 (window as unknown as {projectDeleteFixture:{deny:()=>void}}).projectDeleteFixture={deny:()=>{lease.current.entry++;lease.current.enabled=false;render(n=>n+1);}};
 const full=new URLSearchParams(location.search).get('parent')==='1',props={workspaceId:wid,projectId:current,userId:account,readOwner:String(entry),readEnabled:lease.current.enabled,isCurrent,onUnauthorized:()=>setDenied(n=>n+1),onDeleted:()=>{setDeleted(n=>n+1);setMounted(false);}};
 return <><nav aria-label="Synthetic identity controls" className="row" style={{flexWrap:'wrap'}}><button className="btn" onClick={()=>{lease.current.entry++;setAccount(value=>value===user?user.replace(/1$/,'2'):user);}}>Change account</button><button className="btn" onClick={()=>{lease.current.entry++;setProject(value=>value===project?project.replace(/1$/,'2'):project);}}>Change project</button><button className="btn" onClick={()=>{lease.current.entry++;render(n=>n+1);}}>Recheck current access</button><button className="btn" onClick={()=>{lease.current.entry++;setWorkspace(value=>value===workspace?workspace.replace(/1$/,'2'):workspace);}}>Change workspace</button></nav><output aria-label="Unauthorized callbacks">{denied}</output><output aria-label="Deleted callbacks">{deleted}</output><main className="card stack" style={{maxWidth:900,margin:'16px auto',minWidth:0}}><h1>Website data</h1><p>Synthetic component fixture. No website or database is connected.</p>{mounted&&(full?<AnalyticsSettingsPanel {...props}/>:<ProjectDeletePanel {...props} authorityOwner={String(entry)} pendingRequest={pending}/>)}</main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
