/**
 * MEMORY ADMIN - deploy as api/memory-admin.js
 *
 * One-time migration and verification for the four-woman room's memory.
 * Copies existing memory into the new room keys (copy-then-verify, never move):
 *   forge:memory   -> room:mem:shared
 *   selene:memory  -> room:mem:selene
 *   nysera:memory  -> room:mem:nysera
 * Originals are NEVER touched. Mirael and Talia have no prior memory, so their
 * room keys start empty (nothing to migrate). Targets are only written if empty,
 * unless force:true, so re-running cannot clobber accumulated room memory.
 *
 * Token-gated with the existing KNOWLEDGE_ADMIN_TOKEN (or MEMORY_ADMIN_TOKEN).
 * Ops: migrate | verify | peek.
 * Zero backticks on purpose. Paste cannot corrupt it.
 */

const PAIRS = [
  { from: "forge:memory", to: "room:mem:shared" },
  { from: "selene:memory", to: "room:mem:selene" },
  { from: "nysera:memory", to: "room:mem:nysera" },
];
const SOURCE_KEYS = ["forge:memory", "selene:memory", "nysera:memory"];
const ROOM_KEYS = ["room:mem:shared", "room:mem:selene", "room:mem:nysera", "room:mem:mirael", "room:mem:talia"];

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
async function redisCmd(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return { ok: false, error: "redis env missing" };
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: "redis " + r.status, detail: text };
    let d = null;
    try { d = JSON.parse(text); } catch (e) { return { ok: false, error: "redis parse", detail: text }; }
    if (d && d.error) return { ok: false, error: "redis: " + d.error };
    return { ok: true, result: d && ("result" in d) ? d.result : null };
  } catch (e) { return { ok: false, error: String(e) }; }
}
async function getKey(k) {
  const res = await redisCmd(["GET", k]);
  return res.ok ? (res.result || "") : null;
}
async function setKey(k, v) {
  const res = await redisCmd(["SET", k, v]);
  return res.ok;
}
function summary(v) {
  if (v === null) return { present: null, note: "read error" };
  return { present: v.length > 0, len: v.length };
}

async function opVerify() {
  const sources = {}, rooms = {};
  for (let i = 0; i < SOURCE_KEYS.length; i++) sources[SOURCE_KEYS[i]] = summary(await getKey(SOURCE_KEYS[i]));
  for (let i = 0; i < ROOM_KEYS.length; i++) rooms[ROOM_KEYS[i]] = summary(await getKey(ROOM_KEYS[i]));
  return { status: 200, body: { ok: true, op: "verify", sources, rooms } };
}

async function opPeek(key) {
  if (!key) return { status: 400, body: { error: "peek needs a key" } };
  if (SOURCE_KEYS.indexOf(key) === -1 && ROOM_KEYS.indexOf(key) === -1)
    return { status: 400, body: { error: "peek only allowed on known memory keys" } };
  const v = await getKey(key);
  if (v === null) return { status: 502, body: { error: "read failed for " + key } };
  return { status: 200, body: { ok: true, op: "peek", key, value: v } };
}

async function opMigrate(force) {
  const results = [];
  for (let i = 0; i < PAIRS.length; i++) {
    const from = PAIRS[i].from, to = PAIRS[i].to;
    const src = await getKey(from);
    const tgt = await getKey(to);
    if (src === null || tgt === null) { results.push({ from, to, copied: false, reason: "read error" }); continue; }
    if (!src) { results.push({ from, to, copied: false, reason: "source empty, nothing to copy" }); continue; }
    if (tgt && !force) { results.push({ from, to, copied: false, reason: "target not empty (use force:true to overwrite)", targetLen: tgt.length }); continue; }
    const wrote = await setKey(to, src);
    results.push({ from, to, copied: wrote, sourceLen: src.length, reason: wrote ? "copied" : "write failed (Upstash Safe Mode?)" });
  }
  return { status: 200, body: { ok: true, op: "migrate", note: "originals untouched", results } };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.soulforgedstudio.com");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-knowledge-token");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const token = req.headers["x-knowledge-token"] || body.token || "";
  const expected = process.env.MEMORY_ADMIN_TOKEN || process.env.KNOWLEDGE_ADMIN_TOKEN || "";
  if (!expected) return res.status(500).json({ error: "no admin token set" });
  if (token !== expected) return res.status(401).json({ error: "unauthorized" });

  const op = String(body.op || "").toLowerCase();
  try {
    let out;
    if (op === "migrate") out = await opMigrate(body.force === true);
    else if (op === "verify") out = await opVerify();
    else if (op === "peek") out = await opPeek(body.key);
    else return res.status(400).json({ error: "unknown op: " + op + " (use migrate|verify|peek)" });
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
