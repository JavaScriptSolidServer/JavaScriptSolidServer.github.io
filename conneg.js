/*
 * conneg.js — client-side content negotiation for HTML-embedded RDF.
 *
 * Reads the inline data island (a <script type="application/ld+json"
 * id="dataisland" data-uri="…"> element placed before this script) and
 * serves it back in whatever RDF format the consumer asks for, so a
 * mashlib/rdflib client can render the page with no second HTTP request
 * — works from any static host (GitHub Pages, Dropbox, file://).
 *
 * Four pieces, all auto-applied when this file is loaded:
 *
 *   1. Origin rewrite — remap the data island's data-uri and embedded
 *      @id origins to the current page origin, so the same HTML renders
 *      identically from any host.
 *
 *   2. window.fetch interceptor — when something fetches the data
 *      island's URI:
 *        - Container URIs (trailing /): convert JSON-LD → turtle via
 *          rdflib's own $rdf.parse + $rdf.serialize, return turtle.
 *          (solid-panes' outline/manager.js hardcodes turtle parsing
 *          for containers; this feeds it what it expects.)
 *        - Everything else: return JSON-LD raw with
 *          Content-Type: application/ld+json. mashlib's JsonLdHandler
 *          dispatches natively.
 *
 *   3. Mashlib + jsonld-chunk loader — load mashlib from unpkg, then
 *      pre-load the jsonld parser chunk (841) from unpkg before
 *      runDataBrowser. mashlib's webpack publicPath is '/' which 404s
 *      from any non-root deploy (see github.com/SolidOS/mashlib#287).
 *      Pre-registering the chunk into self.webpackChunkMashlib makes
 *      webpack's runtime see it as already-resolved.
 *
 *   4. Defensive $rdf.fetcher patch — currently inert under mashlib 2.x
 *      (the fetcher instance isn't reachable from any exposed global),
 *      but if a future mashlib exposes a stable fetcher handle this
 *      activates and short-circuits the fetch shim entirely.
 *
 * Stable surfaces this file depends on:
 *   - window.fetch (Web platform)
 *   - $rdf.parse / $rdf.serialize / $rdf.graph (rdflib top-level API)
 *   - The DOM element with id="dataisland"
 * No mashlib internals, no rdflib internals, no solid-panes anything.
 */

