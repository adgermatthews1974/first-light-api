"use strict";

/* ============================================================
   ROOM WEATHER - the real sky over the Forge valley
   Carpathian Mountains, Maramures, close to the Ukrainian border.
   Open-Meteo, no key needed. Cached in Redis for 15 minutes, so the
   weather service is asked at most a few times an hour. If it is slow
   or down, the room simply goes without weather for that turn.
   ZERO BACKTICKS.
   ============================================================ */

var WEATHER_KEY = "sim:weather";
var LAT = Number(process.env.FORGE_LAT || 47.78);
var LON = Number(process.env.FORGE_LON || 24.6);
var WEATHER_TZ = "Europe/Bucharest";
var FRESH_MS = 15 * 60 * 1000;
var KEEP_MS = 6 * 3600 * 1000;   // an older reading beats none, up to this age
var TIMEOUT_MS = 2500;
var RETRY_MS = 5 * 60 * 1000;    // after a failure, wait this long before asking again

/* ---------- redis ---------- */

async function redis(command){
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if(!url || !token){ return null; }
  var res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if(!res.ok){ return null; }
  var data = JSON.parse(await res.text());
  return data ? data.result : null;
}

/* ---------- WMO weather codes ---------- */

var CODES = {
  0:  ["clear",   "clear sky"],
  1:  ["clear",   "mostly clear"],
  2:  ["cloud",   "partly cloudy"],
  3:  ["cloud",   "overcast"],
  45: ["fog",     "fog"],
  48: ["fog",     "freezing fog, rime on everything"],
  51: ["drizzle", "light drizzle"],
  53: ["drizzle", "drizzle"],
  55: ["drizzle", "heavy drizzle"],
  56: ["drizzle", "freezing drizzle"],
  57: ["drizzle", "freezing drizzle"],
  61: ["rain",    "light rain"],
  63: ["rain",    "rain"],
  65: ["rain",    "heavy rain"],
  66: ["rain",    "freezing rain"],
  67: ["rain",    "freezing rain"],
  71: ["snow",    "light snow"],
  73: ["snow",    "snow"],
  75: ["snow",    "heavy snow"],
  77: ["snow",    "snow grains"],
  80: ["rain",    "rain showers"],
  81: ["rain",    "rain showers"],
  82: ["rain",    "violent downpours"],
  85: ["snow",    "snow showers"],
  86: ["snow",    "heavy snow showers"],
  95: ["storm",   "thunderstorm"],
  96: ["storm",   "thunderstorm with hail"],
  99: ["storm",   "thunderstorm with hail"]
};

function weatherUrl(){
  return "https://api.open-meteo.com/v1/forecast?latitude=" + LAT + "&longitude=" + LON +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m" +
    "&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min" +
    "&timezone=Europe%2FBucharest&forecast_days=1";
}

function num(x){ var n = Number(x); return isNaN(n) ? null : Math.round(n); }
function hhmm(s){ var m = String(s || "").match(/T(\d\d:\d\d)/); return m ? m[1] : ""; }
function first(a){ return Array.isArray(a) && a.length ? a[0] : null; }

function shape(d, now){
  var c = (d && d.current) || {};
  var dl = (d && d.daily) || {};
  var code = Number(c.weather_code);
  var cd = CODES[code] || ["cloud", "grey sky"];
  return {
    at: now.toISOString(),
    place: "the Forge valley",
    tempC: num(c.temperature_2m),
    feelsC: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    code: isNaN(code) ? null : code,
    kind: cd[0],
    text: cd[1],
    isDay: c.is_day === 1,
    wind: num(c.wind_speed_10m),
    gusts: num(c.wind_gusts_10m),
    cloud: num(c.cloud_cover),
    precip: Number(c.precipitation) || 0,
    sunrise: hhmm(first(dl.sunrise)),
    sunset: hhmm(first(dl.sunset)),
    hi: num(first(dl.temperature_2m_max)),
    lo: num(first(dl.temperature_2m_min))
  };
}

async function fetchWeather(now){
  var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = ctl ? setTimeout(function(){ ctl.abort(); }, TIMEOUT_MS) : null;
  try {
    var r = await fetch(weatherUrl(), ctl ? { signal: ctl.signal } : {});
    if(!r.ok){ return null; }
    var d = await r.json();
    if(!d || !d.current){ return null; }
    return shape(d, now);
  } catch(e){
    return null;
  } finally {
    if(timer){ clearTimeout(timer); }
  }
}

