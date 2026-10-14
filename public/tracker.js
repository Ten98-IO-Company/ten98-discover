// ten98 foundation monitor: initial page_view, SPA navigations, bfcache restores, custom events.
// Dependency-free IIFE. Instrumentation must never break the host page.
(function () {
  'use strict';

  var NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
  var PAGE_VIEW = 'page_view';

  function uuid() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function hub() {
    return window.__ten98FoundationHub || null;
  }

  function currentUrl() {
    return location.origin + location.pathname; // page URLs never carry query strings or fragments
  }

  function send(site, name, properties) {
    try {
      var event = { name: name, eventId: uuid(), url: currentUrl() };
      var h = hub();
      if (h && typeof h.destinationEvent === 'function') h.destinationEvent(site, { name: name, eventId: event.eventId, url: event.url, properties: properties });
    } catch (ignore) {
      // Missing crypto/fetch or any other instrumentation failure stays invisible to the host.
    }
  }

  function nativeReady(state) {
    var h = hub(), settings = state.config && state.config.nativeTracking;
    return !!(h && h.nativeAllowed && h.nativeAllowed(state) && settings && settings.enabled && state.environment === 'live' &&
      !settings.excludedPaths.some(function (path) { return decodeURIComponent(location.pathname).startsWith(decodeURIComponent(path)); }));
  }
  function nativeCurrent(state, epoch, generation, controller) {
    return !controller.signal.aborted && state.nativeGeneration === generation && state.config && state.config.consentEpoch === epoch && nativeReady(state);
  }
  async function readNativeResponse(response, signal) {
    var reader = response.body.getReader(), bytes = 0, text = '';
    function cancel() { reader.cancel().catch(function () {}); }
    signal.addEventListener('abort', cancel, {once: true});
    try {
      var decoder = new TextDecoder('utf-8', {fatal: true});
      while (true) {
        if (signal.aborted) throw new Error('Native request cancelled.');
        var part = await reader.read();
        if (signal.aborted) throw new Error('Native request cancelled.');
        if (part.done) return text + decoder.decode();
        bytes += part.value.byteLength;
        if (bytes > 2048) throw new Error('Native response too large.');
        text += decoder.decode(part.value, {stream: true});
      }
    } catch (error) { cancel(); throw error; }
    finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  }

  // Called only by the consent coordinator. No activity is queued before consent.
  function nativeEvent(state, event) {
    try {
      var config = state.config, settings = config.nativeTracking;
      if (!nativeReady(state) || state.nativeRequests.size >= 20 || typeof TextDecoder !== 'function' || typeof ReadableStream !== 'function') return;
      var dimensions = {}, epoch = config.consentEpoch, generation = state.nativeGeneration;
      if (state.nativeIdentifier !== undefined) dimensions.distinctId = state.nativeIdentifier;
      if (navigator.language) dimensions.language = navigator.language;
      if (settings.captureReferrer && document.referrer) dimensions.referrer = new URL(document.referrer).origin;
      if (settings.captureScreen && window.screen) dimensions.screen = {width: screen.width, height: screen.height};
      if (settings.captureCampaigns) {
        var query = new URL(location.href).searchParams, campaign = {};
        ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (key) { var value = query.get('utm_' + key); if (value) campaign[key] = value; });
        if (Object.keys(campaign).length) dimensions.campaign = campaign;
      }
      var body = JSON.stringify({siteKey: state.siteKey, name: event.name, eventId: event.eventId, url: event.url, properties: event.properties,
        dimensions: dimensions, context: state.nativeContext || undefined, consent: {analytics: true, epoch: epoch}});
      if (new TextEncoder().encode(body).length > 16384) return;
      var controller = new AbortController(); state.nativeRequests.add(controller);
      var timer = setTimeout(function () { controller.abort(); }, 5000);
      Promise.resolve().then(function () { if (!nativeCurrent(state, epoch, generation, controller)) return; return fetch(state.origin + '/api/collect', {method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors',
        cache: 'no-store', redirect: 'error', signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: body}); })
        .then(async function (response) {
          if (!response) return;
          var text = await readNativeResponse(response, controller.signal);
          if (!response.ok) { warn('ten98-monitor: event was not accepted. Check installation diagnostics.'); return; }
          var result = JSON.parse(text);
          if (nativeCurrent(state, epoch, generation, controller) && result.accepted && typeof result.context === 'string' && result.context.length <= 1024) state.nativeContext = result.context;
        }).catch(function () { if (!controller.signal.aborted) warn('ten98-monitor: collector unavailable or blocked.'); })
        .finally(function () { clearTimeout(timer); state.nativeRequests.delete(controller); });
    } catch (ignore) {} // Invalid application properties must never break the host page.
  }

  function nativeStop(state) {
    state.nativeContext = null; state.nativeIdentifier = undefined; state.nativeGeneration = (state.nativeGeneration || 0) + 1;
    state.nativeRequests.forEach(function (request) { request.abort(); }); state.nativeRequests.clear();
  }

  function clean(value) { return !/\u0000|[\uD800-\uDFFF]/u.test(value); }
  function identifySnapshot(identifier, raw) {
    var leaves = 0, stack = new Set();
    function bad() { throw new Error('Invalid identify input.'); }
    function validId(value) { if (typeof value !== 'string' || !value.length || value.length > 256 || !clean(value) || /[\x00-\x1f\x7f]/.test(value)) bad(); return value; }
    function scalar(value) {
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) return value;
      if (typeof value === 'string' && value.length <= 1000 && clean(value)) return value;
      return bad();
    }
    function object(value) { return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
    function copy(value, path, depth) {
      if (!object(value) || stack.has(value)) bad();
      stack.add(value); var out = Object.create(null);
      Reflect.ownKeys(value).forEach(function (key) {
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) bad();
        var item = descriptor.value;
        if (depth === 1 && key === 'id') { var shortcut = validId(item); if (identifier !== undefined && identifier !== shortcut) bad(); identifier = shortcut; return; }
        if (!key.length || key.length > 80 || ['__proto__', 'prototype', 'constructor'].includes(key) || !clean(key)) bad();
        var next = (path ? path + '.' : '') + key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
        if (next.length > 320) bad();
        if (object(item)) { if (depth >= 4) bad(); out[key] = copy(item, next, depth + 1); }
        else {
          if (++leaves > 50) bad();
          if (Array.isArray(item)) {
            if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 50) bad();
            Reflect.ownKeys(item).forEach(function (index) {
              if (index === 'length') return;
              var d = Object.getOwnPropertyDescriptor(item, index);
              if (typeof index !== 'string' || !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= item.length || !d.enumerable || !('value' in d)) bad();
            });
            var array = [];
            for (var i = 0; i < item.length; i++) { var d = Object.getOwnPropertyDescriptor(item, String(i)); if (!d || !('value' in d)) bad(); array.push(scalar(d.value)); }
            if (new TextEncoder().encode(JSON.stringify(array)).length > 4096) bad(); out[key] = array;
          } else out[key] = scalar(item);
        }
      });
      stack.delete(value); return out;
    }
    if (identifier !== undefined) validId(identifier);
    var properties = copy(raw, '', 1);
    if (new TextEncoder().encode(JSON.stringify(properties)).length > 6144) bad();
    return {identifier: identifier, properties: properties};
  }

  async function nativeIdentify(state, identifier, properties) {
    var requestId, sentAt, controller, timer, sent = false;
    function outcome(status, reason) { return Object.assign({status: status}, requestId ? {requestId: requestId, sentAt: sentAt} : {}, reason ? {reason: reason} : {}); }
    try {
      if (!nativeReady(state)) return outcome('not_sent', 'collection_unavailable');
      if (state.nativeRequests.size >= 20) return outcome('not_sent', 'busy');
      if (typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function' || typeof ReadableStream !== 'function' || typeof AbortController !== 'function' || typeof fetch !== 'function' || typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return outcome('not_sent', 'browser_unavailable');
      var snapshot;
      try { snapshot = identifySnapshot(identifier, properties); } catch (_) { return outcome('invalid', 'invalid_input'); }
      var changed = snapshot.identifier !== undefined && snapshot.identifier !== state.nativeIdentifier;
      var nextId = snapshot.identifier === undefined ? state.nativeIdentifier : snapshot.identifier, epoch = state.config.consentEpoch;
      requestId = uuid(); sentAt = new Date().toISOString(); controller = new AbortController();
      var body = JSON.stringify({type: 'identify', siteKey: state.siteKey, requestId: requestId, sentAt: sentAt, url: currentUrl(), properties: snapshot.properties,
        dimensions: nextId === undefined ? undefined : {distinctId: nextId}, context: changed ? undefined : state.nativeContext || undefined, consent: {analytics: true, epoch: epoch}});
      if (new TextEncoder().encode(body).length > 16384) return outcome('invalid', 'invalid_input');
      if (!nativeReady(state)) return outcome('not_sent', 'collection_unavailable');
      if (changed) { nativeStop(state); state.nativeIdentifier = nextId; }
      var generation = state.nativeGeneration;
      state.nativeRequests.add(controller);
      var aborted = new Promise(function (resolve) { controller.signal.addEventListener('abort', function () { resolve(outcome(sent ? 'unknown' : 'not_sent', sent ? undefined : 'cancelled')); }, {once: true}); });
      timer = setTimeout(function () { controller.abort(); }, 5000);
      var work = Promise.resolve().then(async function () {
        if (!nativeCurrent(state, epoch, generation, controller)) return outcome('not_sent', 'cancelled');
        sent = true;
        var response = await fetch(state.origin + '/api/collect', {method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: body});
        var text = await readNativeResponse(response, controller.signal);
        if (!nativeCurrent(state, epoch, generation, controller)) return outcome('unknown');
        var result = JSON.parse(text);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return outcome('unknown');
        if ([400, 409].includes(response.status) && typeof result.error === 'string' && Object.keys(result).every(function (key) { return ['error', 'reason'].includes(key); })) {
          if (response.status === 400 && result.reason === 'request_expired') return outcome('expired', 'request_expired');
          return outcome('invalid', response.status === 409 ? 'request_conflict' : 'invalid_input');
        }
        if (response.status !== 202) return outcome('unknown');
        if (result.accepted === false && Object.keys(result).length === 2 && ['collection_disabled', 'consent_required', 'identity_unavailable'].includes(result.reason)) return outcome(result.reason === 'identity_unavailable' ? 'identity_unavailable' : 'rejected', result.reason);
        if (result.accepted !== true || typeof result.duplicate !== 'boolean' || Object.keys(result).some(function (key) { return !['accepted', 'duplicate', 'context'].includes(key); }) ||
          Object.prototype.hasOwnProperty.call(result, 'context') && (result.duplicate || typeof result.context !== 'string' || !result.context.length || result.context.length > 1024 || !clean(result.context))) return outcome('unknown');
        if (result.context !== undefined) state.nativeContext = result.context;
        return Object.assign(outcome('accepted'), {duplicate: result.duplicate});
      }).catch(function () { return outcome('unknown'); });
      return await Promise.race([work, aborted]);
    } catch (_) { return outcome(sent ? 'unknown' : 'not_sent', sent ? undefined : 'collection_unavailable'); }
    finally { if (timer) clearTimeout(timer); if (controller) state.nativeRequests.delete(controller); }
  }

  function identify(first, second, third) {
    try {
      var explicit = typeof first === 'string', h = hub();
      if (arguments.length !== (explicit ? 3 : 2)) return Promise.resolve({status: 'invalid', reason: 'invalid_input'});
      if (!h || !h.destinationIdentify) return Promise.resolve({status: 'not_sent', reason: 'configuration_unavailable'});
      return h.destinationIdentify(explicit ? first : undefined, explicit ? second : first, explicit ? third : second);
    } catch (_) { return Promise.resolve({status: 'invalid', reason: 'invalid_input'}); }
  }
  function resetIdentity(options) {
    try { var h = hub(); if (h && h.destinationResetIdentity) return h.destinationResetIdentity(options); } catch (_) {}
    return {ok: false, reason: 'Choose one configured site and environment.'};
  }

  function warn(message) {
    try { console.warn(message); } catch (ignore) {}
  }

  function fanout(name, properties) {
    var h = hub();
    if (!h) return;
    for (var i = 0; i < h.sites.length; i++) send(h.sites[i], name, properties);
  }

  // Sends a page_view only when origin+pathname actually changed (query/hash-only moves are ignored).
  function afterNav() {
    try {
      var h = hub();
      if (!h) return;
      var url = currentUrl();
      if (url === h.lastUrl) return;
      h.lastUrl = url;
      fanout(PAGE_VIEW);
    } catch (ignore) {}
  }

  function onPageshow(event) {
    try {
      var h = hub();
      if (!h || !event || !event.persisted || h.restored) return; // ordinary pageshow must not duplicate
      h.restored = true; // exactly one restored page_view per bfcache restoration; pagehide re-arms
      h.lastUrl = currentUrl();
      fanout(PAGE_VIEW);
    } catch (ignore) {}
  }

  function onPagehide() {
    try {
      var h = hub();
      if (h) h.restored = false;
    } catch (ignore) {}
  }

  function patchHistory(method) {
    try {
      var nativeMethod = history[method];
      if (typeof nativeMethod !== 'function') return;
      history[method] = function () {
        var result = nativeMethod.apply(this, arguments); // native this/args/return/exceptions untouched
        afterNav(); // origin/path collected only after the native call succeeded
        return result;
      };
    } catch (ignore) {} // A frozen host method must not disable initial/custom events.
  }

  function track(name, properties) {
    try {
      if (typeof name !== 'string' || name === PAGE_VIEW || name !== name.trim() || !NAME_RE.test(name)) return;
      fanout(name, properties);
    } catch (ignore) {}
  }

  function install() {
    var h = { sites: [], lastUrl: currentUrl(), restored: false, nativeEvent: nativeEvent, nativeStop: nativeStop, nativeIdentify: nativeIdentify, api: { track: track, identify: identify, resetIdentity: resetIdentity } };
    window.__ten98FoundationHub = h;
    patchHistory('pushState');
    patchHistory('replaceState');
    window.addEventListener('popstate', afterNav);
    window.addEventListener('pageshow', onPageshow);
    window.addEventListener('pagehide', onPagehide);
    if (!window.ten98) window.ten98 = h.api; // never overwrite a foreign global
    return h;
  }

  function loadDestinations(h, site) {
    try {
      if (typeof h.destinationInit === 'function') { h.destinationInit(site); return; }
      if (h.destinationLoaderRequested || window.ten98 !== h.api) return;
      h.destinationLoaderRequested = true;
      var loader = document.createElement('script');
      loader.src = new URL('/destinations.js', site.endpoint).href;
      loader.async = true;
      loader.referrerPolicy = 'no-referrer';
      loader.onerror = function () { warn('ten98-monitor: destination loader unavailable or blocked.'); };
      (document.head || document.documentElement).appendChild(loader);
    } catch (ignore) {} // A blocked coordinator leaves collection disabled.
  }

  try {
    var script = document.currentScript;
    if (!script) return;
    var siteKey = script.getAttribute('data-site-key');
    if (!siteKey) return;
    var environment = script.getAttribute('data-environment') || 'live';
    if (environment !== 'live' && environment !== 'test') return;
    var endpoint;
    try {
      endpoint = new URL('/api/collect', script.src).href;
    } catch (badUrl) {
      return; // invalid collector URL: skip this site quietly
    }
    var registry = window.__ten98FoundationSites || (window.__ten98FoundationSites = new Set());
    var key = endpoint + ':' + siteKey + ':' + environment;
    if (registry.has(key)) return; // repeated init must not double send/patch/listen
    var h = hub() || install();
    var site = { endpoint: endpoint, siteKey: siteKey, environment: environment };
    h.sites.push(site);
    registry.add(key);
    loadDestinations(h, site);
    send(site, PAGE_VIEW); // dropped until consent; a restored grant permits one fresh observation
  } catch (ignore) {}
})();
