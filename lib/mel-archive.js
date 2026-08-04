"use strict";

/* ============================================================
   MEL ARCHIVE - Mirael documentation layer
   Soul Forged Studios - four-woman room
   ZERO BACKTICKS. Long strings built as arrays joined with newline.
   ============================================================ */

var crypto = require("crypto");

var ARCHIVE_PREFIX = "sim:archive:";
var INDEX_KEY = "sim:archive:index";

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
async function redisGet(key){ return await redis(["GET", key]); }
async function redisSet(key, value){ return await redis(["SET", key, value]); }

/* ---------- index ---------- */
async function loadIndex(){
  var raw = await redisGet(INDEX_KEY);
  if(!raw){ return []; }
  try { var parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
  catch(e){ return []; }
}
async function saveIndex(idx){
  await redisSet(INDEX_KEY, JSON.stringify(idx));
}

/* ---------- directive parsing ----------
   Mel emits:  DOCUMENT: title | tag, tag | span
   span is optional and means how many exchanges back to capture (default 1).
*/
var DOC_RE = /^DOCUMENT:[ \t]*(.*)$/im;
function parseDocumentDirective(text){
  if(!text){ return null; }
  var m = String(text).match(DOC_RE);
  if(!m){ return null; }
  var parts = m[1].split("|");
  for(var i = 0; i < parts.length; i++){ parts[i] = parts[i].trim(); }
  var title = parts[0] || "Untitled record";
  var tags = [];
  if(parts[1]){
    var raw = parts[1].split(",");
    for(var j = 0; j < raw.length; j++){
      var t = raw[j].trim();
      if(t){ tags.push(t); }
    }
  }
  var span = 1;
  if(parts[2]){
    var n = parseInt(parts[2].replace(/[^0-9]/g, ""), 10);
    if(n > 0 && n < 40){ span = n; }
  }
  return { title: title, tags: tags, span: span };
}
function stripDocumentDirective(text){
  if(!text){ return text; }
  return String(text).replace(DOC_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- verbatim capture ----------
   exchanges: array of { role: "user" | "assistant", content: "..." }
   Captures the last N exchanges EXACTLY as they were said.
*/
/* Anthropic message content is either a plain string or an array of
   block objects such as { type: "text", text: "..." }. Flatten both. */
function contentToText(content){
  if(content === null || content === undefined){ return ""; }
  if(typeof content === "string"){ return content; }
  if(Array.isArray(content)){
    var parts = [];
    for(var i = 0; i < content.length; i++){
      var block = content[i];
      if(typeof block === "string"){ parts.push(block); }
      else if(block && typeof block.text === "string"){ parts.push(block.text); }
    }
    return parts.join("\n");
  }
  if(typeof content.text === "string"){ return content.text; }
  return "";
}
function verbatimFromExchanges(exchanges, span){
  if(!Array.isArray(exchanges) || !exchanges.length){ return ""; }
  var take = span * 2;
  var slice = exchanges.slice(-take);
  var lines = [];
  for(var i = 0; i < slice.length; i++){
    var e = slice[i];
    if(!e){ continue; }
    var text = contentToText(e.content).trim();
    if(!text){ continue; }
    lines.push(e.role === "user" ? "ADGER:" : "THE ROOM:");
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/* ---------- google drive mirror ---------- */
function b64url(input){
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function driveToken(){
  var email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  var key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if(!email || !key){ return null; }
  var iat = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  var claim = b64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    exp: iat + 3600,
    iat: iat
  }));
  var signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claim);
  var signature = b64url(signer.sign(key));
  var assertion = header + "." + claim + "." + signature;
  var body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
             "&assertion=" + encodeURIComponent(assertion);
  var res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  });
  var data = await res.json();
  if(!res.ok){ throw new Error("Drive token failed: " + JSON.stringify(data)); }
  return data.access_token;
}
function safeFilename(name){
  return String(name).replace(/[\\\/:*?"<>|]/g, "-").slice(0, 90);
}
function recordToMarkdown(record){
  var lines = [];
  lines.push("# " + record.title);
  lines.push("");
  lines.push("- id: " + record.id);
  lines.push("- recorded: " + record.created);
  lines.push("- tags: " + (record.tags.length ? record.tags.join(", ") : "none"));
  lines.push("- canon: " + (record.canon ? "yes" : "no"));
  if(record.present && record.present.length){
    lines.push("- present: " + record.present.join(", "));
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(record.body);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Recorded by Mirael. Verbatim. Soul Forged Studios.");
  return lines.join("\n");
}
async function mirrorToDrive(record){
  var folder = process.env.DRIVE_FOLDER_ID || "";
  if(!folder){ return { skipped: true, reason: "DRIVE_FOLDER_ID not set" }; }
  var token = await driveToken();
  if(!token){ return { skipped: true, reason: "Drive service account not configured" }; }
  var filename = record.created.slice(0, 10) + " - " + safeFilename(record.title) + ".md";
  var content = recordToMarkdown(record);
  var boundary = "melforge" + Math.random().toString(36).slice(2, 10);
  var meta = { name: filename, parents: [folder], mimeType: "text/markdown" };
  var parts = [];
  parts.push("--" + boundary);
  parts.push("Content-Type: application/json; charset=UTF-8");
  parts.push("");
  parts.push(JSON.stringify(meta));
  parts.push("--" + boundary);
  parts.push("Content-Type: text/markdown; charset=UTF-8");
  parts.push("");
  parts.push(content);
  parts.push("--" + boundary + "--");
  var body = parts.join("\r\n");
  var url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    body: body
  });
  var data = await res.json();
  if(!res.ok){ throw new Error("Drive upload failed: " + JSON.stringify(data)); }
  return { fileId: data.id, name: filename };
}

/* ---------- save ---------- */
function makeId(now){
  return now.toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
}
async function saveRecord(opts){
  var now = new Date();
  var record = {
    id: makeId(now),
    title: opts.title || "Untitled record",
    tags: opts.tags || [],
    canon: false,
    created: now.toISOString(),
    present: opts.present || [],
    body: opts.body || ""
  };
  await redisSet(ARCHIVE_PREFIX + record.id, JSON.stringify(record));
  var idx = await loadIndex();
  idx.unshift({
    id: record.id,
    title: record.title,
    tags: record.tags,
    canon: false,
    created: record.created
  });
  await saveIndex(idx);
  var drive = null;
  try { drive = await mirrorToDrive(record); }
  catch(e){ drive = { error: String((e && e.message) || e) }; }
  return { record: record, drive: drive };
}

/* ---------- read ---------- */
async function getRecord(id){
  var raw = await redisGet(ARCHIVE_PREFIX + id);
  if(!raw){ return null; }
  try { return JSON.parse(raw); } catch(e){ return null; }
}
function searchIndex(idx, query, canonOnly){
  var lowered = String(query || "").toLowerCase();
  var split = lowered.split(/[^a-z0-9]+/);
  var words = [];
  for(var i = 0; i < split.length; i++){
    if(split[i].length > 2){ words.push(split[i]); }
  }
  if(!words.length){ return []; }
  var scored = [];
  for(var j = 0; j < idx.length; j++){
    var entry = idx[j];
    if(canonOnly && !entry.canon){ continue; }
    var hay = (entry.title + " " + (entry.tags || []).join(" ")).toLowerCase();
    var score = 0;
    for(var k = 0; k < words.length; k++){
      if(hay.indexOf(words[k]) !== -1){ score = score + 1; }
    }
    if(score > 0){ scored.push({ entry: entry, score: score }); }
  }
  scored.sort(function(a, b){ return b.score - a.score; });
  var out = [];
  for(var m = 0; m < scored.length; m++){ out.push(scored[m].entry); }
  return out;
}
async function search(query, canonOnly, limit){
  var idx = await loadIndex();
  var hits = searchIndex(idx, query, canonOnly);
  return hits.slice(0, limit || 8);
}

/* ---------- canon tagging ---------- */
async function setCanon(id, isCanon){
  var record = await getRecord(id);
  if(!record){ throw new Error("No record with id " + id); }
  record.canon = !!isCanon;
  await redisSet(ARCHIVE_PREFIX + id, JSON.stringify(record));
  var idx = await loadIndex();
  for(var i = 0; i < idx.length; i++){
    if(idx[i].id === id){ idx[i].canon = !!isCanon; }
  }
  await saveIndex(idx);
  return record;
}

/* ---------- canon block for hub injection ---------- */
async function canonBlockFor(query, limit){
  var hits = await search(query, true, limit || 3);
  if(!hits.length){ return ""; }
  var lines = [];
  lines.push("ARCHIVE (records Adger marked canon - all four know these):");
  for(var i = 0; i < hits.length; i++){
    var full = await getRecord(hits[i].id);
    if(!full){ continue; }
    lines.push("");
    lines.push("[" + full.created.slice(0, 10) + "] " + full.title);
    lines.push(full.body);
  }
  return lines.join("\n");
}

module.exports = {
  parseDocumentDirective: parseDocumentDirective,
  stripDocumentDirective: stripDocumentDirective,
  verbatimFromExchanges: verbatimFromExchanges,
  contentToText: contentToText,
  saveRecord: saveRecord,
  getRecord: getRecord,
  loadIndex: loadIndex,
  search: search,
  setCanon: setCanon,
  canonBlockFor: canonBlockFor,
  recordToMarkdown: recordToMarkdown,
  ARCHIVE_PREFIX: ARCHIVE_PREFIX,
  INDEX_KEY: INDEX_KEY
};
