/* The Room: the service worker.
   1. Opening the page: always fresh from the network, the last good copy kept for no signal.
   2. When one of them reaches out: the push carries nothing. The phone wakes, asks the room
      what is new with this device's own token, and shows it. Tapping it opens the room.
   It never touches the conversation, the pictures or any other server call. */
var CACHE = "room-shell-v1";
var ICON = "/room-icon-192.png";
var BADGE = "/room-badge-96.png";
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

function generic() {
  return self.registration.showNotification("The Room", {
    body: "Someone left you a message.", icon: ICON, badge: BADGE, tag: "room", data: { url: "/room.html" }
  });
}
function showNew() {
  return caches.open("room-push")
    .then(function (c) { return c.match("/room-push-token"); })
    .then(function (r) { return r ? r.text() : ""; })
    .then(function (token) {
      if (!token) return { messages: [] };
      return fetch("/api/room", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "pushInbox", token: token })
      }).then(function (r) { return r.ok ? r.json() : { messages: [] }; });
    })
    .then(function (d) {
      var list = (d && d.messages) || [];
      if (!list.length) return generic();
      return Promise.all(list.map(function (m) {
        return self.registration.showNotification(m.title, {
          body: m.body, icon: ICON, badge: BADGE, tag: m.tag, renotify: true,
          timestamp: m.ts, data: { url: "/room.html" }
        });
      }));
    })
    .catch(function () { return generic(); });
}
self.addEventListener("push", function (e) { e.waitUntil(showNew()); });
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/room.html";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf("/room.html") !== -1 && "focus" in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
