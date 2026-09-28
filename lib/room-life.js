"use strict";

/* ============================================================
   ROOM LIFE - the day goes on while Adger is away
   Each woman has a loose, lodge-centred day on the room clock.
   Events on the calendar (concerts, video builds, tours, shoots)
   reshape it. Talia has Sera by day. Rehearsal two evenings a week.
   Nothing here is scheduled: the day is worked out from the clock
   whenever anyone asks, so it is always right and costs nothing.
   ZERO BACKTICKS.
   ============================================================ */

var SETTINGS_KEY = "sim:settings";
var ROOM_TZ = process.env.ROOM_TZ || "Europe/Athens";

var BEDROOM  = "the master bedroom in the lodge";
var BATHROOM = "the master bathroom in the lodge";
var NURSERY  = "the nursery in the lodge";
var KITCHEN  = "the main kitchen in the lodge";
var LIVING   = "the main living room in the lodge";
var COURT    = "the courtyard outside the lodge";
var CEO      = "the CEO office at HQ";
var CONF     = "the conference room at HQ";
var SECURITY = "the security office at HQ";
var STUDIO   = "the recording studio at the Forge";
var SPRINGS  = "the Forge hot springs";
var TAVERN   = "the Forge tavern in the Village";
var COFFEE   = "the coffee shop in the Village";
var SQUARE   = "the square in the Village";
var GROUNDS  = "the Forge";
var STAGE    = "the stage at the Forge";
var ROOFTOP  = "the Forge rooftop, atop the stage";
var BUS      = "the tour bus, on the road";

var WIVES = ["selene", "nysera", "mirael", "talia"];

var DEFAULT_SETTINGS = {
  version: 1,
  rehearsal: { days: [2, 4], from: "19:30", to: "21:30", place: STUDIO },
  holdHours: 2,
  notes: { on: true, minAwayHours: 6 },
  ember: { aloneHours: 48, restHours: 24 },
  push: { on: true, quietFrom: "23:00", quietTo: "08:00", pace: "natural" },
  events: []
};

/* ---------- redis ---------- */

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

/* ---------- settings ---------- */

function clone(o){ return JSON.parse(JSON.stringify(o)); }

