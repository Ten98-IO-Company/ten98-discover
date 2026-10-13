import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MetaConnectionView,type MetaConnectionViewProps,type MetaAccountOption} from '../src/components/MetaConnectionView.tsx';
import '../src/styles.css';

const accounts:MetaAccountOption[]=[
 {id:'9007199254740993',name:'North campaign <img src=x onerror=alert(1)>',currency:'USD',timeZone:'America/New_York',statusLabel:'Access checked',selectable:true,unavailableReason:null},
 {id:'9007199254740994',name:'North campaign',currency:'AED',timeZone:'Asia/Dubai',statusLabel:'Access unavailable',selectable:false,unavailableReason:'Meta did not confirm access to this account.'},
];
const cards=[{id:'connection-one',name:'Synthetic Meta source',statusLabel:'Account selected',statusDetail:'No report has been imported.',accountLabel:'Account 9007199254740993',currencyLabel:'USD',timeZoneLabel:'America/New_York',tokenExpiryLabel:'Token access expires Oct 20, 2026',dataExpiryLabel:'Data-access expiry not reported',canChoose:true,canReconnect:true,canDisconnect:true}];
function Fixture(){
 const calls=React.useRef<{action:string;value?:unknown}[]>([]);
 const [state,setState]=React.useState<Partial<MetaConnectionViewProps>>({prefix:'meta-fixture-',role:'owner',loaded:true,reading:false,writeState:'idle',error:'',notice:'',mode:'connections',setupMessage:'',canOpenAppSetup:false,canConnect:true,name:'',connections:[],connectionName:'Synthetic Meta source',connectionAccountLabel:'North campaign · Account 9007199254740993',accounts,discoveryLabel:'Accounts returned for this grant; the list may be incomplete.',discoveryState:'loaded',canPreviousAccounts:false,canNextAccounts:true,selectedAccount:null,accountId:'',canCheckAccount:true,canConfirmAccount:true,canRemoteRevoke:true,canRetrySame:false,canRestartConnect:false,pendingActionLabel:''});
 const record=(action:string,value?:unknown)=>calls.current.push({action,value});
 const patch=(value:Partial<MetaConnectionViewProps>)=>setState(old=>({...old,...value}));
 (window as any).metaViewFixture={patch:(value:Partial<MetaConnectionViewProps>)=>flushSync(()=>patch(value)),calls:()=>calls.current,clear:()=>{calls.current=[];},cards,accounts};
 const callbacks={
  onName:(value:string)=>{record('name',value);patch({name:value});},
  onAccountId:(value:string)=>{record('accountId',value);patch({accountId:value});},
  onConnect:()=>record('connect',state.name),onOpenAppSetup:()=>record('appSetup'),onReload:()=>record('reload'),
  onChoose:(id:string)=>{record('choose',id);patch({mode:'account'});},
  onReconnect:(id:string)=>record('reconnect',id),
  onReviewDisconnect:(id:string)=>{record('reviewDisconnect',id);patch({mode:'disconnect'});},
  onPreviousAccounts:()=>record('previous'),onNextAccounts:()=>record('next'),onReloadAccounts:()=>record('reloadAccounts'),
  onPickAccount:(id:string)=>{record('pick',id);patch({selectedAccount:accounts.find(x=>x.id===id)??null});},
  onCheckAccount:()=>record('checkAccount',state.accountId),onConfirmAccount:()=>record('confirm',state.selectedAccount?.id),
  onDisconnect:(revoke:boolean)=>record('disconnect',revoke),onRetrySame:()=>record('retrySame'),
  onRestartConnect:()=>record('restartConnect'),onBack:()=>{record('back');patch({mode:'connections'});},
 };
 return <main style={{maxWidth:1000,margin:'24px auto',padding:'0 16px'}}><MetaConnectionView {...state as MetaConnectionViewProps} {...callbacks}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
