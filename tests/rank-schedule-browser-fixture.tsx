import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {RankSchedulePanel} from '../src/components/RankSchedulePanel.tsx';
import '../src/styles.css';
const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001',trackerId:'50000000-0000-4000-8000-000000000001',quoteId:'80000000-0000-4000-8000-000000000001' as string|undefined,knownQuoteExpiresAt:undefined as string|undefined};
function Panel(){const [current,setCurrent]=React.useState(scope),[closed,setClosed]=React.useState('');(window as any).rankScheduleHarness={scope:(next:Partial<typeof scope>)=>setCurrent(p=>({...p,...next}))};return closed?<h1>{closed}</h1>:<RankSchedulePanel {...current} trackerName="Synthetic schedule tracker" backLabel="Back to quote" onUnauthorized={()=>setClosed('Fixture signed out')} onBack={()=>setClosed('Fixture quote')} onPrepareQuote={()=>setClosed('Fixture full queued quote')}/>;}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture schedule</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel}),elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
createRoot(document.getElementById('root')!).render(<RouterProvider router={createRouter({routeTree:root.addChildren([index,elsewhere])})}/>);
