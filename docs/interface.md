# Interface direction and usability checks

The owner requested a stronger connection to the applications being combined. This pass changes the working interface rather than introducing a separate mockup or UI framework.

## Reference patterns

- Umami: compact statistics, date controls adjacent to the report, a primary activity chart and paired breakdown tables. Reference: [website layout](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/%28main%29/websites/%5BwebsiteId%5D/WebsiteLayout.tsx).
- OpenSEO: persistent project context, grouped sidebar destinations and mobile navigation that closes after choosing a page. Reference: [sidebar](https://github.com/every-app/open-seo/blob/89e5a00717cdf049b7c2b4e29646edb3a7d4995b/src/client/components/Sidebar.tsx).
- Elmo: separate project measurement and configuration groups, with organization tools kept distinct from brand work. Reference: [application sidebar](https://github.com/elmohq/elmo/blob/3c673d0253d01ae030fa41519f62ad7e54f2281b/apps/web/src/components/app-sidebar.tsx).

These are structural references. This pass uses original React/CSS within the existing application and adds no upstream UI package or dependency.

## Changes

The previous narrow layout placed the full workspace menu ahead of every page. Mobile navigation now starts collapsed behind a labelled button; choosing a destination closes it and transfers keyboard focus to the page. Desktop navigation stays beside the content. Project measurement, connections and workspace settings have separate groups.

Analytics now has compact date presets, a custom-date disclosure, one metric grid, activity and paired page/event tables. Setup, recent events and worker diagnostics have their own appropriate surfaces. Empty analytics offers a direct installation action; it does not use fabricated traffic. Missing visitor estimates retain their unavailable labels and explanation.

The palette is cool neutral with graphite text and a restrained violet accent. Shared controls use consistent borders, spacing and typography. System fonts avoid an external font dependency; numbers use tabular figures. Navigation and controls retain visible focus, native semantics and 44px mobile targets.

The selected workspace, project and section now live in the installation URL. Sidebar destinations are ordinary links, supporting reload, bookmarks, Back/Forward and opening a new tab. The explicit New project destination remains a form after reload. Filter values and form drafts are not part of the URL. These links require normal account/workspace permissions; they do not create public report shares.

The URL contains only allowlisted section names and workspace/project identifiers. Membership and project discovery resolve the target before a project panel mounts; missing or forbidden targets fall back to an accessible page with an explanation. A failed project-list request offers a retry rather than claiming the workspace is empty. Deliberate navigation adds a history entry, while default selection and unavailable-target normalization replace the current entry.

Google and OIDC return fragments take initial priority, then yield to a newer user choice. Invitation and identity capabilities are captured once in memory and removed from the address bar through the router; mixed or duplicate callback fields are rejected. They are never copied to query parameters, browser storage or history state. Project/account changes continue clearing panel state through the existing keys and authorization handlers. Session and navigation generations prevent earlier login, project creation or membership responses from selecting a page or signing out a later session.

Google connections follow the same hierarchy: each source has a heading, provider label, explicit status and separated import rows. Once a project has connections, adding another is a native disclosure so setup controls do not displace existing reports. A successful Google authorization return uses a polite informational notice; failed authorization remains an alert. Disconnected sources explain that retained snapshots can still be read.

## Verification

The combined Google, keyword, serving-domain and navigation tree passed the production build, TypeScript, plan checks and 153 unit/VM checks (two platform skips). An independent production Edge run passed the navigation scenarios and the serving-domain tracker, consent, Origin filter/CSV and revocation flows. Existing Google, native analytics, retention, Explorer, context/prompts and static report-isolation browser checks also passed with native link semantics. All provider/domain transport in these acceptance fixtures was synthetic.

TypeScript and production build passed. Visual review covers the actual local application, including empty metrics and the compact sidebar. Browser acceptance additionally checks mobile navigation/focus, installation and event-page separation, delayed project loading, report editing/sharing and privacy-setting behavior. Exact completed evidence belongs in the foundation runbook; this document does not certify full V1 parity.
