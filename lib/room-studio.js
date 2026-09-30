"use strict";

/* ============================================================
   ROOM STUDIO - the channel in depth, as YouTube Studio sees it
   One Google sign-in, as the account that owns the channel,
   lets the room read YouTube Analytics: watch time, how long
   people stay, where the views come from, who watches, Shorts
   against videos, and the money or the road to the Partner
   Program. Pulled once a day on the tick, or when Adger asks.
   Nysera, as CEO, keeps an eye on it; Mirael pulls the reports.
   Needs YT_CLIENT_ID and YT_CLIENT_SECRET in Vercel. The
   sign-in lives at sim:ytstudio:auth and never leaves the server.
   ZERO BACKTICKS. ASCII only.
   ============================================================ */

var crypto = require("crypto");

var AUTH_KEY = "sim:ytstudio:auth";
var SNAP_KEY = "sim:ytstudio:snap";
var LOCK_KEY = "sim:ytstudio:lock";
var NONCE_PREFIX = "sim:ytstudio:nonce:";
var AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var REVOKE_URL = "https://oauth2.googleapis.com/revoke";
var REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
var DATA = "https://www.googleapis.com/youtube/v3/";
var S_ANALYTICS = "https://www.googleapis.com/auth/yt-analytics.readonly";
var S_MONEY = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
var S_YOUTUBE = "https://www.googleapis.com/auth/youtube.readonly";
var SCOPES = [S_ANALYTICS, S_MONEY, S_YOUTUBE];
var FRESH_MS = 20 * 3600000;   // Studio numbers settle once a day
var RETRY_MS = 2 * 3600000;    // wait after a pull that failed
var LAG_DAYS = 2;              // the last two days are still coming in
// the Partner Program bars as YouTube publishes them (worth a check now and then)
var YPP = { subs: 1000, hours: 4000, shorts: 10000000, lowSubs: 500, lowHours: 3000, lowShorts: 3000000 };

/* ---------- plumbing ---------- */

async function redis(command){
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if(!url || !token){ return null; }
  var res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if(!res.ok){ throw new Error("Redis " + res.status); }
  var data = JSON.parse(await res.text());
  return data ? data.result : null;
}
async function getJson(k, d){ var r = await redis(["GET", k]); if(!r){ return d; } try { return JSON.parse(r); } catch(e){ return d; } }
async function setJson(k, v){ return await redis(["SET", k, JSON.stringify(v)]); }

function clientId(){ return process.env.YT_CLIENT_ID || ""; }
function clientSecret(){ return process.env.YT_CLIENT_SECRET || ""; }
function configured(){ return !!(clientId() && clientSecret()); }
function redirectUri(){ return process.env.YT_REDIRECT_URI || "https://first-light-api.vercel.app/api/room"; }

function qs(o){
  return Object.keys(o).filter(function(k){ return o[k] !== undefined && o[k] !== null && o[k] !== ""; })
    .map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&");
}
async function timed(url, opts, ms){
  var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, ms || 12000) : null;
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl ? ctl.signal : undefined })); }
  finally { if(timer){ clearTimeout(timer); } }
}
async function readJson(r){ try { return JSON.parse(await r.text()); } catch(e){ return {}; } }
function googleWhy(d, status){
  var e = d && d.error;
  var m = (e && typeof e === "object" && e.message) || (d && d.error_description) || (typeof e === "string" ? e : "");
  return clip(String(status || "") + (m ? " " + m : ""), 160);
}

function num(x){ var v = Number(x); return isFinite(v) ? v : 0; }
function clip(s, n){ return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim().slice(0, n); }
function clean(s){
  return String(s || "").replace(/[\u2013\u2014]/g, ", ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/\s+/g, " ").replace(/ ,/g, ",").trim();
}

/* ---------- days (YouTube Analytics counts days in Pacific time) ---------- */

function ptDay(d){
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d || new Date());
  } catch(e){ return (d || new Date()).toISOString().slice(0, 10); }
}
function addDays(day, n){ return new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
function dayName(day){
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(day + "T12:00:00Z")); }
  catch(e){ return day; }
}

/* ---------- Google ---------- */

