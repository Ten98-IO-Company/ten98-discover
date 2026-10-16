import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {UtmPanel} from '../src/components/UtmPanel';
import '../src/styles.css';
const first='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
function Fixture(){
  const [project,setProject]=React.useState(first),[user,setUser]=React.useState('30000000-0000-4000-8000-000000000001'),[shown,setShown]=React.useState(true),[denied,setDenied]=React.useState(false),[callbacks,setCallbacks]=React.useState(0);
  return <main className="stack" style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}>
    <p className="hint">Synthetic native-shaped UTM transport fixture. No database or authenticated API acceptance.</p>
    <nav className="row" aria-label="Fixture scope"><button type="button" className="btn" onClick={()=>setProject(value=>value===first?other:first)}>Change project</button><button type="button" className="btn" onClick={()=>setUser(value=>value.endsWith('1')?'30000000-0000-4000-8000-000000000002':'30000000-0000-4000-8000-000000000001')}>Change account</button><button type="button" className="btn" onClick={()=>setShown(value=>!value)}>{shown?'Unmount report':'Mount report'}</button></nav>
    <output aria-label="Unauthorized callbacks">{callbacks}</output>
    {denied?<h1>Fixture signed out</h1>:shown?<UtmPanel key={user+':'+project} projectId={project} userId={user} onUnauthorized={()=>{setCallbacks(value=>value+1);setDenied(true);}}/>:<p>Report unmounted</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
