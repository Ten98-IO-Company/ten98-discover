import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MetaAppView, type MetaAppViewProps, type MetaAppSelection} from '../src/components/MetaAppView.tsx';
import '../src/styles.css';

const selected:MetaAppSelection={id:'selected-registration',appId:'9007199254740993',statusLabel:'Inactive · Enabled',revisionLabel:'Revision 2147483647',active:false,enabled:true,boundOrigin:'https://synthetic-app.example'};
const other:MetaAppSelection={id:'other-registration',appId:'9007199254740994',statusLabel:'Active · Enabled',revisionLabel:'Revision 3',active:true,enabled:true,boundOrigin:'https://synthetic-app.example'};
const callbacks=[{kind:'oauth' as const,label:'OAuth callback',url:'https://synthetic-app.example/api/meta/callback',helper:'Add this exact address to the Meta login configuration.'},{kind:'deletion' as const,label:'Data-deletion callback',url:'https://synthetic-app.example/api/meta/apps/selected-registration/delete-data',helper:'This callback belongs to the selected registration.'}];

function Fixture(){
 const calls=React.useRef<{action:string;value?:unknown}[]>([]);
 const [state,setState]=React.useState<Partial<MetaAppViewProps>>({prefix:'meta-app-fixture-',operator:true,reading:false,writeState:'idle',error:'',notice:'',readiness:'HTTPS origin configured. Saved settings are not proof of Meta approval.',choices:[{id:other.id,label:'App '+other.appId+' · Active · Enabled'}],selected,newRegistration:false,canPrevious:false,canNext:true,appId:selected.appId,configId:'9007199254740995',secret:'',enabled:true,declaredMode:'development',activate:false,canSave:true,canDisable:true,confirmDisable:false,callbacks,backLabel:'Back to connections'});
 const patch=(value:Partial<MetaAppViewProps>)=>setState(old=>({...old,...value}));
 const record=(action:string,value?:unknown)=>calls.current.push({action,...(value===undefined?{}:{value})});
 (window as any).metaAppViewFixture={patch:(value:Partial<MetaAppViewProps>)=>flushSync(()=>patch(value)),calls:()=>calls.current,clear:()=>{calls.current=[];},selected,other,callbacks};
 const actions={
  onSelect:(id:string)=>{record('select',id);const item=id===selected.id?selected:other;patch({selected:item,newRegistration:false,appId:item.appId,secret:'',activate:false});},
  onNew:()=>{record('new');patch({newRegistration:true,selected:null,appId:'',configId:'',secret:'',enabled:false,activate:false,canDisable:false,callbacks:callbacks.slice(0,1)});},
  onPrevious:()=>record('previous'),onNext:()=>record('next'),
  onAppId:(value:string)=>{record('appId',value);patch({appId:value});},onConfigId:(value:string)=>{record('configId',value);patch({configId:value});},
  onSecret:(value:string)=>{record('secretLength',value.length);patch({secret:value});},onEnabled:(value:boolean)=>{record('enabled',value);patch({enabled:value});},
  onMode:(value:'development'|'live')=>{record('mode',value);patch({declaredMode:value});},onActivate:(value:boolean)=>{record('activate',value);patch({activate:value});},
  onSave:()=>{record('save',{appId:state.appId,configId:state.configId,hasSecret:!!state.secret,activate:state.activate,enabled:state.enabled});patch({secret:'',writeState:'submitting'});},
  onReviewDisable:()=>{record('reviewDisable');patch({confirmDisable:true});},onDisable:()=>record('disable'),onKeepEnabled:()=>{record('keepEnabled');patch({confirmDisable:false});},
  onCopy:(kind:'oauth'|'deletion')=>record('copy',kind),onReload:()=>record('reload'),onBack:()=>record('back'),
 };
 return <main style={{maxWidth:960,margin:'24px auto',padding:'0 16px'}}><MetaAppView {...state as MetaAppViewProps} {...actions}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