async function tokenCall(params){
  var r = await timed(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs(params) }, 10000);
  var d = await readJson(r);
  if(!r.ok || !d.access_token){ return { ok: false, why: googleWhy(d, r.status), invalid: d && d.error === "invalid_grant" }; }
  return { ok: true, data: d };
}
async function revokeToken(t){
  if(!t){ return false; }
  try { var r = await timed(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs({ token: t }) }, 8000); return r.ok; }
  catch(e){ return false; }
}
async function dataCall(token, path, params){
  var r = await timed(DATA + path + "?" + qs(params), { headers: { "Authorization": "Bearer " + token } }, 10000);
  var d = await readJson(r);
  if(!r.ok){ return { ok: false, why: googleWhy(d, r.status), status: r.status }; }
  return { ok: true, data: d };
}
/* one YouTube Analytics report; rows come back as objects named by column */
async function report(token, params){
  var p = Object.assign({ ids: "channel==MINE" }, params);
  var r = await timed(REPORTS + "?" + qs(p), { headers: { "Authorization": "Bearer " + token } }, 12000);
  var d = await readJson(r);
  if(!r.ok){ return { ok: false, why: googleWhy(d, r.status), status: r.status }; }
  var heads = (d.columnHeaders || []).map(function(h){ return h.name; });
  var rows = (d.rows || []).map(function(row){ var o = {}; heads.forEach(function(h, i){ o[h] = row[i]; }); return o; });
  return { ok: true, rows: rows };
}
async function accessToken(auth){
  if(auth.access && num(auth.accessExp) - 60000 > Date.now()){ return auth.access; }
  var t = await tokenCall({ client_id: clientId(), client_secret: clientSecret(), refresh_token: auth.refresh, grant_type: "refresh_token" });
  if(!t.ok){
    if(t.invalid){
      auth.broken = "Google signed the Room out (" + t.why + "). Connect again.";
      auth.access = ""; auth.accessExp = 0;
      await setJson(AUTH_KEY, auth);
    }
    throw new Error("Google sign-in: " + t.why);
  }
  auth.access = t.data.access_token;
  auth.accessExp = Date.now() + num(t.data.expires_in || 3600) * 1000;
  await setJson(AUTH_KEY, auth);
  return auth.access;
}

/* ---------- connecting ---------- */

/* the page asks for a sign-in link; a one-time ticket guards the way back */
async function start(){
  if(!configured()){ return { ok: false, detail: "YT_CLIENT_ID and YT_CLIENT_SECRET are not set in Vercel yet" }; }
  var nonce = crypto.randomBytes(24).toString("hex");
  var saved = await redis(["SET", NONCE_PREFIX + nonce, "1", "EX", "900"]);
  if(saved !== "OK"){ return { ok: false, detail: "could not save the sign-in ticket" }; }
  var url = AUTH_URL + "?" + qs({
    client_id: clientId(), redirect_uri: redirectUri(), response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: nonce
  });
  return { ok: true, url: url };
}

/* Google sends him back here with a code. Trade it, keep the lasting sign-in, pull once. */
async function finish(q){
  q = q || {};
  var state = String(q.state || "");
  if(!/^[a-f0-9]{48}$/.test(state)){ return { ok: false, why: "that sign-in link was not one the Room made" }; }
  var had = await redis(["GET", NONCE_PREFIX + state]);
  if(!had){ return { ok: false, why: "that sign-in took too long or was already used; start it again from the Room" }; }
  await redis(["DEL", NONCE_PREFIX + state]);
  if(q.error){ return { ok: false, why: q.error === "access_denied" ? "Google was told no" : "Google said " + clip(q.error, 60) }; }
  var code = String(q.code || "");
  if(!code){ return { ok: false, why: "Google sent nothing back" }; }
  if(!configured()){ return { ok: false, why: "YT_CLIENT_ID and YT_CLIENT_SECRET are not set in Vercel" }; }
  var tok = await tokenCall({ code: code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(), grant_type: "authorization_code" });
  if(!tok.ok){ return { ok: false, why: "Google would not finish the sign-in (" + tok.why + ")" }; }
  var t = tok.data;
  var granted = String(t.scope || "").split(/\s+/);
  if(granted.indexOf(S_ANALYTICS) === -1 || granted.indexOf(S_YOUTUBE) === -1){
    await revokeToken(t.refresh_token || t.access_token);
    return { ok: false, why: "the Room needs the YouTube Analytics and YouTube account boxes ticked; connect again and leave them ticked" };
  }
  if(!t.refresh_token){ return { ok: false, why: "Google gave no lasting sign-in; remove The Room at myaccount.google.com/permissions and connect again" }; }
  var ch = await dataCall(t.access_token, "channels", { part: "snippet,contentDetails", mine: "true" });
  var c = ch.ok && ch.data.items && ch.data.items[0];
  if(!c){
    await revokeToken(t.refresh_token);
    return { ok: false, why: "that Google account has no YouTube channel; sign in as the account that owns the channel, and pick the channel if Google asks" };
  }
  var auth = {
    v: 1, refresh: t.refresh_token, access: t.access_token, accessExp: Date.now() + num(t.expires_in || 3600) * 1000,
    money: granted.indexOf(S_MONEY) !== -1, channelId: c.id, channel: clean(c.snippet && c.snippet.title),
    published: (c.snippet && c.snippet.publishedAt) || "",
    uploads: (c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads) || "",
    at: new Date().toISOString(), broken: "", pullFailedAt: "", pullError: ""
  };
  // a different channel than before: its old numbers are not this one's
  var old = await getJson(AUTH_KEY, null);
  if(old && old.channelId && old.channelId !== auth.channelId){ await redis(["DEL", SNAP_KEY]); }
  if(old && old.refresh && old.refresh !== auth.refresh){ await revokeToken(old.refresh); }
  await setJson(AUTH_KEY, auth);
  var pulled = null;
  try { pulled = await pull(true); } catch(e){ pulled = { ok: false }; }
  return { ok: true, channel: auth.channel, pulled: !!(pulled && pulled.ok) };
}

