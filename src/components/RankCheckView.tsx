import {Tooltip} from '@ten98/ui';
import type * as React from 'react';
import type {WorkspaceRole} from '@ten98/runtime';

export type RankQuoteDisplay={
 connectionName:string;methodLabel:string;targetLabel:string;selectionLabel:string;
 taskCount:number;dispatchCount:number;estimateUsd:string;priceAsOf:string;expiresAt:string;
 expired:boolean;canStart:boolean;
 tasks:readonly {id:string;keyword:string;device:string;maximumUsd:string}[];
};
export type RankCheckViewProps={
 prefix:string;backLabel:string;role:WorkspaceRole|null;
 schedulePurpose:boolean;canConfigureSchedule:boolean;onConfigureSchedule:()=>void;
 phase:'setup'|'review';locked:boolean;reading:boolean;pending:boolean;conflict:boolean;
 error:string;notice:string;selectionLabel:string;canQuote:boolean;
 connections:readonly {id:string;name:string}[];connectionId:string;
 method:'queued'|'live';quote:RankQuoteDisplay|null;
 onConnection:(id:string)=>void;onMethod:(method:'queued'|'live')=>void;
 onQuote:()=>void;onStart:()=>void;onRefresh:()=>void;onBack:()=>void;onRetry:()=>void;onOpenProviders:()=>void;
};

export function RankCheckView(p:RankCheckViewProps):React.JSX.Element{
 const writer=p.role==='owner'||p.role==='admin'||p.role==='editor',q=p.quote;
 return <section className="research-panel stack" style={{minWidth:0,'--control-md':'var(--control-touch)'} as React.CSSProperties}>
  <div className="row between"><h2 id={p.prefix+'quote-heading'} tabIndex={-1}>{p.schedulePurpose?'Schedule rank checks':'Run a rank check'}</h2><button type="button" className="btn ghost" disabled={p.locked} onClick={p.onBack}>{p.backLabel}</button></div>
  {p.error&&<p className="alert" role="alert">{p.error}</p>}{p.notice&&<p role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading check…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry this same request to recover its result.</p><button type="button" className="btn primary" onClick={p.onRetry}>Retry same request</button></div>}
  {p.conflict&&<div className="banner" role="alert"><p>The saved check changed. Refresh before continuing.</p><button type="button" className="btn" disabled={p.locked} onClick={p.onRefresh}>Refresh setup</button></div>}
  {p.role!==null&&p.phase==='setup'&&<>
   <p>{p.selectionLabel}</p>
   {writer?<form className="stack" onSubmit={event=>{event.preventDefault();p.onQuote();}}>
    <fieldset disabled={p.locked||p.reading} style={{border:0,padding:0,minWidth:0}}><legend>Check settings</legend>
     <label htmlFor={p.prefix+'connection'}>DataForSEO connection<select id={p.prefix+'connection'} value={p.connectionId} onChange={event=>p.onConnection(event.target.value)}><option value="">Choose a connection</option>{p.connections.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
     {!p.schedulePurpose&&<label htmlFor={p.prefix+'method'}>Retrieval method<select id={p.prefix+'method'} value={p.method} onChange={event=>p.onMethod(event.target.value as 'queued'|'live')}><option value="queued">Queued</option><option value="live">Live</option></select></label>}
     <Tooltip content="Live retrieves results immediately. Queued waits for the provider to finish. Both use the tracker’s saved market, devices and keywords."><button type="button" className="btn ghost" aria-label="About ranking methods">About ranking methods</button></Tooltip>
     {p.connections.length?<button type="submit" className="btn primary" disabled={!p.canQuote||p.conflict||!p.connectionId}>{p.schedulePurpose?'Continue to schedule':'Run rank check'}</button>:p.role==='owner'?<button type="button" className="btn" onClick={p.onOpenProviders}>Open Connections</button>:<p>Ask a workspace owner to add DataForSEO.</p>}
    </fieldset>
   </form>:<p>An editor can run a check.</p>}
  </>}
  {p.phase==='review'&&q&&<div className="stack">
   <p>{q.targetLabel} · {q.selectionLabel}</p>
   {q.expired?<p role="alert">These settings expired. Return to the tracker and run again.</p>:p.schedulePurpose?<button type="button" className="btn primary" disabled={p.locked||!p.canConfigureSchedule} onClick={p.onConfigureSchedule}>Configure schedule</button>:<><p role="status">{p.locked?'Starting rank check…':'The check is ready to run.'}</p>{!p.locked&&!p.pending&&<button type="button" className="btn primary" disabled={!q.canStart} onClick={p.onStart}>Run rank check</button>}</>}
  </div>}
 </section>;
}
