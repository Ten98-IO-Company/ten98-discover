# Information architecture and flow replacement map

Status: target interaction design; existing functionality remains authoritative until each bounded replacement passes acceptance. This is not permission to remove requirements or invent APIs.

## Intended users and success

- Operator installs and maintains one free Docker instance; success is a working, recoverable installation.
- Workspace owner connects accounts and approves provider spending; success is a correctly scoped source and a first trustworthy result.
- Admin/editor configures what their existing capabilities allow; success is a saved draft or controlled result without hidden billing/permission changes.
- Analyst/viewer reads and compares evidence; success is explaining a result and its coverage, then exporting or saving it where allowed.

Returning analysts should reach useful data without walking through setup. First-time owners should be able to defer OIDC, paid providers and optional tags. Configuration and actual observation are separate milestones.

## Proposed navigation

Desktop rail: brand, native workspace selector, native project selector plus New project, then six families:

1. Analytics — Overview, Explore, Conversions, Recent events.
2. AI visibility — Insights, Prompt library. Existing comparisons, citations and execution evidence are local pages within this family.
3. Search — Keywords, Rankings, Site audits.
4. Reports — Saved reports, Google reports, Meta reports.
5. Connections — Reporting sources. Future provider connections join this inventory only when implemented.
6. Tracking — Install snippet, Browser destinations, Collection & privacy, Domains.

Below the project families:
- Project context: a direct utility link, not an additional “analytics” view.
- Workspace settings: Team, Providers & spending, API keys, Retention; actions shown according to actual current authority.
- Account: Security, Sign-in methods.
- Instance settings: provider app registration and operator identity configuration, visible only to an instance operator.
- New workspace: selector action; Sign out in the account area.

Implementation should use one stable rail and a local page row under the page title. Do not add a second full-height nested sidebar. Native details/summary for a family group is acceptable while preserving real Link elements for pages. Selected family opens automatically. At most the active family needs to be expanded by default.

Existing query navigation remains the compatibility contract: workspace/project/view. Do not replace it with an invented path router or leak OAuth/invitation/proof capabilities into query state. Family labels are presentation grouping, not a new authorization layer.

## Every current view accounted for

| Current view key | Target location / label | Decision and non-negotiable behavior |
|---|---|---|
| project | Analytics / Overview | Preserve native AnalyticsPanel, unknown vs zero, first-project resolution and authenticated scope. No synthetic all-source score. |
| explore | Analytics / Explore | Preserve typed properties, timezone/date filters, exports and every existing operator. |
| conversions | Analytics / Conversions | Preserve saved funnels/goals, authored rules, result evidence and permissions. |
| events | Analytics / Recent events | Keep retained-event count, latest observations and retention boundary. Do not label lifetime/realtime. |
| prompts | AI visibility / Prompt library | Preserve bulk authoring, immutable versions, archive/restore, tags and explicit quote/run/receipt paths. |
| ai-insights | AI visibility / Insights | Keep insights/comparison/citation/receipt functions reachable. Local navigation needs approved state/URL work; first visual batch keeps current callbacks. |
| keywords | Search / Keywords | Keep research, saved lists/tags, exports and quoted refreshes. Results first; creation/research forms on request. |
| ranks | Search / Rankings | Preserve tracker editor, manual checks, history/reporting, schedules, exact caps and recovery actions. |
| audits | Search / Site audits | Preserve static audit limits, start/progress/cancel/delete, coverage and page/link evidence. Never relabel as rendered/Lighthouse. |
| reports | Reports / Saved reports | Preserve authored HTML/templates, sandboxed preview, immutable share snapshots, expiration and revocation. |
| google | Reports / Google | Current GoogleReportsPanel still owns connect/property/import/read. Until safely split, Connections links here with “Manage Google connections in Google reports.” No fake separate inventory/API. |
| meta-reports | Reports / Meta | Preserve manual imports, latest complete coverage, retained campaigns, snapshots and exports. |
| meta | Connections / Meta ads | Rename the navigation context to Reporting connections; retain exact account-selection and remote-revocation flows. |
| installation | Tracking / Install snippet | Copy one generated script; native consent and verified serving-origin guidance; actual event evidence. |
| destinations | Tracking / Browser destinations | Preserve test/live drafts, managed/external ownership, consent, dry-run, publish and rollback gates. |
| collection | Tracking / Collection & privacy | Preserve native collection switch, privacy/DNT/GPC, metadata and exclusions. Role checks remain current. |
| domains | Tracking / Domains | Canonical/serving/redirect roles, proof/reissue/revoke and observed checks remain. No automatic DNS edit or per-client report hostname. |
| context | Project context utility | Preserve profile, sections, competitors, pages, research log, template summaries, revisions and ambiguous-write handling. |
| new-project | Project selector / New project | Same name/origin contract. No new required timezone field until backend preference contract exists. |
| team | Workspace settings / Team | Preserve member roles, invitations, revocation and ownership safeguards. |
| providers | Workspace settings / Providers & spending | Owner-only credentials, budget and reconciliation behavior. Provider costs are distinct from application access. |
| keys | Workspace settings / API keys | Preserve scopes, expiry, one-time secret display and revoke. Do not move secrets into URLs/local storage. |
| retention | Workspace settings / Retention | Preserve policy, preview, cleanup/erasure distinctions and retained financial/authored records. |
| workspace | Workspace selector / New workspace | Preserve create callback, membership refresh and navigation generation guards. |
| security | Account / Security | Password, sessions, 2FA and recovery codes remain explicit secure flows. |
| identity | Account / Sign-in methods; operator block under Instance | Initially retain the existing screen and proof handlers. Separate account linking/recovery from provider administration only after GPT approves the split. |
| google-app | Instance / Provider apps / Google | Only operator sees and changes client configuration. Preserve redirectUri and testing/enable state. |
| meta-app | Instance / Provider apps / Meta | Keep operator registration/rotation/disable, app prerequisites and back route; owners are not operators. |

