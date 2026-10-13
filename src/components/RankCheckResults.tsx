import type * as React from 'react';
export type RankHistoryDisplay={id:string;createdAt:string;method:string;selection:string;status:string;cost:string;availability:string};
export type RankResultDisplay={status:string;target:string;method:string;selection:string;estimateUsd:string;knownChargeUsd:string;
 costStatus:'not_started'|'pending'|'uncertain'|'final';createdAt:string;startedAt:string;completedAt:string;
 diagnostic:string|null;expired:boolean;rawExpired:boolean;canCancel:boolean;
 tasks:readonly {id:string;keyword:string;device:string;outcome:string;position:string;coverage:string;observedAt:string;rankingUrl:string|null}[];
 dispatches:readonly {id:string;label:string;status:string;estimateUsd:string;actualUsd:string|null;canRecover:boolean;diagnostic:string|null}[]};
export type RankCheckResultsProps={prefix:string;backLabel:string;role:'owner'|'admin'|'editor'|'viewer'|null;phase:'history'|'run';
 locked:boolean;reading:boolean;pending:boolean;error:string;notice:string;loaded:boolean;
 history:readonly RankHistoryDisplay[];nextCursor:string|null;run:RankResultDisplay|null;
 canPrepare:boolean;connections:readonly {id:string;name:string}[];recoveryConnectionId:string;
 onPrepare:()=>void;onOpen:(id:string)=>void;onMore:()=>void;onRefresh:()=>void;onBack:()=>void;onHistory:()=>void;
 onRetry:()=>void;onCancel:()=>void;onRecoveryConnection:(id:string)=>void;onRecover:(id:string)=>void;onOpenProviders:()=>void};
