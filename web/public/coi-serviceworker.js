//
// coi-serviceworker.js — enables SharedArrayBuffer on a static host.
//
// WebAssembly threads are built on SharedArrayBuffer, which browsers only hand
// out to a "cross-origin isolated" page. Isolation is requested through two
// response headers:
//
//     Cross-Origin-Opener-Policy:   same-origin
//     Cross-Origin-Embedder-Policy: require-corp
//
// GitHub Pages serves static files and offers no way to set them. A service
// worker gets around this: once installed it sits between the page and the
// network, so it can add the headers to responses on their way back. The first
// visit installs the worker and reloads once; from then on the page loads
// already isolated and the multithreaded build becomes available.
//
// If anything here fails the page still works — it just falls back to the
// single-threaded solver.
//

if (typeof self !== 'undefined' && self.document === undefined) {
  // ── Service worker side ────────────────────────────────────────────────────
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    event.respondWith(
      fetch(r)
        .then((response) => {
          if (response.status === 0) return response; // opaque, leave alone

          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          // Same-origin subresources must opt in explicitly once the page is
          // isolated, including the worker scripts the pthread pool loads.
          headers.set('Cross-Origin-Resource-Policy', 'same-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((e) => console.error('[coi]', e))
    );
  });

} else {
  // ── Page side ──────────────────────────────────────────────────────────────
  (() => {
    if (window.crossOriginIsolated) return;          // already isolated
    if (!window.isSecureContext) return;             // needs https (or localhost)
    if (!navigator.serviceWorker) return;            // unsupported browser

    navigator.serviceWorker
      .register(window.document.currentScript.src)
      .then((registration) => {
        // A fresh registration only takes effect on the next load.
        registration.addEventListener('updatefound', () => window.location.reload());
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      })
      .catch((err) => console.warn('[coi] registration failed:', err));
  })();
}
