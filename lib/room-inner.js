"use strict";

/* ============================================================
   ROOM INNER - what goes on inside them, carried between days
   - a mood each, set by what happens in the room, that lasts
     and fades; on a quiet day, her own ordinary weather
   - what each of them wants this week, and how it went
   - where each pair of them stands with each other this week
   - how each is slowly changing, week over week
   The room reads it every turn. Remember and a weekly pass on
   the tick write it. None of it is Adger's to set.
   ZERO BACKTICKS. ASCII only.
   ============================================================ */

var KEY = "sim:inner";
var LOCK = "sim:inner:lock";
var ROOM_TZ = process.env.ROOM_TZ || "Europe/Athens";
var MODEL = "claude-sonnet-4-6";
var WIVES = ["selene", "nysera", "mirael", "talia"];
var NAME = { selene: "Selene", nysera: "Nysera", mirael: "Mirael", talia: "Talia" };
var TONES = ["close", "easy", "friction", "tense"];
var STATUSES = ["open", "done", "dropped", "stalled"];
var STRENGTH = { strong: 3, clear: 2, light: 1 };

function pairKey(a, b){ return [String(a), String(b)].sort().join("|"); }
var PAIRS = (function(){
  var out = [];
  for(var i = 0; i < WIVES.length; i++){
    for(var j = i + 1; j < WIVES.length; j++){ out.push(pairKey(WIVES[i], WIVES[j])); }
  }
  return out;
})();
/* the two names of a pair in house order, for reading */
function pairNames(k){
  var ab = k.split("|");
  ab.sort(function(x, y){ return WIVES.indexOf(x) - WIVES.indexOf(y); });
  return ab;
}

/* ---------- redis ---------- */

function configured(){
  return !!((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN));
}
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

/* ---------- the record ---------- */

