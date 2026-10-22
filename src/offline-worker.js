/* Replaced after Angular's build, including every lazy route and local asset. */
const MANIFEST = /* ECHO_MANIFEST */ null;
const PREFIX = `pnj-shell:${self.registration.scope}:`;
const CACHE = `${PREFIX}${MANIFEST.version}`;
const SHELL = MANIFEST.files.map((file) => new URL(file, self.registration.scope).href);
const INDEX = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  // An incomplete shell must not replace the last fully installed version.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.href.startsWith(self.registration.scope)
  )
    return;
  // Catalogs and WAVs never enter this cache; explicit downloads use IndexedDB.
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const navigation =
    request.mode === 'navigate' &&
    ['', 'index.html', 'connection', 'conversation', 'settings', 'stories'].includes(path);
  if (!navigation && !SHELL.includes(url.href)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(async (cache) => (await cache.match(navigation ? INDEX : request)) ?? fetch(request)),
  );
});
