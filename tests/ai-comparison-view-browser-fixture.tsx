import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AIComparisonView,type AIComparisonViewProps} from '../src/components/AIComparisonView.tsx';
import '../src/styles.css';

const hostile='<img src=x onerror=alert(1)> <script>window.comparisonExecuted=true</script>';
const long='opaque-'+ '9'.repeat(160);
const initial={prefix:'comparison-view-',role:'owner',reading:false,exporting:false,dirty:false,canApply:true,error:null,notice:null,
 filtersLabel:'Applied filters: 7–13 October 2026 · Asia/Dubai · one archived prompt · exact tag',cohort:'current-neutral',
 report:{scopeLabel:'7–13 October versus 30 September–6 October 2026',snapshotLabel:'Context revision7 · exact synthetic snapshot',cohortLabel:'Applied: Currently classified neutral prompts',
  statusLabel:'Not comparable · supplied coverage decision',basisLabel:'Each comparable prompt/model/settings cell has equal weight.',warnings:['Some original settings could not be reconstructed.',hostile],
  periods:[{id:'current',label:'Current period',range:'2026-10-07 to 2026-10-13',attempted:'12',eligible:'11',usable:'9',identityUnavailable:'1',identityInvalid:'1',matched:'3 / 5',details:'90% coverage does not mean every cell matched.'},
   {id:'previous',label:'Previous period',range:'2026-09-30 to 2026-10-06',attempted:'8',eligible:'0',usable:'0',identityUnavailable:'0',identityInvalid:'0',matched:'0 / 5',details:'Expired evidence is unavailable, not a negative answer.'}],
  metrics:[{id:'brand',name:'Synthetic brand',current:'1 / 3 (33.333333%)',previous:'2 / 5 (40%)',delta:'-6.666667 pp',citationsCurrent:'0',citationsPrevious:'Unavailable',citationsDelta:'Unavailable'},
   {id:'other',name:hostile,current:'Unavailable',previous:'0 / 2 (0%)',delta:'Unavailable',citationsCurrent:'1 / 3 (33.333333%)',citationsPrevious:'0 / 2 (0%)',citationsDelta:'+33.333333 pp'}],
  entities:[{id:'brand',name:'Synthetic brand'},{id:'other',name:hostile}],entityId:'brand',view:'cells',outcome:'all',evidenceLabel:'All comparison cells · current context',pageLabel:'Page2 · 2 of7 cells',canPrevious:true,canNext:true,canExport:true,
  cells:[{id:'cell-one',prompt:'Immutable authored prompt '+hostile,model:'GPT-4o mini',identity:long,status:'Matched cell',current:'1 / 3 usable',previous:'2 / 5 usable',currentMentions:'1 / 3',previousMentions:'2 / 5',currentCitations:'0 / 3',previousCitations:'1 / 5',canCurrent:true,canPrevious:true},
   {id:'cell-two',prompt:'Archived prompt',model:'GPT-4o',identity:'Identity unavailable',status:'Previous-only cell',current:'Unavailable',previous:'0',currentMentions:'Unavailable',previousMentions:'0 / 2',currentCitations:'Unavailable',previousCitations:'0 / 2',canCurrent:false,canPrevious:false}],
  executions:[{id:'execution-one',requestedAt:'2026-10-13T12:00:00.123456Z',model:'Requested GPT-4o mini · resolved GPT-4o mini',eligibility:'Eligible answer · charge uncertain',identity:long,matches:hostile,canOpen:true},
   {id:'execution-two',requestedAt:'2026-10-12T12:00:00.123456Z',model:'Requested GPT-4o · resolved unavailable',eligibility:'Expired answer',identity:'Unavailable',matches:'Unavailable',canOpen:false}],
 },
} satisfies Omit<AIComparisonViewProps,`on${string}`>;
function freeze(value:unknown){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}freeze(initial);
function Fixture(){
 const [state,setState]=React.useState<Omit<AIComparisonViewProps,`on${string}`>>(initial),events=React.useRef<unknown[][]>([]);
 const record=(...args:unknown[])=>events.current.push(args);
 (window as any).aiComparisonViewFixture={initial,patch:(value:Partial<AIComparisonViewProps>)=>flushSync(()=>setState(old=>({...old,...value}))),reset:()=>flushSync(()=>{setState(initial);events.current=[];}),calls:()=>events.current,clear:()=>{events.current=[];}};
 const actions:Pick<AIComparisonViewProps,Extract<keyof AIComparisonViewProps,`on${string}`>>={
  onCohortChange:value=>{record('cohort',value);setState(old=>({...old,cohort:value}));},onApply:()=>record('apply'),onReload:()=>record('reload'),onBack:()=>record('back'),
  onEntityChange:value=>{record('entity',value);setState(old=>({...old,report:old.report?{...old.report,entityId:value}:null}));},
  onView:value=>{record('view',value);setState(old=>({...old,report:old.report?{...old.report,view:value}:null}));},
  onOutcome:value=>{record('outcome',value);setState(old=>({...old,report:old.report?{...old.report,outcome:value}:null}));},
  onCell:(id,period)=>record('cell',id,period),onOpenComparison:id=>record('open',id),onPrevious:()=>record('previous'),onNext:()=>record('next'),onExport:()=>record('export'),onCancelExport:()=>record('cancelExport'),
 };
 return <main style={{maxWidth:1200,margin:'24px auto',padding:'0 16px',minWidth:0}}><AIComparisonView {...state} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
