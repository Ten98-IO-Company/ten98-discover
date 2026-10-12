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
    return location.origin + location.pathname; // never query, hash, cookies, storage or referrer
  }

  function send(site, name, properties) {
    try {
      var event = { name: name, eventId: uuid(), url: currentUrl() };
      try { if (site.environment !== 'test') fetch(site.endpoint, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, eventId: event.eventId, siteKey: site.siteKey, url: event.url })
      }).then(function (response) {
        if (!response.ok) warn('ten98-monitor: event was not accepted. Check installation diagnostics.');
      }).catch(function () {
        warn('ten98-monitor: collector unavailable or blocked.');
      }); } catch (ignore) {}
      var h = hub();
      if (h && typeof h.destinationEvent === 'function') h.destinationEvent(site, { name: name, eventId: event.eventId, url: event.url, properties: properties });
    } catch (ignore) {
      // Missing crypto/fetch or any other instrumentation failure stays invisible to the host.
    }
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
    var h = { sites: [], lastUrl: currentUrl(), restored: false, api: { track: track } };
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
    } catch (ignore) {} // Blocked optional tags never stop the host or native collection.
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
    send(site, PAGE_VIEW); // exactly one initial page_view per site registration
  } catch (ignore) {}
})();
