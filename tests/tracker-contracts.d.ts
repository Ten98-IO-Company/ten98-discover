declare namespace Ten98Tracker {
 type ConsentKey = 'analytics'|'advertising'|'adUserData'|'adPersonalization'|'replay';
 type Consent = {analytics:boolean;advertising:boolean;adUserData:boolean;adPersonalization:boolean;replay?:boolean};
 type Provider = 'meta'|'ga4'|'google_ads'|'cloudflare'|'tiktok'|'linkedin'|'microsoft_ads'|'pinterest'|'snapchat'|'x';
 type Destination = {provider:Provider;assetId:string;enabled:boolean;owner:'managed'|'external';ownershipConfirmed:boolean;mappings:{event:string;target?:string}[]};
 type Configuration = {destinations:Destination[]};
 type NativeSettings = {enabled:boolean;consentMode:'builtin'|'external';collectionMode?:'cookieless'|'consent-first';captureReferrer:boolean;captureCampaigns:boolean;captureScreen:boolean;excludeBots:boolean;excludedPaths:string[];linkIdentities?:boolean;capturePerformance?:boolean;replay?:{enabled:boolean;sampleRate:number;maskLevel:'strict'|'moderate';maxDurationMs:number;blockSelector:string};heatmap?:{enabled:boolean;sampleRate:number}};
 type PublicConfig = {schemaVersion:2|3;siteKey:string;environment:string;origin:string;revisionId:string|null;consentEpoch:string;validUntil:string;configuration:Configuration;nativeTracking:NativeSettings};
 type EventProperties = {value?:string;currency?:string;transactionId?:string;itemId?:string};
 type Event = {name:string;eventId:string;url:string;properties:EventProperties};
 type SiteOptions = {siteKey:string;environment:string;collectorOrigin?:string;acknowledgeReload?:boolean};
 type Site = {siteKey:string;environment?:string;endpoint:string;tag?:string};
 type PreferenceFields = {epoch:string;choice:Consent;updatedAt:number;expiresAt:number};
 type LegacyPreference = PreferenceFields & {version?:never;basicOptOut?:never};
 type CurrentPreference = PreferenceFields & {version:2;basicOptOut:boolean};
 type Preference = LegacyPreference | CurrentPreference;
 type ChoiceResult = {ok:boolean;reason?:string;reloadRequired?:boolean};
 type VendorAdapter = {invoke:(event:Event,target:string)=>void;stop:()=>void;pageviewsOwned:boolean};
 type Route = {destination:Destination;queue:{event:Event;target:string;epoch:string;consent:string;at:number}[];seen:Set<string>;state:string;reason:string;adapter?:VendorAdapter;loading?:boolean;failed?:boolean};
 type State = {tag?:string;siteKey:string;environment:string;origin:string;collectPath?:string;storageKey:string;consent:Consent;basicOptOut:boolean;preferenceReadable:boolean;consentExpires:number;config:PublicConfig|null;expires:number;routes:Route[];loaded:boolean;reload:boolean;reloaded:boolean;nativeContext:string|null;nativeIdentifier:string|undefined;nativeGeneration:number;nativeRequests:Set<AbortController>;fetching?:boolean;expiryTimer?:ReturnType<typeof setTimeout>;dialog?:HTMLDialogElement|null;closeDialog?:(()=>void)|null;preferenceButton?:HTMLButtonElement|null;preferenceStyle?:HTMLLinkElement;nativePageObservation?:PageObservation;replayRestartRequired?:boolean;heatmapRestartRequired?:boolean} & NativeState;
 type Hook<F> = F & {protocolVersion?:number};
 type Api = {consent:(value:unknown,options:SiteOptions)=>ChoiceResult;setAnalyticsOptOut:(value:unknown,options:SiteOptions)=>ChoiceResult;destinationStatus:(options:SiteOptions)=>unknown;consentPreferences:(options:SiteOptions)=>boolean};
 type Hub = {api:Api;sites:Site[];destinationInit?:(site:Site)=>void;destinationEvent?:(site:Site,event:unknown)=>void;destinationIdentify?:(identifier:unknown,properties:unknown,options:SiteOptions)=>Promise<unknown>;destinationResetIdentity?:(options:SiteOptions)=>ChoiceResult;nativeStop:Hook<(state:State)=>void>;nativeEvent:Hook<(state:State,event:unknown)=>void>;nativeIdentify:Hook<(state:State,identifier:unknown,properties:unknown)=>Promise<unknown>>;nativeAllowed?:Hook<(state:State)=>boolean>;nativeConsentAllowed?:Hook<(state:State)=>boolean>;replayAllowed?:Hook<(state:State)=>boolean>;replayStop?:Hook<(state:State,erase:boolean)=>void>;replayStart?:Hook<(state:State)=>void>;heatmapStart?:Hook<(state:State,fresh?:boolean)=>void>;preferencesContainer?:HTMLElement} & CaptureHub;
 type VendorContext = {allowed:()=>boolean;consent:()=>Consent;pageUrl:()=>string;loadScript:(url:string,attributes?:Record<string,string>)=>Promise<void>};
 type Values = Record<string,unknown>;
 type VendorCall = {(...args:unknown[]):void;apply:(receiver:unknown,args:ArrayLike<unknown>)=>void};
 type VendorQueue = VendorCall & {queue:(unknown[]|IArguments)[];q:unknown[][];push?:VendorQueue;loaded?:boolean;version?:string;callMethod?:VendorCall;handleRequest?:VendorCall;exe?:VendorCall};
 type TikTokQueue = unknown[][] & Record<'page'|'track'|'identify'|'instances'|'debug'|'on'|'off'|'once'|'ready'|'alias'|'group'|'enableCookie'|'disableCookie'|'holdConsent'|'revokeConsent'|'grantConsent',VendorCall> & {_i:Record<string,TikTokQueue>;_u?:string;_t:Record<string,number>;_o:Record<string,object>;instance:(id:string)=>TikTokQueue};
 type VendorGlobals = {fbq:VendorQueue;lintrk:VendorQueue;pintrk:VendorQueue;snaptr:VendorQueue;twq:VendorQueue;ttq:TikTokQueue;uetq:{push:(...args:unknown[])=>number};UET:new(options:{ti:string;q:unknown;enableAutoSpaTracking:boolean;disableAutoPageView:boolean;enableAutoConsent:boolean})=>{push:(...args:unknown[])=>number}};
 type GoogleSdk = {layer:IArguments[];call:(...args:unknown[])=>void;ids:Set<string>;loading:Promise<void>};
}
interface Window {__ten98FoundationHub?:Ten98Tracker.BootstrapHub;__ten98FoundationSites?:Set<string>;ten98?:Ten98Tracker.BootstrapApi & Partial<Ten98Tracker.Api>;doNotTrack?:string;[key:string]:unknown}
interface Navigator {globalPrivacyControl?:boolean;msDoNotTrack?:string}

