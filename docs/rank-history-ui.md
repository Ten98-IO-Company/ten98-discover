# Rank observations presentation leaf

Load Ponytail and UX Copy Refiner. Return ONLY JSON {"files":[{"path":"src/components/RankHistoryView.tsx","content":"complete TSX source"}]}. One original public-intended React19/TypeScript presentation component, <=145lines. No state/effects/timers/API/router/window/storage/validation/financial arithmetic/dependency. Only Skill tool; no shell/files/network/subagents/applying changes. GPT owns validation, current authorization, async lifecycle, expiry and independent tests. These supplied interfaces are reviewed public-intended display contracts; no credentials/private fixtures.

Import only type * as React from 'react'. Export named RankHistoryView(p:RankHistoryViewProps):React.JSX.Element and the exact types below. Existing CSS research-panel,stack,card,row,between,field,hint,dim,alert,notice,btn primary,btn ghost,table-wrap,pill. No new stylesheets/fonts/assets/redesign. No h1 because the app shell owns it. Section heading id prefix+'history-heading', tabIndex=-1. Bounded tables minWidth900 within labelled focusable table-wrap (role=region tabIndex=0);360px pagefit, plain strings may need style overflowWrap:anywhere in table cells for verylong URLs. Native controls and explicit button types. No raw HTML or URL links.

```ts
export type RankObservationFilters={device:'both'|'desktop'|'mobile';search:string;pinned:'all'|'true'|'false'};
export type RankBaselineDisplay={days:1|7|30|90;change:string;source:string;targetAt:string;observedAt:string;position:string};
export type RankLatestDisplay={id:string;keywordId:string;keyword:string;device:string;pinned:boolean;attempt:string;observation:string;coverage:string;observedAt:string;availability:string;baselines:readonly RankBaselineDisplay[]};
export type RankObservationDisplay={id:string;runId:string;device:string;attemptedAt:string;observedAt:string;retrievedAt:string;outcome:string;position:string;coverage:string;target:string;compatibility:string;scope:string;availability:string;rankingUrl:string|null;diagnostic:string|null};
export type RankHistoryViewProps={
 prefix:string;role:'owner'|'admin'|'editor'|'viewer'|null;phase:'latest'|'keyword';reading:boolean;loaded:boolean;error:string;
 target:string;enabledDevices:string;asOf:string;filters:RankObservationFilters;filterDirty:boolean;appliedFilters:string;
 latest:readonly RankLatestDisplay[];keyword:string;removed:boolean;observations:readonly RankObservationDisplay[];nextCursor:string|null;
 onFilters:(value:RankObservationFilters)=>void;onApply:()=>void;onRefresh:()=>void;onMore:()=>void;onBack:()=>void;onLatest:()=>void;
 onKeyword:(id:string)=>void;onRun:(id:string)=>void;
};
```

All display strings already formatted/validated by GPT controller. Do not parse dates or calculate deltas, average ranks, round costs, infer eligibility or generate provider calls. Null/expired/unavailable states are intentionally supplied strings, not zero. No graphs/interpolation or pagination guesses. Cursor is opaque controller-owned. Latest may retain an older compatible observation alongside a more recent failed/uncertain/incompatible/expired attempt: always display both supplied columns. Baseline change may be unavailable for same observation, different rank basis, unranked observations or expired data; render provided change verbatim. Positive change means improved rank, negative worse, controller labels it. Every baseline includes its requested target and actual observation dates, and explicit source. Never call earliest fallback an exact 1/7/30/90-day comparison.

Common: root research-panel stack. Top button exact 'Back to tracker' -> onBack (reading does not disable navigation). error nonempty=>role alert, text only. reading=>role status 'Loading rank observations…'. Ifrole null, no protected tables/filters/data; ifreading show only commonloading; ifnotreading button exact 'Reload access' ->onRefresh and text 'Rank observations are unavailable. Reload access or return to the tracker.' No write/paid/connection/provider/schedule controls anywhere, viewer gets same read-only observations.

