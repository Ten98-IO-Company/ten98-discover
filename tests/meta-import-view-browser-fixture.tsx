import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MetaImportView,type MetaImportViewProps} from '../src/components/MetaImportView.tsx';
import '../src/styles.css';

const hostile='<img src=x onerror=alert(1)> & <script>window.fixtureExecuted=true</script>';
const initial={
 prefix:'meta-import-fixture-',role:'owner',loaded:true,reading:false,writeState:'idle',error:'',notice:'',
 sources:[{id:'source-one',label:'Synthetic source'},{id:'source-two',label:'Synthetic source'}],selectedSourceId:'source-one',
 source:{name:'Synthetic source',accountId:'1234567890123456789012345678901234567890',currency:'AED',timeZone:'Pacific/Kiritimati',statusLabel:'Ready',help:'This saved source has an account selected.'},
 canPreviousSources:true,canNextSources:true,report:'campaign_daily',from:'2026-09-01',to:'2026-09-30',canImport:true,canCancel:true,canRetrySame:true,pendingActionLabel:'Saving the import request…',
 imports:[{id:'receipt-one',label:'Campaign by day · Complete'},{id:'receipt-two',label:'Account by day · Partial'}],selectedImportId:'receipt-one',canPreviousImports:true,canNextImports:true,
 summary:{id:'exact-immutable-receipt',statusLabel:'Completed',dataStateLabel:'Available',rangeLabel:'2026-09-01 to 2026-09-30',requestedAtLabel:'Requested 2026-10-01T12:34:56.123Z',completedAtLabel:'Completed 2026-10-01T12:35:00.456Z',sourceLabel:'Captured source name',currencyLabel:'AED',timeZoneLabel:'Pacific/Kiritimati',attributionLabel:'Meta-reported mixed attribution; effective ad-set settings unknown.',countsLabel:'3 retained rows',diagnosticLabel:'',warnings:['Today’s data is provisional.'],state:'available',coverage:'complete'},
 rows:[
  {key:'not-displayed-react-key-one',date:'2026-09-01',campaignLabel:hostile,impressions:'0',clicks:'Unavailable',spend:'0.000000',actions:null,actionValues:[]},
  {key:'not-displayed-react-key-two',date:'2026-09-02',campaignLabel:'Second campaign',impressions:'123456789012345678901234567890',clicks:'0',spend:'123456789012345678901234567890.123456789012345678',actions:[],actionValues:null},
  {key:'not-displayed-react-key-three',date:'2026-09-03',campaignLabel:'Third campaign',impressions:'Unavailable',clicks:'0',spend:'Unavailable',actions:[{label:'purchase · 7d_click',value:'0.000000000000000000'},{label:hostile,value:'2.5000'}],actionValues:[{label:'purchase · 1d_view',value:'999999999999.000000000000000001'}]},
 ],canPreviousRows:true,canNextRows:true,
} satisfies Omit<MetaImportViewProps,`on${string}`>;

function Fixture(){
 const [state,setState]=React.useState<Omit<MetaImportViewProps,`on${string}`>>(initial);
 const events=React.useRef<{action:string;value?:unknown}[]>([]);
 const patch=(value:Partial<MetaImportViewProps>)=>setState(old=>({...old,...value}));
 const record=(action:string,value?:unknown)=>events.current.push({action,...(value===undefined?{}:{value})});
 (window as any).metaImportViewFixture={patch:(value:Partial<MetaImportViewProps>)=>flushSync(()=>patch(value)),reset:()=>flushSync(()=>{setState(initial);events.current=[];}),calls:()=>events.current,clear:()=>{events.current=[];},initial,hostile};
 const actions={
  onSource:(value:string)=>{record('source',value);patch({selectedSourceId:value});},
  onPreviousSources:()=>record('previousSources'),onNextSources:()=>record('nextSources'),
  onReport:(value:'account_daily'|'campaign_daily')=>{record('report',value);patch({report:value});},
  onFrom:(value:string)=>{record('from',value);patch({from:value});},onTo:(value:string)=>{record('to',value);patch({to:value});},
  onImport:()=>record('import'),onSelectImport:(value:string)=>{record('selectImport',value);patch({selectedImportId:value});},
  onPreviousImports:()=>record('previousImports'),onNextImports:()=>record('nextImports'),onPreviousRows:()=>record('previousRows'),onNextRows:()=>record('nextRows'),
  onCancel:()=>record('cancel'),onRetrySame:()=>record('retrySame'),onReload:()=>record('reload'),onConnections:()=>record('connections'),
 };
 return <main style={{maxWidth:1120,margin:'24px auto',padding:'0 16px',minWidth:0}}><MetaImportView {...state} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
