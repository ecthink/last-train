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
// a reading only counts if the watcher never looked away for longer than this…
const MAX_GAP = 12;          // minutes between polls
// …until the whole network was surely dark (regular last trains end ~01:30)
const DARK_BY = "01:45";
// one-off repairs, re-applied every run so the published file self-heals:
// nights GitHub let the watcher look only once, or stopped before close —
// every reading truncated (e.g. TKL-QUB-DOWN "00:29" vs its usual 01:03)
const PARTIAL_NIGHTS = ["2026-08-26", "2026-09-05", "2026-09-06"];
// keys whose history up to that date is pure ghost (see maxTimes); the date
// leaves room for nights the old workflow still folds before this ships
const GHOST_UNTIL = { "DRL-DIS-UP": "2026-10-31" };

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
// HKT now in the API's own shape, "YYYY-MM-DD HH:MM:SS"
export function hktStamp(now = new Date()){
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
}
// a service date's night: [D 21:00, D+1 03:00) HKT
export function nightBounds(date){
  const next = new Date(Date.parse(date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
  return [date + " 21:00:00", next + " 03:00:00"];
}
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const plusMinute = stamp =>
  new Date(Date.parse(stamp.replace(" ", "T") + "Z") + 60e3).toISOString().slice(0, 19).replace("T", " ");
// from one API payload, the furthest-future train per direction that is
//  - inside TONIGHT's window: after close the API advertises tomorrow's first
//    trains (06:xx) — learned 12 Jul: 205/220 entries were 頭班車 — and even
//    tomorrow night's (5–6 Sep: KTL "01:02" dated a day ahead)
//  - more than a minute away: at 迪士尼 the API keeps an UP entry stamped with
//    the current time, all night; for 14 nights it followed our run clock
//    (01:42 → 02:56) and became a fake "02:34" last train. Real trains are
//    seen coming; with polls every 3 min the last one is always caught early.
export function maxTimes(payload, line, sta, date, now = hktStamp()){
  const d = payload && payload.data && payload.data[line + "-" + sta];
  const out = {};
  if (!d) return out;
  const [from, to] = nightBounds(date);
  const soonest = plusMinute(STAMP.test(d.curr_time) ? d.curr_time : now);
  for (const dir of ["UP", "DOWN"]){
    const arr = d[dir];
    if (!Array.isArray(arr)) continue;
    const ok = arr.filter(x => x && x.time && x.valid !== "N" && x.time >= from && x.time < to && x.time > soonest);
    if (ok.length) out[dir] = ok.map(x => x.time).sort().at(-1); // ISO-ish strings sort fine
  }
  return out;
}
// scrub bad readings out of the learned dataset: morning/day times, the
// partial nights and ghost keys above (history + medians)
export function sanitizeLearned(learned){
  const night = hhmm => { const h = Number(hhmm.slice(0, 2)); return h >= 21 || h < 3; };
  let changed = false;
  for (const key of Object.keys(learned)){
    const e = learned[key];
    const hist = e.history || [];
    const keep = hist.filter(h => night(h.time) && !PARTIAL_NIGHTS.includes(h.date) && !(h.date <= (GHOST_UNTIL[key] || "")));
    if (keep.length !== hist.length){
      changed = true;
      if (!keep.length){ delete learned[key]; continue; }
      e.history = keep;
      e.time = medianTime(keep.map(h => h.time));
      e.nights = keep.length;
      e.updated = keep.at(-1).date;
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
// was the watcher looking the whole time? A poll at least 10 min before the
// reading, then no blind spot over MAX_GAP until the network is surely dark —
// otherwise the real last train may have slipped by unseen (Aug 2026: polls
// 25–60 min apart left many readings one headway early)
export function covered(polls, hhmm){
  const t = nightMinutes(hhmm);
  const from = t - 10, to = Math.max(nightMinutes(DARK_BY), t + 10);
  let prev = null;
  for (const m of polls.map(nightMinutes).sort((a, b) => a - b)){
    if (m <= from){ prev = m; continue; }
    if (prev === null || m - prev > MAX_GAP) return false;
    if (m >= to) return true;
    prev = m;
  }
  return false;
}
// fold a finished night into the learned dataset — covered readings only
export function foldNight(learned, seen, date, polls = []){
  for (const key in seen){
    const hhmm = seen[key].slice(11, 16);
    if (!covered(polls, hhmm)) continue;
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
  const now = hktStamp();
  let obs = readJson(OBS_FILE, null);
  if (!obs || obs.date !== today) obs = { date: today, seen: {}, polls: [] };
  obs.polls ||= [];

  // poll the whole network in small parallel batches
  const pairs = [];
  for (const line in NETWORK) for (const sta of NETWORK[line]) pairs.push([line, sta]);
  let polled = 0;
  for (let i = 0; i < pairs.length; i += 12){
    const batch = pairs.slice(i, i + 12);
    const results = await Promise.all(batch.map(([l, s]) => poll(l, s)));
    results.forEach((payload, j) => {
      if (payload){ polled++; mergeSeen(obs.seen, batch[j][0], batch[j][1], maxTimes(payload, batch[j][0], batch[j][1], obs.date, now)); }
    });
  }
  // a pass only counts as "looking" if (nearly) the whole network answered
  if (polled >= pairs.length * 0.9) obs.polls.push(now.slice(11, 16));
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
    const learned = foldNight(readJson(OUT_FILE, {}), obs.seen, obs.date, obs.polls);
    sanitizeLearned(learned);
    writeFileSync(OUT_FILE, JSON.stringify(learned, null, 1));
    const trusted = Object.values(obs.seen).filter(v => covered(obs.polls, v.slice(11, 16))).length;
    console.log("finalized", obs.date, "— trusted", trusted, "/", Object.keys(obs.seen).length, "readings; keys:", Object.keys(learned).length);
  }
  console.log("polled", polled, "/", pairs.length, "stations; tonight's keys:", Object.keys(obs.seen).length);
}

// run only when executed directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) await main();
