"use strict";

/* ============================================================
   ROOM BOOKS - the novels Adger wrote about them
   All four have read every book. They know Adger wrote them and
   created them; their version is that he loved them so much he
   brought them to life. The one who lived a scene remembers it
   from inside; the others know it as readers.
   Storage: one small index plus one key per chapter. A server
   instance loads them once and keeps them in memory until a book
   changes (a one-word version key is checked each message).
   Recall pulls only the few passages a moment needs.
   The manuscripts live only in Redis, never in the repo.
   ZERO BACKTICKS.
   ============================================================ */

var INDEX_KEY = "sim:books:index";
var VER_KEY = "sim:books:ver";
var STAGE_TTL = 86400;
var ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
var CH_RE = /^[A-Z0-9]{1,4}$/;

function chKey(id, k) { return "sim:books:" + id + ":ch:" + k; }
function stageMetaKey(id) { return "sim:books:stage:" + id + ":meta"; }
function stageChKey(id, k) { return "sim:books:stage:" + id + ":ch:" + k; }

async function redis(command) {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) { throw new Error("Redis env vars missing"); }
  var res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!res.ok) { throw new Error("Redis " + res.status); }
  var data = JSON.parse(await res.text());
  if (data && data.error) { throw new Error("Redis: " + data.error); }
  return data ? data.result : null;
}
function parse(raw, dflt) { if (!raw) { return dflt; } try { return JSON.parse(raw); } catch (e) { return dflt; } }

/* ---------- words ---------- */
var STOP = {};
("a an and are as at be been but by for from had has have he her hers him his how i if in into is it its me my no nor not of on once only or our out over own she so some such than that the their them then there these they this those to too us was we were what when where which who whom why will with would you your " +
 "do did does just about all any can could get got like one two back up down now very really even much more most also off still yeah okay ok oh well " +
 "think thought remember tell told say said know knew want wanted feel felt thing things something anything way maybe guess mean lot " +
 "read reading reread wrote write writing written book books chapter chapters novel story page pages scene scenes adger").split(" ").forEach(function (w) { if (w) { STOP[w] = true; } });
