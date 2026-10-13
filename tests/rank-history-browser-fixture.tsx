import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {RankHistoryPanel} from '../src/components/RankHistoryPanel.tsx';
import type {RankTracker} from '../src/components/RankTrackingView.tsx';
import '../src/styles.css';
const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001'};
const tracker:RankTracker={id:'50000000-0000-4000-8000-000000000001',name:'Synthetic history tracker',domain:'example.com',countryCode:2840,countryIso:'US',locationCode:2840,locationName:'United States',locationType:'Country',languageCode:'en',languageName:'English',devices:'mobile',depth:10,maxCrawlPages:1,revision:1,keywordsRevision:1,authoredRevision:1,keywordCount:3,archivedAt:null,createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z',schedule:{interval:'manual',enabled:false,nextDueAt:null}};
function Panel(){
 const [current,setCurrent]=React.useState(scope),[closed,setClosed]=React.useState(''),opened=React.useRef<string[]>([]);
 (window as any).rankHistoryHarness={scope:(next:Partial<typeof scope>)=>setCurrent(p=>({...p,...next})),opened:()=>opened.current};
 return closed?<h1>{closed}</h1>:<RankHistoryPanel {...current} tracker={tracker} onUnauthorized={()=>setClosed('Fixture signed out')} onBack={()=>setClosed('Fixture tracker')} onOpenRun={id=>opened.current.push(id)}/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture observations</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel}),elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
createRoot(document.getElementById('root')!).render(<RouterProvider router={createRouter({routeTree:root.addChildren([index,elsewhere])})}/>);
