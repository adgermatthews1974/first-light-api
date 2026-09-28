"use strict";

/* ============================================================
   ROOM SITE - the studio's own website, as the women know it
   Once a day the server reads soulforgedstudio.com from its
   sitemap, keeps the words (not the pictures or code), and files
   them as knowledge the room can draw on when the talk turns there.
   Hidden pages and the old sim pages are never read.
   ZERO BACKTICKS.
   ============================================================ */

var SITE = "https://www.soulforgedstudio.com";
var KNOW_KEY = "sim:knowledge:site";
var META_KEY = "sim:site:meta";
var MAX_PAGES = 45;
var CHUNK = 900;
var UA = "SoulForgedRoom/1.0 (+https://first-light-api.vercel.app)";

/* never read these: hidden pages, the sims, the shop machinery */
var SKIP = [/until-the-last-light/i, /last-light/i, /-sim(\/|$)/i, /\/sim(\/|$)/i, /nyseraselene/i,
  /\/cart/i, /\/account/i, /\/checkout/i, /\/search/i, /\/s\//i, /\/config/i, /\/commerce/i, /\.(xml|json|jpg|png|pdf)$/i];

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

async function get(url, ms){
  var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, ms || 9000) : null;
  try {
    var r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xml" }, signal: ctl ? ctl.signal : undefined });
    if(!r.ok){ return null; }
    return await r.text();
  } catch(e){ return null; }
  finally { if(timer){ clearTimeout(timer); } }
}

function decode(s){
  return String(s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, "\"").replace(/&hellip;/g, "...").replace(/&mdash;|&ndash;/g, ", ")
    .replace(/&middot;/g, " . ").replace(/&#(\d+);/g, function(m, n){ var c = parseInt(n, 10); return c > 126 ? " " : String.fromCharCode(c); })
    .replace(/&[a-z]+;/gi, " ");
}

/* the words on a page: no scripts, styles, pictures, menus or footers */
function pageText(html){
  var h = String(html || "");
  var title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  var desc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || "";
  var body = (h.match(/<main[\s\S]*?<\/main>/i) || [])[0] || (h.match(/<body[\s\S]*<\/body>/i) || [])[0] || h;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  var text = decode(body)
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").replace(/ ,/g, ",").trim();
  return { title: decode(title).replace(/\s+/g, " ").trim(), desc: decode(desc).trim(), text: text };
}

function chunkText(text, size){
  var out = [], buf = "";
  String(text).split("\n").forEach(function(line){
    if((buf + "\n" + line).length > size && buf){ out.push(buf.trim()); buf = ""; }
    buf += (buf ? "\n" : "") + line;
    while(buf.length > size * 1.6){ out.push(buf.slice(0, size).trim()); buf = buf.slice(size); }
  });
  if(buf.trim()){ out.push(buf.trim()); }
  return out;
}

function slugWords(url){
  var p = String(url).replace(SITE, "").replace(/^https?:\/\/[^/]+/, "");
  return p.split(/[\/\-_]+/).filter(function(w){ return w && w.length > 2; });
}

async function pageList(){
  var xml = await get(SITE + "/sitemap.xml", 12000);
  var urls = [];
  if(xml){
    var re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi, m;
    while((m = re.exec(xml)) !== null){ urls.push(decode(m[1]).trim()); }
  }
  if(!urls.length){ urls = [SITE + "/"]; }
  var seen = {};
  return urls.filter(function(u){
    if(!/^https:\/\/(www\.)?soulforgedstudio\.com\//i.test(u)){ return false; }
    for(var i = 0; i < SKIP.length; i++){ if(SKIP[i].test(u)){ return false; } }
    var k = u.replace(/\/$/, "").toLowerCase();
    if(seen[k]){ return false; }
    seen[k] = true;
    return true;
  }).slice(0, MAX_PAGES);
}

/* read the whole site and file it. Returns a short summary, never the text. */
async function refresh(){
  var urls = await pageList();
  var pages = [], chunks = [];
  for(var i = 0; i < urls.length; i += 5){
    var batch = urls.slice(i, i + 5);
    var got = await Promise.all(batch.map(function(u){ return get(u, 9000); }));
    got.forEach(function(html, j){
      if(!html){ return; }
      var u = batch[j];
      var p = pageText(html);
      if(!p.text || p.text.length < 20){ return; }
      var name = (p.title || u).replace(/\s*[\u2014\u2013|-]\s*Soul Forged Studios.*$/i, "").trim() || u;
      var body = (p.desc ? p.desc + "\n" : "") + p.text.slice(0, 12000);
      var parts = chunkText(body, CHUNK);
      pages.push({ url: u, title: name, chars: body.length, chunks: parts.length });
      parts.forEach(function(t, k){
        chunks.push({
          id: "site-" + slugWords(u).join("-").slice(0, 60) + "-" + k,
          scope: "site",
          title: "The website, " + name + (parts.length > 1 ? " (" + (k + 1) + " of " + parts.length + ")" : ""),
          text: t,
          boost: [name].concat(slugWords(u)),
          url: u
        });
      });
    });
  }
  if(!chunks.length){ return { ok: false, pages: 0, chunks: 0, detail: "nothing could be read" }; }
  var meta = { at: new Date().toISOString(), pages: pages };
  await redis(["SET", KNOW_KEY, JSON.stringify(chunks)]);
  await redis(["SET", META_KEY, JSON.stringify(meta)]);
  return { ok: true, pages: pages.length, chunks: chunks.length };
}

async function meta(){
  var raw = await redis(["GET", META_KEY]);
  if(!raw){ return null; }
  try { return JSON.parse(raw); } catch(e){ return null; }
}

/* true when it has been more than a day, or never */
async function due(){
  var m = await meta();
  if(!m || !m.at){ return true; }
  return Date.now() - Date.parse(m.at) > 24 * 3600000;
}

module.exports = { refresh: refresh, meta: meta, due: due, pageText: pageText, pageList: pageList, chunkText: chunkText, KNOW_KEY: KNOW_KEY };
