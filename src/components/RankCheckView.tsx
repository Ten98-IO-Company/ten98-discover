import type * as React from 'react';

export type RankQuoteDisplay={
 connectionName:string;methodLabel:string;targetLabel:string;selectionLabel:string;
 taskCount:number;dispatchCount:number;estimateUsd:string;priceAsOf:string;expiresAt:string;
 expired:boolean;canStart:boolean;
 tasks:readonly {id:string;keyword:string;device:string;maximumUsd:string}[];
};
export type RankCheckViewProps={
 prefix:string;backLabel:string;role:'owner'|'admin'|'editor'|'viewer'|null;
 schedulePurpose:boolean;canConfigureSchedule:boolean;onConfigureSchedule:()=>void;
 phase:'setup'|'review';locked:boolean;reading:boolean;pending:boolean;conflict:boolean;
 error:string;notice:string;selectionLabel:string;canQuote:boolean;
 connections:readonly {id:string;name:string}[];connectionId:string;
 method:'queued'|'live';quote:RankQuoteDisplay|null;
 onConnection:(id:string)=>void;onMethod:(method:'queued'|'live')=>void;
 onQuote:()=>void;onStart:()=>void;onRefresh:()=>void;onBack:()=>void;onRetry:()=>void;onOpenProviders:()=>void;
};

export function RankCheckView(p:RankCheckViewProps):React.JSX.Element{
 const writer=p.role==='owner'||p.role==='admin'||p.role==='editor',hid=p.prefix+'quote-heading',q=p.quote;
 return <section className="research-panel stack" style={{'--control-md':'var(--control-touch)',display:'grid',gap:'var(--space-3)',minWidth:0} as React.CSSProperties}>
  <div className="row" style={{justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:'var(--space-3)'}}>
   {p.role!==null&&<h2 id={hid} tabIndex={-1} style={{margin:0}}>{p.phase==='setup'?'Review a rank check':'Review the maximum charge'}</h2>}
   <button type="button" className="btn ghost" disabled={p.locked} onClick={p.onBack}>{p.backLabel}</button>
  </div>
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading check…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry the same request to recover its result.</p> <button type="button" className="btn primary" onClick={p.onRetry}>Retry same request</button></div>}
  {p.conflict&&<div className="banner" role="alert"><p>The saved check changed. Refresh it before continuing.</p> <button type="button" className="btn primary" disabled={p.locked} onClick={p.onRefresh}>Refresh quote</button></div>}
  {p.role===null?(!p.reading&&<p>Check access is unavailable. Return to the tracker to reload access.</p>):p.phase==='setup'?<>
   <p>{p.selectionLabel}</p>
   {writer&&(!p.schedulePurpose||p.role==='owner')?<form className="card stack" style={{maxWidth:'var(--form-max)',width:'100%',marginBottom:0,gap:'var(--space-3)'}} aria-labelledby={hid} onSubmit={e=>{e.preventDefault();p.onQuote();}}>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,220px),1fr))',gap:'var(--space-3)'}}>
     <div className="field" style={{margin:0,minWidth:0}}><label htmlFor={p.prefix+'connection'}>DataForSEO connection</label>
      <select id={p.prefix+'connection'} value={p.connectionId} disabled={p.locked} onChange={e=>p.onConnection(e.target.value)}>
       <option value="">Choose a connection</option>{p.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
     {p.schedulePurpose?<p style={{margin:0}}>Retrieval method: Queued. This quote includes all current keywords and configured devices.</p>:<div className="field" style={{margin:0,minWidth:0}}><label htmlFor={p.prefix+'method'}>Retrieval method</label>
      <select id={p.prefix+'method'} value={p.method} disabled={p.locked} onChange={e=>p.onMethod(e.target.value as 'queued'|'live')}>
       <option value="queued">Queued</option><option value="live">Live</option></select></div>}
    </div>
    <p className="hint">Preparing a quote does not start a paid check. {p.schedulePurpose?'You will review the schedule and approve recurring spending separately.':'Both retrieval methods may incur provider charges.'}</p>
    {p.connections.length===0?(p.role==='owner'
     ?<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onOpenProviders}>Open providers</button>
     :<p className="hint">Ask a workspace owner to configure DataForSEO.</p>)
    :<button type="submit" className="btn primary" disabled={p.locked||p.reading||p.conflict||!p.canQuote||p.connectionId===''}>Prepare quote</button>}
   </form>:<p>{p.schedulePurpose?'Only workspace owners can prepare a recurring-spend approval.':'An editor can prepare a check; only its requester can start it.'}</p>}
  </>:<>
   {q===null?<p>Quote unavailable. Refresh or return to the tracker.</p>:<>
    <div className="card stack" style={{marginBottom:0,gap:'var(--space-3)'}}>
     <p className="dim" id={p.prefix+'max'}>Maximum total</p>
     <p className="big-num" aria-labelledby={p.prefix+'max'}><strong>{'$'+q.estimateUsd}</strong></p>
     <p>{q.connectionName} · {q.methodLabel}</p>
     <p>{q.targetLabel}</p>
     <p>{q.selectionLabel}</p>
     <p className="dim">{q.taskCount} keyword/device checks · {q.dispatchCount} provider requests</p>
     <p className="dim">Prices checked {q.priceAsOf} · Quote expires {q.expiresAt}</p>
    </div>
    {q.expired&&<p className="notice">This quote expired. Return to the tracker to prepare a new quote.</p>}
    <p className="hint">The final charge may be lower. Unfinished checks and unconfirmed charges stay visible until resolved.</p>
    {writer&&!q.expired&&!q.canStart&&<p className="hint">Only the requester can start an eligible quote.</p>}
   </>}
   {(q!==null||!p.conflict)&&<div className="row">
    {q!==null&&(p.schedulePurpose?<button type="button" className="btn primary" disabled={p.locked||!p.canConfigureSchedule} onClick={p.onConfigureSchedule}>Configure schedule</button>:<button type="button" className="btn primary" disabled={p.locked||p.conflict||!writer||!q.canStart||q.expired} onClick={p.onStart}>Start paid rank check</button>)}
    {!p.schedulePurpose&&p.canConfigureSchedule&&<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onConfigureSchedule}>Set up recurring checks</button>}
    {!p.conflict&&<button type="button" className="btn ghost" disabled={p.locked} onClick={p.onRefresh}>Refresh quote</button>}
   </div>}
   {q!==null&&<><h3 style={{margin:0}}>Quoted keyword and device costs</h3>
    <div className="table-wrap" role="region" aria-label="Quoted keyword and device costs" tabIndex={0}>
     <table style={{minWidth:640}}>
      <thead><tr><th style={{minWidth:180}}>Keyword</th><th style={{minWidth:88}}>Device</th><th style={{minWidth:140}}>Maximum charge</th></tr></thead>
      <tbody>{q.tasks.map(t=><tr key={t.id}><td style={{minWidth:'10em'}}>{t.keyword}</td><td>{t.device}</td><td>{'$'+t.maximumUsd}</td></tr>)}</tbody>
     </table></div></>}
  </>}
 </section>;
}
