import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MetaLatestView,type MetaLatestViewProps} from '../src/components/MetaLatestView.tsx';
import '../src/styles.css';

const hostile='<img src=x onerror=alert(1)> & <script>window.fixtureExecuted=true</script>';
const initial={
 prefix:'meta-latest-fixture-',role:'viewer',loaded:true,reading:false,exporting:false,error:'',exportError:'',notice:'',
 profile:{accountLabel:'Synthetic account · 1234567890123456789012345678901234567890',reportLabel:'Campaign by day',currency:'AED',timeZone:'Pacific/Kiritimati',attributionLabel:'Meta-reported mixed attribution; effective ad-set settings unknown.'},
 from:'2026-09-01',to:'2026-09-06',
 result:{rangeLabel:'2026-09-01 to 2026-09-06',asOfLabel:'Read at 2026-10-13T15:00:00.123Z',countLabel:'3 readable rows; review each day’s coverage.',selectionRevision:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123',coverage:[
  {date:'2026-09-01',state:'rows',stateLabel:'Retained rows',countsLabel:'2 rows returned',help:'Latest compatible completed receipt.',receiptId:'10000000-0000-4000-8000-000000000001'},
  {date:'2026-09-02',state:'empty',stateLabel:'Successful empty coverage',countsLabel:'0 returned rows',help:'A complete empty receipt replaced older rows; this is not measured zero activity.',receiptId:'10000000-0000-4000-8000-000000000002'},
  {date:'2026-09-03',state:'missing',stateLabel:'No completed coverage',countsLabel:'Unavailable',help:'No compatible completed receipt covers this day.',receiptId:null},
  {date:'2026-09-04',state:'expired',stateLabel:'Payload expired',countsLabel:'Unavailable',help:'The selected receipt expired; older values are not substituted.',receiptId:'10000000-0000-4000-8000-000000000004'},
  {date:'2026-09-05',state:'deleted',stateLabel:'Payload deleted',countsLabel:'Unavailable',help:'The covered grant requested deletion.',receiptId:'10000000-0000-4000-8000-000000000005'},
  {date:'2026-09-06',state:'incompatible',stateLabel:'Profile cannot be established',countsLabel:'Unavailable',help:hostile,receiptId:null},
 ]},
 rows:[
  {key:'not-displayed-react-key-one',date:'2026-09-01',campaignLabel:hostile,impressions:'0',clicks:'Unavailable',spend:'0.000000',actions:null,actionValues:[]},
  {key:'not-displayed-react-key-two',date:'2026-09-01',campaignLabel:'Second campaign',impressions:'123456789012345678901234567890',clicks:'0',spend:'123456789012345678901234567890.123456789012345678',actions:[],actionValues:null},
  {key:'not-displayed-react-key-three',date:'2026-09-01',campaignLabel:'Third campaign',impressions:'Unavailable',clicks:'0',spend:'Unavailable',actions:[{label:'purchase · 7d_click',value:'0.000000000000000000'},{label:hostile,value:'2.5000'}],actionValues:[{label:'purchase · 1d_view',value:'999999999999.000000000000000001'}]},
 ],canApply:true,canExport:true,canPreviousRows:true,canNextRows:true,
} satisfies Omit<MetaLatestViewProps,`on${string}`>;

function Fixture(){
 const [state,setState]=React.useState<Omit<MetaLatestViewProps,`on${string}`>>(initial);
 const events=React.useRef<{action:string;value?:unknown}[]>([]);
 const patch=(value:Partial<MetaLatestViewProps>)=>setState(old=>({...old,...value}));
 const record=(action:string,value?:unknown)=>events.current.push({action,...(value===undefined?{}:{value})});
 (window as any).metaLatestViewFixture={patch:(value:Partial<MetaLatestViewProps>)=>flushSync(()=>patch(value)),reset:()=>flushSync(()=>{setState(initial);events.current=[];}),calls:()=>events.current,clear:()=>{events.current=[];},initial,hostile};
 const actions={
  onFrom:(value:string)=>{record('from',value);patch({from:value});},onTo:(value:string)=>{record('to',value);patch({to:value});},
  onApply:()=>record('apply'),onReload:()=>record('reload'),onBack:()=>record('back'),
  onPreviousRows:()=>record('previousRows'),onNextRows:()=>record('nextRows'),
  onOpenImport:(value:string)=>record('openImport',value),onExport:()=>record('export'),onCancelExport:()=>record('cancelExport'),
 };
 return <main style={{maxWidth:1120,margin:'24px auto',padding:'0 16px',minWidth:0}}><MetaLatestView {...state} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
