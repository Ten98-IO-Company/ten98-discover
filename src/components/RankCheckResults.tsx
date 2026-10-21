import type * as React from 'react';
import type {WorkspaceRole} from '@ten98/runtime';
export type RankHistoryDisplay={id:string;createdAt:string;method:string;selection:string;status:string;cost:string;availability:string};
export type RankResultDisplay={status:string;target:string;method:string;selection:string;estimateUsd:string;knownChargeUsd:string;
 costStatus:'not_started'|'pending'|'uncertain'|'final';createdAt:string;startedAt:string;completedAt:string;
 diagnostic:string|null;expired:boolean;rawExpired:boolean;canCancel:boolean;
 tasks:readonly {id:string;keyword:string;device:string;outcome:string;position:string;coverage:string;observedAt:string;rankingUrl:string|null}[];
 dispatches:readonly {id:string;label:string;status:string;estimateUsd:string;actualUsd:string|null;canRecover:boolean;diagnostic:string|null}[]};
export type RankCheckResultsProps={prefix:string;backLabel:string;role:WorkspaceRole|null;phase:'history'|'run';
 locked:boolean;reading:boolean;pending:boolean;error:string;notice:string;loaded:boolean;
 history:readonly RankHistoryDisplay[];nextCursor:string|null;run:RankResultDisplay|null;
 canPrepare:boolean;connections:readonly {id:string;name:string}[];recoveryConnectionId:string;
 onPrepare:()=>void;onOpen:(id:string)=>void;onMore:()=>void;onRefresh:()=>void;onBack:()=>void;onHistory:()=>void;
 onRetry:()=>void;onCancel:()=>void;onRecoveryConnection:(id:string)=>void;onRecover:(id:string)=>void;onOpenProviders:()=>void};
