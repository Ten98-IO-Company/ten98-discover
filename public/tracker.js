(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var siteKey = script.getAttribute('data-site-key');
  if (!siteKey) return;
  var endpoint = new URL('/api/collect', script.src).href;
  var registry = window.__ten98FoundationSites || (window.__ten98FoundationSites = new Set());
  var key = endpoint + ':' + siteKey;
  if (registry.has(key)) return;
  registry.add(key);
  var bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  var eventId = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  // This foundation records one page load only. SPA/custom-event parity is still planned.
  fetch(endpoint, {
    method: 'POST', credentials: 'omit', mode: 'cors', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteKey: siteKey, eventId: eventId, name: 'page_view', url: location.origin + location.pathname }),
  }).then(function (response) {
    if (!response.ok) console.warn('ten98-monitor: event was not accepted. Check installation diagnostics.');
  }).catch(function () { console.warn('ten98-monitor: collector unavailable or blocked.'); });
})();
