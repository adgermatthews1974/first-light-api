/**
 * BOOK LOADER — admin endpoint. Deploy as api/book-load.js
 *
 * Loads a chapter's chunks into Redis so api/read.js can retrieve from them.
 * The manuscript NEVER goes in the repo. It lives only in Redis.
 *
 * Requires a new env var on the project:
 *   BOOK_ADMIN_TOKEN   (any long random string you choose)
 *
 * Usage (server-side, not from a browser):
 *   POST https://first-light-api.vercel.app/api/book-load
 *   headers: { "content-type": "application/json", "x-admin-token": "<BOOK_ADMIN_TOKEN>" }
 *   body:    { "chapter": 6, "chunks": [ ...contents of awakening-ch6.json... ] }
 *
 * Verify:
 *   POST same URL with { "chapter": 6, "verify": true }  -> { chapter, chunks, words }
 */
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
export default async function handler(req, res) {
  // No CORS: this endpoint is not for browsers.
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const token = req.headers["x-admin-token"];
  if (!process.env.BOOK_ADMIN_TOKEN || token !== process.env.BOOK_ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const b = req.body || {};
  const chapter = b.chapter;
  if (!Number.isInteger(chapter) || chapter < 0 || chapter > 99) {
    return res.status(400).json({ error: "chapter must be an integer 0-99" });
  }
  const key = "book:awakening:ch" + chapter;
  // --- verify mode: report what is already stored ---
  if (b.verify) {
    const raw = await redisCmd(["GET", key]);
    if (!raw) return res.status(200).json({ chapter, stored: false });
    let chunks = [];
    try { chunks = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) {
      return res.status(500).json({ chapter, stored: true, error: "stored value is not valid JSON" });
    }
    return res.status(200).json({
      chapter,
      stored: true,
      chunks: chunks.length,
      words: chunks.reduce((n, c) => n + (c.words || 0), 0),
      scenes: [...new Set(chunks.map(c => c.scene))].length,
      present: [...new Set(chunks.flatMap(c => c.present || []))].sort(),
    });
  }
  // --- load mode ---
  const chunks = b.chunks;
  if (!Array.isArray(chunks) || !chunks.length) {
    return res.status(400).json({ error: "chunks must be a non-empty array" });
  }
  const bad = chunks.find(c => !c || c.chapter !== chapter || !Array.isArray(c.present) || typeof c.text !== "string");
  if (bad) {
    return res.status(400).json({ error: "every chunk needs chapter, present[], text — and chapter must match" });
  }
  const ok = await redisCmd(["SET", key, JSON.stringify(chunks)]);
  if (ok === null) return res.status(500).json({ error: "redis write failed (check UPSTASH/KV env vars)" });
  return res.status(200).json({
    chapter,
    stored: true,
    chunks: chunks.length,
    words: chunks.reduce((n, c) => n + (c.words || 0), 0),
  });
}
