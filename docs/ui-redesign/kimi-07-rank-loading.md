Implement approved L01 rank-family loading boundary for ten98-monitor. Use Kimi K3 maximum thinking; load Ponytail only. One360-second draft with at most one180-second repair, maximum9minutes total, then stop and hand back to GPT. Only Skill tools; no shell/filesystem/network/subagents/deployment/provider calls. Return bare JSON {"reactImport":"...","lazyDeclaration":"...","rankView":"..."}; no prose or whole-file output. GPT reviews/applies/tests.

Only src/routes/index.tsx may change, in exactly the three supplied original blocks. No other source, dependencies, configuration, routes, CSS, tests or controller edits. This addresses measured eager rank UI loading; do not claim byte savings until an independent production build measures them.

1. Replace original React import by adding installed React lazy and Suspense; preserve useEffect/useRef/useState. Keep separate type import unchanged.
2. Replace ONLY eager RankTrackingPanel import with a stable module-scope const named RankTrackingPanel initialized using lazy. Use literal import('../components/RankTrackingPanel'), map named module.RankTrackingPanel to {default:...}. Attach catch only to this import promise, returning a stable failure component as default. Failure component displays accessible role=alert 'Rank tracking couldn’t load. Reload this page to try again.' plus an explicit native button className='btn' type='button' minHeight44 labelled 'Reload page', onClick invoking window.location.reload(). Show no raw error, no retry loop, no useEffect/state/router/sessionStorage/prefetch. The function is created only when that one import fails, never per App render. No generic error boundary or wrapper abstraction. Successful module's props/component remain untouched.
3. Wrap ONLY the existing condition's RankTrackingPanel element in Suspense with fallback a role=status paragraph 'Loading rank tracking…'. Keep condition and all original panel props/callback expressions byte-equivalent. Do not wrap shell/sidebar/auth/main; normal navigation must remain available. No new key. No App imports on demand based on user-controlled paths, no captured project/user in promise, no data fetch in fallback.

Behavior requirements: one initial code boundary, not nested feature splitting. RankTrackingPanel retains its own current-user/workspace/project key, dirty/unknown-write blockers, quote expiry, hidden mounted report/history flows and all API authorization. Import completion after changing scope/view/signout must merely allow current React tree to render, never restore old state or fetch for old scope. Initial import failure has no mounted rank controller/paid intent; reload recovery applies only there, never around runtime errors in successfully loaded controller. Keep other route/auth error behavior.

Native dynamic import failure is cached by React.lazy; honest page reload recovery is intentional. No automatic reload. Props named export type (read-only context):
type Props={workspaceId:string;projectId:string;userId:string;origin:string;onUnauthorized:()=>void;onOpenProviders:()=>void};

PUBLIC ORIGINAL BLOCKS (each exactly once):
S1:
import { useEffect, useRef, useState } from 'react'

S2:
import { RankTrackingPanel } from '../components/RankTrackingPanel'

S3:
        {view === 'ranks' && project && me && <RankTrackingPanel workspaceId={workspaceId} projectId={project.id} userId={me.user.id} origin={project.origin} onUnauthorized={unauthorized} onOpenProviders={() => go(target('providers'))} />}

Independent GPT acceptance (not drafting claims): TypeScript/build, emitted initial/deferred chunk raw/gzip measurement and server-only boundary scan, cold signin/overview excludes rank-family chunk and rank API, actual ranks navigation fetches chunk/current scope, delayed code navigation/project/session A-B-A no stale data/GET, failed chunk local error + restored-assets explicit reload, mobile/loading/main focus, existing rank management/check/history/reporting/schedule negative cases for unknown writes/expiry/Back. No livepreview/provider/DB mutation by the drafter.