A new Connections overview is a proposed view, not an existing endpoint. Its first implementation can be a small navigation list of supported source routes and their limitations. It must not fabricate readiness or enumerate sources from unrelated credentials. A unified live inventory requires a reviewed data contract first.

## Retirement/replacement decisions

| Existing pattern | Replace with | What must survive |
|---|---|---|
| Eighteen equal-weight project links | Six stable family headings and local pages | All existing links, browser Back/Forward/reload/new-tab behavior and role checks. |
| Visible page title repeated inside embedded feature | One visible h1 plus meaningful nested headings | Standalone view labels and focus IDs remain available. |
| Tall always-open filter forms before results | Compact applied-filter summary and Filters disclosure | Every draft field, Apply/reset, validation, dirty state, paging and current report provenance. |
| Repeated methodology prose above each result | One short contextual qualifier plus Measurement details disclosure | Current-context vs captured-history, source/web-search mode, coverage and exact denominator warnings. |
| Card per connection/provider plus full blank form | Compact source/provider list and explicit Add/Edit state | Connection name, stable asset ID, state, timezone/currency, access and recovery actions. |
| Empty selects and disabled pagination with no data/pages | Specific empty state and one available next action | Loading/failed/denied distinct from empty, paging when actually present. |
| Worker check visually near tracker success | Named diagnostic disclosure, then equivalent instance operations page | Worker enqueue/check path, permitted roles and errors; never claim it verified a browser visit. |
| Separate mandatory provider setup before a first result | Outcome choice and relevant prerequisites only | Every optional provider remains configurable later. |
| New OIDC form permanently open below provider cards | Provider list, Add provider, Edit draft | Test transaction, existing session, explicit proof review/enable and local recovery. |
| Two prominent technical development notices | One quiet persistent Development preview badge plus release details link | Honest development status. Removal of a duplicate footer must not imply V1 readiness. |
| “Connected” as a generic healthy badge | Actual states: App configured, Authorized, Asset selected, Report available | Separate authority, credentials, import coverage and vendor delivery. |
| SaaS billing/upgrade/seat restrictions | Retire entirely | External provider spending/usage caps and owner approval are retained. |
| Legacy-product history migration | Retire entirely | Own exports/backup/restore and native account report imports remain. |
| Per-client report custom domains | Retire entirely | Report slugs under installation domain, revocation, expiry, branding, alias-domain measurement remain. |