export function RankCheckResults(p:RankCheckResultsProps):React.JSX.Element{
 const w=p.role==='owner'||p.role==='admin'||p.role==='editor',r=p.run;
 const hd={id:p.prefix+'results-heading',tabIndex:-1} as const,rg={className:'table-wrap',role:'region',tabIndex:0} as const,tw={minWidth:720};
 const b=(t:string,f:()=>void,d:boolean,c:string='btn ghost')=><button type="button" className={c} onClick={f} disabled={d}>{t}</button>;
 if(p.role===null)return <div className="research-panel stack" style={{'--control-md':'var(--control-touch)'} as React.CSSProperties}>{b(p.backLabel,p.onBack,p.locked)}{p.reading?<p role="status">Loading checks…</p>:<p className="alert" role="alert">{p.error||'Access is unavailable. Return to the tracker to reload access.'}</p>}</div>;
 return <div className="research-panel stack" style={{display:'grid',gap:'var(--space-3)',minWidth:0,'--control-md':'var(--control-touch)'} as React.CSSProperties}>
  <div style={{display:'flex',flexWrap:'wrap',justifyContent:'space-between',alignItems:'flex-start',gap:'var(--space-3)',minWidth:0}}>
   {p.phase==='history'?<>
    <h2 {...hd}>Rank check history</h2>
    <div className="row">{b(p.backLabel,p.onBack,p.locked)}{b('Refresh checks',p.onRefresh,p.locked)}{p.canPrepare&&w&&b('Prepare a rank check',p.onPrepare,p.locked,'btn primary')}</div>
   </>:<>
    <h2 {...hd}>Rank check result</h2>
    <div className="row">{b(p.backLabel,p.onBack,p.locked)}{b('Check history',p.onHistory,p.locked)}{b('Refresh check',p.onRefresh,p.locked)}</div>
   </>}
  </div>
  {p.error!==''&&<p className="alert" role="alert">{p.error}</p>}
  {p.notice!==''&&<p className="notice" role="status">{p.notice}</p>}
  {p.reading&&<p role="status">Loading checks…</p>}
  {p.pending&&<div className="banner" role="alert"><p>The request may already be saved. Retry the same request to recover its result.</p>{b('Retry same request',p.onRetry,false,'btn primary')}</div>}
  {p.phase==='history'?<>
   <div {...rg} aria-label="Rank check history"><table style={tw}>
    <thead><tr><th style={{minWidth:160}}>Created</th><th style={{minWidth:88}}>Method</th><th style={{minWidth:180}}>Scope</th><th style={{minWidth:110}}>Outcome</th><th style={{minWidth:240}}>Costs</th><th style={{minWidth:140}}>Data</th></tr></thead>
    <tbody>{p.history.map(h=><tr key={h.id}><td><button type="button" className="btn ghost" onClick={()=>p.onOpen(h.id)} disabled={p.locked}>{h.createdAt}</button></td><td>{h.method}</td><td>{h.selection}</td><td>{h.status}</td><td>{h.cost}</td><td>{h.availability}</td></tr>)}</tbody>
   </table></div>
   {p.loaded&&p.error===''&&p.history.length===0&&<p className="dim">No rank checks yet.</p>}
   {p.nextCursor!==null&&b('Load more checks',p.onMore,p.locked||p.reading)}
  </>:<>
   {r===null?(!p.reading&&<p className="dim">Check unavailable.</p>):<>
    <div className="card stack" style={{marginBottom:0,gap:'var(--space-3)'}}>
     <div className="row between"><span className="pill">{r.status}</span><span className="dim">{r.method} · {r.selection}</span></div>
     <p>{r.target}</p>
     <div style={{display:'flex',flexWrap:'wrap',gap:'var(--space-3)'}}><span>{r.status==='skipped'?'No quote applied':'Quoted maximum $'+r.estimateUsd}</span><span>Known charges ${r.knownChargeUsd}</span><span>Charge status {{not_started:'Not started',pending:'Pending',uncertain:'Unconfirmed',final:'Confirmed'}[r.costStatus]}</span></div>
     {r.costStatus==='uncertain'&&<p className="alert" role="alert">Some charges are unresolved. Known charges are not the final total. Recovery does not submit another paid check; new paid work stays blocked until the charge is reconciled.</p>}
     {r.costStatus==='pending'&&<p className="hint">The provider is still processing work or confirming charges. Known charges are not the final total.</p>}
     {r.costStatus==='not_started'&&<p className="hint">{r.status==='skipped'?'No paid check started.':'This check has not started.'}</p>}
     {r.diagnostic!==null&&<p className="alert" role="alert">{r.diagnostic}</p>}
    </div>
    {w&&r.canCancel&&<>{b('Cancel remaining checks',p.onCancel,p.locked)}<p className="hint">Checks already sent will continue and may be charged.</p></>}
    {r.expired&&<p className="notice" role="status">Rank observations expired under workspace retention. The check outcome and financial receipt remain.</p>}
    {r.rawExpired&&!r.expired&&<p className="hint">Raw provider evidence expired; retained rank observations are shown below.</p>}
    <h3>Rank observations</h3>
    <div {...rg} aria-label="Rank observations"><table style={tw}>
     <thead><tr><th style={{minWidth:180}}>Keyword</th><th style={{minWidth:88}}>Device</th><th style={{minWidth:160}}>Outcome</th><th style={{minWidth:140}}>Position</th><th style={{minWidth:180}}>Coverage</th><th style={{minWidth:160}}>Observed</th><th style={{minWidth:240}}>Ranking URL</th></tr></thead>
     <tbody>{r.tasks.map(t=><tr key={t.id}><td>{t.keyword}</td><td>{t.device}</td><td>{t.outcome}</td><td>{t.position}</td><td>{t.coverage}</td><td>{t.observedAt}</td><td>{t.rankingUrl??'—'}</td></tr>)}</tbody>
    </table></div>
    {r.tasks.length===0&&!r.expired&&<p className="dim">No rank observations are available for this receipt.</p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:'var(--space-3)'}}><span>Created {r.createdAt}</span><span>Started {r.startedAt}</span><span>Completed {r.completedAt}</span></div>
    <h3>Provider request charges</h3>
    {p.role==='owner'&&r.dispatches.some(d=>d.canRecover)&&<div className="card stack">
     <label className="field" htmlFor={p.prefix+'recovery'}>Recovery DataForSEO connection</label>
     <select id={p.prefix+'recovery'} value={p.recoveryConnectionId} onChange={e=>p.onRecoveryConnection(e.target.value)} disabled={p.locked}>
      <option value="">Choose connection</option>{p.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select>
     <p className="hint">Choose the DataForSEO account used for this check to look up its original result and charge.</p>
     {p.connections.length===0&&b('Open providers',p.onOpenProviders,p.locked)}
    </div>}
    <div {...rg} aria-label="Provider request charges"><table style={tw}>
     <thead><tr><th style={{minWidth:110}}>Request</th><th style={{minWidth:240}}>State</th><th style={{minWidth:140}}>Maximum</th><th style={{minWidth:160}}>Confirmed charge</th><th style={{minWidth:180}}>Recovery</th></tr></thead>
     <tbody>{r.dispatches.map(d=><tr key={d.id}><td>{d.label}</td><td>{d.status}{d.diagnostic!==null&&<p className="hint">{d.diagnostic}</p>}</td><td>${d.estimateUsd}</td><td>{d.actualUsd===null?'Unconfirmed':'$'+d.actualUsd}</td><td>{p.role==='owner'&&d.canRecover?b('Recover '+d.label,()=>p.onRecover(d.id),p.locked||p.recoveryConnectionId===''):'—'}</td></tr>)}</tbody>
    </table></div>
   </>}
  </>}
 </div>;
}