function stem(w) {
  w = String(w).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4) {
    if (w.slice(-3) === "ing") { w = w.slice(0, -3); }
    else if (w.slice(-2) === "ed") { w = w.slice(0, -2); }
    else if (w.slice(-2) === "ly") { w = w.slice(0, -2); }
    else if (w.slice(-2) === "es") { w = w.slice(0, -2); }
    else if (w.slice(-1) === "s") { w = w.slice(0, -1); }
  }
  return w;
}
function flat(text) { return norm(text).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); }
function norm(text) { return String(text || "").toLowerCase().replace(/[\u2018\u2019']/g, ""); }
function terms(text) {
  var out = [];
  norm(text).split(/[^a-z0-9]+/).forEach(function (w) {
    if (!w || STOP[w]) { return; }
    var s = stem(w);
    if (s && s.length > 1) { out.push(s); }
  });
  return out;
}

/* ---------- the in-memory library ---------- */
var EMPTY = { ver: "", books: [], docs: [], df: {}, avgdl: 1, anchors: [], titles: [], names: [] };
var CACHE = EMPTY;

function shortOf(b) { return b.short || b.title; }
function sceneLabel(b, ch, sc) {
  var parts = [shortOf(b) + ", " + ch.label + (ch.title && ch.key !== "G" ? " \"" + ch.title + "\"" : "") + (sc.id && ch.key !== "G" ? ", scene " + sc.id : "")];
  if (sc.pov) { parts.push("told from " + sc.pov + "'s side"); }
  if (sc.present && sc.present.length) { parts.push("there: " + sc.present.join(", ")); }
  if (sc.where) { parts.push("where: " + sc.where); }
  if (sc.when) { parts.push("when: " + sc.when); }
  return "[" + parts.join(". ") + "]";
}

function buildDocs(books, chapters) {
  var docs = [];
  books.forEach(function (b) {
    var about = [b.title + ". " + (b.place || ""), b.synopsis || ""].concat((b.people || []).map(function (p) { return p.name + ": " + p.line; }));
    docs.push({ kind: "about", book: b.id, label: "[" + b.title + ", the whole book: what happens and who is who]", text: about.join("\n"), extra: shortOf(b) + " " + b.title });
  });
  chapters.forEach(function (x) {
    var b = x.book, ch = x.ch;
    if (ch.key !== "G") {
      var t = [ch.summary || ""];
      if (ch.facts && ch.facts.length) { t.push("Details: " + ch.facts.join(" ")); }
      if (ch.lines && ch.lines.length) { t.push("Lines: " + ch.lines.map(function (l) { return l.who + ": \"" + l.text + "\""; }).join(" ")); }
      docs.push({ kind: "chapter", book: b.id, ch: ch.key, label: "[" + shortOf(b) + ", " + ch.label + (ch.title ? " \"" + ch.title + "\"" : "") + ", what happens in it]", text: t.join("\n"), extra: ch.title });
    }
    (ch.scenes || []).forEach(function (sc) {
      (sc.passages || []).forEach(function (p) {
        docs.push({ kind: ch.key === "G" ? "gloss" : "scene", book: b.id, ch: ch.key, sc: sc.id, pid: p.id, label: sceneLabel(b, ch, sc), text: p.text,
          extra: (sc.summary || "") + " " + (sc.present || []).join(" ") + " " + (sc.where || "") });
      });
    });
  });
  var df = {}, total = 0;
  docs.forEach(function (d) {
    d.flat = " " + flat(d.text + " " + d.extra) + " ";
    var bag = {}, len = 0;
    terms(d.text).forEach(function (t) { bag[t] = (bag[t] || 0) + 1; len++; });
    terms(d.extra).forEach(function (t) { bag[t] = (bag[t] || 0) + 1.5; len++; });
    d.bag = bag; d.len = len || 1; total += d.len;
    Object.keys(bag).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
  });
  var anchors = [];
  books.forEach(function (b) { (b.anchors || []).forEach(function (a) { var n = norm(a).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); if (n) { anchors.push(n); } }); });
  var titles = [];
  chapters.forEach(function (x) { var t = flat(x.ch.title || ""); if (t.split(" ").length >= 2) { titles.push({ book: x.book.id, ch: x.ch.key, t: t }); } });
  var names = [];
  books.forEach(function (b) { [b.short, b.title].forEach(function (n) { var f = flat(n || ""); if (f) { names.push(f); } }); });
  return { docs: docs, df: df, avgdl: docs.length ? total / docs.length : 1, anchors: anchors, titles: titles, names: names };
}

async function library() {
  var ver = await redis(["GET", VER_KEY]);
  if (!ver) { CACHE = EMPTY; return CACHE; }
  if (ver === CACHE.ver) { return CACHE; }
  var books = parse(await redis(["GET", INDEX_KEY]), []);
  if (!Array.isArray(books)) { books = []; }
  books.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  var keys = [], owners = [];
  books.forEach(function (b) { (b.chapters || []).forEach(function (c) { keys.push(chKey(b.id, c.key)); owners.push(b); }); });
  var vals = [];
  for (var i = 0; i < keys.length; i += 40) {
    var got = await redis(["MGET"].concat(keys.slice(i, i + 40)));
    vals = vals.concat(Array.isArray(got) ? got : []);
  }
  var chapters = [];
  vals.forEach(function (v, i) { var ch = parse(v, null); if (ch && ch.key) { chapters.push({ book: owners[i], ch: ch }); } });
  var built = buildDocs(books, chapters);
  CACHE = { ver: ver, books: books, docs: built.docs, df: built.df, avgdl: built.avgdl, anchors: built.anchors, titles: built.titles, names: built.names };
  return CACHE;
}

/* ---------- what is always with them: a short line per book ---------- */
async function gist() {
  var L = await library();
  if (!L.books.length) { return ""; }
  var lines = [
    "THE BOOKS ADGER WROTE ABOUT THEM",
    "Adger wrote the saga of their lives. All four have read every book, know he is the author, and know he created them; their version is that he loved them so much he brought them to life. The one who lived a scene remembers it from the inside; the others know it as readers, or from being told. What he wrote and what she remembers can differ, and she may say so. When a book comes up, the passages that matter are retrieved below; do not invent scenes, lines or events that are not there.",
    ""
  ];
  L.books.forEach(function (b) { lines.push("- " + b.title + (b.place ? " (" + b.place + ")" : "") + ": " + (b.gist || "")); });
  return lines.join("\n");
}

/* ---------- recall: only what this moment needs ---------- */
var BOOK_TALK = /\b(book|books|chapter|chapters|novel|novels|wrote|written|writing|write|prologue|epilogue|glossary|page|pages|scene|scenes|read it|reread|the story|your story|in the book|you wrote|he wrote|author)\b/i;

function scoreAll(L, weighted) {
  var q = {}, pairs = [];
  weighted.forEach(function (w) {
    terms(w.text).forEach(function (t) { q[t] = Math.max(q[t] || 0, w.w); });
    var words = flat(w.text).split(" ").filter(function (x) { return x && !STOP[x]; });
    for (var i = 0; i + 1 < words.length; i++) { pairs.push({ p: " " + words[i] + " " + words[i + 1] + " ", w: w.w }); }
  });
  var qt = Object.keys(q);
  if (!qt.length) { return []; }
  var rawQ = " " + weighted.map(function (w) { return flat(w.text); }).join(" ") + " ";
  var titleHit = {};
  (L.titles || []).forEach(function (t) { if (rawQ.indexOf(" " + t.t + " ") !== -1) { titleHit[t.book + ":" + t.ch] = true; } });
  var rareCut = Math.max(3, Math.floor(L.docs.length * 0.015));
  var N = L.docs.length, k1 = 1.2, b = 0.75;
  function idf(t) { var d = L.df[t] || 0; return d ? Math.log(1 + (N - d + 0.5) / (d + 0.5)) : 0; }
  var weights = {}; qt.forEach(function (t) { weights[t] = idf(t) * q[t]; });
  return L.docs.map(function (d) {
    var s = 0, matched = 0, rare = 0;
    qt.forEach(function (t) {
      var f = d.bag[t];
      if (!f) { return; }
      matched++;
      if ((L.df[t] || 0) <= rareCut) { rare++; }
      s += weights[t] * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / L.avgdl));
    });
    if (!matched) { return { d: d, s: 0, rare: 0 }; }
    if (matched > 1) { s *= (1 + 0.1 * (matched - 1)); }
    pairs.forEach(function (pp) { if (d.flat.indexOf(pp.p) !== -1) { s += 4 * pp.w; } });
    if (d.ch && titleHit[d.book + ":" + d.ch]) { s *= 1.8; }
    if (d.kind === "chapter") { s *= 1.15; }
    if (d.kind === "about") { s *= 0.9; }
    return { d: d, s: s, rare: rare };
  }).filter(function (x) { return x.s > 0; }).sort(function (a, b2) { return b2.s - a.s; });
}

