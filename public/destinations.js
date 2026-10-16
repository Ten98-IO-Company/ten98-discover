(function () {
  'use strict';
  // Also guard standalone loading by an older tracker or a manual script tag.
  if (!['http:', 'https:'].includes(location.protocol) || location.origin === 'null' || window.origin === 'null') return;
  var hub = window.__ten98FoundationHub;
  if (!hub || !hub.api || window.ten98 !== hub.api || hub.destinationInit) return;
  var DAY = 86400000, started = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now(), sites = [], owners = Object.create(null);
  var purposes = ['analytics', 'advertising', 'adUserData', 'adPersonalization'];
  var names = ['page_view', 'sign_up', 'generate_lead', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];
  var targets = {
    meta: ['PageView', 'CompleteRegistration', 'Lead', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
    ga4: names, google_ads: [null, 'conversion', 'conversion', 'conversion', 'conversion', 'conversion', 'conversion'],
    cloudflare: ['sdk_pageview'], tiktok: ['Pageview', 'CompleteRegistration', 'Lead', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
    linkedin: [null, 'conversion', 'conversion', 'conversion', 'conversion', 'conversion', 'conversion'],
    microsoft_ads: names.slice(0, 7), pinterest: ['pagevisit', 'signup', 'lead', 'viewcontent', 'addtocart', 'initiatecheckout', 'checkout'],
    snapchat: ['PAGE_VIEW', 'SIGN_UP', null, 'VIEW_CONTENT', 'ADD_CART', 'START_CHECKOUT', 'PURCHASE'],
    x: ['configured', 'configured', 'configured', 'configured', 'configured', 'configured', 'configured']
  };
  var patterns = {meta: /^\d{1,25}$/, ga4: /^G-[A-Z0-9]{4,20}$/, google_ads: /^AW-\d{1,20}$/,
    cloudflare: /^[a-fA-F0-9]{32}$/, tiktok: /^[A-Z0-9]{10,32}$/, linkedin: /^(?!0+$)\d{1,20}$/,
    microsoft_ads: /^(?!0+$)\d{1,20}$/, pinterest: /^(?!0+$)\d{1,20}$/,
    snapchat: /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/, x: /^[A-Za-z0-9]{3,20}$/};
  var uuidPattern = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  function exact(pattern, value) { return typeof value === 'string' && pattern.exec(value)?.[0] === value; }
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
  function keys(value, allowed, required) {
    return plain(value) && Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; }) &&
      (required || allowed).every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
  }
  function denied() { return {analytics: false, advertising: false, adUserData: false, adPersonalization: false}; }
  function choice(value) { return keys(value, purposes) && purposes.every(function (key) { return typeof value[key] === 'boolean'; }); }
  function granted(value) { return purposes.some(function (key) { return value[key]; }); }
  function privacy() {
    return navigator.globalPrivacyControl === true || [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack].some(function (v) { return v === '1' || v === 'yes'; });
  }
  function configuration(value) {
    if (!keys(value, ['destinations']) || !Array.isArray(value.destinations) || value.destinations.length > 10) return false;
    var seen = new Set();
    for (var d of value.destinations) {
      if (!keys(d, ['provider', 'assetId', 'enabled', 'owner', 'ownershipConfirmed', 'mappings']) ||
          !Object.prototype.hasOwnProperty.call(patterns, d.provider) || seen.has(d.provider) || !exact(patterns[d.provider], d.assetId) ||
          typeof d.enabled !== 'boolean' || !['managed', 'external'].includes(d.owner) || typeof d.ownershipConfirmed !== 'boolean' ||
          (d.enabled && d.owner === 'managed' && !d.ownershipConfirmed) || !Array.isArray(d.mappings) || d.mappings.length > 8) return false;
      seen.add(d.provider);
      var events = new Set();
      for (var m of d.mappings) {
        if (!keys(m, ['event', 'target'], ['event']) || events.has(m.event) || names.indexOf(m.event) < 0 || !targets[d.provider][names.indexOf(m.event)]) return false;
        events.add(m.event);
        if (d.provider === 'google_ads') { if (!exact(/^[A-Za-z0-9_-]{1,100}$/, m.target)) return false; }
        else if (d.provider === 'linkedin') { if (!exact(/^\d{1,20}$/, m.target) || !Number.isSafeInteger(Number(m.target)) || Number(m.target) <= 0) return false; }
        else if (d.provider === 'x') { if (!exact(/^tw-[A-Za-z0-9]{3,20}-[A-Za-z0-9]{1,64}$/, m.target) || !m.target.startsWith('tw-' + d.assetId + '-')) return false; }
        else if (Object.prototype.hasOwnProperty.call(m, 'target')) return false;
      }
    }
    var ga = value.destinations.find(function (d) { return d.provider === 'ga4' && d.enabled; });
    var ads = value.destinations.find(function (d) { return d.provider === 'google_ads' && d.enabled; });
    return !(ga && ads && ga.owner !== ads.owner);
  }
  function eventInput(input) {
    if (!keys(input, ['name', 'eventId', 'url', 'properties'], ['name', 'eventId', 'url']) || !names.includes(input.name) || !exact(uuidPattern, input.eventId) || typeof input.url !== 'string' || input.url.length > 2048) return null;
    var u;
    try { u = new URL(input.url); } catch (_) { return null; }
    if (u.origin !== location.origin || u.username || u.password) return null;
    var p = input.properties;
    if (p !== undefined) {
      if (!keys(p, ['value', 'currency', 'transactionId', 'itemId'], [])) return null;
      if ((p.value === undefined) !== (p.currency === undefined)) return null;
      if (p.value !== undefined && (!exact(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/, p.value) || Number(p.value) > 1000000)) return null;
      if (p.currency !== undefined) {
        try { if (!exact(/^[A-Z]{3}$/, p.currency) || ['XXX', 'XTS'].includes(p.currency) || !Intl.supportedValuesOf('currency').includes(p.currency)) return null; } catch (_) { return null; }
      }
      if (['transactionId', 'itemId'].some(function (key) { return p[key] !== undefined && !exact(/^[A-Za-z0-9_.:-]{1,128}$/, p[key]); })) return null;
    }
    if (['purchase', 'refund'].includes(input.name) && (!p || p.value === undefined || p.currency === undefined || p.transactionId === undefined)) return null;
    return {name: input.name, eventId: input.eventId, url: u.origin + u.pathname, properties: p ? Object.assign({}, p) : {}};
  }
  function permitted(state, route) {
    if (state.reload || !state.config || Date.now() >= state.expires || Date.now() >= state.consentExpires || privacy() || !route.destination.enabled || route.destination.owner !== 'managed') return false;
    var provider = route.destination.provider;
    return provider === 'ga4' || provider === 'cloudflare' ? state.consent.analytics :
      provider === 'google_ads' ? state.consent.advertising && state.consent.adUserData : state.consent.advertising;
  }
  function saveChoice(state, value, expiresAt) {
    var record = {version: 2, basicOptOut: state.basicOptOut, epoch: state.config.consentEpoch, choice: value, updatedAt: Date.now(), expiresAt: expiresAt || Date.now() + 180 * DAY};
    return saveRecord(state, record);
  }
  function preference(record) {
    var legacy = keys(record, ['epoch', 'choice', 'updatedAt', 'expiresAt']);
    if (!legacy && (!keys(record, ['version', 'basicOptOut', 'epoch', 'choice', 'updatedAt', 'expiresAt']) || record.version !== 2 || typeof record.basicOptOut !== 'boolean')) return null;
    if (!choice(record.choice) || !legacy && record.basicOptOut && record.choice.analytics || !exact(uuidPattern, record.epoch) || !Number.isFinite(record.updatedAt) || !Number.isFinite(record.expiresAt) || record.updatedAt > Date.now() || record.expiresAt <= record.updatedAt || record.expiresAt > record.updatedAt + 180 * DAY) return null;
    return {record: record, basicOptOut: legacy ? !record.choice.analytics : record.basicOptOut};
  }
  function saveRecord(state, record) {
    try { localStorage.setItem(state.storageKey, JSON.stringify(record)); return true; } catch (_) { return false; }
  }
  function eraseChoice(state) { try { localStorage.removeItem(state.storageKey); return localStorage.getItem(state.storageKey) === null; } catch (_) { return false; } }
  function stop(state, reason, persisted) {
    if (typeof hub.nativeStop === 'function') hub.nativeStop(state);
    state.routes.forEach(function (route) {
      route.queue.length = 0;
      try { route.adapter?.stop(); } catch (_) {}
      route.state = state.loaded ? 'reload_required' : 'consent_blocked'; route.reason = reason;
    });
    if (!state.loaded) return;
    state.reload = true;
    if (persisted && !state.reloaded) {
      state.reloaded = true;
      try { location.reload(); } catch (_) {}
    } else if (!persisted && !state.reloaded) {
      state.reloaded = true;
      // Reloading this URL could restore the stale stored grant. Leave the document
      // instead; an already-sent or unload-time vendor request cannot be retracted.
      try { location.replace('about:blank#ten98-consent-storage-unavailable'); } catch (_) {}
    }
    // SDKs already executing are not stopped by our dispatch guard. If storage fails,
    // a reload could restore an old grant. If navigation is blocked, the visitor must close it.
  }
  function applyChoice(state, value, acknowledge, basicOptOut, expiresAt) {
    if (!state.config || Date.now() >= state.expires || state.reload) return {ok: false, reason: 'Configuration unavailable or page reload required.'};
    if (!choice(value)) return {ok: false, reason: 'Provide all four consent choices as booleans.'};
    var requestedOptOut = basicOptOut === undefined ? !value.analytics : basicOptOut;
    value = privacy() ? denied() : Object.assign({}, value);
    if (granted(value) && acknowledge !== true) return {ok: false, reason: 'Explain the page reload warning before requesting consent.'};
    var changed = purposes.some(function (key) { return state.consent[key] !== value[key]; }), newlyAnalytics = !state.consent.analytics && value.analytics;
    var before = nativeBasis(state);
    state.basicOptOut = requestedOptOut;
    var saved = saveChoice(state, value, expiresAt);
    if (!saved) {
      state.consent = denied();
      state.preferenceReadable = false;
      var erased = eraseChoice(state);
      stop(state, erased ? 'Consent could not be saved. Reload required.' : 'Withdrawal not applied to loaded SDKs: close this page and clear site data. Consent storage is unavailable.', erased);
      return {ok: false, reloadRequired: state.loaded, reason: erased ? 'Consent storage unavailable; no new grant was applied.' : 'Close this page and clear site data; loaded SDK withdrawal could not be applied.'};
    }
    state.consent = value;
    state.preferenceReadable = true;
    state.consentExpires = expiresAt || Date.now() + 180 * DAY;
    if ((before !== nativeBasis(state) || !value.analytics && state.basicOptOut) && typeof hub.nativeStop === 'function') hub.nativeStop(state);
    if (state.preferenceButton) state.preferenceButton.textContent = 'Tracking preferences';
    if (changed && state.loaded) stop(state, 'Consent changed. Reload required to stop already loaded vendor SDKs.', true);
    else state.routes.forEach(function (route) { route.state = permitted(state, route) ? 'ready' : 'consent_blocked'; route.reason = 'No event has been invoked by this loader.'; });
    // Observe the page as it exists now. No pre-consent event, timestamp, property
    // or vendor queue is replayed when analytics is newly granted.
    if ((newlyAnalytics || before === null && nativeBasis(state) === 'cookieless') && !state.reload && typeof hub.nativeEvent === 'function' && !(state.nativePageObservation && state.nativePageObservation.basic && state.nativePageObservation.sent && state.nativePageObservation.url === location.origin + location.pathname)) {
      try { hub.nativeEvent(state, {name: 'page_view', eventId: crypto.randomUUID(), url: location.origin + location.pathname}); } catch (_) {}
    }
    return {ok: true, reloadRequired: state.reload};
  }
  function expire(state) {
    if (Date.now() < state.expires) return;
    invalidate(state, 'Configuration expired; vendor routing is disabled pending reload.');
  }
  function invalidate(state, reason) {
    state.consent = denied();
    state.consentExpires = 0;
    // An unreadable prior refusal must not be replaced by an automatic allowance.
    var persisted = !!state.config && state.preferenceReadable && saveChoice(state, state.consent);
    if (!persisted) state.preferenceReadable = false;
    stop(state, persisted ? reason : 'Withdrawal not applied to loaded SDKs: close this page and clear site data.', persisted);
  }
  function findSite(options) {
    if (!plain(options) || !exact(uuidPattern, options.siteKey) || !['live', 'test'].includes(options.environment)) return null;
    var found = sites.filter(function (s) { return s.siteKey === options.siteKey && s.environment === options.environment && (!options.collectorOrigin || s.origin === options.collectorOrigin); });
    return found.length === 1 ? found[0] : null;
  }
  function nativeBasis(state) {
    if (state.reload || !state.config || Date.now() >= state.expires || privacy() || !state.preferenceReadable || state.basicOptOut) return null;
    if (state.consent.analytics && Date.now() < state.consentExpires) return 'consent';
    return state.config.nativeTracking.collectionMode === 'cookieless' && hub.nativeEvent?.protocolVersion === 3 && hub.nativeStop?.protocolVersion === 3 && hub.nativeIdentify?.protocolVersion === 3 ? 'cookieless' : null;
  }
  function nativeAllowed(state) {
    if (state.config && Date.now() >= state.expires) { expire(state); return false; }
    if (privacy() && !granted(state.consent)) { if (typeof hub.nativeStop === 'function') hub.nativeStop(state); return false; }
    if ((privacy() || Date.now() >= state.consentExpires) && granted(state.consent)) invalidate(state, 'Analytics permission is unavailable; loaded vendor SDKs require reload.');
    return nativeBasis(state) !== null;
  }
  function nativeConsentAllowed(state) { return nativeAllowed(state) && nativeBasis(state) === 'consent'; }
  nativeAllowed.protocolVersion = nativeConsentAllowed.protocolVersion = 3;
  hub.nativeAllowed = nativeAllowed;
  hub.nativeConsentAllowed = nativeConsentAllowed;
  function inject(state, route, url, attributes) {
    return new Promise(function (resolve, reject) {
      if (!permitted(state, route)) return reject(new Error('Consent unavailable.'));
      var script = document.createElement('script'), done = false;
      script.async = true; script.referrerPolicy = 'no-referrer'; script.src = url;
      Object.keys(attributes || {}).forEach(function (key) { script.setAttribute(key, attributes[key]); });
      var timer = setTimeout(function () { finish(false); }, 10000);
      function finish(ok) { if (done) return; done = true; clearTimeout(timer); script.onload = script.onerror = null; ok && permitted(state, route) ? resolve() : reject(new Error('SDK unavailable or consent changed.')); }
      script.onload = function () { finish(true); }; script.onerror = function () { finish(false); };
      state.loaded = true;
      try { (document.head || document.documentElement).appendChild(script); } catch (_) { finish(false); }
    });
  }
  function dispatch(state, input) {
    if (nativeAllowed(state) && typeof hub.nativeEvent === 'function') hub.nativeEvent(state, input);
    var event = eventInput(input);
    if (!event) return;
    state.routes.forEach(function (route) {
      if (!permitted(state, route)) return;
      var mapping = route.destination.mappings.find(function (m) { return m.event === event.name; });
      if (!mapping) { route.state = 'unsupported'; route.reason = 'No supported mapping for this event.'; return; }
      if (route.seen.has(event.eventId) || route.failed) return;
      route.seen.add(event.eventId); if (route.seen.size > 256) route.seen.delete(route.seen.values().next().value);
      var target = mapping.target || targets[route.destination.provider][names.indexOf(event.name)];
      route.queue.push({event: event, target: target, epoch: state.config.consentEpoch, consent: JSON.stringify(state.consent), at: Date.now()});
      if (route.queue.length > 20) route.queue.shift();
      function flush() {
        var queue = route.queue.splice(0);
        queue.forEach(function (entry) {
          if (!permitted(state, route) || entry.epoch !== state.config.consentEpoch || entry.consent !== JSON.stringify(state.consent) || Date.now() - entry.at >= 10000) return;
          try { route.adapter.invoke(entry.event, entry.target); route.state = route.adapter.pageviewsOwned ? 'ready' : 'invoked'; route.reason = route.adapter.pageviewsOwned ? 'The SDK owns its page observations; no delivery receipt is available.' : 'SDK function invoked; delivery is unverified.'; }
          catch (_) { route.state = 'blocked_or_failed'; route.reason = 'SDK invocation failed; this event will not be retried.'; }
        });
      }
      if (route.adapter) { flush(); return; }
      if (route.loading) return;
      var family = ['ga4', 'google_ads'].includes(route.destination.provider) ? 'google' : route.destination.provider;
      if (owners[family] && owners[family] !== state.storageKey) { route.failed = true; route.queue.length = 0; route.state = 'blocked_or_failed'; route.reason = 'Another site or environment owns this SDK on this page.'; return; }
      owners[family] = state.storageKey;
      route.loading = true; route.state = 'loading'; route.reason = 'Waiting for the vendor SDK.';
      createVendorAdapter(route.destination, {allowed: function () { return permitted(state, route); }, consent: function () { return state.consent; },
        pageUrl: function () { return location.origin + location.pathname; }, loadScript: function (url, attrs) { return inject(state, route, url, attrs); }})
        .then(function (adapter) { route.adapter = adapter; route.loading = false; flush(); })
        .catch(function () { route.failed = true; route.loading = false; route.queue.length = 0; route.state = 'blocked_or_failed'; route.reason = 'SDK unavailable, externally owned, or consent changed. No retry is scheduled.'; });
    });
  }
  function validatePublic(value, state) {
    if (!keys(value, ['schemaVersion', 'siteKey', 'environment', 'origin', 'revisionId', 'consentEpoch', 'validUntil', 'configuration', 'nativeTracking']) ||
      ![2, 3].includes(value.schemaVersion) || value.siteKey !== state.siteKey || value.environment !== state.environment || value.origin !== location.origin ||
      typeof value.validUntil !== 'string' || !configuration(value.configuration)) return false;
    var settings = value.nativeTracking;
    if (!keys(settings, ['enabled', 'consentMode', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots', 'excludedPaths', 'linkIdentities', 'capturePerformance'].concat(value.schemaVersion === 3 ? ['collectionMode'] : []), ['enabled', 'consentMode', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots', 'excludedPaths'].concat(value.schemaVersion === 3 ? ['collectionMode'] : [])) ||
      (value.schemaVersion === 3 && !['cookieless', 'consent-first'].includes(settings.collectionMode)) ||
      (Object.prototype.hasOwnProperty.call(settings,'linkIdentities') && typeof settings.linkIdentities !== 'boolean') ||
      (Object.prototype.hasOwnProperty.call(settings,'capturePerformance') && typeof settings.capturePerformance !== 'boolean') ||
      !['builtin', 'external'].includes(settings.consentMode) || ['enabled', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots'].some(function (key) { return typeof settings[key] !== 'boolean'; }) ||
      !Array.isArray(settings.excludedPaths) || settings.excludedPaths.length > 50 || settings.excludedPaths.some(function (path) { return typeof path !== 'string' || path.length > 256 || !exact(/^\/[^?#\u0000-\u001f]*$/, path); })) return false;
    var expiry = Date.parse(value.validUntil);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 65000) return false;
    return exact(uuidPattern, value.consentEpoch) && ((value.revisionId === null && value.configuration.destinations.length === 0) || exact(uuidPattern, value.revisionId));
  }
  async function refresh(state) {
    if (state.fetching || state.reload) return;
    state.fetching = true;
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 5000);
    try {
      var response = await fetch(state.origin + '/api/tracking-config', {method: 'POST', body: JSON.stringify({siteKey: state.siteKey, environment: state.environment}), headers: {'Content-Type': 'application/json'},
        credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error', signal: controller.signal});
      if (!response.ok || Number(response.headers.get('content-length')) > 65536) throw new Error('Configuration unavailable.');
      var text = await response.text(); if (text.length > 65536) throw new Error('Configuration too large.');
      var value = JSON.parse(text); if (!validatePublic(value, state)) throw new Error('Invalid configuration.');
      var first = !state.config, changed = state.config && (state.config.revisionId !== value.revisionId || state.config.consentEpoch !== value.consentEpoch);
      if (changed) {
        if (state.closeDialog) state.closeDialog();
        invalidate(state, 'Published revision changed; fresh consent and reload are required.');
      }
      state.config = value; state.expires = Date.parse(value.validUntil);
      if (value.nativeTracking.consentMode === 'builtin' && !state.preferenceButton) installPreferences(state);
      else if (value.nativeTracking.consentMode !== 'builtin' && state.preferenceButton) { if (state.closeDialog) state.closeDialog(); state.preferenceButton.remove(); state.preferenceButton = null; }
      clearTimeout(state.expiryTimer); state.expiryTimer = setTimeout(function () { expire(state); }, Math.max(0, state.expires - Date.now()));
      if (first || changed) state.routes = value.configuration.destinations.map(function (d) { return {destination: d, queue: [], seen: new Set(), state: d.owner === 'external' || !d.enabled ? 'not_configured' : 'consent_blocked', reason: d.owner === 'external' ? 'External ownership; this loader never injects or invokes this SDK.' : 'Waiting for explicit consent.'}; });
      if (state.reload) { state.routes.forEach(function (r) { r.state = 'reload_required'; r.reason = 'Reload required after a configuration change.'; }); return; }
      if (privacy() || (granted(state.consent) && Date.now() >= state.consentExpires)) { if (granted(state.consent)) invalidate(state, 'Tracking permission expired; reload required for loaded SDKs.'); if (privacy()) return; }
      if (first && value.consentEpoch) {
        var record, parsed, stored;
        try { stored = localStorage.getItem(state.storageKey); record = stored === null ? null : JSON.parse(stored); state.preferenceReadable = stored === null || !!(parsed = preference(record)); } catch (_) { state.preferenceReadable = false; }
        if (parsed) state.basicOptOut = parsed.basicOptOut;
        if (parsed && record.epoch === value.consentEpoch && record.updatedAt < started && record.expiresAt > Date.now() && saveRecord(state, record)) {
          state.consent = record.choice; state.consentExpires = record.expiresAt;
          if (state.preferenceButton) state.preferenceButton.textContent = 'Tracking preferences';
        } else if (parsed && record.epoch === value.consentEpoch && record.updatedAt < started && record.expiresAt > Date.now() && granted(record.choice)) state.preferenceReadable = false;
      }
      if ((first || changed) && (nativeAllowed(state) || granted(state.consent)) && !(state.nativePageObservation && state.nativePageObservation.sent && state.nativePageObservation.url === location.origin + location.pathname)) dispatch(state, {name: 'page_view', eventId: crypto.randomUUID(), url: location.origin + location.pathname});
      if (first || changed) window.dispatchEvent(new CustomEvent('ten98:destinations-ready', {detail: {siteKey: state.siteKey, environment: state.environment, collectorOrigin: state.origin}}));
    } catch (_) { if (Date.now() >= state.expires) expire(state); }
    finally { clearTimeout(timer); state.fetching = false; }
  }
  hub.destinationInit = function (site) {
    try {
      if (!site || !exact(uuidPattern, site.siteKey) || !['live', 'test', undefined].includes(site.environment)) return;
      var endpoint = new URL(site.endpoint), environment = site.environment || 'live';
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return;
      if (sites.some(function (s) { return s.siteKey === site.siteKey && s.environment === environment && s.origin === endpoint.origin; }) || sites.length >= 20) return;
      var state = {siteKey: site.siteKey, environment: environment, origin: endpoint.origin, storageKey: 'ten98:consent:v1:' + endpoint.origin + ':' + site.siteKey + ':' + environment,
        consent: denied(), basicOptOut: false, preferenceReadable: false, consentExpires: 0, config: null, expires: 0, routes: [], loaded: false, reload: false, reloaded: false, nativeContext: null, nativeIdentifier: undefined, nativeGeneration: 0, nativeRequests: new Set()};
      sites.push(state); void refresh(state); setInterval(function () { void refresh(state); }, 30000);
    } catch (_) {}
  };
  hub.destinationEvent = function (site, event) { try { var state = findSite({siteKey: site.siteKey, environment: site.environment || 'live', collectorOrigin: new URL(site.endpoint).origin}); if (state) dispatch(state, event); } catch (_) {} };
  hub.destinationIdentify = function (identifier, properties, options) { var state = findSite(options); return state ? hub.nativeIdentify(state, identifier, properties) : Promise.resolve({status: 'not_sent', reason: 'site_unavailable'}); };
  hub.destinationResetIdentity = function (options) { var state = findSite(options); if (!state) return {ok: false, reason: 'Choose one configured site and environment.'}; hub.nativeStop(state); return {ok: true}; };
  hub.api.consent = function (value, options) { var state = findSite(options); return state ? applyChoice(state, value, options.acknowledgeReload) : {ok: false, reason: 'Choose one configured site and environment.'}; };
  hub.api.setAnalyticsOptOut = function (value, options) {
    var state = findSite(options); if (!state || typeof value !== 'boolean') return {ok: false, reason: 'Choose one configured site and a boolean opt-out.'};
    if (!value && !state.basicOptOut && state.preferenceReadable && state.config && Date.now() < state.expires && !state.reload && (!granted(state.consent) || Date.now() < state.consentExpires)) return {ok: true, reloadRequired: false};
    // A basic preference change cannot renew or manufacture enhanced grants.
    var current = Date.now() < state.consentExpires ? Object.assign({}, state.consent) : denied();
    if (value) current.analytics = false;
    var result = applyChoice(state, current, options.acknowledgeReload, value, granted(current) ? state.consentExpires : undefined);
    if (result.ok && !value && !state.reload && nativeAllowed(state) && (!state.nativePageObservation || state.nativePageObservation.url !== location.origin + location.pathname)) {
      try { hub.nativeEvent(state, {name: 'page_view', eventId: crypto.randomUUID(), url: location.origin + location.pathname}); } catch (_) {}
    }
    return result;
  };
  hub.api.destinationStatus = function (options) {
    var state = findSite(options); if (!state) return {ready: false, revisionId: null, expiresAt: null, consent: denied(), routes: []};
    return {ready: !!state.config && state.expires > Date.now() && !state.reload, revisionId: state.config?.revisionId || null, expiresAt: state.expires ? new Date(state.expires).toISOString() : null,
      consent: privacy() ? denied() : Object.assign({}, state.consent), collectionMode: state.config?.nativeTracking.collectionMode || 'consent-first', basicAnalytics: nativeBasis(state) === 'cookieless', routes: state.routes.map(function (r) { return {provider: r.destination.provider, state: r.state, reason: r.reason}; })};
  };
  window.addEventListener('storage', function (event) {
    sites.forEach(function (state) {
      if (event.key !== state.storageKey && event.key !== null) return;
      var record, parsed; try { record = JSON.parse(event.newValue || 'null'); parsed = preference(record); } catch (_) {}
      var next = denied(), before = nativeBasis(state);
      state.preferenceReadable = !!parsed;
      if (parsed && parsed.basicOptOut) state.basicOptOut = true;
      if (parsed && state.config && record.epoch === state.config.consentEpoch && record.expiresAt > Date.now()) {
        purposes.forEach(function (key) { next[key] = state.consent[key] && record.choice[key]; });
      }
      var changed = purposes.some(function (key) { return next[key] !== state.consent[key]; }); state.consent = next;
      if (changed || before !== nativeBasis(state) || !parsed) stop(state, 'Tracking preference changed in another tab. Reload required for loaded SDKs.', true);
    });
  });
  hub.api.consentPreferences = function (options) {
    var state = findSite(options); if (!state || !state.config || state.reload) return false;
    if (state.dialog) { state.dialog.focus(); return true; }
    installPreferenceStyle(state);
    var prior = document.activeElement, dialog = document.createElement('dialog'), openingEpoch = state.config.consentEpoch;
    state.dialog = dialog;
    dialog.setAttribute('aria-label', 'Tracking preferences');
    dialog.className = 'ten98-tracking-dialog';
    var title = document.createElement('h2'); title.textContent = 'Tracking preferences'; dialog.appendChild(title);
    var cookieless = state.config.nativeTracking.collectionMode === 'cookieless';
    var nativeNotice = document.createElement('p'); nativeNotice.textContent = cookieless ? 'Basic analytics counts page paths and events without cookies or an analytics grant. Opting out or a browser privacy signal stops these observations. Enhanced analytics may send an identifier and profile details after you agree. Basic permission does not enable advertising or identification.' : 'Analytics records page paths and events after you agree. This website may also send an identifier and profile details to its native analytics collector. Earlier activity is discarded.'; dialog.appendChild(nativeNotice);
    var geographyNotice = document.createElement('p'); geographyNotice.textContent = 'When enabled by this site, approximate country, region and city may be derived locally from the connection address. The raw address and coordinates are not stored. This follows the analytics choice above; opting out, Do Not Track or Global Privacy Control stops new observations.'; dialog.appendChild(geographyNotice);
    if(state.config.nativeTracking.linkIdentities===true){var linkNotice=document.createElement('p');linkNotice.textContent='This website also links future activity with matching identifiers across devices and months within its own analytics project. The raw identifier is not stored. Earlier anonymous activity stays separate. Withdrawing consent stops new collection; previously accepted links remain subject to retention.';dialog.appendChild(linkNotice);}
    var warning = document.createElement('p'); warning.textContent = 'Changing consent after a vendor tag loads reloads this page and may lose unsaved work. If consent storage fails, this page closes to stop loaded SDKs; clear site data before returning. Vendor SDKs may read the full URL, referrer and automatic events. Already shared or in-flight data cannot be withdrawn here.'; dialog.appendChild(warning);
    var vendors = document.createElement('p'), vendorNames = state.routes.filter(function (r) { return r.destination.enabled; }).map(function (r) { return r.destination.provider; }); vendors.textContent = vendorNames.length ? 'Configured vendors: ' + vendorNames.join(', ') : 'No additional vendor tags are configured.'; dialog.appendChild(vendors);
    var controls = {}, feedback = document.createElement('p'), basic; feedback.setAttribute('role', 'status');
    if (cookieless) {
      var basicLabel = document.createElement('label'); basic = document.createElement('input'); basic.type = 'checkbox'; basic.checked = !privacy() && state.preferenceReadable && !state.basicOptOut; basic.disabled = privacy(); basicLabel.appendChild(basic); basicLabel.appendChild(document.createTextNode(' Allow cookieless basic analytics')); dialog.appendChild(basicLabel);
      var basicStatus = document.createElement('p'); basicStatus.textContent = nativeBasis(state) === 'cookieless' ? 'Basic analytics is currently enabled. Enhanced analytics is a separate choice.' : 'Basic observations require an available configuration and no opt-out or browser privacy signal.'; dialog.appendChild(basicStatus);
    }
    purposes.forEach(function (purpose) { var label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = privacy() ? false : state.consent[purpose]; input.disabled = privacy(); controls[purpose] = input; label.appendChild(input); label.appendChild(document.createTextNode(' ' + ({analytics: cookieless ? 'Enhanced analytics' : 'Analytics', advertising: 'Advertising', adUserData: 'Ad user data', adPersonalization: 'Ad personalization'})[purpose])); dialog.appendChild(label); });
    if (privacy()) { var veto = document.createElement('p'); veto.textContent = 'Your browser privacy signal requires denial.'; dialog.appendChild(veto); }
    function close() { dialog.close(); dialog.remove(); state.dialog = null; state.closeDialog = null; prior?.focus(); }
    state.closeDialog = close;
    function button(label, action) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); dialog.appendChild(b); }
    function submit(value, optOut) {
      if (state.dialog !== dialog || state.config.consentEpoch !== openingEpoch) return;
      var result = applyChoice(state, value, true, optOut); if (result.ok && !result.reloadRequired) close(); else feedback.textContent = result.reason || 'Reload required to apply this choice to loaded SDKs.';
    }
    button('Save choices', function () { var value = {}; purposes.forEach(function (p) { value[p] = controls[p].checked; }); if (basic && !basic.checked) value.analytics = false; submit(value, basic ? !basic.checked : undefined); });
    button('Deny all', function () { submit(denied(), true); }); button('Cancel', close); dialog.appendChild(feedback);
    dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dialog); if (typeof dialog.showModal !== 'function') { dialog.remove(); state.dialog = null; state.closeDialog = null; return false; } dialog.showModal(); controls.analytics.focus(); return true;
  };
  function installPreferenceStyle(state) {
    if (state.preferenceStyle) return;
    var stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.referrerPolicy = 'no-referrer'; stylesheet.href = state.origin + '/tracking-consent.css?v=3'; (document.head || document.documentElement).appendChild(stylesheet); state.preferenceStyle = stylesheet;
  }
  function installPreferences(state) {
    function mount() {
      if (!document.body || state.preferenceButton || state.config.nativeTracking.consentMode !== 'builtin') return;
      installPreferenceStyle(state);
      var button = document.createElement('button'); button.type = 'button'; button.textContent = state.config.nativeTracking.collectionMode === 'cookieless' ? 'Tracking preferences' : 'Choose tracking preferences';
      button.setAttribute('aria-label', 'Tracking preferences for ' + state.origin);
      // Native button/dialog semantics keep the embedded consent flow keyboard accessible.
      button.className = 'ten98-tracking-button';
      button.addEventListener('click', function () { hub.api.consentPreferences({siteKey: state.siteKey, environment: state.environment, collectorOrigin: state.origin}); });
      if (!hub.preferencesContainer) {
        var container = document.createElement('aside'); container.setAttribute('aria-label', 'Website tracking preferences');
        container.className = 'ten98-tracking-preferences';
        hub.preferencesContainer = container; document.body.appendChild(container);
      }
      state.preferenceButton = button; hub.preferencesContainer.appendChild(button);
    }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, {once: true});
  }
  // Original protocol adapters; vendor SDKs retain their own automatic observations.
  // An invoked SDK function is not a receipt, and stop() always requires coordinator reload.
  var vendorInstances = Object.create(null), googleSdk;
  var vendorUrls = {meta: 'https://connect.facebook.net/en_US/fbevents.js', cloudflare: 'https://static.cloudflareinsights.com/beacon.min.js',
    tiktok: 'https://analytics.tiktok.com/i18n/pixel/events.js', linkedin: 'https://snap.licdn.com/li.lms-analytics/insight.min.js',
    microsoft_ads: 'https://bat.bing.com/bat.js', pinterest: 'https://s.pinimg.com/ct/core.js', snapchat: 'https://sc-static.net/scevent.min.js', x: 'https://static.ads-twitter.com/uwt.js'};
  function foreignScript(hosts) {
    return Array.from(document.querySelectorAll('script[src]')).some(function (script) { try { return hosts.includes(new URL(script.src).hostname); } catch (_) { return false; } });
  }
  function requireAllowed(context) { if (!context.allowed()) throw new Error('Consent unavailable.'); }
  function googleChoice(value) { return {analytics_storage: value.analytics ? 'granted' : 'denied', ad_storage: value.advertising ? 'granted' : 'denied', ad_user_data: value.adUserData ? 'granted' : 'denied', ad_personalization: value.adPersonalization ? 'granted' : 'denied'}; }
  function propertyFields(event, mapping) { var output = {}, p = event.properties || {}; Object.keys(mapping).forEach(function (key) { if (p[key] !== undefined) output[mapping[key]] = key === 'value' ? Number(p[key]) : p[key]; }); return output; }
  async function createVendorAdapter(destination, context) {
    requireAllowed(context);
    var provider = destination.provider, asset = destination.assetId, instanceKey = provider + ':' + asset;
    if (vendorInstances[instanceKey]) return vendorInstances[instanceKey];
    // Ownership is claimed by the coordinator before calling this factory.
    var promise = (async function () {
      var invoke, stop = function () {}, pageviewsOwned = false, p, queue;
      if (provider === 'ga4' || provider === 'google_ads') {
        if (!googleSdk) {
          if (window.gtag || window.google_tag_manager || window.ten98DataLayer || foreignScript(['www.googletagmanager.com', 'www.google-analytics.com'])) throw new Error('External Google owner.');
          var layer = []; window.ten98DataLayer = layer;
          var gtag = function () { layer.push(arguments); };
          gtag('consent', 'default', googleChoice(denied()));
          gtag('set', 'ads_data_redaction', true); gtag('set', 'url_passthrough', false);
          gtag('consent', 'update', googleChoice(context.consent())); gtag('js', new Date());
          googleSdk = {layer: layer, call: gtag, ids: new Set(), loading: context.loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(asset) + '&l=ten98DataLayer')};
        }
        await googleSdk.loading; requireAllowed(context);
        googleSdk.call('consent', 'update', googleChoice(context.consent()));
        if (!googleSdk.ids.has(asset)) {
          googleSdk.call('config', asset, {send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: context.consent().adPersonalization, page_location: context.pageUrl(), page_referrer: ''});
          googleSdk.ids.add(asset);
        }
        invoke = function (event, target) {
          var values = propertyFields(event, {value: 'value', currency: 'currency', transactionId: 'transaction_id'});
          values.send_to = provider === 'ga4' ? asset : asset + '/' + target;
          if (provider === 'ga4') { values.page_location = event.url; values.page_referrer = ''; if (event.properties.itemId !== undefined) values.items = [{item_id: event.properties.itemId}]; }
          googleSdk.call('event', provider === 'ga4' ? target : 'conversion', values);
        };
        stop = function () { if (provider === 'ga4') window['ga-disable-' + asset] = true; googleSdk.layer.length = 0; };
      } else {
        var globalNames = {meta: ['fbq', '_fbq'], tiktok: ['ttq', 'TiktokAnalyticsObject'], linkedin: ['lintrk', '_linkedin_data_partner_ids', '_linkedin_partner_id'], microsoft_ads: ['uetq', 'UET'], pinterest: ['pintrk'], snapchat: ['snaptr'], x: ['twq'], cloudflare: ['__cfBeacon']};
        var sdkUrl = vendorUrls[provider];
        if (!sdkUrl || globalNames[provider].some(function (name) { return window[name] !== undefined; }) || foreignScript([new URL(sdkUrl).hostname])) throw new Error('External SDK owner.');
        if (provider === 'meta') {
          queue = function () { queue.callMethod ? queue.callMethod.apply(queue, arguments) : queue.queue.push(arguments); };
          queue.queue = []; queue.push = queue; queue.loaded = true; queue.version = '2.0'; window.fbq = window._fbq = queue;
          await context.loadScript(sdkUrl); requireAllowed(context);
          window.fbq('set', 'autoConfig', false, asset); window.fbq('init', asset); window.fbq('consent', 'grant');
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency'}); if (event.properties.itemId !== undefined) { values.content_ids = [event.properties.itemId]; values.content_type = 'product'; } window.fbq('trackSingle', asset, target, values, {eventID: event.eventId}); };
          stop = function () { window.fbq('consent', 'revoke'); };
        } else if (provider === 'cloudflare') {
          await context.loadScript(sdkUrl, {'type': 'module', 'data-cf-beacon': JSON.stringify({token: asset, spa: true})}); requireAllowed(context);
          pageviewsOwned = true; invoke = function () {};
        } else if (provider === 'tiktok') {
          var methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
          function tiktokQueue() { var q = []; methods.forEach(function (method) { q[method] = function () { q.push([method].concat(Array.from(arguments))); }; }); return q; }
          queue = tiktokQueue(); queue._i = {}; queue._i[asset] = tiktokQueue(); queue._i[asset]._u = sdkUrl; queue._t = {}; queue._t[asset] = Date.now(); queue._o = {}; queue._o[asset] = {}; queue.instance = function (id) { return queue._i[id]; };
          window.TiktokAnalyticsObject = 'ttq'; window.ttq = queue;
          await context.loadScript(sdkUrl + '?sdkid=' + encodeURIComponent(asset) + '&lib=ttq'); requireAllowed(context); window.ttq.grantConsent();
          invoke = function (event, target) { if (event.name === 'page_view') { window.ttq.page(); return; } var values = propertyFields(event, {value: 'value', currency: 'currency'}); if (event.properties.itemId !== undefined) values.content_ids = [event.properties.itemId]; window.ttq.track(target, values, {event_id: event.eventId}); };
          stop = function () { window.ttq.revokeConsent(); };
        } else if (provider === 'linkedin') {
          queue = function (a, b) { queue.q.push([a, b]); }; queue.q = []; window.lintrk = queue; window._linkedin_data_partner_ids = [asset];
          await context.loadScript(sdkUrl); requireAllowed(context);
          invoke = function (event, target) { window.lintrk('track', {conversion_id: Number(target), event_id: event.eventId}); };
        } else if (provider === 'microsoft_ads') {
          window.uetq = []; window.uetq.push('consent', 'default', {ad_storage: 'denied'}); window.uetq.push('consent', 'update', {ad_storage: 'granted'});
          await context.loadScript(sdkUrl); requireAllowed(context);
          if (typeof window.UET !== 'function') throw new Error('UET unavailable.');
          window.uetq = new window.UET({ti: asset, q: window.uetq, enableAutoSpaTracking: false, disableAutoPageView: true, enableAutoConsent: false});
          invoke = function (event, target) { if (event.name === 'page_view') window.uetq.push('event', 'page_view', {page_path: new URL(event.url).pathname}); else { var values = propertyFields(event, {value: 'revenue_value', currency: 'currency'}); values.event_category = 'ten98'; window.uetq.push('event', target, values); } };
        } else if (provider === 'pinterest') {
          queue = function () { queue.queue.push(Array.from(arguments)); }; queue.queue = []; queue.version = '3.0'; window.pintrk = queue;
          await context.loadScript(sdkUrl); requireAllowed(context); window.pintrk('load', asset); window.pintrk('page');
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency', transactionId: 'order_id'}); values.event_id = event.eventId; if (event.properties.itemId !== undefined) values.line_items = [{product_id: event.properties.itemId}]; window.pintrk('track', target, values); };
        } else if (provider === 'snapchat') {
          queue = function () { queue.handleRequest ? queue.handleRequest.apply(queue, arguments) : queue.queue.push(arguments); }; queue.queue = []; window.snaptr = queue;
          await context.loadScript(sdkUrl); requireAllowed(context); window.snaptr('init', asset, {});
          invoke = function (event, target) { var values = propertyFields(event, {currency: 'currency', transactionId: 'transaction_id'}); values.client_dedup_id = event.eventId; if (event.properties.value !== undefined) values.price = event.properties.value; if (event.properties.itemId !== undefined) values.item_ids = [event.properties.itemId]; window.snaptr('track', target, values); };
        } else if (provider === 'x') {
          queue = function () { queue.exe ? queue.exe.apply(queue, arguments) : queue.queue.push(arguments); }; queue.queue = []; queue.version = '1.1'; window.twq = queue;
          await context.loadScript(sdkUrl); requireAllowed(context); window.twq('set', {hide_page_location: true}); window.twq('config', asset);
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency'}); values.conversion_id = event.eventId; if (event.properties.itemId !== undefined) values.contents = [{content_id: event.properties.itemId}]; window.twq('event', target, values); };
        }
      }
      return {invoke: function (event, target) { requireAllowed(context); invoke(event, target); }, stop: stop, pageviewsOwned: pageviewsOwned};
    })();
    vendorInstances[instanceKey] = promise;
    return promise;
  }
  (hub.sites || []).forEach(hub.destinationInit);
})();