async function disconnect(){
  var auth = await getJson(AUTH_KEY, null);
  var revoked = auth ? await revokeToken(auth.refresh) : false;
  await redis(["DEL", AUTH_KEY, SNAP_KEY]);
  return { ok: true, revoked: revoked };
}

/* ---------- names for what Google calls things ---------- */

var TRAFFIC = {
  YT_SEARCH: "YouTube search", RELATED_VIDEO: "Suggested videos", SUBSCRIBER: "Browse (home and subscriptions)",
  EXT_URL: "Other sites and apps", NO_LINK_OTHER: "Direct or unknown", PLAYLIST: "Playlists", YT_PLAYLIST_PAGE: "Playlist pages",
  YT_CHANNEL: "The channel page", SHORTS: "The Shorts feed", SHORTS_CONTENT_LINKS: "Links in Shorts", NOTIFICATION: "Notifications",
  END_SCREEN: "End screens", YT_OTHER_PAGE: "Other YouTube pages", HASHTAGS: "Hashtag pages", ANNOTATION: "Cards",
  CAMPAIGN_CARD: "Campaign cards", ADVERTISING: "Ads", PROMOTED: "Promotion", NO_LINK_EMBEDDED: "Embedded players",
  LIVE_REDIRECT: "Live redirects", SOUND_PAGE: "Sound pages", VIDEO_REMIXES: "Remixes", PRODUCT_PAGE: "Product pages",
  IMMERSIVE_LIVE: "Immersive live", SEARCH: "YouTube search"
};
var DEVICE = { MOBILE: "Phones", DESKTOP: "Computers", TABLET: "Tablets", TV: "TVs", GAME_CONSOLE: "Game consoles", UNKNOWN_PLATFORM: "Unknown" };
var CTYPE = { VIDEO_ON_DEMAND: "Videos", SHORTS: "Shorts", LIVE_STREAM: "Live", STORY: "Stories", UNSPECIFIED: "Other" };
function titleCase(k){ return String(k || "").toLowerCase().replace(/_/g, " ").replace(/^./, function(c){ return c.toUpperCase(); }); }
function countryName(code){
  try { var n = new Intl.DisplayNames(["en"], { type: "region" }).of(String(code)); return n || String(code); } catch(e){ return String(code); }
}
function ageLabel(a){
  var m = /^age(\d+)-(\d*)$/.exec(String(a || ""));
  if(!m){ return String(a || ""); }
  return m[2] ? m[1] + " to " + m[2] : m[1] + " and over";
}
function genderLabel(g){ return g === "male" ? "men" : (g === "female" ? "women" : "people of another gender"); }

/* ---------- reading it ---------- */

