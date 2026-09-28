"use strict";

/* ============================================================
   ROOM STATE - where everyone is and what they are doing
   Soul Forged Studios - four-woman room
   Loaded whole every turn. Never summarized. Never retrieved.
   ZERO BACKTICKS.
   ============================================================ */

var life = require("./room-life");

var STATE_KEY = "sim:state";
var LOG_KEY = "sim:state:log";

var PEOPLE = ["selene", "nysera", "mirael", "talia", "adger", "sera", "virestar"];

/* rows that are not the four women or Adger */
var NURSERY  = "the nursery in the lodge";
var KITCHEN  = "the main kitchen in the lodge";
var BATHROOM = "the master bathroom in the lodge";
var BEDROOM  = "the master bedroom in the lodge";

/* what a toddler's record is good for before her normal day takes back over */
var SERA_STALE_HOURS = 2;

/* Their day runs on this clock. Must match ROOM_TZ in api/room.js. */
var ROOM_TZ = process.env.ROOM_TZ || "Europe/Athens";

/* A row older than this is history, not the present. */
var STALE_HOURS = 10;

var DEFAULT_STATE = {
  updated: null,
  people: {
    selene: { where: "the road", doing: "walking. thread quiet, not cut", since: "unknown", at: null, absent: true },
    nysera: { where: "bedside",  doing: "sitting with him",              since: "unknown", at: null, absent: false },
    mirael: { where: "hallway",  doing: "at the doorway",                since: "unknown", at: null, absent: false },
    talia:  { where: "bedside",  doing: "holding the star",              since: "unknown", at: null, absent: false },
    adger:  { where: "bed",      doing: "awake",                         since: "unknown", at: null, absent: false },
    sera:   { where: NURSERY,    doing: "asleep in her crib",            since: "unknown", at: null, absent: false, auto: true },
    virestar: { where: BEDROOM,  doing: "on its stand",                  since: "unknown", at: null, absent: false }
  }
};

/* ---------- redis ---------- */

function redisUrl(){
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
}

function redisToken(){
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
}

async function redis(command){
  var url = redisUrl();
  var token = redisToken();
  if(!url || !token){ throw new Error("Redis env vars missing"); }
  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  var text = await res.text();
  if(!res.ok){ throw new Error("Redis " + res.status + " " + text); }
  var data = JSON.parse(text);
  if(data && data.error){ throw new Error("Redis error: " + data.error); }
  return data ? data.result : null;
}

/* ---------- load and save ---------- */

function clone(o){ return JSON.parse(JSON.stringify(o)); }

async function loadState(){
  var raw = null;
  try { raw = await redis(["GET", STATE_KEY]); }
  catch(e){ return clone(DEFAULT_STATE); }
  if(!raw){ return clone(DEFAULT_STATE); }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch(e){ return clone(DEFAULT_STATE); }
  if(!parsed || !parsed.people){ return clone(DEFAULT_STATE); }
  // backfill anyone missing so the block is never short a row
  for(var i = 0; i < PEOPLE.length; i++){
    var k = PEOPLE[i];
    if(!parsed.people[k]){ parsed.people[k] = clone(DEFAULT_STATE.people[k]); }
    if(typeof parsed.people[k].at === "undefined"){ parsed.people[k].at = null; }
  }
  return parsed;
}

async function saveState(state){
  state.updated = new Date().toISOString();
  await redis(["SET", STATE_KEY, JSON.stringify(state)]);
  return state;
}

/* Append-only transition log. Never injected into context.
   This is history; the state blob is the present. */
async function logTransition(entry){
  try { await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]); }
  catch(e){ /* logging must never break a turn */ }
}

/* ---------- directive parsing ----------
   STATE: name | where | doing | reason
   reason is optional. One directive per line, several allowed per reply.
*/

var STATE_LINE = /^STATE:[ \t]*(.*)$/gim;

function parseStateDirectives(text){
  if(!text){ return []; }
  var out = [];
  var src = String(text);
  var m;
  STATE_LINE.lastIndex = 0;
  while((m = STATE_LINE.exec(src)) !== null){
    var parts = m[1].split("|");
    for(var i = 0; i < parts.length; i++){ parts[i] = parts[i].trim(); }
    var who = (parts[0] || "").toLowerCase();
    if(PEOPLE.indexOf(who) === -1){ continue; }
    if(!parts[1] && !parts[2]){ continue; }
    out.push({
      who: who,
      where: parts[1] || "",
      doing: parts[2] || "",
      reason: parts[3] || ""
    });
  }
  return out;
}

