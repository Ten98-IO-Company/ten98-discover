import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useLocation} from '@tanstack/react-router';
import {SessionExplorerPanel} from '../src/components/SessionExplorerPanel';
import {JourneysPanel} from '../src/components/JourneysPanel';
import {parseNavigation,type NavigationSearch} from '../src/lib/navigation';
import '../src/styles.css';
declare global{interface Window{reportNavigationFixture:{freeze:(value:boolean)=>void;navigate:(value:NavigationSearch)=>void};reportEpochs:{search:NavigationSearch;entry:string|undefined;wire:string}[];}}
function Fixture(){
 const search=index.useSearch(),navigate=index.useNavigate(),location=useLocation(),initial=React.useRef(search),[frozen,setFrozen]=React.useState(false),previous=React.useRef(search),[signedOut,setSignedOut]=React.useState(false);
 if(!frozen)previous.current=search;const passed=previous.current,A=initial.current,B:NavigationSearch=A.view==='sessions'?{...A,from:'2026-10-02',to:'2026-10-08'}:{...A,journeyQuery:'from=2026-10-02&to=2026-10-08&timeZone=UTC&kind=all&steps=3'};
 window.reportNavigationFixture={freeze:setFrozen,navigate:value=>void navigate({search:value})};
 React.useEffect(()=>{window.reportEpochs??=[];window.reportEpochs.push({search:passed,entry:location.state.__TSR_key,wire:location.searchStr});},[JSON.stringify(passed),location.state.__TSR_key,location.searchStr]);
 return <><nav aria-label="Fixture navigation"><button type="button" onClick={()=>{void navigate({search:B});void navigate({search:A});}}>Round trip</button></nav><p>Entry <span id="entry">{location.state.__TSR_key}</span></p>{signedOut?<h1>Fixture signed out</h1>:passed.view==='sessions'?<SessionExplorerPanel projectId={passed.project!} userId="30000000-0000-4000-8000-000000000001" search={passed} onNavigate={value=>void navigate({search:{workspace:passed.workspace,project:passed.project,view:'sessions',...value}})} onUnauthorized={()=>setSignedOut(true)}/>:<JourneysPanel projectId={passed.project!} userId="30000000-0000-4000-8000-000000000001" search={passed} onNavigate={value=>void navigate({search:{workspace:passed.workspace,project:passed.project,view:'journeys',...value}})} onUnauthorized={()=>setSignedOut(true)}/>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:16}}><Outlet/></main>}),index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:parseNavigation,component:Fixture}),router=createRouter({routeTree:root.addChildren([index])});createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