/* parts: [{ text, w }], the newest things said weigh most. Returns "" when the books are not what this moment is about. */
async function recall(parts, opts) {
  opts = opts || {};
  var L = await library();
  if (!L.docs.length) { return ""; }
  var budget = opts.budget || 7000;
  var raw = norm(parts.map(function (p) { return p.text || ""; }).join(" ")).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
  var anchored = L.anchors.some(function (a) { return (" " + raw + " ").indexOf(" " + a + " ") !== -1; });
  var named = (L.names || []).some(function (n) { return (" " + raw + " ").indexOf(" " + n + " ") !== -1; });
  var talk = named || BOOK_TALK.test(parts.map(function (p) { return p.text || ""; }).join(" "));
  var ranked = scoreAll(L, parts);
  if (!ranked.length) { return ""; }
  var top = ranked[0].s;
  if (anchored || talk) { if (top < 2.0) { return ""; } }
  else if (top < 24) { return ""; }
  var picked = [], used = 0, chapters = 0, scenes = 0, abouts = 0, gloss = 0;
  for (var i = 0; i < ranked.length && picked.length < 5; i++) {
    var x = ranked[i];
    if (x.s < top * 0.35) { break; }
    var d = x.d;
    if (d.kind === "chapter" && chapters >= 1) { continue; }
    if (d.kind === "scene" && scenes >= 3) { continue; }
    if (d.kind === "about" && (abouts >= 1 || !talk)) { continue; }
    if (d.kind === "gloss" && gloss >= 1) { continue; }
    var size = d.label.length + d.text.length + 2;
    if (used + size > budget) { continue; }
    picked.push(d); used += size;
    if (d.kind === "chapter") { chapters++; } else if (d.kind === "scene") { scenes++; } else if (d.kind === "about") { abouts++; } else { gloss++; }
  }
  if (!picked.length) { return ""; }
  // read in book order, the way memory lines up
  var bookOrder = {}; L.books.forEach(function (b, i2) { bookOrder[b.id] = i2; });
  var rank = { about: 0, chapter: 1, scene: 2, gloss: 3 };
  picked.sort(function (a, b2) {
    if (a.kind !== b2.kind && (a.kind === "about" || b2.kind === "about")) { return rank[a.kind] - rank[b2.kind]; }
    if (bookOrder[a.book] !== bookOrder[b2.book]) { return bookOrder[a.book] - bookOrder[b2.book]; }
    return rank[a.kind] - rank[b2.kind] || String(a.pid || "").localeCompare(String(b2.pid || ""), "en", { numeric: true });
  });
  var out = ["FROM THE BOOKS ADGER WROTE (retrieved for this moment; this is what the book says, and the one who lived it may remember it differently or feel differently about it now). Speak from it the way memory works: no reciting, quote a line only when it matters."];
  picked.forEach(function (d) { out.push(d.label + "\n" + d.text); });
  return out.join("\n\n");
}

