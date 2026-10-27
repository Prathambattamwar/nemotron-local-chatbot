const SHELL_CACHE = 'nemotron-shell-v3';
const CHAT_CACHE_PREFIX = 'nemotron-chat-data-';
const SHELL = ['/', '/styles.css', '/app.js', '/db.js', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(
  // Only retire old application-shell caches. Never delete the user's conversation cache.
  keys.filter(key => key.startsWith('nemotron-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key))
)).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/__nemotron_local_data__/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === '/' || SHELL.includes(url.pathname))) caches.open(SHELL_CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(async () => (await caches.match(event.request)) || (url.pathname === '/' ? caches.match('/') : Promise.reject(new Error('Offline resource unavailable')))));
});