declare namespace Ten98Tracker {
 type BootstrapApi = {track:(name:unknown,properties?:unknown,options?:unknown)=>void;identify:(first:unknown,second?:unknown,third?:unknown)=>Promise<unknown>;resetIdentity:(options:SiteOptions)=>ChoiceResult};
 type BootstrapHub = Omit<Hub,'api'> & {api:BootstrapApi & Partial<Api>};
 type PageObservation = {url:string;basic:boolean;sent:boolean;generation:number;dropped?:boolean};
 type NativeState = {selfReferral?:{generation:number;from:PageObservation|null};performanceCapture?:PerformanceCapture;heatmapCapture?:HeatmapCapture|null;heatmapHidden?:boolean;replayCapture?:ReplayCapture|null;replayResumeRequest?:string|null;replayDocumentBlocked?:boolean;replayOwnerSkipped?:boolean};
 type PerformanceMetric = {name:string;value:number;navigationType?:string;navigationStartTime?:number};
 type PerformanceCapture = {state:State;navigationId:string;url:string;epoch:string;generation:number;revision:number;active:boolean;started:boolean;requests:Set<AbortController>;restoreAt?:number};
 type ReplaySettings = NonNullable<NativeSettings['replay']>;
 type HeatmapSettings = NonNullable<NativeSettings['heatmap']>;
 type CaptureReply = {accepted:boolean;reason:string|null;token:string|null;createdAt:string;deadlineAt:string;uploadUntil:string;limits:Record<string,number>};
 type HeatmapReply = CaptureReply & {captureId:string;settings:HeatmapSettings};
 type ReplayReply = CaptureReply & {recordingId:string;settings:ReplaySettings};
 type ReplayRecord = {version:1;siteKey:string;collector:string;origin:string;epoch:string;settings:ReplaySettings;requestId:string;beginUrl:string;localDeadline:number;nextSequence:number;usedBytes:number;terminal:boolean;reply:ReplayReply|null};
 type Geometry = {basis:'document-css-v1';direction:'ltr'|'rtl';pageWidth:number;pageHeight:number;viewportWidth:number;viewportHeight:number};
 type GeometryFact = {geometry:Geometry;scrollX:number;scrollY:number;left:number};
 type HeatmapPoint = {kind:'click'|'scroll';scrollX:number;scrollY:number;offsetMs:number;x?:number;y?:number;clientX?:number;clientY?:number};
 type BackgroundLocation = {kind:'event';sequence:number;index:number;chunkSha256:string}|{kind:'fragment';fragmentId:string};
 type BackgroundRef = {hash:string|null;location:BackgroundLocation|null;acks:number;total:number};
 type BackgroundMeta = {ref:BackgroundRef;href:string;width:number;height:number;timestamp:number};
 type BackgroundPlan = {requestId:string;replay:ReplayCapture;meta:BackgroundRef;snapshot:BackgroundRef;geometry:Geometry;plane:string;geometryKey:string|null;offset:number;sent:boolean};
 type HeatmapCapture = {state:State;url:string;epoch:string;generation:number;settings:HeatmapSettings;start:number;active:boolean;queue:{body:string;bytes:number;requestId:string;geometry:Geometry|undefined}[];parts:HeatmapPoint[];queuedBytes:number;usedBytes:number;usedBatches:number;lastOffset:number;sending:boolean;ending:boolean;reply:HeatmapReply|null;backgroundPlans:BackgroundPlan[];backgroundBatches:Record<string,string>;backgroundRequested:Record<string,boolean>;backgroundSending:boolean;geometry?:Geometry;nextUrl?:string|null;controller?:AbortController|null;click?:((event:MouseEvent)=>void)|null;scroll?:((event:globalThis.Event)=>void)|null;resize?:(()=>void)|null;flushTimer?:ReturnType<typeof setInterval>;endTimer?:ReturnType<typeof setTimeout>};
 type PartReference = {ref:BackgroundRef;index:number};
 type ReplayChunk = {bytes:Uint8Array<ArrayBuffer>;final:boolean;references?:PartReference[]};
 type ReplayCapture = {state:State;generation:number;epoch:string;key:string;active:boolean;queue:ReplayChunk[];parts:string[];partReferences:PartReference[];partBytes:number;partNodes:number;queuedBytes:number;started:boolean;sending:boolean;finishing:boolean;record?:unknown;controller?:AbortController|null;stop?:(()=>void)|null;flushTimer?:ReturnType<typeof setInterval>;endTimer?:ReturnType<typeof setTimeout>;backgroundMeta?:BackgroundMeta|null};
 type RecorderEvent = {type:4;timestamp:number;data:{href:string;width:number;height:number}}|{type:0|1|2|3;timestamp:number;data:Record<string,unknown>};
 type NativeInput = {type?:'performance';name?:string;eventId?:string;url:string;properties?:unknown;tag?:string;navigationId?:string;metric?:string;value?:number;revision?:number};
 type Dimensions = {distinctId?:string;language?:string;referrer?:string;screen?:{width:number;height:number};campaign?:Record<string,string>;clickIds?:Record<string,string>;tag?:string};
 type NativePayload = NativeInput & {siteKey:string;dimensions:Dimensions;context?:string;consent?:{analytics:true;epoch:string};collection?:{mode:'cookieless';epoch:string}};
 type IdentifyScalar = string|number|boolean|null;
 type IdentifyProperties = {[key:string]:IdentifyScalar|IdentifyScalar[]|IdentifyProperties};
 type IdentifySnapshot = {identifier:string|undefined;properties:IdentifyProperties};
 type IdentifyOutcome = {status:string;reason?:string;requestId?:string;sentAt?:string;duplicate?:boolean};
 type CaptureHub = {lastUrl?:string;restored?:boolean;destinationLoaderRequested?:boolean;heatmapStates?:State[];replayStates?:State[];replayOwner?:ReplayCapture|null;takeReplaySnapshot?:Hook<()=>void>;replayLoader?:Promise<boolean>;performanceLoader?:Promise<boolean>;startReplayRecorder?:Hook<(settings:ReplaySettings,emit:(event:RecorderEvent|null)=>void)=>(()=>void)|null>;startPerformance?:Hook<(emit:(metric:PerformanceMetric)=>void)=>void>};
}
// Ready views are used only after the existing begin/storage gates and callback installation.
declare namespace Ten98Tracker { type ActiveReplayRecord = ReplayRecord & {reply:ReplayReply}; }

