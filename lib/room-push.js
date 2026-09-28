"use strict";

/* ============================================================
   ROOM PUSH - they reach out to Adger's phone
   Web Push with no packages: a push with no body, signed with
   a VAPID key the server makes for itself and keeps in Redis.
   The phone wakes, asks the server what is new, and shows it.
   Nothing about a message is ever inside the push itself.
   ZERO BACKTICKS.
   ============================================================ */

var crypto = require("crypto");

var VAPID_KEY = "sim:push:vapid";
var SUBS_KEY = "sim:push:subs";
var TEST_KEY = "sim:push:test";
var SUBJECT = "mailto:room@soulforgedstudio.com";
var ROOM_TZ = process.env.ROOM_TZ || "Europe/Athens";

/* ---------- redis ---------- */

async function redis(command){
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if(!url || !token){ throw new Error("Redis env vars missing"); }
  var res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if(!res.ok){ throw new Error("Redis " + res.status); }
  var data = JSON.parse(await res.text());
  return data ? data.result : null;
}
async function getJson(key, dflt){
  var raw = await redis(["GET", key]);
  if(!raw){ return dflt; }
  try { return JSON.parse(raw); } catch(e){ return dflt; }
}
async function setJson(key, val){ await redis(["SET", key, JSON.stringify(val)]); }

/* ---------- base64url ---------- */

function b64u(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(s){ s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while(s.length % 4){ s += "="; } return Buffer.from(s, "base64"); }

/* ---------- the VAPID key: made once, kept in Redis ---------- */

async function vapid(){
  var jwk = await getJson(VAPID_KEY, null);
  if(!jwk || !jwk.d){
    var pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = pair.privateKey.export({ format: "jwk" });
    // only the first writer wins, so two cold starts can never make two keys
    await redis(["SET", VAPID_KEY, JSON.stringify(jwk), "NX"]);
    jwk = await getJson(VAPID_KEY, jwk);
  }
  var pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { jwk: jwk, publicKey: b64u(pub) };
}

function vapidHeader(endpoint, v){
  var aud = new URL(endpoint).origin;
  var head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  var body = b64u(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  var key = crypto.createPrivateKey({ key: v.jwk, format: "jwk" });
  var sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: key, dsaEncoding: "ieee-p1363" });
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + v.publicKey;
}

/* ---------- subscriptions: one per device ---------- */

async function loadSubs(){ var s = await getJson(SUBS_KEY, []); return Array.isArray(s) ? s : []; }
async function saveSubs(list){ await setJson(SUBS_KEY, list.slice(0, 10)); }

function cleanSub(sub){
  if(!sub || typeof sub !== "object" || typeof sub.endpoint !== "string"){ return null; }
  if(!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1200){ return null; }
  return { endpoint: sub.endpoint };
}

async function subscribe(sub, label){
  var s = cleanSub(sub);
  if(!s){ throw new Error("bad subscription"); }
  var list = await loadSubs();
  var found = list.filter(function(x){ return x.endpoint === s.endpoint; })[0];
  if(found){ found.label = String(label || found.label || "").slice(0, 60); await saveSubs(list); return found; }
  var rec = { id: "d" + b64u(crypto.randomBytes(6)), token: b64u(crypto.randomBytes(24)), endpoint: s.endpoint,
    label: String(label || "").slice(0, 60), at: new Date().toISOString() };
  list.unshift(rec);
  await saveSubs(list);
  return rec;
}

async function unsubscribe(token){
  var list = await loadSubs();
  var left = list.filter(function(x){ return x.token !== token; });
  await saveSubs(left);
  return list.length - left.length;
}

async function subByToken(token){
  if(!token){ return null; }
  var list = await loadSubs();
  return list.filter(function(x){ return x.token === token; })[0] || null;
}

/* ---------- sending ---------- */