Latest phase:
- h2 exact 'Latest rank observations' with required focus ID.
- Current scope card: supplied target (domain inclsubdomains, market, language, requested depth and maxbillablepages), label 'Enabled devices: '+enabledDevices, label 'Results as of: '+asOf. Keep asOf supplied Unavailable beforeload honest; no client clock.
- Explicit filter form onSubmit preventDefault+onApply. Device select label 'Device', options Both devices(both),Desktop(desktop),Mobile(mobile). Keyword input label 'Keyword contains', maxLength200, controlled filters.search. Pin select label 'Pinned keywords', options All keywords(all),Pinned(true),Unpinned(false). Each onChange onFilters full copy; no auto-submit. Buttons 'Apply filters' submit and 'Refresh observations' typebutton onRefresh. Do not disable editing/Refresh while reading: controller supersedesoldread. Above current table show supplied appliedFilters text so draft filter values never pretend the rows are already filtered. filterDirty=>hint 'Apply filters to update these observations.' Loadmoredisabledwhenreading or filterDirty.
- Latest table columns Keyword, Device, Latest attempt, Retained observation, 1 day, 7 days, 30 days, 90 days. Keyword button text exactly row.keyword -> onKeyword(keywordId), optional 'Pinned' pill. Latestattempt suppliedplain. Retained observation cell contains observation,availability,coverage and 'Observed '+observedAt; all four are separatetextlines so no missingdata disguisedzero.
- For each of the four baseline cells render baseline.change prominently, baseline.position, baseline.source, 'Target '+targetAt and 'Observed '+observedAt. Values are important, don't collapse dates into tooltiponly. Use smaller hint text. Allfour baselines suppliedinorder, use dayskey. Table scrolling containswidth. No arbitrary truncationofrows.
- loaded&&error===''&&latest.length===0=> 'No tracked keywords match these filters.' Never claim empty whileloading/unloaded/error.
- nextCursornonnull=>button exact 'Load more observations' onMore disabledreading||filterDirty.

Keyword phase:
- h2 exact 'Keyword rank history' focus ID; supplied keyword asplain paragraph, ifremoved show notice 'This keyword was removed from the tracker. Its retained history remains available.' No implied recreation.
- Buttons 'Latest observations' onLatest and 'Refresh history' onRefresh. Same target scope and enableddevices; asOf referslatestonly so DO NOTshowasOf here.
- Small filter form only Device select (samevalue/onFilters fullcopy), 'Apply device filter' submit preventDefault+onApply. Do NOTshowsearch/pinfields. appliedFilters visible + filterDirty same applyhint.
- Table columns Attempt,Device,Outcome,Position,Coverage,Observed,Source. Attempt cell button exact row.attemptedAt -> onRun(runId) (opensknownreceipt, neverstarts). Outcome includes suppliedoutcome,compatibility,availability,scope,diagnosticifnonnull; positionplain; coverageplain; Observed includes observedAt and 'Retrieved '+retrievedAt; Source includes capturedtarget, plainrankingUrl or emdash. No anchors for provider URLs. Longuntrustedtextwraps insideboundedcell.
- Explicit hint 'History includes failed and incompatible attempts. Opening a check does not run it again.'
- loaded&&error===''&&observations.length===0=> 'No retained attempts match this device filter.'
- nextCursornonnull=>button 'Load more history' onMore disabledreading||filterDirty.

Use native accessibility labels, no color-only status. Buttons cannot accidentallysubmit otherforms. Headercontrols rowwrap onmobile, labelselect in fieldnotgridfixedcolumn. No h1/duplicateparenttitle, noemptyplaceholdercards, no server fields invented. Pure JSX only. Finish entire component without commentary in JSON. Skill calls are permitted only for supplied curated skills. Do not read any file or access network.