“Retire” in this document removes redundant presentation or explicitly excluded product scope. It never deletes a working function, security warning, financial receipt, source limitation or pending V1 requirement.

## First-result flow

Current facts: owner setup creates the owner/default workspace; project create accepts name and origin; project creation returns to native analytics; snippet, events and imports already exist. A resumable outcome chooser is proposed. Existing APIs do not provide a universal setup-completion model.

~~~mermaid
flowchart TD
  A[Host installation guide] --> B[Secure installation]
  B --> C[Create project]
  C --> D[Choose first result]
  D -->|Website visits| E[Install snippet]
  D -->|Existing reports| F[Choose reporting source]
  D -->|Site audit| G[Review audit]
  D -->|Configure later| J[Project results]
  E --> H[Verify received event]
  F --> I[Authorize and import]
  G --> J
  I --> J
  H -->|Observed event| J
  H -->|Missing or blocked| E
  B -->|Already configured| K[Sign in]
  K --> J
~~~

| Screen | Primary action | Required fields/evidence | Recovery |
|---|---|---|---|
| Host installation guide | Start services | Existing Docker URL/config/key/migration instructions | Diagnostics, restart/recovery instructions. Do not put host secrets in browser prose. |
| Secure installation | Create owner | Current setup token, name, email, password, workspace name contract | Invalid token stays local; 409 offers Sign in. Do not weaken secure claim. |
| Create project | Create project | Name + origin only, using existing validation | Inline origin error, no path/query/userinfo silently accepted. |
| Choose first result | Continue | Choice of visits, reports, audit; optional defer | Remember navigation intent only with an approved storage contract. Completion from actual evidence, not click. |
| Install snippet | Copy snippet | Server-generated public snippet, correct origin/consent | Manual select/copy on clipboard failure, localhost reachability message. |
| Verify received event | Refresh events | Actual accepted receipt and timestamp or explicit no event | Review origin/consent/CSP instructions. Do not claim fetched script equals received visit. |
| Choose reporting source | Connect account | Implemented provider and relevant prerequisite state | Operator handoff when app unavailable; other outcomes remain available. |
| Review audit | Start audit | Existing limits/coverage and safety contract | Failed/blocked/partial run retains evidence, retry only through existing action. |
| Project results | Inspect result | Actual source/date/coverage | “No visits yet” or “No report imported”; appropriate next step. |

Happy path asks for one necessary account form, one project form, and one outcome choice. It does not ask for OIDC, every provider key, ten browser tag IDs or team invitations.

Target compact wireframes (labels are examples; no observed metrics claimed):

    ten98   Workspace [Example team]   Project [Example site]   Development preview
    ---------------------------------------------------------------------------
    Analytics      Install snippet                             [Copy snippet]
    AI visibility  https://example.com
    Search         [ generated script, horizontally scrollable ]
    Reports        1 Add script   2 Grant analytics consent   3 Refresh events
    Connections    Last accepted event: None yet                 [Refresh events]
    Tracking       No event observed. Review origin and consent.
                   > Installation help       > Worker diagnostics

    Choose first result
    ( ) Website visits     One snippet on the site
    ( ) Existing reports   Authorize a reporting account
    ( ) Site audit         Inspect a public site with stated limits
    [Continue]  Configure later

States: loading retains the current step label; empty names the missing observation; error points to the next recoverable action; success cites the saved/received result. No generic “Setup complete” without exact supporting evidence.

## Native account/report flow

~~~mermaid
flowchart TD
  A[Reporting sources] --> B{Provider app available?}
  B -->|No| C[Operator setup handoff]
  C --> A
  B -->|Yes| D[Authorize account]
  D -->|Canceled or failed| A
  D --> E[Select account or property]
  E -->|No readable assets| F[Review access or switch account]
  F --> D
  E --> G[Review import]
  G --> H[Import status]
  H -->|Available dates or rows| I[Source report]
  H -->|Reconnect required| D
  H -->|Failed or unknown result| J[Review receipt and permitted retry]
  J --> H
~~~