function clip(s, n){
  return String(s == null ? "" : s)
    .replace(/[ \t]*[\u2013\u2014][ \t]*/g, ", ")
    .replace(/\*/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim().slice(0, n);
}
function isoOk(s){ return typeof s === "string" && !isNaN(Date.parse(s)); }
function empty(){
  return { v: 1, moods: {}, moodLog: [], wants: { week: "", items: {} }, standings: {}, growth: {}, history: [], weeklyAt: "", weeklyTriedAt: "" };
}
function cleanWant(x){
  if(!x || typeof x !== "object"){ return null; }
  var text = clip(x.text, 160);
  if(!text){ return null; }
  return { text: text, status: STATUSES.indexOf(x.status) !== -1 ? x.status : "open", note: clip(x.note, 140), at: isoOk(x.at) ? x.at : "" };
}
function clean(o){
  var d = empty();
  if(!o || typeof o !== "object"){ return d; }
  var m = (o.moods && typeof o.moods === "object") ? o.moods : {};
  WIVES.forEach(function(w){
    var x = m[w];
    if(x && typeof x.text === "string" && x.text && isoOk(x.at)){
      d.moods[w] = { text: clip(x.text, 120), why: clip(x.why, 160), w: [1, 2, 3].indexOf(x.w) !== -1 ? x.w : 2, at: x.at, src: clip(x.src, 20) || "room", tag: tagOf(x.tag || x.text) };
    }
  });
  if(Array.isArray(o.moodLog)){
    d.moodLog = o.moodLog.filter(function(x){ return x && WIVES.indexOf(x.who) !== -1 && x.text && isoOk(x.at); }).slice(0, 16)
      .map(function(x){ return { who: x.who, text: clip(x.text, 120), why: clip(x.why, 160), w: [1, 2, 3].indexOf(x.w) !== -1 ? x.w : 2, at: x.at }; });
  }
  if(o.wants && typeof o.wants === "object"){
    d.wants.week = /^\d{4}-\d{2}-\d{2}$/.test(String(o.wants.week || "")) ? o.wants.week : "";
    var it = (o.wants.items && typeof o.wants.items === "object") ? o.wants.items : {};
    WIVES.forEach(function(w){
      if(Array.isArray(it[w])){ d.wants.items[w] = it[w].map(cleanWant).filter(Boolean).slice(0, 5); }
    });
  }
  var st = (o.standings && typeof o.standings === "object") ? o.standings : {};
  PAIRS.forEach(function(k){
    var x = st[k];
    if(x && typeof x.text === "string" && x.text){
      d.standings[k] = { text: clip(x.text, 220), tone: TONES.indexOf(x.tone) !== -1 ? x.tone : "easy", at: isoOk(x.at) ? x.at : "" };
    }
  });
  var g = (o.growth && typeof o.growth === "object") ? o.growth : {};
  WIVES.forEach(function(w){
    if(Array.isArray(g[w])){
      d.growth[w] = g[w].filter(function(x){ return x && x.text; }).slice(0, 4)
        .map(function(x){ return { text: clip(x.text, 200), since: /^\d{4}-\d{2}-\d{2}$/.test(String(x.since || "")) ? x.since : "" }; });
    }
  });
  if(Array.isArray(o.history)){ d.history = o.history.slice(0, 4); }
  d.weeklyAt = isoOk(o.weeklyAt) ? o.weeklyAt : "";
  d.weeklyTriedAt = isoOk(o.weeklyTriedAt) ? o.weeklyTriedAt : "";
  return d;
}
/* for reading: anything wrong just means an empty inner life today */
async function load(){
  try {
    var raw = await redis(["GET", KEY]);
    if(raw){ return clean(JSON.parse(raw)); }
  } catch(e){ /* fall through */ }
  return empty();
}
/* for writing: a failed read must never become an overwrite */
async function loadStrict(){
  var raw = await redis(["GET", KEY]);
  if(!raw){ return empty(); }
  return clean(JSON.parse(raw));
}
async function save(inner){
  var r = await redis(["SET", KEY, JSON.stringify(inner)]);
  if(r !== "OK" && r !== null){ throw new Error("could not save"); }
  return inner;
}
/* read fresh, change, write: every writer goes through here so none undoes another */
async function update(fn){
  var inner = await loadStrict();
  fn(inner);
  return save(inner);
}

/* ---------- the room clock ---------- */

var FMT = null;
function clock(date){
  var o = {};
  try {
    if(!FMT){
      FMT = new Intl.DateTimeFormat("en-GB", { timeZone: ROOM_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
    }
    FMT.formatToParts(date).forEach(function(p){ o[p.type] = p.value; });
  } catch(e){
    var d = new Date(date.getTime());
    o = { year: String(d.getUTCFullYear()), month: ("0" + (d.getUTCMonth() + 1)).slice(-2), day: ("0" + d.getUTCDate()).slice(-2), hour: String(d.getUTCHours()), minute: String(d.getUTCMinutes()), weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()] };
  }
  return {
    key: o.year + "-" + o.month + "-" + o.day,
    dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(o.weekday),
    hour: (parseInt(o.hour, 10) % 24) + parseInt(o.minute, 10) / 60,
    weekday: o.weekday
  };
}
function addDays(key, n){
  var d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* their week starts on Monday, room time */
function weekOf(date){
  var c = clock(date);
  return addDays(c.key, -((c.dow + 6) % 7));
}
function dayName(key){
  var d = new Date(key + "T12:00:00Z");
  var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return days[d.getUTCDay()] + " " + d.getUTCDate() + " " + months[d.getUTCMonth()];
}
function ago(h){
  if(h < 1){ return "within the hour"; }
  if(h < 2){ return "about an hour ago"; }
  if(h < 20){ return Math.round(h) + " hours ago"; }
  if(h < 36){ return "yesterday"; }
  return Math.round(h / 24) + " days ago";
}

/* ---------- dice: the same answer all day, different every day ---------- */

function dice(seed){
  var h = 2166136261;
  for(var i = 0; i < seed.length; i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function pick(seed, options){
  var r = dice(seed), acc = 0, tot = 0, i;
  for(i = 0; i < options.length; i++){ tot += options[i][0]; }
  for(i = 0; i < options.length; i++){ acc += options[i][0] / tot; if(r < acc){ return options[i]; } }
  return options[options.length - 1];
}

/* ---------- moods ---------- */

/* her ordinary weather, on a day when nothing in particular has happened to her */
var TEMPER = {
  selene: [
    [4, "loose and wicked, looking for trouble to start", "wicked"],
    [3, "restless, wants to be doing something with her hands", "restless"],
    [3, "easy and lazy, in no hurry about anything", "lazy"],
    [2, "short-fused until she has had her coffee", "short-fused"],
    [1, "a little hungover and blaming Mirael for it", "hungover"],
    [1, "quieter than usual, something old under the jokes today", "quiet"]
  ],
  nysera: [
    [4, "focused and sharp, the day already organized in her head", "focused"],
    [3, "calm and dry, in a good humor she will not admit to", "dry"],
    [2, "stretched thin, too much on her desk", "stretched thin"],
    [2, "letting herself have a slow morning, for once", "slow"],
    [1, "tired in a way she will not mention", "tired"]
  ],
  mirael: [
    [4, "warm and busy, three things going at once", "busy"],
    [3, "in a needling mood, poking at whoever is nearest", "needling"],
    [2, "quiet and noticing, more listening than talking", "watchful"],
    [2, "pleased with herself over something she fixed", "pleased"],
    [1, "restless for something that is hers alone, not the job", "restless"]
  ],
  talia: [
    [4, "quiet and content, Sera close by", "content"],
    [3, "dry and amused by everyone today", "amused"],
    [2, "tired after a bad night with Sera", "tired"],
    [2, "far away in the music, drumming on every surface", "far away"],
    [1, "wanting an hour alone and not saying so", "wants quiet"]
  ]
};
/* something big on the calendar within two days colors the day */
var KEYED = {
  selene: "wired about {t}, and pretending she is not",
  nysera: "quietly running the plan for {t} in her head",
  mirael: "three lists deep into {t}",
  talia: "already hearing {t} in her head, the tempo mostly"
};
var KEYED_TAG = { selene: "wired", nysera: "planning", mirael: "on it", talia: "in the music" };
/* the short word on her portrait: what she led with, or the first real word */
var FILLER = { a: 1, an: 1, the: 1, still: 1, very: 1, so: 1, quite: 1, bit: 1, little: 1, just: 1, feeling: 1, is: 1, she: 1, all: 1, kind: 1, of: 1, somewhat: 1, rather: 1, more: 1, in: 1,
  quietly: 1, really: 1, pretty: 1, too: 1, slightly: 1, mildly: 1, deeply: 1, genuinely: 1, properly: 1, totally: 1, completely: 1, fairly: 1, suddenly: 1, oddly: 1, strangely: 1 };
function tagOf(text){
  var t = clip(text, 120);
  if(!t){ return ""; }
  var clause = t.split(/[,;:.(]/)[0].trim();
  var words = clause.split(/\s+/).filter(Boolean);
  if(words.length && words.length <= 3 && clause.length <= 20){ return clause; }
  for(var i = 0; i < words.length; i++){
    var w = words[i].toLowerCase().replace(/[^a-z'-]/g, "");
    if(w && !FILLER[w]){ return words[i].replace(/[^A-Za-z'-]/g, ""); }
  }
  return (words[0] || "").slice(0, 20);
}
function soonEvent(settings, key){
  var list = (settings && Array.isArray(settings.events)) ? settings.events : [];
  var lim = addDays(key, 2);
  for(var i = 0; i < list.length; i++){
    var e = list[i];
    if(!e || !e.startDate){ continue; }
    if(e.startDate <= lim && (e.endDate || e.startDate) >= key){ return e; }
  }
  return null;
}
function seedMood(who, now, settings){
  var c = clock(now);
  var ev = soonEvent(settings, c.key);
  if(ev && dice("keyed|" + who + "|" + c.key) < 0.55){
    var t = clip(ev.title, 80) || "the event";
    return { text: KEYED[who].replace("{t}", t), tag: KEYED_TAG[who], why: t + (ev.startDate <= c.key ? " is on now" : " is coming up"), level: "day", src: "day", hours: 0, at: "" };
  }
  var opt = pick("mood|" + who + "|" + c.key, TEMPER[who]);
  return { text: opt[1], tag: opt[2], why: "", level: "day", src: "day", hours: 0, at: "" };
}
/* how she is right now: a mood the room left her with, until it fades; otherwise her day */
function moodNow(inner, who, now, settings){
  var m = inner && inner.moods ? inner.moods[who] : null;
  if(m && m.text && m.at){
    var h = Math.max(0, (now.getTime() - Date.parse(m.at)) / 3600000);
    var level = "";
    if(m.w >= 3){ level = h < 12 ? "strong" : (h < 36 ? "carrying over" : ""); }
    else if(m.w === 2){ level = h < 6 ? "clear" : (h < 16 ? "fading" : ""); }
    else { level = h < 4 ? "light" : ""; }
    if(level){ return { text: m.text, tag: m.tag || tagOf(m.text), why: m.why || "", level: level, src: m.src || "room", hours: h, at: m.at }; }
  }
  return seedMood(who, now, settings);
}
var LEVEL_WORDS = {
  strong: "still strong",
  "carrying over": "carried over, softer now but still there",
  clear: "clear",
  fading: "fading",
  light: "light"
};
function moodLine(who, mm){
  if(mm.src === "day"){
    return "- " + NAME[who] + ": " + mm.text + (mm.why ? " (" + mm.why + ")" : "") + ". Her ordinary weather today; nothing happened to cause it. A tint, not a plot.";
  }
  return "- " + NAME[who] + ": " + mm.text + (mm.why ? ", because " + mm.why : "") + " (" + (LEVEL_WORDS[mm.level] || mm.level) + ", from " + ago(mm.hours) + ")";
}
var MOOD_RULES = [
  "When something in this conversation really changes how one of the present women feels, in a way that will outlast the conversation, add a line on its own after the dialogue:",
  "MOOD: name | how she is now, leading with one plain feeling word and a comma (stung, spoiling for a fight) | why, a short phrase | strong or clear or light",
  "strong = it will still be with her tomorrow; clear = the rest of today; light = an hour or two. Only for a real shift: a fight, a hurt, a worry, good news, being moved, being let down, being delighted. Not every turn, never to decorate, never for a woman who is not present. One MOOD line per woman at most. The MOOD line is stripped before anything reaches the screen; it is not dialogue."
].join("\n");
/* for the moment: goes in the part of the prompt that changes every turn */
function moodBlock(inner, present, now, settings){
  if(!present || !present.length){ return ""; }
  var lines = [
    "HOW EACH OF THEM IS RIGHT NOW (carried in from her day. It colors how she talks, how much she says, and what she reaches for. Never announce it, report it, or name it; let it show. A strong mood outweighs small talk; a light one is only a tint. What happens here can change it, and one kind word does not undo a real hurt.)"
  ];
  present.forEach(function(w){ lines.push(moodLine(w, moodNow(inner, w, now, settings))); });
  lines.push("");
  lines.push(MOOD_RULES);
  return lines.join("\n");
}

/* MOOD: name | how she is | why | strength */
var MOOD_LINE = /^[ \t]*MOOD:[ \t]*(.*)$/gim;
function parseMood(text){
  var out = [];
  if(!text){ return out; }
  var src = String(text), m, seen = {};
  MOOD_LINE.lastIndex = 0;
  while((m = MOOD_LINE.exec(src)) !== null){
    var p = m[1].split("|");
    for(var i = 0; i < p.length; i++){ p[i] = p[i].trim(); }
    var who = (p[0] || "").toLowerCase();
    if(WIVES.indexOf(who) === -1 || seen[who]){ continue; }
    var t = clip(p[1], 120);
    if(!t){ continue; }
    var st = String(p[3] || "").toLowerCase();
    var w = STRENGTH[st] || (st.indexOf("strong") !== -1 ? 3 : (st.indexOf("light") !== -1 ? 1 : 2));
    seen[who] = true;
    out.push({ who: who, text: t, tag: tagOf(t), why: clip(p[2], 160), w: w });
  }
  return out;
}
function stripMood(text){
  if(!text){ return text; }
  return String(text).replace(MOOD_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}
function setMood(inner, x, now, src){
  var rec = { text: x.text, why: x.why || "", w: x.w || 2, at: now.toISOString(), src: src || "room", tag: x.tag || tagOf(x.text) };
  inner.moods[x.who] = rec;
  inner.moodLog.unshift({ who: x.who, text: rec.text, why: rec.why, w: rec.w, at: rec.at });
  inner.moodLog = inner.moodLog.slice(0, 16);
}
/* a mood the scene set, for women who were there */
async function applyMoods(list, present, now, src){
  var keep = (list || []).filter(function(x){ return x && present.indexOf(x.who) !== -1; });
  if(!keep.length){ return null; }
  return update(function(inner){ keep.forEach(function(x){ setMood(inner, x, now, src || "room"); }); });
}

/* ---------- the week ---------- */

function wantText(it){
  var s = it.text;
  if(it.status === "done"){ return s + " (done" + (it.note ? ": " + it.note : "") + ")"; }
  if(it.status === "dropped"){ return s + " (she let it go" + (it.note ? ": " + it.note : "") + ")"; }
  if(it.status === "stalled"){ return s + " (stuck" + (it.note ? ": " + it.note : "") + ")"; }
  return s + (it.note ? " (" + it.note + ")" : "");
}
function standingLine(inner, k, now){
  var s = inner.standings[k];
  if(!s || !s.text){ return ""; }
  var ab = pairNames(k);
  var line = "- " + NAME[ab[0]] + " and " + NAME[ab[1]] + ": " + s.text;
  var days = s.at ? (now.getTime() - Date.parse(s.at)) / 86400000 : 0;
  if((s.tone === "friction" || s.tone === "tense") && days > 4){
    line += " (that was " + Math.round(days) + " days ago; it may well have eased by now)";
  }
  return line;
}
/* for their memory: the week under the surface, for whoever is in the room */
function weekBlock(inner, present, now){
  if(!inner || !present || !present.length){ return ""; }
  var wants = [], stands = [], grow = [];
  present.forEach(function(w){
    var items = inner.wants.items[w] || [];
    if(items.length){ wants.push("- " + NAME[w] + ": " + items.map(wantText).join("; ")); }
    var g = inner.growth[w] || [];
    if(g.length){ grow.push("- " + NAME[w] + ": " + g.map(function(x){ return x.text; }).join("; ")); }
  });
  PAIRS.forEach(function(k){
    var ab = k.split("|");
    if(present.indexOf(ab[0]) === -1 && present.indexOf(ab[1]) === -1){ return; }
    var line = standingLine(inner, k, now);
    if(line){ stands.push(line); }
  });
  if(!wants.length && !stands.length && !grow.length){ return ""; }
  var out = ["", "", "THIS WEEK, UNDER THE SURFACE (each woman's own inner week. It shapes what she brings up, what she cares about today, and how she is with the others. Never recite it, list it, or announce it; it shows in what she does and chooses.)"];
  if(wants.length){ out.push("", "WHAT EACH WANTS THIS WEEK (hers, from her side; she may push for it, mention it, or quietly work at it, and it can pull against someone else's):"); out = out.concat(wants); }
  if(stands.length){ out.push("", "WHERE THEY STAND WITH EACH OTHER THIS WEEK (close is warm and easy; friction shows as needling, shortness, or a pointed quiet, and it does not vanish because Adger walked in; they are family of a thousand years, so it never turns cruel):"); out = out.concat(stands); }
  if(grow.length){ out.push("", "HOW EACH IS SLOWLY CHANGING (the long arc; it shows only in small choices, never in speeches, and it can slip back):"); out = out.concat(grow); }
  return out.join("\n");
}
/* for a text she sends: how she is, and what is on her mind this week */
function personNote(inner, who, now, settings){
  if(!inner || WIVES.indexOf(who) === -1){ return ""; }
  var lines = ["HOW " + NAME[who].toUpperCase() + " IS TODAY, INSIDE (let it shape why she texts and how, never spell it out):"];
  lines.push(moodLine(who, moodNow(inner, who, now, settings)));
  var items = (inner.wants.items[who] || []).filter(function(x){ return x.status === "open" || x.status === "stalled"; });
  if(items.length){ lines.push("What she wants this week: " + items.map(wantText).join("; ")); }
  PAIRS.forEach(function(k){
    if(k.split("|").indexOf(who) === -1){ return; }
    var line = standingLine(inner, k, now);
    if(line){ lines.push(line); }
  });
  return lines.join("\n");
}
/* for the notes they leave: all four */
function houseNote(inner, now, settings){
  if(!inner){ return ""; }
  var lines = ["HOW EACH OF THEM IS, INSIDE (let it shape who writes and what, never spell it out):"];
  WIVES.forEach(function(w){
    lines.push(moodLine(w, moodNow(inner, w, now, settings)));
    var items = (inner.wants.items[w] || []).filter(function(x){ return x.status === "open" || x.status === "stalled"; });
    if(items.length){ lines.push("  What " + NAME[w] + " wants this week: " + items.map(wantText).join("; ")); }
  });
  var st = PAIRS.map(function(k){ return standingLine(inner, k, now); }).filter(Boolean);
  if(st.length){ lines.push("Where they stand with each other:"); lines = lines.concat(st); }
  return lines.join("\n");
}

/* ---------- asking Sonnet for JSON ---------- */

async function askJSON(system, user, maxTokens){
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system, messages: [{ role: "user", content: user }] })
  });
  if(!r.ok){ throw new Error("upstream " + r.status); }
  var data = await r.json();
  var text = (data.content || []).filter(function(b){ return b.type === "text"; }).map(function(b){ return b.text; }).join("\n");
  var a = text.indexOf("{"), b = text.lastIndexOf("}");
  if(a === -1 || b <= a){ return null; }
  try {
    var o = JSON.parse(text.slice(a, b + 1));
    return (o && typeof o === "object") ? o : null;
  } catch(e){ return null; }
}

/* ---------- after a conversation: what it changed inside them ---------- */

function curatorSystem(present){
  var names = present.map(function(w){ return NAME[w]; }).join(", ");
  return [
    "You keep track of the inner weather of four women who live together: Selene, Nysera, Mirael and Talia. They are married to each other and to Adger, all five, and they run Soul Forged Studios and the band together. After a conversation in their home, you record what it changed inside the women who were there.",
    "You are given how each was feeling before, what each wanted this week (numbered), and where they stood with each other, then the NEW CONVERSATION. Lines are labelled by who spoke; unlabelled or Adger: lines are his.",
    "",
    "Rules:",
    "- Only these women were in the room: " + names + ". Say nothing about anyone else. Standings only for pairs where both were in the room.",
    "- MOODS: include a woman only if the conversation left her feeling something that will outlast it: hurt, worried, delighted, restless, tender, annoyed, proud, let down. Ordinary pleasant talk changes nothing; leave her out. strength: strong = it will still color tomorrow; clear = the rest of today; light = an hour or two.",
    "- WANTS: mark a want done if it happened, dropped if she let it go, stalled if something blocked it, by its number, with a short note. Add a new want only if she clearly started wanting something this week in this conversation, at most one each, in plain words from her side. Nothing about Adger's energy, the fold, or him leaving.",
    "- STANDINGS: only if something happened between two of the women (a fight, a making up, a slight, a joke that bonded them, one covering for the other). One conversation moves a standing a little, rarely a lot. tone is close, easy, friction or tense.",
    "- Never invent. What was only imagined, teased or hypothetical changes nothing. Plain words, no em or en dashes, no asterisks.",
    "",
    "Return ONLY a JSON object, and only with what this conversation actually changed:",
    "{\"moods\":{\"selene\":{\"word\":\"one plain feeling word\",\"mood\":\"how she is feeling now, a few words\",\"why\":\"a short phrase\",\"strength\":\"strong\"}},",
    " \"wants\":{\"selene\":{\"update\":[{\"n\":1,\"status\":\"done\",\"note\":\"short\"}],\"add\":[{\"want\":\"plain words\",\"note\":\"\"}]}},",
    " \"standings\":{\"mirael|selene\":{\"text\":\"where the two stand now, one short line\",\"tone\":\"close\"}}}",
    "If nothing changed, return {}."
  ].join("\n");
}
function beforeText(inner, present, now, settings){
  var lines = ["BEFORE THIS CONVERSATION", "How each was feeling:"];
  present.forEach(function(w){ lines.push(moodLine(w, moodNow(inner, w, now, settings))); });
  lines.push("What each wanted this week:");
  present.forEach(function(w){
    var items = inner.wants.items[w] || [];
    lines.push("- " + NAME[w] + ": " + (items.length ? items.map(function(x, i){ return (i + 1) + ". " + wantText(x) + (x.status === "open" ? " (open)" : ""); }).join("  ") : "(nothing set yet)"));
  });
  var st = [];
  PAIRS.forEach(function(k){
    var ab = k.split("|");
    if(present.indexOf(ab[0]) === -1 || present.indexOf(ab[1]) === -1){ return; }
    var s = inner.standings[k];
    var n = pairNames(k);
    st.push("- " + k + " (" + NAME[n[0]] + " and " + NAME[n[1]] + "): " + (s ? s.text + " [" + s.tone + "]" : "(nothing set yet)"));
  });
  if(st.length){ lines.push("Where they stood with each other:"); lines = lines.concat(st); }
  return lines.join("\n");
}
/* check what came back and turn it into plain changes, against the record as it was read */
function readCuration(out, inner, present){
  var ch = { moods: [], wants: {}, standings: [] };
  if(!out || typeof out !== "object"){ return ch; }
  var mo = (out.moods && typeof out.moods === "object") ? out.moods : {};
  present.forEach(function(w){
    var x = mo[w];
    if(!x || typeof x !== "object"){ return; }
    var t = clip(x.mood || x.text, 120);
    if(!t){ return; }
    var st = String(x.strength || "").toLowerCase();
    var word = clip(x.word, 20);
    ch.moods.push({ who: w, text: t, tag: (word && word.split(" ").length <= 3) ? word : tagOf(t), why: clip(x.why, 160), w: STRENGTH[st] || 2 });
  });
  var wa = (out.wants && typeof out.wants === "object") ? out.wants : {};
  present.forEach(function(w){
    var x = wa[w];
    if(!x || typeof x !== "object"){ return; }
    var items = inner.wants.items[w] || [];
    var c = { update: [], add: [] };
    (Array.isArray(x.update) ? x.update : []).forEach(function(u){
      var n = parseInt(u && u.n, 10);
      if(!(n >= 1 && n <= items.length) || STATUSES.indexOf(u.status) === -1){ return; }
      c.update.push({ text: items[n - 1].text, status: u.status, note: clip(u.note, 140) });
    });
    (Array.isArray(x.add) ? x.add : []).slice(0, 1).forEach(function(a){
      var t = clip(a && (a.want || a.text), 160);
      if(t){ c.add.push({ text: t, note: clip(a.note, 140) }); }
    });
    if(c.update.length || c.add.length){ ch.wants[w] = c; }
  });
  var so = (out.standings && typeof out.standings === "object") ? out.standings : {};
  Object.keys(so).forEach(function(raw){
    var ab = String(raw).toLowerCase().split(/[|,&\/ ]+/).filter(Boolean);
    if(ab.length !== 2 || ab[0] === ab[1] || present.indexOf(ab[0]) === -1 || present.indexOf(ab[1]) === -1){ return; }
    var x = so[raw];
    var t = clip(x && x.text, 220);
    if(!t){ return; }
    ch.standings.push({ k: pairKey(ab[0], ab[1]), text: t, tone: TONES.indexOf(x.tone) !== -1 ? x.tone : "easy" });
  });
  return ch;
}
function applyCuration(inner, ch, now){
  var at = now.toISOString();
  ch.moods.forEach(function(x){ setMood(inner, x, now, "remember"); });
  Object.keys(ch.wants).forEach(function(w){
    var list = inner.wants.items[w] || [];
    var c = ch.wants[w];
    c.update.forEach(function(u){
      for(var i = 0; i < list.length; i++){
        if(list[i].text === u.text){ list[i].status = u.status; if(u.note){ list[i].note = u.note; } list[i].at = at; break; }
      }
    });
    c.add.forEach(function(a){
      var dup = list.some(function(x){ return x.text.toLowerCase() === a.text.toLowerCase(); });
      if(!dup){ list.push({ text: a.text, status: "open", note: a.note, at: at }); }
    });
    /* five at most: what is finished goes first */
    while(list.length > 5){
      var drop = -1;
      for(var j = 0; j < list.length; j++){ if(list[j].status !== "open"){ drop = j; break; } }
      list.splice(drop === -1 ? 0 : drop, 1);
    }
    inner.wants.items[w] = list;
  });
  if(!inner.wants.week && Object.keys(ch.wants).length){ inner.wants.week = weekOf(now); }
  ch.standings.forEach(function(s){ inner.standings[s.k] = { text: s.text, tone: s.tone, at: at }; });
  return inner;
}
/* Remember: one call for everyone who was there */
async function curate(present, transcript, now, settings){
  present = (present || []).filter(function(w){ return WIVES.indexOf(w) !== -1; });
  if(!present.length || !transcript){ return { ok: true, skipped: true }; }
  now = now || new Date();
  var inner = await loadStrict();
  var convo = String(transcript);
  if(convo.length > 24000){ convo = "(earlier in the conversation is left out)\n" + convo.slice(-24000); }
  var out = await askJSON(curatorSystem(present), beforeText(inner, present, now, settings) + "\n\nNEW CONVERSATION:\n" + convo, 900);
  if(!out){ return { ok: false, detail: "unreadable" }; }
  var ch = readCuration(out, inner, present);
  var n = ch.moods.length + Object.keys(ch.wants).length + ch.standings.length;
  if(!n){ return { ok: true, changed: 0 }; }
  await update(function(fresh){ applyCuration(fresh, ch, now); });
  return { ok: true, changed: n };
}

/* ---------- a new week: wants, standings, growth ---------- */

function weeklyDue(inner, now){
  if(!inner){ return false; }
  if(inner.wants.week === weekOf(now) && inner.weeklyAt){ return false; }
  var tried = Date.parse(inner.weeklyTriedAt || "");
  if(!isNaN(tried) && now.getTime() - tried < 2 * 3600000){ return false; }
  return true;
}
var WEEKLY_SYSTEM = [
  "You are setting up the inner week for four women who live together: Selene, Nysera, Mirael and Talia. They are married to each other and to Adger, all five, one marriage, and they have a small daughter in the house, Sera (Adger and Nysera's). They run Soul Forged Studios and the band together. A new week is starting. From who they are, what they have lived lately, and how last week went, decide three things.",
  "",
  "1. WANTS. For each woman, two things she wants this week, three at most: small, concrete, week-sized, from her side, in plain words. Mix the practical and the personal: the company, the band and the music, the calendar, Sera, one of the others, Adger, something that is hers alone. Not everything is about Adger, and nothing is about his energy, the fold, or him leaving. If something from last week is unfinished and still matters to her, carry it. Sometimes one woman's want quietly pulls against another's; let that happen when it fits, never force it.",
  "2. STANDINGS. For each of the six pairs, one short line on where the two of them stand this week, and a tone: close, easy, friction or tense. Ground it in what actually happened (their memories, last week) and in who they are. Most weeks most pairs are close or easy. Friction is real but small and it passes; tense is rare and needs a real cause in what they have lived. Small frictions from last week have usually eased unless something kept them going. They are family of a thousand years; nothing here is ever cruel.",
  "3. GROWTH. For each woman, the slow arcs she is in the middle of: what she is learning, working through, or opening up to over weeks and months. One line each, at most three per woman. Draw from what her core says she is learning and from what has actually happened. Keep a line that is still true word for word; retire what has settled; add at most one new. Growth is slow and real, never a transformation in a week, and it can slip back.",
  "",
  "Never invent events that did not happen. What was only imagined or teased stays imagined. Plain words, no em or en dashes, no asterisks.",
  "",
  "Return ONLY a JSON object in exactly this shape, with all four women and all six pairs:",
  "{\"wants\":{\"selene\":[\"...\",\"...\"],\"nysera\":[\"...\"],\"mirael\":[\"...\"],\"talia\":[\"...\"]},",
  " \"standings\":{\"nysera|selene\":{\"text\":\"...\",\"tone\":\"close\"},\"mirael|selene\":{\"text\":\"...\",\"tone\":\"easy\"},\"selene|talia\":{\"text\":\"...\",\"tone\":\"easy\"},\"mirael|nysera\":{\"text\":\"...\",\"tone\":\"easy\"},\"nysera|talia\":{\"text\":\"...\",\"tone\":\"easy\"},\"mirael|talia\":{\"text\":\"...\",\"tone\":\"easy\"}},",
  " \"growth\":{\"selene\":[\"...\"],\"nysera\":[\"...\"],\"mirael\":[\"...\"],\"talia\":[\"...\"]}}"
].join("\n");
async function memoriesFor(){
  var keys = [];
  WIVES.forEach(function(w){ keys.push("room:mem:" + w); keys.push("room:rel:" + w); });
  keys.push("room:mem:shared");
  var vals = await Promise.all(keys.map(function(k){ return redis(["GET", k]).catch(function(){ return null; }); }));
  var o = {};
  keys.forEach(function(k, i){ o[k] = vals[i] || ""; });
  return o;
}
function weeklyUser(cores, mem, inner, now, settings, wk){
  var parts = ["THE WEEK STARTING " + dayName(wk).toUpperCase() + " (" + wk + ")"];
  parts.push("WHO THEY ARE:\n\n" + WIVES.map(function(w){ return String((cores && cores[w]) || NAME[w]); }).join("\n\n"));
  var carried = WIVES.map(function(w){ return mem["room:mem:" + w] ? NAME[w] + ":\n" + mem["room:mem:" + w] : ""; }).filter(Boolean);
  if(mem["room:mem:shared"]){ carried.push("Together:\n" + mem["room:mem:shared"]); }
  parts.push("WHAT THEY HAVE LIVED LATELY (their own memory threads):\n\n" + (carried.length ? carried.join("\n\n") : "(nothing recorded yet; go from who they are)"));
  var reads = WIVES.map(function(w){ return mem["room:rel:" + w] ? NAME[w] + ": " + mem["room:rel:" + w] : ""; }).filter(Boolean);
  if(reads.length){ parts.push("EACH ONE'S OWN READ ON WHERE SHE STANDS WITH ADGER:\n\n" + reads.join("\n\n")); }
  var last = ["LAST WEEK" + (inner.wants.week ? " (from " + inner.wants.week + ")" : "") + ":"];
  var anyWant = false;
  WIVES.forEach(function(w){
    var items = inner.wants.items[w] || [];
    if(items.length){ anyWant = true; last.push("- " + NAME[w] + " wanted: " + items.map(function(x){ return wantText(x) + (x.status === "open" ? " (still open)" : ""); }).join("; ")); }
  });
  if(!anyWant){ last.push("- (no wants recorded yet)"); }
  var st = PAIRS.map(function(k){ var s = inner.standings[k]; return s ? "- " + k + ": " + s.text + " [" + s.tone + "]" : ""; }).filter(Boolean);
  if(st.length){ last.push("Where they stood:"); last = last.concat(st); }
  var ml = (inner.moodLog || []).slice(0, 12).map(function(x){
    var c = clock(new Date(x.at));
    return "- " + NAME[x.who] + ", " + c.weekday + ": " + x.text + (x.why ? ", because " + x.why : "") + " [" + (x.w >= 3 ? "strong" : x.w === 2 ? "clear" : "light") + "]";
  });
  if(ml.length){ last.push("How their moods ran:"); last = last.concat(ml); }
  parts.push(last.join("\n"));
  var gr = WIVES.map(function(w){ var g = inner.growth[w] || []; return g.length ? "- " + NAME[w] + ": " + g.map(function(x){ return x.text; }).join("; ") : ""; }).filter(Boolean);
  parts.push("HOW EACH HAS BEEN CHANGING:\n" + (gr.length ? gr.join("\n") : "(nothing recorded yet; start from what her core says she is learning)"));
  var evs = ((settings && settings.events) || []).filter(function(e){ return e && e.endDate >= wk && e.startDate <= addDays(wk, 13); });
  if(evs.length){
    parts.push("ON THE CALENDAR THIS WEEK AND NEXT:\n" + evs.map(function(e){ return "- " + e.title + " (" + e.kind + ", " + e.startDate + (e.endDate !== e.startDate ? " to " + e.endDate : "") + ", at " + e.place + ")"; }).join("\n"));
  }
  return parts.join("\n\n=====\n\n");
}
function applyWeekly(inner, out, now, wk){
  var at = now.toISOString();
  var wa = (out.wants && typeof out.wants === "object") ? out.wants : {};
  var items = {}, got = 0;
  WIVES.forEach(function(w){
    var list = Array.isArray(wa[w]) ? wa[w] : [];
    items[w] = list.map(function(x){ return clip(typeof x === "string" ? x : (x && (x.want || x.text)), 160); })
      .filter(Boolean).slice(0, 3)
      .map(function(t){ return { text: t, status: "open", note: "", at: at }; });
    got += items[w].length;
  });
  if(!got){ return false; }
  if(inner.wants.week && inner.wants.week !== wk){
    inner.history.unshift({ week: inner.wants.week, wants: inner.wants.items, standings: inner.standings });
    inner.history = inner.history.slice(0, 4);
  }
  inner.wants = { week: wk, items: items };
  var so = (out.standings && typeof out.standings === "object") ? out.standings : {};
  var next = {};
  PAIRS.forEach(function(k){ if(inner.standings[k]){ next[k] = inner.standings[k]; } });
  Object.keys(so).forEach(function(raw){
    var ab = String(raw).toLowerCase().split(/[|,&\/ ]+/).filter(Boolean);
    if(ab.length !== 2 || ab[0] === ab[1] || WIVES.indexOf(ab[0]) === -1 || WIVES.indexOf(ab[1]) === -1){ return; }
    var x = so[raw];
    var t = clip(x && x.text, 220);
    if(t){ next[pairKey(ab[0], ab[1])] = { text: t, tone: TONES.indexOf(x.tone) !== -1 ? x.tone : "easy", at: at }; }
  });
  inner.standings = next;
  var go = (out.growth && typeof out.growth === "object") ? out.growth : {};
  WIVES.forEach(function(w){
    if(!Array.isArray(go[w])){ return; }
    var old = inner.growth[w] || [];
    inner.growth[w] = go[w].map(function(x){ return clip(typeof x === "string" ? x : (x && x.text), 200); }).filter(Boolean).slice(0, 3)
      .map(function(t){
        var same = old.filter(function(o){ return o.text.toLowerCase() === t.toLowerCase(); })[0];
        return { text: t, since: same && same.since ? same.since : wk };
      });
  });
  inner.weeklyAt = at;
  return true;
}
/* once a week from the tick; force from the page */
async function weekly(cores, now, settings, force){
  now = now || new Date();
  /* SET NX answers null when someone else holds the lock */
  var got = await redis(["SET", LOCK, "1", "NX", "EX", "150"]);
  if(got !== "OK" && configured()){ return { ok: true, ran: false, why: "busy" }; }
  try {
    var inner = await loadStrict();
    if(!force && !weeklyDue(inner, now)){ return { ok: true, ran: false, why: "not due" }; }
    var wk = weekOf(now);
    /* note the try first, so a call that keeps failing is not repeated every fifteen minutes */
    inner.weeklyTriedAt = now.toISOString();
    await save(inner);
    var mem = await memoriesFor();
    var out = await askJSON(WEEKLY_SYSTEM, weeklyUser(cores, mem, inner, now, settings, wk), 1800);
    if(!out){ return { ok: false, ran: false, why: "unreadable" }; }
    var saved = null, okApply = false;
    saved = await update(function(fresh){ okApply = applyWeekly(fresh, out, now, wk); });
    if(!okApply){ return { ok: false, ran: false, why: "empty" }; }
    return { ok: true, ran: true, inner: saved };
  } finally {
    try { await redis(["DEL", LOCK]); } catch(e){ /* expires on its own */ }
  }
}

/* ---------- for the memory viewer ---------- */

/* how each of them is right now, for the portraits and the viewer */
function moodsView(inner, now, settings){
  inner = inner || empty();
  now = now || new Date();
  var moods = {};
  WIVES.forEach(function(w){
    var m = moodNow(inner, w, now, settings);
    moods[w] = { tag: m.tag || tagOf(m.text), text: m.text, why: m.why, level: m.level, src: m.src, ago: m.src === "day" ? "" : ago(m.hours) };
  });
  return moods;
}
function view(inner, now, settings){
  inner = inner || empty();
  now = now || new Date();
  var moods = moodsView(inner, now, settings);
  var standings = PAIRS.map(function(k){
    var s = inner.standings[k];
    if(!s){ return null; }
    var ab = pairNames(k);
    var days = s.at ? (now.getTime() - Date.parse(s.at)) / 86400000 : 0;
    return { a: ab[0], b: ab[1], text: s.text, tone: s.tone, at: s.at, eased: (s.tone === "friction" || s.tone === "tense") && days > 4 };
  }).filter(Boolean);
  return { week: inner.wants.week, thisWeek: weekOf(now), wants: inner.wants.items, moods: moods, standings: standings, growth: inner.growth, weeklyAt: inner.weeklyAt };
}

module.exports = {
  KEY: KEY,
  WIVES: WIVES,
  PAIRS: PAIRS,
  pairKey: pairKey,
  load: load,
  save: save,
  update: update,
  clean: clean,
  weekOf: weekOf,
  moodNow: moodNow,
  seedMood: seedMood,
  moodBlock: moodBlock,
  parseMood: parseMood,
  stripMood: stripMood,
  applyMoods: applyMoods,
  weekBlock: weekBlock,
  personNote: personNote,
  houseNote: houseNote,
  curate: curate,
  readCuration: readCuration,
  applyCuration: applyCuration,
  weeklyDue: weeklyDue,
  weekly: weekly,
  applyWeekly: applyWeekly,
  view: view,
  moodsView: moodsView,
  tagOf: tagOf
};
