/* The Room: a small service worker so the phone treats it as an app.
   It only touches opening the page itself: always fresh from the network,
   with the last good copy kept for when there is no signal.
   It never touches the conversation, the pictures or the server calls. */
var CACHE = "room-shell-v1";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var r = e.request;
  if (r.method !== "GET" || r.mode !== "navigate") return;
  e.respondWith(
    fetch(r).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(r, copy); });
      return res;
    }).catch(function () {
      return caches.match(r).then(function (m) {
        return m || new Response("The Room needs a connection.", { status: 503, headers: { "Content-Type": "text/plain" } });
      });
    })
  );
});
