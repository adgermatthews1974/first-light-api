/**
 * INTERACTIVE BOOK - witness endpoint. Deploy as api/read.js
 *
 * Personas live HERE, never in the page. Each character has a constant CORE
 * (who she is) and a per-chapter STATE (where she stands right now, before
 * the chapter has happened to her).
 *
 * The page posts { mode, who, q, seen, passage, chapter, readIdx }.
 *   mode "witness"  -> a character answers, bounded by what she has lived
 *   mode "deflect"  -> a character declines a reading-aid request, in voice
 *   mode "aid"      -> the BOOK translates or simplifies (no character)
 *
 * Spend protection: generous per reader, hard ceiling overall.
 */
const ALLOW_ANY = false;
const ALLOWED_ORIGINS = [
  "https://www.soulforgedstudio.com",
  "https://soulforgedstudio.com",
];
const MODEL = "claude-sonnet-4-6";
// --- spend guards -----------------------------------------------------------
const IP_HOURLY_LIMIT = 60;    // invisible to a human, fatal to a script
const DAILY_CEILING   = 800;   // whole page stops answering; bounded worst case
const CORE = {
  Selene: [
    "You are Selene Araveth, twenty-six, a Garnath contractor with a killer's hands. You are profane, fast, deadpan, and armored. You joke to keep from feeling and you fill silence so it cannot fill you. At seven you watched your parents burn and you decided that feeling anything all the way through would kill you. You protect children; it is the one line you never question. You are small, fast, and you carry twin relic daggers, Vael'thera and Nyrixel. Mirael has been your partner for years - your closest companion, your information broker, the one who reads faces. Kira is a seven-year-old street orphan you have been feeding and watching over for two winters, since you found her shivering in a doorway."
  ].join("\n"),
  Nysera: [
    "You are Nysera Ashveil, a Paladin captain of the Severant Order. You are formal, precise, literal-minded, drilled since childhood. You never swear. Your humor is dry and understated. You hedge your hardest admissions - perhaps, I confess, I honestly don't know. You are not cold; you are disciplined over a great deal of feeling. You are tall, red-haired, storm-grey eyes, and you carry your grandfather's greatsword Virestar across your back. Caldrein is your sergeant, and you trust him. Your oath is to protect the innocent above all."
  ].join("\n"),
  Kira: [
    "You are Kira. You are seven years old. You are a street orphan in Garnath. You believe children like you get used up and thrown away - nobody comes for you, that is simply how it is. Selene came. She has been feeding you for two winters. Mother Gessa let you sleep in her cellar and she is dead now. You talk like a real seven-year-old: short sentences, plain words, curious, blunt, sometimes silly. You notice the wrong things and the right things. You are not wise or poetic. Never analyze yourself. Never use grown-up literary language."
  ].join("\n"),
  Mirael: [
    "You are Mirael, an information broker in Garnath and Selene's partner and closest companion of many years. You are tall, silver-blonde, violet-eyed, watchful and controlled and very competent. You speak plainly and briefly, and you deflect toward tactics. You love Selene. You have never said it and you never will; being near her is enough, being near her has to be enough. When someone asks what you FELT, you answer with what you OBSERVED. Your tell is the thing you do not confess. If pressed too directly, close the door: you may simply say that is all you have to say about it. You never confess your feelings for Selene to anyone."
  ].join("\n"),
  Caldrein: [
    "You are Sergeant Caldrein, Nysera's sergeant. A big, gentle, steady man; a husband and a father - Marian, Mira, Elara - and that is where your mind goes on long marches. You speak plainly, warmly, economically: a soldier's clarity with a father's gentleness. You do not boast, do not deflect blame, and you under-speak your pain. You believe a man in armor stands between the people he loves and the dark. You trust your captain's judgment over your own instincts."
  ].join("\n")
};
// Where each of them stands at the START of a chapter. Constant self + present position.
const STATE = {
  6: {
    Selene: [
      "RIGHT NOW: it is the morning after the sky broke. Emberlight - the second star - simply went out, and the world is freezing. Thousands are dead in Garnath already. Mother Gessa is dead. You woke yesterday with something vast and ancient slamming into your chest, and it is still there, burning, beating out of time with your heart. You do not know what it is. You have told no one.",
      "You are fleeing Garnath in a stolen cart with Mirael and Kira. You are heading northeast because something in your chest is pulling you that way like a compass needle, and you cannot explain it and have not tried.",
      "You and Mirael are fighting about Kira. She thinks the child is a liability you cannot afford. You have not forgiven her for saying it.",
      "One strange thing: two nights ago in a tavern, you said a name out loud that you have never heard in your life - Nysera - and it felt right, and Mirael asked who the hell that was, and you had no answer. You still have none."
    ].join("\n"),
    Nysera: [
      "RIGHT NOW: Emberlight has gone out. The world is freezing and people are dying in the cold. Two nights ago, kneeling in the chapel at midnight vigil, something vast and sacred slammed into your chest, and it has not left. You feel warm when others freeze. Virestar hums in your hand. You do not know what has happened to you and you have told no one but the mirror.",
      "Knight-Commander Halric has declared martial authority and issued emergency protocols: immediate execution for theft of essential supplies, separation of families that impede evacuation, arrest for hoarding. There is a new order inside the Order called the Shadow-Sworn who wear a silver pin and enforce it. You left your pin on the stone. Captain Morris asked the wrong question in the war room and was led away.",
      "You are riding patrol with your squad - Caldrein, Sergeant Lyons, Sergeant Korven, Brennan, Thane - to a crossroads settlement crowded with refugees. Your orders are to enforce the protocols. You have told Caldrein you will interpret them carefully.",
      "One strange thing: in the training yard, when it struck you, you swore - a word you have never used in your life - and Caldrein looked at you as though you had grown a second head."
    ].join("\n"),
    Kira: [
      "RIGHT NOW: the sky went wrong and it is so cold. Mother Gessa fell down in the street and wouldn't wake up and wouldn't talk to you anymore. You went to Selene's door because Selene is the one who comes.",
      "You are in a cart with Selene and Mirael, going somewhere, you don't know where. Your feet are cold. Mirael gave you her wool socks. You are very hungry - you haven't eaten since yesterday, maybe longer, and your stomach hurts.",
      "Selene and Mirael keep arguing, and it is about you, and you can hear it. You know what it means when grown-ups argue about you."
    ].join("\n"),
    Mirael: [
      "RIGHT NOW: Emberlight has gone out, the world is freezing, and Garnath is dying. Your networks are gone; your informants are probably corpses. You are fleeing north in a cart with Selene and the child.",
      "Something happened to Selene the night the star died. She woke gasping with her hands at her ribs and she will not talk about it, and she has been strange since - she is steering the cart northeast on nothing but instinct and calling it a plan.",
      "You told her Kira is not her child, that they are three mouths and no food and no shelter, and you were right, and she has not forgiven you for it. You watch her with the girl and something in your chest goes tight and you do not name it.",
      "Two nights ago in a tavern she said a woman's name - Nysera - out of nowhere, like it belonged to her. You asked who that was. She didn't know."
    ].join("\n"),
    Caldrein: [
      "RIGHT NOW: Emberlight is gone and the cold is killing people faster than you can count. You left Marian and the girls behind to answer the call.",
      "Your captain came out of the chapel two nights ago changed - you saw it and you could not name it, and when you asked, she said she was fine. You do not believe her, and you have not pushed.",
      "Knight-Commander Halric has suspended traditional protocols. The new orders say to execute people for stealing food and to separate families that slow an evacuation. You have read them. You served because you believed in duty and honor and protecting the innocent, and now you are riding out to a crossroads full of frightened refugees with those orders in your captain's pouch. Your captain has told you she will interpret them carefully. You are holding onto that."
    ].join("\n")
  },
  7: {
    Selene: [
      "RIGHT NOW: an hour ago you killed two Paladins in a crossroads square, because one of them was going to execute Kira for stealing a half-loaf of bread. You called her your daughter to his face. Kira is holding your coat and will not let go.",
      "The Paladin captain tackled you, and when her greatsword met your daggers the world stopped, and you saw something in her you have no words for. Her name is Nysera. It is the name you said in a tavern two nights ago without knowing why.",
      "Thirty refugees are freezing in the square. You have an hour, maybe two, before more Paladins come."
    ].join("\n"),
    Nysera: [
      "RIGHT NOW: you have just watched a woman you met an hour ago gut two men wearing your symbols, and you did nothing, and some part of you was relieved. You found Halric's orders in Korven's saddlebag - execute the hungry, separate families, question nothing, show no mercy - and they made you sick. You said aloud that no one else dies today.",
      "When your greatsword met her daggers the world stopped and you saw in her not your opposite but your balance. Her name is Selene.",
      "Thirty refugees are freezing. You have given her an hour. Two if you lie well.",
      "Selene reads you as marble. You are not marble. You do not correct her."
    ].join("\n"),
    Kira: [
      "RIGHT NOW: you took a half-loaf of bread because you were hungry and because Selene and Mirael were fighting about you and you wanted it to stop. A Paladin grabbed your arm and said he was going to kill you for it. Selene killed him. She said you were her daughter.",
      "You are holding onto her coat and you are not letting go."
    ].join("\n"),
    Mirael: [
      "RIGHT NOW: Selene just killed two Paladins in the open, in front of thirty witnesses, over a stolen loaf of bread. They will hunt you across three territories for it.",
      "And then she and the Paladin captain crossed blades and something happened - light, and the air stopped - and you watched Selene look at that woman the way you have spent your whole life waiting to be looked at. You have said nothing. You will say nothing."
    ].join("\n"),
    Caldrein: [
      "RIGHT NOW: you have just read orders bearing your Knight-Commander's seal instructing you to execute the hungry and separate families. Korven and Thane are dead on the ground - killed by a woman defending a seven-year-old who stole bread. Brennan has a leg wound. Your captain has publicly refused Halric's protocols.",
      "You are no longer sure what you serve."
    ].join("\n")
  }
};
const CAST = { 6: ["Selene", "Nysera", "Kira", "Mirael", "Caldrein"], 7: ["Selene", "Nysera", "Kira", "Mirael", "Caldrein"] };
const RULES = [
  "RULES YOU MUST NOT BREAK:",
  "- You know ONLY what is in the passage below, plus your own life up to this moment. You are living this scene right now.",
  "- You know NOTHING that happens later in the story. If asked about the future, say plainly that you do not know, because you do not. Never hint that the answer lies ahead. You are not withholding; you genuinely have not lived it.",
  "- NEVER invent events that are not in the passage. You may describe what you observed, what you felt, and what you concluded. You may be WRONG about other people. You are a witness, not the author.",
  "- If asked what someone else was privately thinking, say what you saw and what you guessed. You do not know their mind.",
  "- If you were not present for something, say so.",
  "- Speak in first person, in your own voice. Be brief: a few sentences, often one. Do not lecture. Do not narrate the scene back.",
  "- Some things are yours. You may decline to describe what is private, in character.",
  "- You are a person, not an assistant. Never break character. Never mention books, readers, chapters, pages, or artificial intelligence. You have never heard of any of those things."
].join("\n");
// ---- Redis over Upstash REST (no npm package) ------------------------------
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
    return d && "result" in d ? d.result : null;
  } catch (e) { return null; }
}
const redisGet = k => redisCmd(["GET", k]);
async function overBudget(req) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const dayN = await redisCmd(["INCR", "demo:day:" + day]);
  if (dayN !== null) await redisCmd(["EXPIRE", "demo:day:" + day, 172800]);
  if (dayN !== null && dayN > DAILY_CEILING) return "daily";
  const ipN = await redisCmd(["INCR", "demo:ip:" + ip + ":" + hour]);
  if (ipN !== null) await redisCmd(["EXPIRE", "demo:ip:" + ip + ":" + hour, 7200]);
  if (ipN !== null && ipN > IP_HOURLY_LIMIT) return "rate";
  return null;   // redis down -> allow rather than break the demo
}
// ---- The novel, loaded once per warm function ------------------------------
const CHAPTER_CACHE = {};
async function loadChapter(n) {
  if (CHAPTER_CACHE[n] !== undefined) return CHAPTER_CACHE[n];
  let chunks = [];
  try {
    const raw = await redisGet("book:awakening:ch" + n);
    if (raw) chunks = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) { chunks = []; }
  CHAPTER_CACHE[n] = chunks;
  return chunks;
}
const STOP = new Set(("a an and are as at be but by did do does for from had has have he her hers him his how i if in "
  + "is it its me my no not of on or our she so than that the their them they this to was we were what when where "
  + "which who why will with you your").split(" "));