function tot(o){
  o = o || {};
  return { views: num(o.views), minutes: num(o.estimatedMinutesWatched), avgDur: num(o.averageViewDuration), avgPct: num(o.averageViewPercentage),
    subsGained: num(o.subscribersGained), subsLost: num(o.subscribersLost), likes: num(o.likes), comments: num(o.comments), shares: num(o.shares) };
}
function parseDuration(iso){
  var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ""));
  if(!m){ return 0; }
  return num(m[1]) * 86400 + num(m[2]) * 3600 + num(m[3]) * 60 + num(m[4]);
}
/* the retention curve: share of viewers still there at each point, and where it falls away */
function curveOf(rows, durSec){
  var pts = rows.map(function(r){ return { x: num(r.elapsedVideoTimeRatio), y: num(r.audienceWatchRatio), rel: num(r.relativeRetentionPerformance) }; })
    .filter(function(p){ return p.x > 0; }).sort(function(a, b){ return a.x - b.x; });
  if(pts.length < 5){ return null; }
  function at(x){
    if(x <= pts[0].x){ return pts[0].y; }
    for(var i = 1; i < pts.length; i++){
      if(pts[i].x >= x){ var a = pts[i - 1], b = pts[i]; return a.y + (b.y - a.y) * ((x - a.x) / ((b.x - a.x) || 1)); }
    }
    return pts[pts.length - 1].y;
  }
  var curve = [];
  for(var k = 0; k <= 20; k++){ curve.push(Math.round(at(Math.max(0.01, k / 20)) * 1000) / 1000); }
  var drop = null;
  for(var j = 3; j < pts.length; j++){
    if(pts[j].x > 0.95){ break; }
    var d = pts[j - 3].y - pts[j].y;
    if(!drop || d > drop.lost){ drop = { lost: d, x: pts[j - 3].x }; }
  }
  var relSum = 0, relN = 0;
  pts.forEach(function(p){ if(p.rel > 0){ relSum += p.rel; relN++; } });
  return {
    curve: curve,
    still30: durSec > 45 ? Math.round(at(30 / durSec) * 100) : null,
    stillHalf: Math.round(at(0.5) * 100),
    drop: drop && drop.lost > 0.04 ? { atSec: Math.round(drop.x * durSec), lost: Math.round(drop.lost * 100) } : null,
    rel: relN ? Math.round((relSum / relN) * 100) / 100 : null,
    loops: pts.some(function(p){ return p.y > 1.02; })
  };
}

