import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MetaCampaignView,type MetaCampaignViewProps} from '../src/components/MetaCampaignView.tsx';
import '../src/styles.css';

const hostile='<img src=x onerror=alert(1)> & <script>window.fixtureExecuted=true</script>';
const initial={
 prefix:'meta-campaign-fixture-',role:'owner',loaded:true,reading:false,exporting:false,writeState:'idle',error:'',exportError:'',notice:'',
 source:{label:'Synthetic Meta source',accountLabel:'Synthetic account · 1234567890123456789012345678901234567890',statusLabel:'Disconnected; saved records remain available',help:'Connect again before requesting a new inventory.'},
 latestAttemptLabel:'Latest attempt: failed; previous completed inventory remains selected.',showingLatest:true,
 inventories:[{id:'receipt-one',label:'Complete · original snapshot'},{id:'receipt-two',label:'Partial · later attempt'}],selectedInventoryId:'receipt-one',
 summary:{id:'a'.repeat(96),statusLabel:'Completed',coverageLabel:'Complete pagination; not an atomic snapshot',state:'available',sourceLabel:'Synthetic observed source',requestedAtLabel:'2026-10-13T12:00:00.123Z',completedAtLabel:'2026-10-13T12:01:00.456Z',intervalLabel:'2026-10-13T12:00:00.500Z to 2026-10-13T12:01:00.123Z',countsLabel:'2 recorded rows; 2 readable rows',diagnosticLabel:'Supplied diagnostic',warnings:['Supplied coverage warning',hostile]},
 rows:[{id:'1234567890123456789012345678901234567890',nameLabel:hostile,statusLabel:'PAUSED',effectiveStatusLabel:'Unknown provider status: FUTURE_STATUS'},{id:'2',nameLabel:'Campaign with no reported activity',statusLabel:'Unavailable',effectiveStatusLabel:'ARCHIVED'}],
 canRefresh:true,canCancel:true,canRetrySame:true,canPreviousHistory:true,canNextHistory:true,canPreviousRows:true,canNextRows:true,canExport:true,pendingActionLabel:'Saving the refresh request…',
} satisfies Omit<MetaCampaignViewProps,`on${string}`>;

function Fixture(){
 const [state,setState]=React.useState<Omit<MetaCampaignViewProps,`on${string}`>>(initial);
 const events=React.useRef<{action:string;value?:string}[]>([]);
 const record=(action:string,value?:string)=>events.current.push({action,...value===undefined?{}:{value}});
 (window as any).metaCampaignViewFixture={patch:(value:Partial<MetaCampaignViewProps>)=>flushSync(()=>setState(old=>({...old,...value}))),reset:()=>flushSync(()=>{setState(initial);events.current=[];}),calls:()=>events.current,clear:()=>{events.current=[];},initial};
 const actions={onBack:()=>record('back'),onReload:()=>record('reload'),onLatest:()=>record('latest'),onRefresh:()=>record('refresh'),onCancel:()=>record('cancel'),onRetrySame:()=>record('retrySame'),onSelectInventory:(value:string)=>{record('select',value);setState(old=>({...old,selectedInventoryId:value}));},onPreviousHistory:()=>record('previousHistory'),onNextHistory:()=>record('nextHistory'),onPreviousRows:()=>record('previousRows'),onNextRows:()=>record('nextRows'),onExport:()=>record('export'),onCancelExport:()=>record('cancelExport')};
 return <main style={{maxWidth:1120,margin:'24px auto',padding:'0 16px',minWidth:0}}><MetaCampaignView {...state} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
