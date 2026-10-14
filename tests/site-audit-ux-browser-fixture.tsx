import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {SiteAuditPanel} from '../src/components/SiteAuditPanel.tsx';
import '../src/styles.css';

function Fixture(){
  const [destination,setDestination]=React.useState('');
  const [scope,setScope]=React.useState({projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'});
  React.useEffect(()=>{Object.assign(window,{auditFixture:{scope:setScope}});},[]);
  return <div className="shell">
    <aside className="side"><p>Audit test workspace</p></aside>
    <main className="main">
      <header className="app-bar">Synthetic project</header>
      <div className="page-content"><h1>Site audits</h1>
        {destination?<h2>{destination}</h2>:<SiteAuditPanel
          projectId={scope.projectId}
          userId={scope.userId}
          onUnauthorized={()=>setDestination('Fixture signed out')}
          onOpenDomains={()=>setDestination('Fixture domains')}
          onOpenRetention={()=>setDestination('Fixture retention')}/>}
      </div>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
