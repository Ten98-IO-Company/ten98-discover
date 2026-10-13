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

The first available project opens after loading, unless the user has already chosen another page or started a new project. Delayed requests must not replace an identity verification or newer navigation. Project/account changes continue clearing panel state through the existing keys and authorization handlers.

Google connections follow the same hierarchy: each source has a heading, provider label, explicit status and separated import rows. Once a project has connections, adding another is a native disclosure so setup controls do not displace existing reports. A successful Google authorization return uses a polite informational notice; failed authorization remains an alert. Disconnected sources explain that retained snapshots can still be read.

## Verification

TypeScript and production build passed. Visual review covers the actual local application, including empty metrics and the compact sidebar. Browser acceptance additionally checks mobile navigation/focus, installation and event-page separation, delayed project loading, report editing/sharing and privacy-setting behavior. Exact completed evidence belongs in the foundation runbook; this document does not certify full V1 parity.
