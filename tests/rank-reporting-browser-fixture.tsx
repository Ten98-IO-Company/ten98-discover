import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Link,Outlet,type AnyRouter} from '@tanstack/react-router';
import {RankReportingPanel} from '../src/components/RankReportingPanel.tsx';
import {RankTrackingPanel} from '../src/components/RankTrackingPanel.tsx';
import type {RankTracker} from '../src/components/RankTrackingView.tsx';
import '../src/styles.css';
const scope={workspaceId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',userId:'30000000-0000-4000-8000-000000000001',active:true};
const tracker:RankTracker={id:'50000000-0000-4000-8000-000000000001',name:'Synthetic reporting tracker',domain:'example.com',countryCode:2840,countryIso:'US',locationCode:2840,locationName:'United States',locationType:'Country',languageCode:'en',languageName:'English',devices:'mobile',depth:100,maxCrawlPages:1,revision:1,keywordsRevision:1,authoredRevision:1,keywordCount:2,archivedAt:null,createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z',schedule:{interval:'manual',enabled:false,nextDueAt:null}};
function Panel({parent=false}:{parent?:boolean}){
 const [current,setCurrent]=React.useState(scope),[closed,setClosed]=React.useState(''),opened=React.useRef<string[]>([]);
 (window as any).rankReportingHarness={scope:(next:Partial<typeof scope>)=>setCurrent(p=>({...p,...next})),opened:()=>opened.current};
 if(closed)return <h1>{closed}</h1>;
 return parent?<RankTrackingPanel {...current} origin="https://example.com" onUnauthorized={()=>setClosed('Fixture signed out')} onOpenProviders={()=>setClosed('Unexpected provider setup')}/>:
 <div hidden={!current.active}><RankReportingPanel {...current} tracker={tracker} onUnauthorized={()=>setClosed('Fixture signed out')} onBack={()=>setClosed('Fixture tracker')} onOpenRun={id=>opened.current.push('run:'+id)} onOpenKeyword={id=>opened.current.push('keyword:'+id)} onCheckHistory={()=>opened.current.push('history')}/></div>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1200,margin:'20px auto',padding:'0 16px'}}><nav className="row"><Link<AnyRouter> to="/">Fixture reporting</Link><Link<AnyRouter> to="/elsewhere">Fixture elsewhere</Link></nav><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Panel}),parent=createRoute({getParentRoute:()=>root,path:'/parent',component:()=> <Panel parent/>}),elsewhere=createRoute({getParentRoute:()=>root,path:'/elsewhere',component:()=> <h1>Fixture elsewhere page</h1>});
createRoot(document.getElementById('root')!).render(<RouterProvider router={createRouter({routeTree:root.addChildren([index,parent,elsewhere])})}/>);
