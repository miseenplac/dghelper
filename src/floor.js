// Floor log — tracks each completed Dungeoneering floor's timer.
//
// Detection is single-event: the end-of-dungeon dialog fires the sentinel
// check, which triggers a one-shot OCR of the bottom-left timer. Each
// successful read appends one row here; failed reads do nothing (the floor
// is silently not logged — accepted tradeoff per the rebuild plan, since
// chat-line fallbacks were dropped along with chat reading).
//
// Persistence: localStorage['dgh:floors:v2'] holds an array of records:
//   { endedAt, time, timeSeconds }
// `endedAt` is Date.now() ms when the floor was logged (acts as the row's
// stable id for per-row deletion). `time` is the OCR'd clock string
// ("00:33:46") and `timeSeconds` is the parsed total seconds.
//
// UI wiring: listeners subscribe via onChange(fn) and get called with a
// copy of the full log whenever record/delete/clear/setMaxFloors fires.

const STORAGE_KEY = 'dgh:floors:v2';
const HARD_MAX_FLOORS = 1000;

let floorLog = [];
let maxFloors = HARD_MAX_FLOORS;
const listeners = new Set();

function pruneIfNeeded() {
  if (floorLog.length > maxFloors) {
    floorLog = floorLog.slice(-maxFloors);
    return true;
  }
  return false;
}

function save() {
  pruneIfNeeded();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(floorLog)); }
  catch (_) { /* storage full / unavailable — ignore */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      floorLog = parsed.filter(f => f && typeof f.endedAt === 'number');
      if (floorLog.length > HARD_MAX_FLOORS) {
        floorLog = floorLog.slice(-HARD_MAX_FLOORS);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(floorLog)); } catch (_) {}
      }
    }
  } catch (_) { /* corrupt — leave floorLog empty */ }
}
load();

function notify() {
  const snap = floorLog.slice();
  for (const fn of listeners) {
    try { fn(snap); } catch (_) {}
  }
}

export function setMaxFloors(n) {
  const clamped = Math.min(Math.max(1, Math.floor(Number(n) || 0)), HARD_MAX_FLOORS);
  if (clamped === maxFloors) return;
  maxFloors = clamped;
  if (pruneIfNeeded()) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(floorLog)); } catch (_) {}
    notify();
  }
}

export function getMaxFloors() { return maxFloors; }
export function getHardMaxFloors() { return HARD_MAX_FLOORS; }

export function recordFloor({ time, timeSeconds }) {
  if (typeof time !== 'string' || !time) return null;
  if (typeof timeSeconds !== 'number' || !isFinite(timeSeconds)) return null;
  const row = { endedAt: Date.now(), time, timeSeconds };
  floorLog.push(row);
  save();
  notify();
  return row;
}

export function getAll()  { return floorLog.slice(); }
export function count()   { return floorLog.length; }

export function clear() {
  floorLog = [];
  save();
  notify();
}

export function deleteByEndedAt(endedAt) {
  const idx = floorLog.findIndex(f => f && f.endedAt === endedAt);
  if (idx < 0) return null;
  const [row] = floorLog.splice(idx, 1);
  save();
  notify();
  return row;
}

export function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function exportCsv() {
  const rows = [['endedAt', 'time', 'timeSeconds']];
  for (const f of floorLog) {
    rows.push([
      f.endedAt ? new Date(f.endedAt).toISOString() : '',
      f.time || '',
      typeof f.timeSeconds === 'number' ? String(f.timeSeconds) : '',
    ]);
  }
  return rows.map(r => r.join(',')).join('\n');
}
