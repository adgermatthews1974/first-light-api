"use strict";

/* ============================================================
   ROOM YOUTUBE - the channel, as the band sees it
   Public numbers from the YouTube Data API (a free key set in
   Vercel as YOUTUBE_API_KEY): subscribers, every video's views,
   likes and comments, and the newest comments. Refreshed every
   few hours. A daily snapshot gives "since yesterday".
   ZERO BACKTICKS.
   ============================================================ */

var HANDLE = process.env.YOUTUBE_HANDLE || "@Soul.Forged.Studios";
var SNAP_KEY = "sim:youtube:snap";
var HIST_KEY = "sim:youtube:hist";
var API = "https://www.googleapis.com/youtube/v3/";
var FRESH_MS = 3 * 3600000;

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
async function getJson(k, d){ var r = await redis(["GET", k]); if(!r){ return d; } try { return JSON.parse(r); } catch(e){ return d; } }

function key(){ return process.env.YOUTUBE_API_KEY || ""; }

async function api(path, params){
  var q = Object.keys(params).map(function(k){ return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
  var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, 9000) : null;
  try {
    var r = await fetch(API + path + "?" + q + "&key=" + encodeURIComponent(key()), { signal: ctl ? ctl.signal : undefined });
    var d = await r.json();
    if(!r.ok){ throw new Error("YouTube " + r.status + " " + ((d && d.error && d.error.message) || "")); }
    return d;
  } finally { if(timer){ clearTimeout(timer); } }
}

function n(x){ var v = parseInt(x, 10); return isNaN(v) ? 0 : v; }
function clean(s){
  return String(s || "").replace(/[\u2013\u2014]/g, ", ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function dayKey(d){ return new Date(d).toISOString().slice(0, 10); }

/* read the channel now. Returns the new snapshot. */
async function refresh(){
  if(!key()){ return { ok: false, detail: "no YOUTUBE_API_KEY set in Vercel" }; }
  var ch = await api("channels", { part: "snippet,statistics,contentDetails", forHandle: HANDLE });
  var c = ch.items && ch.items[0];
  if(!c){ return { ok: false, detail: "channel not found for " + HANDLE }; }
  var uploads = c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads;
  var ids = [];
  if(uploads){
    var pl = await api("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: 50 });
    ids = (pl.items || []).map(function(i){ return i.contentDetails && i.contentDetails.videoId; }).filter(Boolean);
  }
  var videos = [];
  if(ids.length){
    var vs = await api("videos", { part: "snippet,statistics", id: ids.join(",") });
    videos = (vs.items || []).map(function(v){
      return { id: v.id, title: clean(v.snippet && v.snippet.title), published: v.snippet && v.snippet.publishedAt,
        views: n(v.statistics && v.statistics.viewCount), likes: n(v.statistics && v.statistics.likeCount), comments: n(v.statistics && v.statistics.commentCount) };
    }).sort(function(a, b){ return a.published < b.published ? 1 : -1; });
  }
  var titles = {}; videos.forEach(function(v){ titles[v.id] = v.title; });
  var comments = [];
  try {
    var ct = await api("commentThreads", { part: "snippet", allThreadsRelatedToChannelId: c.id, order: "time", maxResults: 20, textFormat: "plainText" });
    comments = (ct.items || []).map(threadToComment);
  } catch(e){
    // fall back to the newest few videos one by one
    for(var i = 0; i < Math.min(4, videos.length); i++){
      try {
        var one = await api("commentThreads", { part: "snippet", videoId: videos[i].id, order: "time", maxResults: 6, textFormat: "plainText" });
        comments = comments.concat((one.items || []).map(threadToComment));
      } catch(e2){ /* comments off on that video */ }
    }
    comments.sort(function(a, b){ return a.at < b.at ? 1 : -1; });
  }
  comments = comments.slice(0, 15).map(function(x){ x.video = titles[x.videoId] || ""; return x; });

  var prevHist = await getJson(HIST_KEY, []);
  if(!Array.isArray(prevHist)){ prevHist = []; }
  var snap = {
    at: new Date().toISOString(),
    channel: clean(c.snippet && c.snippet.title),
    subs: n(c.statistics && c.statistics.subscriberCount),
    views: n(c.statistics && c.statistics.viewCount),
    videoCount: n(c.statistics && c.statistics.videoCount),
    videos: videos,
    comments: comments
  };
  // one snapshot per day, two weeks kept, for "since yesterday" and "this week"
  var today = dayKey(snap.at);
  var per = {}; videos.forEach(function(v){ per[v.id] = v.views; });
  var hist = prevHist.filter(function(h){ return h.day !== today; });
  hist.unshift({ day: today, subs: snap.subs, views: snap.views, per: per });
  hist = hist.slice(0, 14);
  // something worth celebrating since the last reading
  var old = await getJson(SNAP_KEY, null);
  snap.moments = [];
  if(old){
    if(Math.floor(snap.subs / 100) > Math.floor((old.subs || 0) / 100)){ snap.moments.push("the channel just passed " + (Math.floor(snap.subs / 100) * 100) + " subscribers"); }
    var oldPer = {}; (old.videos || []).forEach(function(v){ oldPer[v.id] = v.views; });
    videos.forEach(function(v){
      var step = v.views >= 10000 ? 5000 : 1000;
      if(oldPer[v.id] !== undefined && Math.floor(v.views / step) > Math.floor(oldPer[v.id] / step)){
        snap.moments.push("\"" + v.title + "\" just passed " + (Math.floor(v.views / step) * step) + " views");
      }
    });
    (old.moments || []).forEach(function(m){ if(snap.moments.length < 4 && snap.moments.indexOf(m) === -1 && Date.now() - Date.parse(old.at) < 24 * 3600000){ snap.moments.push(m); } });
  }
  await redis(["SET", SNAP_KEY, JSON.stringify(snap)]);
  await redis(["SET", HIST_KEY, JSON.stringify(hist)]);
  return { ok: true, subs: snap.subs, videos: videos.length, comments: comments.length };
}

function threadToComment(t){
  var s = (t.snippet && t.snippet.topLevelComment && t.snippet.topLevelComment.snippet) || {};
  return { videoId: (t.snippet && t.snippet.videoId) || s.videoId || "", author: clean(s.authorDisplayName), text: clean(s.textOriginal || s.textDisplay).slice(0, 400),
    likes: n(s.likeCount), replies: n(t.snippet && t.snippet.totalReplyCount), at: s.publishedAt || "" };
}

async function snapshot(){ return await getJson(SNAP_KEY, null); }
async function due(){
  if(!key()){ return false; }
  var s = await snapshot();
  return !s || !s.at || Date.now() - Date.parse(s.at) > FRESH_MS;
}

function ago(iso){
  var t = Date.parse(iso || ""); if(isNaN(t)){ return ""; }
  var h = (Date.now() - t) / 3600000;
  if(h < 1){ return "within the hour"; }
  if(h < 24){ return Math.round(h) + " hours ago"; }
  var d = Math.round(h / 24); return d + (d === 1 ? " day ago" : " days ago");
}
function fmt(x){ return String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/* what the room is told. Short: the headline numbers, what moved, the newest comments. */
async function channelNote(){
  var s = await snapshot();
  if(!s){ return ""; }
  var hist = await getJson(HIST_KEY, []);
  var y = Array.isArray(hist) ? hist[1] : null;
  var week = Array.isArray(hist) ? hist[Math.min(7, hist.length - 1)] : null;
  var lines = [];
  lines.push("THE CHANNEL (" + (s.channel || "Soul Forged Studios") + " on YouTube, read " + ago(s.at) + "; real numbers, theirs. They check it the way any band does and bring it up only when it matters, never as a report):");
  var subs = fmt(s.subs) + " subscribers" + (y ? " (" + (s.subs - y.subs >= 0 ? "+" : "") + (s.subs - y.subs) + " since yesterday)" : "") + ", " + fmt(s.views) + " views in all";
  if(week && week !== y && hist.length > 2){ subs += ", " + (s.subs - week.subs >= 0 ? "+" : "") + (s.subs - week.subs) + " subscribers this week"; }
  lines.push(subs + ".");
  var v0 = s.videos && s.videos[0];
  if(v0){ lines.push("Newest video: \"" + v0.title + "\", posted " + ago(v0.published) + ", " + fmt(v0.views) + " views, " + fmt(v0.likes) + " likes, " + fmt(v0.comments) + " comments."); }
  if(y && y.per && s.videos && s.videos.length){
    var best = null;
    s.videos.forEach(function(v){ var d = v.views - (y.per[v.id] || v.views); if(!best || d > best.d){ best = { v: v, d: d }; } });
    if(best && best.d > 0){ lines.push("Moving fastest since yesterday: \"" + best.v.title + "\" (+" + fmt(best.d) + " views, " + fmt(best.v.views) + " total)."); }
  }
  if(s.moments && s.moments.length){ lines.push("Just happened: " + s.moments.join("; ") + "."); }
  var cs = (s.comments || []).slice(0, 4);
  if(cs.length){
    lines.push("Newest comments:");
    cs.forEach(function(c){ lines.push("- " + c.author + (c.video ? " on \"" + c.video + "\"" : "") + ", " + ago(c.at) + ": \"" + c.text.slice(0, 220) + "\""); });
  }
  return lines.join("\n");
}

module.exports = { refresh: refresh, snapshot: snapshot, due: due, channelNote: channelNote, HANDLE: HANDLE };