/* pull every report at once; whatever fails is noted and the rest still counts */
async function pull(force){
  if(!configured()){ return { ok: false, detail: "not set up in Vercel" }; }
  var auth = await getJson(AUTH_KEY, null);
  if(!auth || !auth.refresh){ return { ok: false, detail: "not connected" }; }
  if(auth.broken){ return { ok: false, detail: auth.broken }; }
  var got = await redis(["SET", LOCK_KEY, "1", "NX", "EX", "90"]);
  if(got !== "OK"){ return { ok: false, detail: "already pulling" }; }
  try {
    var token;
    try { token = await accessToken(auth); }
    catch(e){
      auth = (await getJson(AUTH_KEY, null)) || auth;
      auth.pullFailedAt = new Date().toISOString(); auth.pullError = clip(e && e.message, 200);
      await setJson(AUTH_KEY, auth);
      return { ok: false, detail: auth.broken || auth.pullError };
    }
    var end = addDays(ptDay(new Date()), -LAG_DAYS);
    var s28 = addDays(end, -27), p28e = addDays(s28, -1), p28s = addDays(s28, -28);
    var s90 = addDays(end, -89), s365 = addDays(end, -364);
    var born = auth.published ? ptDay(new Date(auth.published)) : "2006-01-01";
    if(born > end){ born = end; }
    var M_TOT = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares";
    var jobs = {
      cur: { startDate: s28, endDate: end, metrics: M_TOT },
      prev: { startDate: p28s, endDate: p28e, metrics: M_TOT },
      daily: { startDate: p28s, endDate: end, dimensions: "day", metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", sort: "day" },
      top: { startDate: s28, endDate: end, dimensions: "video", metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes", sort: "-views", maxResults: 10 },
      traffic: { startDate: s28, endDate: end, dimensions: "insightTrafficSourceType", metrics: "views,estimatedMinutesWatched" },
      countries: { startDate: s28, endDate: end, dimensions: "country", metrics: "views,estimatedMinutesWatched", sort: "-views" },
      audience: { startDate: s90, endDate: end, dimensions: "ageGroup,gender", metrics: "viewerPercentage", sort: "gender,ageGroup" },
      subscribed: { startDate: s28, endDate: end, dimensions: "subscribedStatus", metrics: "views,estimatedMinutesWatched,averageViewDuration" },
      devices: { startDate: s28, endDate: end, dimensions: "deviceType", metrics: "views,estimatedMinutesWatched" },
      types: { startDate: s28, endDate: end, dimensions: "creatorContentType", metrics: "views,estimatedMinutesWatched,subscribersGained" },
      year: { startDate: s365, endDate: end, dimensions: "creatorContentType", metrics: "views,estimatedMinutesWatched" },
      shorts90: { startDate: s90, endDate: end, dimensions: "creatorContentType", metrics: "views" },
      life: { startDate: born, endDate: end, metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost" }
    };
    if(auth.money){ jobs.money = { startDate: s28, endDate: end, metrics: "estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,playbackBasedCpm,monetizedPlaybacks", currency: "USD" }; }
    var names = Object.keys(jobs);
    var results = await Promise.all(names.map(function(n){ return report(token, jobs[n]).catch(function(e){ return { ok: false, why: clip(e && e.message, 120) }; }); })
      .concat([
        dataCall(token, "channels", { part: "statistics", mine: "true" }).catch(function(){ return { ok: false }; }),
        auth.uploads ? dataCall(token, "playlistItems", { part: "contentDetails", playlistId: auth.uploads, maxResults: 6 }).catch(function(){ return { ok: false }; }) : Promise.resolve({ ok: false })
      ]));
    var R = {}; names.forEach(function(n, i){ R[n] = results[i]; });
    var chStats = results[names.length], upl = results[names.length + 1];
    if(!R.cur.ok && !R.daily.ok && !R.top.ok){
      auth.pullFailedAt = new Date().toISOString(); auth.pullError = "YouTube Analytics: " + (R.cur.why || "no answer");
      await setJson(AUTH_KEY, auth);
      return { ok: false, detail: auth.pullError };
    }
    var rows = function(n){ return (R[n] && R[n].ok) ? R[n].rows : []; };
    var errors = {};
    names.forEach(function(n){ if(n !== "money" && R[n] && !R[n].ok){ errors[n] = R[n].why || "failed"; } });

    // titles, lengths and dates for the newest uploads and the month's best
    var newestIds = (upl && upl.ok ? (upl.data.items || []) : []).map(function(i){ return i.contentDetails && i.contentDetails.videoId; }).filter(Boolean);
    var topIds = rows("top").map(function(r){ return r.video; });
    var allIds = newestIds.concat(topIds).filter(function(v, i, a){ return v && a.indexOf(v) === i; }).slice(0, 50);
    var info = {};
    if(allIds.length){
      var vs = await dataCall(token, "videos", { part: "snippet,contentDetails,status", id: allIds.join(",") }).catch(function(){ return { ok: false }; });
      (vs.ok ? (vs.data.items || []) : []).forEach(function(v){
        info[v.id] = { title: clean(v.snippet && v.snippet.title), published: (v.snippet && v.snippet.publishedAt) || "",
          durSec: parseDuration(v.contentDetails && v.contentDetails.duration), privacy: (v.status && v.status.privacyStatus) || "" };
      });
    }
    // the newest two public uploads: how they are holding people
    var fresh = newestIds.filter(function(id){ return info[id] && info[id].privacy === "public"; }).slice(0, 2);
    var newest = await Promise.all(fresh.map(async function(id){
      var v = info[id], day = ptDay(new Date(v.published || Date.now()));
      var o = { id: id, title: v.title, published: v.published, durSec: v.durSec };
      if(day > end){ o.tooNew = true; return o; }
      var two = await Promise.all([
        report(token, { startDate: day, endDate: end, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes", filters: "video==" + id }).catch(function(){ return { ok: false }; }),
        report(token, { startDate: day, endDate: end, dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio,relativeRetentionPerformance", filters: "video==" + id }).catch(function(){ return { ok: false }; })
      ]);
      if(two[0].ok){ var s = tot(two[0].rows[0]); o.views = s.views; o.minutes = s.minutes; o.avgDur = s.avgDur; o.avgPct = s.avgPct; o.subs = s.subsGained; o.likes = s.likes; }
      if(two[1].ok){ o.retention = curveOf(two[1].rows, v.durSec); }
      return o;
    }));

    var cur = tot(rows("cur")[0]), prev = tot(rows("prev")[0]);
    var daily = rows("daily").map(function(r){ return [String(r.day), num(r.views), num(r.estimatedMinutesWatched), num(r.subscribersGained) - num(r.subscribersLost)]; });
    var byType = function(list){ var o = {}; list.forEach(function(r){ o[r.creatorContentType] = r; }); return o; };
    var yr = byType(rows("year")), s90r = byType(rows("shorts90"));
    var longMin = 0; ["VIDEO_ON_DEMAND", "LIVE_STREAM"].forEach(function(k){ if(yr[k]){ longMin += num(yr[k].estimatedMinutesWatched); } });
    var snap = {
      v: 1, at: new Date().toISOString(), channel: auth.channel, channelId: auth.channelId,
      range: { start: s28, end: end, prevStart: p28s, prevEnd: p28e },
      subs: (chStats && chStats.ok && chStats.data.items && chStats.data.items[0]) ? num(chStats.data.items[0].statistics.subscriberCount) : null,
      cur: cur, prev: prev, daily: daily,
      top: rows("top").map(function(r){ var t = tot(r); return { id: r.video, title: (info[r.video] && info[r.video].title) || "", views: t.views, minutes: t.minutes, avgDur: t.avgDur, avgPct: t.avgPct, subs: t.subsGained, likes: t.likes }; }),
      traffic: rows("traffic").map(function(r){ return { key: r.insightTrafficSourceType, name: TRAFFIC[r.insightTrafficSourceType] || titleCase(r.insightTrafficSourceType), views: num(r.views), minutes: num(r.estimatedMinutesWatched) }; })
        .sort(function(a, b){ return b.views - a.views; }),
      countries: rows("countries").map(function(r){ return { code: r.country, name: countryName(r.country), views: num(r.views), minutes: num(r.estimatedMinutesWatched) }; })
        .sort(function(a, b){ return b.views - a.views; }).slice(0, 10),
      audience: rows("audience").map(function(r){ return { age: ageLabel(r.ageGroup), gender: String(r.gender || ""), pct: Math.round(num(r.viewerPercentage) * 10) / 10 }; })
        .filter(function(a){ return a.pct > 0; }).sort(function(a, b){ return b.pct - a.pct; }),
      subscribed: rows("subscribed").map(function(r){ return { key: r.subscribedStatus, views: num(r.views), minutes: num(r.estimatedMinutesWatched), avgDur: num(r.averageViewDuration) }; }),
      devices: rows("devices").map(function(r){ return { key: r.deviceType, name: DEVICE[r.deviceType] || titleCase(r.deviceType), views: num(r.views), minutes: num(r.estimatedMinutesWatched) }; })
        .sort(function(a, b){ return b.views - a.views; }),
      types: rows("types").map(function(r){ return { key: r.creatorContentType, name: CTYPE[r.creatorContentType] || titleCase(r.creatorContentType), views: num(r.views), minutes: num(r.estimatedMinutesWatched), subs: num(r.subscribersGained) }; })
        .filter(function(t){ return t.views > 0 || t.minutes > 0; }).sort(function(a, b){ return b.views - a.views; }),
      year: { longHours: Math.round(longMin / 6) / 10, shortsViews90: s90r.SHORTS ? num(s90r.SHORTS.views) : 0, ok: R.year.ok && R.shorts90.ok },
      life: R.life.ok ? tot(rows("life")[0]) : null,
      newest: newest,
      money: null, moneyWhy: "",
      errors: errors
    };
    if(!auth.money){ snap.moneyWhy = "the revenue box was not ticked at sign-in"; }
    else if(R.money && R.money.ok){
      var m = rows("money")[0] || {};
      snap.money = { revenue: num(m.estimatedRevenue), ad: num(m.estimatedAdRevenue), gross: num(m.grossRevenue), cpm: num(m.cpm), playbackCpm: num(m.playbackBasedCpm), monetized: num(m.monetizedPlaybacks) };
    } else { snap.moneyWhy = (R.money && R.money.status === 403) ? "the channel is not earning yet" : "YouTube did not answer about money (" + ((R.money && R.money.why) || "no answer") + ")"; }
    snap.earning = !!(snap.money && (snap.money.revenue > 0 || snap.money.monetized > 0));

    // worth mentioning since the last pull
    var old = await getJson(SNAP_KEY, null);
    var best = null;
    daily.forEach(function(d){ if(!best || d[1] > best.views){ best = { day: d[0], views: d[1] }; } });
    snap.best = best;
    snap.moments = [];
    if(old && best && daily.length >= 14 && best.views >= 20 && (!old.best || best.day > old.best.day) && best.views > num(old.best && old.best.views)){
      snap.moments.push("the best day in two months: " + fmt(best.views) + " views on " + dayName(best.day));
    }
    if(old && old.year && snap.year.ok && !snap.earning){
      var step = 500;
      if(Math.floor(snap.year.longHours / step) > Math.floor(num(old.year.longHours) / step)){
        snap.moments.push("long-form watch hours over the last 12 months just passed " + fmt(Math.floor(snap.year.longHours / step) * step) + " (the Partner Program wants " + fmt(YPP.hours) + ")");
      }
    }
    if(old && old.moments && Date.now() - Date.parse(old.at) < 24 * 3600000){
      old.moments.forEach(function(x){ if(snap.moments.length < 4 && snap.moments.indexOf(x) === -1){ snap.moments.push(x); } });
    }
    await setJson(SNAP_KEY, snap);
    auth = (await getJson(AUTH_KEY, null)) || auth;
    auth.pullFailedAt = ""; auth.pullError = "";
    await setJson(AUTH_KEY, auth);
    return { ok: true, views: cur.views, hours: Math.round(cur.minutes / 60), errors: Object.keys(errors).length };
  } finally {
    try { await redis(["DEL", LOCK_KEY]); } catch(e){}
  }
}

async function snapshot(){ return await getJson(SNAP_KEY, null); }
async function due(){
  if(!configured()){ return false; }
  var auth = await getJson(AUTH_KEY, null);
  if(!auth || !auth.refresh || auth.broken){ return false; }
  var now = Date.now();
  if(auth.pullFailedAt && now - Date.parse(auth.pullFailedAt) < RETRY_MS){ return false; }
  var s = await snapshot();
  return !s || !s.at || now - Date.parse(s.at) > FRESH_MS;
}

/* for the page: never the sign-in itself */
async function status(){
  var auth = await getJson(AUTH_KEY, null);
  var snap = auth ? await snapshot() : null;
  return {
    ok: true, configured: configured(), connected: !!(auth && auth.refresh), channel: auth ? auth.channel : "",
    since: auth ? auth.at : "", broken: auth ? (auth.broken || "") : "", money: !!(auth && auth.money),
    pullError: auth ? (auth.pullError || "") : "", pullFailedAt: auth ? (auth.pullFailedAt || "") : "",
    snap: snap, note: snap ? studioNote(snap, "room") : ""
  };
}

/* ---------- what the room is told ---------- */

function fmt(x){ return String(Math.round(num(x))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function hrs(min){ var h = num(min) / 60; return h < 10 ? (Math.round(h * 10) / 10) + " hours" : fmt(h) + " hours"; }
function dur(sec){ sec = Math.round(num(sec)); return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2); }
function pctOf(a, b){ return b > 0 ? Math.round((a / b) * 100) : 0; }
function change(a, b){
  if(!(b > 0)){ return a > 0 ? "new" : ""; }
  var c = Math.round(((a - b) / b) * 100);
  if(Math.abs(c) < 3){ return "about the same as the 28 days before"; }
  return (c > 0 ? "+" : "") + c + "% on the 28 days before";
}
function ago(iso){
  var t = Date.parse(iso || ""); if(isNaN(t)){ return ""; }
  var h = (Date.now() - t) / 3600000;
  if(h < 1){ return "within the hour"; }
  if(h < 24){ return Math.round(h) + " hours ago"; }
  var d = Math.round(h / 24); return d + (d === 1 ? " day ago" : " days ago");
}
function holdLine(o){
  var r = o.retention, bits = [];
  if(o.views != null){ bits.push(fmt(o.views) + " views"); }
  if(o.avgDur){ bits.push("people stay " + dur(o.avgDur) + " (" + Math.round(num(o.avgPct)) + "% of it)"); }
  if(r && r.still30 != null && !r.loops){ bits.push("30 seconds in, " + r.still30 + "% are still watching"); }
  if(r && r.loops){ bits.push("people loop it"); }
  if(r && r.drop && !r.loops){ bits.push("the biggest drop is around " + dur(r.drop.atSec)); }
  if(r && r.rel != null){ bits.push(r.rel >= 0.6 ? "it holds people better than most videos its length" : (r.rel <= 0.4 ? "it loses people faster than most videos its length" : "about usual for its length")); }
  return bits.join(", ");
}

/* mode "room": the full picture for when the talk turns there. mode "text": two lines for a text. */
function studioNote(s, mode){
  if(!s || !s.cur){ return ""; }
  var c = s.cur, p = s.prev || {};
  var head = fmt(c.views) + " views (" + (change(c.views, p.views) || "no earlier numbers") + "), " + hrs(c.minutes) + " watched (" + (change(c.minutes, p.minutes) || "new") + "), "
    + "+" + fmt(c.subsGained) + " subscribers and " + fmt(c.subsLost) + " lost";
  if(mode === "text"){
    var t = ["THE CHANNEL IN DEPTH (YouTube Studio, the 28 days to " + dayName(s.range.end) + "; Nysera keeps an eye on it): " + head + "."];
    if(s.moments && s.moments.length){ t.push("Just happened: " + s.moments.join("; ") + "."); }
    return t.join("\n");
  }
  var L = [];
  L.push("THE CHANNEL IN DEPTH (YouTube Studio for " + (s.channel || "the channel") + ", the 28 days to " + dayName(s.range.end) + ", pulled " + ago(s.at) + ". Private: only Adger and the band see these. Nysera, as CEO, keeps an eye on them and Mirael pulls the reports; the others hear it from them or ask. Bring a number in only when it matters to what is being said, the way people who know their own channel talk, never as a report):");
  L.push("Last 28 days: " + head + ". People stay " + dur(c.avgDur) + " on average (" + Math.round(c.avgPct) + "% of a video).");
  var top = (s.top || []).filter(function(v){ return v.title; }).slice(0, 3);
  if(top.length){ L.push("Best this month: " + top.map(function(v){ return "\"" + v.title + "\" " + fmt(v.views) + " views, " + hrs(v.minutes) + ", " + Math.round(v.avgPct) + "% watched, +" + fmt(v.subs) + " subscribers"; }).join("; ") + "."); }
  var tv = 0; (s.traffic || []).forEach(function(t){ tv += t.views; });
  if(tv){ L.push("Where the views come from: " + s.traffic.slice(0, 5).map(function(t){ return t.name + " " + pctOf(t.views, tv) + "%"; }).join(", ") + "."); }
  var who = [];
  var sv = 0, unsub = null; (s.subscribed || []).forEach(function(x){ sv += x.views; if(x.key === "UNSUBSCRIBED"){ unsub = x; } });
  if(unsub && sv){ who.push(pctOf(unsub.views, sv) + "% of views are from people not subscribed"); }
  var cv = 0; (s.countries || []).forEach(function(x){ cv += x.views; });
  if(s.countries && s.countries.length && c.views){ who.push("top countries " + s.countries.slice(0, 5).map(function(x){ return x.name + " " + pctOf(x.views, c.views) + "%"; }).join(", ")); }
  var dv = 0; (s.devices || []).forEach(function(x){ dv += x.views; });
  if(dv){ who.push(s.devices.slice(0, 2).map(function(x){ return x.name.toLowerCase() + " " + pctOf(x.views, dv) + "%"; }).join(", ")); }
  if(s.audience && s.audience.length){ who.push("mostly " + s.audience.slice(0, 2).map(function(a){ return genderLabel(a.gender) + " " + a.age + " (" + Math.round(a.pct) + "%)"; }).join(" and ") + ", over 90 days"); }
  if(who.length){ L.push("Who watches: " + who.join("; ") + "."); }
  if(s.types && s.types.length > 1){ L.push("Shorts against videos: " + s.types.map(function(t){ return t.name + " " + fmt(t.views) + " views and " + hrs(t.minutes); }).join("; ") + "."); }
  (s.newest || []).forEach(function(o, i){
    if(o.tooNew){ L.push((i ? "Before that" : "Newest") + ": \"" + o.title + "\", up " + ago(o.published) + "; its Studio numbers are not in yet."); return; }
    var h = holdLine(o);
    if(h){ L.push((i ? "Before that" : "Newest") + ": \"" + o.title + "\", up " + ago(o.published) + ": " + h + "."); }
  });
  if(s.earning){
    var m = s.money;
    L.push("Money: about $" + m.revenue.toFixed(2) + " estimated in these 28 days" + (m.playbackCpm ? " (about $" + m.playbackCpm.toFixed(2) + " for every 1,000 views that showed ads)" : "") + ".");
  } else if(s.year && s.year.ok){
    L.push("Toward the Partner Program (approximate; Studio counts only public videos): " + (s.subs != null ? fmt(s.subs) + " of " + fmt(YPP.subs) + " subscribers, " : "")
      + fmt(s.year.longHours) + " of " + fmt(YPP.hours) + " long-form watch hours in the last 12 months, " + fmt(s.year.shortsViews90) + " of 10 million Shorts views in 90 days"
      + ". The lower tier wants " + fmt(YPP.lowSubs) + " subscribers and " + fmt(YPP.lowHours) + " hours.");
  }
  if(s.life){ L.push("Since the channel began: " + fmt(s.life.views) + " views and " + hrs(s.life.minutes) + " watched."); }
  if(s.moments && s.moments.length){ L.push("Just happened: " + s.moments.join("; ") + "."); }
  return L.join("\n");
}

async function note(mode){
  var s = await snapshot();
  return s ? studioNote(s, mode) : "";
}

module.exports = {
  AUTH_KEY: AUTH_KEY, SNAP_KEY: SNAP_KEY, SCOPES: SCOPES, YPP: YPP,
  configured: configured, redirectUri: redirectUri, start: start, finish: finish, disconnect: disconnect,
  pull: pull, due: due, snapshot: snapshot, status: status, studioNote: studioNote, note: note,
  ptDay: ptDay, addDays: addDays, curveOf: curveOf, parseDuration: parseDuration
};