export function RankCheckResults(p:RankCheckResultsProps):React.JSX.Element{
 const w=p.role==='owner'||p.role==='admin'||p.role==='editor',r=p.run;
 const hd={id:p.prefix+'results-heading',tabIndex:-1} as const,rg={className:'table-wrap',role:'region',tabIndex:0} as const,tw={minWidth:720};
 const b=(t:string,f:()=>void,d:boolean,c:string='btn ghost')=><button type="button" className={c} onClick={f} disabled={d}>{t}</button>;
 if(p.role===null)return <div className="research-panel stack">{b(p.backLabel,p.onBack,p.locked)}{p.reading?<p role="status">Loading checks…</p>:<p className="alert" role="alert">{p.error||'Access is unavailable. Return to the tracker to reload access.'}</p>}</div>;
 return <div className="research-panel stack">
  {b(p.backLabel,p.onBack,p.locked)}
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading checks…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry the same request to recover its result.</p>{b('Retry same request',p.onRetry,false,'btn primary')}</div>}
  {p.phase==='history'?<>
   <h2 {...hd}>Rank check history</h2>
   <div className="row">{b('Refresh checks',p.onRefresh,p.locked)}{p.canPrepare&&w&&b('Prepare a rank check',p.onPrepare,p.locked,'btn primary')}</div>
   <div {...rg} aria-label="Rank check history"><table style={tw}>
    <thead><tr><th>Created</th><th>Method</th><th>Scope</th><th>Outcome</th><th>Costs</th><th>Data</th></tr></thead>
    <tbody>{p.history.map(h=><tr key={h.id}><td><button type="button" className="btn ghost" onClick={()=>p.onOpen(h.id)} disabled={p.locked}>{h.createdAt}</button></td><td>{h.method}</td><td>{h.selection}</td><td>{h.status}</td><td>{h.cost}</td><td>{h.availability}</td></tr>)}</tbody>
   </table></div>
   {p.loaded&&p.error===''&&p.history.length===0&&<p className="dim">No rank checks yet.</p>}
   {p.nextCursor!==null&&b('Load more checks',p.onMore,p.locked||p.reading)}
  </>:<>
   <h2 {...hd}>Rank check result</h2>
   <div className="row">{b('Check history',p.onHistory,p.locked)}{b('Refresh check',p.onRefresh,p.locked)}</div>
   {r===null?(!p.reading&&<p className="dim">Check unavailable.</p>):<>
    <div className="card stack">
     <div className="row between"><span className="pill">{r.status}</span><span className="dim">{r.method} · {r.selection}</span></div>
     <p>{r.target}</p>
     <div className="row between"><span className="field">Created {r.createdAt}</span><span className="field">Started {r.startedAt}</span><span className="field">Completed {r.completedAt}</span></div>
     <div className="row between"><span className="field">{r.status==='skipped'?'No quote applied':'Quoted maximum $'+r.estimateUsd}</span><span className="field">Known charges ${r.knownChargeUsd}</span><span className="field">Charge status {r.costStatus}</span></div>
     {r.costStatus==='uncertain'&&<p className="alert" role="alert">Some charges are unresolved. Known charges are not the final total. Recovery does not submit another paid check or unpause spending.</p>}
     {r.costStatus==='pending'&&<p className="hint">The provider is still processing work or confirming charges. Known charges are not the final total.</p>}
     {r.costStatus==='not_started'&&<p className="hint">{r.status==='skipped'?'No paid check started.':'This check has not started.'}</p>}
     {r.diagnostic!==null&&<p className="alert" role="alert">{r.diagnostic}</p>}
    </div>
    {r.expired&&<p className="notice" role="status">Rank observations expired under workspace retention. The check outcome and financial receipt remain.</p>}
    {r.rawExpired&&!r.expired&&<p className="hint">Raw provider evidence expired; retained rank observations are shown below.</p>}
    <div {...rg} aria-label="Rank observations"><table style={tw}>
     <thead><tr><th>Keyword</th><th>Device</th><th>Outcome</th><th>Position</th><th>Coverage</th><th>Observed</th><th>Ranking URL</th></tr></thead>
     <tbody>{r.tasks.map(t=><tr key={t.id}><td>{t.keyword}</td><td>{t.device}</td><td>{t.outcome}</td><td>{t.position}</td><td>{t.coverage}</td><td>{t.observedAt}</td><td>{t.rankingUrl??'—'}</td></tr>)}</tbody>
    </table></div>
    {r.tasks.length===0&&!r.expired&&<p className="dim">No rank observations are available for this receipt.</p>}
    {w&&r.canCancel&&<>{b('Cancel undispatched work',p.onCancel,p.locked)}<p className="hint">Only work not yet sent can be cancelled; dispatched work and charges remain.</p></>}
    {p.role==='owner'&&r.dispatches.some(d=>d.canRecover)&&<div className="card stack">
     <label className="field" htmlFor={p.prefix+'recovery'}>Recovery DataForSEO connection</label>
     <select id={p.prefix+'recovery'} value={p.recoveryConnectionId} onChange={e=>p.onRecoveryConnection(e.target.value)} disabled={p.locked}>
      <option value="">Choose connection</option>{p.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select>
     <p className="hint">Use the provider account that received this check. The server verifies eligibility and evidence.</p>
     {p.connections.length===0&&b('Open providers',p.onOpenProviders,p.locked)}
    </div>}
    <div {...rg} aria-label="Provider request charges"><table style={tw}>
     <thead><tr><th>Request</th><th>State</th><th>Maximum</th><th>Confirmed charge</th><th>Recovery</th></tr></thead>
     <tbody>{r.dispatches.map(d=><tr key={d.id}><td>{d.label}</td><td>{d.status}{d.diagnostic!==null&&<p className="hint">{d.diagnostic}</p>}</td><td>${d.estimateUsd}</td><td>{d.actualUsd===null?'Unconfirmed':'$'+d.actualUsd}</td><td>{p.role==='owner'&&d.canRecover?b('Recover '+d.label,()=>p.onRecover(d.id),p.locked||p.recoveryConnectionId===''):'—'}</td></tr>)}</tbody>
    </table></div>
   </>}
  </>}
 </div>;
}
