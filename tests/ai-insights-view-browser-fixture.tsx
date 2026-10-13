import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AIInsightsView,type AIInsightsViewProps} from '../src/components/AIInsightsView.tsx';
import '../src/styles.css';

const hostile='<img src=x onerror=alert(1)> & <script>window.fixtureExecuted=true</script>';
const initial={prefix:'ai-insights-view-',role:'owner',reading:false,exporting:false,error:'',notice:'',filterError:'',dirty:false,
 draft:{from:'2026-10-07',to:'2026-10-13',timeZone:'Asia/Dubai',model:'',promptId:'prompt-old',tag:'',matcher:'unicode-boundary-v1'},promptSearch:'',
 promptOptions:[{id:'prompt-old',label:'Original prompt (archived, disabled)'},{id:'prompt-other',label:hostile}],canPreviousPrompts:true,canNextPrompts:true,canApply:true,backLabel:'Back to project',
 report:{scopeLabel:'Applied: 7–13 October 2026 · Asia/Dubai · all models',contextLabel:'Recomputed from retained answers using current project context',snapshotLabel:'Context revision 7 · unicode-boundary-v1 · synthetic snapshot',warnings:['No market or language was recorded.',hostile],
 coverage:[{label:'Attempted',value:'12'},{label:'Eligible',value:'4'},{label:'Queued',value:'1'},{label:'Running',value:'1'},{label:'No answer',value:'1'},{label:'Empty',value:'1'},{label:'Truncated',value:'1'},{label:'Content-filtered',value:'1'},{label:'Expired',value:'1'},{label:'Invalid',value:'1'}],
 metrics:[{id:'brand',name:'Synthetic brand',visibility:'2 / 4 (50%)',shareOfVoice:'2 / 4 (50%)',citations:'1 / 4 (25%)',canDrill:true},{id:'competitor',name:hostile,visibility:'0 / 4 (0%)',shareOfVoice:'0 / 4 (0%)',citations:'0 / 4 (0%)',canDrill:false}],
 dailyEntityId:'brand',dailyEntities:[{id:'brand',label:'Synthetic brand'},{id:'competitor',label:hostile}],dailyRows:[{date:'2026-10-12',attempted:'0',eligible:'0',visibility:'Unavailable',shareOfVoice:'Unavailable',citations:'Unavailable'},{date:'2026-10-13',attempted:'12',eligible:'4',visibility:'2 / 4 (50%)',shareOfVoice:'2 / 4 (50%)',citations:'1 / 4 (25%)'}],
 drilldownLabel:'All executions · full applied population',rowCountLabel:'2 of 12 executions on this page',executions:[{id:'execution-one',requestedAt:'2026-10-13T12:00:00.123456Z',model:'Requested GPT-4o mini · resolved GPT-4o mini',eligibility:'Eligible answer; charge uncertain',matches:hostile},{id:'execution-two',requestedAt:'2026-10-12T12:00:00.123456Z',model:'Requested GPT-4o · resolved model unavailable',eligibility:'Expired answer',matches:'Unavailable'}],canPrevious:true,canNext:true,canExport:true},
} satisfies Omit<AIInsightsViewProps,`on${string}`>;
function freeze(value:unknown){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}freeze(initial);
function Fixture(){
 const [state,setState]=React.useState<Omit<AIInsightsViewProps,`on${string}`>>(initial),events=React.useRef<{action:string;value?:string;entityId?:string}[]>([]);
 const record=(action:string,value?:string,entityId?:string)=>events.current.push({action,...value===undefined?{}:{value},...entityId===undefined?{}:{entityId}});
 (window as any).aiInsightsViewFixture={initial,patch:(value:Partial<AIInsightsViewProps>)=>flushSync(()=>setState(old=>({...old,...value}))),reset:()=>flushSync(()=>{setState(initial);events.current=[];}),calls:()=>events.current,clear:()=>{events.current=[];}};
 const actions:Pick<AIInsightsViewProps,Extract<keyof AIInsightsViewProps,`on${string}`>>={
  onChange:(field,value)=>{record('change',field+':'+value);setState(old=>({...old,draft:{...old.draft,[field]:value}}));},onPromptSearchChange:value=>{record('promptSearch',value);setState(old=>({...old,promptSearch:value}));},
  onSearchPrompts:()=>record('searchPrompts'),onPreviousPrompts:()=>record('previousPrompts'),onNextPrompts:()=>record('nextPrompts'),onApply:()=>record('apply'),onReload:()=>record('reload'),onBack:()=>record('back'),
  onDailyEntity:value=>{record('dailyEntity',value);setState(old=>({...old,report:old.report?{...old.report,dailyEntityId:value}:null}));},onDrilldown:(value,entityId)=>record('drilldown',value,entityId),
  onPrevious:()=>record('previous'),onNext:()=>record('next'),onOpenExecution:value=>record('open',value),onExport:()=>record('export'),onCancelExport:()=>record('cancelExport'),
 };
 return <main style={{maxWidth:1160,margin:'24px auto',padding:'0 16px',minWidth:0}}><AIInsightsView {...state} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
