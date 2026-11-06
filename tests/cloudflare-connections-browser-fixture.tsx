import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute, createRoute, createRouter, Outlet, RouterProvider} from '@tanstack/react-router';
import {Button, Heading, Stack} from '@ten98/ui';
import {CloudflareConnectionsPanel} from '../src/components/CloudflareConnectionsPanel.tsx';
import '../src/styles.css';
declare global {interface Window {cloudflareFixture: {user: (value: string) => void}}}
function Fixture() {
  const [signedOut, setSignedOut] = React.useState(false), [user, setUser] = React.useState('30000000-0000-4000-8000-000000000001');
  React.useEffect(() => { Object.assign(window, {cloudflareFixture: {user: setUser}}); }, []);
  return <Stack gap={4}>{signedOut ? <Heading level={1}>Fixture signed out</Heading> : <CloudflareConnectionsPanel projectId="20000000-0000-4000-8000-000000000001" userId={user} onUnauthorized={() => setSignedOut(true)}/>}<Button onClick={() => void router.navigate({to: '/share/$slug', params: {slug: 'fixture-away'}})}>Leave fixture</Button></Stack>;
}
const rootRoute = createRootRoute({component: () => <Outlet/>});
const fixtureRoute = createRoute({getParentRoute: () => rootRoute, path: '/', component: Fixture});
const awayRoute = createRoute({getParentRoute: () => rootRoute, path: '/share/$slug', component: () => <Heading level={1}>Fixture destination</Heading>});
const router = createRouter({routeTree: rootRoute.addChildren([fixtureRoute, awayRoute])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
