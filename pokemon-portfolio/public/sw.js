'use strict';
// Service worker for the home-screen app. It deliberately caches nothing — every page, script and
// price comes straight from the server, so the app is never out of date after a site update.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