(function () {
  if (typeof window === 'undefined' || !window.location) return;

  var MASHLIB_BASE = 'https://unpkg.com/mashlib@2.2.0/dist/';
  var MASHLIB_SCRIPT = MASHLIB_BASE + 'mashlib.min.js';
  var JSONLD_CHUNK_SCRIPT = MASHLIB_BASE + '841.mashlib.min.js';

  // ---- Step 1: origin rewrite ------------------------------------------
  var el = document.getElementById('dataisland');
  if (!el) return;
  var originalUri = el.getAttribute('data-uri');
  if (!originalUri) return;
  try {
    var origUrl = new URL(originalUri);
    var currentOrigin = window.location.origin;
    if (origUrl.origin !== currentOrigin) {
      el.setAttribute('data-uri',
        currentOrigin + origUrl.pathname + origUrl.search + origUrl.hash);
      el.textContent = el.textContent.split(origUrl.origin).join(currentOrigin);
    }
  } catch (e) { /* leave the island alone on malformed input */ }

  // ---- Step 2: window.fetch interceptor --------------------------------
  function convertJsonLdToTurtle(jsonStr, baseUri) {
    return new Promise(function (resolve, reject) {
      var $rdf = window.$rdf;
      if (!$rdf || typeof $rdf.parse !== 'function'
          || typeof $rdf.serialize !== 'function'
          || typeof $rdf.graph !== 'function') {
        reject(new Error('rdflib not available'));
        return;
      }
      try {
        var tempStore = $rdf.graph();
        $rdf.parse(jsonStr, tempStore, baseUri, 'application/ld+json',
          function (err) {
            if (err) { reject(err); return; }
            try {
              $rdf.serialize(null, tempStore, baseUri, 'text/turtle',
                function (sErr, ttl) {
                  if (sErr) { reject(sErr); return; }
                  resolve(ttl);
                });
            } catch (sx) { reject(sx); }
          });
      } catch (px) { reject(px); }
    });
  }

  function islandResponse(body, contentType) {
    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': contentType }
    });
  }

  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string')
          ? input
          : (input && input.url) || String(input);
        var island = document.getElementById('dataisland');
        var dataUri = island && island.getAttribute('data-uri');
        function norm(u) { return String(u).split('#')[0].replace(/\/$/, ''); }
        if (dataUri && norm(url) === norm(dataUri)) {
          var isContainer = /\/(?:[?#].*)?$/.test(String(url));
          if (isContainer) {
            return convertJsonLdToTurtle(island.textContent, dataUri)
              .then(function (ttl) {
                return islandResponse(ttl, 'text/turtle');
              })
              .catch(function () {
                return islandResponse(island.textContent,
                  'application/ld+json');
              });
          }
          return Promise.resolve(islandResponse(island.textContent,
            'application/ld+json'));
        }
      } catch (e) { /* fall through to network */ }
      return origFetch(input, init);
    };
  }

  // ---- Step 4 (defined here, runs in onload): defensive fetcher patch --
  var di = window.__dataIsland;
  if (di === null || di === undefined
      || (typeof di !== 'object' && typeof di !== 'function')) {
    di = window.__dataIsland = {};
  }
  if (typeof di.get !== 'function') {
    di.get = function (uri) {
      if (!uri) return null;
      try {
        var el = document.getElementById('dataisland');
        if (el && el.type === 'application/ld+json'
            && el.getAttribute('data-uri') === String(uri)) {
          return {
            contentType: 'application/ld+json',
            content: el.textContent
          };
        }
      } catch (e) { /* fall through to null */ }
      return null;
    };
  }

  function applyPatch(rdf) {
    if (!rdf || !rdf.fetcher || !rdf.fetcher.load) return;
    if (rdf.fetcher.__dataIslandPatched) return;
    rdf.fetcher.__dataIslandPatched = true;
    var f = rdf.fetcher;
    var orig = f.load.bind(f);
    f.load = function (uri, options) {
      var s = (uri && uri.uri) || (uri && uri.value) || String(uri);
      var d = window.__dataIsland.get(s);
      if (d) {
        return new Promise(function (resolve, reject) {
          rdf.parse(d.content, f.store, s, d.contentType, function (err) {
            if (err) { reject(err); return; }
            try {
              if (f.requested && typeof f.requested === 'object') {
                f.requested[s] = 'done';
              }
              var resp;
              if (typeof Response === 'function') {
                resp = new Response(d.content, {
                  status: 200,
                  statusText: 'OK',
                  headers: { 'content-type': d.contentType }
                });
                try {
                  Object.defineProperty(resp, 'url',
                    { value: s, configurable: true });
                } catch (urlErr) { /* leave url empty */ }
              } else {
                resp = {
                  ok: true,
                  status: 200,
                  statusText: 'OK',
                  url: s,
                  headers: {
                    get: function (name) {
                      if (typeof name !== 'string') return null;
                      if (name.toLowerCase() === 'content-type') {
                        return d.contentType;
                      }
                      return null;
                    }
                  }
                };
              }
              resolve(resp);
            } catch (callbackErr) {
              reject(callbackErr);
            }
          });
        }).catch(function () { return orig(uri, options); });
      }
      return orig(uri, options);
    };
  }

  function findRdf() {
    var rdfMod = (typeof window.$rdf !== 'undefined') ? window.$rdf : null;
    if (rdfMod && rdfMod.fetcher && typeof rdfMod.fetcher.load === 'function') {
      return rdfMod;
    }
    if (rdfMod && typeof rdfMod.parse === 'function'
        && window.SolidLogic
        && window.SolidLogic.solidLogicSingleton
        && window.SolidLogic.solidLogicSingleton.store
        && window.SolidLogic.solidLogicSingleton.store.fetcher
        && typeof window.SolidLogic.solidLogicSingleton.store.fetcher.load
          === 'function') {
      var store = window.SolidLogic.solidLogicSingleton.store;
      return { fetcher: store.fetcher, store: store, parse: rdfMod.parse };
    }
    return null;
  }

  function applyAll() {
    var rdf = findRdf();
    if (rdf) applyPatch(rdf);
  }

  // ---- Step 3: load mashlib + jsonld chunk, then runDataBrowser --------
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  loadScript(MASHLIB_SCRIPT)
    .then(function () { return loadScript(JSONLD_CHUNK_SCRIPT); })
    .then(function () {
      applyAll();
      if (window.panes && typeof window.panes.runDataBrowser === 'function') {
        window.panes.runDataBrowser();
      }
    })
    .catch(function () {
      document.body.innerHTML = '<p>Failed to load Mashlib from CDN</p>';
    });
})();
