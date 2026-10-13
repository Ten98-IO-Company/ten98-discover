import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {AIComparisonPanel} from '../src/components/AIComparisonPanel.tsx';
import '../src/styles.css';
function Fixture(){
 const [scope,setScope]=React.useState({userId:'10000000-0000-4000-8000-000000000001',workspaceId:'20000000-0000-4000-8000-000000000001',projectId:'30000000-0000-4000-8000-000000000001'});
 const [destination,setDestination]=React.useState('');
 (window as any).aiComparisonFixture={scope:(patch:Partial<typeof scope>)=>{setDestination('');setScope(old=>({...old,...patch}));},read:()=>({destination})};
 return <main style={{maxWidth:1200,margin:'24px auto',padding:'0 16px',minWidth:0}}>{destination?<h1>{destination}</h1>:<AIComparisonPanel {...scope} filters={{from:'2025-01-08',to:'2025-01-14',timeZone:'UTC',model:null,promptId:null,tag:null,matcher:'unicode-boundary-v1'}} filtersLabel="8–14 January 2025 · UTC · All models · All prompts" onUnauthorized={()=>setDestination('Fixture signed out')} onBack={()=>setDestination('Fixture insights')}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
