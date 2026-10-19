import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,Link,Outlet,RouterProvider} from '@tanstack/react-router';
import {AccountPreferencesPanel} from '../src/components/AccountPreferencesPanel';
import {ProviderPanel} from '../src/components/ProviderPanel';
import {DomainsPanel} from '../src/components/DomainsPanel';
import {GoogleReportsPanel} from '../src/components/GoogleReportsPanel';
import {ApiKeysPanel} from '../src/components/ApiKeysPanel';
import {TeamPanel} from '../src/components/TeamPanel';
import {AccountPresentationContext,requestAccountPreferences} from '../src/lib/account-presentation';
import type {AccountPreferencesDto} from '../src/lib/account-preferences';
import '../src/styles.css';

const user='30000000-0000-4000-8000-000000000001',workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001';
function Fixture(){
 const view=index.useSearch().view,[data,setData]=React.useState<AccountPreferencesDto|null>(null),[loading,setLoading]=React.useState(false),[error,setError]=React.useState('');
 async function reload(){setLoading(true);setError('');try{setData(await requestAccountPreferences(new AbortController().signal));}catch(error){setError(String(error));}finally{setLoading(false);}}
 React.useEffect(()=>{if(view==='preferences')void reload();},[view]);
 const unauthorized=()=>{throw Error('Unexpected synthetic authorization failure');};
 return <><nav><Link to="/" search={{view:'project'}}>Leave settings</Link></nav>
 {view==='preferences'?<AccountPresentationContext.Provider value={{data,loading,error,reload,accept:saved=>{setData(saved);return true;},unavailable:message=>{setData(null);setError(message);}}}><AccountPreferencesPanel expectedUserId={user} onUnauthorized={unauthorized}/></AccountPresentationContext.Provider>
 :view==='providers'?<ProviderPanel workspaceId={workspace} onUnauthorized={unauthorized}/>
 :view==='domains'?<DomainsPanel projectId={project} userId={user} onUnauthorized={unauthorized} onInstallTracker={()=>{}}/>
 :view==='google'?<GoogleReportsPanel projectId={project} userId={user} onUnauthorized={unauthorized}/>
 :view==='keys'?<ApiKeysPanel workspaceId={workspace} onUnauthorized={unauthorized}/>
 :view==='team'?<TeamPanel workspaceId={workspace} userId={user} onChanged={async()=>{}} onUnauthorized={unauthorized}/>
 :<h1>Fixture away</h1>}</>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',validateSearch:(value:Record<string,unknown>)=>({view:typeof value.view==='string'?value.view:'providers'}),component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
