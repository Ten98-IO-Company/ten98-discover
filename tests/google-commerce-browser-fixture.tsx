import * as React from 'react';
import {ToastProvider} from '@ten98/ui';
import {createRoot} from 'react-dom/client';
import {GoogleReportsPanel} from '../src/components/GoogleReportsPanel';
import '../src/styles.css';

type Scope={projectId:string;userId:string;instanceOperator?:boolean};
declare global{interface Window{googleCommerceScope:Scope;googleCommerceFixture:{setScope:(scope:Scope)=>void;unauthorized:()=>number;setupOpens:()=>number}}}
function Fixture(){
 const [scope,setScope]=React.useState(window.googleCommerceScope),[signedOut,setSignedOut]=React.useState(false),unauthorized=React.useRef(0),setupOpens=React.useRef(0);
 window.googleCommerceFixture={setScope:next=>{setSignedOut(false);setScope(next);},unauthorized:()=>unauthorized.current,setupOpens:()=>setupOpens.current};
 return <main style={{maxWidth:1100,margin:'20px auto',padding:'0 16px',minWidth:0}}><h1>Google reports · synthetic commerce fixture</h1>{signedOut?<p role="status">Fixture signed out</p>:<GoogleReportsPanel {...scope} onUnauthorized={()=>{unauthorized.current++;setSignedOut(true);}} onOpenSetup={scope.instanceOperator?()=>{setupOpens.current++;}:undefined}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<ToastProvider>{<Fixture/>}</ToastProvider>);
