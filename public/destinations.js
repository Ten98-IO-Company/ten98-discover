(function () {
  'use strict';
  // Also guard standalone loading by an older tracker or a manual script tag.
  if (!['http:', 'https:'].includes(location.protocol) || location.origin === 'null' || window.origin === 'null') return;
  var initialHub = window.__ten98FoundationHub;
  /** @type {Ten98Tracker.Hub} */ var hub = /** @type {Ten98Tracker.Hub} */ (initialHub);
  if (!hub || !hub.api || window.ten98 !== hub.api || hub.destinationInit) return;
  var DAY = 86400000, started = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now(), sites = /** @type {Ten98Tracker.State[]} */ ([]), owners = /** @type {Record<string,string>} */ (Object.create(null));
  /** @type {Exclude<Ten98Tracker.ConsentKey,'replay'>[]} */
  var purposes = ['analytics', 'advertising', 'adUserData', 'adPersonalization'];
  var names = ['page_view', 'sign_up', 'generate_lead', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];
  /** @type {Record<string,(string|null)[]>} */
  var targets = {
    meta: ['PageView', 'CompleteRegistration', 'Lead', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
    ga4: names, google_ads: [null, 'conversion', 'conversion', 'conversion', 'conversion', 'conversion', 'conversion'],
    cloudflare: ['sdk_pageview'], tiktok: ['Pageview', 'CompleteRegistration', 'Lead', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
    linkedin: [null, 'conversion', 'conversion', 'conversion', 'conversion', 'conversion', 'conversion'],
    microsoft_ads: names.slice(0, 7), pinterest: ['pagevisit', 'signup', 'lead', 'viewcontent', 'addtocart', 'initiatecheckout', 'checkout'],
    snapchat: ['PAGE_VIEW', 'SIGN_UP', null, 'VIEW_CONTENT', 'ADD_CART', 'START_CHECKOUT', 'PURCHASE'],
    x: ['configured', 'configured', 'configured', 'configured', 'configured', 'configured', 'configured']
  };
  /** @type {Record<string,RegExp>} */
  var patterns = {meta: /^\d{1,25}$/, ga4: /^G-[A-Z0-9]{4,20}$/, google_ads: /^AW-\d{1,20}$/,
    cloudflare: /^[a-fA-F0-9]{32}$/, tiktok: /^[A-Z0-9]{10,32}$/, linkedin: /^(?!0+$)\d{1,20}$/,
    microsoft_ads: /^(?!0+$)\d{1,20}$/, pinterest: /^(?!0+$)\d{1,20}$/,
    snapchat: /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/, x: /^[A-Za-z0-9]{3,20}$/};
  var uuidPattern = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  /** @param {RegExp} pattern @param {unknown} value @returns {value is string} */
  function exact(pattern, value) { return typeof value === 'string' && pattern.exec(value)?.[0] === value; }
  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
  /** @param {unknown} value @param {string[]} allowed @param {string[]} [required] @returns {value is Record<string, unknown>} */
  function keys(value, allowed, required) {
    return plain(value) && Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; }) &&
      (required || allowed).every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
  }
  /** @returns {Ten98Tracker.Consent} */
  function denied() { return {analytics: false, advertising: false, adUserData: false, adPersonalization: false}; }
  /** @param {unknown} value @returns {value is Ten98Tracker.Consent} */
  function choice(value) { return keys(value, (/** @type {Ten98Tracker.ConsentKey[]} */ (purposes)).concat('replay'), purposes) && purposes.every(function (key) { return typeof value[key] === 'boolean'; }) && (!Object.prototype.hasOwnProperty.call(value,'replay') || typeof value.replay === 'boolean' && (!value.replay || /** @type {boolean} */ (value.analytics))); }
  /** @param {Ten98Tracker.Consent} value */
  function granted(value) { return purposes.some(function (key) { return value[key]; }); }
  function privacy() {
    return navigator.globalPrivacyControl === true || [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack].some(function (v) { return v === '1' || v === 'yes'; });
  }
  /** @param {unknown} raw @returns {raw is Ten98Tracker.Configuration} */
  function configuration(raw) {
    var value = /** @type {Ten98Tracker.Configuration} */ (raw);
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
  /** @param {unknown} raw @returns {Ten98Tracker.Event|null} */
  function eventInput(raw) {
    var input = /** @type {Ten98Tracker.Event} */ (raw);
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
      if (['transactionId', 'itemId'].some(function (key) { return p[/** @type {keyof Ten98Tracker.EventProperties} */ (key)] !== undefined && !exact(/^[A-Za-z0-9_.:-]{1,128}$/, p[/** @type {keyof Ten98Tracker.EventProperties} */ (key)]); })) return null;
    }
    if (['purchase', 'refund'].includes(input.name) && (!p || p.value === undefined || p.currency === undefined || p.transactionId === undefined)) return null;
    return {name: input.name, eventId: input.eventId, url: u.origin + u.pathname, properties: p ? Object.assign({}, p) : {}};
  }
  /** @param {Ten98Tracker.State} state @param {Ten98Tracker.Route} route */
  function permitted(state, route) {
    if (state.reload || !state.config || Date.now() >= state.expires || Date.now() >= state.consentExpires || privacy() || !route.destination.enabled || route.destination.owner !== 'managed') return false;
    var provider = route.destination.provider;
    return provider === 'ga4' || provider === 'cloudflare' ? state.consent.analytics :
      provider === 'google_ads' ? state.consent.advertising && state.consent.adUserData : state.consent.advertising;
  }
  /** @param {Ten98Tracker.State} state @param {Ten98Tracker.Consent} value @param {number} [expiresAt] */
  function saveChoice(state, value, expiresAt) {
    /** @type {Ten98Tracker.Preference} */
    var record = {version: 2, basicOptOut: state.basicOptOut, epoch: /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch, choice: value, updatedAt: Date.now(), expiresAt: expiresAt || Date.now() + 180 * DAY};
    return saveRecord(state, record);
  }
  /** @param {unknown} raw @returns {{record:Ten98Tracker.Preference;basicOptOut:boolean}|null} */
  function preference(raw) {
    var record = /** @type {Ten98Tracker.Preference} */ (raw);
    var legacy = keys(record, ['epoch', 'choice', 'updatedAt', 'expiresAt']);
    if (!legacy && (!keys(record, ['version', 'basicOptOut', 'epoch', 'choice', 'updatedAt', 'expiresAt']) || record.version !== 2 || typeof record.basicOptOut !== 'boolean')) return null;
    if (!choice(record.choice) || !legacy && record.basicOptOut && record.choice.analytics || !exact(uuidPattern, record.epoch) || !Number.isFinite(record.updatedAt) || !Number.isFinite(record.expiresAt) || record.updatedAt > Date.now() || record.expiresAt <= record.updatedAt || record.expiresAt > record.updatedAt + 180 * DAY) return null;
    return {record: record, basicOptOut: legacy ? !record.choice.analytics : (/** @type {Ten98Tracker.CurrentPreference} */ (record)).basicOptOut};
  }
  /** @param {Ten98Tracker.State} state @param {Ten98Tracker.Preference} record */
  function saveRecord(state, record) {
    try { localStorage.setItem(state.storageKey, JSON.stringify(record)); return true; } catch (_) { return false; }
  }
  /** @param {Ten98Tracker.State} state */
  function eraseChoice(state) { try { localStorage.removeItem(state.storageKey); return localStorage.getItem(state.storageKey) === null; } catch (_) { return false; } }
  /** @param {Ten98Tracker.State} state @param {string} reason @param {boolean} persisted */
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
  /** @param {Ten98Tracker.State} state @param {unknown} raw @param {boolean} [acknowledge] @param {boolean} [basicOptOut] @param {number} [expiresAt] @returns {Ten98Tracker.ChoiceResult} */
  function applyChoice(state, raw, acknowledge, basicOptOut, expiresAt) {
    var value = /** @type {Ten98Tracker.Consent} */ (raw);
    if (!state.config || Date.now() >= state.expires || state.reload) return {ok: false, reason: 'Configuration unavailable or page reload required.'};
    if (plain(value) && value.replay === true && value.analytics !== true) return {ok:false,reason:'Session replay also requires Analytics permission.'};
    if (!choice(value)) return {ok: false, reason: 'Provide all four consent choices as booleans.'};
    var requestedOptOut = basicOptOut === undefined ? !value.analytics : basicOptOut;
    value = privacy() ? denied() : Object.assign({}, value);
    if (granted(value) && acknowledge !== true) return {ok: false, reason: 'Explain the page reload warning before requesting consent.'};
    var changed = (/** @type {Ten98Tracker.ConsentKey[]} */ (purposes)).concat('replay').some(function (key) { return !!state.consent[key] !== !!value[key]; }), newlyAnalytics = !state.consent.analytics && value.analytics, oldReplay = state.consent.replay === true;
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
    if (oldReplay && value.replay !== true && hub.replayStop?.protocolVersion === 3) hub.replayStop(state,true);
    if ((before !== nativeBasis(state) || !value.analytics && state.basicOptOut) && typeof hub.nativeStop === 'function') hub.nativeStop(state);
    if (value.replay === true && acknowledge === true) state.replayRestartRequired = false;
    if (state.preferenceButton) state.preferenceButton.textContent = 'Tracking preferences';
    if (changed && state.loaded) stop(state, 'Consent changed. Reload required to stop already loaded vendor SDKs.', true);
    else state.routes.forEach(function (route) { route.state = permitted(state, route) ? 'ready' : 'consent_blocked'; route.reason = 'No event has been invoked by this loader.'; });
    // Observe the page as it exists now. No pre-consent event, timestamp, property
    // or vendor queue is replayed when analytics is newly granted.
    if ((newlyAnalytics || before === null && nativeBasis(state) === 'cookieless') && !state.reload && typeof hub.nativeEvent === 'function' && !(state.nativePageObservation && state.nativePageObservation.basic && state.nativePageObservation.sent && state.nativePageObservation.url === location.origin + location.pathname)) {
      try { hub.nativeEvent(state, {name: 'page_view', eventId: crypto.randomUUID(), url: location.origin + location.pathname}); } catch (_) {}
    }
    if (!state.reload && value.replay === true && hub.replayStart?.protocolVersion === 3) hub.replayStart(state);
    if (!state.reload && value.analytics === true && hub.heatmapStart?.protocolVersion === 3) {
      var restartHeatmap = state.heatmapRestartRequired === true && acknowledge === true;
      if (acknowledge === true) state.heatmapRestartRequired = false;
      hub.heatmapStart(state,restartHeatmap);
    }
    return {ok: true, reloadRequired: state.reload};
  }
  /** @param {Ten98Tracker.State} state */
  function expire(state) {
    if (Date.now() < state.expires) return;
    invalidate(state, 'Configuration expired; vendor routing is disabled pending reload.');
  }
  /** @param {Ten98Tracker.State} state @param {string} reason */
  function invalidate(state, reason) {
    state.consent = denied();
    state.consentExpires = 0;
    // An unreadable prior refusal must not be replaced by an automatic allowance.
    var persisted = !!state.config && state.preferenceReadable && saveChoice(state, state.consent);
    if (!persisted) state.preferenceReadable = false;
    stop(state, persisted ? reason : 'Withdrawal not applied to loaded SDKs: close this page and clear site data.', persisted);
  }
  /** @param {unknown} raw @returns {Ten98Tracker.State|null} */
  function findSite(raw) {
    var options = /** @type {Ten98Tracker.SiteOptions} */ (raw);
    if (!plain(options) || !exact(uuidPattern, options.siteKey) || !['live', 'test'].includes(options.environment)) return null;
    var found = sites.filter(function (s) { return s.siteKey === options.siteKey && s.environment === options.environment && (!options.collectorOrigin || s.origin === options.collectorOrigin); });
    return found.length === 1 ? found[0] : null;
  }
  /** @param {Ten98Tracker.State} state */
  function nativeBasis(state) {
    if (state.reload || !state.config || Date.now() >= state.expires || privacy() || !state.preferenceReadable || state.basicOptOut) return null;
    if (state.consent.analytics && Date.now() < state.consentExpires) return 'consent';
    return /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.collectionMode === 'cookieless' && hub.nativeEvent?.protocolVersion === 3 && hub.nativeStop?.protocolVersion === 3 && hub.nativeIdentify?.protocolVersion === 3 ? 'cookieless' : null;
  }
  /** @param {Ten98Tracker.State} state */
  function nativeAllowed(state) {
    if (state.config && Date.now() >= state.expires) { expire(state); return false; }
    if (privacy() && !granted(state.consent)) { if (typeof hub.nativeStop === 'function') hub.nativeStop(state); return false; }
    if ((privacy() || Date.now() >= state.consentExpires) && granted(state.consent)) invalidate(state, 'Analytics permission is unavailable; loaded vendor SDKs require reload.');
    return nativeBasis(state) !== null;
  }
  /** @param {Ten98Tracker.State} state */
  function nativeConsentAllowed(state) { return nativeAllowed(state) && nativeBasis(state) === 'consent'; }
  /** @param {Ten98Tracker.State} state */
  function replayAllowed(state) { return nativeConsentAllowed(state) && state.environment === 'live' && state.consent.replay === true && /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.enabled && /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.replay?.enabled === true; }
  nativeAllowed.protocolVersion = nativeConsentAllowed.protocolVersion = replayAllowed.protocolVersion = 3;
  hub.nativeAllowed = nativeAllowed;
  hub.nativeConsentAllowed = nativeConsentAllowed;
  hub.replayAllowed = replayAllowed;
  /** @param {Ten98Tracker.State} state @param {Ten98Tracker.Route} route @param {string} url @param {Record<string,string>} [attributes] @returns {Promise<void>} */
  function inject(state, route, url, attributes) {
    return new Promise(function (resolve, reject) {
      if (!permitted(state, route)) return reject(new Error('Consent unavailable.'));
      var script = document.createElement('script'), done = false;
      script.async = true; script.referrerPolicy = 'no-referrer'; script.src = url;
      Object.keys(attributes || {}).forEach(function (key) { script.setAttribute(key, (/** @type {Record<string,string>} */ (attributes))[key]); });
      var timer = setTimeout(function () { finish(false); }, 10000);
      /** @param {boolean} ok */ function finish(ok) { if (done) return; done = true; clearTimeout(timer); script.onload = script.onerror = null; ok && permitted(state, route) ? resolve() : reject(new Error('SDK unavailable or consent changed.')); }
      script.onload = function () { finish(true); }; script.onerror = function () { finish(false); };
      state.loaded = true;
      try { (document.head || document.documentElement).appendChild(script); } catch (_) { finish(false); }
    });
  }
  /** @param {Ten98Tracker.State} state @param {unknown} input */
  function dispatch(state, input) {
    if (nativeAllowed(state) && typeof hub.nativeEvent === 'function') hub.nativeEvent(state, input);
    const event = eventInput(input);
    if (!event) return;
    state.routes.forEach(function (route) {
      if (!permitted(state, route)) return;
      var mapping = route.destination.mappings.find(function (m) { return m.event === event.name; });
      if (!mapping) { route.state = 'unsupported'; route.reason = 'No supported mapping for this event.'; return; }
      if (route.seen.has(event.eventId) || route.failed) return;
      route.seen.add(event.eventId); if (route.seen.size > 256) route.seen.delete(/** @type {string} */ (route.seen.values().next().value));
      var target = /** @type {string} */ (mapping.target || targets[route.destination.provider][names.indexOf(event.name)]);
      route.queue.push({event: event, target: target, epoch: /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch, consent: JSON.stringify(state.consent), at: Date.now()});
      if (route.queue.length > 20) route.queue.shift();
      function flush() {
        var queue = route.queue.splice(0);
        queue.forEach(function (entry) {
          if (!permitted(state, route) || entry.epoch !== /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch || entry.consent !== JSON.stringify(state.consent) || Date.now() - entry.at >= 10000) return;
          try { (/** @type {Ten98Tracker.VendorAdapter} */ (route.adapter)).invoke(entry.event, entry.target); route.state = (/** @type {Ten98Tracker.VendorAdapter} */ (route.adapter)).pageviewsOwned ? 'ready' : 'invoked'; route.reason = (/** @type {Ten98Tracker.VendorAdapter} */ (route.adapter)).pageviewsOwned ? 'The SDK owns its page observations; no delivery receipt is available.' : 'SDK function invoked; delivery is unverified.'; }
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
  /** @param {unknown} raw @param {Ten98Tracker.State} state @returns {raw is Ten98Tracker.PublicConfig} */
  function validatePublic(raw, state) {
    var value = /** @type {Ten98Tracker.PublicConfig} */ (raw);
    if (!keys(value, ['schemaVersion', 'siteKey', 'environment', 'origin', 'revisionId', 'consentEpoch', 'validUntil', 'configuration', 'nativeTracking']) ||
      ![2, 3].includes(value.schemaVersion) || value.siteKey !== state.siteKey || value.environment !== state.environment || value.origin !== location.origin ||
      typeof value.validUntil !== 'string' || !configuration(value.configuration)) return false;
    var settings = value.nativeTracking;
    if (!keys(settings, ['enabled', 'consentMode', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots', 'excludedPaths', 'linkIdentities', 'capturePerformance', 'replay', 'heatmap'].concat(value.schemaVersion === 3 ? ['collectionMode'] : []), ['enabled', 'consentMode', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots', 'excludedPaths'].concat(value.schemaVersion === 3 ? ['collectionMode'] : [])) ||
      (value.schemaVersion === 3 && !['cookieless', 'consent-first'].includes(/** @type {string} */ (settings.collectionMode))) ||
      (Object.prototype.hasOwnProperty.call(settings,'linkIdentities') && typeof settings.linkIdentities !== 'boolean') ||
      (Object.prototype.hasOwnProperty.call(settings,'capturePerformance') && typeof settings.capturePerformance !== 'boolean') ||
      (Object.prototype.hasOwnProperty.call(settings,'heatmap') && (!keys(settings.heatmap,['enabled','sampleRate']) || typeof settings.heatmap.enabled!=='boolean' || !Number.isFinite(settings.heatmap.sampleRate) || settings.heatmap.sampleRate<0 || settings.heatmap.sampleRate>1)) ||
      (Object.prototype.hasOwnProperty.call(settings,'replay') && (!keys(settings.replay,['enabled','sampleRate','maskLevel','maxDurationMs','blockSelector']) || typeof settings.replay.enabled !== 'boolean' || !Number.isFinite(settings.replay.sampleRate) || settings.replay.sampleRate<0 || settings.replay.sampleRate>1 || !['strict','moderate'].includes(settings.replay.maskLevel) || ![300000,600000,900000,1200000].includes(settings.replay.maxDurationMs) || typeof settings.replay.blockSelector !== 'string' || settings.replay.blockSelector.length>1024 || /\u0000|[\uD800-\uDFFF]/u.test(settings.replay.blockSelector))) ||
      !['builtin', 'external'].includes(settings.consentMode) || ['enabled', 'captureReferrer', 'captureCampaigns', 'captureScreen', 'excludeBots'].some(function (key) { return typeof settings[/** @type {keyof Ten98Tracker.NativeSettings} */ (key)] !== 'boolean'; }) ||
      !Array.isArray(settings.excludedPaths) || settings.excludedPaths.length > 50 || settings.excludedPaths.some(function (path) { return typeof path !== 'string' || path.length > 256 || !exact(/^\/[^?#\u0000-\u001f]*$/, path); })) return false;
    var expiry = Date.parse(value.validUntil);
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 65000) return false;
    return exact(uuidPattern, value.consentEpoch) && ((value.revisionId === null && value.configuration.destinations.length === 0) || exact(uuidPattern, value.revisionId));
  }
  /** @param {Ten98Tracker.State} state */
  async function refresh(state) {
    if (state.fetching || state.reload) return;
    state.fetching = true;
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 5000);
    try {
      var response = await fetch(state.origin + '/api/tracking-config', {method: 'POST', body: JSON.stringify({siteKey: state.siteKey, environment: state.environment}), headers: {'Content-Type': 'application/json'},
        credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error', signal: controller.signal});
      if (!response.ok || Number(response.headers.get('content-length')) > 65536) throw new Error('Configuration unavailable.');
      var text = await response.text(); if (text.length > 65536) throw new Error('Configuration too large.');
      /** @type {unknown} */
      var value = JSON.parse(text); if (!validatePublic(value, state)) throw new Error('Invalid configuration.');
      var first = !state.config, changed = state.config && (/** @type {Ten98Tracker.PublicConfig} */ (state.config).revisionId !== value.revisionId || /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch !== value.consentEpoch);
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
        /** @type {unknown} */
        var record; var parsed, stored;
        try { stored = localStorage.getItem(state.storageKey); record = stored === null ? null : JSON.parse(stored); state.preferenceReadable = stored === null || !!(parsed = preference(record)); } catch (_) { state.preferenceReadable = false; }
        if (parsed) state.basicOptOut = parsed.basicOptOut;
        if (parsed && parsed.record.epoch === value.consentEpoch && parsed.record.updatedAt < started && parsed.record.expiresAt > Date.now() && saveRecord(state, parsed.record)) {
          state.consent = parsed.record.choice; state.consentExpires = parsed.record.expiresAt;
          if (state.preferenceButton) state.preferenceButton.textContent = 'Tracking preferences';
        } else if (parsed && parsed.record.epoch === value.consentEpoch && parsed.record.updatedAt < started && parsed.record.expiresAt > Date.now() && granted(parsed.record.choice)) state.preferenceReadable = false;
      }
      if ((first || changed) && (nativeAllowed(state) || granted(state.consent)) && !(state.nativePageObservation && state.nativePageObservation.sent && state.nativePageObservation.url === location.origin + location.pathname)) dispatch(state, {name: 'page_view', eventId: crypto.randomUUID(), url: location.origin + location.pathname});
      if (!state.reload && hub.replayStart?.protocolVersion === 3) hub.replayStart(state);
      if (!state.reload && hub.heatmapStart?.protocolVersion === 3) hub.heatmapStart(state);
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
      /** @type {Ten98Tracker.State} */
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
    if (value) { current.analytics = false; if (current.replay !== undefined) current.replay = false; }
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
      /** @type {unknown} */ var record; var parsed; try { record = JSON.parse(event.newValue || 'null'); parsed = preference(record); } catch (_) {}
      var next = denied(), before = nativeBasis(state);
      state.preferenceReadable = !!parsed;
      if (parsed && parsed.basicOptOut) state.basicOptOut = true;
      if (parsed && state.config && parsed.record.epoch === /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch && parsed.record.expiresAt > Date.now()) {
        const stored = parsed.record;
        purposes.forEach(function (key) { next[key] = state.consent[key] && stored.choice[key]; });
        if (state.consent.replay !== undefined) next.replay = state.consent.replay === true && stored.choice.replay === true;
      }
      var changed = (/** @type {Ten98Tracker.ConsentKey[]} */ (purposes)).concat('replay').some(function (key) { return !!next[key] !== !!state.consent[key]; }); state.consent = next;
      if (changed || before !== nativeBasis(state) || !parsed) stop(state, 'Tracking preference changed in another tab. Reload required for loaded SDKs.', true);
    });
  });
  hub.api.consentPreferences = function (options) {
    const selected = findSite(options); if (!selected || !selected.config || selected.reload) return false;
    const state = selected;
    if (state.dialog) { state.dialog.focus(); return true; }
    installPreferenceStyle(state);
    var prior = /** @type {HTMLElement|null} */ (document.activeElement), dialog = document.createElement('dialog'), openingEpoch = /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch;
    state.dialog = dialog;
    dialog.setAttribute('aria-label', 'Tracking preferences');
    dialog.className = 'ten98-tracking-dialog';
    var title = document.createElement('h2'); title.textContent = 'Tracking preferences'; dialog.appendChild(title);
    var cookieless = /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.collectionMode === 'cookieless';
    var nativeNotice = document.createElement('p'); nativeNotice.textContent = cookieless ? 'Basic analytics counts page paths and events without cookies or an analytics grant. Opting out or a browser privacy signal stops these observations. Enhanced analytics may send an identifier and profile details after you agree, and may also record ad click identifiers from the page address. Basic permission does not enable advertising or identification.' : 'Analytics records page paths and events after you agree, and may also record ad click identifiers from the page address. This website may also send an identifier and profile details to its native analytics collector. Earlier activity is discarded.'; dialog.appendChild(nativeNotice);
    var geographyNotice = document.createElement('p'); geographyNotice.textContent = 'When enabled by this site, approximate country, region and city may be derived locally from the connection address. The raw address and coordinates are not stored. This follows the analytics choice above; opting out, Do Not Track or Global Privacy Control stops new observations.'; dialog.appendChild(geographyNotice);
    if(/** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.linkIdentities===true){var linkNotice=document.createElement('p');linkNotice.textContent='This website also links future activity with matching identifiers across devices and months within its own analytics project. The raw identifier is not stored. Earlier anonymous activity stays separate. Withdrawing consent stops new collection; previously accepted links remain subject to retention.';dialog.appendChild(linkNotice);}
    /** @type {Ten98Tracker.ConsentKey[]} */
    var dialogPurposes = purposes.slice();
    if(/** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.heatmap?.enabled===true){var heatmapNotice=document.createElement('p');heatmapNotice.textContent='Analytics also collects numeric click positions and page scroll depths for sampled heatmaps after you agree. It does not record page contents, form values or element labels and works independently of Session replay. Opting out or a browser privacy signal stops new samples.';dialog.appendChild(heatmapNotice);}
    if(/** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.replay){dialogPurposes.push('replay');var replayNotice=document.createElement('p');replayNotice.textContent='Session replay is a separate choice: it records a masked page and interactions only after you agree to both Analytics and Session replay. It does not grant advertising permission. A short-lived recording capability is kept in this tab for navigation; raw page data is not stored in browser storage. Withdrawal stops new recording; already shared data remains subject to retention.';dialog.appendChild(replayNotice);}
    var warning = document.createElement('p'); warning.textContent = 'Changing consent after a vendor tag loads reloads this page and may lose unsaved work. If consent storage fails, this page closes to stop loaded SDKs; clear site data before returning. Vendor SDKs may read the full URL, referrer and automatic events. Already shared or in-flight data cannot be withdrawn here.'; dialog.appendChild(warning);
    var vendors = document.createElement('p'), vendorNames = state.routes.filter(function (r) { return r.destination.enabled; }).map(function (r) { return r.destination.provider; }); vendors.textContent = vendorNames.length ? 'Configured vendors: ' + vendorNames.join(', ') : 'No additional vendor tags are configured.'; dialog.appendChild(vendors);
    var controls = /** @type {Record<Ten98Tracker.ConsentKey,HTMLInputElement>} */ ({}), feedback = document.createElement('p');
    /** @type {HTMLInputElement|undefined} */
    var basic; feedback.setAttribute('role', 'status');
    if (cookieless) {
      var basicLabel = document.createElement('label'); basic = document.createElement('input'); basic.type = 'checkbox'; basic.checked = !privacy() && state.preferenceReadable && !state.basicOptOut; basic.disabled = privacy(); basicLabel.appendChild(basic); basicLabel.appendChild(document.createTextNode(' Allow cookieless basic analytics')); dialog.appendChild(basicLabel);
      var basicStatus = document.createElement('p'); basicStatus.textContent = nativeBasis(state) === 'cookieless' ? 'Basic analytics is currently enabled. Enhanced analytics is a separate choice.' : 'Basic observations require an available configuration and no opt-out or browser privacy signal.'; dialog.appendChild(basicStatus);
    }
    dialogPurposes.forEach(function (purpose) { var label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = privacy() ? false : state.consent[purpose] === true; input.disabled = privacy() || purpose === 'replay' && !(/** @type {NonNullable<Ten98Tracker.NativeSettings['replay']>} */ ((/** @type {Ten98Tracker.PublicConfig} */ (state.config)).nativeTracking.replay)).enabled; controls[purpose] = input; label.appendChild(input); label.appendChild(document.createTextNode(' ' + ({analytics: cookieless ? 'Enhanced analytics' : 'Analytics', advertising: 'Advertising', adUserData: 'Ad user data', adPersonalization: 'Ad personalization', replay:'Session replay (also requires Analytics)'})[purpose])); dialog.appendChild(label); });
    if (privacy()) { var veto = document.createElement('p'); veto.textContent = 'Your browser privacy signal requires denial.'; dialog.appendChild(veto); }
    function close() { dialog.close(); dialog.remove(); state.dialog = null; state.closeDialog = null; prior?.focus(); }
    state.closeDialog = close;
    /** @param {string} label @param {()=>void} action */
    function button(label, action) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); dialog.appendChild(b); }
    /** @param {Ten98Tracker.Consent} value @param {boolean} [optOut] */
    function submit(value, optOut) {
      if (state.dialog !== dialog || /** @type {Ten98Tracker.PublicConfig} */ (state.config).consentEpoch !== openingEpoch) return;
      var result = applyChoice(state, value, true, optOut); if (result.ok && !result.reloadRequired) close(); else feedback.textContent = result.reason || 'Reload required to apply this choice to loaded SDKs.';
    }
    button('Save choices', function () { var value = /** @type {Ten98Tracker.Consent} */ ({}); dialogPurposes.forEach(function (p) { value[p] = controls[p].checked; }); if (basic && !basic.checked) {value.analytics = false;if(controls.replay)value.replay=false;} submit(value, basic ? !basic.checked : undefined); });
    button('Deny all', function () { submit(denied(), true); }); button('Cancel', close); dialog.appendChild(feedback);
    dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dialog); if (typeof dialog.showModal !== 'function') { dialog.remove(); state.dialog = null; state.closeDialog = null; return false; } dialog.showModal(); controls.analytics.focus(); return true;
  };
  /** @param {Ten98Tracker.State} state */
  function installPreferenceStyle(state) {
    if (state.preferenceStyle) return;
    var stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.referrerPolicy = 'no-referrer'; stylesheet.href = state.origin + '/tracking-consent.css?v=3'; (document.head || document.documentElement).appendChild(stylesheet); state.preferenceStyle = stylesheet;
  }
  /** @param {Ten98Tracker.State} state */
  function installPreferences(state) {
    function mount() {
      if (!document.body || state.preferenceButton || /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.consentMode !== 'builtin') return;
      installPreferenceStyle(state);
      var button = document.createElement('button'); button.type = 'button'; button.textContent = /** @type {Ten98Tracker.PublicConfig} */ (state.config).nativeTracking.collectionMode === 'cookieless' ? 'Tracking preferences' : 'Choose tracking preferences';
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
  var vendorInstances = /** @type {Partial<Record<string,Promise<Ten98Tracker.VendorAdapter>>>} */ (Object.create(null)), googleSdk = /** @type {Ten98Tracker.GoogleSdk|undefined} */ (undefined);
  var vendorUrls = {meta: 'https://connect.facebook.net/en_US/fbevents.js', cloudflare: 'https://static.cloudflareinsights.com/beacon.min.js',
    tiktok: 'https://analytics.tiktok.com/i18n/pixel/events.js', linkedin: 'https://snap.licdn.com/li.lms-analytics/insight.min.js',
    microsoft_ads: 'https://bat.bing.com/bat.js', pinterest: 'https://s.pinimg.com/ct/core.js', snapchat: 'https://sc-static.net/scevent.min.js', x: 'https://static.ads-twitter.com/uwt.js'};
  /** @param {string[]} hosts */
  function foreignScript(hosts) {
    return Array.from(document.querySelectorAll('script[src]')).some(function (script) { try { return hosts.includes(new URL((/** @type {HTMLScriptElement} */ (script)).src).hostname); } catch (_) { return false; } });
  }
  /** @param {Ten98Tracker.VendorContext} context */
  function requireAllowed(context) { if (!context.allowed()) throw new Error('Consent unavailable.'); }
  /** @param {Ten98Tracker.Consent} value */
  function googleChoice(value) { return {analytics_storage: value.analytics ? 'granted' : 'denied', ad_storage: value.advertising ? 'granted' : 'denied', ad_user_data: value.adUserData ? 'granted' : 'denied', ad_personalization: value.adPersonalization ? 'granted' : 'denied'}; }
  /** @param {Ten98Tracker.Event} event @param {Record<string,string>} mapping @returns {Ten98Tracker.Values} */
  function propertyFields(event, mapping) { var output = /** @type {Ten98Tracker.Values} */ ({}), p = event.properties || {}; Object.keys(mapping).forEach(function (key) { if (p[/** @type {keyof Ten98Tracker.EventProperties} */ (key)] !== undefined) output[mapping[key]] = key === 'value' ? Number(p[/** @type {keyof Ten98Tracker.EventProperties} */ (key)]) : p[/** @type {keyof Ten98Tracker.EventProperties} */ (key)]; }); return output; }
  /** @param {Ten98Tracker.Destination} destination @param {Ten98Tracker.VendorContext} context @returns {Promise<Ten98Tracker.VendorAdapter>} */
  async function createVendorAdapter(destination, context) {
    requireAllowed(context);
    var sdk = /** @type {Ten98Tracker.VendorGlobals} */ (/** @type {unknown} */ (window));
    var provider = destination.provider, asset = destination.assetId, instanceKey = provider + ':' + asset;
    const existing = vendorInstances[instanceKey];
    if (existing) return existing;
    // Ownership is claimed by the coordinator before calling this factory.
    var promise = (async function () {
      /** @type {Ten98Tracker.VendorAdapter["invoke"]} */ var invoke; var stop = function () {}, pageviewsOwned = false;
      if (provider === 'ga4' || provider === 'google_ads') {
        if (!googleSdk) {
          if (window.gtag || window.google_tag_manager || window.ten98DataLayer || foreignScript(['www.googletagmanager.com', 'www.google-analytics.com'])) throw new Error('External Google owner.');
          var layer = /** @type {IArguments[]} */ ([]); window.ten98DataLayer = layer;
          /** @type {(...args:unknown[])=>void} */ var gtag = function () { layer.push(arguments); };
          gtag('consent', 'default', googleChoice(denied()));
          gtag('set', 'ads_data_redaction', true); gtag('set', 'url_passthrough', false);
          gtag('consent', 'update', googleChoice(context.consent())); gtag('js', new Date());
          googleSdk = {layer: layer, call: gtag, ids: new Set(), loading: context.loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(asset) + '&l=ten98DataLayer')};
        }
        await (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).loading; requireAllowed(context);
        (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).call('consent', 'update', googleChoice(context.consent()));
        if (!(/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).ids.has(asset)) {
          (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).call('config', asset, {send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: context.consent().adPersonalization, page_location: context.pageUrl(), page_referrer: ''});
          (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).ids.add(asset);
        }
        invoke = function (event, target) {
          var values = propertyFields(event, {value: 'value', currency: 'currency', transactionId: 'transaction_id'});
          values.send_to = provider === 'ga4' ? asset : asset + '/' + target;
          if (provider === 'ga4') { values.page_location = event.url; values.page_referrer = ''; if (event.properties.itemId !== undefined) values.items = [{item_id: event.properties.itemId}]; }
          (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).call('event', provider === 'ga4' ? target : 'conversion', values);
        };
        stop = function () { if (provider === 'ga4') window['ga-disable-' + asset] = true; (/** @type {Ten98Tracker.GoogleSdk} */ (googleSdk)).layer.length = 0; };
      } else {
        var globalNames = {meta: ['fbq', '_fbq'], tiktok: ['ttq', 'TiktokAnalyticsObject'], linkedin: ['lintrk', '_linkedin_data_partner_ids', '_linkedin_partner_id'], microsoft_ads: ['uetq', 'UET'], pinterest: ['pintrk'], snapchat: ['snaptr'], x: ['twq'], cloudflare: ['__cfBeacon']};
        var sdkUrl = vendorUrls[provider];
        if (!sdkUrl || globalNames[provider].some(function (name) { return window[name] !== undefined; }) || foreignScript([new URL(sdkUrl).hostname])) throw new Error('External SDK owner.');
        if (provider === 'meta') {
          /** @type {Ten98Tracker.VendorQueue} */ var metaQueue = /** @type {Ten98Tracker.VendorQueue} */ (function () { metaQueue.callMethod ? metaQueue.callMethod.apply(metaQueue, arguments) : metaQueue.queue.push(arguments); });
          metaQueue.queue = []; metaQueue.push = metaQueue; metaQueue.loaded = true; metaQueue.version = '2.0'; window.fbq = window._fbq = metaQueue;
          await context.loadScript(sdkUrl); requireAllowed(context);
          sdk.fbq('set', 'autoConfig', false, asset); sdk.fbq('init', asset); sdk.fbq('consent', 'grant');
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency'}); if (event.properties.itemId !== undefined) { values.content_ids = [event.properties.itemId]; values.content_type = 'product'; } sdk.fbq('trackSingle', asset, target, values, {eventID: event.eventId}); };
          stop = function () { sdk.fbq('consent', 'revoke'); };
        } else if (provider === 'cloudflare') {
          await context.loadScript(sdkUrl, {'type': 'module', 'data-cf-beacon': JSON.stringify({token: asset, spa: true})}); requireAllowed(context);
          pageviewsOwned = true; invoke = function () {};
        } else if (provider === 'tiktok') {
          /** @type {(keyof Pick<Ten98Tracker.TikTokQueue,"page"|"track"|"identify"|"instances"|"debug"|"on"|"off"|"once"|"ready"|"alias"|"group"|"enableCookie"|"disableCookie"|"holdConsent"|"revokeConsent"|"grantConsent">)[]} */
          var methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
          /** @returns {Ten98Tracker.TikTokQueue} */
          function tiktokQueue() { var q = /** @type {Ten98Tracker.TikTokQueue} */ (/** @type {unknown} */ ([])); methods.forEach(function (method) { q[method] = function () { q.push([method].concat(Array.from(arguments))); }; }); return q; }
          var tiktokState = tiktokQueue(); tiktokState._i = {}; tiktokState._i[asset] = tiktokQueue(); tiktokState._i[asset]._u = sdkUrl; tiktokState._t = {}; tiktokState._t[asset] = Date.now(); tiktokState._o = {}; tiktokState._o[asset] = {}; tiktokState.instance = function (/** @type {string} */ id) { return tiktokState._i[id]; };
          window.TiktokAnalyticsObject = 'ttq'; window.ttq = tiktokState;
          await context.loadScript(sdkUrl + '?sdkid=' + encodeURIComponent(asset) + '&lib=ttq'); requireAllowed(context); sdk.ttq.grantConsent();
          invoke = function (event, target) { if (event.name === 'page_view') { sdk.ttq.page(); return; } var values = propertyFields(event, {value: 'value', currency: 'currency'}); if (event.properties.itemId !== undefined) values.content_ids = [event.properties.itemId]; sdk.ttq.track(target, values, {event_id: event.eventId}); };
          stop = function () { sdk.ttq.revokeConsent(); };
        } else if (provider === 'linkedin') {
          /** @type {Ten98Tracker.VendorCall & {q:unknown[][]}} */ var linkedinQueue = /** @type {Ten98Tracker.VendorCall & {q:unknown[][]}} */ (function (/** @type {unknown} */ a, /** @type {unknown} */ b) { linkedinQueue.q.push([a, b]); }); linkedinQueue.q = []; window.lintrk = linkedinQueue; window._linkedin_data_partner_ids = [asset];
          await context.loadScript(sdkUrl); requireAllowed(context);
          invoke = function (event, target) { sdk.lintrk('track', {conversion_id: Number(target), event_id: event.eventId}); };
        } else if (provider === 'microsoft_ads') {
          window.uetq = []; sdk.uetq.push('consent', 'default', {ad_storage: 'denied'}); sdk.uetq.push('consent', 'update', {ad_storage: 'granted'});
          await context.loadScript(sdkUrl); requireAllowed(context);
          if (typeof window.UET !== 'function') throw new Error('UET unavailable.');
          window.uetq = new sdk.UET({ti: asset, q: window.uetq, enableAutoSpaTracking: false, disableAutoPageView: true, enableAutoConsent: false});
          invoke = function (event, target) { if (event.name === 'page_view') sdk.uetq.push('event', 'page_view', {page_path: new URL(event.url).pathname}); else { var values = propertyFields(event, {value: 'revenue_value', currency: 'currency'}); values.event_category = 'ten98'; sdk.uetq.push('event', target, values); } };
        } else if (provider === 'pinterest') {
          /** @type {Ten98Tracker.VendorQueue} */ var pinterestQueue = /** @type {Ten98Tracker.VendorQueue} */ (function () { pinterestQueue.queue.push(Array.from(arguments)); }); pinterestQueue.queue = []; pinterestQueue.version = '3.0'; window.pintrk = pinterestQueue;
          await context.loadScript(sdkUrl); requireAllowed(context); sdk.pintrk('load', asset); sdk.pintrk('page');
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency', transactionId: 'order_id'}); values.event_id = event.eventId; if (event.properties.itemId !== undefined) values.line_items = [{product_id: event.properties.itemId}]; sdk.pintrk('track', target, values); };
        } else if (provider === 'snapchat') {
          /** @type {Ten98Tracker.VendorQueue} */ var snapchatQueue = /** @type {Ten98Tracker.VendorQueue} */ (function () { snapchatQueue.handleRequest ? snapchatQueue.handleRequest.apply(snapchatQueue, arguments) : snapchatQueue.queue.push(arguments); }); snapchatQueue.queue = []; window.snaptr = snapchatQueue;
          await context.loadScript(sdkUrl); requireAllowed(context); sdk.snaptr('init', asset, {});
          invoke = function (event, target) { var values = propertyFields(event, {currency: 'currency', transactionId: 'transaction_id'}); values.client_dedup_id = event.eventId; if (event.properties.value !== undefined) values.price = event.properties.value; if (event.properties.itemId !== undefined) values.item_ids = [event.properties.itemId]; sdk.snaptr('track', target, values); };
        } else if (provider === 'x') {
          /** @type {Ten98Tracker.VendorQueue} */ var xQueue = /** @type {Ten98Tracker.VendorQueue} */ (function () { xQueue.exe ? xQueue.exe.apply(xQueue, arguments) : xQueue.queue.push(arguments); }); xQueue.queue = []; xQueue.version = '1.1'; window.twq = xQueue;
          await context.loadScript(sdkUrl); requireAllowed(context); sdk.twq('set', {hide_page_location: true}); sdk.twq('config', asset);
          invoke = function (event, target) { var values = propertyFields(event, {value: 'value', currency: 'currency'}); values.conversion_id = event.eventId; if (event.properties.itemId !== undefined) values.contents = [{content_id: event.properties.itemId}]; sdk.twq('event', target, values); };
        }
      }
      return {invoke: function (/** @type {Ten98Tracker.Event} */ event, /** @type {string} */ target) { requireAllowed(context); invoke(event, target); }, stop: stop, pageviewsOwned: pageviewsOwned};
    })();
    vendorInstances[instanceKey] = promise;
    return promise;
  }
  (hub.sites || []).forEach(hub.destinationInit);
})();