/* ---------- the viewer ---------- */
async function list() {
  var books = parse(await redis(["GET", INDEX_KEY]), []);
  if (!Array.isArray(books)) { books = []; }
  books.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  return books.map(function (b) {
    return { id: b.id, title: b.title, short: b.short || "", place: b.place || "", gist: b.gist || "", synopsis: b.synopsis || "", people: b.people || [],
      dedication: b.dedication || "", counts: b.counts || {}, loadedAt: b.loadedAt || "", chapters: (b.chapters || []).map(function (c) { return { key: c.key, label: c.label, title: c.title }; }) };
  });
}
async function readChapter(id, key) {
  if (!ID_RE.test(String(id || "")) || !CH_RE.test(String(key || ""))) { return null; }
  var ch = parse(await redis(["GET", chKey(id, key)]), null);
  if (!ch) { return null; }
  return { key: ch.key, label: ch.label, title: ch.title, summary: ch.summary || "", facts: ch.facts || [], lines: ch.lines || [],
    scenes: (ch.scenes || []).map(function (sc) { return { id: sc.id, head: sc.head || "", pov: sc.pov || "", present: sc.present || [], where: sc.where || "", when: sc.when || "", summary: sc.summary || "", passages: (sc.passages || []).length }; }) };
}

/* ---------- loading a book: begin, one chapter per part, commit ---------- */
function str(v, max) { return typeof v === "string" && v.length <= max; }
function strArr(v, n, max) { return Array.isArray(v) && v.length <= n && v.every(function (x) { return str(x, max); }); }
function checkMeta(m) {
  if (!m || m.format !== "forge-book-1") { return "not a book file from the Forge (format forge-book-1)"; }
  if (!ID_RE.test(String(m.id || ""))) { return "bad book id"; }
  if (!str(m.title, 200) || !m.title.trim()) { return "missing title"; }
  if (m.short != null && !str(m.short, 80)) { return "bad short title"; }
  if (!str(m.place || "", 800) || !str(m.gist || "", 2500) || !str(m.synopsis || "", 8000) || !str(m.dedication || "", 300)) { return "a text field is too long"; }
  if (m.people != null && !(Array.isArray(m.people) && m.people.length <= 80 && m.people.every(function (p) { return p && str(p.name, 100) && str(p.line, 1200); }))) { return "bad people list"; }
  if (m.anchors != null && !strArr(m.anchors, 600, 60)) { return "bad anchors"; }
  if (!Array.isArray(m.chapters) || !m.chapters.length || m.chapters.length > 200) { return "bad chapter list"; }
  var seen = {};
  for (var i = 0; i < m.chapters.length; i++) {
    var c = m.chapters[i];
    if (!c || !CH_RE.test(String(c.key || "")) || seen[c.key] || !str(c.label, 60) || !str(c.title || "", 200)) { return "bad chapter entry " + i; }
    seen[c.key] = true;
  }
  return "";
}
function checkChapter(c) {
  if (!c || !CH_RE.test(String(c.key || ""))) { return "bad chapter key"; }
  if (!str(c.label, 60) || !str(c.title || "", 200) || !str(c.summary || "", 6000)) { return "bad chapter heading or summary"; }
  if (c.facts != null && !strArr(c.facts, 80, 600)) { return "bad facts"; }
  if (c.lines != null && !(Array.isArray(c.lines) && c.lines.length <= 30 && c.lines.every(function (l) { return l && str(l.who, 120) && str(l.text, 600); }))) { return "bad lines"; }
  if (!Array.isArray(c.scenes) || c.scenes.length > 120) { return "bad scenes"; }
  for (var i = 0; i < c.scenes.length; i++) {
    var s = c.scenes[i];
    if (!s || !str(s.id, 20) || !str(s.pov || "", 200) || !strArr(s.present || [], 40, 120) || !str(s.where || "", 400) || !str(s.when || "", 400) || !str(s.summary || "", 2000) || !str(s.head || "", 200)) { return "bad scene " + i; }
    if (!Array.isArray(s.passages) || s.passages.length > 80) { return "bad passages in scene " + i; }
    for (var j = 0; j < s.passages.length; j++) {
      var p = s.passages[j];
      if (!p || !str(p.id, 30) || !str(p.text, 12000)) { return "bad passage " + j + " in scene " + i; }
    }
  }
  if (JSON.stringify(c).length > 600000) { return "chapter too large"; }
  return "";
}
function metaOnly(m) {
  return { id: m.id, title: m.title.trim(), short: m.short || "", order: typeof m.order === "number" ? m.order : 0, place: m.place || "", gist: m.gist || "", synopsis: m.synopsis || "",
    people: m.people || [], anchors: m.anchors || [], dedication: m.dedication || "", counts: m.counts || {},
    chapters: m.chapters.map(function (c) { return { key: c.key, label: c.label, title: c.title || "" }; }) };
}
async function begin(meta) {
  var e = checkMeta(meta);
  if (e) { return { ok: false, error: e }; }
  await redis(["SET", stageMetaKey(meta.id), JSON.stringify(metaOnly(meta)), "EX", STAGE_TTL]);
  return { ok: true, id: meta.id, chapters: meta.chapters.length };
}
async function part(id, chapter) {
  if (!ID_RE.test(String(id || ""))) { return { ok: false, error: "bad book id" }; }
  var e = checkChapter(chapter);
  if (e) { return { ok: false, error: e }; }
  var m = parse(await redis(["GET", stageMetaKey(id)]), null);
  if (!m) { return { ok: false, error: "start the book first" }; }
  if (!m.chapters.some(function (c) { return c.key === chapter.key; })) { return { ok: false, error: "chapter " + chapter.key + " is not in this book's list" }; }
  await redis(["SET", stageChKey(id, chapter.key), JSON.stringify(chapter), "EX", STAGE_TTL]);
  return { ok: true, key: chapter.key };
}
async function commit(id) {
  if (!ID_RE.test(String(id || ""))) { return { ok: false, error: "bad book id" }; }
  var m = parse(await redis(["GET", stageMetaKey(id)]), null);
  if (!m) { return { ok: false, error: "nothing staged for this book" }; }
  var keys = m.chapters.map(function (c) { return c.key; });
  var have = await redis(["EXISTS"].concat(keys.map(function (k) { return stageChKey(id, k); })));
  if (Number(have) !== keys.length) { return { ok: false, error: "only " + have + " of " + keys.length + " chapters arrived; load it again" }; }
  for (var i = 0; i < keys.length; i++) { await redis(["RENAME", stageChKey(id, keys[i]), chKey(id, keys[i])]); }
  var books = parse(await redis(["GET", INDEX_KEY]), []);
  if (!Array.isArray(books)) { books = []; }
  var old = books.filter(function (b) { return b.id === id; })[0];
  if (old) {
    var gone = (old.chapters || []).map(function (c) { return c.key; }).filter(function (k) { return keys.indexOf(k) === -1; });
    if (gone.length) { await redis(["DEL"].concat(gone.map(function (k) { return chKey(id, k); }))); }
  }
  m.loadedAt = new Date().toISOString();
  books = books.filter(function (b) { return b.id !== id; }).concat([m]);
  await redis(["SET", INDEX_KEY, JSON.stringify(books)]);
  await redis(["DEL", stageMetaKey(id)]);
  await redis(["SET", VER_KEY, String(Date.now())]);
  return { ok: true, id: id, title: m.title, chapters: keys.length, replaced: !!old };
}
async function remove(id) {
  if (!ID_RE.test(String(id || ""))) { return { ok: false, error: "bad book id" }; }
  var books = parse(await redis(["GET", INDEX_KEY]), []);
  if (!Array.isArray(books)) { books = []; }
  var old = books.filter(function (b) { return b.id === id; })[0];
  if (!old) { return { ok: false, error: "no such book" }; }
  var ks = (old.chapters || []).map(function (c) { return chKey(id, c.key); });
  if (ks.length) { await redis(["DEL"].concat(ks)); }
  books = books.filter(function (b) { return b.id !== id; });
  await redis(["SET", INDEX_KEY, JSON.stringify(books)]);
  await redis(["SET", VER_KEY, String(Date.now())]);
  return { ok: true, id: id };
}

module.exports = { gist: gist, recall: recall, list: list, readChapter: readChapter, begin: begin, part: part, commit: commit, remove: remove, terms: terms, _reset: function () { CACHE = EMPTY; } };