1. Reporting sources: short inventory with provider, source/account label, actual status and one contextual action. Only implemented sources have a working action. Initial Google/Meta presentation differences remain explicit until safe extraction.
2. Operator setup handoff: exact callback/instructions and actor responsible; credential fields only in authorized operator UI. Workspace ownership never grants operator access.
3. Authorize account: clear read-only purpose; use current server-generated authorization URL validation. Return to intended workspace/project. Cancel/back preserves nonsecret draft where current behavior supports it.
4. Select account/property: show name and stable ID, source timezone/currency when returned; require explicit selection. Empty and partial discovery are different. Current Meta fixed-account semantics remain; changing account uses another connection.
5. Review import: source, report kind, inclusive date range, capability/limits and explicit Start import. A default last-seven-days range is permissible only within the existing provider contract and current source-local dates. No schedule switch until scheduling exists.
6. Import status/source report: pending, partial, complete, denied, failed and expired remain distinct. Show actual complete dates/rows and gaps; never an invented percent/ETA.
7. Disconnect review: local disconnect and remote revoke remain separate. The wider-grant effect is visible before revoke; retained report access and retention rules stay accurate.

    Connections / Meta ads                                 [Add connection]
    Source              Account                 Status               Action
    Example source      No account selected     Choose account        [Choose]
    > Connection details
    -----------------------------------------------------------------------
    Authorization is for reports. Browser destinations are in Tracking.

    Reports / Meta       Source [Example source]    Dates [range] [New import]
    Account / timezone / currency / latest successful coverage
    [Latest] [Campaigns] [Import history]
    Data table or exact empty/unavailable state
    > Receipt and measurement details

Pixel installation never counts as authorization. Authorization never enables a pixel. An imported snapshot is never replayed as a newly collected event.

## One-snippet browser destination flow

Keep the current operations: choose environment → configure destination/asset and ownership → save draft → dry-run against that saved version → review → explicit publish → diagnose/rollback.

- Install the loader once. Add supported official provider tags centrally; no arbitrary script editor.
- Saving credentials for reports does not configure browser tags.
- Show test/live environment beside the primary action.
- Default to the existing dry-run simulation. Label “Would invoke,” “Consent blocked,” “Unsupported” and other actual states without a green delivery claim.
- Preserve publish prerequisites: saved clean draft, no managed/external Google ownership conflict, ownership confirmations, successful dry-run of current saved version, and acknowledgment.
- SDK third-party data/reload consequences stay beside the acknowledgment. Do not bury them in a collapsed help block.
- History remains a compact revision table. Rollback creates a fresh revision/consent epoch; do not call it undoing already-sent data.
- Consent API/developer details can be collapsed. Privacy meaning and active state cannot.

Success is “Configuration published” with its revision, not “Vendor received your conversion.” Real provider delivery remains its own acceptance gate.

## OIDC setup without lockout

~~~mermaid
flowchart TD
  A[Identity provider list] --> B[Edit provider draft]
  B --> C[Test sign-in]
  C -->|Failed or canceled| B
  C --> D[Review tested identity]
  D -->|Explicit enable with valid proof| E[Provider enabled]
  D -->|Expired proof| C
  E --> A
  A --> F[Local recovery instructions]
~~~

- List providers with enabled state and draft/live/tested revision first.
- Add/Edit reveals display name, issuer, client ID, write-only secret and authentication mode. Additional network exceptions and verified-email invite policy stay advanced and explicit.
- Keep server discovery/validation behavior; do not introduce a browser fetch to arbitrary issuer URLs.
- Test uses the existing step-up and authorization transaction. Current login remains active until the existing validated flow says otherwise.
- Proof review shows issuer/subject and actual identity information. A matching email never silently links accounts.
- Enable requires the current successful proof and operator capability, and vault availability. Future recovery verification enhancements require backend contracts; do not invent a checked “Recovery tested” field.
- Disabling names session revocation and users who may lose access; configured local recovery remains documented. Never remove the last sign-in path or add an unauthenticated bypass.
- Account linking/recovery stays distinct from operator administration; all existing proof expiry, factor and invitation callback precedence remains.

    Instance / Identity providers                              [Add provider]
    Provider       Enabled      Draft / Live / Tested           Actions
    Example IdP    No           supplied actual revisions      [Edit] [Test]
    > Exact callback and registration help
    Local recovery: current supported instructions

    Review test sign-in
    Provider / issuer / subject / proof expiry
    “A matching email does not link accounts.”
    [Enable tested provider]  Cancel

