// Floor lifecycle log — tracks each Dungeoneering floor's start/end with its
// post-dungeon timer (captured via OCR after the end-interface opens).
//
// Chat triggers (detected in parser.js, dispatched from index.js):
//   floor-start — `- Welcome to Daemonheim -` (RS3 default system colour)
//   floor-end   — `… gorajan trailblazer outfit boosts your base floor
//                   experience by N%.` (RS3 renders this at #5B1A91)
//
// Persistence: localStorage['dkt:floors:v1'] holds an array of records:
//   { startedAt, ended, endedAt?, time?, timeSeconds? }
// All timestamps are Date.now() ms. `time` is the OCR'd clock string
// ("00:01:51") and `timeSeconds` is the parsed total seconds (for sort /
// CSV). Timer may be null if OCR failed — that's fine, floor still counts.
//
// UI wiring: listeners subscribe via onChange(fn) and get called with a copy
// of the full log whenever start/end/clear fires. Timer-attach mutations
// also notify so the UI's "time: null → 00:01:51" flip is visible.

const STORAGE_KEY = 'dkt:floors:v1';

// Hard upper bound on floor log size. RS3 Dungeoneering caps at floor 60,
// so 100 rows comfortably holds any realistic session. Beyond this the
// Floors list DOM starts to feel sluggish on expansion. Cannot be raised
// via settings — only lowered.
const HARD_MAX_FLOORS = 100;

let floorLog = [];
let maxFloors = HARD_MAX_FLOORS;
const listeners = new Set();

/**
 * Drop oldest entries until length ≤ maxFloors. Returns true if anything
 * was actually dropped (caller decides whether to re-save / notify).
 */
function pruneIfNeeded() {
  if (floorLog.length > maxFloors) {
    floorLog = floorLog.slice(-maxFloors);
    return true;
  }
  return false;
}

function save() {
  // Prune inline on every save so all mutation paths (floorStart, floorEnd,
  // attachTimer, deleteByStartedAt) respect the cap without each having to
  // remember to call prune.
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
      // Defensive: drop malformed entries.
      floorLog = parsed.filter(f => f && typeof f.startedAt === 'number');
      // Migrate oversized legacy logs (pre-cap versions) down to the hard
      // max. Re-save so the trimmed state persists.
      if (floorLog.length > HARD_MAX_FLOORS) {
        floorLog = floorLog.slice(-HARD_MAX_FLOORS);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(floorLog)); } catch (_) {}
      }
    }
  } catch (_) { /* corrupt — leave floorLog empty */ }
}
load();

/**
 * Adjust the active cap. Clamped to [1, HARD_MAX_FLOORS]. Called by the
 * settings UI in index.js when the user changes their preference. If the
 * new cap is smaller than the current log size, prunes in-place and
 * notifies listeners so the UI re-renders.
 */
export function setMaxFloors(n) {
  const clamped = Math.min(Math.max(1, Math.floor(Number(n) || 0)), HARD_MAX_FLOORS);
  if (clamped === maxFloors) return;
  maxFloors = clamped;
  if (pruneIfNeeded()) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(floorLog)); } catch (_) {}
    notify();
  }
}

export function getMaxFloors()     { return maxFloors; }
export function getHardMaxFloors() { return HARD_MAX_FLOORS; }

function notify() {
  const snap = floorLog.slice();
  for (const fn of listeners) {
    try { fn(snap); } catch (_) {}
  }
}

// Duplicate-start guard window. The "Welcome to Daemonheim" broadcast has no
// chat timestamp, so our line-dedupe keys on raw text; a slightly different
// OCR of the same line (missing/extra glyphs) escapes the dedupe and fires
// floor-start twice. If the most recent floor opened less than this many ms
// ago AND is still unended, we treat the second call as the same Welcome and
// ignore it instead of force-closing + opening a new floor.
const DUP_START_GUARD_MS = 30_000;

/**
 * Begin a new floor. If the previous floor never received an end marker
 * (OCR missed the reward line, user disconnected, etc.) we auto-close it
 * so the log doesn't accumulate phantom "still running" entries — unless
 * it's so recent that this is almost certainly a duplicate Welcome OCR, in
 * which case we return the existing row unchanged with isNew=false so the
 * caller can skip any side effects (e.g. tracker reset, debug logging).
 *
 * Returns `{ row, isNew }`.
 */
export function floorStart() {
  const last = floorLog[floorLog.length - 1];
  const now = Date.now();
  if (last && !last.ended && (now - last.startedAt) < DUP_START_GUARD_MS) {
    return { row: last, isNew: false };
  }
  if (last && !last.ended) {
    last.ended = true;
    last.endedAt = now;
    // time stays null — we never got the end marker, so no OCR fired.
  }
  const row = { startedAt: now, ended: false, time: null, timeSeconds: null };
  floorLog.push(row);
  save();
  notify();
  return { row, isNew: true };
}

/**
 * Mark the current floor as ended. Timer is attached separately (OCR fires
 * after the end-interface renders, which is milliseconds after this chat
 * marker appears). If no current floor exists (e.g. plugin started mid-
 * dungeon), this is a no-op — we don't fabricate a floor record here.
 */
export function floorEnd() {
  const last = floorLog[floorLog.length - 1];
  if (!last || last.ended) return null;
  last.ended = true;
  last.endedAt = Date.now();
  save();
  notify();
  return last;
}

/**
 * Attach the OCR'd timer to the most recent ended floor. Called by the
 * post-dungeon OCR routine after capture succeeds. No-op if the current
 * floor hasn't been flagged ended yet (timer would belong to a future
 * floor-end) or if we already have a timer (OCR fired twice).
 */
export function attachTimerToCurrent(time, timeSeconds) {
  const last = floorLog[floorLog.length - 1];
  if (!last || !last.ended) return null;
  if (last.time) return last; // already attached — don't clobber
  if (typeof time === 'string' && time) last.time = time;
  if (typeof timeSeconds === 'number' && isFinite(timeSeconds)) last.timeSeconds = timeSeconds;
  save();
  notify();
  return last;
}

export function getAll()   { return floorLog.slice(); }
export function count()    { return floorLog.length; }
export function current()  { return floorLog[floorLog.length - 1] || null; }

export function clear() {
  floorLog = [];
  save();
  notify();
}

/**
 * Remove a single floor entry by its startedAt timestamp (stable id — index
 * shifts when rows are deleted, startedAt does not). Returns the removed row
 * or null if no match.
 */
export function deleteByStartedAt(startedAt) {
  const idx = floorLog.findIndex(f => f && f.startedAt === startedAt);
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

/**
 * Build the CSV representation. Columns: startedAt (ISO), endedAt (ISO),
 * time (HH:MM:SS), timeSeconds (integer). Unended floors get empty endedAt
 * and timer cells. Newline-separated, no trailing newline.
 */
export function exportCsv() {
  const rows = [['startedAt', 'endedAt', 'time', 'timeSeconds']];
  for (const f of floorLog) {
    rows.push([
      f.startedAt ? new Date(f.startedAt).toISOString() : '',
      f.endedAt   ? new Date(f.endedAt).toISOString()   : '',
      f.time || '',
      typeof f.timeSeconds === 'number' ? String(f.timeSeconds) : '',
    ]);
  }
  return rows.map(r => r.join(',')).join('\n');
}

