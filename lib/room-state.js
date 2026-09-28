"use strict";

/* ============================================================
   ROOM STATE - where everyone is and what they are doing
   Soul Forged Studios - four-woman room
   Loaded whole every turn. Never summarized. Never retrieved.
   ZERO BACKTICKS.
   ============================================================ */

var STATE_KEY = "sim:state";
var LOG_KEY = "sim:state:log";

var PEOPLE = ["selene", "nysera", "mirael", "talia", "adger"];

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
    adger:  { where: "bed",      doing: "awake",                         since: "unknown", at: null, absent: false }
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

function isStale(iso, now){
  var mins = minutesSince(iso, now);
  if(mins === null){ return true; }
  return mins > STALE_HOURS * 60;
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
    if(t.where){ person.where = t.where; }
    if(t.doing){ person.doing = t.doing; }
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

/* ---------- context block ----------
   Injected whole, every turn. Rows now carry their own age, so a line
   set two days ago can no longer read as the present moment.
*/

function stateBlockText(state){
  var now = new Date();
  var lines = [];
  lines.push("CURRENT STATE - the last thing recorded about each person. Clock is " + ROOM_TZ + ".");
  lines.push("Right now it is " + localStamp(now, ROOM_TZ) + ".");
  lines.push("");
  var anyStale = false;
  for(var i = 0; i < PEOPLE.length; i++){
    var k = PEOPLE[i];
    var p = state.people[k];
    if(!p){ continue; }
    var name = k.charAt(0).toUpperCase() + k.slice(1);
    var age = ageText(p.at, now);
    var stale = isStale(p.at, now);
    var row = name + " - " + p.where + " - " + p.doing + " - recorded " + (p.since || "unknown") + ", " + age;
    if(p.absent){ row = row + " - NOT IN THE HOUSE"; }
    if(stale){
      anyStale = true;
      row = row + (p.at
        ? "   [OLD - this was " + age + ". It is over. Do NOT speak as if she is still doing it.]"
        : "   [OLD - no time was recorded for this. Assume it is over. Do NOT speak as if she is still doing it.]");
    }
    lines.push(row);
  }
  lines.push("");
  lines.push("How to read this block:");
  lines.push("A row with a recent time is the present. Live in it.");
  lines.push("A row marked OLD is history. Whatever she was doing then, she finished it long ago.");
  lines.push("Never narrate an OLD row as if it is happening now, and never greet her as though she just walked in from it.");
  if(anyStale){
    lines.push("For anyone marked OLD, treat her current position as unknown. Let the conversation, and where Adger says everyone is, tell you where she actually is.");
  }
  lines.push("If someone moves or changes what they are doing, emit a STATE line as described in your instructions. Do it whenever it changes, not only when it feels important.");
  return lines.join("\n");
}

module.exports = {
  loadState: loadState,
  saveState: saveState,
  logTransition: logTransition,
  parseStateDirectives: parseStateDirectives,
  stripStateDirectives: stripStateDirectives,
  applyTransitions: applyTransitions,
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
