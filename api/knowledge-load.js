/**
 * KNOWLEDGE HUB LOADER - deploy as api/knowledge-load.js
 *
 * Token-gated admin endpoint for the four-woman room's canon.
 * Blob-per-scope in Redis: sim:knowledge:{shared,selene,nysera,mirael,talia},
 * each a JSON array of chunks. This holds RECALL knowledge only; CORE identity
 * and the DIRECTOR live in code, never here.
 *
 * Ops: put | get | list | delete | move.
 * Auth: header x-knowledge-token OR body.token, compared to KNOWLEDGE_ADMIN_TOKEN.
 * The token is never logged or echoed.
 *
 * Zero backticks on purpose. Paste cannot corrupt it.
 */

const ALLOW_ANY = false;
const ALLOWED_ORIGINS = [
  "https://www.soulforgedstudio.com",
  "https://soulforgedstudio.com",
];
const SCOPES = ["shared", "selene", "nysera", "mirael", "talia"];
const KEY_PREFIX = "sim:knowledge:";
const keyFor = s => KEY_PREFIX + s;

// --- Redis over Upstash REST (no npm package) --------------------------------
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
async function getScope(scope) {
  const res = await redisCmd(["GET", keyFor(scope)]);
  if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
  let arr = [];
  if (res.result) { try { arr = JSON.parse(res.result) || []; } catch (e) { arr = []; } }
  if (!Array.isArray(arr)) arr = [];
  return { ok: true, arr };
}
async function setScope(scope, arr) {
  const res = await redisCmd(["SET", keyFor(scope), JSON.stringify(arr)]);
  if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
  return { ok: true };
}
function validChunk(c) {
  if (!c || typeof c !== "object") return "not an object";
  if (typeof c.id !== "string" || !c.id.trim()) return "missing id";
  if (SCOPES.indexOf(c.scope) === -1) return "bad scope: " + String(c.scope);
  if (typeof c.text !== "string" || !c.text.trim()) return "missing text";
  if (c.title != null && typeof c.title !== "string") return "bad title";
  if (c.boost != null && !Array.isArray(c.boost)) return "bad boost";
  return null;
}
function cleanChunk(c) {
  const out = { id: c.id.trim(), scope: c.scope, text: c.text };
  if (c.title != null) out.title = c.title;
  if (Array.isArray(c.boost)) out.boost = c.boost;
  return out;
}
async function opPut(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return { status: 400, body: { error: "put needs chunks: [...]" } };
  for (let i = 0; i < chunks.length; i++) {
    const e = validChunk(chunks[i]);
    if (e) return { status: 400, body: { error: "chunk " + i + ": " + e } };
  }
  const byScope = {};
  chunks.forEach(c => { (byScope[c.scope] = byScope[c.scope] || []).push(cleanChunk(c)); });
  const results = [];
  const scopeKeys = Object.keys(byScope);
  for (let k = 0; k < scopeKeys.length; k++) {
    const scope = scopeKeys[k];
    const g = await getScope(scope);
    if (!g.ok) return { status: 502, body: { error: "read " + scope + " failed", detail: g.detail || g.error } };
    const arr = g.arr;
    const index = {};
    arr.forEach((c, idx) => { index[c.id] = idx; });
    byScope[scope].forEach(c => {
      if (c.id in index) { arr[index[c.id]] = c; results.push({ id: c.id, scope: scope, action: "updated" }); }
      else { arr.push(c); index[c.id] = arr.length - 1; results.push({ id: c.id, scope: scope, action: "created" }); }
    });
    const s = await setScope(scope, arr);
    if (!s.ok) return { status: 502, body: { error: "write " + scope + " failed (Upstash Safe Mode?)", detail: s.detail || s.error } };
  }
  return { status: 200, body: { ok: true, op: "put", results } };
}
async function opGet(id, scope) {
  if (scope) {
    if (SCOPES.indexOf(scope) === -1) return { status: 400, body: { error: "bad scope" } };
    const g = await getScope(scope);
    if (!g.ok) return { status: 502, body: { error: "read failed", detail: g.detail || g.error } };
    if (id) { const c = g.arr.find(x => x.id === id); return { status: 200, body: { ok: true, op: "get", chunk: c || null, scope: scope } }; }
    return { status: 200, body: { ok: true, op: "get", scope: scope, chunks: g.arr } };
  }
  if (id) {
    for (let i = 0; i < SCOPES.length; i++) {
      const g = await getScope(SCOPES[i]);
      if (!g.ok) continue;
      const c = g.arr.find(x => x.id === id);
      if (c) return { status: 200, body: { ok: true, op: "get", chunk: c, scope: SCOPES[i] } };
    }
    return { status: 200, body: { ok: true, op: "get", chunk: null } };
  }
  return { status: 400, body: { error: "get needs id or scope" } };
}
async function opList() {
  const scopes = [];
  let total = 0;
  for (let i = 0; i < SCOPES.length; i++) {
    const s = SCOPES[i];
    const g = await getScope(s);
    if (!g.ok) return { status: 502, body: { error: "read " + s + " failed", detail: g.detail || g.error } };
    const items = g.arr.map(c => ({ id: c.id, title: c.title || "", len: (c.text || "").length }));
    total += items.length;
    scopes.push({ scope: s, count: items.length, items });
  }
  return { status: 200, body: { ok: true, op: "list", total, scopes } };
}
async function opDelete(ids, scope) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { error: "delete needs ids: [...]" } };
  if (scope && SCOPES.indexOf(scope) === -1) return { status: 400, body: { error: "bad scope" } };
  const target = scope ? [scope] : SCOPES;
  const removed = [];
  for (let i = 0; i < target.length; i++) {
    const s = target[i];
    const g = await getScope(s);
    if (!g.ok) return { status: 502, body: { error: "read " + s + " failed", detail: g.detail || g.error } };
    const before = g.arr.length;
    const kept = g.arr.filter(c => {
      if (ids.indexOf(c.id) !== -1) { removed.push({ id: c.id, scope: s }); return false; }
      return true;
    });
    if (kept.length !== before) {
      const st = await setScope(s, kept);
      if (!st.ok) return { status: 502, body: { error: "write " + s + " failed (Safe Mode?)", detail: st.detail || st.error } };
    }
  }
  return { status: 200, body: { ok: true, op: "delete", removed } };
}
async function opMove(id, from, to) {
  if (!id || SCOPES.indexOf(from) === -1 || SCOPES.indexOf(to) === -1) return { status: 400, body: { error: "move needs id, valid from, valid to" } };
  if (from === to) return { status: 400, body: { error: "from and to are the same" } };
  const gf = await getScope(from);
  if (!gf.ok) return { status: 502, body: { error: "read " + from + " failed", detail: gf.detail || gf.error } };
  const idx = gf.arr.findIndex(c => c.id === id);
  if (idx === -1) return { status: 404, body: { error: "id not found in " + from } };
  const chunk = gf.arr[idx];
  chunk.scope = to;
  const gt = await getScope(to);
  if (!gt.ok) return { status: 502, body: { error: "read " + to + " failed", detail: gt.detail || gt.error } };
  const tarr = gt.arr.filter(c => c.id !== id);
  tarr.push(chunk);
  const farr = gf.arr.filter(c => c.id !== id);
  let st = await setScope(to, tarr);
  if (!st.ok) return { status: 502, body: { error: "write " + to + " failed (Safe Mode?)", detail: st.detail || st.error } };
  st = await setScope(from, farr);
  if (!st.ok) return { status: 502, body: { error: "write " + from + " failed (Safe Mode?)", detail: st.detail || st.error } };
  return { status: 200, body: { ok: true, op: "move", id, from, to } };
}
export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOW_ANY ? "*" : (ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-knowledge-token");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const token = req.headers["x-knowledge-token"] || body.token || "";
  const expected = process.env.KNOWLEDGE_ADMIN_TOKEN || "";
  if (!expected) return res.status(500).json({ error: "KNOWLEDGE_ADMIN_TOKEN not set" });
  if (token !== expected) return res.status(401).json({ error: "unauthorized" });

  const op = String(body.op || "").toLowerCase();
  try {
    let out;
    if (op === "put") out = await opPut(body.chunks);
    else if (op === "get") out = await opGet(body.id, body.scope);
    else if (op === "list") out = await opList();
    else if (op === "delete") out = await opDelete(body.ids, body.scope);
    else if (op === "move") out = await opMove(body.id, body.from, body.to);
    else return res.status(400).json({ error: "unknown op: " + op + " (use put|get|list|delete|move)" });
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