## Result to evidence

Every results page follows: page title → local pages → applied filter/source row → current metric/coverage summary → data table or chart → exact evidence. On desktop a detail panel may appear beside results only if it uses the existing controller entry and remains keyboard/focus accessible. Initially a full-width section or local detail page is safer and sufficient.

Unknown, filtered-empty, unavailable, expired, partial, role-limited and valid-zero are distinct. Required source/measurement caveats stay near the metrics. Full methodology can be disclosed. Export retains the current server-approved scope, snapshot/revision and formula-safe formatting. Do not change an export to “visible rows only” because the table is paged.

## Full 81-capability placement remains required

| Requirement IDs | Eventual home | Readiness rule |
|---|---|---|
| P01–P07 | Scope selectors, Workspace/Account/Instance settings, API/MCP tools | Current roles/local auth/OIDC slices remain; missing profile/locale/RTL/theme/transfer/full API/MCP are still pending/partial. |
| P08–P10 | First-result setup, Project context, Providers & spending | Assisted website suggestions and full provider diagnostics are not supplied by a prettier manual form. |
| P11–P26 | AI visibility and its local pages | Existing prompt/insight/comparison/citation slices retain provenance. Missing adapters, schedules, historical variants, specialized Reddit/Shopping/fan-out/opportunities stay required. |
| P27–P46 | Analytics, Tracking and shareable reports | Current collection/exploration/conversions remain; realtime, sessions, cohorts, advanced reports, replay/heatmaps, boards, links/pixels and full exports are not implied. |
| P47–P60 | Search and Google reports | Current keyword/rank/static audit/import slices remain. Domain/backlink/local SEO, rendering/Lighthouse and complete Google report sets stay required. |
| P61, P63 | Assistant and programmatic workflows when implemented | Do not add a fake chat composer or advertise existing development-agent skills as application MCP. |
| P62 | Reports / Saved reports | Preserve authored HTML, templates and isolated sharing; generated reports are a separate capability. |
| P64–P69 | Providers & spending, Instance operations, retention and release evidence | Free access; keep costs, jobs, Docker/restore, privacy, license and full acceptance gates. |
| P70–P75, P78 | Tracking | Official provider loaders, consent, ownership, preview/publish/rollback; real vendor evidence still required. |
| P76–P77, P81 | Connections, provider Reports, Operations | Native reports remain separate from browser tags. Missing platforms/schedules/consolidation/operational gates stay required. |
| P79–P80 | Tracking / Domains and future source-aware search views | Preserve aliases and exact-host scope; no imaginary redirect pixels or summed overlapping backlinks. |

This table covers every P01–P81 without reducing scope. Current truthful status comes from docs/release-status.md and the latest capability evidence, not the older planning register's blanket “planned” cells.

## Decisions for the parent before dependent implementation

These do not block the token specimen:
- Choose an isolated UI branch/issue base after the concurrent citation increment stabilizes.
- Approve the family-navigation composition and whether a navigation-only Connections index is worth adding now.
- Approve any additive embedded-heading prop and local subpage/filter URL schema before Kimi touches controllers.
- Confirm rollout gates for dark mode, stored theme/locale/RTL preferences and operator/account screen separation.
- New onboarding completion storage or unified source inventory requires a real server contract. Until then derive only what current APIs prove and avoid persistent progress promises.

Implementation decisions, 2026-10-14: issue50 uses an isolated branch based on the accepted citation increment. The six-family composition is approved. Keep existing query-view navigation and source APIs; do not add a Connections inventory API, stored onboarding completion, controller URL-state changes or account/operator route split through presentation work. Light production rollout precedes a separately tested stored-theme preference. Token/specimen and global CSS drafts are disjoint parallel Kimi tasks; navigation follows an exact JSX-only replacement contract. The runner's total prompt ceiling is 20,000 characters; the compact global CSS contract includes all public source within that limit.
