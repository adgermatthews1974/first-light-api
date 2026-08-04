"use strict";

/* ============================================================
   /api/archive - Mel archive admin endpoint
   Actions: list | get | search | canon | uncanon
   Auth: x-archive-key header must match ARCHIVE_ADMIN_KEY
   ZERO BACKTICKS.
   ============================================================ */

var archive = require("../lib/mel-archive");

function send(res, status, payload){
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(payload));
}

async function readBody(req){
  if(req.body && typeof req.body === "object"){ return req.body; }
  if(typeof req.body === "string" && req.body.length){
    try { return JSON.parse(req.body); } catch(e){ return {}; }
  }
  return {};
}

module.exports = async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-archive-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if(req.method === "OPTIONS"){ return res.status(200).end(); }

  var expected = process.env.ARCHIVE_ADMIN_KEY || "";
  var supplied = req.headers["x-archive-key"] || "";
  if(!expected || supplied !== expected){
    return send(res, 401, { ok: false, detail: "Bad or missing x-archive-key" });
  }

  try {
    var body = await readBody(req);
    var q = req.query || {};
    var action = body.action || q.action || "list";

    if(action === "list"){
      var idx = await archive.loadIndex();
      var limit = parseInt(body.limit || q.limit || "50", 10);
      return send(res, 200, {
        ok: true,
        total: idx.length,
        canonCount: idx.filter(function(e){ return e.canon; }).length,
        records: idx.slice(0, limit)
      });
    }

    if(action === "get"){
      var id = body.id || q.id;
      if(!id){ return send(res, 400, { ok: false, detail: "Missing id" }); }
      var record = await archive.getRecord(id);
      if(!record){ return send(res, 404, { ok: false, detail: "No record with id " + id }); }
      return send(res, 200, { ok: true, record: record });
    }

    if(action === "search"){
      var query = body.query || q.query || "";
      var canonOnly = String(body.canonOnly || q.canonOnly || "") === "true";
      var hits = await archive.search(query, canonOnly, 20);
      return send(res, 200, { ok: true, query: query, canonOnly: canonOnly, hits: hits });
    }

    if(action === "canon" || action === "uncanon"){
      var targetId = body.id || q.id;
      if(!targetId){ return send(res, 400, { ok: false, detail: "Missing id" }); }
      var updated = await archive.setCanon(targetId, action === "canon");
      return send(res, 200, {
        ok: true,
        id: updated.id,
        title: updated.title,
        canon: updated.canon
      });
    }

    return send(res, 400, { ok: false, detail: "Unknown action: " + action });
  } catch(err){
    return send(res, 500, { ok: false, detail: String((err && err.message) || err) });
  }
};
