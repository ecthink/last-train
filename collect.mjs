// 夜間觀察者 night watcher — learns Hong Kong's real last trains by watching
// the MTR Next Train API go dark, station by station, every night.
// Runs on GitHub Actions (see .github/workflows/watch.yml). No dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// Official station codes (source: opendata.mtr.com.hk mtr_lines_and_stations.csv)
const NETWORK = {
  AEL: ["HOK","KOW","TSY","AIR","AWE"],
  TCL: ["HOK","KOW","OLY","NAC","LAK","TSY","SUN","TUC"],
  TML: ["WKS","MOS","HEO","TSH","SHM","CIO","STW","CKT","TAW","HIK","DIH","KAT","SUW","TKW","HOM","HUH","ETS","AUS","NAC","MEF","TWW","KSR","YUL","LOP","TIS","SIH","TUM"],
  TKL: ["NOP","QUB","YAT","TIK","TKO","LHP","HAH","POA"],
  EAL: ["ADM","EXC","HUH","MKK","KOT","TAW","SHT","FOT","RAC","UNI","TAP","TWO","FAN","SHS","LOW","LMC"],
  SIL: ["ADM","OCP","WCH","LET","SOH"],
  TWL: ["CEN","ADM","TST","JOR","YMT","MOK","PRE","SSP","CSW","LCK","MEF","LAK","KWF","KWH","TWH","TSW"],
  KTL: ["WHA","HOM","YMT","MOK","PRE","SKM","KOT","LOF","WTS","DIH","CHH","KOB","NTK","KWT","LAT","YAT","TIK"],
  ISL: ["KET","HKU","SYP","SHW","CEN","ADM","WAC","CAB","TIH","FOH","NOP","QUB","TAK","SWH","SKW","HFC","CHW"],
  DRL: ["SUN","DIS"]
};
const API = "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php";
const OBS_FILE = "data/observations.json";
const OUT_FILE = "data/last-trains.json";
const HISTORY_CAP = 14;

/*PURE-START*/
// HKT now as parts (avoids host-timezone assumptions)
export function hktParts(now = new Date()){
  const t = new Date(now.getTime() + 8 * 3600e3);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}
// service date: the "evening" a night belongs to (00:30 belongs to yesterday's service)
export function serviceDate(now = new Date()){
  const t = new Date(now.getTime() + 8 * 3600e3 - 12 * 3600e3);
  return t.toISOString().slice(0, 10);
}
// minutes since 18:00 for late-night comparison ("23:58" < "00:41" correctly)
export function nightMinutes(hhmm){
  const [h, m] = hhmm.split(":").map(Number);
  return (h < 12 ? h + 24 : h) * 60 + m;
}
export function medianTime(times){
  const sorted = [...times].sort((a, b) => nightMinutes(a) - nightMinutes(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
// a scheduled time only counts as a LAST-train candidate inside the night
// window 21:00–02:59. After close the API starts advertising tomorrow's FIRST
// trains (06:xx) — without this filter they string-sort above the real last
// train and poison the dataset (learned 12 Jul: 205/220 entries were 頭班車).
export function isNightTime(isoish){
  const h = Number(isoish.slice(11, 13));
  return h >= 21 || h < 3;
}
// from one API payload, the furthest-future NIGHT-WINDOW train per direction
export function maxTimes(payload, line, sta){
  const d = payload && payload.data && payload.data[line + "-" + sta];
  const out = {};
  if (!d) return out;
  for (const dir of ["UP", "DOWN"]){
    const arr = d[dir];
    if (Array.isArray(arr) && arr.length){
      const valid = arr.filter(x => x && x.time && x.valid !== "N" && isNightTime(x.time));
      if (valid.length) out[dir] = valid.map(x => x.time).sort().at(-1); // ISO-ish strings sort fine
    }
  }
  return out;
}
// scrub morning/day times out of an already-learned dataset (history + medians)
export function sanitizeLearned(learned){
  const night = hhmm => { const h = Number(hhmm.slice(0, 2)); return h >= 21 || h < 3; };
  let changed = false;
  for (const key of Object.keys(learned)){
    const e = learned[key];
    const keep = (e.history || []).filter(h => night(h.time));
    if (keep.length !== (e.history || []).length){
      changed = true;
      if (!keep.length){ delete learned[key]; continue; }
      e.history = keep;
      e.time = medianTime(keep.map(h => h.time));
      e.nights = keep.length;
    }
  }
  return changed;
}
// merge tonight's sightings: keep the later time per key
export function mergeSeen(seen, line, sta, dirTimes){
  for (const dir in dirTimes){
    const key = line + "-" + sta + "-" + dir;
    if (!seen[key] || dirTimes[dir] > seen[key]) seen[key] = dirTimes[dir];
  }
  return seen;
}
// fold a finished night into the learned dataset
export function foldNight(learned, seen, date){
  for (const key in seen){
    const hhmm = seen[key].slice(11, 16);
    const e = learned[key] || { history: [] };
    if (!e.history.some(h => h.date === date)) e.history.push({ date, time: hhmm });
    e.history = e.history.slice(-HISTORY_CAP);
    e.time = medianTime(e.history.map(h => h.time));
    e.nights = e.history.length;
    e.updated = date;
    learned[key] = e;
  }
  return learned;
}
/*PURE-END*/

function readJson(path, fallback){
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback; }
  catch(e){ return fallback; }
}

async function poll(line, sta){
  try {
    const res = await fetch(API + "?line=" + line + "&sta=" + sta + "&lang=tc", { signal: AbortSignal.timeout(10000) });
    return await res.json();
  } catch(e){ return null; }
}

async function main(){
  mkdirSync("data", { recursive: true });
  const today = serviceDate();
  let obs = readJson(OBS_FILE, null);
  if (!obs || obs.date !== today) obs = { date: today, seen: {} };

  // poll the whole network in small parallel batches
  const pairs = [];
  for (const line in NETWORK) for (const sta of NETWORK[line]) pairs.push([line, sta]);
  let polled = 0;
  for (let i = 0; i < pairs.length; i += 12){
    const batch = pairs.slice(i, i + 12);
    const results = await Promise.all(batch.map(([l, s]) => poll(l, s)));
    results.forEach((payload, j) => {
      if (payload){ polled++; mergeSeen(obs.seen, batch[j][0], batch[j][1], maxTimes(payload, batch[j][0], batch[j][1])); }
    });
  }
  writeFileSync(OBS_FILE, JSON.stringify(obs, null, 1));

  // always keep the published dataset clean (self-heals poisoned entries)
  const learned0 = readJson(OUT_FILE, {});
  if (sanitizeLearned(learned0)){
    writeFileSync(OUT_FILE, JSON.stringify(learned0, null, 1));
    console.log("sanitized dataset; keys now:", Object.keys(learned0).length);
  }

  // in the finalize window (02:00–11:59 HKT) fold the night into the dataset
  const { h } = hktParts();
  if (h >= 2 && h < 12 && Object.keys(obs.seen).length){
    const learned = foldNight(readJson(OUT_FILE, {}), obs.seen, obs.date);
    sanitizeLearned(learned);
    writeFileSync(OUT_FILE, JSON.stringify(learned, null, 1));
    console.log("finalized", obs.date, "keys:", Object.keys(learned).length);
  }
  console.log("polled", polled, "/", pairs.length, "stations; tonight's keys:", Object.keys(obs.seen).length);
}

// run only when executed directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) await main();
