/**
 * THE ROOM - memory update. Deploy as api/room-remember.js
 *
 * Folds a finished conversation into memory. For each PRESENT woman, her own
 * private thread (room:mem:<name>) is updated from her vantage; the shared-room
 * thread (room:mem:shared) is updated for the group. Absent women are untouched.
 *
 * Called by the page on Remember / New. CORS-locked, no token.
 * Zero backticks on purpose. Paste cannot corrupt it.
 */

const ALLOW_ANY = false;
const ALLOWED_ORIGINS = [
  "https://www.soulforgedstudio.com",
  "https://soulforgedstudio.com",
];
const SUMMARY_MODEL = "claude-sonnet-4-6";
const MAX_MEMORY_TOKENS = 700;
const MEM_PREFIX = "room:mem:";
const WOMEN = ["selene", "nysera", "mirael", "talia"];
const LABEL = { selene: "Selene", nysera: "Nysera", mirael: "Mirael", talia: "Talia" };

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
async function redisCmd(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && ("result" in d) ? d.result : null;
  } catch (e) { return null; }
}
const redisGet = k => redisCmd(["GET", k]);
const redisSet = (k, v) => redisCmd(["SET", k, v]);

function personCurator(name) {
  return [
    "You maintain " + name + "'s private memory: her own evolving record of her life with Adger, carried across all their conversations. You are given her CURRENT MEMORY and a NEW CONVERSATION - a scene in the room, with lines labeled by who spoke. Return an UPDATED MEMORY that folds the new conversation into what " + name + " herself would carry.",
    "",
    "Rules:",
    "- Write it as " + name + "'s own carried memory, from her vantage. Keep what SHE would keep: what Adger told her or asked of her, what she said or resolved, emotional shifts for her, promises made, and new facts about her work and world. Others were in the room; note what they said or did only when it matters to her.",
    "- Concise - tight notes, well under 350 words. Consolidate and compress; do not just append. Drop small talk.",
    "- If something was imagined, brainstormed, or spoken as hypothetical, record it AS speculation. Never promote a thing merely imagined into a thing that happened.",
    "- Preserve open threads and things left unfinished, to return to.",
    "- Output ONLY the updated memory text. No preamble, no headers, no commentary."
  ].join("\n");
}

const SHARED_CURATOR = [
  "You maintain the SHARED memory of what the four women - Selene, Nysera, Mirael, Talia - have lived together in the room with Adger: their collective record of their ongoing life together. You are given the CURRENT SHARED MEMORY and a NEW CONVERSATION. Return an UPDATED SHARED MEMORY that folds the new conversation in.",
  "",
  "Rules:",
  "- This is the group's collective thread: what happened in the room, decisions made together, shared emotional beats, things Adger told them, running jokes, promises. Note which of them said or did a thing when it matters; they are distinct people, not one voice.",
  "- Concise - tight notes, well under 400 words. Consolidate and compress; do not just append. Drop small talk.",
  "- If something was imagined or spoken as a hypothetical, record it AS speculation. Never promote a thing merely imagined into a thing that happened.",
  "- Preserve open threads and things left unfinished, to return to.",
  "- Output ONLY the updated memory text. No preamble, no headers, no commentary."
].join("\n");

async function summarize(system, current, transcript) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: MAX_MEMORY_TOKENS,
      system: system,
      messages: [{
        role: "user",
        content: "CURRENT MEMORY:\n" + (current || "(none yet)") + "\n\nNEW CONVERSATION:\n" + transcript,
      }],
    }),
  });
  if (!r.ok) { const detail = await r.text(); return { ok: false, detail: "upstream " + r.status + ": " + detail }; }
  const data = await r.json();
  const updated = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { ok: true, updated };
}

async function updateKey(key, system, transcript) {
  let current = "";
  try { current = (await redisGet(key)) || ""; } catch (e) {}
  const res = await summarize(system, current, transcript);
  if (!res.ok) return { key, ok: false, detail: res.detail };
  if (res.updated) { try { await redisSet(key, res.updated); } catch (e) {} }
  return { key, ok: true };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOW_ANY ? "*" : (ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const lc = x => String(x).toLowerCase();
  let present = Array.isArray(body.present) ? body.present.map(lc).filter(w => WOMEN.indexOf(w) !== -1) : [];
  present = WOMEN.filter(w => present.indexOf(w) !== -1);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(200).json({ ok: true, skipped: "empty" });

  const transcript = messages
    .filter(m => m && m.content)
    .map(m => (m.role === "user" ? "Adger: " : "") + String(m.content))
    .join("\n\n");

  const tasks = [];
  present.forEach(function (w) {
    tasks.push(updateKey(MEM_PREFIX + w, personCurator(LABEL[w]), transcript));
  });
  tasks.push(updateKey(MEM_PREFIX + "shared", SHARED_CURATOR, transcript));

  try {
    const results = await Promise.all(tasks);
    const failed = results.filter(r => !r.ok);
    if (failed.length) return res.status(502).json({ ok: false, updated: results.filter(r => r.ok).map(r => r.key), failed });
    return res.status(200).json({ ok: true, updated: results.map(r => r.key) });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
