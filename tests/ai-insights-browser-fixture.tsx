import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {AIInsightsPanel} from '../src/components/AIInsightsPanel.tsx';
import '../src/styles.css';

function Fixture(){
 const [scope,setScope]=React.useState({userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'});
 const [destination,setDestination]=React.useState(''),[opened,setOpened]=React.useState<string[]>([]);
 (window as any).aiInsightsFixture={scope:(patch:Partial<typeof scope>)=>{setDestination('');setScope(old=>({...old,...patch}));},read:()=>({destination,opened})};
 return <main style={{maxWidth:1200,margin:'24px auto',padding:'0 16px',minWidth:0}}>{destination?<h1>{destination}</h1>:<AIInsightsPanel {...scope} onUnauthorized={()=>setDestination('Fixture signed out')} onBack={()=>setDestination('Fixture project')} backLabel="Back to project" onOpenComparison={(comparisonId,promptId)=>{setOpened([comparisonId,promptId]);setDestination('Fixture comparison');}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
