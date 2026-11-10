/*
 * Finn service worker: exists for installability and a friendly offline page.
 * It caches nothing: API routes, voice sessions and model files always go to
 * the network (a stale orchestrator reply or token check would be worse than
 * an error while driving).
 */

const OFFLINE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Finn</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0a0f1a;color:#f2f5fb;font:600 1.6rem system-ui,-apple-system,sans-serif;text-align:center;padding:1rem}</style>
</head><body><p>Sem internet.<br>O Finn volta quando a conexão voltar.</p></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only page navigations get the offline fallback; everything else (incl. /api/*) is untouched.
  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request).catch(
      () => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});