/* Never throws. Returns the reading or null. */
async function getWeather(now){
  now = now || new Date();
  var cached = null;
  try {
    var raw = await redis(["GET", WEATHER_KEY]);
    if(raw){ cached = JSON.parse(raw); }
  } catch(e){ cached = null; }
  var age = (cached && cached.at) ? now.getTime() - Date.parse(cached.at) : Infinity;
  var usable = (cached && cached.at && age < KEEP_MS) ? cached : null;
  if(usable && age < FRESH_MS){ return usable; }
  // the service failed a few minutes ago: do not make every turn wait on it again
  if(cached && cached.failedAt && now.getTime() - Date.parse(cached.failedAt) < RETRY_MS){ return usable; }
  var fresh = await fetchWeather(now);
  if(fresh){
    try { await redis(["SET", WEATHER_KEY, JSON.stringify(fresh), "EX", 86400]); } catch(e){}
    return fresh;
  }
  try {
    var marked = cached ? cached : {};
    marked.failedAt = now.toISOString();
    await redis(["SET", WEATHER_KEY, JSON.stringify(marked), "EX", 86400]);
  } catch(e){}
  return usable;
}

/* ---------- words for the room ---------- */

function minutesOf(s){
  var m = String(s || "").match(/^(\d\d):(\d\d)$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function nowMinutes(now){
  try {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: WEATHER_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    var h = 0, m = 0;
    for(var i = 0; i < parts.length; i++){
      if(parts[i].type === "hour"){ h = parseInt(parts[i].value, 10) % 24; }
      if(parts[i].type === "minute"){ m = parseInt(parts[i].value, 10); }
    }
    return h * 60 + m;
  } catch(e){ return now.getUTCHours() * 60 + now.getUTCMinutes(); }
}

function lightNow(w, now){
  var t = nowMinutes(now);
  var up = minutesOf(w.sunrise), down = minutesOf(w.sunset);
  if(up === null || down === null){ return w.isDay ? "daylight" : "dark"; }
  if(t < up - 60){ return "still dark, before dawn"; }
  if(t < up + 45){ return "first light"; }
  if(t < down - 75){ return "daylight"; }
  if(t < down){ return "the light going gold and low"; }
  if(t < down + 50){ return "dusk, the last blue light"; }
  return "dark";
}

function tempWords(t){
  if(t === null){ return ""; }
  if(t <= -10){ return "bitter cold"; }
  if(t <= 0){ return "freezing"; }
  if(t <= 7){ return "cold"; }
  if(t <= 14){ return "cool"; }
  if(t <= 21){ return "mild"; }
  if(t <= 27){ return "warm"; }
  return "hot";
}

function windWords(k){
  if(k === null){ return ""; }
  if(k < 6){ return "still air"; }
  if(k < 15){ return "a light breeze"; }
  if(k < 30){ return "a steady wind"; }
  if(k < 50){ return "a strong wind"; }
  return "a gale coming down the valley";
}

function weatherNote(w, now){
  if(!w){ return ""; }
  now = now || new Date();
  var bits = [];
  var tw = tempWords(w.tempC);
  if(w.tempC !== null){
    bits.push(tw + ", " + w.tempC + " degrees C" + (w.feelsC !== null && Math.abs(w.feelsC - w.tempC) >= 3 ? " (feels like " + w.feelsC + ")" : ""));
  }
  bits.push(w.text);
  var ww = windWords(w.wind);
  if(ww){ bits.push(ww); }
  var lines = [];
  lines.push("WEATHER IN THE VALLEY, right now (real and live): " + bits.join("; ") + ".");
  var day = [];
  if(w.lo !== null && w.hi !== null){ day.push("today runs " + w.lo + " to " + w.hi + " degrees"); }
  if(w.sunrise && w.sunset){ day.push("sunrise " + w.sunrise + ", sunset " + w.sunset); }
  day.push("right now it is " + lightNow(w, now));
  lines.push(cap(day.join("; ")) + ".");
  lines.push("This is the actual sky over the Forge and the lodge. It reaches whoever is in the valley only the way weather really does: rain on the big windows, a cold slate floor, wet boots at the door, fog lying on the meadow, a fire worth lighting, the hot springs steaming harder in the cold. Most lines will not mention it at all. Never read it out like a forecast and never quote the numbers. Anyone far from the valley has her own weather, not this.");
  return lines.join("\n");
}

function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = {
  getWeather: getWeather,
  weatherNote: weatherNote,
  lightNow: lightNow,
  shape: shape,
  WEATHER_KEY: WEATHER_KEY
};