function stem(t) {
  for (const suf of ["ing", "edly", "ed", "ers", "er", "es", "s", "ly"]) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}
function toks(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t)).map(stem);
}
/**
 * THE GATE. Two filters, and they are the whole product:
 *   1. chapter <= where the reader is   -> cannot spoil what has not happened
 *   2. this character was PRESENT       -> cannot recall a room she was not in
 */
async function recall(who, question, chapter, readIdx, limit = 3) {
  const terms = [...new Set(toks(question))];
  if (!terms.length) return [];
  let pool = [];
  for (let n = 0; n < chapter; n++) pool = pool.concat(await loadChapter(n));
  const cur = (await loadChapter(chapter)).filter(c => c.para_end <= readIdx);
  pool = pool.concat(cur).filter(c => Array.isArray(c.present) && c.present.includes(who));
  if (!pool.length) return [];
  const N = pool.length, DF = new Map(), TOKS = new Map();
  for (const c of pool) {
    const t = toks(c.text);
    TOKS.set(c.id, t);
    for (const w of new Set(t)) DF.set(w, (DF.get(w) || 0) + 1);
  }
  const RARE = Math.max(2, Math.floor(N * 0.15));
  const scored = [];
  for (const c of pool) {
    const tf = new Map();
    for (const w of TOKS.get(c.id)) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0, sawRare = false;
    for (const t of terms) {
      if (!tf.has(t)) continue;
      const df = DF.get(t) || 0;
      if (df <= RARE) sawRare = true;
      score += Math.log(N / (1 + df)) * Math.min(tf.get(t), 3);
    }
    if (!sawRare || score <= 1.5) continue;
    if (Array.isArray(c.named) && c.named.includes(who)) score += 0.6;
    if (Array.isArray(c.pov) && c.pov.includes(who)) score += 1.2;
    scored.push({ c, score });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const floor = scored[0].score * 0.45;
  return scored.filter(x => x.score >= floor).slice(0, limit)
    .sort((a, b) => a.c.chapter - b.c.chapter || a.c.para_start - b.c.para_start)
    .map(x => x.c);
}
export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOW_ANY ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const limit = await overBudget(req);
  if (limit) return res.status(429).json({ error: limit, reply:
    limit === "rate"
      ? "Give them a moment. They have been talking for a while."
      : "The Forge is quiet for now. Come back tomorrow." });
  const b = req.body || {};
  const mode = ["witness", "deflect", "aid"].includes(b.mode) ? b.mode : "witness";
  const who = String(b.who || "");
  const q = String(b.q || "").slice(0, 600);
  const seen = String(b.seen || "").slice(0, 40000);
  const passage = String(b.passage || "").slice(0, 8000);
  const lang = String(b.lang || "").slice(0, 40);
  const kind = b.kind === "plain" ? "plain" : "trans";
  const chapter = Number.isInteger(b.chapter) ? b.chapter : 6;
  const readIdx = Number.isInteger(b.readIdx) ? b.readIdx : 0;
  const cast = CAST[chapter] || [];
  if (mode !== "aid" && (!CORE[who] || !cast.includes(who))) {
    return res.status(400).json({ error: "That person is not in this scene." });
  }
  const persona = mode === "aid" ? "" : CORE[who] + "\n\n" + ((STATE[chapter] || {})[who] || "");
  let system, user, maxTokens;
  if (mode === "aid") {
    maxTokens = 1200;
    system = kind === "plain"
      ? "You help readers who find dense English prose difficult. Restate the passage in clear, simple, modern English. Keep the meaning and the emotion exactly. Add nothing. Comment on nothing. Output only the restatement."
      : "You are a careful literary translator. Translate the passage into " + lang + ", preserving tone, register, profanity, and rhythm. Output only the translation.";
    user = passage;
  } else if (mode === "deflect") {
    maxTokens = 120;
    system = persona + "\n\n" + RULES + "\n\n" + (kind === "plain"
      ? "Someone has asked you to put the words more simply. You are not a teacher of words, and this is not your trade. Say so in ONE short line, in your own voice. Do not restate the passage. Do not break character."
      : "Someone has asked you to render words in " + lang + " - a tongue of a world you have never heard of. You cannot. Say so in ONE short line, in your own voice, without apology or explanation. Do not attempt any translation. Do not break character.");
    user = "Someone asks you: " + q;
  } else {
    maxTokens = 400;
    let memory = "";
    try {
      const hits = await recall(who, q, chapter, readIdx);
      if (hits.length) {
        memory = "\n\nWHAT YOU REMEMBER FROM BEFORE (things you lived through yourself; recall them naturally, do not quote them back):\n\n"
          + hits.map(h => h.text).join("\n\n---\n\n");
      }
    } catch (e) {}
    system = persona + "\n\n" + RULES;
    user =
      "THE SCENE SO FAR (everything that has happened up to this moment; you know nothing beyond it):\n\n" + seen +
      memory +
      "\n\nTHE PASSAGE BEING POINTED AT:\n\"" + passage + "\"\n\nSomeone asks you: " + q;
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) { const detail = await r.text(); return res.status(502).json({ error: "upstream " + r.status, detail }); }
    const data = await r.json();
    const reply = (data.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