async function sendOne(sub, v){
  var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, 8000) : null;
  try {
    var r = await fetch(sub.endpoint, {
      method: "POST",
      headers: { "Authorization": vapidHeader(sub.endpoint, v), "TTL": "86400", "Urgency": "normal", "Content-Length": "0" },
      signal: ctl ? ctl.signal : undefined
    });
    return r.status;
  } catch(e){
    return 0;
  } finally {
    if(timer){ clearTimeout(timer); }
  }
}

/* wake every device; forget the ones the push service says are gone */
async function broadcast(){
  var list = await loadSubs();
  if(!list.length){ return { sent: 0, gone: 0 }; }
  var v = await vapid();
  var sent = 0, gone = [];
  for(var i = 0; i < list.length; i++){
    var st = await sendOne(list[i], v);
    if(st >= 200 && st < 300){ sent++; }
    else if(st === 404 || st === 410){ gone.push(list[i].endpoint); }
  }
  if(gone.length){ await saveSubs(list.filter(function(x){ return gone.indexOf(x.endpoint) === -1; })); }
  return { sent: sent, gone: gone.length };
}

/* ---------- when do they reach out ---------- */

function localHour(date){
  try {
    var o = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: ROOM_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(date).forEach(function(p){ o[p.type] = p.value; });
    return (parseInt(o.hour, 10) % 24) + parseInt(o.minute, 10) / 60;
  } catch(e){ return date.getUTCHours() + date.getUTCMinutes() / 60; }
}
function toHours(hhmm){ var p = String(hhmm || "0:0").split(":"); return parseInt(p[0], 10) + (parseInt(p[1], 10) || 0) / 60; }

function quiet(settings, now){
  var q = (settings && settings.push) || {};
  var a = toHours(q.quietFrom || "23:00"), b = toHours(q.quietTo || "08:00"), h = localHour(now);
  if(a === b){ return false; }
  return a > b ? (h >= a || h < b) : (h >= a && h < b);
}

var PACE = { rarely: 0.5, natural: 1, often: 1.8 };

/* The chance, on one quarter-hour tick, that someone reaches out.
   Nothing in the first hour after contact; after that it grows the longer
   it has been, so a quiet day gets three or four texts, a busy one fewer. */
function chance(hoursSince, pace, boost){
  if(hoursSince < 1){ return 0; }
  var p = (PACE[pace] || 1) * (0.01 + 0.025 * hoursSince) + (boost || 0);
  return Math.min(0.35, p);
}

/* who sends it: someone awake and free, not the same woman twice running */
function pickSender(state, routineAt, settings, now, last, rnd){
  var names = ["selene", "nysera", "mirael", "talia"];
  var weights = names.map(function(w){
    var r = routineAt(w, now, settings);
    if(/asleep/i.test(r.doing) || /^on stage/i.test(r.doing)){ return 0; }
    var wt = 1;
    if(w === last){ wt *= 0.35; }
    if(w === "selene" || w === "mirael"){ wt *= 1.15; }
    return wt;
  });
  var tot = weights.reduce(function(a, b){ return a + b; }, 0);
  if(!tot){ return null; }
  var x = (rnd === undefined ? Math.random() : rnd) * tot;
  for(var i = 0; i < names.length; i++){ x -= weights[i]; if(x < 0){ return names[i]; } }
  return names[names.length - 1];
}

async function setTest(msg){ await redis(["SET", TEST_KEY, JSON.stringify({ text: msg, at: new Date().toISOString() }), "EX", 600]); }
async function takeTest(){
  var t = await getJson(TEST_KEY, null);
  if(t){ await redis(["DEL", TEST_KEY]); }
  return t;
}

module.exports = {
  vapid: vapid,
  vapidHeader: vapidHeader,
  subscribe: subscribe,
  unsubscribe: unsubscribe,
  subByToken: subByToken,
  loadSubs: loadSubs,
  broadcast: broadcast,
  quiet: quiet,
  chance: chance,
  pickSender: pickSender,
  localHour: localHour,
  setTest: setTest,
  takeTest: takeTest,
  b64u: b64u,
  unb64u: unb64u
};