function hhmmOk(s){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || "")); }
function dateOk(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
function num(x, lo, hi, dflt){ var n = Number(x); if(isNaN(n)){ return dflt; } return Math.max(lo, Math.min(hi, n)); }
function str(x, max){ return String(x == null ? "" : x).replace(/[\u2013\u2014]/g, ",").slice(0, max || 120).trim(); }

var KINDS = ["concert", "video", "tour", "shoot", "other"];

function cleanEvent(e, i){
  if(!e || typeof e !== "object"){ return null; }
  var startDate = dateOk(e.startDate) ? e.startDate : null;
  if(!startDate){ return null; }
  var endDate = dateOk(e.endDate) && e.endDate >= startDate ? e.endDate : startDate;
  var kind = KINDS.indexOf(e.kind) !== -1 ? e.kind : "other";
  var title = str(e.title, 80) || "an event";
  return {
    id: str(e.id, 40) || ("ev" + Date.now().toString(36) + i),
    kind: kind,
    title: title,
    startDate: startDate,
    endDate: endDate,
    from: hhmmOk(e.from) ? e.from : (kind === "tour" ? "00:00" : kind === "concert" ? "20:00" : "09:00"),
    to: hhmmOk(e.to) ? e.to : (kind === "tour" ? "23:59" : kind === "concert" ? "23:00" : "18:00"),
    place: str(e.place, 120) || defaultPlaceFor(kind)
  };
}

function defaultPlaceFor(kind){
  if(kind === "concert"){ return STAGE; }
  if(kind === "video"){ return STUDIO; }
  if(kind === "tour"){ return BUS; }
  if(kind === "shoot"){ return ROOFTOP; }
  return CONF;
}

function cleanSettings(s){
  var d = clone(DEFAULT_SETTINGS);
  if(!s || typeof s !== "object"){ return d; }
  if(s.rehearsal && typeof s.rehearsal === "object"){
    var days = Array.isArray(s.rehearsal.days) ? s.rehearsal.days.map(Number).filter(function(n){ return n >= 0 && n <= 6; }) : d.rehearsal.days;
    d.rehearsal.days = days.filter(function(v, i, a){ return a.indexOf(v) === i; }).sort();
    if(hhmmOk(s.rehearsal.from)){ d.rehearsal.from = s.rehearsal.from; }
    if(hhmmOk(s.rehearsal.to)){ d.rehearsal.to = s.rehearsal.to; }
    if(s.rehearsal.place){ d.rehearsal.place = str(s.rehearsal.place, 120); }
  }
  d.holdHours = num(s.holdHours, 0.5, 12, d.holdHours);
  if(s.notes && typeof s.notes === "object"){
    d.notes.on = s.notes.on !== false;
    d.notes.minAwayHours = num(s.notes.minAwayHours, 1, 72, d.notes.minAwayHours);
  }
  if(s.ember && typeof s.ember === "object"){
    d.ember.aloneHours = num(s.ember.aloneHours, 6, 336, d.ember.aloneHours);
    d.ember.restHours = num(s.ember.restHours, 1, 168, d.ember.restHours);
  }
  if(s.push && typeof s.push === "object"){
    d.push.on = s.push.on !== false;
    if(hhmmOk(s.push.quietFrom)){ d.push.quietFrom = s.push.quietFrom; }
    if(hhmmOk(s.push.quietTo)){ d.push.quietTo = s.push.quietTo; }
    if(["rarely", "natural", "often"].indexOf(s.push.pace) !== -1){ d.push.pace = s.push.pace; }
  }
  if(Array.isArray(s.events)){
    d.events = s.events.slice(0, 60).map(cleanEvent).filter(Boolean)
      .sort(function(a, b){ return (a.startDate + a.from) < (b.startDate + b.from) ? -1 : 1; });
  }
  return d;
}

async function loadSettings(){
  try {
    var raw = await redis(["GET", SETTINGS_KEY]);
    if(raw){ return cleanSettings(JSON.parse(raw)); }
  } catch(e){ /* fall through to defaults */ }
  return clone(DEFAULT_SETTINGS);
}

async function saveSettings(s){
  var c = cleanSettings(s);
  await redis(["SET", SETTINGS_KEY, JSON.stringify(c)]);
  return c;
}

/* ---------- the room clock ---------- */

var FMT = null;
function fmt(){
  if(!FMT){
    FMT = new Intl.DateTimeFormat("en-GB", {
      timeZone: ROOM_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false
    });
  }
  return FMT;
}
function parts(date){
  var o = {};
  try {
    fmt().formatToParts(date).forEach(function(p){ o[p.type] = p.value; });
  } catch(e){
    var d = new Date(date.getTime());
    o = { year: String(d.getUTCFullYear()), month: pad(d.getUTCMonth() + 1), day: pad(d.getUTCDate()),
      hour: pad(d.getUTCHours()), minute: pad(d.getUTCMinutes()), weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()] };
  }
  var h = parseInt(o.hour, 10) % 24, m = parseInt(o.minute, 10);
  var dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(o.weekday);
  return { key: o.year + "-" + o.month + "-" + o.day, dow: dow, hour: h + m / 60, hhmm: pad(h) + ":" + pad(m), weekday: o.weekday };
}
function pad(n){ n = Number(n); return (n < 10 ? "0" : "") + n; }
function toHours(hhmm){ var p = String(hhmm).split(":"); return parseInt(p[0], 10) + parseInt(p[1], 10) / 60; }