function stripStateDirectives(text){
  if(!text){ return text; }
  return String(text)
    .replace(STATE_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- time ----------
   Everything the women see is ROOM_TZ local, never UTC.
*/

function localStamp(date, tz){
  try {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    var day = "", hh = "", mm = "";
    for(var i = 0; i < parts.length; i++){
      if(parts[i].type === "weekday"){ day = parts[i].value; }
      if(parts[i].type === "hour"){ hh = parts[i].value; }
      if(parts[i].type === "minute"){ mm = parts[i].value; }
    }
    if(hh && mm){ return (day ? day + " " : "") + hh + ":" + mm; }
  } catch(e){ /* fall through */ }
  var h = date.getUTCHours();
  var mi = date.getUTCMinutes();
  return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
}

function minutesSince(iso, now){
  if(!iso){ return null; }
  var then = Date.parse(iso);
  if(isNaN(then)){ return null; }
  var d = Math.floor((now.getTime() - then) / 60000);
  return d < 0 ? 0 : d;
}

function ageText(iso, now){
  var mins = minutesSince(iso, now);
  if(mins === null){ return "age unknown"; }
  if(mins < 2){ return "just now"; }
  if(mins < 60){ return mins + " minutes ago"; }
  var hrs = Math.floor(mins / 60);
  if(hrs < 24){ return hrs + (hrs === 1 ? " hour ago" : " hours ago"); }
  var days = Math.round(hrs / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

function hourIn(date, tz){
  try {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
    var h = 0, m = 0;
    for(var i = 0; i < parts.length; i++){
      if(parts[i].type === "hour"){ h = parseInt(parts[i].value, 10) % 24; }
      if(parts[i].type === "minute"){ m = parseInt(parts[i].value, 10); }
    }
    return h + m / 60;
  } catch(e){ return date.getUTCHours() + date.getUTCMinutes() / 60; }
}

/* ---------- Sera's day ----------
   An 18-month-old's rhythm on the room clock. Anything a woman records about her holds
   for SERA_STALE_HOURS; after that her normal day takes back over. Awake and not eating,
   she is with her mother by default, and the room decides who actually has her.
*/

function seraRoutine(state, now, settings){
  settings = settings || life.DEFAULT_SETTINGS;
  return life.seraAt(state, now, settings, function(w){ return (state.people[w] || {}).where || ""; });
}

function applySeraRoutine(state, now, settings){
  now = now || new Date();
  var s = state && state.people && state.people.sera;
  if(!s){ return false; }
  var m = minutesSince(s.at, now);
  if(!s.auto && m !== null && m <= SERA_STALE_HOURS * 60){ return false; }
  var r = seraRoutine(state, now, settings);
  if(s.auto && s.where === r.where && s.doing === r.doing){ return false; }
  s.where = r.where; s.doing = r.doing; s.auto = true; s.absent = false;
  s.at = now.toISOString(); s.since = localStamp(now, ROOM_TZ);
  return true;
}

function isStale(iso, now){
  var mins = minutesSince(iso, now);
  if(mins === null){ return true; }
  return mins > STALE_HOURS * 60;
}

/* ---------- places ----------
   The page's location picker uses these exact names. When a woman moves herself in the
   story she writes something looser ("the bathroom"); canonPlace maps it onto the same
   names so the page, the board and the room all agree. Anything unrecognised is kept as
   written. Order matters: specific words before general ones.
*/

var PLACE_WORDS = [
  ["the fold",        "the fold"],
  ["hot spring",      "the Forge hot springs"],
  ["master bathroom", "the master bathroom in the lodge"],
  ["master bedroom",  "the master bedroom in the lodge"],
  ["nursery",         "the nursery in the lodge"],
  ["crib",            "the nursery in the lodge"],
  ["bathroom",        "the master bathroom in the lodge"],
  ["shower",          "the master bathroom in the lodge"],
  ["bath",            "the master bathroom in the lodge"],
  ["bedroom",         "the master bedroom in the lodge"],
  ["kitchen",         "the main kitchen in the lodge"],
  ["living room",     "the main living room in the lodge"],
  ["conference room", "the conference room at HQ"],
  ["security office", "the security office at HQ"],
  ["security",        "the security office at HQ"],
  ["office",          "the CEO office at HQ"],
  ["coffee",          "the coffee shop in the Village"],
  ["cafe",            "the coffee shop in the Village"],
  ["village square",  "the square in the Village"],
  ["the square",      "the square in the Village"],
  ["courtyard",       "the courtyard outside the lodge"],
  ["dragon stone",    "the courtyard outside the lodge"],
  ["outside the lodge","the courtyard outside the lodge"],
  ["rooftop",         "the Forge rooftop, atop the stage"],
  ["stage",           "the stage at the Forge"],
  ["tavern",          "the Forge tavern in the Village"],
  ["studio",          "the recording studio at the Forge"],
  ["tour bus",        "the tour bus, on the road"],
  ["jet",             "the jet, SFS2026, in flight"],
  ["yacht",           "the yacht, Little Shadow"]
];

function canonPlace(place){
  var s = String(place || "").trim();
  if(!s){ return ""; }
  var low = s.toLowerCase();
  for(var i = 0; i < PLACE_WORDS.length; i++){
    if(low === PLACE_WORDS[i][1].toLowerCase()){ return PLACE_WORDS[i][1]; }
  }
  for(var j = 0; j < PLACE_WORDS.length; j++){
    if(low.indexOf(PLACE_WORDS[j][0]) !== -1){ return PLACE_WORDS[j][1]; }
  }
  return s;
}

function shortPlace(place){
  return String(place || "").replace(/ in the lodge$/i, "").replace(/^the /i, "");
}

function movePerson(p, place, now){
  if(!p || !place){ return; }
  p.movedAt = now.toISOString();
  p.auto = false;
  if(p.where !== place){
    // a RECENT activity belonged to the old place, so it ended when she moved.
    // an OLD activity is already history and simply stays OLD.
    if(p.where && !isStale(p.at, now)){
      p.doing = "came over from " + shortPlace(p.where);
      p.at = now.toISOString();
      p.since = localStamp(now, ROOM_TZ);
    }
    p.where = place;
  }
  p.absent = false;
}

/* ---------- whoever moved last wins ----------
   The page sends its picker values with EVERY message, changed or not. So a picker value
   only counts as Adger moving someone when it differs from the last picker value we saw
   for that person. Unchanged, it is ignored, and a woman's own move in the story stands.
   picked holds ONLY what the page actually sent. Returns true if the state changed.
*/

function resolvePlaces(state, picked){
  var changed = false;
  var now = new Date();
  if(!state || !state.people || !picked){ return false; }
  if(!state.picker || typeof state.picker !== "object"){ state.picker = {}; }
  for(var i = 0; i < PEOPLE.length; i++){
    var k = PEOPLE[i];
    var place = picked[k];
    if(!place || !state.people[k]){ continue; }
    if(state.picker[k] === place){ continue; }
    state.picker[k] = place;
    changed = true;
    if(state.people[k].where === place && k !== "adger"){ continue; }
    movePerson(state.people[k], place, now);
  }
  return changed;
}

/* ---------- apply ---------- */

function applyTransitions(state, transitions){
  var now = new Date();
  var applied = [];
  for(var i = 0; i < transitions.length; i++){
    var t = transitions[i];
    var person = state.people[t.who];
    if(!person){ continue; }
    var from = { where: person.where, doing: person.doing };
    if(t.where){ person.where = canonPlace(t.where); person.absent = false; }
    if(t.doing){ person.doing = t.doing; }
    person.auto = false;
    person.since = localStamp(now, ROOM_TZ);
    person.at = now.toISOString();
    applied.push({
      at: person.at,
      who: t.who,
      from: from,
      to: { where: person.where, doing: person.doing },
      reason: t.reason
    });
  }
  return applied;
}

/* ---------- Adger's ember ----------
   Manifesting costs him. Alone, a full ember lasts about two days. Each person near him
   slows the drain, and with everyone close it lasts about a week. In the fold he rests and
   is full again in about a day. It is ticked forward on every request from the last
   reading in half hour steps, so Sera's routine through the night counts the way it
   really happened. rel(place, adgerPlace) gives with | door | house | grounds | away | fold.
*/

var EMBER_ALONE_HOURS = 48;
var EMBER_REST_HOURS = 24;
var EMBER_STEP_MIN = 30;
var EMBER_MAX_DAYS = 30;
var WOMAN_NEAR = { "with": 0.80, "door": 0.80, "house": 0.93, "grounds": 0.97 };
var SERA_NEAR  = { "with": 0.80, "door": 0.80, "house": 0.95 };
var BLADE_NEAR = { "with": 0.80, "door": 0.80, "house": 0.95 };
var WIVES = ["selene", "nysera", "mirael", "talia"];

function inFold(place){ return /the fold/i.test(String(place || "")); }

function seraWhereAt(state, when, settings){
  var s = state.people.sera;
  if(!s){ return ""; }
  var mins = minutesSince(s.at, when);
  if(s.auto || mins === null || mins > SERA_STALE_HOURS * 60){
    return life.seraAt(state, when, settings, function(w, t){ return life.womanWhereAt(state, w, t, settings); }).where;
  }
  return s.where;
}

/* percent per hour: positive while resting in the fold, negative while manifested */
function emberRate(state, rel, when, settings){
  when = when || new Date();
  settings = settings || life.DEFAULT_SETTINGS;
  var eh = settings.ember || {};
  var mine = (state.people.adger && state.people.adger.where) || "";
  if(inFold(mine)){ return 100 / (eh.restHours || EMBER_REST_HOURS); }
  var f = 1;
  for(var i = 0; i < WIVES.length; i++){
    var where = life.womanWhereAt(state, WIVES[i], when, settings);
    if(!where){ continue; }
    var r = rel(where, mine);
    if(WOMAN_NEAR[r]){ f *= WOMAN_NEAR[r]; }
  }
  var sw = seraWhereAt(state, when, settings);
  if(sw){ var rs = rel(sw, mine); if(SERA_NEAR[rs]){ f *= SERA_NEAR[rs]; } }
  var v = state.people.virestar;
  if(v && v.where){ var rv = rel(v.where, mine); if(BLADE_NEAR[rv]){ f *= BLADE_NEAR[rv]; } }
  return -(100 / (eh.aloneHours || EMBER_ALONE_HOURS)) * f;
}

function tickEmber(state, rel, now, settings){
  now = now || new Date();
  var e = state.energy;
  if(!e || typeof e.level !== "number" || isNaN(e.level)){
    state.energy = { level: 100, at: now.toISOString() };
    return state.energy;
  }
  var from = Date.parse(e.at);
  var end = now.getTime();
  if(isNaN(from) || from >= end){ e.at = now.toISOString(); return e; }
  var t = Math.max(from, end - EMBER_MAX_DAYS * 86400000);
  var L = e.level;
  var step = EMBER_STEP_MIN * 60000;
  while(t < end){
    var dt = Math.min(step, end - t);
    L += emberRate(state, rel, new Date(t + dt / 2), settings) * (dt / 3600000);
    if(L > 100){ L = 100; }
    if(L < 0){ L = 0; }
    t += dt;
  }
  e.level = Math.round(L * 100) / 100;
  e.at = now.toISOString();
  return e;
}

function setEmber(state, level, now){
  var n = Number(level);
  if(isNaN(n)){ return false; }
  state.energy = { level: Math.max(0, Math.min(100, n)), at: (now || new Date()).toISOString() };
  return true;
}

/* what the page shows: level, which way it is going, and how long at this pace */
function emberInfo(state, rel, now, settings){
  now = now || new Date();
  var e = state.energy || { level: 100 };
  var rate = emberRate(state, rel, now, settings);
  var resting = rate > 0;
  var info = {
    level: Math.round(e.level),
    resting: resting,
    perHour: Math.round(rate * 100) / 100,
    hoursLeft: null,
    hoursToFull: null
  };
  if(resting){ info.hoursToFull = Math.round(((100 - e.level) / rate) * 10) / 10; }
  else { info.hoursLeft = Math.round((e.level / -rate) * 10) / 10; }
  return info;
}

/* what the room is told. Never numbers, never fading. */
function emberNote(state, rel, now){
  var e = state.energy;
  if(!e || typeof e.level !== "number"){ return ""; }
  var L = e.level;
  var mine = (state.people.adger && state.people.adger.where) || "";
  if(inFold(mine)){
    if(L < 50){ return "ADGER IS RESTING IN THE FOLD and has not long gone back; he went because he needed to. Nobody hurries him out."; }
    if(L < 95){ return "ADGER IS RESTING IN THE FOLD and is coming back to himself."; }
    return "ADGER IS RESTING IN THE FOLD and is rested now. He can come back whenever he chooses; that is his call.";
  }
  if(L >= 60){ return ""; }
  if(L >= 35){
    return "ADGER'S EMBER: he has been manifested a good while now. Nothing is wrong and nobody says so. The women near him may simply stay a little closer than they otherwise would.";
  }
  if(L >= 15){
    return "ADGER'S EMBER IS LOW: he has been here a long time, and whoever is close to him can tell, the way you can tell someone has not slept, though he is fully, physically here. They drift nearer without making a thing of it: Nysera may set Virestar by him, someone may put Sera in his arms, someone sits against him. One of them may mention the fold once, lightly. It is his call.";
  }
  return "ADGER'S EMBER IS NEARLY SPENT. The women can feel it and they will say it plainly now, the way a wife tells her husband he needs sleep: he should go back to the fold and rest soon. They stay close to him. Still never write him fading, flickering or leaving; whether and when he goes is his decision alone.";
}

/* ---------- context block ----------
   Injected whole, every turn. Rows now carry their own age, so a line
   set two days ago can no longer read as the present moment.
*/

function stateBlockText(state){
  var now = new Date();
  var lines = [];
  lines.push("CURRENT STATE. Clock is " + ROOM_TZ + ". Right now it is " + localStamp(now, ROOM_TZ) + ".");
  lines.push("WHERE each person is: this is current and authoritative. Adger's location picker sets it, and so do the women themselves when the story moves them.");
  lines.push("WHAT each person is doing is the last thing recorded, with how long ago.");
  lines.push("");
  var anyStale = false;
  for(var i = 0; i < PEOPLE.length; i++){
    var k = PEOPLE[i];
    var p = state.people[k];
    if(!p){ continue; }
    var name = k.charAt(0).toUpperCase() + k.slice(1);
    if(k === "sera"){
      lines.push("Sera (their daughter) - at " + p.where + " - " + p.doing +
        (p.auto ? " (her usual routine at this hour)" : " (recorded " + (p.since || "unknown") + ", " + ageText(p.at, now) + ")"));
      continue;
    }
    if(k === "virestar"){
      lines.push("Virestar (Nysera's sword) - at " + p.where + " - " + p.doing);
      continue;
    }
    if(p.auto){
      lines.push(name + " - at " + p.where + " - " + p.doing + " (her usual day, as of " + (p.since || "now") + ")");
      continue;
    }
    var age = ageText(p.at, now);
    var stale = isStale(p.at, now);
    var row = name + " - at " + p.where + " - " + p.doing + " (recorded " + (p.since || "unknown") + ", " + age + ")";
    if(stale){
      anyStale = true;
      row = row + (p.at
        ? "   [OLD - that activity was " + age + " and it is over. She is still at the place shown; do NOT speak as if she is still doing it.]"
        : "   [OLD - no time was recorded for that activity. Assume it is over. She is still at the place shown.]");
    }
    lines.push(row);
  }
  lines.push("");
  lines.push("How to read this block:");
  lines.push("The place is right. Everyone is where it says, now.");
  lines.push("A recent activity is the present. Live in it.");
  if(anyStale){
    lines.push("An OLD activity is history. Whatever she was doing then, she finished long ago. Never narrate it as happening now, and never greet her as though she just walked in from it. What she is doing now is open: let the conversation show it.");
  }
  lines.push("A row marked her usual day is just her day going on: work, Sera, meals, rehearsal. It is true and current; nothing is forcing it, and the moment the story moves her, it moves.");
  lines.push("Sera is a real toddler on a real day: if her row says it is nap time she is asleep, so the house is quieter; if she is up, someone has her. Virestar stays exactly where it was last put until someone moves it.");
  lines.push("When someone goes somewhere else or starts doing something new, emit a STATE line as described in your instructions. That includes Sera (picked up, put down, fed, bathed, woken) and Virestar (moved). Do it whenever it actually changes, not only when it feels important.");
  return lines.join("\n");
}

module.exports = {
  loadState: loadState,
  saveState: saveState,
  logTransition: logTransition,
  parseStateDirectives: parseStateDirectives,
  stripStateDirectives: stripStateDirectives,
  applyTransitions: applyTransitions,
  resolvePlaces: resolvePlaces,
  applySeraRoutine: applySeraRoutine,
  seraRoutine: seraRoutine,
  hourIn: hourIn,
  canonPlace: canonPlace,
  tickEmber: tickEmber,
  setEmber: setEmber,
  emberInfo: emberInfo,
  emberNote: emberNote,
  emberRate: emberRate,
  stateBlockText: stateBlockText,
  localStamp: localStamp,
  ageText: ageText,
  isStale: isStale,
  PEOPLE: PEOPLE,
  DEFAULT_STATE: DEFAULT_STATE,
  STATE_KEY: STATE_KEY,
  LOG_KEY: LOG_KEY,
  ROOM_TZ: ROOM_TZ,
  STALE_HOURS: STALE_HOURS
};