// Private APIs used by the pinned vendor bundles; the checked views supply these lexical parameters.
declare namespace Ten98Tracker {
 type VitalReporter = 'onLCP'|'onINP'|'onCLS'|'onFCP'|'onTTFB';
 type WebVitalsAdapter = Record<VitalReporter,(callback:(metric:PerformanceMetric)=>void,options:{reportAllChanges:boolean})=>void>;
 type RrwebEvent = {type:number;timestamp:number;data:RrwebData};
 type ReplayRecordOptions = {emit:(event:RrwebEvent)=>void;blockClass:string;blockSelector:string;maskAllInputs:boolean;maskInputFn:()=>string;maskTextSelector:string;maskTextFn:(value:unknown)=>string;slimDOMOptions:'all';inlineStylesheet:boolean;recordCanvas:boolean;recordCrossOriginIframes:boolean;collectFonts:boolean;inlineImages:boolean;sampling:{mousemove:number;scroll:number;input:'last'};plugins:unknown[];errorHandler:()=>boolean};
 type ReplayPlayerOptions = {root:HTMLElement;speed:number;showWarning:boolean;showDebug:boolean;skipInactive:boolean;mouseTail:boolean;triggerFocus:boolean;UNSAFE_replayCanvas:boolean};
 type ReplayPlayer = {iframe:HTMLIFrameElement;wrapper:HTMLElement;destroy:()=>void;getCurrentTime:()=>number;pause:(offset:number)=>void;play:(offset:number)=>void;setConfig:(options:{speed:number}|{skipInactive:boolean})=>void;getMetaData:()=>{totalTime:number};on:(event:'resize'|'finish',callback:()=>void)=>void;disableInteract:()=>void;enableInteract:()=>void;getMirror:()=>{getId:(node:Node)=>number}};
 type ReplayCore = {record:((options:ReplayRecordOptions)=>(()=>void)|undefined)&{mirror:{getNode:(id:number)=>Node|null}};takeFullSnapshot:()=>void;Replayer:new(events:ReplayEnvelope[],options:ReplayPlayerOptions)=>ReplayPlayer};
 type ReplayCoreModule = {exports:ReplayCore};
 type ReplayPlayerMessage = {type:'error';message:string}|{type:'ready';duration:number}|{type:'ended'}|{type:'tick';time:number;playing:boolean};
 type HeatmapPlayback = {geometry:Geometry}&({mode:'click';points:{x:number;y:number;count:number}[]}|{mode:'scroll';bands:{depth:number;captures:number}[];captures:number});
 type HeatmapExtent = {release:()=>void;check:()=>boolean};
 type HeatmapOrigin = {x:number;y:number};
 type ReplayStyleOwner = Pick<CSSStyleSheet,'cssRules'|'deleteRule'>;
 type ReplayStyleRule = CSSRule & {style?:CSSStyleDeclaration;cssRules?:CSSRuleList;deleteRule?:(index:number)=>void};
}
// Optional fields read from the pinned recorder emitter; individual values remain checked by the sanitizer.
declare namespace Ten98Tracker {
 type RrwebRule = {rule?:unknown};
 type RrwebData = Record<string,unknown> & {source?:number;text?:string;isChecked?:boolean;texts?:{id:number;value:unknown}[];adds?:RrwebRule[];styles?:{rules?:RrwebRule[]}[];set?:{property?:unknown;value?:unknown}};
 // These projections are confined to the existing validators; their inputs remain unknown.
 type HeatmapValidationCandidate = {geometry:Geometry;mode:unknown;points:unknown;bands:unknown;captures:number};
 type HeatmapPointCandidate = {x:number;y:number;count:number};
 type HeatmapBandCandidate = {depth:number;captures:number};
 type PlayerInitCandidate = {type?:unknown;protocol?:unknown;events?:unknown;heatmap?:unknown};
 type PlayerCommandCandidate = {type?:unknown;axis?:unknown;value?:unknown;offset?:unknown};
 type ReplayEventCandidate = {type:number;timestamp:number;data:Record<string,unknown>&{source?:number;width:number;height:number}};
}
// The player validates the common envelope; nested input fields intentionally stay unknown.
declare namespace Ten98Tracker { type ReplayEnvelope = {type:number;timestamp:number;data:Record<string,unknown>}; }
