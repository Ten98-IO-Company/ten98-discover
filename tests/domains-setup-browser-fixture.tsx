import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider} from '@tanstack/react-router';
import {DomainsPanel} from '../src/components/DomainsPanel';
import {allowedView, parseNavigation, type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';

const workspace = '10000000-0000-4000-8000-000000000001';
const first = '20000000-0000-4000-8000-000000000001';
const second = '20000000-0000-4000-8000-000000000002';

function Fixture() {
  const search = index.useSearch(), navigate = index.useNavigate();
  const [user, setUser] = React.useState('30000000-0000-4000-8000-000000000001');
  const [role, setRole] = React.useState('owner');
  const [signedOut, setSignedOut] = React.useState(false);
  const project = search.project ?? first;
  const target = (view: NavigationSearch['view']): NavigationSearch => ({workspace, project, view});
  return <>
    <nav aria-label="Fixture navigation" className="row">
      <Link to="/" search={{...target('domains'), project: first}}>First project</Link>
      <Link to="/" search={{...target('domains'), project: second}}>Other project</Link>
      <button type="button" className="btn" onClick={() => setUser('30000000-0000-4000-8000-000000000002')}>Change account</button>
      <button type="button" className="btn" onClick={() => setRole('viewer')}>Become viewer</button>
    </nav>
    {signedOut ? <h1>Fixture signed out</h1> : search.view === 'installation' ? <><h1>Tracker installation</h1><p data-testid="installation-scope">{search.workspace} / {search.project}</p></> : !allowedView('domains', role, false) ? <h1>Domain management unavailable for this role</h1> : <DomainsPanel projectId={project} userId={user} onUnauthorized={() => setSignedOut(true)} onInstallTracker={() => void navigate({search: target('installation')})}/>}
  </>;
}
const root = createRootRoute({component: () => <main style={{maxWidth: 1100, margin: '20px auto', padding: '0 16px', minWidth: 0}}><Outlet/></main>});
const index = createRoute({getParentRoute: () => root, path: '/', validateSearch: parseNavigation, component: Fixture});
const router = createRouter({routeTree: root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
