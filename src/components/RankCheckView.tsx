import {Alert,Button,Field,Fieldset,Heading,Inline,Option,Select,Stack,Text,Tooltip} from '@ten98/ui';
import type * as React from 'react';
import type {WorkspaceRole} from '@ten98/runtime/browser';

export type RankPreparationDisplay={
 connectionName:string;methodLabel:string;targetLabel:string;selectionLabel:string;
 taskCount:number;dispatchCount:number;expiresAt:string;
 expired:boolean;canStart:boolean;
 tasks:readonly {id:string;keyword:string;device:string}[];
};
export type RankCheckViewProps={
 prefix:string;backLabel:string;role:WorkspaceRole|null;
 schedulePurpose:boolean;canConfigureSchedule:boolean;onConfigureSchedule:()=>void;
 phase:'setup'|'review';locked:boolean;reading:boolean;pending:boolean;conflict:boolean;
 error:string;notice:string;selectionLabel:string;canPrepare:boolean;
 connections:readonly {id:string;name:string}[];connectionId:string;
 method:'queued'|'live';preparation:RankPreparationDisplay|null;
 onConnection:(id:string)=>void;onMethod:(method:'queued'|'live')=>void;
 onPrepare:()=>void;onStart:()=>void;onRefresh:()=>void;onBack:()=>void;onRetry:()=>void;onOpenProviders:()=>void;
};

export function RankCheckView(p:RankCheckViewProps):React.JSX.Element{
 const writer=p.role==='owner'||p.role==='admin'||p.role==='editor',q=p.preparation;
 return <Stack as="section">
  <Inline justify="between"><Heading level={2} id={p.prefix+'quote-heading'} tabIndex={-1}>{p.schedulePurpose?'Schedule rank checks':'Run a rank check'}</Heading><Button type="button" variant="ghost" disabled={p.locked} onClick={p.onBack}>{p.backLabel}</Button></Inline>
  {p.error&&<Alert tone="danger" role="alert">{p.error}</Alert>}{p.notice&&<Text as="p" role="status">{p.notice}</Text>}
  {p.reading&&<Text as="p" role="status">Loading check…</Text>}
  {p.pending&&<Stack><Alert tone="warning" variant="banner" role="alert">The request may already be saved. Retry this same request to recover its result.</Alert><Inline><Button type="button" variant="primary" onClick={p.onRetry}>Retry same request</Button></Inline></Stack>}
  {p.conflict&&<Stack><Alert tone="warning" variant="banner" role="alert">The saved check changed. Refresh before continuing.</Alert><Inline><Button type="button" variant="secondary" disabled={p.locked} onClick={p.onRefresh}>Refresh setup</Button></Inline></Stack>}
  {p.role!==null&&p.phase==='setup'&&<>
   <Text as="p">{p.selectionLabel}</Text>
   {writer?<Stack as="form" onSubmit={event=>{event.preventDefault();p.onPrepare();}}>
    <Fieldset legend="Check settings" disabled={p.locked||p.reading}>
     <Field label="DataForSEO connection" htmlFor={p.prefix+'connection'}><Select aria-label="DataForSEO connection" id={p.prefix+'connection'} value={p.connectionId} onChange={event=>p.onConnection(event.target.value)}><Option value="">Choose a connection</Option>{p.connections.map(connection=><Option key={connection.id} value={connection.id}>{connection.name}</Option>)}</Select></Field>
     {!p.schedulePurpose&&<Field label="Retrieval method" htmlFor={p.prefix+'method'}><Select aria-label="Retrieval method" id={p.prefix+'method'} value={p.method} onChange={event=>p.onMethod(event.target.value as 'queued'|'live')}><Option value="queued">Queued</Option><Option value="live">Live</Option></Select></Field>}
     <Tooltip content="Live retrieves results immediately. Queued waits for the provider to finish. Both use the tracker’s saved market, devices and keywords."><Button type="button" variant="ghost" aria-label="About ranking methods">About ranking methods</Button></Tooltip>
     {p.connections.length?<Button type="submit" variant="primary" disabled={!p.canPrepare||p.conflict||!p.connectionId}>{p.schedulePurpose?'Continue to schedule':'Run rank check'}</Button>:p.role==='owner'?<Button type="button" variant="secondary" onClick={p.onOpenProviders}>Open Connections</Button>:<Text as="p">Ask a workspace owner to add DataForSEO.</Text>}
    </Fieldset>
   </Stack>:<Text as="p">An editor can run a check.</Text>}
  </>}
  {p.phase==='review'&&q&&<Stack>
   <Text as="p">{q.targetLabel} · {q.selectionLabel}</Text>
   {q.expired?<Alert tone="warning" role="alert">These settings expired. Return to the tracker and run again.</Alert>:p.schedulePurpose?<Button type="button" variant="primary" disabled={p.locked||!p.canConfigureSchedule} onClick={p.onConfigureSchedule}>Configure schedule</Button>:<><Text as="p" role="status">{p.locked?'Starting rank check…':'The check is ready to run.'}</Text>{!p.locked&&!p.pending&&<Button type="button" variant="primary" disabled={!q.canStart} onClick={p.onStart}>Run rank check</Button>}</>}
  </Stack>}
 </Stack>;
}
