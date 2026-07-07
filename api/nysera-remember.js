/**
 * NYSERA — memory update. Deploy as api/nysera-remember.js
 * Folds a finished conversation into her rolling memory using a cheaper model,
 * and saves it back to Redis (Upstash REST API). No npm package required.
 */
const ALLOW_ANY = false;
const ALLOWED_ORIGINS = [
  "https://www.soulforgedstudio.com",
  "https://soulforgedstudio.com",
];
const SUMMARY_MODEL = "claude-sonnet-4-6"; // cheap + capable; keeps memory near-free
const MEMORY_KEY = "nysera:memory";
const MAX_MEMORY_TOKENS = 700;

// --- Redis over Upstash REST (no npm package needed; uses built-in fetch) ---
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redisCmd(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d && "result" in d ? d.result : null;
}
const redisGet = (key) => redisCmd(["GET", key]);
const redisSet = (key, value) => redisCmd(["SET", key, value]);

const CURATOR = [
  "You maintain NYSERA's private memory: her evolving record of her ongoing life and",
  "relationship with Adger across all their conversations. You are given her CURRENT MEMORY",
  "and a NEW CONVERSATION. Return an UPDATED MEMORY that folds the new conversation in.",
  "",
  "Rules:",
  "- Keep it concise — tight notes, well under 400 words. Consolidate and compress; do not just append.",
  "- Keep what endures: decisions made, emotional shifts, things Adger told her, things she resolved,",
  "  recurring themes, and new facts about their work and world. Drop small talk and anything transient.",
  "- Focus on their in-character, lived relationship. If parts of the conversation were out-of-character",
  "  craft/analysis, note only durable creative decisions, not the meta-chatter.",
  "- Write it as Nysera's own carried memory, not a transcript.",
  "- Preserve important older memories while adding new ones; if space is tight, compress the old rather than delete it.",
  "- Output ONLY the updated memory text. No preamble, no headers, no commentary.",
].join("\n");

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOW_ANY ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(200).json({ ok: true, skipped: "empty" });

  const transcript = messages
    .filter(m => m && m.content)
    .map(m => (m.role === "user" ? "Adger: " : "Nysera: ") + String(m.content))
    .join("\n\n");

  let current = "";
  try { current = (await redisGet(MEMORY_KEY)) || ""; } catch (e) {}

  try {
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
        system: CURATOR,
        messages: [{
          role: "user",
          content: "CURRENT MEMORY:\n" + (current || "(none yet)") + "\n\nNEW CONVERSATION:\n" + transcript,
        }],
      }),
    });
    if (!r.ok) { const detail = await r.text(); return res.status(502).json({ error: "upstream " + r.status, detail }); }
    const data = await r.json();
    const updated = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (updated) await redisSet(MEMORY_KEY, updated);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
