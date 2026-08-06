"use strict";

/* ============================================================
   /api/state - room state admin
   Actions: get | set | reset | log
   Auth: x-archive-key header must match ARCHIVE_ADMIN_KEY
   ZERO BACKTICKS.
   ============================================================ */

var roomState = require("../lib/room-state");

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
    var action = body.action || q.action || "get";

    if(action === "get"){
      var state = await roomState.loadState();
      return send(res, 200, { ok: true, state: state, block: roomState.stateBlockText(state) });
    }

    if(action === "set"){
      var who = String(body.who || q.who || "").toLowerCase();
      if(roomState.PEOPLE.indexOf(who) === -1){
        return send(res, 400, { ok: false, detail: "Unknown person: " + who });
      }
      var current = await roomState.loadState();
      var applied = roomState.applyTransitions(current, [{
        who: who,
        where: body.where || "",
        doing: body.doing || "",
        reason: body.reason || "set by hand"
      }]);
      await roomState.saveState(current);
      for(var i = 0; i < applied.length; i++){ await roomState.logTransition(applied[i]); }
      return send(res, 200, { ok: true, state: current, applied: applied });
    }

    if(action === "reset"){
      var fresh = JSON.parse(JSON.stringify(roomState.DEFAULT_STATE));
      await roomState.saveState(fresh);
      return send(res, 200, { ok: true, state: fresh, detail: "State reset to default" });
    }

    if(action === "log"){
      return send(res, 200, {
        ok: true,
        detail: "Transition log lives at Redis key " + roomState.LOG_KEY + " as a list. Read it from Upstash."
      });
    }

    return send(res, 400, { ok: false, detail: "Unknown action: " + action });

  } catch(err){
    return send(res, 500, { ok: false, detail: String((err && err.message) || err) });
  }
};
