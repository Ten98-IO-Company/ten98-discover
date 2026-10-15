import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {PromptExecutionsPanel,type ExecutionEntry} from '../src/components/PromptExecutionsPanel';
import {AIInsightsPanel} from '../src/components/AIInsightsPanel';
import {AIComparisonPanel} from '../src/components/AIComparisonPanel';
import {AiSuggestionsPanel} from '../src/components/AiSuggestionsPanel';
import {OpenRouterModelPicker,readModelCatalog,validObservedModels} from '../src/components/OpenRouterModelPicker';
import type {InsightFilters} from '../src/server/prompt-insights';
import '../src/styles.css';

type Config={mode:'prompt'|'insights'|'comparison'|'suggestions'|'picker';scope:{userId:string;workspaceId:string;projectId:string};entry?:ExecutionEntry;filters?:InsightFilters;catalog?:unknown;maximum?:1|2;structured?:boolean;selected?:string[];observed?:unknown};
declare global{interface Window{modelUIConfig:Config;modelUI:{set:(value:Config)=>void;selected:()=>string[];refreshes:()=>number}}}
function Picker({config}:{config:Config}){
 const [selected,setSelected]=React.useState(config.selected??[]),[refreshes,setRefreshes]=React.useState(0);
 window.modelUI.selected=()=>selected;window.modelUI.refreshes=()=>refreshes;
 if(config.observed!==undefined&&!validObservedModels(config.observed))throw Error('Invalid observed-options fixture');
 return <><OpenRouterModelPicker catalog={readModelCatalog(config.catalog)} selected={selected} maximum={config.maximum??2} structured={config.structured} disabled={false} refreshing={false} canRefresh onChange={setSelected} onRefresh={()=>setRefreshes(n=>n+1)}/>{config.observed!==undefined&&<p>Observed options checked against the actual captured metadata.</p>}</>;
}
function Fixture(){
 const [config,setConfig]=React.useState(window.modelUIConfig),[destination,setDestination]=React.useState('');
 window.modelUI={set:value=>{setDestination('');setConfig(value);},selected:window.modelUI?.selected??(()=>[]),refreshes:window.modelUI?.refreshes??(()=>0)};
 const common={...config.scope,onUnauthorized:()=>setDestination('Fixture signed out'),onBack:()=>setDestination('Fixture returned')};
 if(destination)return <h1>{destination}</h1>;
 if(config.mode==='picker')return <Picker key={JSON.stringify(config)} config={config}/>;
 if(config.mode==='prompt')return <PromptExecutionsPanel {...common} entry={config.entry!}/>;
 if(config.mode==='suggestions')return <AiSuggestionsPanel {...common}/>;
 if(config.mode==='comparison')return <AIComparisonPanel {...common} filters={config.filters!} filtersLabel={`${config.filters!.from} to ${config.filters!.to} · ${config.filters!.timeZone}`}/>;
 return <AIInsightsPanel {...common} backLabel="Back to project" onOpenComparison={()=>setDestination('Fixture receipt')}/>;
}
const root=createRootRoute({component:()=> <main style={{maxWidth:1200,margin:'20px auto',padding:'0 16px',minWidth:0}}><Outlet/></main>});
const index=createRoute({getParentRoute:()=>root,path:'/',component:Fixture});
const router=createRouter({routeTree:root.addChildren([index])});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
