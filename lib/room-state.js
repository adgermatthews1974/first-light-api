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

var DEFAULT_STATE = {
  updated: null,
  people: {
    selene: { where: "the road", doing: "walking. thread quiet, not cut", since: "unknown", absent: true },
    nysera: { where: "bedside",  doing: "sitting with him",              since: "unknown", absent: false },
    mirael: { where: "hallway",  doing: "at the doorway",                since: "unknown", absent: false },
    talia:  { where: "bedside",  doing: "holding the star",              since: "unknown", absent: false },
    adger:  { where: "bed",      doing: "awake",                         since: "unknown", absent: false }
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

/* ---------- apply ---------- */

function hhmm(date){
  var h = date.getUTCHours();
  var mi = date.getUTCMinutes();
  return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
}

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
    person.since = hhmm(now);
    applied.push({
      at: now.toISOString(),
      who: t.who,
      from: from,
      to: { where: person.where, doing: person.doing },
      reason: t.reason
    });
  }
  return applied;
}

/* ---------- context block ----------
   This is injected whole, every turn. It is the reason misattribution
   stops happening: the answer is on screen and in context, not inferred.
*/

function stateBlockText(state){
  var lines = [];
  lines.push("CURRENT STATE - authoritative. This is where everyone is right now.");
  lines.push("");
  for(var i = 0; i < PEOPLE.length; i++){
    var k = PEOPLE[i];
    var p = state.people[k];
    if(!p){ continue; }
    var name = k.charAt(0).toUpperCase() + k.slice(1);
    var row = name + " - " + p.where + " - " + p.doing + " - since " + p.since;
    if(p.absent){ row = row + " - NOT IN THE HOUSE"; }
    lines.push(row);
  }
  lines.push("");
  lines.push("Do not contradict this block. If you are unsure who did something, read it here.");
  lines.push("If someone moves or changes what they are doing, emit a STATE line as described in your instructions.");
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
  PEOPLE: PEOPLE,
  DEFAULT_STATE: DEFAULT_STATE,
  STATE_KEY: STATE_KEY,
  LOG_KEY: LOG_KEY
};