/* a day's key plus or minus n days, by calendar */
function addDays(key, n){
  var d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

/* ---------- events ---------- */

function eventsOn(settings, key){
  return (settings.events || []).filter(function(e){ return e.startDate <= key && key <= e.endDate; });
}
function eventActive(e, key, hour){
  if(!(e.startDate <= key && key <= e.endDate)){ return false; }
  var a = toHours(e.from), b = toHours(e.to);
  if(b <= a){ return hour >= a || hour < b; }
  return hour >= a && hour < b;
}
function doingFor(e){
  if(e.kind === "concert"){ return "on stage: " + e.title; }
  if(e.kind === "video"){ return "on set, filming " + e.title; }
  if(e.kind === "tour"){ return "on tour: " + e.title; }
  if(e.kind === "shoot"){ return "the shoot: " + e.title; }
  return e.title;
}
/* a concert or a tour coming up within three days means rehearsal every night */
function prepFor(settings, key){
  var list = settings.events || [];
  for(var i = 0; i < list.length; i++){
    var e = list[i];
    if(e.kind !== "concert" && e.kind !== "tour"){ continue; }
    if(e.startDate > key && e.startDate <= addDays(key, 3)){ return e; }
  }
  return null;
}

/* ---------- one woman's day ----------
   Returns blocks [{from, to, where, doing}] in hours, covering the whole day.
   Loose on purpose: mostly the lodge, HQ some days, with the dice deciding
   the details so each day is different but stays the same all day long. */

function B(from, to, where, doing){ return { from: from, to: to, where: where, doing: doing }; }

var PLAN_CACHE = { settings: null, map: {} };
function dayPlan(who, key, dow, settings){
  if(PLAN_CACHE.settings !== settings){ PLAN_CACHE.settings = settings; PLAN_CACHE.map = {}; }
  var ck = who + "|" + key;
  if(!PLAN_CACHE.map[ck]){ PLAN_CACHE.map[ck] = buildDay(who, key, dow, settings); }
  return PLAN_CACHE.map[ck];
}
function buildDay(who, key, dow, settings){
  var s = key + "|" + who + "|";
  var weekend = (dow === 0 || dow === 6);
  var friday = (dow === 5), sunday = (dow === 0);
  var reh = settings.rehearsal || DEFAULT_SETTINGS.rehearsal;
  var rFrom = toHours(reh.from), rTo = toHours(reh.to);
  var prep = prepFor(settings, key);
  var rehearsing = prep || reh.days.indexOf(dow) !== -1;
  var rehDoing = prep ? "rehearsing for " + prep.title : "band rehearsal";
  var P = [];

  function evening(latestBed){
    // after the bath hour, until bed: rehearsal, the tavern on Fridays and Saturdays, or home
    var start = 19.5;
    if(rehearsing){
      if(rFrom > start){ P.push(B(start, rFrom, LIVING, "the quiet hour after dinner")); }
      P.push(B(Math.max(start, rFrom), rTo, reh.place || STUDIO, rehDoing));
      start = rTo;
    }
    if((friday || dow === 6) && !rehearsing){
      P.push(B(start, 20, LIVING, "getting ready to head to the tavern"));
      P.push(B(20, Math.min(23.5, latestBed), TAVERN, friday ? "Friday night at the tavern" : "Saturday night at the tavern"));
      start = Math.min(23.5, latestBed);
    }
    if(start < latestBed){
      var o = pick(s + "eve", [[6, LIVING, "evening in the living room"], [2, SPRINGS, "an evening soak in the hot springs"], [1, COURT, "out in the courtyard under the lanterns"]]);
      if(sunday && who !== "talia"){ o = [1, SPRINGS, "the Sunday soak in the hot springs"]; }
      P.push(B(start, latestBed, o[1], o[2]));
    }
  }

  if(who === "nysera"){
    var nW = weekend ? 7.5 : 6.5;
    P.push(B(0, nW, BEDROOM, "asleep in the big bed"));
    if(!weekend){
      P.push(B(nW, 7.5, KITCHEN, "coffee and the day's mail before anyone else is up"));
      P.push(B(7.5, 8.5, KITCHEN, "breakfast with Sera and whoever is up"));
      var m1 = pick(s + "am", [[4, CEO, "working in the CEO office at HQ"], [6, LIVING, "working from the living room, laptop open"]]);
      P.push(B(8.5, 12.5, m1[1], m1[2]));
      P.push(B(12.5, 13.25, KITCHEN, "lunch"));
      var m2 = pick(s + "pm", [[5, CEO, "calls and contracts in the CEO office"], [4, LIVING, "working from the living room"], [1, CONF, "a meeting in the conference room"]]);
      P.push(B(13.25, 17.5, m2[1], m2[2]));
      P.push(B(17.5, 18, LIVING, "done for the day, shoes off"));
    } else {
      P.push(B(nW, 10, KITCHEN, "a slow breakfast, no email, on principle"));
      var w1 = pick(s + "wk", [[3, LIVING, "reading by the fire"], [2, COFFEE, "at the coffee shop in the Village"], [2, SPRINGS, "at the hot springs"], [1, CEO, "catching up on work she swore she would not do"]]);
      P.push(B(10, 12.5, w1[1], w1[2]));
      P.push(B(12.5, 13.25, KITCHEN, "lunch"));
      var w2 = pick(s + "wk2", [[3, SQUARE, "walking through the Village"], [3, LIVING, "a quiet afternoon at home"], [2, COURT, "in the courtyard"]]);
      P.push(B(13.25, 18, w2[1], w2[2]));
    }
    P.push(B(18, 18.75, KITCHEN, "family dinner"));
    P.push(B(18.75, 19.5, BATHROOM, "giving Sera her bath"));
    evening(22.5);
    P.push(B(22.5, 24, BEDROOM, "asleep in the big bed"));
  }

  else if(who === "talia"){
    P.push(B(0, 7, BEDROOM, "asleep in the big bed"));
    P.push(B(7, 8, KITCHEN, "breakfast, feeding Sera"));
    var withSera = [[3, LIVING, "on the floor with Sera, blocks and books"], [2, NURSERY, "reading to Sera in the nursery"], [2, COURT, "out in the courtyard with Sera"], [1, SQUARE, "walking Sera through the Village"], [1, COFFEE, "at the coffee shop with Sera"]];
    var t1 = pick(s + "am", withSera);
    P.push(B(8, 12, t1[1], t1[2]));
    P.push(B(12, 12.5, KITCHEN, "lunch with Sera"));
    var t2 = pick(s + "nap", [[5, LIVING, "reading while Sera naps, the monitor beside her"], [3, STUDIO, "drum practice while Sera naps, someone else on the monitor"], [2, SPRINGS, "an hour in the hot springs while Sera naps"]]);
    P.push(B(12.5, 15, t2[1], t2[2]));
    var t3 = pick(s + "pm", [[3, LIVING, "playing with Sera in the living room"], [2, COURT, "out in the courtyard with Sera"], [1, SQUARE, "walking Sera through the Village"], [1, COFFEE, "at the coffee shop with Sera, a treat after her nap"], [1, NURSERY, "in the nursery with Sera, just up from her nap"]]);
    P.push(B(15, 18, t3[1], t3[2]));
    P.push(B(18, 18.75, KITCHEN, "family dinner"));
    P.push(B(18.75, 19.5, LIVING, "the quiet hour while Sera has her bath"));
    evening(23);
    P.push(B(23, 24, BEDROOM, "asleep in the big bed"));
  }

  else if(who === "mirael"){
    var mW = weekend ? 8.5 : 7.5;
    P.push(B(0, mW, BEDROOM, "asleep in the big bed"));
    P.push(B(mW, weekend ? 10 : 8.5, KITCHEN, "breakfast"));
    if(!weekend){
      var a1 = pick(s + "am", [[5, CONF, "running the schedule from the conference room"], [5, LIVING, "on the laptop in the living room, running the schedule"]]);
      P.push(B(8.5, 12.5, a1[1], a1[2]));
      P.push(B(12.5, 13.25, KITCHEN, "lunch"));
      var a2 = pick(s + "pm", [[4, CONF, "calls and logistics in the conference room"], [4, LIVING, "working from the living room"], [2, SECURITY, "in the security office with Selene, supposedly working"]]);
      P.push(B(13.25, 17, a2[1], a2[2]));
      var a3 = pick(s + "air", [[1, COURT, "out in the courtyard for air"], [1, LIVING, "done for the day"]]);
      P.push(B(17, 18, a3[1], a3[2]));
    } else {
      var b1 = pick(s + "wk", [[3, LIVING, "a lazy morning in the living room"], [2, COFFEE, "at the coffee shop, people watching"], [2, STUDIO, "noodling on the bass in the studio"]]);
      P.push(B(10, 12.5, b1[1], b1[2]));
      P.push(B(12.5, 13.25, KITCHEN, "lunch"));
      var b2 = pick(s + "wk2", [[3, SQUARE, "in the Village"], [3, SPRINGS, "at the hot springs"], [2, LIVING, "at home"]]);
      P.push(B(13.25, 18, b2[1], b2[2]));
    }
    P.push(B(18, 18.75, KITCHEN, "family dinner"));
    P.push(B(18.75, 19.5, LIVING, "after dinner"));
    evening(23.5);
    P.push(B(23.5, 24, BEDROOM, "asleep in the big bed"));
  }

  else if(who === "selene"){
    var sW = weekend ? 10 : 9;
    P.push(B(0, 0.5, LIVING, "still up, the last of the whiskey"));
    P.push(B(0.5, sW, BEDROOM, "asleep in the big bed"));
    P.push(B(sW, sW + 1, KITCHEN, "coffee, black, no talking yet"));
    if(!weekend){
      var c1 = pick(s + "am", [[6, SECURITY, "in the security office, going through the feeds"], [4, GROUNDS, "walking the grounds"]]);
      P.push(B(sW + 1, 13, c1[1], c1[2]));
      P.push(B(13, 13.75, KITCHEN, "lunch"));
      var c2 = pick(s + "pm", [[5, SECURITY, "in the security office"], [3, STUDIO, "running vocals in the studio"], [2, COURT, "out on the courtyard and the gate, checking the perimeter"]]);
      P.push(B(13.75, 17.5, c2[1], c2[2]));
      P.push(B(17.5, 18, LIVING, "feet up, done"));
    } else {
      var d1 = pick(s + "wk", [[3, LIVING, "sprawled on the sofa"], [2, STUDIO, "in the studio, loud"], [2, SQUARE, "in the Village, causing trouble"]]);
      P.push(B(sW + 1, 13, d1[1], d1[2]));
      P.push(B(13, 13.75, KITCHEN, "lunch"));
      var d2 = pick(s + "wk2", [[3, SPRINGS, "at the hot springs"], [3, LIVING, "at home"], [2, COURT, "in the courtyard"]]);
      P.push(B(13.75, 18, d2[1], d2[2]));
    }
    P.push(B(18, 18.75, KITCHEN, "family dinner"));
    P.push(B(18.75, 19.5, LIVING, "after dinner"));
    evening(24);
  }

  return P.filter(function(b){ return b.to > b.from; });
}

/* ---------- where someone is at a given moment, by the day alone ---------- */

function routineAt(who, when, settings){
  var p = parts(when);
  // an active event takes everyone
  var evs = eventsOn(settings, p.key);
  for(var i = 0; i < evs.length; i++){
    var e = evs[i];
    if(eventActive(e, p.key, p.hour)){ return { where: e.place, doing: doingFor(e), event: e.id }; }
    if(e.kind === "concert" && e.startDate === p.key){
      var start = toHours(e.from);
      if(p.hour >= start - 3 && p.hour < start){ return { where: e.place, doing: "soundcheck for " + e.title, event: e.id }; }
    }
  }
  var plan = dayPlan(who, p.key, p.dow, settings);
  for(var j = 0; j < plan.length; j++){
    if(p.hour >= plan[j].from && p.hour < plan[j].to){ return { where: plan[j].where, doing: plan[j].doing }; }
  }
  return { where: BEDROOM, doing: "asleep in the big bed" };
}

/* Sera: an 18-month-old's rhythm. By day she is with Talia; if Talia is busy
   or away, with Nysera; if both are, with whoever is home; at an event at
   the Forge, with a sitter from the Village. On tour she comes along. */
function seraAt(state, when, settings, womanWhere){
  var p = parts(when), h = p.hour;
  function mine(w){ return womanWhere ? womanWhere(w, when) : ((state.people[w] || {}).where || ""); }
  function inValley(place){ return /in the lodge|at hq|the forge|in the village|outside the lodge/i.test(String(place)); }
  var evs = eventsOn(settings, p.key).filter(function(e){ return eventActive(e, p.key, h); });
  var tour = evs.filter(function(e){ return e.kind === "tour"; })[0];
  if(tour){ return { where: tour.place, doing: "on the road with her mothers" }; }
  if(h >= 19.5 || h < 7){ return { where: NURSERY, doing: "asleep in her crib for the night" }; }
  if(h < 8){ return { where: KITCHEN, doing: "just up, breakfast" }; }
  if(h >= 12 && h < 12.5){ return { where: KITCHEN, doing: "lunch" }; }
  if(h >= 12.5 && h < 15){ return { where: NURSERY, doing: "down for her nap" }; }
  if(h >= 18 && h < 18.75){ return { where: KITCHEN, doing: "dinner" }; }
  if(h >= 18.75){ return { where: BATHROOM, doing: "bath and bedtime" }; }
  if(evs.length){ return { where: NURSERY, doing: "with a sitter from the Village while her mothers work" }; }
  var t = mine("talia");
  if(inValley(t)){ return { where: t, doing: "with Talia" }; }
  var n = mine("nysera");
  if(inValley(n)){ return { where: n, doing: "with Nysera" }; }
  for(var i = 0; i < WIVES.length; i++){
    var x = mine(WIVES[i]);
    if(/in the lodge/i.test(String(x))){ return { where: x, doing: "with " + WIVES[i].charAt(0).toUpperCase() + WIVES[i].slice(1) }; }
  }
  return { where: NURSERY, doing: "with a sitter from the Village" };
}

/* ---------- applying the day to the live state ----------
   A woman follows her day unless the story or Adger moved her, or she
   spoke, within holdHours. Then her day takes back over. */

function lastActive(p){
  var t = 0;
  ["at", "movedAt", "spokeAt"].forEach(function(k){
    var v = Date.parse(p && p[k] || "");
    if(!isNaN(v) && v > t){ t = v; }
  });
  return t;
}

function held(p, now, settings){
  if(!p || p.auto){ return false; }
  var t = lastActive(p);
  if(!t){ return false; }
  return (now.getTime() - t) < settings.holdHours * 3600000;
}

/* where a woman is at a past or present moment, as best the house knows */
function womanWhereAt(state, who, when, settings){
  var p = state.people[who];
  if(p && !p.auto){
    var t = lastActive(p);
    if(t && when.getTime() - t < settings.holdHours * 3600000 && when.getTime() >= t){ return p.where; }
  }
  return routineAt(who, when, settings).where;
}

function stampLocal(date){
  var p = parts(date);
  return p.weekday + " " + p.hhmm;
}

function applyRoutines(state, now, settings){
  now = now || new Date();
  var moved = [];
  WIVES.forEach(function(w){
    var p = state.people[w];
    if(!p){ return; }
    if(held(p, now, settings)){ return; }
    var r = routineAt(w, now, settings);
    if(p.auto && p.where === r.where && p.doing === r.doing){ return; }
    p.where = r.where; p.doing = r.doing; p.auto = true; p.absent = false;
    p.at = now.toISOString(); p.since = stampLocal(now);
    moved.push(w);
  });
  return moved;
}

/* ---------- the day, told: for the map's timeline and for the notes ---------- */

function todayTimeline(state, now, settings){
  var p = parts(now);
  var out = {};
  var dayStart = new Date(now.getTime() - p.hour * 3600000);
  WIVES.concat(["sera"]).forEach(function(w){
    var blocks = [], cur = null;
    for(var m = 0; m < 24 * 60; m += 15){
      var at = new Date(dayStart.getTime() + m * 60000);
      var r = w === "sera"
        ? seraAt(state, at, settings, function(x, when){ return routineAt(x, when, settings).where; })
        : routineAt(w, at, settings);
      if(cur && cur.where === r.where && cur.doing === r.doing){ cur.to = (m + 15) / 60; }
      else { cur = { from: m / 60, to: (m + 15) / 60, where: r.where, doing: r.doing }; blocks.push(cur); }
    }
    out[w] = blocks;
  });
  return { day: p.key, weekday: p.weekday, now: p.hour, people: out };
}

/* what happened between two moments, in plain lines, for the notes */
function awayStory(state, from, to, settings){
  var lines = [];
  var span = Math.min(to.getTime() - from.getTime(), 3 * 86400000);
  var start = new Date(to.getTime() - span);
  WIVES.forEach(function(w){
    var cur = null, list = [];
    for(var t = start.getTime(); t < to.getTime(); t += 30 * 60000){
      var at = new Date(t);
      var r = { where: womanWhereAt(state, w, at, settings), doing: "" };
      var rr = routineAt(w, at, settings);
      r.doing = (r.where === rr.where) ? rr.doing : "where the story left her";
      if(cur && cur.where === r.where && cur.doing === r.doing){ continue; }
      cur = { at: stampLocal(at), where: r.where, doing: r.doing };
      list.push(cur);
    }
    var name = w.charAt(0).toUpperCase() + w.slice(1);
    lines.push(name + ": " + list.map(function(x){ return x.at + " " + x.doing + " (" + x.where.replace(/^the /, "") + ")"; }).join("; "));
  });
  var evs = (settings.events || []).filter(function(e){
    var a = parts(start).key, b = parts(to).key;
    return !(e.endDate < a || e.startDate > addDays(b, 14));
  });
  if(evs.length){
    lines.push("On the calendar: " + evs.map(function(e){
      return e.title + " (" + e.kind + ", " + e.startDate + (e.endDate !== e.startDate ? " to " + e.endDate : "") + ", " + e.from + " to " + e.to + ", at " + e.place + ")";
    }).join("; "));
  }
  return lines.join("\n");
}

/* what is coming up, for the room itself to know */
function calendarNote(settings, now){
  var p = parts(now);
  var soon = (settings.events || []).filter(function(e){ return e.endDate >= p.key && e.startDate <= addDays(p.key, 21); });
  if(!soon.length){ return ""; }
  return "ON THE CALENDAR (real plans they are working toward; let them come up the way work and nerves do, never as a list): " +
    soon.map(function(e){
      var when = e.startDate === p.key ? "today" : e.startDate === addDays(p.key, 1) ? "tomorrow" : e.startDate;
      return e.title + " (" + e.kind + ", " + when + (e.endDate !== e.startDate ? " to " + e.endDate : "") + ", " + e.from + " to " + e.to + ", at " + e.place + ")";
    }).join("; ") + ".";
}

module.exports = {
  SETTINGS_KEY: SETTINGS_KEY,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  STAGE: STAGE,
  loadSettings: loadSettings,
  saveSettings: saveSettings,
  cleanSettings: cleanSettings,
  routineAt: routineAt,
  seraAt: seraAt,
  womanWhereAt: womanWhereAt,
  applyRoutines: applyRoutines,
  todayTimeline: todayTimeline,
  awayStory: awayStory,
  calendarNote: calendarNote,
  dayPlan: dayPlan,
  parts: parts,
  held: held
};
